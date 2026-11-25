import { ApiCore, seg } from './core';
import { ValidationError } from '../core/errors';
import { optionKeys, optsOf } from '../core/opts';
import { toAddress, toBool, toUint } from '../core/units';
import type { Cursor, CursorPage, MainFilterParams, Pagination, RawAmount, UsdE18, UsdSource } from './types';

export type LoanSource = 'hub' | 'vault' | 'leverage' | 'vesting';
export type LoanStatus = 'active' | 'expired' | 'liquidated' | 'repaid' | 'claimable';
export type LoanEventAction =
  | 'created' | 'repaid' | 'extended' | 'increased' | 'liquidated' | 'partial_sell' | 'liquidation_claimed'
  | 'refinance_surplus' | 'liquidation_settled' | 'added' | 'repaid_partial' | 'seized';
export type VaultEventAction = 'stake' | 'unstake' | 'claim' | 'compound' | 'liquidation_loss';
export type VestingEventAction =
  | 'created' | 'updated' | 'claimed' | 'extended' | 'beneficiary_changed' | 'renounced' | 'creator_transferred'
  | 'loan_taken' | 'loan_repaid' | 'loan_liquidated';
/** Which side of a vesting the wallet is on; the server default is `any`. */
export type VestingEventRole = 'actor' | 'beneficiary' | 'creator' | 'any';
export type VaultHistoryInterval = '1h' | '4h' | '1d';

/** A ready contract call (a loan row's `repay`): send as is, or change the amount in `args`. */
export interface QuoteCall {
  to: string;
  /** Signature, e.g. `repayLoan(uint256,uint256)`. */
  function: string;
  /** ABI order; integers as decimal strings. */
  args: unknown[];
  value: RawAmount;
  /** ABI-encoded calldata (0x...). */
  data: string;
}

/** A loan row's `claim`: a ready call to collect what a liquidation left. */
export interface LoanClaim {
  contract: string;
  function: string;
  args: unknown[];
}

/** One loan of a wallet. Pair amounts are raw `pairAsset` units, collateral amounts token units (18 decimals). */
export interface Loan {
  wallet: string;
  source: LoanSource;
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  /** Loan id. */
  loanId: number;
  hubId: number | null;
  hub: string | null;
  hubBorrower: string | null;
  coreOwner: string;
  isLeverage: boolean;
  vestingId: number | null;
  /** The collateral token. */
  token: string;
  collateralAmount: RawAmount;
  /** History: received when opened (plus adds and increases), never reduced. The debt is `fullAmount`. */
  borrowedAmount: RawAmount;
  /** The debt, pair units. */
  fullAmount: RawAmount;
  leverageBuyAmount: RawAmount | null;
  /** Pair units, gross, from partial sells of a leverage position; null for a non-leverage loan. */
  cashedOut: RawAmount | null;
  /** Leverage only (null otherwise), raw pair units: lifetime own cash put in (opens and adds, repays, extension fees paid in cash). */
  levCashIn: RawAmount | null;
  /** Leverage only (null otherwise), raw pair units: cash paid to the wallet (sales net of the exit fee, refinance payouts). */
  levCashOut: RawAmount | null;
  /**
   * Leverage only (null otherwise, or when the spot price is not known), raw pair units: collateral sent back to the
   * wallet, valued at the spot price when it was sent. Lifetime P&L = levCashOut + levCollateralOut + net of a full close
   * now (after the exit fee) - levCashIn.
   */
  levCollateralOut: RawAmount | null;
  liquidatedAmount: RawAmount | null;
  claimable: RawAmount | null;
  claimed: RawAmount | null;
  /** claimable - claimed (token units). */
  liquidationClaim: RawAmount | null;
  daysCount: number | null;
  /** Unix seconds. */
  liquidationTime: number;
  expiresAt: string | null;
  /** Unix seconds. */
  creationTime: number;
  txHash: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  isLiquidated: boolean;
  /** Active and past liquidationTime. */
  expired: boolean;
  status: LoanStatus;
  secondsToLiquidation: number | null;
  /** Pair units, live. */
  collateralValue: RawAmount | null;
  collateralUsdE18: UsdE18;
  collateralUsdSource: UsdSource;
  debtUsdE18: UsdE18;
  debtUsdSource: UsdSource;
  /** A ready call to claim what a liquidation left; null when nothing is left. */
  claim: LoanClaim | null;
  /**
   * Unix seconds: the end of the 365-day claim window. After it the leftover may no longer be claimable (the claim then
   * reverts "Nothing to claim"). null when nothing is left to claim or the liquidation is not synced.
   */
  seizableAfter: number | null;
  /** Open leverage position or hub loan: a repay-all call (amount 2^256-1; set args[1] for a partial repay). */
  repay: QuoteCall | null;
  /** Unix seconds the loan closed; null while open. */
  closedAt: number | null;
  closeReason: 'repaid' | 'liquidated' | 'sold' | null;
}

