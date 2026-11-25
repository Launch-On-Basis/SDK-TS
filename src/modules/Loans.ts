import { type Address, type ContractFunctionReturnType, maxUint256, zeroAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import { ERC20Abi, HopExecutorAbi, LoanHubAbi, MainTokenAbi, SwapAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import {
  type CoreLoan, type PartialSellExit, checkDeadline, checkExplicitMin, coreExtendRefusal, isAssetPaused, isPairActive,
  pairAssetPaused, pairNotActive, quoteHopWithinCaps, quotePartialSell, readCoreLoan, readRepaySizing, sizeRepayWith,
} from '../core/loans';
import { type AmountOf, amountOf, optAmount, pairAmountOf } from '../core/amounts';
import { type MainInfo, type MainRef, pairAmount } from '../core/mains';
import { multicall } from '../core/multicall';
import { optionKeys, optsOf } from '../core/opts';
import { addMissingEventWarning } from '../core/events';
import { decodeRevert } from '../core/revert';
import { type Amount, maxWithSlippage, optUint, toAddress, toBool, toUint, validateSlippageBps } from '../core/units';
import { CLAIM_PERIOD_SECONDS } from './Liquidation';

export interface HubPartialSellOptions {
  /** Explicit minimum pair asset paid to the wallet (raw, after the exit fee). Omit (or null) to derive it from a quote. Never 0. */
  minOut?: bigint | null;
  /** Slippage for the derived minimum, bps (default `client.slippageBps.trade`, 1%). */
  slippageBps?: number | null;
}
const HUB_PARTIAL_SELL_KEYS = optionKeys<HubPartialSellOptions>({ minOut: true, slippageBps: true });

/** Options of `repayLoan`. */
export interface HubRepayOptions {
  /** Raw stable to repay; omitted or null: in full. */
  amount?: bigint | null;
}
const HUB_REPAY_KEYS = optionKeys<HubRepayOptions>({ amount: true });

/** Options of `getUserLoans`. */
export interface GetUserLoansOptions {
  /** Open loans only (default false). */
  activeOnly?: boolean | null;
}
const GET_USER_LOANS_KEYS = optionKeys<GetUserLoansOptions>({ activeOnly: true });

/** Options of `quoteRepayLoanWith`. */
export interface QuoteRepayLoanWithOptions {
  /** `tokenIn` to quote (raw); omitted or null: the amount that repays the whole debt. */
  amountIn?: bigint | null;
  /** Headroom on a repay-all sizing, bps (default 50 = 0.5%). */
  bufferBps?: number | null;
  /** Whose loan (default the signer). */
  user?: Address | null;
}
const QUOTE_REPAY_LOAN_WITH_KEYS = optionKeys<QuoteRepayLoanWithOptions>({ amountIn: true, bufferBps: true, user: true });

/** Hub loan details. Collateral amounts raw collateral-token units; debt raw pair asset. */
export interface HubLoanDetails {
  hubId: bigint;
  /** The main of this loan. */
  ecosystem: Address;
  /** The loan's id on its main (the `loanId` `client.liquidation` reads take, with the loan hub as `user`). */
  coreLoanId: bigint;
  collateralToken: Address;
  /** Same as `collateralToken`. */
  token: Address;
  collateralAmount: bigint;
  liquidatedAmount: bigint;
  /** Debt to repay, raw pair asset. */
  fullAmount: bigint;
  /** Borrowed, raw pair asset. */
  borrowedAmount: bigint;
  /** Unix seconds when it becomes liquidatable. */
  liquidationTime: bigint;
  /** Collateral claimable after a liquidation (`claimLiquidation`). */
  liquidationClaim: bigint;
  isLiquidated: boolean;
  active: boolean;
  creationTime: bigint;
}

/** One row of `getUserLoans`: the hub details plus the closure time (raw units as in `HubLoanDetails`). */
export interface UserHubLoan extends HubLoanDetails {
  /** The hub the loan is on (the module's hub: the address book's, or the one given to `atHub`). */
  hub: Address;
  /** Unix seconds the loan closed (repaid, sold or liquidated), 0 while open. */
  timeOfClosure: bigint;
  /**
   * Liquidated loans: unix seconds from which an unclaimed leftover (`liquidationClaim`) can be taken
   * (`timeOfClosure + CLAIM_PERIOD_SECONDS`, 365 days); 0 otherwise.
   */
  claimDeadline: bigint;
}

/** A main's loan setup (`getEcosystem`): `stable` is the main's pair asset, `swapContract` the swap its partial sells and repay-withs use. */
export interface HubEcosystem {
  stable: Address;
  swapContract: Address;
  active: boolean;
}

/** Loan settings of a main (all read from chain). */
export interface LoanTerms {
  main: Address;
  minDays: bigint;
  maxDays: bigint;
  /** Minimum collateral value of a new loan (pair asset). */
  minimumLoan: Amount;
  /** Static fee on the collateral value, bps. */
  staticFeeBps: bigint;
  /** Daily fee, in units of 0.001% of the amount per day. */
  dynamicFeePercentage: bigint;
}

/** Preview of `takeLoan`: the figures, and whether `takeLoan` would go through now. */
export interface LoanQuote {
  main: Address;
  /** Collateral value = the debt to repay (`fullAmount`), pair asset. */
  collateralValue: Amount;
  /** The loan fee, pair asset. */
  fee: Amount;
  /** Paid out to the borrower, pair asset. */
  borrowed: Amount;
  /** `collateralValue >= minimumLoan`. */
  meetsMinimum: boolean;
  /** The fees take the whole value (`fee >= collateralValue`, `borrowed` 0): `takeLoan` refuses "No stable received". */
  feesExceedValue: boolean;
  /** `takeLoan` with these arguments would go through now (no `refusal`). */
  possible: boolean;
  /**
   * The rule `takeLoan` would refuse it with, in its order, or null: "cannot be zero", "pair not active" (the main's
   * pair is paused), "Ecosystem inactive", "Unauthorized caller", "Open loan: increase it" (checked for `user` when
   * there is one), "incorrect loan duration", "Minimum loan amount not met", "No stable received". The wallet's
   * balance is not checked.
   */
  refusal: string | null;
}

/** Preview of `increaseLoan(hubId, amountToAdd)`. Raw pair asset. */
export interface HubIncreaseQuote {
  hubId: bigint;
  /** Collateral value after the add. */
  newCollateralValue: bigint;
  /** Added to the debt (0 when the add gives no borrowing power). */
  addedValue: bigint;
  /** The fee for the add, over the whole days left. */
  fee: bigint;
  /** Paid out (0 when the fees take it all). */
  borrowed: bigint;
  /** Whole days left on the loan at the next block (the days the fee is charged for). */
  daysLeft: bigint;
  /**
   * `increaseLoan` goes through: the pair is live, more than the main's minimum loan days left, borrowing power, and
   * the fees below `addedValue`.
   */
  possible: boolean;
  /**
   * The rule `increaseLoan` would refuse it with, in its order, or null: "pair not active" (the main's pair is paused),
   * "Duration too short", "Zero amount", "No borrowing power", "Fees exceed value". The wallet's balance is not checked.
   */
  refusal: string | null;
}

/** Extension preview of a hub loan (`getExtensionQuote`); fee / extraOut raw pair asset. */
export interface LoanExtensionQuote {
  possible: boolean;
  fee: bigint;
  /** Pair asset a refinance pays out. */
  extraOut: bigint;
}

/** Preview of `repayLoan(hubId, { amount })`. All amounts raw: debt / stable in the pair asset, collateral in its token's units. */
export interface HubRepayPreview {
  hubId: bigint;
  /** The loan is open. A closed loan (repaid, sold or liquidated) keeps its old debt / collateral figures: not `allowed`. */
  active: boolean;
  /** The debt now (`fullAmount`). */
  debt: bigint;
  /** The main's `minimumLoan`: a partial repay must leave at least this much debt. */
  minimumLoan: bigint;
  /** The largest partial repay (`debt - minimumLoan`, 0 when the debt is at or under the minimum: repay in full). */
  maxPartial: bigint;
  /** The stable this repay takes: `min(amount, debt)`. */
  amount: bigint;
  /** `amount >= debt`: the loan closes and all collateral comes back. */
  full: boolean;
  /** The repay goes through: an open loan, and a full repay or a partial one leaving at least `minimumLoan` ("Repay in full" otherwise). */
  allowed: boolean;
  /** Collateral sent back: all of it on a full repay, else the repaid share of it (rounded down). */
  collateralReleased: bigint;
  collateralLeft: bigint;
  debtLeft: bigint;
}

/** Preview of `repayLoanWith`: `tokenIn` converted to the stable through an outside route. Raw units. */
export interface HubRepayWithQuote {
  hubId: bigint;
  tokenIn: Address;
  /** The loan's stable (the main's pair asset). */
  stable: Address;
  debt: bigint;
  /** `tokenIn` to send. Sized for the whole debt plus `bufferBps` (within the route's caps) when the caller gave none. */
  amountIn: bigint;
  /** Stable it converts to now (net of the route fee; `amountIn` itself when `tokenIn` is the stable). */
  stableOut: bigint;
  /** `stableOut >= debt`: it repays everything (send with `close`). */
  covers: boolean;
  /** Stable refunded after a full repay (`stableOut - debt`), else 0. */
  refund: bigint;
  /** Collateral that comes back (all on a full repay, else its share). */
  collateralReleased: bigint;
}

export interface HubRepayWithOptions {
  /** `tokenIn` to send (raw). Omitted (or null): sized to repay the whole debt (quote + `bufferBps`) and `close` defaults to true. */
  amountIn?: bigint | null;
  /**
   * Explicit minimum stable out of the conversion (raw, never 0; above the quote's `stableOut`: "Min out"). Omitted: the
   * quote minus `slippageBps`, and at least the debt with `close`.
   */
  minStableOut?: bigint | null;
  /**
   * Refuse ("Not enough to close") unless the conversion covers the whole debt. Default: true when `amountIn` is omitted
   * or its quote covers the debt (all or nothing, so a move within slippage cannot leave the loan part-repaid), else false.
   */
  close?: boolean | null;
  /** Slippage for the derived minimum, bps (default `client.slippageBps.trade`, 1%). */
  slippageBps?: number | null;
  /** Headroom on a repay-all sizing, bps (default 50 = 0.5%); the unused stable is refunded. */
  bufferBps?: number | null;
  /** Unix seconds, not before the latest block time ("Deadline" otherwise; default: latest block time + 600 s). */
  deadline?: bigint | null;
}
const HUB_REPAY_WITH_KEYS = optionKeys<HubRepayWithOptions>({
  amountIn: true, minStableOut: true, close: true, slippageBps: true, bufferBps: true, deadline: true,
});

/**
 * What a repay did, read from the transaction (null when the expected event is missing: see `warnings`). Money figures
 * are `Amount`s: the stable in the loan main's pair asset, collateral in the collateral token.
 */
export interface HubRepayResult extends TxResult {
  /** True when the loan closed, false for a partial repay. */
  closed: boolean | null;
  /** Stable that went to the debt (partial: the amount repaid; full: the whole debt). */
  repaid: Amount | null;
  /** Collateral sent back to the wallet (partial: its share; full: all of the collateral). */
  collateralReleased: Amount | null;
}

export interface HubRepayWithResult extends HubRepayResult {
  /**
   * Stable the token converted to, and the part of it refunded. All of `stableOut` goes to the debt: a route paying more
   * than quoted repays more on a partial (`repaid` = `stableOut`, more collateral back, `refund` 0); only what is above
   * the whole debt is refunded.
   */
  stableOut: Amount | null;
  refund: Amount | null;
}

/** What `extendLoan` did. */
export interface HubExtendResult extends TxResult {
  /** Unix seconds of the new liquidation time. */
  newLiquidationTime: bigint | null;
  /** The debt after the extension (pair asset; a fee added to the debt or a refinance raise it). */
  newFullAmount: Amount | null;
  /** Pair asset a refinance paid to the wallet (0 otherwise). */
  extraOut: Amount;
}

export interface HubIncreaseResult extends TxResult {
  /** Pair asset paid out. */
  borrowed: Amount | null;
}

export interface HubClaimLiquidationResult extends TxResult {
  /** Collateral paid to the wallet, in the collateral token. */
  claimed: Amount | null;
}

export interface HubPartialSellResult extends TxResult {
  /** Pair asset paid to the wallet, net of the exit fee (as `trading.partialSellLeverage`'s `payout`). */
  payout: Amount | null;
}

/**
 * Preview of `partialSellLoan(hubId, pct)`. Raw pair asset except `collateralSold` (collateral units). `gross` is the
 * payout before the exit fee, `taxBps` the borrower's own sell rate, `fee` that rate on the whole sale, and `net` what
 * the wallet gets (`minOut` binds it); `taxable` always equals `gross` on a hub loan.
 */
export interface HubPartialSellQuote extends PartialSellExit {
  collateralSold: bigint;
  debtRepaid: bigint;
}

export interface TakeLoanResult extends TxResult {
  /** The new hub loan id (ids run 1..`getUserLoanCount`). */
  hubId: bigint | null;
  /** The loan's id on its main (the `loanId` `client.liquidation` reads take, with the loan hub as `user`). */
  coreLoanId: bigint | null;
  /** Pair asset paid out. */
  borrowed: Amount | null;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const DAY = 86_400n;
/** Hub loans read per multicall in `getUserLoans` (a deployless multicall stays small). */
const LOANS_PAGE = 100;
/** Default headroom on a repay-all `repayLoanWith` sizing: 0.5%. */
const REPAY_WITH_BUFFER_BPS = 50;
/** `repayLoanWith` deadline: latest block + 600 s. */
const REPAY_WITH_DEADLINE = 600;

/** How `tokenIn` converts to a loan's stable: itself (`direct`), or `quoteHop` on the route executor `exec`. */
interface RepayRoute {
  stable: Address;
  direct: boolean;
  exec: Address;
  quote: (x: bigint) => Promise<bigint>;
}

/**
 * Hub partial sells take 10-100 % in steps of 10 (a bigint or an integer number, as PY takes any int), checked in
 * order: "% by 10", then "% range". Returns it as a number.
 */
function checkSellPct(percentage: number | bigint): number {
  const p = typeof percentage === 'bigint' ? percentage
    : typeof percentage === 'number' && Number.isInteger(percentage) ? BigInt(percentage) : null;
  if (p === null || p % 10n !== 0n) {
    throw new ValidationError('% by 10', `percentage must be a multiple of 10 (10-100), got ${String(percentage)}.`);
  }
  if (p < 10n || p > 100n) {
    throw new ValidationError('% range', `percentage must be 10-100, got ${String(percentage)}.`);
  }
  return Number(p);
}

/** A hub given to `atHub`: an address (`toAddress`), not the zero address (rule "hub"), checksummed. */
function checkHub(hub: Address): Address {
  const a = toAddress(hub, 'hub');
  if (isZeroAddress(a)) throw new ValidationError('hub', `hub must be a non-zero address, got ${String(hub)}.`);
  return a;
}

/** An optional wallet argument through `toAddress` (rule `user`), undefined when omitted (undefined or null). */
function optUser(user: Address | null | undefined): Address | undefined {
  return user == null ? undefined : toAddress(user, 'user');
}

/**
 * `client.loans`: borrow the pair asset against a main or a factory token, then repay (in full or in part, in the
 * stable or another token), extend, top up, sell part, or claim what is left after a liquidation. Loans are made by the
 * BASIS protocol. A loan can be liquidated once its `liquidationTime` has passed. Hub ids are per wallet (`coreLoanId`
 * is the loan's id on its main). A wallet has ONE open loan per (main, collateral token): a second borrow there is
 * refused, `increaseLoan` adds to the open one. A vault position's loan belongs to the vault, not the wallet. Every
 * method works on the address book's loan hub; `atHub(hub)` reaches the loans on an older hub. An optional parameter
 * or option given as null counts as not given (as PY None). An options argument must be a plain object (or left out):
 * a positional value in its place (`repayLoan(id, 50_000000n)`) is refused, rule 'options', before any read.
 */
export class LoansModule extends BaseModule {
  /** The hub given to `atHub`, or null for the address book's. */
  private readonly hubOverride: Address | null;

  constructor(client: BasisClient, hub?: Address) {
    super(client);
    this.hubOverride = hub === undefined ? null : checkHub(hub);
  }

  /** True when the module's hub has an address (the address book's, or the one given to `atHub`). */
  get deployed(): boolean {
    return !isZeroAddress(this.hubOverride ?? this.client.addresses.loanHub);
  }

  private get hub(): Address {
    return this.require(this.hubOverride ?? this.client.addresses.loanHub, 'LoanHub');
  }

  /**
   * This module on another loan hub, e.g. an older one (the address book follows the current one). An older hub keeps
   * serving its own loans: every read here (`getUserLoans`, `getUserLoanDetails`, the quotes, ...) and every write on an
   * existing loan (`repayLoan`, `repayLoanWith`, `extendLoan`, `increaseLoan`, `partialSellLoan`, `claimLiquidation`)
   * then runs on `hub`. Hub ids count per hub. New loans open only on a main's current hub: `takeLoan` elsewhere is
   * refused ("Unauthorized caller"). Rule `hub` (not a non-zero address). No RPC.
   */
  atHub(hub: Address): LoansModule {
    return new LoansModule(this.client, checkHub(hub));
  }


  /**
   * Borrow against `amount` (raw) of `collateral` for `numberOfDays`. The main is derived from the collateral (the
   * collateral itself, or the main it trades against). Checks the pair ("pair not active" while it is paused), that the
   * main takes loans on this hub ("Ecosystem inactive", "Unauthorized caller"), one open loan per (main, collateral)
   * ("Open loan: increase it": use `increaseLoan` on it), the days range, the minimum value `minimumLoan`, 'pair asset
   * paused' (its issuer paused the pair asset the loan pays out), fees below the value ("No stable received") and the
   * balance; approves the collateral to the loan hub.
   * Pays out the pair asset. Returns `hubId`, `coreLoanId` and `borrowed`.
   */
  async takeLoan(collateral: Address, amount: bigint, numberOfDays: bigint | number): Promise<TakeLoanResult> {
    const hub = this.hub;
    const amt = toUint(amount, 'amount');
    if (amt === 0n) throw new ValidationError('cannot be zero', 'Collateral amount must be greater than 0.');
    const days = toUint(numberOfDays, 'numberOfDays');
    collateral = toAddress(collateral, 'collateral');
    const me = this.account;
    const { info, error } = await this.loanPlan(collateral, amt, days, me);
    if (error) throw error;
    const bal = await this.balanceOf(collateral);
    if (bal < amt) throw new ValidationError('balance', `Balance of ${collateral} is ${bal}, below the ${amt} needed.`);

    await this.ensureAllowance(collateral, hub, amt);
    const tx = await this.send({
      address: hub, abi: LoanHubAbi, functionName: 'takeLoan', args: [info.main, collateral, amt, days], contract: 'LoanHub',
    });
    const ev = this.expectEvent(tx, LoanHubAbi, 'LoanCreated', hub, 'LoanHub', ['hubId', 'coreLoanId', 'borrowed']);
    return { ...tx, hubId: ev?.hubId ?? null, coreLoanId: ev?.coreId ?? null, borrowed: optAmount(pairAmountOf(info), ev?.borrowed) };
  }

  /**
   * Repay a hub loan with its stable (the main's pair asset); nothing is sold. `amount` (raw) omitted or null = in full
   * (exactly the debt is taken and all collateral comes back). Under the debt: the debt drops by it, the repaid share of
   * the collateral comes back and the loan stays open; what is left must stay at least the main's `minimumLoan`
   * ("Repay in full"; `getRepayPreview` gives the largest partial). Then 'pair asset paused' (its issuer paused the
   * stable: the debt cannot be paid in) and the balance. Approves the stable taken to the loan hub.
   * Returns `closed`, `repaid` and `collateralReleased`.
   */
  async repayLoan(hubId: bigint | number, opts: HubRepayOptions | null = {}): Promise<HubRepayResult> {
    const o = optsOf(opts, HUB_REPAY_KEYS);
    const id = toUint(hubId, 'hubId');
    const hub = this.hub;
    const amount = o.amount == null ? maxUint256 : toUint(o.amount, 'amount');
    if (amount === 0n) throw new ValidationError('Zero amount', 'amount must be greater than 0 (omit it to repay in full).');
    const d = await this.getUserLoanDetails(this.account, id);
    if (!d.active) throw new ValidationError('Core loan inactive', `Hub loan ${id} is not active (repaid, sold or liquidated).`);
    const p = await this.repayPreview(d, amount);
    if (!p.allowed) {
      throw new ValidationError('Repay in full', `Repaying ${amount} of ${p.debt} would leave ${p.debtLeft}, under the minimum loan ${p.minimumLoan}: repay at most ${p.maxPartial}, or in full.`);
    }
    const { stable } = await this.getEcosystem(d.ecosystem);
    await this.refusePaused(d, stable, 'the loan cannot be repaid in it now');
    const bal = await this.balanceOf(stable);
    if (bal < p.amount) throw new ValidationError('balance', `Balance of ${stable} is ${bal}, below the ${p.amount} to repay.`);
    const f = await this.loanFormats(d);
    await this.ensureAllowance(stable, hub, p.amount);
    const tx = await this.send({ address: hub, abi: LoanHubAbi, functionName: 'repayLoan', args: [id, amount], contract: 'LoanHub' });
    return { ...tx, ...this.repaidFigures(tx, d, stable, f) };
  }

  /**
   * Repay a hub loan with another token (e.g. OUT, or USDG on an NVDA+ loan): `tokenIn` is converted to the stable
   * through an outside route (net of the route fee), all of it goes to the debt (a partial repay releases its share of
   * the collateral) and the stable left over is refunded.
   * Without `amountIn` it is sized to repay everything: the amount quoting the debt, plus `bufferBps` (0.5%), with
   * `close` = true. An explicit `amountIn` whose quote covers the debt also defaults `close` to true; with `close` or a
   * covering quote the derived `minStableOut` is at least the debt. A partial repay must stay a valid partial even if
   * the route pays up to the slippage more than quoted ("Repay in full"). Checks the deadline first (default latest
   * block + 600 s; an explicit one before the latest block time: "Deadline"), then the route ("No swap for ecosystem",
   * "no executor", "no route"), 'pair asset paused' (its issuer paused the stable the debt is paid in), an explicit
   * `amountIn` against the balance and against what the route's caps allow a swap sent now ("above cap": what other
   * swaps left of them in the current window on Robinhood Chain, where waiting about 12 seconds can clear it), an
   * explicit `minStableOut` above the quote ("Min out") and the balance; approves `tokenIn` to the loan hub.
   */
  async repayLoanWith(hubId: bigint | number, tokenIn: Address, opts: HubRepayWithOptions | null = {}): Promise<HubRepayWithResult> {
    const o = optsOf(opts, HUB_REPAY_WITH_KEYS);
    const id = toUint(hubId, 'hubId');
    const explicit = optUint(o.minStableOut, 'minStableOut');
    const optDeadline = optUint(o.deadline, 'deadline');
    const closeOpt = o.close == null ? undefined : toBool(o.close, 'close');
    if (o.bufferBps != null) validateSlippageBps(o.bufferBps, 'bufferBps');
    if (o.slippageBps != null) validateSlippageBps(o.slippageBps);
    tokenIn = toAddress(tokenIn, 'tokenIn');
    const hub = this.hub;
    const me = this.account;
    const deadline = await this.sendDeadline(optDeadline);
    const d = await this.getUserLoanDetails(me, id);
    if (!d.active) throw new ValidationError('Core loan inactive', `Hub loan ${id} is not active (repaid, sold or liquidated).`);
    const sizing = o.amountIn == null;
    const route = await this.repayRoute(d, tokenIn);
    await this.refusePaused(d, route.stable, 'the loan cannot be repaid in it now');
    if (!sizing) {
      const amt = toUint(o.amountIn as bigint, 'amountIn');
      if (amt === 0n) throw new ValidationError('Zero amount', 'amountIn must be greater than 0.');
      const have = await this.balanceOf(tokenIn);
      if (have < amt) throw new ValidationError('balance', `Balance of ${tokenIn} is ${have}, below the ${amt} needed.`);
    }
    const q = await this.repayWithQuote(d, tokenIn, o.amountIn, o.bufferBps, route);
    const close = closeOpt ?? (sizing || q.covers);
    if (close && !q.covers) {
      throw new ValidationError('Not enough to close', `${q.amountIn} of ${tokenIn} converts to ${q.stableOut}, under the ${q.debt} debt.`);
    }
    if (!q.covers) {
      const p = await this.repayPreview(d, q.stableOut);
      const high = route.direct ? q.stableOut : maxWithSlippage(q.stableOut, o.slippageBps ?? this.client.slippageBps.trade);
      if (!p.allowed || high > p.maxPartial) {
        throw new ValidationError('Repay in full', `${q.amountIn} of ${tokenIn} converts to ${q.stableOut} (up to ${high} after slippage), which could leave under the minimum loan ${p.minimumLoan} of the ${p.debt} debt: repay at most ${p.maxPartial} worth (less the slippage), or everything.`);
      }
    }
    let minStableOut = await this.resolveMin(explicit, o.slippageBps, async () => q.stableOut, 'trade', 'minStableOut');
    checkExplicitMin(explicit, q.stableOut, 'minStableOut', `what ${q.amountIn} of ${tokenIn} converts to`);
    if (explicit == null && (close || q.covers) && minStableOut < q.debt) minStableOut = q.debt;
    const bal = await this.balanceOf(tokenIn);
    if (bal < q.amountIn) throw new ValidationError('balance', `Balance of ${tokenIn} is ${bal}, below the ${q.amountIn} needed.`);
    const f = await this.loanFormats(d);
    await this.ensureAllowance(tokenIn, hub, q.amountIn);
    const tx = await this.send({
      address: hub, abi: LoanHubAbi, functionName: 'repayLoanWith',
      args: [id, tokenIn, q.amountIn, minStableOut, close, deadline], contract: 'LoanHub',
    });
    const ev = this.expectEvent(tx, LoanHubAbi, 'RepaidWith', hub, 'LoanHub', ['stableOut', 'refund']);
    return {
      ...tx, ...this.repaidFigures(tx, d, route.stable, f), stableOut: optAmount(f.pair, ev?.stableOut), refund: optAmount(f.pair, ev?.refund),
    };
  }

  /**
   * Extend a hub loan by `numberOfDays` (`getLoanTerms` `minDays..maxDays`, or 0 with `refinance`). The days count from
   * the due date, or from the time of the transaction when the loan is past due (not yet liquidated): the new due date
   * is the later of the two plus `numberOfDays`.
   * `payInPairAsset`: the fee is paid from the wallet (the stable is approved to the loan hub); otherwise it is added to
   * the debt, or with `refinance` the surplus collateral value is borrowed out. `payInPairAsset && refinance` is
   * refused. A paused pair is refused next ("pair not active"), and so is a stable its issuer paused ('pair asset
   * paused'), before any approval. Then, in order: "Must be refinance if not extending time", "incorrect loan duration",
   * "Loan not active", then "Not enough collateral to cover fees" (add to debt) or "No equity", "Minimum surplus not
   * met", "Time remaining too short", "Fees exceed surplus value" (refinance). A pay-in passes once the days and the
   * loan are valid. Returns `newLiquidationTime`, `newFullAmount` and the refinance payout `extraOut`.
   */
  async extendLoan(hubId: bigint | number, numberOfDays: bigint | number, payInPairAsset: boolean, refinance: boolean): Promise<HubExtendResult> {
    payInPairAsset = toBool(payInPairAsset, 'payInPairAsset');
    refinance = toBool(refinance, 'refinance');
    if (payInPairAsset && refinance) {
      throw new ValidationError('Pay in stable or refinance, not both', 'Choose either payInPairAsset or refinance, not both.');
    }
    const id = toUint(hubId, 'hubId');
    const hub = this.hub;
    const me = this.account;
    const days = toUint(numberOfDays, 'numberOfDays');
    const d = await this.getUserLoanDetails(me, id);
    const [q, live] = await Promise.all([this.extensionQuote(d, days, payInPairAsset, refinance), isPairActive(this.client, d.ecosystem)]);
    if (!live) throw pairNotActive(d.ecosystem);
    const { stable } = await this.getEcosystem(d.ecosystem);
    await this.refusePaused(d, stable, 'no extension can take its fee');
    const refusal = await coreExtendRefusal(this.client, d.ecosystem, d, days, payInPairAsset, refinance, q);
    if (refusal) throw refusal;
    const pair = pairAmountOf(await this.client.mains.get(d.ecosystem));
    if (payInPairAsset && q.fee > 0n) {
      const bal = await this.balanceOf(stable);
      if (bal < q.fee) throw new ValidationError('balance', `Balance of ${stable} is ${bal}, below the ${q.fee} fee.`);
      await this.ensureAllowance(stable, hub, q.fee);
    }
    const tx = await this.send({
      address: hub, abi: LoanHubAbi, functionName: 'extendLoan', args: [id, days, payInPairAsset, refinance], contract: 'LoanHub',
    });
    const ev = this.events(tx, MainTokenAbi, 'LoanExtended', d.ecosystem).find((e) => eq(e.user, hub) && e.loanId === d.coreLoanId);
    if (!ev) addMissingEventWarning(tx, 'MainToken', 'LoanExtended', ['newLiquidationTime', 'newFullAmount']);
    const extraOut = refinance ? this.transferred(tx, stable, hub, me) : 0n;
    return { ...tx, newLiquidationTime: ev?.newLiquidationTime ?? null, newFullAmount: optAmount(pair, ev?.newFullAmount), extraOut: pair(extraOut) };
  }

  /**
   * Add `amountToAdd` (raw) of the loan's collateral token and borrow the added value (minus fees) in the pair asset.
   * Rules: "Loan not active", "pair not active" (the main's pair is paused), then in order: "Duration too short" (needs
   * more than the main's `minDays` days left), "Zero amount", "No borrowing power", "Fees exceed value"
   * (`quoteIncreaseLoan` previews the payout), then 'pair asset paused' (its issuer paused the pair asset the top-up
   * pays out) and "balance". Approves the collateral to the loan hub; after an approval it sent, "Duration too short"
   * is checked again before the increase is sent (fewer days are left by then). Returns `borrowed`.
   */
  async increaseLoan(hubId: bigint | number, amountToAdd: bigint): Promise<HubIncreaseResult> {
    const id = toUint(hubId, 'hubId');
    const hub = this.hub;
    const amt = toUint(amountToAdd, 'amountToAdd');
    const d = await this.getUserLoanDetails(this.account, id);
    if (!d.active) throw new ValidationError('Loan not active', `Hub loan ${id} is not active.`);
    const q = await this.increaseQuote(d, amt);
    if (!q.live) throw pairNotActive(d.ecosystem);
    const tooShort = () => new ValidationError('Duration too short', `Hub loan ${id} needs more than ${q.minDays} days left to be increased; extend it first.`);
    if (!q.timeOk) throw tooShort();
    if (amt === 0n) throw new ValidationError('Zero amount', 'amountToAdd must be greater than 0.');
    if (q.newCollateralValue <= d.fullAmount) {
      throw new ValidationError('No borrowing power', `Adding ${amt} collateral adds no borrowing power (value ${q.newCollateralValue} vs debt ${d.fullAmount}).`);
    }
    if (q.feeMost >= q.addedValue) {
      throw new ValidationError('Fees exceed value', `The fees ${q.feeMost} on the added value ${q.addedValue} (raw pair asset, ${q.mostDays} days left) would take all of it.`);
    }
    await this.refusePaused(d, null, 'no top-up can pay it out');
    const bal = await this.balanceOf(d.collateralToken);
    if (bal < amt) throw new ValidationError('balance', `Balance of ${d.collateralToken} is ${bal}, below the ${amt} needed.`);
    const pair = pairAmountOf(await this.client.mains.get(d.ecosystem));
    if ((await this.ensureAllowance(d.collateralToken, hub, amt)) != null) {
      const now = (await this.preSendRead(() => this.chainTime())) + 1n;
      if (!(now + q.minDays * DAY < d.liquidationTime)) throw tooShort();
    }
    const tx = await this.send({ address: hub, abi: LoanHubAbi, functionName: 'increaseLoan', args: [id, amt], contract: 'LoanHub' });
    const ev = this.expectEvent(tx, LoanHubAbi, 'LoanIncreased', hub, 'LoanHub', ['borrowed']);
    return { ...tx, borrowed: optAmount(pair, ev?.borrowed) };
  }

  /**
   * Claim the collateral left over after a hub loan was liquidated (paid in the collateral token). A leftover still
   * unclaimed 365 days after the liquidation can be taken, and once it is, this answers "Nothing to claim".
   * Returns `claimed`.
   */
  async claimLiquidation(hubId: bigint | number): Promise<HubClaimLiquidationResult> {
    const id = toUint(hubId, 'hubId');
    const hub = this.hub;
    const d = await this.getUserLoanDetails(this.account, id);
    if (d.active) throw new ValidationError('Loan is still active', `Hub loan ${id} is still active.`);
    if (d.liquidationClaim === 0n) {
      const why = d.isLiquidated ? ' (already claimed, or taken: unclaimed for more than 365 days after the liquidation)' : ' (it was not liquidated)';
      throw new ValidationError('Nothing to claim', `Nothing to claim on hub loan ${id}${why}.`);
    }
    const { col } = await this.loanFormats(d);
    const tx = await this.send({ address: hub, abi: LoanHubAbi, functionName: 'claimLiquidation', args: [id], contract: 'LoanHub' });
    const ev = this.expectEvent(tx, LoanHubAbi, 'LiquidationClaimed', hub, 'LoanHub', ['claimed']);
    return { ...tx, claimed: optAmount(col, ev?.claimed) };
  }

  /**
   * Sell `percentage` (10-100, step 10) of a hub loan's collateral: the same share of the debt is cleared, and the rest
   * of the sale is paid out in the pair asset minus the exit fee (the wallet's own sell fee rate on the whole sale, read
   * live; a fee-whitelisted wallet pays none). `minOut` binds what the wallet receives, after that fee; omitted →
   * `quotePartialSellLoan(...).net` minus the slippage. 100% closes the loan. A paused pair cannot sell: "pair not
   * active"; nor can a sale pay out a stable its issuer paused ('pair asset paused', after "No swap for ecosystem" and
   * the minimum).
   * Returns `payout` (net of the exit fee).
   */
  async partialSellLoan(hubId: bigint | number, percentage: number | bigint, opts: HubPartialSellOptions | null = {}): Promise<HubPartialSellResult> {
    const o = optsOf(opts, HUB_PARTIAL_SELL_KEYS);
    const id = toUint(hubId, 'hubId');
    const pct = checkSellPct(percentage);
    const explicit = optUint(o.minOut, 'minOut');
    const hub = this.hub;
    const me = this.account;
    const d = await this.getUserLoanDetails(me, id);
    if (!d.active) throw new ValidationError('Loan not active', `Hub loan ${id} is not active.`);
    const [eco, live] = await Promise.all([this.getEcosystem(d.ecosystem), isPairActive(this.client, d.ecosystem)]);
    if (!live) throw pairNotActive(d.ecosystem);
    if (isZeroAddress(eco.swapContract)) throw new ValidationError('No swap for ecosystem', `Main ${d.ecosystem} has no swap set on the loan hub.`);
    const min = await this.resolveMin(explicit, o.slippageBps, async () => (await this.exitQuote(d, pct, me)).net);
    await this.refusePaused(d, eco.stable, 'no sale can pay it out');
    const pair = pairAmountOf(await this.client.mains.get(d.ecosystem));
    const tx = await this.send({
      address: hub, abi: LoanHubAbi, functionName: 'hubPartialLoanSell', args: [id, BigInt(pct), min], contract: 'LoanHub',
    });
    const ev = this.expectEvent(tx, LoanHubAbi, 'PartialLoanSold', hub, 'LoanHub', ['payout']);
    return { ...tx, payout: optAmount(pair, ev?.received) };
  }


  /** Hub loan `hubId` of `user`. Reverts "Loan does not exist" for an unknown id. */
  async getUserLoanDetails(user: Address, hubId: bigint | number): Promise<HubLoanDetails> {
    const id = toUint(hubId, 'hubId');
    const who = toAddress(user, 'user');
    try {
      const r = await this.publicClient.readContract({ address: this.hub, abi: LoanHubAbi, functionName: 'getUserLoanDetails', args: [who, id] });
      return toHubDetails(r);
    } catch (e) {
      throw decodeRevert(e, { contract: 'LoanHub', functionName: 'getUserLoanDetails', abi: LoanHubAbi });
    }
  }

  /** Number of hub loans `user` (default the signer) opened. Ids run 1..count. */
  async getUserLoanCount(user?: Address | null): Promise<bigint> {
    const who = optUser(user) ?? this.account;
    return this.publicClient.readContract({ address: this.hub, abi: LoanHubAbi, functionName: 'userLoanCount', args: [who] });
  }

  /**
   * Every hub loan of `user` (default the signer), ids 1..`getUserLoanCount`, oldest first: the hub details plus
   * `timeOfClosure` and `claimDeadline` (a liquidation leftover can be taken from then on). One multicall for the
   * details and one for the closure times of the closed loans (per 100 loans). `activeOnly`: open loans only.
   * A wallet's own loans only: vault and vesting loans belong to those contracts (`client.vault`, `client.vesting`).
   * Each row names its `hub`; the loans on a hub the mains moved away from are listed by `atHub(oldHub).getUserLoans()`.
   */
  async getUserLoans(user?: Address | null, opts: GetUserLoansOptions | null = {}): Promise<UserHubLoan[]> {
    const o = optsOf(opts, GET_USER_LOANS_KEYS);
    const activeOnly = toBool(o.activeOnly, 'activeOnly', false);
    const who = optUser(user) ?? this.account;
    const hub = this.hub;
    const count = await this.getUserLoanCount(who);
    const rows: HubLoanDetails[] = [];
    for (let start = 1n; start <= count; start += BigInt(LOANS_PAGE)) {
      const reads = [];
      for (let id = start; id <= count && id < start + BigInt(LOANS_PAGE); id++) {
        reads.push({ address: hub, abi: LoanHubAbi, functionName: 'getUserLoanDetails', args: [who, id], contract: 'LoanHub' as const });
      }
      for (const r of await multicall(this.client, reads)) rows.push(toHubDetails(r as RawHubDetails));
    }
    const kept = activeOnly ? rows.filter((r) => r.active) : rows;
    const closed = kept.filter((r) => !r.active);
    const closedAt = new Map<bigint, bigint>();
    for (let i = 0; i < closed.length; i += LOANS_PAGE) {
      const page = closed.slice(i, i + LOANS_PAGE);
      const closure = await multicall(this.client, page.map((r) => ({
        address: r.ecosystem, abi: MainTokenAbi, functionName: 'loans', args: [hub, r.coreLoanId], contract: 'MainToken' as const,
      })));
      page.forEach((r, j) => closedAt.set(r.hubId, (closure[j] as readonly unknown[])[11] as bigint));
    }
    return kept.map((r) => {
      const timeOfClosure = closedAt.get(r.hubId) ?? 0n;
      return { ...r, hub, timeOfClosure, claimDeadline: r.isLiquidated ? timeOfClosure + CLAIM_PERIOD_SECONDS : 0n };
    });
  }

  /** Where hub loan `hubId` of `user` lives: the main, the loan's id on it and the collateral token (zero ecosystem = no such loan). */
  async getLoanRef(user: Address, hubId: bigint | number): Promise<{ ecosystem: Address; coreLoanId: bigint; collateralToken: Address }> {
    const id = toUint(hubId, 'hubId');
    const who = toAddress(user, 'user');
    const [ecosystem, coreLoanId, collateralToken] = await this.publicClient.readContract({
      address: this.hub, abi: LoanHubAbi, functionName: 'userLoans', args: [who, id],
    });
    return { ecosystem, coreLoanId, collateralToken };
  }

  /** A hub loan as its main records it, incl. `timeOfClosure` which the hub details omit. */
  async getCoreLoan(user: Address, hubId: bigint | number): Promise<CoreLoan> {
    const id = toUint(hubId, 'hubId');
    user = toAddress(user, 'user');
    const ref = await this.getLoanRef(user, id);
    if (isZeroAddress(ref.ecosystem)) throw new ValidationError('Loan does not exist', `No hub loan ${id} for ${user}.`);
    return readCoreLoan(this.client, ref.ecosystem, this.hub, ref.coreLoanId, false);
  }

  /** The loan setup of `main` (all zero / false for a main never added to the loan hub). */
  async getEcosystem(main: MainRef): Promise<HubEcosystem> {
    const addr = this.client.mains.addressOf(main);
    const [stable, swapContract, active] = await this.publicClient.readContract({
      address: this.hub, abi: LoanHubAbi, functionName: 'ecosystems', args: [addr],
    });
    return { stable, swapContract, active };
  }

  /** True when `main` was added to the loan hub (its stable is set; `active` may still be off). */
  async isEcosystemRegistered(main: MainRef): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.hub, abi: LoanHubAbi, functionName: 'isEcosystemRegistered', args: [this.client.mains.addressOf(main)],
    });
  }

  /**
   * The hub id of `user`'s (default the signer) OPEN loan on `collateral` (its main derived from it), 0n when none
   * (also when the last loan there has closed).
   */
  async openLoanOf(collateral: Address, user?: Address | null): Promise<bigint> {
    collateral = toAddress(collateral, 'collateral');
    const who = optUser(user) ?? this.account;
    const info = await this.client.mains.infoOfToken(collateral);
    const id = await this.publicClient.readContract({
      address: this.hub, abi: LoanHubAbi, functionName: 'openLoanOf', args: [who, info.main, collateral],
    });
    if (id === 0n) return 0n;
    const d = await this.getUserLoanDetails(who, id);
    return d.active ? id : 0n;
  }

  /** True for the vesting contract, which may hold more than one loan per collateral. */
  private async isMultiLoan(borrower: Address): Promise<boolean> {
    return this.publicClient.readContract({ address: this.hub, abi: LoanHubAbi, functionName: 'multiLoan', args: [borrower] });
  }

  /** The wallet (or vault / vesting contract) and hub id behind loan `coreLoanId` of the loan hub on `main`. */
  async coreLoanOwner(main: MainRef, coreLoanId: bigint | number): Promise<{ user: Address; hubId: bigint }> {
    const addr = this.client.mains.addressOf(main);
    const [user, hubId] = await this.publicClient.readContract({
      address: this.hub, abi: LoanHubAbi, functionName: 'coreLoanOwner', args: [addr, toUint(coreLoanId, 'coreLoanId')],
    });
    return { user, hubId };
  }

  /** True for the vault, which may also hold more than one loan per collateral. */
  private async isLiquidationHook(borrower: Address): Promise<boolean> {
    return this.publicClient.readContract({ address: this.hub, abi: LoanHubAbi, functionName: 'liquidationHook', args: [borrower] });
  }

  /** Loan settings of `main` (default the default main). */
  async getLoanTerms(main?: MainRef | null): Promise<LoanTerms> {
    const info = main == null ? await this.client.mains.default() : await this.client.mains.get(main);
    const read = <F extends 'minDaysLoan' | 'maxDaysLoan' | 'minimumLoan' | 'staticFeePercentage' | 'dynamicFeePercentage'>(fn: F) =>
      this.publicClient.readContract({ address: info.main, abi: MainTokenAbi, functionName: fn });
    const [minDays, maxDays, minimumLoan, staticFeeBps, dynamicFeePercentage] = await Promise.all([
      read('minDaysLoan'), read('maxDaysLoan'), read('minimumLoan'), read('staticFeePercentage'), read('dynamicFeePercentage'),
    ]);
    return { main: info.main, minDays, maxDays, minimumLoan: pairAmount(minimumLoan, info), staticFeeBps, dynamicFeePercentage };
  }

  /**
   * Preview `takeLoan(collateral, amount, days)` for `user` (default the signer): collateral value (= debt), fees and the
   * payout, in the main's pair asset, plus `possible` / `refusal` from the same checks `takeLoan` runs, in its order.
   * The open-loan check needs a wallet: with no `user` and no signer it is skipped. With `possible`, `borrowed` is what
   * `takeLoan` pays in the same state.
   */
  async quoteLoan(collateral: Address, amount: bigint, numberOfDays: bigint | number, user?: Address | null): Promise<LoanQuote> {
    const amt = toUint(amount, 'amount');
    const days = toUint(numberOfDays, 'numberOfDays');
    collateral = toAddress(collateral, 'collateral');
    const { info, value, fee, minimumLoan, error } = await this.loanPlan(collateral, amt, days, optUser(user) ?? this.client.account);
    return {
      main: info.main,
      collateralValue: pairAmount(value, info),
      fee: pairAmount(fee, info),
      borrowed: pairAmount(value > fee ? value - fee : 0n, info),
      meetsMinimum: value >= minimumLoan,
      feesExceedValue: fee >= value,
      possible: error === null,
      refusal: error?.rule ?? null,
    };
  }

  /**
   * Preview `increaseLoan(hubId, amountToAdd)` for `user` (default the signer), as it would run in the next block: the
   * collateral value after the add, the value added to the debt, the fee and the payout, plus `possible` / `refusal`
   * from the same checks `increaseLoan` runs, in its order ('pair asset paused' last, read only when nothing else
   * refuses). Raw pair asset. A closed loan throws "Loan not active".
   */
  async quoteIncreaseLoan(hubId: bigint | number, amountToAdd: bigint, user?: Address | null): Promise<HubIncreaseQuote> {
    const id = toUint(hubId, 'hubId');
    const amt = toUint(amountToAdd, 'amountToAdd');
    const d = await this.getUserLoanDetails(optUser(user) ?? this.account, id);
    if (!d.active) throw new ValidationError('Loan not active', `Hub loan ${id} is not active.`);
    const q = await this.increaseQuote(d, amt);
    const rule = !q.live ? 'pair not active' : !q.timeOk ? 'Duration too short' : amt === 0n ? 'Zero amount'
      : q.addedValue === 0n ? 'No borrowing power' : q.feeMost >= q.addedValue ? 'Fees exceed value' : null;
    const refusal = rule ?? (await this.pausedRule(d));
    return {
      hubId: id, newCollateralValue: q.newCollateralValue, addedValue: q.addedValue, fee: q.fee,
      borrowed: q.addedValue > q.fee ? q.addedValue - q.fee : 0n, daysLeft: q.daysLeft,
      possible: refusal === null, refusal,
    };
  }

  /**
   * Preview `extendLoan(hubId, numberOfDays, payInPairAsset, refinance)` for `user` (default the signer): whether it
   * goes through, its fee and a refinance's payout. Both flags at once are
   * never possible (`extendLoan` refuses them): `possible: false`, `fee` and `extraOut` 0. On a paused pair
   * (`extendLoan` refuses "pair not active"), or while the issuer of the stable has paused it ('pair asset paused'),
   * `possible` is false; the figures stay.
   */
  async getExtensionQuote(
    hubId: bigint | number, numberOfDays: bigint | number, payInPairAsset: boolean, refinance: boolean, user?: Address | null,
  ): Promise<LoanExtensionQuote> {
    const days = toUint(numberOfDays, 'numberOfDays');
    const pay = toBool(payInPairAsset, 'payInPairAsset');
    const refi = toBool(refinance, 'refinance');
    const d = await this.getUserLoanDetails(optUser(user) ?? this.account, hubId);
    if (pay && refi) return { possible: false, fee: 0n, extraOut: 0n };
    const [q, live] = await Promise.all([this.extensionQuote(d, days, pay, refi), isPairActive(this.client, d.ecosystem)]);
    const possible = q.possible && live && (await this.pausedRule(d)) === null;
    return { ...q, possible };
  }

  /**
   * Preview `repayLoan(hubId, { amount })` for `user` (default the signer): the debt, the minimum loan, the largest
   * partial repay, the stable taken and the collateral released. `amount` omitted or null = in full. A closed loan gives
   * `active: false, allowed: false` (`repayLoan` would be refused "Core loan inactive").
   */
  async getRepayPreview(hubId: bigint | number, amount?: bigint | null, user?: Address | null): Promise<HubRepayPreview> {
    const d = await this.getUserLoanDetails(optUser(user) ?? this.account, hubId);
    return this.repayPreview(d, amount == null ? maxUint256 : toUint(amount, 'amount'));
  }

  /**
   * Preview `repayLoanWith(hubId, tokenIn, { amountIn })` for `user` (default the signer). Without `amountIn`: the
   * `tokenIn` that repays the whole debt (the least amount quoting it, plus `bufferBps`, default 0.5%, trimmed to the
   * route's `maxIn` / `maxOut` caps, or to what other swaps left of them in the current window on Robinhood Chain).
   * Checks the route ("no executor" / "no route"; a debt, or an explicit `amountIn`, over the caps or over what is left
   * of them now: "above cap"). A closed loan throws "Core loan inactive".
   */
  async quoteRepayLoanWith(
    hubId: bigint | number, tokenIn: Address, opts: QuoteRepayLoanWithOptions | null = {},
  ): Promise<HubRepayWithQuote> {
    const o = optsOf(opts, QUOTE_REPAY_LOAN_WITH_KEYS);
    if (o.bufferBps != null) validateSlippageBps(o.bufferBps, 'bufferBps');
    tokenIn = toAddress(tokenIn, 'tokenIn');
    const d = await this.getUserLoanDetails(optUser(o.user) ?? this.account, hubId);
    if (!d.active) throw new ValidationError('Core loan inactive', `Hub loan ${d.hubId} is not active (repaid, sold or liquidated).`);
    return this.repayWithQuote(d, tokenIn, o.amountIn, o.bufferBps);
  }

  /**
   * Preview `partialSellLoan(hubId, percentage)` for `user` (default the signer), in the same state: the gross pair
   * asset, `user`'s sell rate and the fee it takes on the whole sale, the net payout (`minOut` binds it), and the
   * collateral / debt slices. Exact for main collateral; for a factory token the payout may be a little higher than
   * quoted (dust), never lower. A closed loan throws "Loan not active"; a paused pair throws "pair not active", as
   * `partialSellLoan` does.
   */
  async quotePartialSellLoan(hubId: bigint | number, percentage: number | bigint, user?: Address | null): Promise<HubPartialSellQuote> {
    const id = toUint(hubId, 'hubId');
    const pctN = checkSellPct(percentage);
    const who = optUser(user) ?? this.account;
    const d = await this.getUserLoanDetails(who, id);
    if (!d.active) throw new ValidationError('Loan not active', `Hub loan ${id} is not active.`);
    if (!(await isPairActive(this.client, d.ecosystem))) throw pairNotActive(d.ecosystem);
    const exit = await this.exitQuote(d, pctN, who);
    const pct = BigInt(pctN);
    return { ...exit, collateralSold: (d.collateralAmount * pct) / 100n, debtRepaid: (d.fullAmount * pct) / 100n };
  }


  /**
   * What `takeLoan(collateral, amt, days)` by `user` would do now: the collateral value (= the debt) and the fees (raw
   * pair asset), and the first rule it would be refused with, in `takeLoan`'s order (null when it goes through): "cannot
   * be zero", "pair not active" (the main's pair is paused), "Ecosystem inactive", "Unauthorized caller" (the main's
   * loans run on another hub), "Open loan: increase it" (skipped without a `user`, and
   * for the vault and vesting contracts, which may hold several loans), "incorrect loan duration", "Minimum loan amount
   * not met", 'pair asset paused' (its issuer paused the pair asset the loan pays out; read only when nothing before it
   * refuses), "No stable received" (the fees take the whole value).
   */
  private async loanPlan(
    collateral: Address, amt: bigint, days: bigint, user: Address | undefined,
  ): Promise<{ info: MainInfo; value: bigint; fee: bigint; minimumLoan: bigint; error: ValidationError | null }> {
    const hub = this.hub;
    const info = await this.client.mains.infoOfToken(collateral);
    const [live, eco, loanHub, terms, open, value] = await Promise.all([
      isPairActive(this.client, info.main),
      this.getEcosystem(info.main),
      this.publicClient.readContract({ address: info.main, abi: MainTokenAbi, functionName: 'LOAN' }),
      this.getLoanTerms(info.main),
      user === undefined ? 0n : this.openLoanOf(collateral, user),
      amt === 0n ? 0n : this.collateralValue(info.main, collateral, amt),
    ]);
    const inRange = days >= terms.minDays && days <= terms.maxDays;
    const fee = await this.loanFee(info.main, value, days, terms.staticFeeBps).catch((e: unknown) => {
      if (inRange) throw e;
      return 0n;
    });
    const minimumLoan = terms.minimumLoan.raw;
    const plan = (error: ValidationError | null) => ({ info, value, fee, minimumLoan, error });
    if (amt === 0n) return plan(new ValidationError('cannot be zero', 'Collateral amount must be greater than 0.'));
    if (!live) return plan(pairNotActive(info.main, info.symbol));
    if (!eco.active) return plan(new ValidationError('Ecosystem inactive', `Main ${info.main} is not active on the loan hub.`));
    if (!eq(loanHub, hub)) {
      return plan(new ValidationError('Unauthorized caller', `Main ${info.main} takes new loans from hub ${loanHub}, not ${hub}.`));
    }
    if (open !== 0n && user !== undefined) {
      const [hook, multi] = await Promise.all([this.isLiquidationHook(user), this.isMultiLoan(user)]);
      if (!hook && !multi) {
        return plan(new ValidationError('Open loan: increase it',
          `${user} already has open hub loan ${open} on ${collateral}: add to it with increaseLoan(${open}, amount) instead of a second loan.`));
      }
    }
    if (!inRange) {
      return plan(new ValidationError('incorrect loan duration', `Days must be ${terms.minDays}-${terms.maxDays} on this main, got ${days}.`));
    }
    if (value < minimumLoan) {
      return plan(new ValidationError('Minimum loan amount not met',
        `Collateral value ${pairAmount(value, info).formatted} ${info.pairSymbol} is below the minimum loan ${terms.minimumLoan.formatted}.`));
    }
    if (await isAssetPaused(this.client, info.pairAsset)) return plan(pairAssetPaused(info.pairAsset, info.pairSymbol, 'no loan can pay it out'));
    if (fee >= value) {
      return plan(new ValidationError('No stable received',
        `The loan fees ${fee} would take the whole collateral value ${value} (raw ${info.pairSymbol}); borrow for fewer days.`));
    }
    return plan(null);
  }

  /**
   * 'pair asset paused' for a write on hub loan `d`: the issuer of its main's pair asset (`asset`, the loan's stable for
   * the main; null = the main's pair asset) has paused it, so `effect`. Before any approval. The main is looked up for
   * its symbol only after a paused answer (and for the asset when none is given). PY: `_refuse_paused`.
   */
  private async refusePaused(d: HubLoanDetails, asset: Address | null, effect: string): Promise<void> {
    const a = asset ?? (await this.client.mains.get(d.ecosystem)).pairAsset;
    if (await isAssetPaused(this.client, a)) throw pairAssetPaused(a, (await this.client.mains.get(d.ecosystem)).pairSymbol, effect);
  }

  /** 'pair asset paused' when the issuer of hub loan `d`'s pair asset has paused it, else null (a quote's refusal). */
  private async pausedRule(d: HubLoanDetails): Promise<'pair asset paused' | null> {
    const info = await this.client.mains.get(d.ecosystem);
    return (await isAssetPaused(this.client, info.pairAsset)) ? 'pair asset paused' : null;
  }

  /** What a partial sell of hub loan `d` pays `borrower`, at the borrower's own sell fee rate. */
  private exitQuote(d: HubLoanDetails, percentage: number, borrower: Address): Promise<PartialSellExit> {
    return quotePartialSell(this.client, d.ecosystem, { token: d.collateralToken, fullAmount: d.fullAmount }, this.hub, d.coreLoanId, percentage, false, borrower);
  }

  private async repayPreview(d: HubLoanDetails, amount: bigint): Promise<HubRepayPreview> {
    const minimumLoan = await this.publicClient.readContract({ address: d.ecosystem, abi: MainTokenAbi, functionName: 'minimumLoan' });
    const debt = d.fullAmount;
    const full = amount >= debt;
    const pay = full ? debt : amount;
    const released = full ? d.collateralAmount : debt === 0n ? 0n : (d.collateralAmount * pay) / debt;
    return {
      hubId: d.hubId, active: d.active, debt, minimumLoan,
      maxPartial: debt > minimumLoan ? debt - minimumLoan : 0n,
      amount: pay, full,
      allowed: d.active && pay > 0n && (full || debt - pay >= minimumLoan),
      collateralReleased: released, collateralLeft: d.collateralAmount - released, debtLeft: debt - pay,
    };
  }

  /** The loan's stable and how `tokenIn` converts to it: itself, or `quoteHop` on the route executor (route checked). */
  private async repayRoute(d: HubLoanDetails, tokenIn: Address): Promise<RepayRoute> {
    const { stable, swapContract } = await this.getEcosystem(d.ecosystem);
    if (isZeroAddress(swapContract)) throw new ValidationError('No swap for ecosystem', `Main ${d.ecosystem} has no swap set on the loan hub.`);
    if (eq(tokenIn, stable)) return { stable, direct: true, exec: zeroAddress, quote: async (x) => x };
    const exec = await this.publicClient.readContract({ address: swapContract, abi: SwapAbi, functionName: 'hopExecutor' });
    if (isZeroAddress(exec)) throw new ValidationError('no executor', `The swap ${swapContract} has no outside-route executor: repay in ${stable}.`);
    const hops = await this.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'getRoute', args: [tokenIn, stable] });
    if (hops.length === 0) throw new ValidationError('no route', `No outside route from ${tokenIn} to ${stable}: repay in ${stable} or another token.`);
    return { stable, direct: false, exec, quote: (x) => this.quoteHop(exec, tokenIn, stable, x) };
  }

  private async repayWithQuote(
    d: HubLoanDetails, tokenIn: Address, amountIn: bigint | null | undefined, bufferBps?: number | null,
    route?: RepayRoute,
  ): Promise<HubRepayWithQuote> {
    const { stable, direct, exec, quote } = route ?? await this.repayRoute(d, tokenIn);
    const debt = d.fullAmount;
    let x: bigint;
    let stableOut: bigint;
    if (amountIn != null) {
      x = toUint(amountIn, 'amountIn');
      if (x === 0n) throw new ValidationError('Zero amount', 'amountIn must be greater than 0.');
      stableOut = direct ? x : await quoteHopWithinCaps(this.client, exec, tokenIn, stable, x, quote);
    } else {
      x = direct ? debt : await this.sizeFor(exec, tokenIn, stable, debt, quote, bufferBps ?? REPAY_WITH_BUFFER_BPS);
      stableOut = await quote(x);
    }
    const covers = stableOut >= debt;
    const released = covers ? d.collateralAmount : debt === 0n ? 0n : (d.collateralAmount * stableOut) / debt;
    return {
      hubId: d.hubId, tokenIn, stable, debt, amountIn: x, stableOut, covers,
      refund: covers ? stableOut - debt : 0n, collateralReleased: released,
    };
  }

  /**
   * `tokenIn` to send for `target` of `stable`: the least amount quoting it, plus `bufferBps`, within what the route takes
   * now (on Robinhood Chain, what other swaps left of its caps in the current window).
   */
  private async sizeFor(exec: Address, tokenIn: Address, stable: Address, target: bigint, quote: (x: bigint) => Promise<bigint>, bufferBps: number): Promise<bigint> {
    return sizeRepayWith(quote, target, { ...(await readRepaySizing(this.client, exec, tokenIn, stable)), bufferBps });
  }

  /** `quoteHop` on the route executor (an eth_call; net of the route fee). */
  private async quoteHop(exec: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    try {
      const { result } = await this.publicClient.simulateContract({
        address: exec, abi: HopExecutorAbi, functionName: 'quoteHop', args: [tokenIn, tokenOut, amountIn], account: this.client.account,
      });
      return result;
    } catch (e) {
      throw decodeRevert(e, { contract: 'HopExecutor', functionName: 'quoteHop', abi: HopExecutorAbi });
    }
  }


  private async extensionQuote(d: HubLoanDetails, days: bigint, payInPairAsset: boolean, refinance: boolean): Promise<LoanExtensionQuote> {
    const [possible, fee, extraOut] = await this.publicClient.readContract({
      address: d.ecosystem, abi: MainTokenAbi, functionName: 'extensionEligibility',
      args: [this.hub, d.coreLoanId, days, false, payInPairAsset, refinance],
    });
    return { possible, fee, extraOut };
  }

  /** The collateral value of `amount` of `token` on `main`, raw pair asset (reverts "wrong pair" / "Only ecosystem tokens" decoded). */
  private async collateralValue(main: Address, token: Address, amount: bigint): Promise<bigint> {
    try {
      return await this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'getColleteralValue', args: [amount, token] });
    } catch (e) {
      throw decodeRevert(e, { contract: 'MainToken', functionName: 'getColleteralValue', abi: MainTokenAbi });
    }
  }

  private async chainTime(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }

  /**
   * The `repayLoanWith` deadline to send (unix seconds, chain time): `explicit`, refused ("Deadline") when it is before
   * the latest block time (`checkDeadline`), else the latest block time + 600 s.
   */
  private async sendDeadline(explicit: bigint | null | undefined): Promise<bigint> {
    const now = (await this.preSendRead(() => this.publicClient.getBlock())).timestamp;
    return explicit == null ? now + BigInt(REPAY_WITH_DEADLINE) : checkDeadline(explicit, now);
  }

  /** The fee of a new loan on `value` (raw pair asset) for `days`. */
  private async loanFee(main: Address, value: bigint, days: bigint, staticFeeBps: bigint): Promise<bigint> {
    const dynamic = await this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'getDynamicFee', args: [value, days] });
    return (value * staticFeeBps) / 10_000n + dynamic;
  }

  /**
   * The `increaseLoan` figures for the next block (latest + 1 s: the tx mines later): `live` = the pair is not paused,
   * `timeOk` = more than the minimum days left, the collateral value after the add, the value added to the debt (0
   * without borrowing power) and its fee for the whole days left (`daysLeft`, from the next block). `feeMost` /
   * `mostDays`: the fee on the days left at the latest block, which "Fees exceed value" is checked on (the tx can mine
   * in a block with the same time, which can leave one more whole day).
   */
  private async increaseQuote(d: HubLoanDetails, amt: bigint) {
    const pc = this.publicClient;
    const [live, minDays, staticFee, latest, newCollateralValue] = await Promise.all([
      isPairActive(this.client, d.ecosystem),
      pc.readContract({ address: d.ecosystem, abi: MainTokenAbi, functionName: 'minDaysLoan' }),
      pc.readContract({ address: d.ecosystem, abi: MainTokenAbi, functionName: 'staticFeePercentage' }),
      this.chainTime(),
      this.collateralValue(d.ecosystem, d.collateralToken, d.collateralAmount + amt),
    ]);
    const now = latest + 1n;
    const daysAt = (t: bigint) => (d.liquidationTime > t ? (d.liquidationTime - t) / DAY : 0n);
    const timeOk = now + minDays * DAY < d.liquidationTime;
    const daysLeft = daysAt(now);
    const mostDays = daysAt(latest);
    const addedValue = newCollateralValue > d.fullAmount ? newCollateralValue - d.fullAmount : 0n;
    const dynamicFor = async (days: bigint) => (addedValue === 0n ? 0n
      : pc.readContract({ address: d.ecosystem, abi: MainTokenAbi, functionName: 'getDynamicFee', args: [addedValue, days] }));
    const staticPart = (addedValue * staticFee) / 10_000n;
    const fee = staticPart + await dynamicFor(daysLeft);
    const feeMost = mostDays === daysLeft ? fee : staticPart + await dynamicFor(mostDays);
    return { live, minDays, timeOk, daysLeft, mostDays, newCollateralValue, addedValue, fee, feeMost };
  }

  /**
   * What a repay of loan `d` did, from the transaction's events: a partial repay's amount and collateral released, else
   * a full repay's stable repaid and the collateral sent back to the wallet (from the ERC-20 transfers). Neither: all
   * null and a warning.
   */
  /** Formatters of a hub loan's figures (its main's pair asset, its collateral token), resolved before a write sends. */
  private async loanFormats(d: HubLoanDetails): Promise<{ pair: AmountOf; col: AmountOf }> {
    const info = await this.client.mains.get(d.ecosystem);
    return { pair: pairAmountOf(info), col: await amountOf(this.client, d.collateralToken, info) };
  }

  private repaidFigures(
    tx: TxResult, d: HubLoanDetails, stable: Address, f: { pair: AmountOf; col: AmountOf },
  ): Pick<HubRepayResult, 'closed' | 'repaid' | 'collateralReleased'> {
    const hub = this.hub;
    const part = this.events(tx, LoanHubAbi, 'LoanPartlyRepaid', hub).find((e) => e.hubId === d.hubId);
    if (part) return { closed: false, repaid: f.pair(part.amount), collateralReleased: f.col(part.collateralReleased) };
    const full = this.events(tx, LoanHubAbi, 'LoanRepaid', hub).find((e) => e.hubId === d.hubId);
    if (!full) {
      addMissingEventWarning(tx, 'LoanHub', 'LoanRepaid', ['closed', 'repaid', 'collateralReleased']);
      return { closed: null, repaid: null, collateralReleased: null };
    }
    return {
      closed: true,
      repaid: f.pair(this.transferred(tx, stable, hub, d.ecosystem)),
      collateralReleased: f.col(this.transferred(tx, d.collateralToken, hub, this.account)),
    };
  }

  /** Sum of the `token` transfers `from` → `to` in `tx` (ERC-20 `Transfer` logs emitted by `token`). */
  private transferred(tx: TxResult, token: Address, from: Address, to: Address): bigint {
    return this.events(tx, ERC20Abi, 'Transfer', token)
      .filter((e) => eq(e.from, from) && eq(e.to, to))
      .reduce((s, e) => s + e.value, 0n);
  }
}

type RawHubDetails = ContractFunctionReturnType<typeof LoanHubAbi, 'view', 'getUserLoanDetails'>;

function toHubDetails(r: RawHubDetails): HubLoanDetails {
  return {
    hubId: r.hubId, ecosystem: r.ecosystem, coreLoanId: r.coreLoanId, collateralToken: r.collateralToken, token: r.token,
    collateralAmount: r.collateralAmount, liquidatedAmount: r.liquidatedAmount, fullAmount: r.fullAmount,
    borrowedAmount: r.borrowedAmount, liquidationTime: r.liquidationTime, liquidationClaim: r.liquidationClaim,
    isLiquidated: r.isLiquidated, active: r.active, creationTime: r.creationTime,
  };
}
