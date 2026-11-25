import { type Abi, type Address, type ContractEventName, getAddress, maxUint256, zeroAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import {
  EcosystemTokenAbi, FactoryTokenAbi, HopExecutorAbi, MainTokenAbi, SwapAbi, TaxesAbi, VaultAbi, VestingAbi,
} from '../abis';
import { isZeroAddress, ZERO_ADDRESS } from '../config/addresses';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { addMissingEventWarning, type EventArgs } from '../core/events';
import { checkCrossHop, checkCrossPlan, crossSides } from '../core/crossHop';
import {
  type CoreLoan, type PartialSellExit, checkDeadline, checkExplicitMin, coreExtendRefusal, grossOfHop, isAssetPaused,
  pairAssetPaused, quoteHopWithinCaps, quotePartialSell, readCoreLoan, readRepaySizing, refusePausedAsset, sizeRepayWith,
} from '../core/loans';
import { type AmountOf, amountOf, optAmount, pairAmountOf } from '../core/amounts';
import { type MainInfo, type MainRef, mainAmount } from '../core/mains';
import { optionKeys, optsOf } from '../core/opts';
import { decodeRevert } from '../core/revert';
import { errorText } from '../core/redact';
import {
  type Amount, BPS, maxWithSlippage, minWithSlippage, optUint, toAddress, toAmount, toBool, toUint, validateSlippageBps,
} from '../core/units';
import type { WhitelistStatus } from './Factory';
import type { HopCaps, HopCapsLeft } from './HopExecutor';
import type { LeverageEndResult } from './LeverageSimulator';

export interface TradeOptions {
  /**
   * Explicit minimum output (raw units of the path's last token). Omit (or null) to derive it from a tax-inclusive quote.
   * Never 0. On a buy, sell or swap the quote is read either way, and a minimum above it is refused ("Min out") before
   * any approval; `partialSellLeverage` sends an explicit minimum as given, 0 included (see there).
   */
  minOut?: bigint | null;
  /** Slippage for the derived minimum, bps (default `client.slippageBps.trade`, 1%). */
  slippageBps?: number | null;
}
const TRADE_KEYS = optionKeys<TradeOptions>({ minOut: true, slippageBps: true });

export interface BuyOptions extends TradeOptions {
  /** What to pay with for a factory token: its main's pair asset (default) or the main itself. A main is always bought with its pair asset. */
  input?: 'pairAsset' | 'main';
}
const BUY_KEYS = optionKeys<BuyOptions>({ minOut: true, slippageBps: true, input: true });

export interface SellOptions extends TradeOptions {
  /** Factory token only: sell through to the main's pair asset (3-hop) instead of stopping at the main (default false). */
  toPairAsset?: boolean | null;
}
const SELL_KEYS = optionKeys<SellOptions>({ minOut: true, slippageBps: true, toPairAsset: true });

/** Options of `quoteSwap`. */
export interface QuoteSwapOptions {
  /** Whose tax rate, balance and whitelist entry the quote uses (default the signer, else the zero address). */
  trader?: Address | null;
  /** Slippage for the quote's minimum, bps (default `client.slippageBps.trade`, 1%). */
  slippageBps?: number | null;
}
const QUOTE_SWAP_KEYS = optionKeys<QuoteSwapOptions>({ trader: true, slippageBps: true });

/** Options of `repayLeverage`. */
export interface RepayLeverageOptions {
  /** Raw pair asset to repay; omitted or null: in full. */
  amount?: bigint | null;
}
const REPAY_LEVERAGE_KEYS = optionKeys<RepayLeverageOptions>({ amount: true });

/** Options of `quoteRepayLeverageWith`. */
export interface QuoteRepayLeverageWithOptions {
  /** `tokenIn` to quote (raw); omitted or null: the amount that repays the whole debt. */
  amountIn?: bigint | null;
  /** Headroom on a repay-all sizing, bps (default 50 = 0.5%). */
  bufferBps?: number | null;
  /** Whose position (default the signer). */
  user?: Address | null;
}
const QUOTE_REPAY_LEVERAGE_WITH_KEYS = optionKeys<QuoteRepayLeverageWithOptions>({ amountIn: true, bufferBps: true, user: true });

export interface SwapCrossOptions extends TradeOptions {
  /** Receiver of the output (default: the signer; never the zero address: "no recipient"). */
  recipient?: Address | null;
  /**
   * Unix seconds, not before the latest block time ("Deadline" otherwise; default: latest block time + 600 s). A
   * deadline equal to the latest block time can still be met, but only just: give some room.
   */
  deadline?: bigint | null;
  /** Pay out native ETH; the path must end in the hop executor's WETH. */
  unwrapNative?: boolean | null;
  /** Pay in native ETH (`msg.value = amountIn`); path[0] must be the hop executor's WETH. */
  native?: boolean | null;
}
const SWAP_CROSS_KEYS = optionKeys<SwapCrossOptions>({
  minOut: true, slippageBps: true, recipient: true, deadline: true, unwrapNative: true, native: true,
});

export interface LeverageOptions {
  /**
   * Explicit minimum tokens this buy puts in the position (raw units of the bought token). Omit (or null) to derive it
   * from `quoteLeverage`. Never 0; above the quote's `sim.totalCollateral` it is refused ("Min out") before the approval.
   */
  minOut?: bigint | null;
  slippageBps?: number | null;
}
const LEVERAGE_KEYS = optionKeys<LeverageOptions>({ minOut: true, slippageBps: true });

/**
 * `quoteLeverage`: what a leverage buy (`leveragePct` 100) or mixed buy (1-99) does right now. One position per token:
 * with one open, the buy ADDS to it, keeps its end date and is priced on the days left.
 */
export interface LeverageQuote {
  /** `[pairAsset, main(, token)]`. */
  path: Address[];
  /** 100 = `leverageBuy`; 1-99 = `mixedBuy` (lower keeps more of the position debt-free). */
  leveragePct: number;
  /** Days the buy is priced on: the asked days for a new position, the days left on the open one for an add. */
  days: bigint;
  /** The open position on this token the buy adds to (0n = it opens a new one). */
  openLoanId: bigint;
  /**
   * The wallet the quote is priced for: `user`, else the signer. The zero address means neither was given, and the quote
   * is then at the list rate (no wallet discounts): the most any wallet pays, so a real open gets at least this
   * collateral at the same prices. Only a quote for the opening wallet matches its open to the wei.
   */
  trader: Address;
  /** `trader`'s buy fee rate for the bought token, bps, read live: what the buys pay. */
  taxBps: number;
  /** The exact figures the open gets for `trader`; `sim.totalCollateral` = tokens the position gains. */
  sim: LeverageEndResult;
  /** What `amount` buys at spot, before fees (`getAmountsOut`). A position under 2x leverage is refused ("Under 2x"). */
  spot: bigint;
  /**
   * Why `leverageBuy` / `mixedBuy` would refuse this buy for `trader` now, in order, under the rule names those writes
   * refuse it with (empty: nothing in the way): 'In presale' (an auto-vest token whose presale is not
   * complete), 'No WL for freeze' (a frozen token, and `trader` is not on its whitelist; the zero address never is) or
   * 'WL cap' (the position's collateral over what is left of `trader`'s presale cap), 'Under 2x', 'Trading is not
   * enabled' (the main is not live yet), 'pair asset paused' (its issuer paused the main's pair asset: the buy cannot be
   * paid in). The wallet's balance is not checked; the days range and "Extend first" still throw, as before.
   */
  blocked: LeverageBlock[];
}

/** A rule `leverageBuy` / `mixedBuy` refuse a buy with (`LeverageQuote.blocked`). */
export type LeverageBlock = 'In presale' | 'No WL for freeze' | 'WL cap' | 'Under 2x' | 'Trading is not enabled' | 'pair asset paused';

/** What a trade cannot do while the issuer of a pair asset it moves has paused it (`pairAssetPaused`). */
const TRADE_PAUSED = 'no trade that moves it (paid in, paid out or as the fee) can go through';

/**
 * What a sale of the factory token `token` cannot do while its main's pair asset is paused and the signer has holder
 * rewards on it to claim (`pairAssetPaused`): every sale pays them out in that asset, whatever the fee.
 */
const rewardsPaused = (token: Address) => `no sale of ${token} can go through: every sale pays out your pending holder rewards on it in this asset`;

/**
 * How a trade on one main moves that main's pair asset when the asset is not on its path (`refusePausedTrade`): `fees`,
 * each side's fee rate for the signer (a fee moves the pair asset), and `sold`, the factory token the trade sells (its
 * sale pays the signer's pending holder rewards in the pair asset, fee or not), or null.
 */
interface PausedMoves {
  fees: (() => Promise<number>)[];
  sold: Address | null;
}

/** How `repayLeverageWith` converts its token to the pair asset (`repayWithRoute`): itself, or `quoteHop` on the route executor. */
interface LeverageRepayRoute {
  direct: boolean;
  exec: Address | null;
  quote: (x: bigint) => Promise<bigint>;
}

/** `getOpenLeverage`: the user's one open leverage position on a token. */
export interface OpenLeverage {
  loanId: bigint;
  position: CoreLoan;
  /**
   * Whole days left until `liquidationTime`, counted from the next block (latest block time + 1 s): what an add sent now
   * is priced on ("Extend first" below the main's minimum loan days). A later block can only mean fewer days (lower
   * fees, more collateral).
   */
  daysLeft: bigint;
}

/**
 * `quotePartialSellLeverage`: what `partialSellLeverage` pays. Raw pair asset except `collateralSold` (collateral units).
 * `gross` is what the sale produces, `taxable` the profit in it, `taxBps` the wallet's own sell fee rate, `fee` that rate
 * on `taxable` (0 at a loss), and `net` what the wallet gets (`minOut` binds it).
 */
export interface LeveragePartialSellQuote extends PartialSellExit {
  collateralSold: bigint;
  debtRepaid: bigint;
}

/** `getLeverageRepayPreview`: what `repayLeverage(main, loanId, { amount })` does. Raw: debts in the pair asset, collateral in its token's units. */
export interface LeverageRepayPreview {
  loanId: bigint;
  /** The debt now (`fullAmount`). */
  debt: bigint;
  /** The main's `minimumLoan`: a partial repay must leave at least this much debt. */
  minimumLoan: bigint;
  /** The largest partial repay (`debt - minimumLoan`, 0 when the debt is at or under the minimum: repay in full). */
  maxPartial: bigint;
  /** The pair asset this repay takes: `min(amount, debt)`. */
  amount: bigint;
  /** `amount >= debt`: the position closes and all collateral comes back. */
  full: boolean;
  /** The position is open (`active`): a closed, sold-out or liquidated one cannot be repaid ("Loan not active"). */
  active: boolean;
  /** The repay goes through: an active position, and a full repay or a partial one leaving at least `minimumLoan` ("Repay in full" otherwise). */
  allowed: boolean;
  /** Collateral sent back: all of it on a full repay, else the repaid share of it (rounded down). */
  collateralReleased: bigint;
  collateralLeft: bigint;
  debtLeft: bigint;
}

/** `quoteRepayLeverageWith`: `tokenIn` converted to the main's pair asset through the hop executor. Raw units. */
export interface LeverageRepayWithQuote {
  loanId: bigint;
  tokenIn: Address;
  /** The main's pair asset (what the debt is owed in). */
  pairAsset: Address;
  debt: bigint;
  /** `tokenIn` to send. Sized for the whole debt plus `bufferBps` (within the route's caps) when the caller gave none. */
  amountIn: bigint;
  /** Pair asset it converts to now (`quoteHop`, net of the hop fee; `amountIn` itself when `tokenIn` is the pair asset). */
  pairOut: bigint;
  /** `pairOut >= debt`: it repays everything (send with `close`). */
  covers: boolean;
  /** Pair asset refunded after a full repay (`pairOut - debt`), else 0. */
  refund: bigint;
  /** Collateral that comes back (all on a full repay, else its share). */
  collateralReleased: bigint;
}

export interface RepayLeverageWithOptions {
  /** `tokenIn` to send (raw). Omitted (or null): sized to repay the whole debt (quote + `bufferBps`) and `close` defaults to true. */
  amountIn?: bigint | null;
  /**
   * Explicit minimum pair asset out of the conversion (raw, never 0; above the quote's `pairOut`: "Min out"). Omitted:
   * the quote minus `slippageBps`, and at least the debt with `close`.
   */
  minPairOut?: bigint | null;
  /** Refuse ("Not enough to close") unless the conversion covers the whole debt. Default: true when `amountIn` is omitted, else false. */
  close?: boolean | null;
  /** Slippage for the derived minimum, bps (default `client.slippageBps.trade`, 1%). */
  slippageBps?: number | null;
  /** Headroom on a repay-all sizing, bps (default 50 = 0.5%); the unused pair asset is refunded. */
  bufferBps?: number | null;
  /** Unix seconds, not before the latest block time ("Deadline" otherwise; default: latest block time + 600 s). */
  deadline?: bigint | null;
}
const REPAY_LEVERAGE_WITH_KEYS = optionKeys<RepayLeverageWithOptions>({
  amountIn: true, minPairOut: true, close: true, slippageBps: true, bufferBps: true, deadline: true,
});

/**
 * Write results carry the figures decoded from the tx's own events (only logs of the expected contract count), every
 * money figure as an `Amount` in its token (decimals, unit, symbol resolved before sending). A figure is null when its
 * event is missing from a confirmed tx; `warnings` then says so. Never resend a confirmed tx.
 */

/** Where a presale buy of an auto-vest token went: a vesting with the signer as beneficiary. */
export interface AutoVested {
  vestingId: bigint;
  /** Tokens in the vesting (the bought token). */
  amount: Amount;
  /** Gradual release until `endsAt`, else a cliff: everything unlocks at `endsAt`. */
  gradual: boolean;
  /** Unix seconds: buy time + the token's `autoVestDuration` days (null if the block could not be read; see `warnings`). Claim with `client.vesting`. */
  endsAt: bigint | null;
}

/** What `buyTokens` / `sellTokens` / `buy` / `sell` / `sellPercentage` did (trader = the signer). */
export interface TradeResult extends TxResult {
  /** What was paid in (`path[0]`). */
  amountIn: Amount | null;
  /** What the trade produced (last token): a buy's tokens (also when they went to the vault or a vesting), a sell's proceeds after the tax. */
  amountOut: Amount | null;
  /** The tax in its own unit: a buy's in `path[0]`, a sell's in the last token. */
  tax: Amount | null;
  /** A presale buy of an auto-vest token lands in a vesting, not the wallet (null otherwise, and on sells). */
  autoVested: AutoVested | null;
  /**
   * A sell of a factory token first pays the signer's pending holder rewards, in its main's pair asset, in the same tx:
   * on top of `amountOut`, and in another token when the sell stops at the main. 0 when none were owed or the token has
   * rewards off. Null on buys and when a main is sold.
   */
  rewardsClaimed: Amount | null;
}

/** `buyAndStake`: the trade plus the amount staked in the vault (the main, = `amountOut`). */
export interface BuyAndStakeResult extends TradeResult {
  staked: Amount | null;
}

/** What `swapCross` did (trader = the signer). `result` is the simulated output before sending; `amountOut` is what was delivered. */
export interface SwapCrossResult extends TxResult {
  /** What arrived at the swap (`path[0]`; a fee-on-transfer token delivers less than sent). */
  amountIn: Amount | null;
  /** What `recipient` received (last token). */
  amountOut: Amount | null;
  recipient: Address | null;
  /**
   * Each side's tax in the unit held at that step (the sell side's last token: its main or pair asset; the buy side's
   * first token); 0 without that side (then in `path[0]` for the sell side, the last token for the buy side).
   */
  sellFee: Amount | null;
  buyFee: Amount | null;
  /** What the sell side produced after its fee, and what entered the buy side before its fee (same units; 0 without that side). */
  sellOut: Amount | null;
  buyIn: Amount | null;
  /**
   * A route that sells a factory token (`path[0]`) first pays the signer's pending holder rewards, in that token's pair
   * asset, to the signer (not `recipient`), in the same tx; 0 when none were owed. Null when `path[0]` is not a factory
   * token.
   */
  rewardsClaimed: Amount | null;
}

/** What `leverageBuy` / `mixedBuy` did: a new position, or an add to the open one. */
export interface LeverageBuyResult extends TxResult {
  /** The position id (new, or the open one the buy added to). */
  loanId: bigint | null;
  /** True when the buy added to the open position on the token. */
  added: boolean | null;
  /** Tokens put in the position (the collateral token: the path's last token). */
  collateralAdded: Amount | null;
  /** Pair asset borrowed and debt added by this buy. */
  borrowedAdded: Amount | null;
  debtAdded: Amount | null;
  /** The pair asset the signer paid in (`amount`). */
  initialBuy: Amount | null;
  /** End date of a new position (unix seconds); null on an add (the end date does not change). */
  liquidationTime: bigint | null;
}

/** What `partialSellLeverage` did. Pair asset, collateral in its token. */
export interface PartialSellLeverageResult extends TxResult {
  /** Pair asset the sale produced. */
  gross: Amount | null;
  /** The exit fee, at the signer's own sell fee rate on the profit only; 0 at a loss. */
  fee: Amount | null;
  /** Paid to the signer: `gross - fee` (`minOut` applies to it). */
  payout: Amount | null;
  debtLeft: Amount | null;
  collateralLeft: Amount | null;
  /** The position closed (nothing left). */
  closed: boolean | null;
  /**
   * The sale of a factory-token position first pays the signer's pending holder rewards, in the pair asset, on top of
   * `payout`; 0 when none were owed. Null for a position on the main itself.
   */
  rewardsClaimed: Amount | null;
}

/** What `extendLeverage` did. Amounts in the pair asset. */
export interface ExtendLeverageResult extends TxResult {
  newLiquidationTime: bigint | null;
  newFullAmount: Amount | null;
  newBorrowedAmount: Amount | null;
  /** Pair asset a refinance paid out; 0 otherwise. */
  extraOut: Amount | null;
}

/** How a repay ended (partial or full). */
export interface RepayOutcome {
  /** The position closed (all collateral back). */
  closed: boolean | null;
  /** Debt left (pair asset; 0 when closed). */
  debtLeft: Amount | null;
  /** Collateral sent back (collateral token). */
  collateralReleased: Amount | null;
}

/** `repayLeverage`: the pair asset taken and the outcome. */
export interface RepayLeverageResult extends TxResult, RepayOutcome {
  /** Pair asset that went to the debt (as `loans.repayLoan`'s `repaid`). */
  repaid: Amount | null;
}

export interface RepayLeverageWithResult extends TxResult, RepayOutcome {
  /**
   * `tokenIn` taken, the pair asset it converted to, and the part of that refunded. The whole `pairOut` goes to the debt:
   * a hop paying more than quoted repays more (`debtLeft` lower, more collateral back) and refunds only what is above
   * the debt.
   */
  amountIn: Amount | null;
  pairOut: Amount | null;
  refund: Amount | null;
}

/** `claimLeverageLiquidation`: tokens claimed, in the collateral token. */
export interface ClaimLeverageLiquidationResult extends TxResult {
  claimed: Amount | null;
}

/** Headroom of a repay-all `repayLeverageWith` sizing, bps (the surplus is refunded). */
export const REPAY_LEVERAGE_WITH_BUFFER_BPS = 50;

/** Extension preview (`getLeverageExtensionQuote`): fee in raw pair asset; `extraOut` = pair asset paid out by a refinance. */
export interface LeverageExtensionQuote {
  possible: boolean;
  fee: bigint;
  extraOut: bigint;
}

/** `buildCrossPath`: the `swapCross` route between two tokens. */
export interface CrossRoute {
  /** Sell steps out of the input, at most one outside hop between two assets, then buy steps into the output. */
  path: Address[];
  /** The route has an outside hop: a swap through an outside exchange, which pays the hop fee and has caps (`hopExecutor.checkCaps`). */
  usesOutside: boolean;
  /** The outside hop `[from, to]` (through the hop executor), or null. */
  outsideHop: [Address, Address] | null;
}

/** `buy` / `sell`: one side on one main; `cross`: a sell side then a buy side; `hop`: any route with an outside hop. */
export type SwapKind = 'buy' | 'sell' | 'cross' | 'hop';
/** The method that sends the route (`buy` → `buyTokens`, `sell` → `sellTokens`, else `swapCross`). */
export type SwapEngine = 'buyTokens' | 'sellTokens' | 'swapCross';

/** One side's tax in a `quoteSwap`. */
export interface SwapTax {
  side: 'sell' | 'buy';
  /** The token the rate is keyed on: the input for the sell side, the output for the buy side. */
  token: Address;
  /** The side's fee rate for the trader, bps, read live. */
  taxBps: number;
  /** Raw units of `asset` (0 while the quote is blocked before this side). */
  amount: bigint;
  /** What the tax is taken in: the sell side's last token (its main or pair asset), the buy side's first one. */
  asset: Address;
}

/**
 * The outside leg of a `quoteSwap`, raw units of its tokenIn / tokenOut: `caps` = the most one window allows,
 * `capsLeft` = what other swaps left of them now. On Robinhood Chain usage counts per window of about 12 s, so
 * `capsLeft` is what a swap sent now meets and what `blocked` checks; elsewhere a swap sent now meets the full `caps`,
 * and those are checked (`hopExecutor.checkCaps`). Never cache.
 */
export interface SwapOutsideHop {
  tokenIn: Address;
  tokenOut: Address;
  caps: HopCaps;
  capsLeft: HopCapsLeft;
}

/** `quoteSwap`: the route, its engine, the tax-inclusive output, each side's tax and what would block it. Raw units. */
export interface SwapQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Who the taxes and whitelist are read for. */
  trader: Address;
  /** Empty when there is no route. */
  path: Address[];
  /** null when there is no route. */
  kind: SwapKind | null;
  engine: SwapEngine | null;
  /** `trading.quote(path, amountIn, trader)`: tax-inclusive, raw units of `tokenOut` (0 when blocked before the quote). */
  amountOut: bigint;
  /** `amountOut` minus the slippage (default `client.slippageBps.trade`); never 0 for a route that is not blocked, 0 when blocked. */
  minOut: bigint;
  taxes: SwapTax[];
  outsideHop: SwapOutsideHop | null;
  /** The trader's presale whitelist entry when `tokenOut` is frozen and still in presale, else null. */
  whitelist: WhitelistStatus | null;
  /**
   * Why the swap cannot be sent now, or null: 'no route', 'pair paused' (a main on the route has its pair paused),
   * 'trading not enabled', 'pair asset paused' (its issuer paused the pair asset of a main the route trades on,
   * and the swap moves it: on the path, as that side's fee, or as the trader's pending holder rewards, which a sale of a
   * factory token pays out in it whatever the fee), 'no executor', 'autovest presale' (a cross route into an auto-vest token in presale; a
   * plain buy works), 'not whitelisted', 'Overcapped on WL buying', 'above cap' (the outside leg is over what its caps
   * allow now: `capsLeft` on Robinhood Chain, where waiting about 12 seconds can clear it; `caps` elsewhere), 'too small',
   * or a decoded revert reason.
   */
  blocked: string | null;
}