/** `data` of a loan event, parsed; keys depend on source and action (see the spec's LoanEventDetails). */
export type LoanEventDetails = Record<string, unknown>;

export interface LoanEvent {
  wallet: string;
  source: string;
  action: LoanEventAction;
  /** Loan id; null until known. */
  loanId: number | null;
  hubId: number | null;
  main: string | null;
  hub: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  /** USD x 1e18 of the row's amount at the block time. */
  usdE18: UsdE18;
  usdSource: UsdSource;
  /** JSON string (see `details`). */
  data: string;
  /** ISO time. */
  timestamp: string;
  details: LoanEventDetails | null;
}

export interface VaultEvent {
  wallet: string;
  vault: string;
  main: string;
  action: VaultEventAction;
  /** Raw main units (18 decimals). */
  amount: RawAmount;
  /** Pair units on unstake, main units on liquidation_loss (see `amountOutUnit`). */
  amountOut: RawAmount | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO time. */
  timestamp: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  amountOutUnit: 'pair' | 'main' | null;
}

export interface VestingEvent {
  chainId: number;
  vestingContract: string;
  /** The actor of the event. */
  wallet: string;
  action: VestingEventAction;
  vestingId: number;
  creator: string | null;
  beneficiary: string | null;
  main: string | null;
  /** Collateral token. */
  token: string | null;
  /** totalAmount on created, the claimable amount on claimed. */
  amount: RawAmount | null;
  usdE18: UsdE18;
  usdSource: UsdSource;
  /** JSON of extra fields (the optional typed fields below are parsed from it). */
  data: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO time. */
  timestamp: string;
  additionalDays?: number;
  hub?: string;
  loanId?: number;
  /** Raw pair units of the vesting's main. */
  borrowed?: RawAmount;
  recovered?: RawAmount;
  newTotalAmount?: RawAmount;
  oldBeneficiary?: string;
  newBeneficiary?: string;
  oldCreator?: string;
  newCreator?: string;
  /** The pair asset of `borrowed` (and its decimals): only on rows that carry `borrowed`. */
  pairAsset?: string | null;
  pairDecimals?: number | null;
  /** wallet = 0x0: not resolved yet. */
  walletPending: boolean;
}

/**
 * A wallet's vault position for one main (spec `VaultPosition`; database only). Pending rewards, freeToUnstake and the
 * exact live position are chain reads: see `client.vault` (whose on-chain view is `VaultPosition`).
 */
export interface ApiVaultPosition {
  main: string;
  vault: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  /** Main units. */
  staked: RawAmount;
  /** Main units put in, net of withdrawals (only the database keeps it). */
  principal: RawAmount | null;
  /** Main units locked as loan collateral. */
  pledged: RawAmount;
  hasActiveLoan: boolean;
  hubId: number | null;
  hub: string | null;
  loan: {
    hubId: number;
    hub: string | null;
    /** Raw pair units received (never reduced); the debt is `fullAmount`. */
    borrowed: RawAmount;
    fullAmount: RawAmount;
    /** Unix seconds. */
    liquidationTime: number;
    active: boolean;
    isLiquidated: boolean;
  } | null;
}

export interface VaultPositions {
  wallet: string;
  data: ApiVaultPosition[];
}

/** A vault's most recent liquidation loss (`stakeLost` / `rewardsLost` main units; `time` ISO). */
export interface VaultLastLiquidation {
  wallet: string;
  hub: string | null;
  hubId: number | null;
  stakeLost: RawAmount | null;
  rewardsLost: RawAmount | null;
  txHash: string;
  time: string;
}

