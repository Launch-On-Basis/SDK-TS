import { type Address, type Hex, hexToBigInt, size, slice } from 'viem';
import type { BasisClient } from '../BasisClient';
import { FactoryTokenAbi, HopExecutorAbi, MainLensAbi, MainTokenAbi, SwapAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import type { HopCapCheck } from '../modules/HopExecutor';
import { BasisRpcError, NotDeployedError, ValidationError } from './errors';
import { classifyError, decodeRevert, isRevertNamed } from './revert';
import { maxWithSlippage, toAddress, toUint } from './units';

/**
 * A loan or leverage position on a main (`readCoreLoan`; for a `client.loans` loan use `loans.getCoreLoan`). Amounts
 * raw: collateral in the token's units, debt in the pair asset.
 */
export interface CoreLoan {
  user: Address;
  /** The collateral / bought token (the main itself, or a factory token on it). */
  token: Address;
  collateralAmount: bigint;
  liquidatedAmount: bigint;
  /** Debt to repay, raw pair asset. */
  fullAmount: bigint;
  /** Borrowed, raw pair asset. */
  borrowedAmount: bigint;
  /** Unix seconds when it becomes liquidatable. */
  liquidationTime: bigint;
  /** Collateral claimable after a liquidation. */
  liquidationClaim: bigint;
  isLiquidated: boolean;
  active: boolean;
  creationTime: bigint;
  timeOfClosure: bigint;
  /** Leverage only: raw pair asset put in at open, and taken out so far by partial sells. */
  leverageBuyAmount: bigint;
  cashedOut: bigint;
}

/** `getPartialLoanSellAmounts`: raw amounts used up / left to sell. */
export interface PartialLoanSellAmounts {
  /** Main tokens used to clear this share of the debt. */
  mainUsed: bigint;
  /** Collateral tokens used for it (equals `mainUsed` for main collateral). */
  tokensUsed: bigint;
  /** Collateral tokens left to sell for the pair asset. */
  residualTokens: bigint;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * True when `main`'s pair is live (not paused), read now: the mains cache may be stale. While the pair is paused, new
 * loans, top-ups, extensions and partial sells on it fail; repaying still works.
 */
export async function isPairActive(client: BasisClient, main: Address): Promise<boolean> {
  const swap = client.addresses.swap;
  if (isZeroAddress(swap)) throw new NotDeployedError('Swap', client.chainId);
  return client.publicClient.readContract({ address: swap, abi: SwapAbi, functionName: 'isMain', args: [main] });
}

/** The 'pair not active' refusal of a credit write on `main` (`symbol` names it in the message). */
export function pairNotActive(main: Address, symbol?: string): ValidationError {
  return new ValidationError(
    'pair not active',
    `${symbol ? `${symbol} (${main})` : `Main ${main}`} is on a paused pair: new loans, top-ups, extensions and partial sells are refused while it is paused (repaying still works).`,
  );
}

/** `paused()`, read raw: a token without it counts as live. */
const PAUSED_CALL: Hex = '0x5c975abb';

/**
 * True when the issuer of `asset` (a main's pair asset: USDG and tokenized stocks can be paused) has paused it. A token
 * without `paused()`, or one whose read reverts, counts as live; an RPC failure throws `BasisRpcError` (nothing was
 * sent). While the asset is paused it cannot move, so writes that pay it in or out refuse before any approval
 * (`refusePausedAsset`). PY: `is_asset_paused` (core/loans.py).
 */
export async function isAssetPaused(client: BasisClient, asset: Address): Promise<boolean> {
  try {
    const { data } = await client.publicClient.call({ to: asset, data: PAUSED_CALL });
    return data !== undefined && size(data) >= 32 && hexToBigInt(slice(data, 0, 32)) === 1n;
  } catch (e) {
    const err = classifyError(e, { contract: 'ERC20' });
    if (err instanceof BasisRpcError) throw err;
    return false;
  }
}

/**
 * The 'pair asset paused' refusal: `asset` (named `symbol` when known) is paused by its issuer, so `effect` (what the
 * write cannot do). PY: `pair_asset_paused`.
 */
export function pairAssetPaused(asset: Address, symbol: string | null, effect: string): ValidationError {
  return new ValidationError('pair asset paused', pairAssetPausedMessage(asset, symbol, effect));
}

/** The message of `pairAssetPaused`, for a refusal list that carries its own messages (`checkBuy`). PY: `pair_asset_paused_message`. */
export function pairAssetPausedMessage(asset: Address, symbol: string | null, effect: string): string {
  return `${symbol ? `${symbol} (${asset})` : `The pair asset ${asset}`} is paused by its issuer: it cannot move until it is unpaused, so ${effect}. Nothing was sent.`;
}

/** Throws `pairAssetPaused(asset, symbol, effect)` when the issuer has paused `asset` (`isAssetPaused`). PY: `refuse_paused_asset`. */
export async function refusePausedAsset(client: BasisClient, asset: Address, symbol: string | null, effect: string): Promise<void> {
  if (await isAssetPaused(client, asset)) throw pairAssetPaused(asset, symbol, effect);
}

/** Loan (or, with `isLeverage`, leverage position) `loanId` of `user` on `main`. `main` and `user` go through `toAddress`. */
export async function readCoreLoan(client: BasisClient, main: Address, user: Address, loanId: bigint, isLeverage: boolean): Promise<CoreLoan> {
  main = toAddress(main, 'main');
  user = toAddress(user, 'user');
  const pc = client.publicClient;
  const r = isLeverage
    ? await pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'leverages', args: [user, loanId] })
    : await pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'loans', args: [user, loanId] });
  return {
    user: r[0], token: r[1], collateralAmount: r[2], liquidatedAmount: r[3], fullAmount: r[4], borrowedAmount: r[5],
    liquidationTime: r[6], liquidationClaim: r[7], isLiquidated: r[8], active: r[9], creationTime: r[10],
    timeOfClosure: r[11], leverageBuyAmount: r[12].leverageBuyAmount, cashedOut: r[12].cashedOut,
  };
}