/** A token as the router sees it: a main, a factory token, or anything else ('pair': a pair asset or an outside token). */
interface RouteToken {
  address: Address;
  kind: 'main' | 'token' | 'pair';
  /** A factory token's main, a main itself; null for 'pair' (or a factory token on an unknown main). */
  main: Address | null;
  /** The main's pair asset; null for 'pair'. */
  pair: Address | null;
}

interface PlannedRoute extends CrossRoute {
  /** The sell steps (`[tokenIn]` alone when there are none) and the buy steps (`[tokenOut]` alone when none). */
  sell: Address[];
  buy: Address[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * `client.trading`: plain buys/sells per main, cross-pair swaps, tax-inclusive quotes, and leverage (open, add, sell
 * part, extend, repay, claim). Every trade sends a real minimum, and every write returns the figures decoded from its
 * own events. An optional parameter or option given as null counts as not given
 * (as PY None). An options argument must be a plain object (or left out): a positional value in its place
 * (`repayLeverage(main, id, 50_000000n)`, `sell(token, amount, 1n)`) is refused, rule 'options', before any read.
 */
export class TradingModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when trading is deployed on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.swap);
  }

  private get swap(): Address {
    return this.require(this.client.addresses.swap, 'Swap');
  }


  /**
   * The on-chain quote, taxes included as `trader` (default: the signer, else 0x0). Sent as an eth_call. An outside hop
   * is quoted net of the hop fee (`hopExecutor.feePpm`). Prices plain paths too. Raw units of the last token.
   */
  async quoteCross(path: readonly Address[], amountIn: bigint, trader?: Address | null): Promise<bigint> {
    const amt = toUint(amountIn, 'amountIn');
    path = toPath(path);
    const who = trader == null ? this.client.account : toAddress(trader, 'trader');
    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.swap, abi: SwapAbi, functionName: 'quoteCross',
        args: [path, amt, who ?? zeroAddress], account: who,
      });
      return result;
    } catch (e) {
      throw decodeRevert(e, { contract: 'Swap', functionName: 'quoteCross', abi: SwapAbi });
    }
  }

  /**
   * Tax-inclusive output of a trade (raw units of the path's last token), as `trader` (default the signer).
   * Uses `quoteCross`; a plain buy of a token in an auto-vest presale (`[main, token]` or `[pairAsset, main, token]`,
   * which `quoteCross` refuses with "autovest presale" but `buyTokens` runs) is priced from `getAmountsOut` and the live
   * fee rate instead. Any other route into such a token (from another token) rethrows the revert: it cannot be traded.
   */
  async quote(path: readonly Address[], amountIn: bigint, trader?: Address | null): Promise<bigint> {
    const amt = toUint(amountIn, 'amountIn');
    const who = trader == null ? undefined : toAddress(trader, 'trader');
    return (await this.quoteTrade(toPath(path), amt, who)).out;
  }

  /** `quote` on a checked path, saying whether it was priced by hand (a plain buy of an auto-vest token in presale). */
  private async quoteTrade(path: readonly Address[], amt: bigint, trader?: Address): Promise<{ out: bigint; byHand: boolean }> {
    try {
      return { out: await this.quoteCross(path, amt, trader), byHand: false };
    } catch (e) {
      if (decodeRevert(e).reason !== 'autovest presale' || !(await this.isPlainBuy(path))) throw e;
      return { out: await this.quoteBuyByHand(path, amt, trader ?? this.client.account ?? zeroAddress), byHand: true };
    }
  }

  /**
   * A plain buy's quote for the signer. A quote priced by hand (an auto-vest token in presale) checks the presale
   * whitelist itself for a frozen token, as `quoteSwap` does: "No WL for freeze", then "Overcapped on WL buying" (bought
   * so far plus this buy over the wallet's cap).
   */
  private async quoteBuy(path: readonly Address[], amount: bigint): Promise<bigint> {
    const me = this.account;
    const { out, byHand } = await this.quoteTrade(path, amount, me);
    if (byHand) await this.checkPresaleWhitelist(path[path.length - 1], me, out);
    return out;
  }

  /**
   * The presale whitelist of a frozen factory token, for a presale buy of `tokens` by `who` (the caller knows the
   * presale is on): "No WL for freeze" for a wallet not on it, "Overcapped on WL buying" when the buy takes it over its
   * cap. Nothing for a token that is not frozen.
   */
  private async checkPresaleWhitelist(token: Address, who: Address, tokens: bigint): Promise<void> {
    const frozen = await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'frozen' });
    if (!frozen) return;
    const wl = await this.client.factory.getWhitelistStatus(token, who);
    if (!wl.whitelisted) throw new ValidationError('No WL for freeze', 'This token is frozen and the wallet is not whitelisted.');
    if (wl.bought + tokens > wl.maxBuy) {
      throw new ValidationError('Overcapped on WL buying', `This buy gets ${tokens} tokens, over what is left of the wallet's presale cap (${wl.remaining} of ${wl.maxBuy}): use a smaller amount.`);
    }
  }

  /** A path `buyTokens` runs as a buy: 2 or 3 tokens, the first not a factory token selling into the second. */
  private async isPlainBuy(path: readonly Address[]): Promise<boolean> {
    if (path.length !== 2 && path.length !== 3) return false;
    try {
      const q = await this.publicClient.readContract({ address: path[0], abi: EcosystemTokenAbi, functionName: 'quoteToken' });
      return !eq(q, path[1]);
    } catch {
      return true;
    }
  }

  /** Plain buy quote by hand, at the live fee rate of the bought token. */
  private async quoteBuyByHand(path: readonly Address[], amountIn: bigint, trader: Address): Promise<bigint> {
    const taxes = this.require(this.client.addresses.taxes, 'Taxes');
    const rate = await this.publicClient.readContract({ address: taxes, abi: TaxesAbi, functionName: 'getTaxRate', args: [path[path.length - 1], trader] });
    return this.getAmountsOut(amountIn - (amountIn * rate) / BPS, path);
  }

  /** The output of a trade **excluding tax** (use `quote` for what a trade pays). Raw units of the last token. */
  async getAmountsOut(amount: bigint, path: readonly Address[]): Promise<bigint> {
    const amt = toUint(amount, 'amount');
    return this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'getAmountsOut', args: [amt, toPath(path)] });
  }

  /**
   * A factory token's price in its main (unit `main`, 18 decimals); for a main, its price in the pair asset (unit
   * `pairAsset`, scaled by PAIR_UNIT).
   */
  async getTokenPrice(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const { info, isMain } = await this.tokenMain(token);
    if (isMain) return this.getPairPrice(token);
    const raw = await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getTokenPrice' });
    return toAmount(raw, 18, 'main', info.main, info.symbol);
  }

  /** The token's price in its main's pair asset (scaled by PAIR_UNIT). */
  async getPairPrice(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const { info, isMain } = await this.tokenMain(token);
    const raw = isMain
      ? await this.publicClient.readContract({ address: token, abi: MainTokenAbi, functionName: 'getPairPrice' })
      : await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getPairPrice' });
    return toAmount(raw, info.pairDecimals, 'pairAsset', info.pairAsset, info.pairSymbol);
  }

  /** The hop executor trading uses for outside hops (zero when there is none; outside hops then revert "no executor"). */
  async getHopExecutor(): Promise<Address> {
    return this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'hopExecutor' });
  }


  /** Buy path for `token`: `[pairAsset, main]` for a main; `[pairAsset, main, token]` or `[main, token]` for a factory token. */
  async buildBuyPath(token: Address, input: 'pairAsset' | 'main' = 'pairAsset'): Promise<Address[]> {
    if (input !== 'pairAsset' && input !== 'main') {
      throw new ValidationError('input', `input must be 'pairAsset' or 'main', got ${String(input)}.`);
    }
    token = toAddress(token, 'token');
    const { info, isMain } = await this.tokenMain(token);
    if (isMain) {
      if (input === 'main') throw new ValidationError('Bad path', 'A main is bought with its pair asset, not with itself.');
      return [info.pairAsset, info.main];
    }
    return input === 'main' ? [info.main, token] : [info.pairAsset, info.main, token];
  }

  /** Sell path for `token`: `[main, pairAsset]` for a main; `[token, main]` or `[token, main, pairAsset]` for a factory token. */
  async buildSellPath(token: Address, toPairAsset: boolean | null = false): Promise<Address[]> {
    const toPair = toBool(toPairAsset, 'toPairAsset', false);
    token = toAddress(token, 'token');
    const { info, isMain } = await this.tokenMain(token);
    if (isMain) return [info.main, info.pairAsset];
    return toPair ? [token, info.main, info.pairAsset] : [token, info.main];
  }

  /**
   * The `swapCross` route from `tokenIn` to `tokenOut`, or null when none exists (the same token, two non-BASIS assets,
   * a round trip, a factory token on an unknown main). Each token is a main (`mains.isMain`), a listed factory token or
   * an asset (a pair asset or an outside token). Route = the sell steps (token → main → pair asset), at most one outside
   * hop between two different assets, then the buy steps; no token twice. Plain buys and sells come out as their 2-3
   * token paths.
   */
  async buildCrossPath(tokenIn: Address, tokenOut: Address): Promise<CrossRoute | null> {
    tokenIn = toAddress(tokenIn, 'tokenIn');
    tokenOut = toAddress(tokenOut, 'tokenOut');
    const [a, b] = await Promise.all([this.routeToken(tokenIn), this.routeToken(tokenOut)]);
    const r = planRoute(a, b);
    return r && { path: r.path, usesOutside: r.usesOutside, outsideHop: r.outsideHop };
  }

  /**
   * One-call swap quote (what the API's `/swap/quote` returned), read from the chain as `trader` (default the signer,
   * else 0x0): the route (`buildCrossPath`), its kind and engine (`buyTokens` / `sellTokens` / `swapCross`), the
   * tax-inclusive `amountOut` (`quote`) and `minOut` (the client trade slippage, or `slippageBps`), each side's tax (read
   * live), the outside leg's caps and caps left, the whitelist entry of a frozen presale output, and `blocked` (paused
   * pairs and trading not yet enabled, read live, the issuer pause of a traded main's pair asset the swap moves,
   * executor and route, auto-vest presale, whitelist, the outside leg against what its caps allow a swap sent now:
   * `hopExecutor.checkCaps`, which counts the current window's usage on Robinhood Chain). A blocked quote carries
   * `minOut` 0 and is not sendable. Send with `buyTokens` / `sellTokens` / `swapCross` on `path`.
   */
  async quoteSwap(
    tokenIn: Address, tokenOut: Address, amountIn: bigint, opts: QuoteSwapOptions | null = {},
  ): Promise<SwapQuote> {
    const o = optsOf(opts, QUOTE_SWAP_KEYS);
    amountIn = checkAmount(amountIn, 'amountIn');
    if (o.slippageBps != null) validateSlippageBps(o.slippageBps);
    tokenIn = toAddress(tokenIn, 'tokenIn');
    tokenOut = toAddress(tokenOut, 'tokenOut');
    const trader = o.trader == null ? getAddress(this.client.account ?? zeroAddress) : toAddress(o.trader, 'trader');
    const pc = this.publicClient;
    const [a, b] = await Promise.all([this.routeToken(tokenIn), this.routeToken(tokenOut)]);
    const route = planRoute(a, b);
    const q: SwapQuote = {
      tokenIn, tokenOut, amountIn, trader, path: route?.path ?? [], kind: null, engine: null,
      amountOut: 0n, minOut: 0n, taxes: [], outsideHop: null, whitelist: null, blocked: null,
    };
    if (!route) return { ...q, blocked: 'no route' };
    const sellSide = route.sell.length > 1;
    const buySide = route.buy.length > 1;
    q.kind = route.usesOutside ? 'hop' : sellSide && buySide ? 'cross' : sellSide ? 'sell' : 'buy';
    q.engine = q.kind === 'buy' ? 'buyTokens' : q.kind === 'sell' ? 'sellTokens' : 'swapCross';
    let blocked: string | null = null;

    if ((await this.pausedMains(route.path)).length) blocked = 'pair paused';

    const base = await this.client.taxes.getBaseRate();
    let sellBase = 0;
    let buyBase = 0;
    if (sellSide && buySide) {
      if (!eq(a.main!, b.main!)) {
        sellBase = Math.floor(base / 2);
        buyBase = base - sellBase;
      } else sellBase = base;
    } else if (sellSide) sellBase = base;
    else buyBase = base;
    const rateOf = (token: Address, bps: number) => (bps === base
      ? this.client.taxes.getTaxRate(token, trader)
      : this.client.taxes.getTaxRateBase(token, trader, bps));
    const [sellBps, buyBps] = await Promise.all([sellSide ? rateOf(tokenIn, sellBase) : 0, buySide ? rateOf(tokenOut, buyBase) : 0]);
    const sellTax: SwapTax | null = sellSide ? { side: 'sell', token: tokenIn, taxBps: sellBps, amount: 0n, asset: route.sell[route.sell.length - 1] } : null;
    const buyTax: SwapTax | null = buySide ? { side: 'buy', token: tokenOut, taxBps: buyBps, amount: 0n, asset: route.buy[0] } : null;
    q.taxes = [sellTax, buyTax].filter((t): t is SwapTax => t !== null);

    const gated = new Map<string, Address>();
    const gate = (side: RouteToken, steps: Address[], bps: number) => {
      if (steps.length < 2 || !side.main) return;
      if (side.kind === 'main' || steps.length === 3 || bps > 0) gated.set(side.main.toLowerCase(), side.main);
    };
    gate(a, route.sell, sellBps);
    gate(b, route.buy, buyBps);
    const enabled = await Promise.all([...gated.values()].map((m) => pc.readContract({ address: m, abi: MainTokenAbi, functionName: 'tradingEnabled' })));
    if (enabled.some((x) => !x)) blocked ??= 'trading not enabled';

    if (!blocked) {
      const moved = new Map<string, Address>();
      const side = (t: RouteToken, steps: Address[], bps: number) => {
        if (steps.length < 2 || !t.main || !t.pair) return;
        if (bps > 0 || route.path.some((x) => eq(x, t.pair!))) moved.set(t.pair.toLowerCase(), t.pair);
      };
      side(a, route.sell, sellBps);
      side(b, route.buy, buyBps);
      const rewardsIn = sellSide && a.kind === 'token' && a.pair && !moved.has(a.pair.toLowerCase()) ? a.pair : null;
      const assets = [...moved.values(), ...(rewardsIn ? [rewardsIn] : [])];
      const paused = await Promise.all(assets.map((x) => isAssetPaused(this.client, x)));
      if (paused.slice(0, moved.size).some((x) => x)) blocked = 'pair asset paused';
      else if (rewardsIn && paused[moved.size] && (await this.claimableRewards(tokenIn, trader)) > 0n) blocked = 'pair asset paused';
    }

    let exec: Address | null = null;
    if (route.outsideHop) {
      const [hIn, hOut] = route.outsideHop;
      exec = await this.getHopExecutor();
      if (isZeroAddress(exec)) {
        blocked ??= 'no executor';
      } else {
        const [hops, idle] = await Promise.all([
          pc.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'getRoute', args: [hIn, hOut] }),
          this.client.hopExecutor.checkCaps(hIn, hOut, 0n, undefined, { executor: exec }),
        ]);
        q.outsideHop = { tokenIn: hIn, tokenOut: hOut, caps: idle.caps, capsLeft: idle.capsLeft };
        if (hops.length === 0) blocked ??= 'no route';
      }
    }

    if (b.kind === 'token') {
      const c = { address: tokenOut, abi: FactoryTokenAbi } as const;
      const [presaleComplete, autoVest, frozen] = await Promise.all([
        pc.readContract({ ...c, functionName: 'presaleComplete' }),
        pc.readContract({ ...c, functionName: 'autoVest' }),
        pc.readContract({ ...c, functionName: 'frozen' }),
      ]);
      if (!presaleComplete && autoVest && q.engine !== 'buyTokens') blocked ??= 'autovest presale';
      if (!presaleComplete && frozen) {
        q.whitelist = await this.client.factory.getWhitelistStatus(tokenOut, trader);
        if (!q.whitelist.whitelisted) blocked ??= 'not whitelisted';
      }
    }

    if (!blocked) {
      try {
        let x = amountIn;
        if (sellTax) {
          const gross = await this.getAmountsOut(amountIn, route.sell);
          sellTax.amount = (gross * BigInt(sellBps)) / BPS;
          x = gross - sellTax.amount;
        }
        if (route.outsideHop && q.outsideHop && exec) {
          const [hIn, hOut] = route.outsideHop;
          const pre = await this.client.hopExecutor.checkCaps(hIn, hOut, x, undefined, { executor: exec });
          if (pre.blocked) blocked = pre.blocked;
          else {
            const [out, feePpm] = await Promise.all([
              this.simulateHop(exec, hIn, hOut, x),
              pc.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'feePpm' }),
            ]);
            const post = await this.client.hopExecutor.checkCaps(hIn, hOut, x, grossOfHop(out, feePpm), { executor: exec });
            if (post.blocked) blocked = post.blocked;
            x = out;
          }
        }
        if (!blocked) {
          if (buyTax) buyTax.amount = (x * BigInt(buyBps)) / BPS;
          q.amountOut = await this.quote(route.path, amountIn, trader);
        }
      } catch (e) {
        blocked = swapBlockReason(e);
      }
    }
    if (!blocked && q.whitelist && q.whitelist.bought + q.amountOut > q.whitelist.maxBuy) blocked = 'Overcapped on WL buying';
    if (!blocked) {
      q.minOut = minWithSlippage(q.amountOut, o.slippageBps ?? this.client.slippageBps.trade);
      if (q.minOut === 0n) blocked = 'too small';
    }
    q.blocked = blocked;
    return q;
  }


  /**
   * Buy along `path` (`amount` raw units of path[0]). Approves path[0] to the swap. The trade is quoted first (`quote`,
   * one eth_call), also with an explicit `minOut`, so its run-time refusals ("Trading is not enabled", the frozen
   * presale whitelist: "No WL for freeze", "Overcapped on WL buying", ...) come before the approval; `minOut` omitted →
   * the quote minus the client slippage, an explicit one above the quote → "Min out". `wrapTokens` stakes a bought
   * **main** in its vault (ignored for factory tokens), with `buyAndStake`'s rule: a quote under the vault's `minStake`
   * is refused ("Below min stake") and the minimum sent is raised to it. A presale buy of an auto-vest token goes into a
   * vesting for the signer, not the wallet (`autoVested`); a frozen one checks the wallet's presale whitelist first.
   * Refuses a paused pair ("unknown pair"), then a path in the wrong direction, before any approval: a buy starts at a
   * main's pair asset (or at the main, for a factory token on it) and ends in a main or a factory token ("Alien
   * output", "Bad pair", "Not pair asset", "Not ecosystem"). After the quote, 'pair asset paused' (its issuer paused
   * the main's pair asset and the buy moves it: a buy of a factory token with the main is refused only when the signer
   * pays a fee on it). Returns the trade figures.
   */
  async buyTokens(
    amount: bigint, minOut: bigint | null | undefined, path: readonly Address[], wrapTokens: boolean | null = false, slippageBps?: number | null,
  ): Promise<TradeResult> {
    this.checkPlainPath(path);
    amount = checkAmount(amount, 'amount');
    const explicit = optUint(minOut, 'minOut');
    const wrap = toBool(wrapTokens, 'wrapTokens', false);
    const p = toPath(path);
    const pairs = await this.checkPlainRoute('buyTokens', p);
    const [outAsset, staking] = pairs[p.length - 1];
    const min = wrap && !isZeroAddress(outAsset)
      ? await this.stakeMin(await this.client.mains.get(p[p.length - 1]), staking, p, amount, explicit, slippageBps)
      : await this.tradeMin(explicit, slippageBps, () => this.quoteBuy(p, amount), 'what this buy gets');
    await this.refusePausedPlain(p, pairs);
    return this.sendTrade('buyTokens', amount, min, p, wrap);
  }

  /**
   * Sell along `path` (`amount` raw units of path[0]). Approves path[0] to the swap. For native ETH out use `swapCross`
   * with `unwrapNative`. Quoted first (`quote`, one eth_call), also with an explicit `minOut` (its run-time refusals come
   * before the approval; an explicit minimum above the quote: "Min out").
   * Refuses a paused pair ("unknown pair"), then a path in the wrong direction, before any approval: a sell starts at a
   * main or a factory token and ends at the main's pair asset (or at the main, for a factory token) ("Wrong token",
   * "Bad pair", "Not ecosystem", "Not MAIN", "Not pair asset"). After the quote, 'pair asset paused' (its issuer paused
   * the main's pair asset and the sale moves it, also as the signer's pending holder rewards, which a sale of a factory
   * token pays out in it whatever the fee: a sale of a factory token for the main is refused only when the signer pays
   * a fee on it or has holder rewards on it to claim, `factory.getClaimableRewards` above 0). Returns the trade figures.
   */
  async sellTokens(amount: bigint, minOut: bigint | null | undefined, path: readonly Address[], slippageBps?: number | null): Promise<TradeResult> {
    this.checkPlainPath(path);
    amount = checkAmount(amount, 'amount');
    const explicit = optUint(minOut, 'minOut');
    const p = toPath(path);
    const pairs = await this.checkPlainRoute('sellTokens', p);
    const min = await this.tradeMin(explicit, slippageBps, () => this.quote(p, amount), 'what this sale pays');
    await this.refusePausedPlain(p, pairs);
    return this.sendTrade('sellTokens', amount, min, p, false);
  }

  /**
   * Buy `token` (a main or a factory token) with `amountIn` raw units of its main's pair asset (or of the main: `opts.input`).
   * A presale buy of an auto-vest token lands in a vesting (`autoVested`), not the wallet.
   */
  async buy(token: Address, amountIn: bigint, opts: BuyOptions | null = {}): Promise<TradeResult> {
    const o = optsOf(opts, BUY_KEYS);
    const path = await this.buildBuyPath(token, o.input);
    return this.buyTokens(amountIn, o.minOut, path, false, o.slippageBps);
  }

  /** Sell `amount` raw units of `token`; a factory token stops at its main unless `opts.toPairAsset`. */
  async sell(token: Address, amount: bigint, opts: SellOptions | null = {}): Promise<TradeResult> {
    const o = optsOf(opts, SELL_KEYS);
    const path = await this.buildSellPath(token, o.toPairAsset);
    return this.sellTokens(amount, o.minOut, path, o.slippageBps);
  }

  /** Sell `percentage` (1-100, a whole number or a bigint) of the signer's balance of `token`. */
  async sellPercentage(token: Address, percentage: number | bigint, opts: SellOptions | null = {}): Promise<TradeResult> {
    const o = optsOf(opts, SELL_KEYS);
    const pct = wholeOrNull(percentage);
    if (pct === null || pct < 1n || pct > 100n) {
      throw new ValidationError('percentage', `percentage must be an integer 1-100, got ${String(percentage)}.`);
    }
    toBool(o.toPairAsset, 'toPairAsset', false);
    token = toAddress(token, 'token');
    const balance = await this.balanceOf(token);
    const amount = (balance * pct) / 100n;
    if (amount === 0n) throw new ValidationError('balance', `Nothing to sell: balance of ${token} is ${balance}.`);
    return this.sell(token, amount, o);
  }

  /**
   * Buy a main with `amount` raw pair asset and stake it in that main's vault in one tx (`buyTokens(..., wrapTokens = true)`).
   * The vault stakes at least its `minStake`: a quote under it is refused ("Below min stake") and the minimum sent is
   * raised to `minStake`, so the slippage guard covers the stake too.
   * Then 'pair asset paused' (its issuer paused the pair asset the buy is paid in), before any approval.
   */
  async buyAndStake(main: MainRef, amount: bigint, opts: TradeOptions | null = {}): Promise<BuyAndStakeResult> {
    const o = optsOf(opts, TRADE_KEYS);
    const info = await this.client.mains.get(main);
    amount = checkAmount(amount, 'amount');
    const explicit = optUint(o.minOut, 'minOut');
    const [, staking, active] = await this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairs', args: [info.main] });
    if (!active) throw pausedError(info.main);
    const path = [info.pairAsset, info.main];
    const min = await this.stakeMin(info, staking, path, amount, explicit, o.slippageBps);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, TRADE_PAUSED);
    const tx = await this.sendTrade('buyTokens', amount, min, path, true);
    const me = this.account;
    const st = this.firstEvent(tx, VaultAbi, 'Staked', staking, 'Vault', ['staked'], (e) => eq(e.user, me) && eq(e.main, info.main));
    return { ...tx, staked: st ? mainAmount(st.amount, info) : null };
  }


  /**
   * Any route in one tx (sell-token, sell-main, outside, buy-main, buy-token, each at most once). Approves path[0] to
   * the swap, or with `native` sends `amountIn` as msg.value (path[0] = WETH). `minOut` omitted → derived from
   * `quoteCross` as the signer. Refuses, before any approval: a zero `recipient` ("no recipient"), a `deadline` before
   * the latest block time ("Deadline"), a paused main on the path ("unknown pair"), a path refused by its steps ("Bad
   * route order": steps out of order or repeated; "no BASIS leg": nothing sold or bought on BASIS; "round trip": a main
   * sold into its pair asset and bought back), 'pair asset paused' (its issuer paused the pair asset of a main the route
   * trades on and the route moves it: on the path, as a side's fee, or as the signer's pending holder rewards, which a
   * sale of a factory token pays out in it whatever the fee: refused only when the signer pays a fee there or has
   * rewards to claim on the token sold, `factory.getClaimableRewards` above 0), an outside hop over what its caps allow
   * a swap sent now ("above cap": what other swaps left of them in the current window on Robinhood Chain, where waiting
   * about 12 seconds can clear it; `hopExecutor.checkCaps`), all as `ValidationError` with or without `minOut`, then
   * what `quoteCross` (read either way, one eth_call) refuses, as the contract's revert ("autovest presale", "Trading is
   * not enabled", the frozen presale whitelist, ...), and an explicit `minOut` above that quote ("Min out"). Returns the
   * swap figures (`amountOut` = what was delivered).
   */
  async swapCross(path: readonly Address[], amountIn: bigint, opts: SwapCrossOptions | null = {}): Promise<SwapCrossResult> {
    const o = optsOf(opts, SWAP_CROSS_KEYS);
    if (path.length < 2) throw new ValidationError('Bad path', 'A cross path needs at least 2 tokens.');
    path = toPath(path);
    if (eq(path[0], path[path.length - 1])) throw new ValidationError('same token', 'Input and output token are the same.');
    amountIn = checkAmount(amountIn, 'amountIn');
    const explicit = optUint(o.minOut, 'minOut');
    const native = toBool(o.native, 'native', false);
    const unwrapNative = toBool(o.unwrapNative, 'unwrapNative', false);
    const optDeadline = optUint(o.deadline, 'deadline');
    const me = this.account;
    const recipient = o.recipient == null ? me : toAddress(o.recipient, 'recipient');
    if (isZeroAddress(recipient)) throw new ValidationError('no recipient', 'The output cannot go to the zero address: omit recipient to receive it yourself.');
    const deadline = await this.sendDeadline(optDeadline);
    await this.checkPairsActive(path);

    let weth: Address | null = null;
    if (native || unwrapNative) {
      const exec = await this.getHopExecutor();
      if (isZeroAddress(exec)) throw new ValidationError('no executor', 'Native in/out needs the hop executor, which SWAP does not have yet.');
      weth = await this.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'weth' });
    }
    if (native && !eq(path[0], weth!)) throw new ValidationError('native in', `Native input needs path[0] = WETH (${weth}).`);
    if (unwrapNative && !eq(path[path.length - 1], weth!)) throw new ValidationError('not native', `unwrapNative needs the path to end in WETH (${weth}).`);

    const rt = await Promise.all(path.map((t) => this.routeToken(t)));
    checkCrossPlan(path, rt);
    await this.refusePausedCross(path, rt);
    await checkCrossHop(this.client, path, rt, amountIn, me, (ex, a, b, v) => this.simulateHop(ex, a, b, v));
    const min = await this.tradeMin(explicit, o.slippageBps, () => this.quoteCross(path, amountIn, me), 'what this swap pays');
    const f = await this.crossFormats(path, rt[0], rt[rt.length - 1]);

    if (native) {
      const bal = await this.publicClient.getBalance({ address: me });
      if (bal < amountIn) throw new ValidationError('balance', `Native balance ${bal} is below ${amountIn}.`);
    } else {
      await this.checkBalance(path[0], amountIn);
      await this.ensureAllowance(path[0], this.swap, amountIn);
    }
    const tx = await this.send({
      address: this.swap, abi: SwapAbi, functionName: 'swapCross',
      args: [path, amountIn, min, recipient, deadline, unwrapNative],
      value: native ? amountIn : undefined,
      contract: 'Swap',
    });
    const ev = this.firstEvent(tx, SwapAbi, 'CrossSwap', this.swap, 'Swap',
      ['amountIn', 'amountOut', 'recipient', 'sellFee', 'buyFee', 'sellOut', 'buyIn'], (e) => eq(e.trader, me));
    return {
      ...tx, amountIn: optAmount(f.in, ev?.amountIn), amountOut: optAmount(f.out, ev?.amountOut), recipient: ev?.recipient ?? null,
      sellFee: optAmount(f.sell, ev?.sellFee), buyFee: optAmount(f.buy, ev?.buyFee),
      sellOut: optAmount(f.sell, ev?.sellOut), buyIn: optAmount(f.buy, ev?.buyIn),
      rewardsClaimed: f.rewards ? this.rewardsPaid(tx, path[0], f.rewards) : null,
    };
  }


  /**
   * What a leverage buy (`leveragePct` 100) or mixed buy (1-99) of `amount` raw pair asset on `target` (a token, or an
   * explicit `[pairAsset, main(, token)]` path) does now, priced at the rate of `user` (default the signer; the open
   * pays that wallet's rate). A client with neither gets the list rate (`trader` is then the zero address): no wallet
   * discounts, so a real open gets at least that collateral. One position per token: with one open the buy adds to it,
   * priced on its days left (`numberOfDays` is then ignored), and "Extend first" is thrown below the main's minimum
   * loan days left. A new position checks `numberOfDays` against the main's range. A bad path and a paused pair are
   * refused first, in `leverageBuy`'s order ("wrong path", "unknown pair"). Everything else the
   * open would be refused with now is listed in `blocked` ("In presale", "No WL for freeze", "WL cap", "Under 2x",
   * "Trading is not enabled", "pair asset paused"), not thrown: the quote is sendable only while `blocked` is empty.
   */
  async quoteLeverage(
    target: Address | readonly Address[], amount: bigint, numberOfDays: bigint | number, leveragePct: number | bigint = 100, user?: Address | null,
  ): Promise<LeverageQuote> {
    const pct = checkLevPct(leveragePct, 100);
    const who = user == null ? this.client.account : toAddress(user, 'user');
    const path = await this.leveragePath(target);
    amount = checkAmount(amount, 'amount');
    const days = toUint(numberOfDays, 'numberOfDays');
    const { q, daysError } = await this.quoteOn(path, amount, days, pct, who);
    if (daysError) throw daysError;
    const blocks = await this.leverageBlocks(path, q, q.trader);
    return { ...q, blocked: blocks.map((b) => b.rule as LeverageBlock) };
  }

  /**
   * The user's (default the signer's) one open leverage position on `token`, or null.
   * `main` undefined: the token's own main.
   */
  async getOpenLeverage(main: MainRef | null | undefined, token: Address, user?: Address | null): Promise<OpenLeverage | null> {
    token = toAddress(token, 'token');
    const given = user == null ? undefined : toAddress(user, 'user');
    const mainAddr = main == null ? await this.client.mains.mainOf(token) : this.client.mains.addressOf(main);
    const who = given ?? this.account;
    const loanId = await this.publicClient.readContract({ address: mainAddr, abi: MainTokenAbi, functionName: 'openLeverageOf', args: [who, token] });
    if (loanId === 0n) return null;
    const [position, block] = await Promise.all([readCoreLoan(this.client, mainAddr, who, loanId, true), this.publicClient.getBlock()]);
    const now = block.timestamp + 1n;
    const end = position.liquidationTime;
    return { loanId, position, daysLeft: end > now ? (end - now) / 86_400n : 0n };
  }

  /**
   * Every leverage position id `user` (default the signer) ever opened on `token` (open and closed, oldest first).
   * `main` undefined: the token's own main. Positions: `getLeveragePosition(main, user, id)`.
   */
  async getLeverageIdsForToken(main: MainRef | null | undefined, token: Address, user?: Address | null): Promise<bigint[]> {
    token = toAddress(token, 'token');
    const given = user == null ? undefined : toAddress(user, 'user');
    const mainAddr = main == null ? await this.client.mains.mainOf(token) : this.client.mains.addressOf(main);
    const who = given ?? this.account;
    const n = await this.client.mainLens.getLeverageCountForUserAndToken(mainAddr, who, token);
    return Promise.all(Array.from({ length: Number(n) }, (_, i) => this.publicClient.readContract({
      address: mainAddr, abi: MainTokenAbi, functionName: 'userTokenLeverageIds', args: [who, token, BigInt(i)],
    })));
  }

  /**
   * Open a leverage position on `target` (a token, path built as `[pairAsset, main(, token)]`, or an explicit path
   * starting at the main's pair asset), or ADD to the open one on that token (same end date, priced on the days left).
   * `amount` raw pair asset, approved to the swap. `minOut` omitted → `quoteLeverage(...)` collateral minus the
   * slippage. Pre-checks, in order: "wrong path" (path[1] not a main, path[0] not its pair asset), "unknown pair"
   * (paused), "wrong path" (not 2 or 3 tokens, or a factory token that is not listed: a delisted token cannot be
   * leveraged), "Extend first" (add), "In presale", "No WL for freeze", "WL
   * cap" (frozen factory token), "Under 2x", "Min out" (an explicit `minOut` above the quote's collateral), days range
   * (new position), then "Trading is not enabled" (a main not live yet) and "pair asset paused" (its issuer paused the
   * pair asset the buy is paid in), all before the approval (`quoteLeverage` lists the same refusals in `blocked`).
   * Returns the position id and figures.
   */
  async leverageBuy(target: Address | readonly Address[], amount: bigint, numberOfDays: bigint | number, opts: LeverageOptions | null = {}): Promise<LeverageBuyResult> {
    const o = optsOf(opts, LEVERAGE_KEYS);
    return this.levBuy(target, amount, numberOfDays, 100, o);
  }

  /**
   * ONE leverage position at a chosen leverage, `percentageLeverage` (1-99): the whole amount goes into the position,
   * and a lower value keeps more of it as debt-free collateral (nothing goes to the wallet). Adds to an open position
   * like `leverageBuy`, same pre-checks. The position must still reach 2x ("Under 2x"). `opts.minOut` = minimum tokens
   * into the position.
   */
  async mixedBuy(
    target: Address | readonly Address[], amount: bigint, numberOfDays: bigint | number, percentageLeverage: number | bigint,
    opts: LeverageOptions | null = {},
  ): Promise<LeverageBuyResult> {
    const o = optsOf(opts, LEVERAGE_KEYS);
    return this.levBuy(target, amount, numberOfDays, checkLevPct(percentageLeverage, 99), o);
  }

  /** `opts` already through `optsOf` (leverageBuy / mixedBuy). */
  private async levBuy(target: Address | readonly Address[], amount: bigint, numberOfDays: bigint | number, pct: number, opts: LeverageOptions): Promise<LeverageBuyResult> {
    const path = await this.leveragePath(target);
    amount = checkAmount(amount, 'amount');
    const days = toUint(numberOfDays, 'numberOfDays');
    const explicit = optUint(opts.minOut, 'minOut');
    const me = this.account;
    const { q, daysError } = await this.quoteOn(path, amount, days, pct, me);
    const blocks = await this.leverageBlocks(path, q, me);
    const gate = blocks.find((b) => b.rule === 'Trading is not enabled');
    const paused = blocks.find((b) => b.rule === 'pair asset paused');
    const first = blocks.find((b) => b !== gate && b !== paused);
    if (first) throw first;
    checkExplicitMin(explicit, q.sim.totalCollateral, 'minOut', 'what this buy puts in the position');
    if (daysError) throw daysError;
    const min = await this.resolveMin(explicit, opts.slippageBps, async () => q.sim.totalCollateral);
    if (gate) throw gate;
    if (paused) throw paused;
    await this.checkBalance(path[0], amount);
    const info = await this.client.mains.get(path[1]);
    const pair = pairAmountOf(info);
    const col = await amountOf(this.client, path[path.length - 1], info);
    await this.ensureAllowance(path[0], this.swap, amount);
    const tx = pct === 100
      ? await this.send({ address: this.swap, abi: SwapAbi, functionName: 'leverageBuy', args: [amount, min, path, q.days], contract: 'Swap' })
      : await this.send({ address: this.swap, abi: SwapAbi, functionName: 'mixedBuy', args: [amount, min, path, q.days, BigInt(pct)], contract: 'Swap' });
    const main = path[1];
    const created = this.events(tx, MainTokenAbi, 'LeverageCreated', main).find((e) => eq(e.user, me));
    if (created) {
      return {
        ...tx, loanId: created.loanId, added: false, collateralAdded: col(created.collateralAmount), borrowedAdded: pair(created.borrowedAmount),
        debtAdded: pair(created.fullAmount), initialBuy: pair(created.initialBuy), liquidationTime: created.liquidationTime,
      };
    }
    const inc = this.firstEvent(tx, MainTokenAbi, 'LeverageIncreased', main, 'MainToken',
      ['loanId', 'added', 'collateralAdded', 'borrowedAdded', 'debtAdded', 'initialBuy'], (e) => eq(e.user, me));
    return {
      ...tx, loanId: inc?.loanId ?? null, added: inc ? true : null, collateralAdded: optAmount(col, inc?.collateralAdded),
      borrowedAdded: optAmount(pair, inc?.borrowedAdded), debtAdded: optAmount(pair, inc?.fullAmountAdded),
      initialBuy: optAmount(pair, inc?.initialBuy), liquidationTime: null,
    };
  }

  /**
   * Sell `percentage` (10-100, step 10) of the signer's leverage position on `main`; 100 closes it (hub loans are sold
   * through `loans.partialSellLoan`). The exit fee is the signer's own sell fee rate on the profit only: a sale at a loss
   * pays none, and neither does a fee-whitelisted wallet. `minOut` binds what the signer receives, after the fee;
   * omitted → `quotePartialSellLeverage(...).net` minus the slippage (never 0: a quote that rounds to 0 is refused). An
   * explicit `minOut` of 0 is sent as given: a main-collateral position, or a factory-token one on the standard curve
   * (hybrid multiplier 100, not reversed), whose sale pays nothing (underwater: the debt takes all it brings in) can
   * still be closed with it, and its slot freed; the sale then pays whatever it pays, from 0 up, without a guard. On any
   * other factory token an underwater sale is refused ("cannot sell off with no profit"), with `minOut` 0 too: nothing
   * is sent. Rules, in order: "unknown pair" (paused), "% by 10", "% range", "Not user", "Loan not
   * active", then 'pair asset paused' (its issuer paused the pair asset the sale pays out in). Returns the sale figures
   * (gross, fee, payout, what is left).
   */
  async partialSellLeverage(main: MainRef, loanId: bigint, percentage: number | bigint, opts: TradeOptions | null = {}): Promise<PartialSellLeverageResult> {
    const o = optsOf(opts, TRADE_KEYS);
    const id = toUint(loanId, 'loanId');
    const explicit = optUint(o.minOut, 'minOut');
    const mainAddr = this.client.mains.addressOf(main);
    await this.checkPairsActive([mainAddr]);
    const pct = checkSellPct(percentage);
    const me = this.account;
    const pos = await this.sellablePosition(mainAddr, me, id);
    let min: bigint;
    if (explicit === 0n) {
      if (o.slippageBps != null) validateSlippageBps(o.slippageBps);
      min = 0n;
    } else {
      min = await this.resolveMin(explicit, o.slippageBps, async () => (await quotePartialSell(this.client, mainAddr, pos, me, id, pct, true, me)).net);
    }
    const info = await this.client.mains.get(mainAddr);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'no sale can pay it out');
    const pair = pairAmountOf(info);
    const col = await amountOf(this.client, pos.token, info);
    const tx = await this.send({
      address: this.swap, abi: SwapAbi, functionName: 'partialLoanSellFor',
      args: [mainAddr, id, BigInt(pct), true, min], contract: 'Swap',
    });
    const ev = this.firstEvent(tx, SwapAbi, 'LoanSold', this.swap, 'Swap',
      ['gross', 'fee', 'payout', 'debtLeft', 'collateralLeft', 'closed'], (e) => eq(e.owner, me) && e.loanId === id);
    return {
      ...tx, gross: optAmount(pair, ev?.gross), fee: optAmount(pair, ev?.fee), payout: ev ? pair(ev.gross - ev.fee) : null,
      debtLeft: optAmount(pair, ev?.debtLeft), collateralLeft: optAmount(col, ev?.collateralLeft),
      closed: ev ? ev.debtLeft === 0n && ev.collateralLeft === 0n : null,
      rewardsClaimed: eq(pos.token, mainAddr) ? null : this.rewardsPaid(tx, pos.token, pair),
    };
  }

  /**
   * Preview `partialSellLeverage(main, loanId, percentage)` for `user` (default the signer), in the same state: the
   * gross pair asset, the profit in it, `user`'s sell rate, the fee, the net payout (`minOut` binds it) and the collateral /
   * debt slices. Exact for a position in a main; for a factory token the payout may be a little higher than quoted
   * (dust), never lower. Rules, in order: "unknown pair" (paused), "% by 10", "% range", "Not user", "Loan not active".
   */
  async quotePartialSellLeverage(main: MainRef, loanId: bigint, percentage: number | bigint, user?: Address | null): Promise<LeveragePartialSellQuote> {
    const id = toUint(loanId, 'loanId');
    const given = user == null ? undefined : toAddress(user, 'user');
    const mainAddr = this.client.mains.addressOf(main);
    await this.checkPairsActive([mainAddr]);
    const pct = checkSellPct(percentage);
    const who = given ?? this.account;
    const pos = await this.sellablePosition(mainAddr, who, id);
    const exit = await quotePartialSell(this.client, mainAddr, pos, who, id, pct, true, who);
    const share = BigInt(pct);
    return { ...exit, collateralSold: (pos.collateralAmount * share) / 100n, debtRepaid: (pos.fullAmount * share) / 100n };
  }

  /**
   * Extend the signer's leverage position on its main by `numberOfDays` (the main's `minDays..maxDays`,
   * `loans.getLoanTerms`, or 0 with `refinance`). The days count from the due date, or from the time of the transaction
   * when the position is past due (not yet liquidated): the new due date is the later of the two plus the days.
   * `payInPairAsset` pays the fee in the pair asset (approved to the main); otherwise it is added to the debt, or a
   * refinance pays the surplus out. Both together are refused ("Pay in stable or refinance, not both"). A paused pair is
   * refused first ("unknown pair"), then a pair asset its issuer paused ('pair asset paused'), before any approval.
   * Other refusals carry the contract's revert reason, in order (the same check as `loans.extendLoan` /
   * `vault.extendLoan`): "Must be refinance if not extending time", "incorrect loan duration", "Loan not active", then
   * "Not enough collateral to cover fees" (add to debt) or "No equity", "Minimum surplus not met", "Time remaining too
   * short", "Fees exceed surplus value" (refinance).
   * Returns the new end date and debt, and `extraOut` (a refinance's payout).
   */
  async extendLeverage(main: MainRef, loanId: bigint, numberOfDays: bigint | number, payInPairAsset: boolean, refinance: boolean): Promise<ExtendLeverageResult> {
    const id = toUint(loanId, 'loanId');
    payInPairAsset = toBool(payInPairAsset, 'payInPairAsset');
    refinance = toBool(refinance, 'refinance');
    if (payInPairAsset && refinance) {
      throw new ValidationError('Pay in stable or refinance, not both', 'Choose either payInPairAsset or refinance, not both (the main silently ignores refinance when paying).');
    }
    const info = await this.client.mains.get(main);
    const days = toUint(numberOfDays, 'numberOfDays');
    const me = this.account;
    await this.checkPairsActive([info.main]);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'no extension can take its fee');
    const [pos, q] = await Promise.all([
      readCoreLoan(this.client, info.main, me, id, true),
      this.leverageExtensionQuote(info.main, [me, id, days, true, payInPairAsset, refinance]),
    ]);
    const refusal = await coreExtendRefusal(this.client, info.main, pos, days, payInPairAsset, refinance, q);
    if (refusal) throw refusal;
    if (payInPairAsset) {
      await this.checkBalance(info.pairAsset, q.fee);
      await this.ensureAllowance(info.pairAsset, info.main, q.fee);
    }
    const tx = await this.send({
      address: info.main, abi: MainTokenAbi, functionName: 'extendLoan',
      args: [id, days, true, payInPairAsset, refinance], contract: 'MainToken',
    });
    const ev = this.firstEvent(tx, MainTokenAbi, 'LoanExtended', info.main, 'MainToken',
      ['newLiquidationTime', 'newFullAmount', 'newBorrowedAmount', 'extraOut'], (e) => eq(e.user, me) && e.loanId === id && e.isLeverage);
    const pair = pairAmountOf(info);
    return {
      ...tx, newLiquidationTime: ev?.newLiquidationTime ?? null, newFullAmount: optAmount(pair, ev?.newFullAmount),
      newBorrowedAmount: optAmount(pair, ev?.newBorrowedAmount),
      extraOut: ev ? pair(refinance && ev.newBorrowedAmount > pos.borrowedAmount ? ev.newBorrowedAmount - pos.borrowedAmount : 0n) : null,
    };
  }

  /**
   * Repay the signer's leverage position with the pair asset (nothing is sold). `amount` (raw) omitted or null = in full
   * (exactly the debt is taken and all collateral comes back). Under the debt: the debt drops by it, the repaid share of
   * the collateral comes back (and the fee-free part of a later sale shrinks by the same share) and the position
   * stays open; what is left must stay at least the main's `minimumLoan`
   * ("Repay in full"; `getLeverageRepayPreview` gives the largest partial). Rules, in order: "Loan not active",
   * "Zero amount", "Repay in full", then 'pair asset paused' (its issuer paused the pair asset: the debt cannot be paid
   * in) and the balance. Approves the pair asset taken to the main. Returns the amount taken and the outcome.
   */
  async repayLeverage(main: MainRef, loanId: bigint, opts: RepayLeverageOptions | null = {}): Promise<RepayLeverageResult> {
    const o = optsOf(opts, REPAY_LEVERAGE_KEYS);
    const id = toUint(loanId, 'loanId');
    const amount = o.amount == null ? maxUint256 : toUint(o.amount, 'amount');
    const info = await this.client.mains.get(main);
    const pos = await readCoreLoan(this.client, info.main, this.account, id, true);
    if (!pos.active) throw new ValidationError('Loan not active', `Leverage ${id} is not active.`);
    if (amount === 0n) throw new ValidationError('Zero amount', 'amount must be greater than 0 (omit it to repay in full).');
    const p = await this.repayPreview(info.main, id, pos, amount);
    if (!p.allowed) {
      throw new ValidationError('Repay in full', `Repaying ${amount} of ${p.debt} would leave ${p.debtLeft}, under the minimum loan ${p.minimumLoan}: repay at most ${p.maxPartial}, or in full.`);
    }
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'the position cannot be repaid in it now');
    await this.checkBalance(info.pairAsset, p.amount);
    const col = await amountOf(this.client, pos.token, info);
    await this.ensureAllowance(info.pairAsset, info.main, p.amount);
    const tx = await this.send({
      address: info.main, abi: MainTokenAbi, functionName: 'repayLoan', args: [id, amount, true], contract: 'MainToken',
    });
    const res = this.repayOutcome(tx, info, id, pos, col, ['repaid', 'closed', 'debtLeft', 'collateralReleased']);
    return { ...tx, ...res.outcome, repaid: res.amount };
  }

  /**
   * Preview `repayLeverage(main, loanId, { amount })` for `user` (default the signer): whether the position is active,
   * the debt, the minimum loan, the largest partial repay, the pair asset taken and the collateral released. `amount`
   * omitted or null = in full. `allowed` is false for a position that is not active.
   */
  async getLeverageRepayPreview(main: MainRef, loanId: bigint, amount?: bigint | null, user?: Address | null): Promise<LeverageRepayPreview> {
    const id = toUint(loanId, 'loanId');
    const amt = amount == null ? maxUint256 : toUint(amount, 'amount');
    const given = user == null ? undefined : toAddress(user, 'user');
    const mainAddr = this.client.mains.addressOf(main);
    const pos = await readCoreLoan(this.client, mainAddr, given ?? this.account, id, true);
    return this.repayPreview(mainAddr, id, pos, amt);
  }

  /**
   * Repay the signer's leverage position with another token: `tokenIn` is swapped to the main's pair asset through an
   * outside exchange (net of the hop fee, within what the route's caps allow now; no swap when `tokenIn` is the pair
   * asset), all of it goes to the debt (a partial repay releases its share of the collateral) and the pair asset left
   * over is refunded. Without `amountIn` it is sized to repay everything: the amount quoting the debt, plus `bufferBps`
   * (0.5%), with `close` = true. `minPairOut` omitted: the quote minus the slippage, raised to the debt when closing or
   * when the quote covers it (a payout just under the debt would revert "Repay in full"). Checks the deadline first
   * (default latest block + 600 s; an explicit one before the latest block time: "Deadline"), then the route ("no
   * executor", "no route"), 'pair asset paused' (its issuer paused the pair asset the debt is paid in), an explicit
   * `amountIn` against what the route's caps allow a swap sent now ("above cap": what other swaps left of them in the
   * current window on Robinhood Chain, where waiting about 12 seconds can clear it), the minimum-loan rule on a partial (the quote plus the slippage must leave at least `minimumLoan`), an explicit
   * `minPairOut` above the quote ("Min out") and the balance; approves `tokenIn` to the swap.
   * Returns the conversion figures and the outcome.
   */
  async repayLeverageWith(main: MainRef, loanId: bigint, tokenIn: Address, opts: RepayLeverageWithOptions | null = {}): Promise<RepayLeverageWithResult> {
    const o = optsOf(opts, REPAY_LEVERAGE_WITH_KEYS);
    const id = toUint(loanId, 'loanId');
    const explicit = optUint(o.minPairOut, 'minPairOut');
    const optDeadline = optUint(o.deadline, 'deadline');
    const closeOpt = o.close == null ? undefined : toBool(o.close, 'close');
    if (o.bufferBps != null) validateSlippageBps(o.bufferBps, 'bufferBps');
    if (o.slippageBps != null) validateSlippageBps(o.slippageBps);
    tokenIn = toAddress(tokenIn, 'tokenIn');
    const info = await this.client.mains.get(main);
    const me = this.account;
    const deadline = await this.sendDeadline(optDeadline);
    const pos = await readCoreLoan(this.client, info.main, me, id, true);
    if (!pos.active) throw new ValidationError('Loan not active', `Leverage ${id} is not active.`);
    const sizing = o.amountIn == null;
    const route = await this.repayWithRoute(info, tokenIn);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'the position cannot be repaid in it now');
    const q = await this.repayWithQuote(info, id, pos, tokenIn, o.amountIn, o.bufferBps, route);
    const close = closeOpt ?? sizing;
    if (close && !q.covers) {
      throw new ValidationError('Not enough to close', `${q.amountIn} of ${tokenIn} converts to ${q.pairOut}, under the ${q.debt} debt.`);
    }
    if (!q.covers) {
      const p = await this.repayPreview(info.main, id, pos, q.pairOut);
      const high = eq(tokenIn, info.pairAsset) ? q.pairOut : maxWithSlippage(q.pairOut, o.slippageBps ?? this.client.slippageBps.trade);
      if (!p.allowed || high > p.maxPartial) {
        throw new ValidationError('Repay in full', `${q.amountIn} of ${tokenIn} converts to ${q.pairOut} (up to ${high} after slippage), which could leave under the minimum loan ${p.minimumLoan} of the ${p.debt} debt: repay at most ${p.maxPartial} worth (less the slippage), or everything.`);
      }
    }
    let minPairOut = await this.resolveMin(explicit, o.slippageBps, async () => q.pairOut, 'trade', 'minPairOut');
    checkExplicitMin(explicit, q.pairOut, 'minPairOut', `what ${q.amountIn} of ${tokenIn} converts to`);
    if (explicit == null && (close || q.covers) && minPairOut < q.debt) minPairOut = q.debt;
    await this.checkBalance(tokenIn, q.amountIn);
    const [fIn, col] = await Promise.all([amountOf(this.client, tokenIn, info), amountOf(this.client, pos.token, info)]);
    const pair = pairAmountOf(info);
    await this.ensureAllowance(tokenIn, this.swap, q.amountIn);
    const tx = await this.send({
      address: this.swap, abi: SwapAbi, functionName: 'repayWith',
      args: [info.main, id, tokenIn, q.amountIn, minPairOut, close, deadline], contract: 'Swap',
    });
    const ev = this.firstEvent(tx, SwapAbi, 'RepaidWith', this.swap, 'Swap', ['amountIn', 'pairOut', 'refund'],
      (e) => eq(e.owner, me) && e.loanId === id);
    const res = this.repayOutcome(tx, info, id, pos, col, ['closed', 'debtLeft', 'collateralReleased']);
    return { ...tx, ...res.outcome, amountIn: optAmount(fIn, ev?.amountIn), pairOut: optAmount(pair, ev?.pairOut), refund: optAmount(pair, ev?.refund) };
  }

  /**
   * Preview `repayLeverageWith(main, loanId, tokenIn, { amountIn })` for `user` (default the signer). Without `amountIn`:
   * the `tokenIn` that repays the whole debt (the least amount quoting it, plus `bufferBps`, default 0.5%, trimmed to
   * the route's `maxIn` / `maxOut` caps, or to what other swaps left of them in the current window on Robinhood Chain).
   * Quoted on the hop executor trading uses. Checks the route ("no executor" / "no route"; a debt, or an explicit
   * `amountIn`, over the caps or over what is left of them now: "above cap").
   */
  async quoteRepayLeverageWith(
    main: MainRef, loanId: bigint, tokenIn: Address, opts: QuoteRepayLeverageWithOptions | null = {},
  ): Promise<LeverageRepayWithQuote> {
    const o = optsOf(opts, QUOTE_REPAY_LEVERAGE_WITH_KEYS);
    const id = toUint(loanId, 'loanId');
    if (o.bufferBps != null) validateSlippageBps(o.bufferBps, 'bufferBps');
    tokenIn = toAddress(tokenIn, 'tokenIn');
    const given = o.user == null ? undefined : toAddress(o.user, 'user');
    const info = await this.client.mains.get(main);
    const pos = await readCoreLoan(this.client, info.main, given ?? this.account, id, true);
    if (!pos.active) throw new ValidationError('Loan not active', `Leverage ${id} is not active.`);
    return this.repayWithQuote(info, id, pos, tokenIn, o.amountIn, o.bufferBps);
  }

  /**
   * Preview `extendLeverage(main, loanId, numberOfDays, payInPairAsset, refinance)` for `user` (default the signer):
   * whether it goes through, its fee and a refinance's payout. Fee / extraOut raw pair asset. Both flags are never
   * possible: extendLeverage refuses them. On a paused pair (extendLeverage refuses "unknown pair"), or while the issuer
   * of the pair asset has paused it ('pair asset paused'), `possible` is false; the figures stay.
   */
  async getLeverageExtensionQuote(
    main: MainRef, loanId: bigint, numberOfDays: bigint | number, payInPairAsset: boolean, refinance: boolean, user?: Address | null,
  ): Promise<LeverageExtensionQuote> {
    const args = [
      user == null ? this.account : toAddress(user, 'user'), toUint(loanId, 'loanId'), toUint(numberOfDays, 'numberOfDays'), true,
      toBool(payInPairAsset, 'payInPairAsset'), toBool(refinance, 'refinance'),
    ] as const;
    if (args[4] && args[5]) return { possible: false, fee: 0n, extraOut: 0n };
    const mainAddr = this.client.mains.addressOf(main);
    const q = await this.leverageExtensionQuote(mainAddr, args);
    const possible = q.possible && !(await isAssetPaused(this.client, (await this.client.mains.get(mainAddr)).pairAsset));
    return { ...q, possible };
  }

  /**
   * The extension preview on `mainAddr` (checked arguments), `possible` false on a paused pair. The issuer pause is not
   * read: `getLeverageExtensionQuote` adds it, `extendLeverage` refuses it first.
   */
  private async leverageExtensionQuote(
    mainAddr: Address, args: readonly [Address, bigint, bigint, boolean, boolean, boolean],
  ): Promise<LeverageExtensionQuote> {
    const [[possible, fee, extraOut], paused] = await Promise.all([
      this.publicClient.readContract({ address: mainAddr, abi: MainTokenAbi, functionName: 'extensionEligibility', args }),
      this.pausedMains([mainAddr]),
    ]);
    return { possible: possible && paused.length === 0, fee, extraOut };
  }

  /**
   * Claim the tokens left over after the signer's leverage position was liquidated. A leftover still unclaimed 365 days
   * after the liquidation can be taken. Returns `claimed` (an `Amount` in the collateral token; null when the event is
   * missing).
   */
  async claimLeverageLiquidation(main: MainRef, loanId: bigint): Promise<ClaimLeverageLiquidationResult> {
    const id = toUint(loanId, 'loanId');
    const mainAddr = this.client.mains.addressOf(main);
    const me = this.account;
    const pos = await readCoreLoan(this.client, mainAddr, me, id, true);
    if (pos.active) throw new ValidationError('Loan is still active', `Leverage ${id} is still active.`);
    if (pos.liquidationClaim === 0n) throw new ValidationError('Nothing to claim', `Nothing to claim on leverage ${id}.`);
    const col = await amountOf(this.client, pos.token);
    const tx = await this.send({
      address: mainAddr, abi: MainTokenAbi, functionName: 'claimLiquidation', args: [id, true], contract: 'MainToken',
    });
    const ev = this.firstEvent(tx, MainTokenAbi, 'LiquidationClaimed', mainAddr, 'MainToken', ['claimed'],
      (e) => eq(e.user, me) && e.loanId === id && e.isLeverage);
    return { ...tx, claimed: optAmount(col, ev?.amount) };
  }

  /** Number of leverage positions `user` (default the signer) opened on `main` (default the default main). Ids run 1..count. */
  async getLeverageCount(main?: MainRef | null, user?: Address | null): Promise<bigint> {
    const who = user == null ? undefined : toAddress(user, 'user');
    const addr = main == null ? this.client.mains.defaultAddress() : this.client.mains.addressOf(main);
    return this.publicClient.readContract({ address: addr, abi: MainTokenAbi, functionName: 'leverageCount', args: [who ?? this.account] });
  }

  /** Leverage position `loanId` of `user` on `main`. */
  async getLeveragePosition(main: MainRef, user: Address, loanId: bigint): Promise<CoreLoan> {
    const who = toAddress(user, 'user');
    return readCoreLoan(this.client, this.client.mains.addressOf(main), who, toUint(loanId, 'loanId'), true);
  }


  private async tokenMain(token: Address): Promise<{ info: MainInfo; isMain: boolean }> {
    const main = await this.client.mains.mainOf(token);
    const info = await this.client.mains.get(main);
    return { info, isMain: eq(main, token) };
  }

  /** How the router sees a token: a main, a factory token (its main and pair asset), or an asset. Checksummed. */
  private async routeToken(token: Address): Promise<RouteToken> {
    token = getAddress(token);
    if (await this.client.mains.isMain(token)) {
      const info = await this.client.mains.get(token);
      return { address: token, kind: 'main', main: info.main, pair: info.pairAsset };
    }
    if (await this.client.factory.isEcosystemToken(token)) {
      const main = await this.publicClient.readContract({ address: token, abi: EcosystemTokenAbi, functionName: 'quoteToken' });
      if (!(await this.client.mains.isMain(main))) return { address: token, kind: 'token', main: null, pair: null };
      return { address: token, kind: 'token', main, pair: (await this.client.mains.get(main)).pairAsset };
    }
    return { address: token, kind: 'pair', main: null, pair: null };
  }

  /**
   * Formatters for a `swapCross` result, resolved before sending: `path[0]`, the last token, the sell side's unit (the
   * token after its last sell step: the main or its pair asset) and the buy side's (the token before its first buy
   * step). A side the route does not have is formatted in `path[0]` (sell) / the last token (buy); its figures are 0.
   * `rewards`: the pair asset of `path[0]`'s main when the route sells that factory token (its holder rewards are paid
   * out by the sale), else null. `a` / `b`: how the router sees `path[0]` / the last token (`routeToken`).
   */
  private async crossFormats(
    path: readonly Address[], a: RouteToken, b: RouteToken,
  ): Promise<{ in: AmountOf; out: AmountOf; sell: AmountOf; buy: AmountOf; rewards: AmountOf | null }> {
    const n = path.length - 1;
    let sellUnit = path[0];
    const sellsToken = a.kind === 'token' && !!a.main && eq(path[1], a.main);
    if (sellsToken) sellUnit = n >= 2 && a.pair && eq(path[2], a.pair) ? path[2] : path[1];
    else if (a.kind === 'main' && a.pair && eq(path[1], a.pair)) sellUnit = path[1];
    let buyUnit = path[n];
    if (b.kind === 'token' && b.main && eq(path[n - 1], b.main)) buyUnit = n >= 2 && b.pair && eq(path[n - 2], b.pair) ? path[n - 2] : path[n - 1];
    else if (b.kind === 'main' && b.pair && eq(path[n - 1], b.pair)) buyUnit = path[n - 1];
    const [fIn, fOut, fSell, fBuy] = await Promise.all([path[0], path[n], sellUnit, buyUnit].map((t) => amountOf(this.client, t)));
    const rewards = sellsToken ? pairAmountOf(await this.client.mains.get(a.main!)) : null;
    return { in: fIn, out: fOut, sell: fSell, buy: fBuy, rewards };
  }

  /**
   * The holder rewards `token` paid the signer in `tx` (from its own logs: a sale of a factory token pays the seller's
   * pending rewards first), formatted by `fmt` (its main's pair asset). 0 when none were owed: the token then emits
   * nothing, so no missing-event warning. Never throws: the tx is confirmed.
   */
  private rewardsPaid(tx: TxResult, token: Address, fmt: AmountOf): Amount {
    const me = this.account;
    return fmt(this.events(tx, FactoryTokenAbi, 'RewardsClaimed', token)
      .filter((e) => eq(e.investor, me))
      .reduce((sum, e) => sum + e.claimableNow, 0n));
  }

  /**
   * The deadline to send (unix seconds, chain time): `explicit`, refused ("Deadline") when it is before the latest block
   * time (`checkDeadline`), else the latest block time + 600 s.
   */
  private async sendDeadline(explicit: bigint | null | undefined): Promise<bigint> {
    const now = (await this.preSendRead(() => this.publicClient.getBlock())).timestamp;
    return explicit == null ? now + 600n : checkDeadline(explicit, now);
  }

  /** `quoteHop` on the hop executor trading uses (an eth_call), net of the hop fee. */
  private async simulateHop(exec: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    try {
      const { result } = await this.publicClient.simulateContract({
        address: exec, abi: HopExecutorAbi, functionName: 'quoteHop', args: [tokenIn, tokenOut, amountIn], account: this.client.account,
      });
      return result;
    } catch (e) {
      throw decodeRevert(e, { contract: 'HopExecutor', functionName: 'quoteHop', abi: HopExecutorAbi });
    }
  }

  /**
   * The tokens of `tokens` that are mains with their pair paused, read live. Trading then treats such a main as an
   * outside token ("unknown pair", "Not main", "no BASIS leg").
   */
  private async pausedMains(tokens: readonly Address[]): Promise<Address[]> {
    const pairs = await Promise.all(tokens.map((t) => this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairs', args: [t] })));
    return tokens.filter((_, i) => !isZeroAddress(pairs[i][0]) && !pairs[i][2]);
  }

  /** Refuses a route through a paused main ("unknown pair"). */
  private async checkPairsActive(tokens: readonly Address[]): Promise<void> {
    const paused = await this.pausedMains(tokens);
    if (paused.length) throw pausedError(paused[0]);
  }

  /**
   * A plain buy / sell path, from the pause check's reads (no other read): a paused main first ("unknown pair"), then
   * the path's direction (`plainPathError`). Returns each token's pair row (`[pairAsset, staking, active]`; a zero pair
   * asset for a token that is not a main).
   */
  private async checkPlainRoute(fn: 'buyTokens' | 'sellTokens', path: readonly Address[]): Promise<(readonly [Address, Address, boolean])[]> {
    const pairs = await Promise.all(path.map((t) => this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairs', args: [t] })));
    const paused = path.find((_, i) => !isZeroAddress(pairs[i][0]) && !pairs[i][2]);
    if (paused) throw pausedError(paused);
    const err = plainPathError(fn, path, pairs.map((p) => (p[2] ? p[0] : null)));
    if (err) throw err;
    return pairs;
  }

  /**
   * 'pair asset paused' for a trade on the main `main` while the issuer of its pair asset `asset` has paused it, before
   * any approval. `moves` null: the trade moves the asset itself (it is on the path: paid in, paid out, or swapped on an
   * outside hop; `TRADE_PAUSED`). Otherwise the trade stays between the main and factory tokens on it, and the asset
   * moves only as a fee (`moves.fees`: refused, `TRADE_PAUSED`, when one is above 0 for the signer) or as the signer's
   * pending holder rewards on the factory token it sells (`moves.sold`: a sale pays them out in the pair asset, fee or
   * not; refused, `rewardsPaused`, when the signer has rewards to claim). All read only while the asset is paused, in
   * that order, and only until one refuses.
   */
  private async refusePausedTrade(main: Address, asset: Address, moves: PausedMoves | null): Promise<void> {
    if (!(await isAssetPaused(this.client, asset))) return;
    const refuse = async (effect: string) => pairAssetPaused(asset, (await this.client.mains.get(main)).pairSymbol, effect);
    if (moves === null) throw await refuse(TRADE_PAUSED);
    for (const rate of moves.fees) {
      if ((await rate()) > 0) throw await refuse(TRADE_PAUSED);
    }
    if (moves.sold !== null && (await this.claimableRewards(moves.sold, this.account)) > 0n) throw await refuse(rewardsPaused(moves.sold));
  }

  /**
   * `refusePausedTrade` for a plain path, from `checkPlainRoute`'s rows (`pairs`): the path trades on one main. Off the
   * path, the asset moves only on a trade between the main and a factory token on it: as its fee (the signer's fee
   * rate on the token), or, on a sale of the token (`[token, main]`), as the signer's holder rewards.
   */
  private async refusePausedPlain(path: readonly Address[], pairs: readonly (readonly [Address, Address, boolean])[]): Promise<void> {
    const i = pairs.findIndex((row) => !isZeroAddress(row[0]));
    if (i < 0) return;
    const asset = pairs[i][0];
    const token = path.find((_, j) => j !== i);
    if (path.some((t) => eq(t, asset)) || token === undefined) return this.refusePausedTrade(path[i], asset, null);
    const me = this.account;
    return this.refusePausedTrade(path[i], asset, { fees: [() => this.client.taxes.getTaxRate(token, me)], sold: i > 0 ? token : null });
  }

  /**
   * `refusePausedTrade` for each main a cross route trades on (`rt`: how the router sees each token of `path`; the
   * route's steps already checked, `checkCrossPlan`). Off the path, a main's pair asset moves only as the fee of a side
   * on that main (`crossSides`: each side's own fee rate for the signer) or as the signer's holder rewards on the
   * factory token the route sells on it. A main traded only on the outside exchange moves nothing of its pair asset
   * (the outside exchange's own route aside).
   */
  private async refusePausedCross(path: readonly Address[], rt: readonly RouteToken[]): Promise<void> {
    const { sell, buy, split } = crossSides(path, rt);
    const me = this.account;
    const taxes = this.client.taxes;
    const rateOf = (token: Address, side: 'sell' | 'buy') => async (): Promise<number> => {
      if (!split) return side === 'buy' && sell !== null ? taxes.getTaxRateBase(token, me, 0) : taxes.getTaxRate(token, me);
      const base = await taxes.getBaseRate();
      const half = Math.floor(base / 2);
      return taxes.getTaxRateBase(token, me, side === 'sell' ? half : base - half);
    };
    const done = new Set<string>();
    for (const t of rt) {
      if (!t.main || !t.pair || done.has(t.main.toLowerCase())) continue;
      done.add(t.main.toLowerCase());
      const asset = t.pair;
      const main = t.main;
      if (path.some((x) => eq(x, asset))) {
        await this.refusePausedTrade(main, asset, null);
        continue;
      }
      const sellSide = sell !== null && eq(sell.main, main) ? sell : null;
      const buySide = buy !== null && eq(buy.main, main) ? buy : null;
      const fees: (() => Promise<number>)[] = [];
      if (sellSide) fees.push(rateOf(sellSide.token ?? main, 'sell'));
      if (buySide) fees.push(rateOf(buySide.token ?? main, 'buy'));
      await this.refusePausedTrade(main, asset, { fees, sold: sellSide?.token ?? null });
    }
  }

  /** The holder rewards (raw pair asset) a sale of the factory token `token` pays `user` now. */
  private claimableRewards(token: Address, user: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getClaimableRewards', args: [user] });
  }

  /**
   * The minimum of a buy of the main `info` staked in its vault `staking` (`buyAndStake`, `buyTokens` with
   * `wrapTokens`): the vault stakes at least its `minStake`, so a quote under it is refused ("Below min stake"), an
   * explicit minimum above the quote too ("Min out"), and the minimum sent (explicit or derived) is raised to
   * `minStake`, so the slippage guard covers the stake too.
   */
  private async stakeMin(
    info: MainInfo, staking: Address, path: readonly Address[], amount: bigint, explicit: bigint | undefined, slippageBps: number | null | undefined,
  ): Promise<bigint> {
    if (slippageBps != null) validateSlippageBps(slippageBps);
    const [quoted, minStake] = await Promise.all([
      this.quote(path, amount),
      this.publicClient.readContract({ address: staking, abi: VaultAbi, functionName: 'minStake' }),
    ]);
    if (quoted < minStake) {
      throw new ValidationError('Below min stake', `${amount} raw ${info.pairSymbol} buys ${quoted} raw ${info.symbol}, under the vault's minimum stake ${minStake}: buy more.`);
    }
    const min = await this.resolveMin(explicit, slippageBps, async () => quoted);
    checkExplicitMin(explicit, quoted, 'minOut', 'what this buy stakes');
    return min < minStake ? minStake : min;
  }

  /**
   * The minimum of a plain trade or a cross swap, from the on-chain quote `quote` (exact in the current state), read
   * with an explicit minimum too (one eth_call): the trade's run-time refusals ("autovest presale", "Trading is not
   * enabled", "No WL for freeze", "Overcapped on WL buying", ...) then come from the quote, before any approval, and an explicit
   * minimum above it is refused ("Min out", `what` names the output). Explicit: as given (never 0, refused before the
   * read); omitted: the quote minus the slippage.
   */
  private async tradeMin(
    explicit: bigint | undefined, slippageBps: number | null | undefined, quote: () => Promise<bigint>, what: string,
  ): Promise<bigint> {
    if (slippageBps != null) validateSlippageBps(slippageBps);
    if (explicit != null) await this.resolveMin(explicit, slippageBps, async () => 0n);
    const quoted = await this.preSendRead(quote);
    checkExplicitMin(explicit, quoted, 'minOut', what);
    return this.resolveMin(explicit, slippageBps, async () => quoted);
  }

  /**
   * Checks, approves, sends a plain trade and decodes its figures (trader = the signer). A buy of an auto-vest token in
   * presale (read before sending) also expects the signer's new vesting.
   */
  private async sendTrade(fn: 'buyTokens' | 'sellTokens', amount: bigint, min: bigint, path: readonly Address[], wrap: boolean): Promise<TradeResult> {
    const me = this.account;
    const out = path[path.length - 1];
    let vest: { gradual: boolean; days: bigint; vesting: Address } | null = null;
    if (fn === 'buyTokens' && !(await this.client.mains.isMain(out))) {
      const c = { address: out, abi: FactoryTokenAbi } as const;
      const [autoVest, presaleComplete] = await Promise.all([
        this.publicClient.readContract({ ...c, functionName: 'autoVest' }),
        this.publicClient.readContract({ ...c, functionName: 'presaleComplete' }),
      ]);
      if (autoVest && !presaleComplete) {
        const [gradual, days, vesting] = await Promise.all([
          this.publicClient.readContract({ ...c, functionName: 'gradualAutoVesting' }),
          this.publicClient.readContract({ ...c, functionName: 'autoVestDuration' }),
          this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'vesting' }),
        ]);
        vest = { gradual, days, vesting };
      }
    }
    let rewardsOf: AmountOf | null = null;
    if (fn === 'sellTokens') {
      const [sellsMain, nextIsMain] = await Promise.all([this.client.mains.isMain(path[0]), this.client.mains.isMain(path[1])]);
      if (!sellsMain && nextIsMain) rewardsOf = pairAmountOf(await this.client.mains.get(path[1]));
    }
    await this.checkBalance(path[0], amount);
    const [fIn, fOut] = await Promise.all([amountOf(this.client, path[0]), amountOf(this.client, out)]);
    await this.ensureAllowance(path[0], this.swap, amount);
    const tx = fn === 'buyTokens'
      ? await this.send({ address: this.swap, abi: SwapAbi, functionName: 'buyTokens', args: [amount, min, path, wrap], contract: 'Swap' })
      : await this.send({ address: this.swap, abi: SwapAbi, functionName: 'sellTokens', args: [amount, min, path, false], contract: 'Swap' });
    const ev = this.firstEvent(tx, SwapAbi, 'Traded', this.swap, 'Swap', ['amountIn', 'amountOut', 'tax'], (e) => eq(e.trader, me));
    let autoVested: AutoVested | null = null;
    if (vest) {
      const vc = this.firstEvent(tx, VestingAbi, 'VestingCreated', vest.vesting, 'Vesting', ['autoVested'], (e) => eq(e.beneficiary, me) && eq(e.token, out));
      if (vc) {
        let endsAt: bigint | null = null;
        try {
          endsAt = (await this.publicClient.getBlock({ blockNumber: tx.receipt.blockNumber })).timestamp + vest.days * 86_400n;
        } catch (e) {
          const msg = `Block ${tx.receipt.blockNumber} of ${tx.hash} could not be read (${errorText(e)}): autoVested.endsAt is null. The transaction is confirmed: do not resend it.`;
          tx.warnings.push(msg);
          console.warn(`[basis-sdk] ${msg}`);
        }
        autoVested = { vestingId: vc.vestingId, amount: fOut(vc.totalAmount), gradual: vest.gradual, endsAt };
      }
    }
    return {
      ...tx, amountIn: optAmount(fIn, ev?.amountIn), amountOut: optAmount(fOut, ev?.amountOut),
      tax: optAmount(fn === 'buyTokens' ? fIn : fOut, ev?.tax), autoVested,
      rewardsClaimed: rewardsOf ? this.rewardsPaid(tx, path[0], rewardsOf) : null,
    };
  }

  /**
   * The first `eventName` log of `tx` emitted by `address` that `match`es, decoded; or null with a missing-event
   * warning naming `fields` (the result fields left null). Never throws: the tx is confirmed.
   */
  private firstEvent<const A extends Abi, N extends ContractEventName<A>>(
    tx: TxResult, abi: A, eventName: N, address: Address, contract: string, fields: readonly string[],
    match: (e: EventArgs<A, N>) => boolean = () => true,
  ): EventArgs<A, N> | null {
    const ev = this.events(tx, abi, eventName, address).find(match);
    if (ev) return ev;
    addMissingEventWarning(tx, contract, eventName as string, fields);
    return null;
  }

  /**
   * How a repay of leverage `loanId` on `main` ended: a partial repay's figures, or a full repay (the debt and
   * collateral `pos` held, all taken and sent back). Neither: nulls and a warning naming `fields`. `amount` = the pair
   * asset taken.
   */
  private repayOutcome(
    tx: TxResult, info: MainInfo, loanId: bigint, pos: CoreLoan, col: AmountOf, fields: readonly string[],
  ): { outcome: RepayOutcome; amount: Amount | null } {
    const me = this.account;
    const main = info.main;
    const pair = pairAmountOf(info);
    const part = this.events(tx, MainTokenAbi, 'LoanPartlyRepaid', main).find((e) => eq(e.user, me) && e.loanId === loanId && e.isLeverage);
    if (part) return { outcome: { closed: false, debtLeft: pair(part.fullAmountLeft), collateralReleased: col(part.collateralReleased) }, amount: pair(part.amount) };
    const full = this.events(tx, MainTokenAbi, 'LoanRepaid', main).find((e) => eq(e.user, me) && e.loanId === loanId);
    if (full) return { outcome: { closed: true, debtLeft: pair(0n), collateralReleased: col(pos.collateralAmount) }, amount: pair(pos.fullAmount) };
    addMissingEventWarning(tx, 'MainToken', 'LoanPartlyRepaid / LoanRepaid', fields);
    return { outcome: { closed: null, debtLeft: null, collateralReleased: null }, amount: null };
  }

  private checkPlainPath(path: readonly Address[]): void {
    if (path.length !== 2 && path.length !== 3) throw new ValidationError('Bad path', `buyTokens/sellTokens take a path of 2 or 3 tokens, got ${path.length} (use swapCross for longer routes).`);
  }

  private async checkBalance(token: Address, amount: bigint): Promise<void> {
    const bal = await this.balanceOf(token);
    if (bal < amount) throw new ValidationError('balance', `Balance of ${token} is ${bal}, below the ${amount} needed.`);
  }

  /** The open leverage position `id` of `who` on `main`: "Not user" for a position that is not theirs, "Loan not active" for a closed one. */
  private async sellablePosition(main: Address, who: Address, id: bigint): Promise<CoreLoan> {
    const pos = await readCoreLoan(this.client, main, who, id, true);
    if (!eq(pos.user, who)) {
      throw new ValidationError('Not user', `No leverage position ${id} of ${who} on main ${main} (hub loans are sold through loans.partialSellLoan).`);
    }
    if (!pos.active) throw new ValidationError('Loan not active', `Position ${id} is not active.`);
    return pos;
  }

  /** The main's day range check for a new position ("incorrect loan duration"), or null when `days` is in range. */
  private async daysError(main: Address, days: bigint): Promise<ValidationError | null> {
    const [minD, maxD] = await Promise.all([
      this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'minDaysLoan' }),
      this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'maxDaysLoan' }),
    ]);
    return days < minD || days > maxD ? new ValidationError('incorrect loan duration', `Days must be ${minD}-${maxD} on this main, got ${days}.`) : null;
  }

  /**
   * Leverage path from a token or an explicit path, refused in order: at least 2 tokens with path[1] a main (paused or
   * not) and path[0] its pair asset ("wrong path"), then a paused main ("unknown pair"), then 2 or 3 tokens and a listed
   * factory token at path[2] (a delisted token cannot be leveraged) trading against that main ("wrong path").
   */
  private async leveragePath(target: Address | readonly Address[]): Promise<Address[]> {
    let path: Address[];
    if (typeof target === 'string') {
      path = await this.buildBuyPath(target, 'pairAsset');
    } else {
      if (Array.isArray(target) && target.length < 2) {
        throw new ValidationError('wrong path', `A leverage path has 2 or 3 tokens, got ${target.length}.`);
      }
      path = toPath(target as readonly Address[]);
      if (!(await this.client.mains.isMain(path[1]))) throw new ValidationError('wrong path', `path[1] (${path[1]}) is not a main.`);
      const info = await this.client.mains.get(path[1]);
      if (!eq(path[0], info.pairAsset)) throw new ValidationError('wrong path', `path[0] must be the main's pair asset ${info.pairAsset}.`);
    }
    await this.checkPairsActive([path[1]]);
    if (path.length !== 2 && path.length !== 3) {
      throw new ValidationError('wrong path', `A leverage path has 2 or 3 tokens, got ${path.length}.`);
    }
    if (path.length === 3) {
      if (!(await this.client.factory.isEcosystemToken(path[2]))) {
        throw new ValidationError('wrong path', `${path[2]} is not a listed factory token: leverage is open on listed tokens only.`);
      }
      if (typeof target !== 'string') {
        const q = await this.publicClient.readContract({ address: path[2], abi: EcosystemTokenAbi, functionName: 'quoteToken' });
        if (!eq(q, path[1])) throw new ValidationError('wrong path', `${path[2]} does not trade against main ${path[1]}.`);
      }
    }
    return path;
  }

  /**
   * Why `leverageBuy` / `mixedBuy` would refuse the buy quoted in `q` for `who` now (`LeverageQuote.blocked`), in order,
   * each as the refusal the write throws: for a factory token, auto-vest needs a finished presale ("In presale"), a
   * frozen token needs `who` on the whitelist ("No WL for freeze") and room under its presale cap for the position's
   * collateral ("WL cap"); then "Under 2x" (under 2x leverage), the main's own trading gate ("Trading is not enabled",
   * read live) and the issuer pause of the pair asset the buy is paid in, `path[0]` ("pair asset paused"). The days
   * range is `quoteOn`'s.
   */
  private async leverageBlocks(path: readonly Address[], q: Pick<LeverageQuote, 'sim' | 'spot'>, who: Address): Promise<ValidationError[]> {
    const collateral = q.sim.totalCollateral;
    const [factory, enabled, assetPaused] = await Promise.all([
      path.length === 3 ? this.factoryLeverageBlocks(path[2], collateral, who) : Promise.resolve<ValidationError[]>([]),
      this.publicClient.readContract({ address: path[1], abi: MainTokenAbi, functionName: 'tradingEnabled' }),
      isAssetPaused(this.client, path[0]),
    ]);
    const out = [...factory];
    if (!(q.spot * 2n < collateral)) {
      out.push(new ValidationError('Under 2x', `This leverage would be under 2x (collateral ${collateral} vs spot ${q.spot}); try more days, a higher leverage % or a different amount.`));
    }
    if (!enabled) out.push(new ValidationError('Trading is not enabled', `Trading on main ${path[1]} has not opened yet: no leverage until it does.`));
    if (assetPaused) out.push(pairAssetPaused(path[0], (await this.client.mains.get(path[1])).pairSymbol, 'no leverage buy can be paid in it'));
    return out;
  }

  /** The factory token's part of `leverageBlocks`: "In presale", then "No WL for freeze" or "WL cap" (frozen token). */
  private async factoryLeverageBlocks(token: Address, collateral: bigint, who: Address): Promise<ValidationError[]> {
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [autoVest, presaleComplete, frozen] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'autoVest' }),
      this.publicClient.readContract({ ...c, functionName: 'presaleComplete' }),
      this.publicClient.readContract({ ...c, functionName: 'frozen' }),
    ]);
    const out: ValidationError[] = [];
    if (autoVest && !presaleComplete) out.push(new ValidationError('In presale', 'Leverage on an auto-vest token needs its presale to be complete.'));
    if (!frozen) return out;
    const wl = await this.client.factory.getWhitelistStatus(token, who);
    if (!wl.whitelisted) out.push(new ValidationError('No WL for freeze', 'This token is frozen and the wallet is not whitelisted.'));
    else if (wl.bought + collateral > wl.maxBuy) {
      out.push(new ValidationError('WL cap', `This position takes ${collateral} tokens, over what is left of the wallet's presale cap (${wl.remaining} of ${wl.maxBuy}): use a smaller amount.`));
    }
    return out;
  }

  /**
   * Quote on a checked path. The term: with an open position on the token, its days left (at least the main's minimum,
   * else "Extend first"); otherwise the asked days. A new position's day range is checked last, so its refusal comes
   * back as `daysError` for the caller to throw in that order (and in place of a simulation that fails on out-of-range
   * days). The simulation is priced for `user`, as the open is: without one, the zero address (the list rate).
   */
  private async quoteOn(path: Address[], amount: bigint, asked: bigint, pct: number, user: Address | undefined): Promise<{ q: Omit<LeverageQuote, 'blocked'>; daysError: ValidationError | null }> {
    const main = path[1];
    const open = user ? await this.getOpenLeverage(main, path[path.length - 1], user) : null;
    let days = asked;
    let daysError: ValidationError | null = null;
    if (open) {
      const minD = await this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'minDaysLoan' });
      if (open.daysLeft < minD) {
        throw new ValidationError('Extend first', `The open position ${open.loanId} on this token has ${open.daysLeft} days left, under the minimum ${minD}: extend it before adding to it.`);
      }
      days = open.daysLeft;
    } else {
      daysError = await this.daysError(main, asked);
    }
    const trader = user ?? ZERO_ADDRESS;
    let sim: LeverageEndResult;
    let spot: bigint;
    let taxBps: number;
    try {
      [sim, spot, taxBps] = await Promise.all([
        this.client.leverageSimulator.simulate(amount, path, days, pct, trader),
        this.getAmountsOut(amount, path),
        this.client.taxes.getTaxRate(path[path.length - 1], trader),
      ]);
    } catch (e) {
      throw daysError ?? e;
    }
    return { q: { path, leveragePct: pct, days, openLoanId: open?.loanId ?? 0n, trader, taxBps, sim, spot }, daysError };
  }

  private async repayPreview(main: Address, loanId: bigint, pos: CoreLoan, amount: bigint): Promise<LeverageRepayPreview> {
    const minimumLoan = await this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'minimumLoan' });
    const debt = pos.fullAmount;
    const full = amount >= debt;
    const pay = full ? debt : amount;
    const released = full ? pos.collateralAmount : debt === 0n ? 0n : (pos.collateralAmount * pay) / debt;
    return {
      loanId, debt, minimumLoan,
      maxPartial: debt > minimumLoan ? debt - minimumLoan : 0n,
      amount: pay, full, active: pos.active,
      allowed: pos.active && pay > 0n && (full || debt - pay >= minimumLoan),
      collateralReleased: released, collateralLeft: pos.collateralAmount - released, debtLeft: debt - pay,
    };
  }

  /**
   * How `tokenIn` converts to the pair asset of `info` on the hop executor trading uses: itself (`direct`), or
   * `quoteHop` on the executor, route checked ("no executor", "no route").
   */
  private async repayWithRoute(info: MainInfo, tokenIn: Address): Promise<LeverageRepayRoute> {
    const asset = info.pairAsset;
    if (eq(tokenIn, asset)) return { direct: true, exec: null, quote: async (x) => x };
    const exec = await this.getHopExecutor();
    if (isZeroAddress(exec)) throw new ValidationError('no executor', `SWAP has no outside-route executor: repay in ${asset}.`);
    const route = await this.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'getRoute', args: [tokenIn, asset] });
    if (route.length === 0) throw new ValidationError('no route', `No outside route from ${tokenIn} to ${asset}: repay in ${asset} or another token.`);
    return { direct: false, exec, quote: (x) => this.simulateHop(exec, tokenIn, asset, x) };
  }

  /** Repay-with quote on the hop executor trading uses; `route` from `repayWithRoute` (read when not given). */
  private async repayWithQuote(
    info: MainInfo, loanId: bigint, pos: CoreLoan, tokenIn: Address, amountIn: bigint | null | undefined, bufferBps?: number | null,
    route?: LeverageRepayRoute,
  ): Promise<LeverageRepayWithQuote> {
    const asset = info.pairAsset;
    const debt = pos.fullAmount;
    const { direct, exec, quote } = route ?? await this.repayWithRoute(info, tokenIn);
    let x: bigint;
    let pairOut: bigint;
    if (amountIn != null) {
      x = toUint(amountIn, 'amountIn');
      if (x === 0n) throw new ValidationError('Zero amount', 'amountIn must be greater than 0.');
      pairOut = direct ? x : await quoteHopWithinCaps(this.client, exec!, tokenIn, asset, x, quote);
    } else {
      x = direct ? debt : await this.sizeFor(exec!, tokenIn, asset, debt, quote, bufferBps ?? REPAY_LEVERAGE_WITH_BUFFER_BPS);
      pairOut = await quote(x);
    }
    const covers = pairOut >= debt;
    const released = covers ? pos.collateralAmount : debt === 0n ? 0n : (pos.collateralAmount * pairOut) / debt;
    return {
      loanId, tokenIn, pairAsset: asset, debt, amountIn: x, pairOut, covers,
      refund: covers ? pairOut - debt : 0n, collateralReleased: released,
    };
  }

  /**
   * `tokenIn` to send for `target` of `asset`: the least amount quoting it, plus `bufferBps`, within what `exec`'s route
   * takes now (on Robinhood Chain, what other swaps left of its caps in the current window).
   */
  private async sizeFor(exec: Address, tokenIn: Address, asset: Address, target: bigint, quote: (x: bigint) => Promise<bigint>, bufferBps: number): Promise<bigint> {
    return sizeRepayWith(quote, target, { ...(await readRepaySizing(this.client, exec, tokenIn, asset)), bufferBps });
  }
}