/** One row of /vaults per main. Live values cached 15 s. */
export interface VaultSummary {
  main: string;
  vault: string;
  pairAsset: string;
  pairDecimals: number;
  pairSymbol: string;
  /** The minimum stake; null when the read fails. */
  minStake: RawAmount | null;
  /** Main units; null when the read fails. */
  totalStaked: RawAmount | null;
  totalPledged: RawAmount | null;
  /** Main units. */
  yield7d: RawAmount;
  yield30d: RawAmount;
  yield7dPair: RawAmount;
  yield30dPair: RawAmount;
  yield7dUsdE18: UsdE18;
  usdSource: UsdSource;
  yield30dUsdE18: UsdE18;
  yield30dUsdSource: UsdSource;
  injections7d: number;
  injections30d: number;
  aprBps: number | null;
  aprBasis: 'current_total_staked';
  lastLiquidation: VaultLastLiquidation | null;
  /** Main units accrued and not yet claimed or compounded; null when the read fails. */
  rewardsHeld: RawAmount | null;
}

/** One bucket of /vaults/history (listed only when something happened in it). */
export interface VaultHistoryBucket {
  /** Bucket start, unix seconds (UTC). */
  time: number;
  staked: RawAmount;
  unstaked: RawAmount;
  compounded: RawAmount;
  claimed: RawAmount;
  liquidationLoss: RawAmount;
  /** Yield received, raw pair units. */
  yieldPair: RawAmount;
  /** Main added by that yield, main units. */
  yieldMainAdded: RawAmount;
  yieldToOwnerPair: RawAmount;
  yieldUsdE18: UsdE18;
  /** Running total at the end of the bucket (main units). */
  totalStaked: RawAmount;
  totalYieldMainAdded: RawAmount;
}

export interface VaultHistory {
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  interval: string;
  /** Unix seconds. */
  from: number;
  to: number;
  count: number;
  data: VaultHistoryBucket[];
}

/**
 * `getLoanExitQuote`: which position and how much of it. Take `main`, `token`, `owner` (the row's `coreOwner`) and
 * `loanId` from a loans row (`getMyLoans` / `getWalletLoans`).
 */
export interface LoanExitQuoteParams {
  /** The main the position is on (the row's `main`), a 0x address. */
  main: string;
  /** The collateral token (the main itself for main collateral), a 0x address. */
  token: string;
  /** The row's `coreOwner`, passed as is. A 0x address. */
  owner: string;
  /** The row's `loanId` (not `hubId`): a whole number above 0. */
  loanId: number | bigint;
  /** How much to sell, in percent: 10, 20, ... 100. */
  pct: number;
  /** true for a leverage position, false for a loan. */
  leverage: boolean;
  /** The wallet whose sell fee applies (a hub loan's borrower). Default: `owner`. */
  payer?: string;
}
const LOAN_EXIT_QUOTE_KEYS = optionKeys<LoanExitQuoteParams>({
  main: true, token: true, owner: true, loanId: true, pct: true, leverage: true, payer: true,
});

/** `getLoanExitQuote` figures: raw units as decimal strings, every one read at the same block. */
export interface LoanExitQuoteData {
  quote: {
    /** Collateral left to sell once the debt share is settled (token units). */
    residual: RawAmount;
    /** What the sale brings in (pair asset raw units). */
    gross: RawAmount;
    /** The exit fee (pair asset raw units). */
    fee: RawAmount;
    /** gross less fee (pair asset raw units). */
    net: RawAmount;
    /** The residual at the spot price (no price impact): gross against grossAtSpot is the price impact. */
    grossAtSpot: RawAmount;
  };
  /** net less 2%: the floor the site sends with the sale. */
  minOut: RawAmount;
  /** Main tokens that settle the debt share (the server's field name). */
  mainToBurn: RawAmount;
  /** Collateral tokens that settle the debt share (the server's field name). */
  tokensToBurn: RawAmount;
  /** The payer's own sell rate, in basis points (a decimal string). */
  sellRateBps: string;
  position: {
    /** The debt now (pair asset raw units). */
    fullAmount: RawAmount;
    /** The collateral (token units). */
    collateralAmount: RawAmount;
  };
  /** The block every figure was read at (a decimal string). */
  block: string;
}

/** GET /api/v1/loans/exit-quote answer. */
export interface LoanExitQuote {
  network: string;
  chainId: number;
  data: LoanExitQuoteData;
  /** ISO time. */
  asOf: string;
}

