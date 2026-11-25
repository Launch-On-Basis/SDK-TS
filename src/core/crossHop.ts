import { getAddress, type Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { EcosystemTokenAbi, HopExecutorAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { ValidationError } from './errors';
import { quoteHopWithinCaps } from './loans';
import { BPS } from './units';


/**
 * How a cross route treats a token: a main (`main` itself, `pair` its pair asset), a factory token (`main` its main,
 * `pair` that main's pair asset; both null on a token whose main is not a known main) or anything else ('pair': a pair
 * asset or an outside token; both null). Checksummed.
 */
export interface CrossRouteToken {
  address: Address;
  kind: 'main' | 'token' | 'pair';
  main: Address | null;
  pair: Address | null;
}

/** A hop quote on the executor `exec`, net of the hop fee, with the caller's error handling. */
export type HopQuote = (exec: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<bigint>;

/** Step kinds of a cross route: a route's steps run in this order, each at most once. */
const STEP_SELL_TOKEN = 0;
const STEP_SELL_MAIN = 1;
const STEP_OUTSIDE = 2;
const STEP_BUY_MAIN = 3;
const STEP_BUY_TOKEN = 4;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How a cross route treats `token` (`CrossRouteToken`): a main (paused or not, as `mains.isMain`), a factory token
 * (none when the factory is not deployed), or anything else.
 */
export async function routeTokenOf(client: BasisClient, token: Address): Promise<CrossRouteToken> {
  const address = getAddress(token);
  if (await client.mains.isMain(address)) {
    const info = await client.mains.get(address);
    return { address, kind: 'main', main: info.main, pair: info.pairAsset };
  }
  if (!isZeroAddress(client.addresses.factory) && (await client.factory.isEcosystemToken(address))) {
    const main = await client.publicClient.readContract({ address, abi: EcosystemTokenAbi, functionName: 'quoteToken' });
    if (!(await client.mains.isMain(main))) return { address, kind: 'token', main: null, pair: null };
    return { address, kind: 'token', main, pair: (await client.mains.get(main)).pairAsset };
  }
  return { address, kind: 'pair', main: null, pair: null };
}

/**
 * The kind of each step of `path`, from how the route treats each token (`rt`, with every main on the path live): a
 * factory token into its own main (sell token), a main into its pair asset (sell main), a pair asset into its main (buy
 * main), a main into a factory token on it (buy token), anything else through the outside exchange.
 */
function stepKinds(path: readonly Address[], rt: readonly CrossRouteToken[]): number[] {
  return path.slice(0, -1).map((a, i) => {
    const [ta, tb] = [rt[i], rt[i + 1]];
    const b = path[i + 1];
    if (ta.kind === 'token' && ta.main && eq(ta.main, b) && tb.kind === 'main') return STEP_SELL_TOKEN;
    if (ta.kind === 'main' && ta.pair && eq(ta.pair, b)) return STEP_SELL_MAIN;
    if (tb.kind === 'main' && tb.pair && eq(tb.pair, a)) return STEP_BUY_MAIN;
    if (ta.kind === 'main' && tb.kind === 'token' && tb.main && eq(tb.main, a)) return STEP_BUY_TOKEN;
    return STEP_OUTSIDE;
  });
}

/**
 * Why a swap refuses a cross route by its step kinds (`stepKinds`), checked in the swap's order, or null: each step at
 * most once and in order ("Bad route order"), a sell step first or a buy step last ("no BASIS leg"), and no main sold
 * into its pair asset and bought back ("round trip": the sell side's main is the buy side's).
 */
function crossPlanError(path: readonly Address[], kinds: readonly number[]): ValidationError | null {
  const n = kinds.length;
  if (kinds.some((k, i) => i > 0 && k <= kinds[i - 1])) {
    return new ValidationError('Bad route order', 'The steps of the route are out of order or repeated. A cross swap takes each step at most once, in this order: sell a factory token, sell a main, one outside exchange hop, buy a main, buy a factory token (buildCrossPath builds the route).');
  }
  const sell = kinds[0] <= STEP_SELL_MAIN;
  const buy = kinds[n - 1] >= STEP_BUY_MAIN;
  if (!sell && !buy) {
    return new ValidationError('no BASIS leg', 'The route neither sells nor buys a BASIS token: a cross swap starts by selling a main or a factory token, or ends by buying one.');
  }
  if (sell && buy && kinds.includes(STEP_SELL_MAIN) && kinds.includes(STEP_BUY_MAIN)) {
    const sellMain = kinds[0] === STEP_SELL_TOKEN ? path[1] : path[0];
    const buyMain = kinds[n - 1] === STEP_BUY_TOKEN ? path[n - 1] : path[n];
    if (eq(sellMain, buyMain)) {
      return new ValidationError('round trip', `The route sells ${sellMain} into its pair asset and buys it back (a round trip): go through it once, without the pair asset (buildCrossPath builds the route).`);
    }
  }
  return null;
}

/**
 * A cross route refused by its steps as a swap refuses them (`rt`: how the route treats each token of `path`,
 * `routeTokenOf`): "Bad route order", "no BASIS leg", "round trip". No reads. `checkCrossHop` runs it first too.
 * PY: `check_cross_plan`.
 */
export function checkCrossPlan(path: readonly Address[], rt: readonly CrossRouteToken[]): void {
  const refused = crossPlanError(path, stepKinds(path, rt));
  if (refused) throw refused;
}

/** A side of a cross route that trades on BASIS (`crossSides`): its main, that main's pair asset, and the factory token it sells or buys (null: the main itself). */
export interface CrossSide {
  main: Address;
  pair: Address;
  token: Address | null;
}

/**
 * The sides of a cross route a swap takes (`checkCrossPlan` passed): `sell` when its first step sells a factory token
 * or a main, `buy` when its last step buys one (null: the route has no such side). `split` true when both sides are
 * there on two different mains (each side then pays part of the base fee), else one side pays it. No reads.
 * PY: `cross_sides`.
 */
export function crossSides(path: readonly Address[], rt: readonly CrossRouteToken[]): { sell: CrossSide | null; buy: CrossSide | null; split: boolean } {
  const kinds = stepKinds(path, rt);
  const n = kinds.length;
  const sell: CrossSide | null = kinds[0] === STEP_SELL_TOKEN ? { main: path[1], pair: rt[1].pair!, token: path[0] }
    : kinds[0] === STEP_SELL_MAIN ? { main: path[0], pair: path[1], token: null } : null;
  const buy: CrossSide | null = kinds[n - 1] === STEP_BUY_TOKEN ? { main: path[n - 1], pair: rt[n - 1].pair!, token: path[n] }
    : kinds[n - 1] === STEP_BUY_MAIN ? { main: path[n], pair: path[n - 1], token: null } : null;
  return { sell, buy, split: sell !== null && buy !== null && !eq(sell.main, buy.main) };
}

/**
 * A cross route's steps (from `rt`: how the route treats each token of `path`, `routeTokenOf`), refused as a swap
 * refuses them ("Bad route order", "no BASIS leg", "round trip"); then its outside hop, if it has one, against what its
 * caps allow a swap sent now: the amount that reaches it (`amountIn` through the sell steps, less the sell side's fee
 * as `trader`), then what the exchange pays for it (`quoteHopWithinCaps` on the trades' hop executor, the payout from
 * `quote`; "above cap", "no executor", "no route"). The on-chain swap quote checks the hop against its full caps only:
 * what other swaps used of them in the current window on Robinhood Chain is not counted there. Its own reads (the hop
 * executor, the route, the caps and the hop fee, the sell-step quote `trading.getAmountsOut`, the fee rates) are not
 * classified: a failure there comes as the RPC client threw it. A failure of the hop quote is `quote`'s to classify.
 */
export async function checkCrossHop(
  client: BasisClient, path: readonly Address[], rt: readonly CrossRouteToken[], amountIn: bigint, trader: Address, quote: HopQuote,
): Promise<void> {
  checkCrossPlan(path, rt);
  const kinds = stepKinds(path, rt);
  const o = kinds.indexOf(STEP_OUTSIDE);
  if (o < 0) return;
  const n = kinds.length;
  const sell = o > 0;
  const buy = o < n - 1;
  const [hIn, hOut] = [path[o], path[o + 1]];
  const exec = await client.trading.getHopExecutor();
  if (isZeroAddress(exec)) throw new ValidationError('no executor', 'This route swaps through an outside exchange, and SWAP has no hop executor yet.');
  const hops = await client.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'getRoute', args: [hIn, hOut] });
  if (hops.length === 0) throw new ValidationError('no route', `No outside route from ${hIn} to ${hOut}.`);
  let x = amountIn;
  if (sell) {
    const base = await client.taxes.getBaseRate();
    const sellMain = kinds[0] === STEP_SELL_TOKEN ? rt[0].main! : path[0];
    const buyMain = !buy ? null : kinds[n - 1] === STEP_BUY_TOKEN ? rt[n].main! : path[n];
    const bps = buyMain && !eq(sellMain, buyMain) ? Math.floor(base / 2) : base;
    const [gross, rate] = await Promise.all([
      client.trading.getAmountsOut(amountIn, path.slice(0, o + 1)),
      bps === base ? client.taxes.getTaxRate(path[0], trader) : client.taxes.getTaxRateBase(path[0], trader, bps),
    ]);
    x = gross - (gross * BigInt(rate)) / BPS;
  }
  await quoteHopWithinCaps(client, exec, hIn, hOut, x, (v) => quote(exec, hIn, hOut, v));
}