/**
 * What a partial sell of `pct` % (1-100) of loan or leverage position `loanId` of `user` on `main` would use up and leave
 * to sell (raw). A loan that is not open (repaid, sold or never opened) throws `ValidationError('Loan not active')`. A bad
 * percentage, a liquidated loan and a sale with no profit come back as `BasisContractError` ("Invalid percentage",
 * "Already liquidated", "cannot sell off with no profit"). Throws `NotDeployedError` before any RPC when the main lens is
 * not deployed on this chain, and `ValidationError('percentage')` before any read for a `pct` that is not a whole number
 * (a fraction, a boolean, a string or a negative); `main` and `user` go through `toAddress`.
 */
export async function getPartialLoanSellAmounts(
  client: BasisClient, main: Address, loanId: bigint, user: Address, pct: number | bigint, isLeverage: boolean,
): Promise<PartialLoanSellAmounts> {
  const lens = client.addresses.mainLens;
  if (isZeroAddress(lens)) throw new NotDeployedError('MainLens', client.chainId);
  const p = toUint(pct, 'percentage');
  main = toAddress(main, 'main');
  user = toAddress(user, 'user');
  if (p >= 1n && p <= 100n) {
    const loan = await readCoreLoan(client, main, user, loanId, isLeverage);
    if (!loan.active && !loan.isLiquidated) {
      throw new ValidationError('Loan not active', `${isLeverage ? 'Leverage position' : 'Loan'} ${loanId} of ${user} is not active (repaid, sold or never opened).`);
    }
  }
  try {
    const [mainUsed, tokensUsed, residualTokens] = await client.publicClient.readContract({
      address: lens, abi: MainLensAbi, functionName: 'getPartialLoanSellAmounts', args: [main, loanId, user, p, isLeverage],
    });
    return { mainUsed, tokensUsed, residualTokens };
  } catch (e) {
    throw decodeRevert(e, { contract: 'MainLens', functionName: 'getPartialLoanSellAmounts', abi: MainLensAbi });
  }
}

/**
 * Gross pair asset a partial sell of `pct` % of loan or leverage position `loanId` of `user` on `main` produces (before
 * the exit fee). It may come out a little low (dust), never high, so a minimum derived from it is never above what the
 * sale pays. `loan` is the position's `token` and `fullAmount` (for a `client.loans` loan use
 * `loans.quotePartialSellLoan`). `pct` as in `getPartialLoanSellAmounts`.
 */