/** Filters of the loan lists. `main` is a main key (e.g. `stasis-usdg`) or address. Offset paged: `page` or `offset`. */
export interface LoansParams {
  source?: LoanSource;
  main?: string;
  hub?: string;
  /** Collateral token (with active=true: the open position of that token). */
  token?: string;
  active?: boolean;
  status?: LoanStatus;
  /** 1-based. */
  page?: number;
  /** Rows to skip (rounded down to a page start), instead of `page`. */
  offset?: number;
  /** 1-100 (default 20). */
  limit?: number;
}
const LOANS_KEYS = optionKeys<LoansParams>({
  source: true, main: true, hub: true, token: true, active: true, status: true, page: true, offset: true, limit: true,
});

export interface LoanEventsParams {
  source?: LoanSource;
  action?: LoanEventAction;
  main?: string;
  hub?: string;
  cursor?: Cursor | null;
  limit?: number;
}
const LOAN_EVENTS_KEYS = optionKeys<LoanEventsParams>({ source: true, action: true, main: true, hub: true, cursor: true, limit: true });

export interface VaultEventsParams {
  action?: VaultEventAction;
  main?: string;
  vault?: string;
  cursor?: Cursor | null;
  limit?: number;
}
const VAULT_EVENTS_KEYS = optionKeys<VaultEventsParams>({ action: true, main: true, vault: true, cursor: true, limit: true });

/** `vestingContract` defaults to every contract (the deployment's own when `vestingId` is given). */
export interface VestingEventsParams {
  vestingContract?: string;
  vestingId?: number | bigint;
  action?: VestingEventAction;
  role?: VestingEventRole;
  cursor?: Cursor | null;
  limit?: number;
}
const VESTING_EVENTS_KEYS = optionKeys<VestingEventsParams>({
  vestingContract: true, vestingId: true, action: true, role: true, cursor: true, limit: true,
});

/** `from` / `to`: unix seconds (ms accepted); defaults: 90 intervals before `to`, now. */
export interface VaultHistoryParams {
  main?: string;
  interval?: VaultHistoryInterval;
  from?: number;
  to?: number;
}
const VAULT_HISTORY_KEYS = optionKeys<VaultHistoryParams>({ main: true, interval: true, from: true, to: true });
const MAIN_FILTER_KEYS = optionKeys<MainFilterParams>({ main: true });

