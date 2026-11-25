import type { Address, Hex } from 'viem';
import type { BasisClient } from '../BasisClient';
import { HopExecutorAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule } from '../core/BaseModule';
import { optionKeys, optsOf } from '../core/opts';
import { decodeRevert } from '../core/revert';
import { toAddress, toBool, toUint } from '../core/units';

/** Options of `checkCaps`. */
export interface CheckCapsOptions {
  /** The executor to read (default the address book's). */
  executor?: Address | null;
}
const CHECK_CAPS_KEYS = optionKeys<CheckCapsOptions>({ executor: true });

/** Options of `listRoutes`. */
export interface ListRoutesOptions {
  /** Add each route's caps left now (default false). */
  withCapsLeft?: boolean | null;
}
const LIST_ROUTES_KEYS = optionKeys<ListRoutesOptions>({ withCapsLeft: true });

/** One hop of an outside-exchange route. */
export interface HopInfo {
  /** 1 = V3-style pool, 2 = Uniswap v4 pool. */
  kind: number;
  /** V3: the pool. */
  pool: Address;
  /** What this hop pays out (WETH for native). */
  tokenOut: Address;
  /** V4 pool key (`currency0` 0x0 = native). */
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** A route with its caps (`routeAt`). Caps are raw units of `tokenIn` / `tokenOut`. */
export interface HopRoute {
  tokenIn: Address;
  tokenOut: Address;
  hops: HopInfo[];
  maxIn: bigint;
  maxOut: bigint;
  /**
   * Only with `listRoutes({ withCapsLeft: true })`: what the route has left now (`capsLeft`), raw units; null when that
   * read failed. On Robinhood Chain this is what a swap sent now meets (see `HopCapsLeft`). Never cache them.
   */
  inLeft?: bigint | null;
  outLeft?: bigint | null;
}

/** Caps of a route in raw token units: `maxIn` of tokenIn, `maxOut` of tokenOut. */
export interface HopCaps {
  maxIn: bigint;
  maxOut: bigint;
}

/**
 * What a route has left now: its caps minus what hops used in the current contract block, raw token units. On Robinhood
 * Chain a contract block is a window of about 12 s, so these figures are what a swap sent now meets until the window
 * turns over. On a chain whose contract block is its own (a local node), they describe the latest mined block, and a swap
 * sent now starts from the full caps (`getCaps`).
 */
export interface HopCapsLeft {
  inLeft: bigint;
  outLeft: bigint;
}

/** `checkCaps`: an amount against a route's caps, the way a swap sent now is checked. Raw token units. */
export interface HopCapCheck {
  /**
   * The swap fits what it meets now: `amountIn` and (when given) `grossOut` within `capsLeft` on Robinhood Chain (usage
   * carries over the window of about 12 s), within the full caps `caps` on a chain whose contract block is its own.
   */
  fits: boolean;
  /** 'above cap' when it does not fit (the revert the swap would give), else null. */
  blocked: 'above cap' | null;
  caps: HopCaps;
  capsLeft: HopCapsLeft;
  /**
   * The amount fits the full caps but not what is left now: other hops used part of them. On Robinhood Chain the swap is
   * blocked until the window turns over (wait about 12 seconds); on a chain whose contract block is its own, a swap in a
   * later block is usually fine (information only).
   */
  busy: boolean;
}

/**
 * The hop executor: swaps through an outside exchange, for cross swaps, outside-token bets and repay-with-another-token.
 * Reads only. Every hop charges a fee on its output (`feePpm`, read live), and each route has caps per contract block
 * (a window of about 12 s on Robinhood Chain). An options argument must be a plain object (or left out): a positional
 * value in its place (`listRoutes(true)`) is refused, rule 'options', before any read.
 */
export class HopExecutorModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the address book has a hop executor for this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.hopExecutor);
  }

  get address(): Address {
    return this.require(this.client.addresses.hopExecutor, 'HopExecutor');
  }

  /**
   * What the route pays for `amountIn` (raw `tokenIn`, a whole number) right now, raw units of `tokenOut`, **net of the
   * hop fee** (`feePpm`): what a swap gets back. Sent as an eth_call (a simulation, no tx). Reverts (decoded into
   * `BasisContractError`):
   * - "no route": there is no route for tokenIn -> tokenOut;
   * - "above cap": `amountIn > maxIn`, or the exchange's output before the fee `> maxOut`. Both are the full caps
   *   (`getCaps`): this quote counts no usage, so on Robinhood Chain it can pass while a swap sent now reverts on what
   *   is left of the window (`checkCaps` counts it);
   * - "partial fill": the exchange cannot take the whole input (thin liquidity / price limit);
   * - "hook not allowed": a v4 hop's hook is no longer allowed;
   * - "no quote": the exchange returned nothing to quote.
   */
  async quoteHop(tokenIn: Address, tokenOut: Address, amountIn: bigint | number): Promise<bigint> {
    const amount = toUint(amountIn, 'amountIn');
    const [a, b] = pair(tokenIn, tokenOut);
    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.address, abi: HopExecutorAbi, functionName: 'quoteHop', args: [a, b, amount],
        account: this.client.account,
      });
      return result;
    } catch (e) {
      throw decodeRevert(e, { contract: 'HopExecutor', functionName: 'quoteHop', abi: HopExecutorAbi });
    }
  }

  /** The hops of the route tokenIn → tokenOut (empty when there is none). */
  async getRoute(tokenIn: Address, tokenOut: Address): Promise<HopInfo[]> {
    const hops = await this.publicClient.readContract({
      address: this.address, abi: HopExecutorAbi, functionName: 'getRoute', args: pair(tokenIn, tokenOut),
    });
    return hops.map(toHop);
  }

  /**
   * The route's caps (raw units): the most one contract block may take in / pay out (`maxOut` is before the fee). On
   * Robinhood Chain a contract block is a window of about 12 s, and a swap sent now meets what is left of it (`capsLeft`).
   */
  async getCaps(tokenIn: Address, tokenOut: Address): Promise<HopCaps> {
    const [maxIn, maxOut] = await this.publicClient.readContract({
      address: this.address, abi: HopExecutorAbi, functionName: 'getCaps', args: pair(tokenIn, tokenOut),
    });
    return { maxIn, maxOut };
  }

  /**
   * What the route has left now: the caps minus what hops used in the current contract block, raw units. On Robinhood
   * Chain (a window of about 12 s) this is what a swap sent now meets. On a chain whose contract block is its own it
   * describes the latest mined block, and a swap sent now starts from the full caps (`getCaps`).
   */
  async capsLeft(tokenIn: Address, tokenOut: Address): Promise<HopCapsLeft> {
    const [inLeft, outLeft] = await this.publicClient.readContract({
      address: this.address, abi: HopExecutorAbi, functionName: 'capsLeft', args: pair(tokenIn, tokenOut),
    });
    return { inLeft, outLeft };
  }

  /**
   * Whether `amountIn` (raw `tokenIn`) and, optionally, `grossOut` (raw `tokenOut` the exchange pays before the fee) fit
   * the route's caps the way a swap sent now is checked, counting usage as the executor does: against `capsLeft` where
   * the contract block is the parent chain's (`chainConfig.contractBlockIsL1`: Robinhood Chain, a window of about 12 s),
   * against the full caps (`getCaps`) where it is the chain's own (a local node: a swap sent now lands in a later block,
   * whose usage starts at 0). `busy` flags an amount that fits the full caps but not what is left now. `opts.executor`
   * reads another executor than the address book's (`trading.quoteSwap` passes the one trades use).
   * `grossOut` / `opts.executor` null = not given (as PY None).
   */
  async checkCaps(
    tokenIn: Address, tokenOut: Address, amountIn: bigint | number, grossOut?: bigint | number | null,
    opts: CheckCapsOptions | null = {},
  ): Promise<HopCapCheck> {
    const o = optsOf(opts, CHECK_CAPS_KEYS);
    const x = toUint(amountIn, 'amountIn');
    const out = grossOut == null ? undefined : toUint(grossOut, 'grossOut');
    const args = pair(tokenIn, tokenOut);
    const c = { address: o.executor == null ? this.address : toAddress(o.executor, 'executor'), abi: HopExecutorAbi } as const;
    const [[maxIn, maxOut], [inLeft, outLeft]] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'getCaps', args }),
      this.publicClient.readContract({ ...c, functionName: 'capsLeft', args }),
    ]);
    const within = (inCap: bigint, outCap: bigint) => x <= inCap && (out === undefined || out <= outCap);
    const full = within(maxIn, maxOut);
    const left = within(inLeft, outLeft);
    const fits = this.client.chainConfig.contractBlockIsL1 === true ? left : full;
    return { fits, blocked: fits ? null : 'above cap', caps: { maxIn, maxOut }, capsLeft: { inLeft, outLeft }, busy: full && !left };
  }

  /** Number of routes. */
  async routeCount(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: HopExecutorAbi, functionName: 'routeCount' });
  }

  /** The i-th route with its hops and caps (the order can change). `i` a whole number. */
  async routeAt(i: bigint | number): Promise<HopRoute> {
    const [tokenIn, tokenOut, hops, maxIn, maxOut] = await this.publicClient.readContract({
      address: this.address, abi: HopExecutorAbi, functionName: 'routeAt', args: [toUint(i, 'index')],
    });
    return { tokenIn, tokenOut, hops: hops.map(toHop), maxIn, maxOut };
  }

  /**
   * Every route (`routeCount` + `routeAt`). `withCapsLeft` adds each route's `inLeft` / `outLeft` now (`capsLeft`, null
   * when that read fails): read fresh, never cached. On Robinhood Chain they are what a swap sent now meets; on a chain
   * whose contract block is its own, the full caps `maxIn` / `maxOut` are (`checkCaps` picks the right one).
   */
  async listRoutes(opts: ListRoutesOptions | null = {}): Promise<HopRoute[]> {
    const o = optsOf(opts, LIST_ROUTES_KEYS);
    const withCapsLeft = toBool(o.withCapsLeft, 'withCapsLeft', false);
    const n = Number(await this.routeCount());
    const routes = await Promise.all(Array.from({ length: n }, (_, i) => this.routeAt(i)));
    if (!withCapsLeft) return routes;
    return Promise.all(routes.map(async (r) => {
      try {
        const { inLeft, outLeft } = await this.capsLeft(r.tokenIn, r.tokenOut);
        return { ...r, inLeft, outLeft };
      } catch {
        return { ...r, inLeft: null, outLeft: null };
      }
    }));
  }

  /** The key of the route tokenIn → tokenOut. */
  async routeKey(tokenIn: Address, tokenOut: Address): Promise<Hex> {
    return this.publicClient.readContract({
      address: this.address, abi: HopExecutorAbi, functionName: 'routeKey', args: pair(tokenIn, tokenOut),
    });
  }

  /** This chain's wrapped native token (WETH) as the executor knows it. */
  async weth(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: HopExecutorAbi, functionName: 'weth' });
  }

  /** The hop fee on every hop's output, read live, parts per million (at most `maxFeePpm()`). Quotes are net of it. */
  async feePpm(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: HopExecutorAbi, functionName: 'feePpm' });
  }

  /** The highest `feePpm` can ever be, parts per million. */
  async maxFeePpm(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: HopExecutorAbi, functionName: 'MAX_FEE_PPM' });
  }
}

/** A route's two tokens as typed by the caller, through `toAddress` (rules `tokenIn`, `tokenOut`). */
function pair(tokenIn: Address, tokenOut: Address): readonly [Address, Address] {
  return [toAddress(tokenIn, 'tokenIn'), toAddress(tokenOut, 'tokenOut')];
}

function toHop(h: {
  kind: number; pool: Address; tokenOut: Address; currency0: Address; currency1: Address;
  fee: number; tickSpacing: number; hooks: Address;
}): HopInfo {
  return {
    kind: Number(h.kind), pool: h.pool, tokenOut: h.tokenOut, currency0: h.currency0, currency1: h.currency1,
    fee: Number(h.fee), tickSpacing: Number(h.tickSpacing), hooks: h.hooks,
  };
}