/**
 * The route between two classified tokens, with its sell and buy steps; null when none exists. Hop order: sell token,
 * sell main, outside, buy main, buy token.
 */
function planRoute(a: RouteToken, b: RouteToken): PlannedRoute | null {
  if (eq(a.address, b.address)) return null;
  if (a.kind === 'pair' && b.kind === 'pair') return null;
  const direct = (path: Address[], sell: Address[], buy: Address[]): PlannedRoute => ({ path, usesOutside: false, outsideHop: null, sell, buy });

  if (a.kind === 'token' && b.kind === 'token' && a.main && b.main && eq(a.main, b.main)) return direct([a.address, a.main, b.address], [a.address, a.main], [a.main, b.address]);
  if (a.kind === 'token' && b.kind === 'main' && a.main && eq(a.main, b.address)) return direct([a.address, b.address], [a.address, b.address], [b.address]);
  if (a.kind === 'main' && b.kind === 'token' && b.main && eq(b.main, a.address)) return direct([a.address, b.address], [a.address], [a.address, b.address]);

  let left: Address[];
  if (a.kind === 'token') {
    if (!a.main || !a.pair) return null;
    left = [a.address, a.main, a.pair];
  } else if (a.kind === 'main') {
    left = [a.address, a.pair!];
  } else left = [a.address];
  let right: Address[];
  if (b.kind === 'token') {
    if (!b.main || !b.pair) return null;
    right = [b.pair, b.main, b.address];
  } else if (b.kind === 'main') {
    right = [b.pair!, b.address];
  } else right = [b.address];

  const joint = left[left.length - 1];
  if (eq(joint, right[0])) {
    const path = [...left, ...right.slice(1)];
    for (let i = 0; i + 2 < path.length; i++) if (eq(path[i], path[i + 2])) return null;
    return direct(path, left, right);
  }
  const path = [...left, ...right];
  if (new Set(path.map((x) => x.toLowerCase())).size !== path.length) return null;
  return { path, usesOutside: true, outsideHop: [joint, right[0]], sell: left, buy: right };
}