export class CreditApi extends ApiCore {
  /** GET /api/v1/loans: loans of the authenticated wallet. Key or session; offset paged (`page` / `offset`). */
  async getMyLoans(params: LoansParams = {}): Promise<{ data: Loan[]; pagination: Pagination }> {
    return this.request('GET', '/api/v1/loans', { auth: 'keyOrSession', query: { ...optsOf(params, LOANS_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/loans: loans of a wallet. API key; offset paged (`page` / `offset`). */
  async getWalletLoans(address: string, params: LoansParams = {}): Promise<{ data: Loan[]; pagination: Pagination }> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/loans`, { auth: 'key', query: { ...optsOf(params, LOANS_KEYS) } });
  }

  /**
   * GET /api/v1/loans/exit-quote: what selling `pct`% of a loan or leverage position pays now: gross, the exit fee,
   * net, and `minOut` (net less 2%), all read at one block. Take `main`, `token`, `owner` (`coreOwner`) and `loanId`
   * from a loans row. Checked before any request: `main`, `token`, `owner` and `payer` 0x addresses (each its own rule
   * name), `loanId` a whole number above 0 ('loanId'), `pct` 10, 20, ... 100 ('pct'), `leverage` true or false
   * ('leverage'). Route errors throw BasisApiError: 400 `bad_param` (the body's `param` names which), 404 `not_found`
   * (no such position), 422 `refused` (the sale would be refused now; the reason in the message), 503. API key.
   * The paper site serves this route today; the main site answers 404 until it has it.
   */
  async getLoanExitQuote(params: LoanExitQuoteParams): Promise<LoanExitQuote> {
    const p = optsOf(params, LOAN_EXIT_QUOTE_KEYS);
    const main = toAddress(p.main, 'main');
    const token = toAddress(p.token, 'token');
    const owner = toAddress(p.owner, 'owner');
    const payer = p.payer == null ? undefined : toAddress(p.payer, 'payer');
    const loanId = toUint(p.loanId, 'loanId');
    if (loanId === 0n) throw new ValidationError('loanId', 'loanId must be a whole number above 0 (the loans row\'s loanId).');
    const pct = p.pct as unknown;
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 10 || pct > 100 || pct % 10 !== 0) {
      throw new ValidationError('pct', `pct must be 10, 20, ... or 100, got ${String(pct)}.`);
    }
    const leverage = toBool(p.leverage, 'leverage');
    return this.request('GET', '/api/v1/loans/exit-quote', {
      auth: 'key', query: { main, token, owner, loanId: loanId.toString(), pct, leverage, payer },
    });
  }

  /** GET /api/v1/loans/events: loan events of the authenticated wallet, newest first. Key or session; cursor paged. */
  async getMyLoanEvents(params: LoanEventsParams = {}): Promise<CursorPage<LoanEvent>> {
    return this.request('GET', '/api/v1/loans/events', { auth: 'keyOrSession', query: { ...optsOf(params, LOAN_EVENTS_KEYS) } });
  }

  /**
   * GET /api/v1/wallet/{address}/loans/events: loan events of a wallet, newest first. API key; cursor paged.
   * A wallet's liquidations: `{ action: 'liquidated' }` (there is no all-wallets liquidation list).
   */
  async getWalletLoanEvents(address: string, params: LoanEventsParams = {}): Promise<CursorPage<LoanEvent>> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/loans/events`, { auth: 'key', query: { ...optsOf(params, LOAN_EVENTS_KEYS) } });
  }

  /** GET /api/v1/vault/position: the authenticated wallet's vault positions, one per main. Key or session. */
  async getMyVaultPosition(params: MainFilterParams = {}): Promise<VaultPositions> {
    return this.request('GET', '/api/v1/vault/position', { auth: 'keyOrSession', query: { ...optsOf(params, MAIN_FILTER_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/vault: a wallet's vault positions, one per main. API key. */
  async getWalletVaultPosition(address: string, params: MainFilterParams = {}): Promise<VaultPositions> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/vault`, { auth: 'key', query: { ...optsOf(params, MAIN_FILTER_KEYS) } });
  }

  /** GET /api/v1/vault/events: vault events of the authenticated wallet. Key or session; cursor paged. */
  async getMyVaultEvents(params: VaultEventsParams = {}): Promise<CursorPage<VaultEvent>> {
    return this.request('GET', '/api/v1/vault/events', { auth: 'keyOrSession', query: { ...optsOf(params, VAULT_EVENTS_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/vault/events: vault events of a wallet. API key; cursor paged. */
  async getWalletVaultEvents(address: string, params: VaultEventsParams = {}): Promise<CursorPage<VaultEvent>> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/vault/events`, { auth: 'key', query: { ...optsOf(params, VAULT_EVENTS_KEYS) } });
  }

  /** GET /api/v1/vaults: one row per live main (stake, pledges, yield, APR). API key. */
  async getVaults(params: MainFilterParams = {}): Promise<{ data: VaultSummary[] }> {
    return this.request('GET', '/api/v1/vaults', { auth: 'key', query: { ...optsOf(params, MAIN_FILTER_KEYS) } });
  }

  /** GET /api/v1/vaults/history: stake flows and yield of one main, bucketed (at most 1000 buckets). API key. */
  async getVaultHistory(params: VaultHistoryParams = {}): Promise<VaultHistory> {
    return this.request('GET', '/api/v1/vaults/history', { auth: 'key', query: { ...optsOf(params, VAULT_HISTORY_KEYS) } });
  }

  /** GET /api/v1/vesting/events: vesting events of the authenticated wallet. Key or session; cursor paged. */
  async getMyVestingEvents(params: VestingEventsParams = {}): Promise<CursorPage<VestingEvent>> {
    return this.request('GET', '/api/v1/vesting/events', { auth: 'keyOrSession', query: { ...optsOf(params, VESTING_EVENTS_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/vesting/events: vesting events of a wallet. API key; cursor paged. */
  async getWalletVestingEvents(address: string, params: VestingEventsParams = {}): Promise<CursorPage<VestingEvent>> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/vesting/events`, { auth: 'key', query: { ...optsOf(params, VESTING_EVENTS_KEYS) } });
  }
}