export async function estimatePartialSell(
  client: BasisClient, main: Address, loan: Pick<CoreLoan, 'token' | 'fullAmount'>,
  user: Address, loanId: bigint, pct: number | bigint, isLeverage: boolean,
): Promise<bigint> {
  const p = toUint(pct, 'percentage');
  main = toAddress(main, 'main');
  user = toAddress(user, 'user');
  const pc = client.publicClient;
  const [amounts, reserves] = await Promise.all([
    getPartialLoanSellAmounts(client, main, loanId, user, p, isLeverage),
    pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getCurveReserves' }),
  ]);
  const [r0, r1] = reserves;
  const payment = (loan.fullAmount * p) / 100n;
  const r0After = r0 - amounts.mainUsed;
  const r1After = r1 - payment;
  let mainIn = amounts.residualTokens;
  if (!eq(loan.token, main)) {
    const [[t0, t1], mag, reversed] = await Promise.all([
      pc.readContract({ address: loan.token, abi: FactoryTokenAbi, functionName: 'getCurveReserves' }),
      pc.readContract({ address: loan.token, abi: FactoryTokenAbi, functionName: 'hybridMultiplier' }),
      pc.readContract({ address: loan.token, abi: FactoryTokenAbi, functionName: 'reversed' }),
    ]);
    const shift = (amounts.tokensUsed * BigInt(mag)) / 100n;
    const t0After = reversed ? t0 + shift : t0 - shift;
    const t1After = t1 - amounts.mainUsed;
    const res = amounts.residualTokens;
    mainIn = res === 0n ? 0n : (res * t1After) / (t0After + res);
  }
  if (mainIn === 0n) return 0n;
  return (mainIn * r1After) / (r0After + mainIn);
}

/** What a partial sell pays. Raw pair asset, `taxBps` in bps. */
export interface PartialSellExit {
  /** Pair asset the sale produces, before the exit fee. */
  gross: bigint;
  /** The part of `gross` the fee is charged on: all of it on a `client.loans` loan, only the profit on a leverage position. */
  taxable: bigint;
  /** The seller's own sell fee rate for the collateral token, in bps, read live. 0 for a fee-whitelisted wallet. */
  taxBps: number;
  /** The exit fee: `taxBps` of `taxable`. */
  fee: bigint;
  /** Paid to the seller: `gross - fee`. `minOut` binds this figure. */
  net: bigint;
}

/**
 * What a partial sell of `pct` % of loan or leverage position `loanId` of `user` on `main` pays `seller` (the wallet
 * behind it): the gross of `estimatePartialSell`, less the exit fee. A leverage position pays the fee on its profit only,
 * so a sale at a loss pays none. `loan` as in `estimatePartialSell`; a leverage position also needs its
 * `leverageBuyAmount` and `cashedOut`.
 */
export async function quotePartialSell(
  client: BasisClient, main: Address,
  loan: Pick<CoreLoan, 'token' | 'fullAmount'> & Partial<Pick<CoreLoan, 'leverageBuyAmount' | 'cashedOut'>>,
  user: Address, loanId: bigint, pct: number | bigint, isLeverage: boolean, seller: Address,
): Promise<PartialSellExit> {
  const p = toUint(pct, 'percentage');
  main = toAddress(main, 'main');
  user = toAddress(user, 'user');
  seller = toAddress(seller, 'seller');
  const [gross, taxBps] = await Promise.all([
    estimatePartialSell(client, main, loan, user, loanId, p, isLeverage),
    client.taxes.getTaxRate(loan.token, seller),
  ]);
  let taxable = gross;
  if (isLeverage) {
    const bought = loan.leverageBuyAmount ?? 0n;
    const cashed = loan.cashedOut ?? 0n;
    const allowance = bought > cashed ? bought - cashed : 0n;
    taxable = gross > allowance ? gross - allowance : 0n;
  }
  const fee = (taxable * BigInt(taxBps)) / 10_000n;
  return { gross, taxable, taxBps, fee, net: gross - fee };
}

/** What an extension check needs to know about the loan. Raw units. */
export interface ExtendLoanState {
  active: boolean;
  /** The collateral token. */
  token: Address;
  collateralAmount: bigint;
  /** Debt, raw pair asset. */
  fullAmount: bigint;
  liquidationTime: bigint;
}

/** Whether the extension can be charged to the loan, and its fee. */
export interface ExtendEligibility {
  possible: boolean;
  /** Raw pair asset. */
  fee: bigint;
}