/** A caller's path, every token through `toAddress` (rule `path`), checksummed. */
function toPath(path: readonly Address[]): Address[] {
  if (!Array.isArray(path)) throw new ValidationError('path', `path must be a list of token addresses, got ${String(path)}.`);
  return path.map((t) => toAddress(t, 'path'));
}

/** A reverted quote read as a `quoteSwap` block reason (the contract's reason, the whitelist / gate ones renamed); anything else is rethrown. */
function swapBlockReason(e: unknown): string {
  const reason = decodeRevert(e).reason;
  if (!reason) throw e;
  if (reason === 'No WL for freeze') return 'not whitelisted';
  if (reason === 'Trading is not enabled') return 'trading not enabled';
  return reason;
}

/** A whole number as a bigint: a bigint, or a number that is an integer (as PY takes any int); null for anything else. */
function wholeOrNull(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  return typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;
}

/** A whole-number leverage % in 1..max (rule "Range"): a bigint or an integer number. */
function checkLevPct(v: number | bigint, max: number): number {
  const n = wholeOrNull(v);
  if (n === null || n < 1n || n > BigInt(max)) throw new ValidationError('Range', `The leverage % must be a whole number 1-${max}, got ${String(v)}.`);
  return Number(n);
}

/** A raw amount argument as bigint (`toUint` under `field`), refused when 0 (rule 'amount'). */
function checkAmount(amount: bigint, field: string): bigint {
  const v = toUint(amount, field);
  if (v === 0n) throw new ValidationError('amount', 'Amount must be greater than 0.');
  return v;
}

/**
 * A partial-sell percentage (a bigint or an integer number), in order: a whole multiple of 10 ("% by 10"), then
 * 10..100 ("% range").
 */
function checkSellPct(v: number | bigint): number {
  const n = wholeOrNull(v);
  if (n === null || n % 10n !== 0n) {
    throw new ValidationError('% by 10', `percentage must be a whole multiple of 10, got ${String(v)}.`);
  }
  if (n < 10n || n > 100n) throw new ValidationError('% range', `percentage must be 10-100, got ${n}.`);
  return Number(n);
}

/** The refusal for a main whose pair is paused ("unknown pair"). */
function pausedError(main: Address): ValidationError {
  return new ValidationError('unknown pair', `Main ${main} is paused on SWAP (pairs(main).active is false): it cannot be traded or leveraged through SWAP until it is reactivated (repayLeverage on the main still works; extendLeverage does not).`);
}

/**
 * The direction rules for a plain 2- or 3-token path, as far as `assetOf` tells them: the pair asset of each live main
 * on the path, null for any other token. The first rule broken, named by the contract's own reason, or null. A factory
 * token's own main is left to the contract (it needs a read).
 */
function plainPathError(fn: 'buyTokens' | 'sellTokens', path: readonly Address[], assetOf: readonly (Address | null)[]): ValidationError | null {
  const isPairAsset = (i: number) => assetOf[i] === null && assetOf.some((a) => a !== null && eq(a, path[i]));
  const last = path.length - 1;
  const [first, out] = [path[0], path[last]];
  const [a0, a1, a2] = [assetOf[0] ?? null, assetOf[1] ?? null, assetOf[2] ?? null];
  if (fn === 'buyTokens') {
    if (isPairAsset(last)) return new ValidationError('Alien output', `A buy ends in a main or a factory token, but the path ends at the pair asset ${out}: to sell, use sellTokens.`);
    if (path.length === 2) {
      if (a1 !== null) return eq(first, a1) ? null : new ValidationError('Bad pair', `A buy of the main ${out} starts at its pair asset ${a1}, not at ${first}.`);
      return a0 !== null ? null : new ValidationError('Bad pair', `A buy of the factory token ${out} starts at its main, and ${first} is not a main.`);
    }
    if (a1 === null) return new ValidationError('unknown pair', `A 3-token buy goes through a main, and ${path[1]} is not a main on SWAP.`);
    if (!eq(first, a1)) return new ValidationError('Not pair asset', `A 3-token buy starts at the pair asset ${a1} of ${path[1]}, not at ${first}.`);
    return a2 === null ? null : new ValidationError('Not ecosystem', `A 3-token buy ends in a factory token, and ${out} is a main.`);
  }
  if (isPairAsset(0)) return new ValidationError('Wrong token', `A sell starts at a main or a factory token, but the path starts at the pair asset ${first}: to buy, use buyTokens.`);
  if (path.length === 2) {
    if (a0 !== null) return eq(out, a0) ? null : new ValidationError('Bad pair', `A sell of the main ${first} ends at its pair asset ${a0}, not at ${out}.`);
    return a1 !== null ? null : new ValidationError('Bad pair', `A sell of the factory token ${first} ends at its main, and ${out} is not a main.`);
  }
  if (a0 !== null) return new ValidationError('Not ecosystem', `A 3-token sell starts at a factory token, and ${first} is a main.`);
  if (a1 === null) return new ValidationError('Not MAIN', `A 3-token sell goes through a main, and ${path[1]} is not a main on SWAP.`);
  return eq(out, a1) ? null : new ValidationError('Not pair asset', `A 3-token sell ends at the pair asset ${a1} of ${path[1]}, not at ${out}.`);
}