/**
 * The refusal an extension of `loan` on `main` by `days` would meet, or null when it goes through: "Must be refinance if
 * not extending time" (0 days is only a refinance with no pay-in), "incorrect loan duration", "Loan not active"; then,
 * for an add-to-debt or refinance the loan cannot cover, "Not enough collateral to cover fees" (add to debt), or "No
 * equity", "Minimum surplus not met", "Time remaining too short", "Fees exceed surplus value" (refinance). A pay-in
 * passes once the days and the loan are valid. The days count from the due date, or from the time of the transaction
 * when the loan is past due.
 */
export async function coreExtendRefusal(
  client: BasisClient, main: Address, loan: ExtendLoanState, days: bigint, payIn: boolean, refinance: boolean,
  q: ExtendEligibility,
): Promise<ValidationError | null> {
  if (days === 0n && (!refinance || payIn)) {
    return new ValidationError('Must be refinance if not extending time', '0 days is only allowed for a refinance without a pay-in.');
  }
  const pc = client.publicClient;
  const [minDays, maxDays] = await Promise.all([
    pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'minDaysLoan' }),
    pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'maxDaysLoan' }),
  ]);
  if (days > 0n && (days < minDays || days > maxDays)) {
    return new ValidationError('incorrect loan duration', `Days must be ${minDays}-${maxDays} on this main, got ${days}.`);
  }
  if (!loan.active) return new ValidationError('Loan not active', 'The loan is not active (repaid, sold or liquidated).');
  if (payIn || q.possible) return null;
  const [value, { pairSymbol: u }] = await Promise.all([
    pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getColleteralValue', args: [loan.collateralAmount, loan.token] }),
    client.mains.get(main),
  ]);
  if (!refinance) {
    return new ValidationError(
      'Not enough collateral to cover fees',
      `Debt ${loan.fullAmount} + fee ${q.fee} is not below the collateral value ${value} (raw ${u}); pay the fee from the wallet (payInPairAsset).`,
    );
  }
  if (value <= loan.fullAmount) {
    return new ValidationError('No equity', `The collateral is worth ${value}, not above the debt ${loan.fullAmount} (raw ${u}): nothing to refinance.`);
  }
  const surplus = value - loan.fullAmount;
  const [baseReserve1, block] = await Promise.all([
    pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'baseReserve1' }),
    pc.getBlock(),
  ]);
  if (surplus < baseReserve1 / 10000n) {
    return new ValidationError('Minimum surplus not met', `The surplus ${surplus} is below the minimum ${baseReserve1 / 10000n} (raw ${u}).`);
  }
  const remaining = loan.liquidationTime > block.timestamp ? (loan.liquidationTime - block.timestamp) / DAY : 0n;
  if (days === 0n && remaining < minDays) {
    return new ValidationError('Time remaining too short', `Only ${remaining} days left (minimum ${minDays}); refinance with days added.`);
  }
  return new ValidationError('Fees exceed surplus value', `The refinance fees ${q.fee} take the whole surplus ${surplus} (raw ${u}).`);
}

const DAY = 86400n;

/** What `sizeRepayWith` needs to know about the route (raw units). */
export interface RepaySizing {
  /** One whole `tokenIn` (the first guess, any price ratio). */
  unit: bigint;
  /**
   * The route's caps: the most `tokenIn` it takes in, and `tokenOut` it pays out before its fee, per window (about 12 s
   * on Robinhood Chain).
   */
  maxIn: bigint;
  maxOut: bigint;
  /**
   * What is left of the caps in the current window (Robinhood Chain): what a repay sent now meets. Omitted or null (not
   * given, as PY None: e.g. a `listRoutes({ withCapsLeft })` route whose caps-left read failed): the full caps apply.
   */
  inLeft?: bigint | null;
  outLeft?: bigint | null;
  /** The route's fee, parts per million: quotes are net of it, `maxOut` is not. */
  feePpm: bigint;
  /** Headroom on top of the least amount (the price may move before the tx lands; the leftover is refunded). */
  bufferBps: number;
  tokenIn: Address;
  tokenOut: Address;
}

/**
 * What `sizeRepayWith` needs about `exec`'s route `tokenIn` -> `tokenOut`, read now: one whole `tokenIn`, the caps, the
 * fee and, on a chain with `chainConfig.contractBlockIsL1`, what is left of the caps.
 */
export async function readRepaySizing(
  client: BasisClient, exec: Address, tokenIn: Address, tokenOut: Address,
): Promise<Omit<RepaySizing, 'bufferBps'>> {
  const c = { address: exec, abi: HopExecutorAbi } as const;
  const pc = client.publicClient;
  const windowed = client.chainConfig.contractBlockIsL1 === true;
  const [{ decimals }, [maxIn, maxOut], feePpm, left] = await Promise.all([
    client.mains.tokenMeta(tokenIn),
    pc.readContract({ ...c, functionName: 'getCaps', args: [tokenIn, tokenOut] }),
    pc.readContract({ ...c, functionName: 'feePpm' }),
    windowed ? pc.readContract({ ...c, functionName: 'capsLeft', args: [tokenIn, tokenOut] }) : undefined,
  ]);
  const s: Omit<RepaySizing, 'bufferBps'> = { unit: 10n ** BigInt(decimals), maxIn, maxOut, feePpm, tokenIn, tokenOut };
  if (left) [s.inLeft, s.outLeft] = left;
  return s;
}

/**
 * The `tokenIn` to send through an outside route to repay `target` of `tokenOut` (raw units): the least amount whose
 * quote reaches `target` (exact to one raw unit of `tokenOut`), plus `bufferBps`, trimmed to the route's caps (`maxIn`,
 * and `maxOut` on the payout; what is left of them with `inLeft` / `outLeft`) so the buffered amount still goes
 * through. `quote` is `quoteHop` (net of the route fee). A target over the route's cap throws "above cap"; one within
 * the full caps but over what other swaps left in the current window says to wait about 12 seconds.
 */
export async function sizeRepayWith(quote: (x: bigint) => Promise<bigint>, target: bigint, s: RepaySizing): Promise<bigint> {
  const { feePpm, tokenIn, tokenOut } = s;
  const net = (out: bigint) => out - (out * feePpm) / PPM;
  if (target > net(s.maxOut)) throw new ValidationError('above cap', `Repaying ${target} of ${tokenOut} is above the route's ${net(s.maxOut)} cap.`);
  const maxIn = s.inLeft != null && s.inLeft < s.maxIn ? s.inLeft : s.maxIn;
  const maxOut = s.outLeft != null && s.outLeft < s.maxOut ? s.outLeft : s.maxOut;
  const wait = maxIn < s.maxIn || maxOut < s.maxOut ? CAP_WAIT_HINT : '';
  const maxNet = net(maxOut);
  if (target > maxNet || maxIn === 0n) {
    throw new ValidationError('above cap', `Repaying ${target} of ${tokenOut} is above what the route has left now (${maxIn} of ${tokenIn} in, ${maxNet} of ${tokenOut} out).${wait}`);
  }
  let lo = 0n;
  let qLo = 0n;
  let prev = 0n;
  let qPrev = 0n;
  let hi: bigint | undefined;
  let qHi = 0n;
  let top = maxIn + 1n;
  let lastHi = false;
  let x = s.unit < maxIn ? s.unit : maxIn;
  for (let i = 0; i < 40; i++) {
    let q: bigint;
    try {
      q = await quote(x);
    } catch (e) {
      if (!isRevertNamed(e, 'above cap') || x - lo <= 1n) throw e;
      top = x;
      x = lo + (x - lo) / 2n;
      continue;
    }
    if (q >= target) {
      hi = x; qHi = q; lastHi = true;
    } else {
      if (lo > 0n) { prev = lo; qPrev = qLo; }
      lo = x; qLo = q; lastHi = false;
    }
    if (hi !== undefined && (hi - lo <= 1n || qHi === target)) break;
    const low = qLo === 0n ? lo * 2n
      : prev > 0n && qLo > qPrev ? lo + ((lo - prev) * (target - qLo)) / (qLo - qPrev)
        : (lo * target) / qLo;
    let next: bigint;
    if (hi === undefined) {
      next = low > 2n * lo ? low : 2n * low - lo;
      if (next <= lo) next = lo + 1n;
      if (next >= top) {
        if (lo >= top - 1n) break;
        next = top - 1n;
      }
    } else {
      const up = lo + ceilDiv((hi - lo) * (target - qLo), qHi - qLo);
      next = !lastHi ? up : qLo > 0n ? low : 2n * up - hi;
      if (next <= lo || next >= hi) next = lo + (hi - lo) / 2n;
    }
    x = next;
  }
  if (hi === undefined) {
    throw new ValidationError(
      lo + 1n >= top ? 'above cap' : 'quote',
      `Could not size ${tokenIn} to repay ${target} of ${tokenOut} from the route's quotes (the route takes at most ${maxIn} of it now).${wait}`,
    );
  }
  let amount = maxWithSlippage(hi, s.bufferBps);
  if (amount > maxIn) amount = maxIn;
  const grossHi = ceilDiv(qHi * PPM, PPM - feePpm);
  const outCap = grossHi === 0n ? amount : (hi * maxOut) / grossHi;
  if (amount > outCap) amount = outCap > hi ? outCap : hi;
  return amount;
}

const PPM = 1_000_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** The end of an 'above cap' refusal that waiting clears: other swaps used part of the route's caps in this window. */
export const CAP_WAIT_HINT = ' Other swaps used part of the route\'s cap in this window: wait about 12 seconds and try again.';

/**
 * What the exchange pays before the hop fee for a quote `out` net of it (`quoteHop`): the figure the route's `maxOut`
 * cap is checked against. Rounded down, so a hop exactly at the cap is not refused.
 */
export function grossOfHop(out: bigint, feePpm: bigint): bigint {
  return feePpm > 0n ? (out * PPM) / (PPM - feePpm) : out;
}

/** The 'above cap' refusal of `amountIn` of `tokenIn` through the outside route to `tokenOut`, from its cap check. */
function aboveCap(c: HopCapCheck, amountIn: bigint, tokenIn: Address, tokenOut: Address): ValidationError {
  if (c.busy) {
    return new ValidationError('above cap', `${amountIn} of ${tokenIn} is above what the outside route has left now (${c.capsLeft.inLeft} of ${tokenIn} in, ${c.capsLeft.outLeft} of ${tokenOut} out before the hop fee).${CAP_WAIT_HINT}`);
  }
  return new ValidationError('above cap', `${amountIn} of ${tokenIn} is above the outside route's caps (${c.caps.maxIn} of ${tokenIn} in, ${c.caps.maxOut} of ${tokenOut} out before the hop fee): send less.`);
}

/**
 * `quote(amountIn)` for an amount the caller chose (not a sizing) through `exec`'s outside route `tokenIn` -> `tokenOut`,
 * checked first the way a swap sent now is (`hopExecutor.checkCaps`: what other swaps left of the caps in the current
 * window on Robinhood Chain, else the full caps): `amountIn` against the input cap, then the payout before the hop fee
 * against the output cap. Refuses 'above cap', saying to wait about 12 seconds when the amount fits the full caps but
 * not what is left now. `quote` is `quoteHop` on `exec` (net of the hop fee).
 */
export async function quoteHopWithinCaps(
  client: BasisClient, exec: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, quote: (x: bigint) => Promise<bigint>,
): Promise<bigint> {
  const hop = client.hopExecutor;
  const pre = await hop.checkCaps(tokenIn, tokenOut, amountIn, undefined, { executor: exec });
  if (pre.blocked) throw aboveCap(pre, amountIn, tokenIn, tokenOut);
  let out: bigint;
  let feePpm: bigint;
  try {
    [out, feePpm] = await Promise.all([
      quote(amountIn),
      client.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'feePpm' }),
    ]);
  } catch (e) {
    if (isRevertNamed(e, 'above cap')) throw aboveCap({ ...pre, busy: false }, amountIn, tokenIn, tokenOut);
    throw e;
  }
  const post = await hop.checkCaps(tokenIn, tokenOut, amountIn, grossOfHop(out, feePpm), { executor: exec });
  if (post.blocked) throw aboveCap(post, amountIn, tokenIn, tokenOut);
  return out;
}

/**
 * An explicit deadline (unix seconds) as sent, or `ValidationError('Deadline')` when it has passed: before the latest
 * block time `now`. A deadline equal to `now` can still be met, but only just: give some room.
 */
export function checkDeadline(deadline: bigint, now: bigint): bigint {
  if (deadline < now) throw new ValidationError('Deadline', `deadline ${deadline} has passed (chain time ${now}).`);
  return deadline;
}

/**
 * Refuses an explicit minimum (`explicit`, raw units; undefined / null = not given) above `quoted`, the SDK's exact quote
 * of what the write produces now (`what` names it): the write would be refused ("Min out"), so it is refused before any
 * approval. A minimum at or under the quote passes.
 */
export function checkExplicitMin(explicit: bigint | null | undefined, quoted: bigint, field: string, what: string): void {
  if (explicit != null && explicit > quoted) {
    throw new ValidationError('Min out', `${field} ${explicit} is above ${what} now (${quoted}), so it would be refused: lower it, or omit it to derive it from the quote.`);
  }
}
