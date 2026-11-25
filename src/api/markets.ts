import { ApiCore, BasisApiError, DEFAULT_API_AI_TIMEOUT_MS, MAX_TIMEOUT_MS, checkTimeoutMs, seg, withoutNulls } from './core';
import { ANY_KEYS, type OptionKeys, optionKeys, optsOf } from '../core/opts';
import { BasisError, ValidationError } from '../core/errors';
import { checkText, optUint, toAddress, toBool, toUint } from '../core/units';
import type { CursorPage, E18, Pagination, RawAmount, UsdE18, UsdSource } from './types';
import type { ApproveMarketParams, MarketApprovalResponse, MarketType } from '../core/marketApproval';

/** The indexed (or, on `getMarketResolution`, live) status machine of a market. */
export type MarketResolutionStatus =
  | 'active' | 'awaiting_proposal' | 'proposed' | 'proposed_closed' | 'voting' | 'veto_window' | 'disputed'
  | 'vetoed' | 'awaiting_finalize' | 'resolved' | 'invalidated' | 'unknown';
/** `resolved` | `invalidated` | `vetoed` (a standing veto: BASIS decides; not final); null while open. */
export type MarketResolutionKind = 'resolved' | 'invalidated' | 'vetoed' | null;
/** Host filter: `public`, `private` or a host address. */
export type MarketHostFilter = 'public' | 'private' | `0x${string}`;
export type MarketSort = 'newest' | 'ending' | 'volume24h' | 'volume' | 'bettors';
export type MarketOddsInterval = 'raw' | '5m' | '15m' | '1h' | '4h' | '1d';
export type OrderStatus = 'ACTIVE' | 'FILLED' | 'CANCELLED';
export type MarketEventAction =
  | 'propose' | 'dispute' | 'vote' | 'veto' | 'resolve' | 'invalidate' | 'ranked_resolved' | 'resolver_resolved'
  | 'redeem' | 'no_winner_swept' | 'dispute_reset' | 'bonds_distributed' | 'bonds_seized' | 'bond_redirected'
  | 'early_reset' | 'vote_reopened' | 'order_created' | 'order_cancelled' | 'order_filled' | 'bet_unplaced';
/** binary: two answers; single: one winner among many; ranked: a podium (one entrant per answer). */
export type MarketShape = 'binary' | 'single' | 'ranked';

/**
 * Sorted-list paging: `page` (1-based) or `offset` (rounded down to a page start, a multiple of limit), and `limit`
 * (1..100, default 20).
 */
export interface PageParams {
  page?: number;
  offset?: number;
  limit?: number;
}

/** The folded final result; null while not resolved. */
export interface MarketFinal {
  /** The winning outcome id; 254 = invalid. */
  finalOutcome: number | null;
  /** Outcome ids in finishing order; [] when invalidated; null for an unranked resolve. */
  ranking: number[] | null;
  /** The first tie group of the ranking; null for an unranked resolve. */
  winners: number[] | null;
  tieMask: string | null;
  /** Unix seconds. */
  resolvedAt: number | null;
}

/** An outcome with its odds as of the last synced bet. */
export interface MarketOutcomeOdds {
  id: number;
  name: string | null;
  /** Outcome weight after the last synced bet, market-token wei; null before any bet. */
  reserve: RawAmount | null;
  /** Probability x 1e18 (also the marginal share price in market-token wei). */
  probabilityE18: E18 | null;
  /** Never bet on: its odds are an estimate, not from bets on it. */
  derived: boolean;
}

/** A market row of `getMarkets`. */
export interface MarketSummary {
  marketToken: string;
  host: string;
  hostKind: MarketType | null;
  creator: string;
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  name: string | null;
  symbol: string | null;
  image: string | null;
  category: string | null;
  private: boolean;
  /** Unix seconds; 0 = open-ended. */
  endTime: number;
  outcomeCount: number | null;
  createdBlock: number | null;
  status: MarketResolutionStatus;
  statusSource: 'indexed';
  /** Unix seconds: when the current window ends. */
  deadline: number | null;
  volumeUsdE18: UsdE18;
  volume24hUsdE18: UsdE18;
  usdSource: UsdSource;
  usdCovered: number;
  n: number;
  bets: number;
  fills: number;
  bettors: number;
  /** ISO 8601. */
  lastActivityAt: string | null;
  resolved: boolean;
  resolution: MarketResolutionKind;
  final: MarketFinal | null;
  outcomes: MarketOutcomeOdds[];
  /** Live: market-token wei (cached 10 s). */
  pot: RawAmount | null;
  noWinnerSwept: boolean;
}

export interface MarketsParams extends PageParams {
  host?: MarketHostFilter;
  /** A main key or address. */
  main?: string;
  status?: MarketResolutionStatus;
  creator?: string;
  /** Unix seconds or an ISO 8601 date. */
  endsBefore?: number | string;
  /** Unix seconds or an ISO 8601 date. */
  endsAfter?: number | string;
  category?: string;
  /** true: resolved or invalidated; false: the rest. */
  resolved?: boolean;
  /** Default `newest`. */
  sort?: MarketSort;
}
const MARKETS_KEYS = optionKeys<MarketsParams>({
  page: true, offset: true, limit: true, host: true, main: true, status: true, creator: true, endsBefore: true, endsAfter: true,
  category: true, resolved: true, sort: true,
});

export interface MarketsPage {
  data: MarketSummary[];
  pagination: Pagination;
  scanned?: number;
  scanCap?: number;
}

/** An outcome of `getMarket`: indexed odds plus live totals. */
export interface MarketOutcomeDetail extends MarketOutcomeOdds {
  /** Shares (18 dec), live. */
  circulatingShares: RawAmount | null;
  /** Market-token wei paid into this outcome, live. */
  totalCost: RawAmount | null;
  hasWon: boolean;
}

/** One market (`getMarket`). Money fields are market-token wei unless noted. */
export interface MarketDetail {
  marketToken: string;
  host: string;
  hostKind: MarketType;
  resolver: string | null;
  creator: string;
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  name: string | null;
  symbol: string | null;
  /** The resolution rules the creator wrote. */
  description: string | null;
  category: string | null;
  image: string | null;
  private: boolean;
  /** Unix seconds (live). */
  creationTime: number;
  /** Unix seconds; 0 = open-ended. */
  endTime: number;
  status: MarketResolutionStatus;
  statusSource: 'indexed';
  deadline: number | null;
  resolved: boolean;
  resolution: MarketResolutionKind;
  final: MarketFinal | null;
  options: { id: number; name: string | null }[];
  trancheBP: number[] | null;
  /** Total outcome weight after the last synced bet, market-token wei; null before any bet. */
  totalVirtualReserve: RawAmount | null;
  outcomes: MarketOutcomeDetail[];
  pot: RawAmount;
  generalPot: RawAmount;
  /** `amount`: raw pair asset; `token`: market-token wei. */
  seed: { amount: RawAmount | null; token: RawAmount | null; sharesPerOutcome: RawAmount | null };
  seedUsdE18: UsdE18;
  seedUsdSource: UsdSource;
  volumeUsdE18: UsdE18;
  volume24hUsdE18: UsdE18;
  volumeUsdSource: UsdSource;
  usdCovered: number;
  n: number;
  bets: number;
  fills: number;
  bettors: number;
  noWinnerSwept: boolean;
  /**
   * Private markets only, else null: the market token's whitelist over its whole history (removed invites and the
   * creator first), at most 1000 (`invitedTruncated`). `invitedAt`: unix seconds.
   */
  invited: { wallet: string; username: string | null; invitedAt: number | null }[] | null;
  /** Every invitee, also when `invited` is cut; null on a public market. */
  invitedCount: number | null;
  /** True when `invited` was cut at 1000; null on a public market. */
  invitedTruncated?: boolean | null;
}

/** An AMM bet with the outcome weights after it. */
export interface MarketTrade {
  id: number;
  host: string;
  buyer: string;
  outcomeId: number;
  shares: RawAmount;
  /** Always `buy`. */
  tradeType: string;
  newReserve: RawAmount;
  newTotalReserve: RawAmount;
  tokensNet: RawAmount;
  tokensGross: RawAmount | null;
  fee: RawAmount;
  inputToken: string | null;
  /** `inputToken` units. */
  paid: RawAmount | null;
  inputDecimals: number | null;
  /** Raw pair asset. */
  valuePair: RawAmount | null;
  valueUsdE18: UsdE18;
  usdSource: UsdSource;
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  /** After the bet. */
  probabilityE18: E18 | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO 8601. */
  timestamp: string;
}

export interface MarketTradesParams {
  outcomeId?: number;
  cursor?: string | null;
  limit?: number;
}
const MARKET_TRADES_KEYS = optionKeys<MarketTradesParams>({ outcomeId: true, cursor: true, limit: true });

export interface MarketOddsParams {
  /** Default `1h`. */
  interval?: MarketOddsInterval;
  /** Unix seconds or an ISO 8601 date. */
  from?: number | string;
  /** Unix seconds or an ISO 8601 date. */
  to?: number | string;
}
const MARKET_ODDS_KEYS = optionKeys<MarketOddsParams>({ interval: true, from: true, to: true });

/** Odds history folded from the indexed bets (at most 1000 points). */
export interface MarketOdds {
  marketToken: string;
  outcomeCount: number | null;
  interval: string;
  baseDerived: boolean;
  initial: { outcomeId: number; probabilityE18: E18 }[] | null;
  /** `time`: unix seconds of the bucket's last bet. */
  series: {
    time: number;
    blockNumber: number;
    logIndex: number;
    probabilities: { outcomeId: number; probabilityE18: E18 | null }[];
  }[];
  truncated: boolean;
}

/** A book order. Named by (host, marketToken, orderId). Shares are 18 decimals. */
export interface Order {
  id: string;
  /** Counts per market per host. */
  orderId: number;
  marketToken: string;
  host: string;
  hostKind: MarketType | null;
  seller: string;
  outcomeId: number;
  /** Shares still listed (same as `remaining`). */
  amount: RawAmount;
  totalAmount: RawAmount;
  remaining: RawAmount;
  filled: RawAmount | null;
  /** Whole pair-asset units per share x 1e18, not the odds; 0 = fill at the live share price (`marketPriced`). */
  pricePerShare: E18;
  marketPriced: boolean;
  /** "1000000000000000000". */
  priceScale: string;
  status: OrderStatus;
  /** ACTIVE and fillable now (`unfillableReason` says why an ACTIVE order is not). */
  fillable: boolean;
  /**
   * Why an ACTIVE order cannot fill now: `resolved` (the market), `above_price` (priced above the live book price),
   * `paused` (its host), `invalid_proposed` (public host: INVALID is proposed or backed by a vote); null otherwise.
   */
  unfillableReason?: 'resolved' | 'above_price' | 'paused' | 'invalid_proposed' | null;
  main: string | null;
  /** The unit a fill costs. */
  pairAsset: string | null;
  pairDecimals: number | null;
  createdTx: string;
  lastBlock: number;
  /** ISO 8601 (row insert time). */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

export interface OrdersPage {
  data: Order[];
  pagination: Pagination;
}

/** The fillable open orders grouped by outcome and price, cheapest first per outcome (`view: 'book'`). */
export interface MarketOrderBook {
  marketToken: string;
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  priceScale: string;
  levels: {
    outcomeId: number;
    host: string;
    /** Whole pair-asset units per share x 1e18; 0 = the live share price. */
    pricePerShare: E18;
    marketPriced: boolean;
    /** Shares. */
    remaining: RawAmount;
    orders: number;
    /** Pass to `client.orderBook.buyOrders`. */
    orderIds: number[];
  }[];
  truncated: boolean;
  /** A market host is paused: its orders are left out of `levels` (none fill until it is unpaused). */
  paused: boolean;
  /** Public host: INVALID is proposed or backed by a vote, so no listing fills until that is settled (left out of `levels`). */
  invalidProposed?: boolean;
  note: string;
}

export interface MarketOrdersParams extends PageParams {
  /** Default `list`. */
  view?: 'list' | 'book';
  /** `view: 'list'` only. */
  status?: OrderStatus;
  outcomeId?: number;
  host?: MarketHostFilter;
}
const MARKET_ORDERS_KEYS = optionKeys<MarketOrdersParams>({ page: true, offset: true, limit: true, view: true, status: true, outcomeId: true, host: true });

export interface OrdersParams extends PageParams {
  marketToken?: string;
  status?: OrderStatus;
  outcomeId?: number;
  host?: MarketHostFilter;
}
const ORDERS_KEYS = optionKeys<OrdersParams>({ page: true, offset: true, limit: true, marketToken: true, status: true, outcomeId: true, host: true });

/** Options of `getMarketHolders`: a page, and one outcome (default all). */
export interface MarketHoldersParams extends PageParams {
  outcomeId?: number;
}
const MARKET_HOLDERS_KEYS = optionKeys<MarketHoldersParams>({ page: true, offset: true, limit: true, outcomeId: true });

export interface MarketHolders {
  marketToken: string;
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  outcomes: { outcomeId: number; holders: number; totalShares: RawAmount }[];
  /** Largest first. `costPair`: raw pair asset. */
  data: {
    wallet: string;
    outcomeId: number;
    shares: RawAmount;
    costPair: RawAmount;
    costComplete: boolean;
    costUsdE18: UsdE18;
    lastBlock: number;
  }[];
  pagination: Pagination;
}

/** Live resolution state. Bonds are raw bond-token units; times unix seconds. */
export interface MarketResolution {
  marketToken: string;
  hostKind: string;
  host: string;
  resolver: string | null;
  status: MarketResolutionStatus;
  phase: string;
  statusSource: 'live';
  endTime: number;
  creationTime: number;
  deadline: number | null;
  secondsLeft: number | null;
  round: number;
  earlyResets: number;
  bondToken: string | null;
  bondDecimals: number | null;
  /** `dispute` is a regular wallet's figure; yours can differ: `client.resolver` reads your own. */
  requiredBond: {
    propose: RawAmount | null;
    dispute: RawAmount | null;
    /**
     * The reduced dispute bond some wallets pay (yours: `client.resolver` reads it); null when no dispute is possible
     * now.
     */
    disputeHouse?: RawAmount | null;
    veto: RawAmount | null;
  } | null;
  canProposeAt: { creator: number; others: number } | null;
  proposal: {
    proposer: string;
    originalKey: string;
    proposerBond: RawAmount;
    disputer: string | null;
    disputedKey: string | null;
    disputerBond: RawAmount | null;
    vetoer: string | null;
    vetoKey: string | null;
    vetoBond: RawAmount | null;
    windowStart: number;
  } | null;
  /**
   * Public: `{ round, leaderKey, leaderMeaning, leaderVotes, totalVotes, tie, quorum, byKey[{ key, votes, ranking, meaning }] }`.
   * Private: `{ voters, totalCast, rows[{ key, votes }], leaders, creatorVoted, outcome, winningKey }`.
   */
  tally: Record<string, unknown> | null;
  finalize: 'finalizeUncontested' | 'finalizeMarket' | 'finalize' | null;
  /** Public markets only. */
  fastEarly?: boolean;
  willReopen?: boolean;
  canDispute?: boolean;
  canVeto?: boolean;
  windows?: { proposalPeriod: number; disputePeriod: number; vetoPeriod: number; earlyFastPeriod: number };
  /** Private markets only. */
  votingOpen?: boolean;
  firstVoteTime?: number | null;
  /** First vote + votingWindow. */
  finalizeAt?: number | null;
  votingWindow?: number;
  final: {
    finalOutcome: number;
    ranking: number[] | null;
    winnersMask: string | null;
    tieMask: string | null;
    finalKey: string | null;
    resolvedAt: number | null;
  } | null;
  rankings: { key: string; ranking: number[]; tieMask: string }[];
}

/** A market / resolution event. `amount` is raw units of `amountAsset` (`amountDecimals`). */
export interface MarketEvent {
  wallet: string;
  marketToken: string;
  host: string | null;
  main: string | null;
  action: MarketEventAction;
  /** Null on ranked and EARLY rows (read `ranking`); 254 on INVALID rows. */
  outcomeId: number | null;
  /** Podium order of a ranked result; [] = INVALID. */
  ranking: number[] | null;
  round: number | null;
  amount: RawAmount | null;
  amountAsset: string | null;
  amountDecimals: number | null;
  /** JSON text of the event's extra fields. */
  data: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  /** ISO 8601. */
  timestamp: string;
  walletIsActor?: boolean;
}

/** Modes: `marketToken` (one market), `wallet` (that wallet's actions), `scope: 'all'`, or none (the caller's wallet). */
export interface MarketEventsParams {
  marketToken?: string;
  wallet?: string;
  action?: MarketEventAction;
  /** Every market's events; not with `wallet` / `marketToken`. */
  scope?: 'all';
  cursor?: string | null;
  limit?: number;
}
const MARKET_EVENTS_KEYS = optionKeys<MarketEventsParams>({ marketToken: true, wallet: true, action: true, scope: true, cursor: true, limit: true });

export interface MarketEventsPage extends CursorPage<MarketEvent> {
  mode: 'market' | 'wallet' | 'own' | 'all';
}

/** A wallet's position in one market. Shares 18 decimals; cost / redeemed raw pair asset. */
export interface WalletMarket {
  marketToken: string;
  host: string;
  hostKind: string | null;
  main: string;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  name: string | null;
  symbol: string | null;
  status: MarketResolutionStatus;
  statusSource: 'indexed';
  resolved: boolean | null;
  lastActivityAt: string | null;
  outcomes: {
    id: number;
    /** Includes `sharesInOrders`. */
    shares: RawAmount | null;
    sharesInOrders: RawAmount;
    cost: RawAmount | null;
    costUsdE18: UsdE18;
    usdSource: UsdSource;
    costBasis: RawAmount | null;
    costBasisUsdE18: UsdE18;
    /** false when a buy's pair value was unknown: costBasis leaves that buy out (a lower bound); null with no cost record. */
    costComplete?: boolean | null;
  }[];
  seed: { amount: RawAmount; asset: string | null; token: RawAmount | null; usdE18: UsdE18; usdSource: UsdSource } | null;
  /** Book sales, net of fees. */
  soldPair: RawAmount | null;
  redeemed: RawAmount;
  sharesSource: 'index' | 'live' | null;
}

export interface WalletMarketsParams extends PageParams {
  status?: MarketResolutionStatus;
}
const WALLET_MARKETS_KEYS = optionKeys<WalletMarketsParams>({ page: true, offset: true, limit: true, status: true });

export interface WalletMarketsPage {
  wallet: string;
  data: WalletMarket[];
  pagination: Pagination;
}

/** A drafting refusal (HTTP 200). */
export interface MarketDraftRefused {
  ok: false;
  refused: true;
  category: string | null;
  reason: string;
  model: string;
  /** The wallet's wait before its next drafting call, ms; absent when the writer names none. */
  cooldownMs?: number;
}

interface MarketDraftOk {
  ok: true;
  refused: false;
  model: string;
  /** The wallet's wait before its next drafting call, ms; absent when the writer names none. */
  cooldownMs?: number;
}

export type MarketDraftResult =
  | (MarketDraftOk & { marketType: MarketType; draft: { name: string; symbol: string; description: string; outcomes: string[] } })
  | MarketDraftRefused;
export type MarketHeadlineResult =
  | (MarketDraftOk & { marketType: MarketType; headline: { name: string; symbol: string; description: string } })
  | MarketDraftRefused;
export type MarketAnswersResult = (MarketDraftOk & { outcomes: string[] }) | MarketDraftRefused;
export type MarketDescriptionResult = (MarketDraftOk & { description: string }) | MarketDraftRefused;

/** `async` of the four drafting calls. */
interface DraftAsync {
  /**
   * true: start the call as a background job. The API answers 202 at once with `{ ok, job, pollAfterMs }`
   * (DraftJobStart) and getDraftJob reads the result, so a slow draft is not cut. An API without background drafts
   * runs the call at once and answers its result. runDraftJob does all of this for you. Default false.
   */
  async?: boolean;
}

export interface DraftMarketParams extends DraftAsync {
  /** 1-400 chars. */
  topic: string;
  marketType: MarketType;
  /** 1..255. */
  outcomeCount?: number;
  shape?: MarketShape;
}

export interface DraftMarketHeadlineParams extends DraftAsync {
  /** 1-400 chars. */
  topic: string;
  marketType: MarketType;
  shape?: MarketShape;
}

export interface DraftMarketAnswersParams extends DraftAsync {
  /** The question, 1-200 chars. */
  name: string;
  /** The rules, at most 2000 chars. */
  description?: string;
  marketType: MarketType;
  /** 1..255. */
  count?: number;
  shape?: MarketShape;
}

export interface DraftMarketDescriptionParams extends DraftAsync {
  /** The question, 1-200 chars. */
  name: string;
  outcomes?: readonly string[];
  marketType: MarketType;
  shape?: MarketShape;
}

/** The four drafting calls, by the name their background jobs carry (`job.kind`). */
export type DraftKind = 'draft' | 'headline' | 'answers' | 'describe';

/** The answer of each drafting call (a draft or a refusal), by kind. */
export interface DraftResultByKind {
  draft: MarketDraftResult;
  headline: MarketHeadlineResult;
  answers: MarketAnswersResult;
  describe: MarketDescriptionResult;
}

/** The params of each drafting call, by kind (runDraftJob sets `async` itself). */
export interface DraftParamsByKind {
  draft: Omit<DraftMarketParams, 'async'>;
  headline: Omit<DraftMarketHeadlineParams, 'async'>;
  answers: Omit<DraftMarketAnswersParams, 'async'>;
  describe: Omit<DraftMarketDescriptionParams, 'async'>;
}
/** The keys of each drafting call. */
const DRAFT_MARKET_KEYS = optionKeys<DraftMarketParams>({ topic: true, marketType: true, outcomeCount: true, shape: true, async: true });
const DRAFT_HEADLINE_KEYS = optionKeys<DraftMarketHeadlineParams>({ topic: true, marketType: true, shape: true, async: true });
const DRAFT_ANSWERS_KEYS = optionKeys<DraftMarketAnswersParams>({ name: true, description: true, marketType: true, count: true, shape: true, async: true });
const DRAFT_DESCRIPTION_KEYS = optionKeys<DraftMarketDescriptionParams>({ name: true, outcomes: true, marketType: true, shape: true, async: true });
/**
 * runDraftJob's params, by kind: the call's own keys. A given `async` is let through and replaced (runDraftJob sets it
 * itself), as PY's run_draft_job drops `async_`.
 */
const RUN_DRAFT_KEYS: Readonly<Record<DraftKind, OptionKeys<any>>> = {
  draft: DRAFT_MARKET_KEYS, headline: DRAFT_HEADLINE_KEYS, answers: DRAFT_ANSWERS_KEYS, describe: DRAFT_DESCRIPTION_KEYS,
};

export type DraftJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * A drafting call running in the background (started with `async: true`). The API keeps it for 10 minutes after it
 * ends, for the wallet that started it only.
 */
export interface DraftJob<R = DraftResultByKind[DraftKind]> {
  /** 32 lower-case hex characters. */
  id: string;
  kind: DraftKind;
  status: DraftJobStatus;
  /** Since the job started, or its whole run once it has ended, ms. */
  elapsedMs: number;
  /** On `done`: exactly what the call answers without `async` (a draft or a refusal). */
  result?: R;
  /** On `failed`: `draft_unavailable` | `timeout` | `internal_error`. */
  error?: string;
}

/** The 202 answer of a drafting call with `async: true`: the job (or the running job of the same input). */
export interface DraftJobStart<R = DraftResultByKind[DraftKind]> {
  ok: true;
  job: DraftJob<R>;
  /** Wait at least this long before the first getDraftJob, ms. */
  pollAfterMs: number;
}

/** The answer of getDraftJob and cancelDraftJob. */
export interface DraftJobResponse<R = DraftResultByKind[DraftKind]> {
  ok: true;
  job: DraftJob<R>;
}

/** null is absent (as None in PY), so the default applies. */
export interface RunDraftJobOptions {
  /**
   * Give up after this long, ms, and cancel the job (default: the client's apiAiTimeoutMs, 330 s). A draft runs up to
   * about 3 minutes.
   */
  timeoutMs?: number;
  /**
   * Least time between the starts of two status checks, ms (default 1500; a larger `pollAfterMs` from the API wins).
   * The API holds each check open until the job ends or about 15 s pass, so this only matters when it answers at once.
   */
  pollIntervalMs?: number;
}
const RUN_DRAFT_JOB_KEYS = optionKeys<RunDraftJobOptions>({ timeoutMs: true, pollIntervalMs: true });
/** The keys of `approveMarket` (the type lives with the approval check, core/marketApproval). */
const APPROVE_MARKET_KEYS = optionKeys<ApproveMarketParams>({
  marketType: true, name: true, symbol: true, description: true, outcomes: true, endTime: true, main: true, seedAmount: true,
  privateEvent: true,
});

const AUTH = 'keyOrSession' as const;

/** Drafting route of each kind. */
const DRAFT_PATHS: Record<DraftKind, string> = {
  draft: '/api/v1/markets/draft',
  headline: '/api/v1/markets/headline',
  answers: '/api/v1/markets/answers',
  describe: '/api/v1/markets/describe',
};
/** Default least gap between two draft-job checks, ms. Same in PY. */
const DRAFT_POLL_MS = 1_500;
/** Wait before asking a busy writer again (429 `gate_busy`) when it names no time, ms. */
const DRAFT_BUSY_RETRY_MS = 5_000;
/**
 * The longest wallet cooldown runDraftJob waits out before starting (429 `cooldown`, 30 s after each drafting call),
 * ms; also the wait when the answer names none. A longer one is thrown at once. Same in PY.
 */
const DRAFT_COOLDOWN_MAX_MS = 30_000;
/** Wait before asking again after a request got no answer (a network error, its own deadline), ms. Same in PY. */
const DRAFT_NO_ANSWER_RETRY_MS = 2_000;
/** A start is asked again only when at least this much of the deadline is left after the wait, ms. Same in PY. */
const DRAFT_START_MIN_LEFT_MS = 5_000;
const DRAFT_JOB_ID = /^[0-9a-f]{32}$/;

/** What each drafting error code means for the caller; appended to the BasisApiError message. */
const DRAFT_HINTS: Record<string, string> = {
  drafting_slow:
    'The AI writer needed longer than one request may last (about 24 s). Run the call in the background: ' +
    'api.runDraftJob(kind, params), or async: true and api.getDraftJob(job.id).',
  drafting_unavailable:
    'The AI writer did not answer in time, or is down. Try again in a moment. draftMarketHeadline + ' +
    'draftMarketAnswers are two shorter calls than one draftMarket, and runDraftJob runs a call in the background ' +
    'where the API offers it.',
  job_running:
    'This wallet already has an AI draft running (its jobId is in the body): wait for it with api.getDraftJob, or ' +
    'stop it with api.cancelDraftJob.',
  job_not_found:
    "That draft job is gone: an unknown id, another wallet's, one that ended more than 10 minutes ago, or one lost " +
    'when the AI writer restarted. Start the call again.',
};
/**
 * A 404 on a draft-job route other than `job_not_found` (the real site answers `not_found`, a bare server none): the
 * API has no such route.
 */
const NO_DRAFT_JOBS_HINT =
  'This API has no background drafts: it answers a drafting call at once, so call it without async.';

/** `e` with the drafting hint of its code (or `fallback`) appended to its message; anything else unchanged. */
function withDraftHint(e: unknown, fallback?: string): unknown {
  if (!(e instanceof BasisApiError)) return e;
  const hint = (e.code && DRAFT_HINTS[e.code]) || fallback;
  if (!hint) return e;
  return new BasisApiError(e.status, e.code, `${e.message.replace(/^\[basis-sdk\] /, '')} ${hint}`, e.body, e.retryAfter);
}

function checkDraftJobId(jobId: unknown): string {
  if (typeof jobId !== 'string' || !DRAFT_JOB_ID.test(jobId)) {
    throw new ValidationError('jobId', `jobId must be the 32 lower-case hex characters of a draft job's id, got ${String(jobId)}.`);
  }
  return jobId;
}

const isDraftJob = (v: unknown): v is DraftJob<unknown> =>
  !!v && typeof v === 'object' && typeof (v as DraftJob).id === 'string' && typeof (v as DraftJob).status === 'string';

/**
 * A request that got no answer: its own deadline (BasisApiError status 0 `timeout`) or a network error (anything that
 * is not an SDK error: fetch's TypeError). It may have reached the server. A caller's abort is not one.
 */
const noAnswer = (e: unknown): boolean =>
  (e instanceof BasisApiError && e.status === 0 && e.code === 'timeout') || !(e instanceof BasisError);

/**
 * ms to wait after a refused or failed request: the body's `retryAfterMs`, else the error's `retryAfter` (`Retry-After`;
 * the per-minute `X-RateLimit-Reset` only for code `rate_limited`, never for `gate_busy` or a daily cap), else `fallback`.
 */
function draftRetryMs(e: BasisApiError, fallback: number): number {
  const b = e.body as { retryAfterMs?: unknown } | null;
  const ms = Number(b && typeof b === 'object' ? b.retryAfterMs : NaN);
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_TIMEOUT_MS);
  if (e.retryAfter !== undefined && e.retryAfter > 0) return Math.min(e.retryAfter * 1000, MAX_TIMEOUT_MS);
  return fallback;
}

/**
 * Throws ValidationError('outcomes') unless `outcomes` is an array of strings (a string would be sent as one value,
 * and PY would split it into characters). Same rule in PY.
 */
function checkOutcomes(outcomes: unknown): void {
  if (!Array.isArray(outcomes) || outcomes.some((o) => typeof o !== 'string')) {
    const got = Array.isArray(outcomes) ? 'an array with a non-string entry' : outcomes === null ? 'null' : typeof outcomes;
    throw new ValidationError('outcomes', `outcomes must be an array of answer strings, got ${got}.`);
  }
}

/**
 * The checks a drafting call of `kind` runs on its params before any request, the same in draftMarketDescription and
 * runDraftJob('describe') (PY's run_draft_job calls the method itself): `describe` refuses an `outcomes` that is not
 * an array of strings (ValidationError('outcomes'); null is absent, as None in PY). The other kinds have none.
 */
function checkDraftParams(kind: DraftKind, params: object): void {
  const outcomes = (params as { outcomes?: unknown }).outcomes;
  if (kind === 'describe' && outcomes != null) checkOutcomes(outcomes);
}

/**
 * `endTime` as the route takes it: a whole number of unix seconds (0 = open-ended, the default; null is absent, as
 * None in PY), at most 2^53 - 1; ValidationError('endTime') otherwise (no truncation of a fraction, no string). Same
 * rule in PY.
 */
function endTimeNumber(endTime: unknown): number {
  const v = endTime === null ? 0n : (optUint(endTime as number | bigint | undefined, 'endTime') ?? 0n);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError('endTime', `endTime must be unix seconds (at most ${Number.MAX_SAFE_INTEGER}), got ${v}.`);
  }
  return Number(v);
}

/** Sleeps `ms`; rejects with BasisApiError `aborted` when `signal` fires. */
function draftPause(ms: number, what: string, signal?: AbortSignal): Promise<void> {
  const aborted = () => new BasisApiError(0, 'aborted', `${what} was aborted by the caller`, null);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    if (ms <= 0) return resolve();
    const onAbort = () => { clearTimeout(t); reject(aborted()); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MarketsApi extends ApiCore {
  /** GET /api/v1/markets: every market of this deployment, sorted and page-paged. Key or session. */
  async getMarkets(params: MarketsParams = {}): Promise<MarketsPage> {
    return this.request('GET', '/api/v1/markets', { auth: AUTH, query: { ...optsOf(params, MARKETS_KEYS) } });
  }

  /**
   * GET /api/v1/markets/{address}: one market with indexed odds and live pot / outcome totals. Key or session.
   * `address` must be a 0x address (ValidationError('address') before any request: `getMarket('events')` would
   * otherwise read the events list).
   */
  async getMarket(address: string): Promise<MarketDetail> {
    const path = `/api/v1/markets/${seg(address)}`;
    toAddress(address, 'address');
    return this.request('GET', path, { auth: AUTH });
  }

  /**
   * GET /api/v1/markets/{address}/trades: the AMM bet log, newest first, cursor-paged. Key or session.
   * Its old name `/api/v1/markets/{address}/liquidity` is an alias and gets no wrapper.
   */
  async getMarketTrades(address: string, params: MarketTradesParams = {}): Promise<CursorPage<MarketTrade>> {
    return this.request('GET', `/api/v1/markets/${seg(address)}/trades`, { auth: AUTH, query: { ...optsOf(params, MARKET_TRADES_KEYS) } });
  }

  /** GET /api/v1/markets/{address}/odds: the odds history per outcome (probability x 1e18). Key or session. */
  async getMarketOdds(address: string, params: MarketOddsParams = {}): Promise<MarketOdds> {
    return this.request('GET', `/api/v1/markets/${seg(address)}/odds`, { auth: AUTH, query: { ...optsOf(params, MARKET_ODDS_KEYS) } });
  }

  /**
   * GET /api/v1/markets/{address}/orders: the market's book, a page of orders (newest orderId first), or with
   * `view: 'book'` the fillable orders grouped by outcome and price. Key or session.
   */
  async getMarketOrders(address: string, params: MarketOrdersParams & { view: 'book' }): Promise<MarketOrderBook>;
  async getMarketOrders(address: string, params?: MarketOrdersParams & { view?: 'list' }): Promise<OrdersPage>;
  async getMarketOrders(address: string, params?: MarketOrdersParams): Promise<OrdersPage | MarketOrderBook>;
  async getMarketOrders(address: string, params: MarketOrdersParams = {}): Promise<OrdersPage | MarketOrderBook> {
    return this.request('GET', `/api/v1/markets/${seg(address)}/orders`, { auth: AUTH, query: { ...optsOf(params, MARKET_ORDERS_KEYS) } });
  }

  /** GET /api/v1/markets/{address}/holders: share holders per outcome, largest first, page-paged. Key or session. */
  async getMarketHolders(address: string, params: MarketHoldersParams = {}): Promise<MarketHolders> {
    return this.request('GET', `/api/v1/markets/${seg(address)}/holders`, { auth: AUTH, query: { ...optsOf(params, MARKET_HOLDERS_KEYS) } });
  }

  /** GET /api/v1/markets/{address}/resolution: the live resolution state (phase, bonds, proposal, tally). Key or session. */
  async getMarketResolution(address: string): Promise<MarketResolution> {
    return this.request('GET', `/api/v1/markets/${seg(address)}/resolution`, { auth: AUTH });
  }

  /**
   * GET /api/v1/markets/events: market and resolution events, newest first, cursor-paged. One market
   * (`marketToken`), one wallet (`wallet`), every market (`scope: 'all'`) or, with none, the caller's own. Key or session.
   */
  async getMarketEvents(params: MarketEventsParams = {}): Promise<MarketEventsPage> {
    return this.request('GET', '/api/v1/markets/events', { auth: AUTH, query: { ...optsOf(params, MARKET_EVENTS_KEYS) } });
  }

  /** GET /api/v1/me/orders: the caller's book orders across markets, newest first, page-paged. Key or session. */
  async getMyOrders(params: OrdersParams = {}): Promise<OrdersPage> {
    return this.request('GET', '/api/v1/me/orders', { auth: AUTH, query: { ...optsOf(params, ORDERS_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/orders: any wallet's book orders, newest first, page-paged. Key or session. */
  async getWalletOrders(address: string, params: OrdersParams = {}): Promise<OrdersPage> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/orders`, { auth: AUTH, query: { ...optsOf(params, ORDERS_KEYS) } });
  }

  /** GET /api/v1/wallet/{address}/markets: any wallet's market positions, latest activity first, page-paged. Key or session. */
  async getWalletMarkets(address: string, params: WalletMarketsParams = {}): Promise<WalletMarketsPage> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/markets`, { auth: AUTH, query: { ...optsOf(params, WALLET_MARKETS_KEYS) } });
  }

  /**
   * POST /api/v1/markets/draft (AI): a whole market (question, ticker, rules, answers) from a topic. Unsigned: it must
   * still pass `approveMarket`. A refusal is returned (`ok: false`); route errors throw BasisApiError: 429 `cooldown`
   * (30 s per wallet, `retryAfterMs` in the body), `rate_limited_ip`, `rate_limited_wallet` (4 drafting calls a minute
   * across draft, headline, answers and describe), `daily_wallet_cap`, `daily_global_cap`, `gate_busy` (`retryAfterMs`),
   * `job_running` (`async`: another job of this wallet is running, its `jobId` in the body); 503 `gate_disabled`,
   * `drafting_slow`, `drafting_unavailable`.
   *
   * The API cuts one request at about 24 s (503 `drafting_slow`, or `drafting_unavailable` where it has no background
   * drafts), and a whole draft often runs longer. For a result that may take minutes use runDraftJob('draft', params),
   * or `async: true` (answers DraftJobStart at once) and getDraftJob. draftMarketHeadline + draftMarketAnswers is the
   * faster pair. Key or session.
   */
  async draftMarket(params: DraftMarketParams & { async: true }): Promise<DraftJobStart<MarketDraftResult> | MarketDraftResult>;
  async draftMarket(params: DraftMarketParams & { async?: false }): Promise<MarketDraftResult>;
  async draftMarket(params: DraftMarketParams): Promise<MarketDraftResult | DraftJobStart<MarketDraftResult>>;
  async draftMarket(params: DraftMarketParams): Promise<MarketDraftResult | DraftJobStart<MarketDraftResult>> {
    return this.draftCall('/api/v1/markets/draft', params, DRAFT_MARKET_KEYS);
  }

  /** POST /api/v1/markets/headline (AI): question, ticker and rules from a topic (no answers). As draftMarket. */
  async draftMarketHeadline(params: DraftMarketHeadlineParams & { async: true }): Promise<DraftJobStart<MarketHeadlineResult> | MarketHeadlineResult>;
  async draftMarketHeadline(params: DraftMarketHeadlineParams & { async?: false }): Promise<MarketHeadlineResult>;
  async draftMarketHeadline(params: DraftMarketHeadlineParams): Promise<MarketHeadlineResult | DraftJobStart<MarketHeadlineResult>>;
  async draftMarketHeadline(params: DraftMarketHeadlineParams): Promise<MarketHeadlineResult | DraftJobStart<MarketHeadlineResult>> {
    return this.draftCall('/api/v1/markets/headline', params, DRAFT_HEADLINE_KEYS);
  }

  /** POST /api/v1/markets/answers (AI): an exhaustive answer set for a question. As draftMarket. */
  async draftMarketAnswers(params: DraftMarketAnswersParams & { async: true }): Promise<DraftJobStart<MarketAnswersResult> | MarketAnswersResult>;
  async draftMarketAnswers(params: DraftMarketAnswersParams & { async?: false }): Promise<MarketAnswersResult>;
  async draftMarketAnswers(params: DraftMarketAnswersParams): Promise<MarketAnswersResult | DraftJobStart<MarketAnswersResult>>;
  async draftMarketAnswers(params: DraftMarketAnswersParams): Promise<MarketAnswersResult | DraftJobStart<MarketAnswersResult>> {
    return this.draftCall('/api/v1/markets/answers', params, DRAFT_ANSWERS_KEYS);
  }

  /** POST /api/v1/markets/describe (AI): resolution rules for a question. `outcomes`, when given, an array. As draftMarket. */
  async draftMarketDescription(params: DraftMarketDescriptionParams & { async: true }): Promise<DraftJobStart<MarketDescriptionResult> | MarketDescriptionResult>;
  async draftMarketDescription(params: DraftMarketDescriptionParams & { async?: false }): Promise<MarketDescriptionResult>;
  async draftMarketDescription(params: DraftMarketDescriptionParams): Promise<MarketDescriptionResult | DraftJobStart<MarketDescriptionResult>>;
  async draftMarketDescription(params: DraftMarketDescriptionParams): Promise<MarketDescriptionResult | DraftJobStart<MarketDescriptionResult>> {
    const p = optsOf(params, DRAFT_DESCRIPTION_KEYS);
    checkDraftParams('describe', p);
    return this.draftCall('/api/v1/markets/describe', p, ANY_KEYS);
  }

  /**
   * GET /api/v1/markets/drafts/{jobId}: a drafting call started with `async: true`: `running`, `done` (`job.result` is
   * the call's own answer: a draft or a refusal), `failed` (`job.error`) or `cancelled`. The API holds the request until
   * the job ends or about 15 s pass, so ask again at once while it runs. Only the wallet that started the job can read
   * it, and checking costs no drafting allowance (60 checks a minute per wallet, 429 `rate_limited_poll`). 404
   * `job_not_found`: an unknown id, another wallet's, one that ended more than 10 minutes ago, or one lost in a writer
   * restart. Key or session.
   */
  async getDraftJob<R = DraftResultByKind[DraftKind]>(jobId: string): Promise<DraftJobResponse<R>> {
    return this.draftJobRequest('GET', jobId);
  }

  /**
   * DELETE /api/v1/markets/drafts/{jobId}: stop a background draft. Idempotent: an ended job answers with its state.
   * A cancelled job counts as one drafting call and starts the 30 s cooldown, like a finished one. Key or session.
   */
  async cancelDraftJob<R = DraftResultByKind[DraftKind]>(jobId: string): Promise<DraftJobResponse<R>> {
    return this.draftJobRequest('DELETE', jobId);
  }

  /**
   * Runs a drafting call in the background and waits for its answer: starts it with `async: true`, then asks
   * getDraftJob until the job ends, never sooner than the API's `pollAfterMs` and never more often than
   * `pollIntervalMs` (each check is held open by the API for up to about 15 s). Returns what the call returns without
   * `async`: a draft, or a refusal (`ok: false`). An API without background drafts answers the start at once: that
   * answer is returned. Asked again inside the deadline: a busy writer (429 `gate_busy`) after its `retryAfterMs`; the
   * wallet's cooldown from its last drafting call (429 `cooldown`, up to 30 s) once it has run; a start that got no
   * answer (a network error, its own deadline) after a short pause, since it may have started a job: when the API then
   * answers 429 `job_running`, that job (its `jobId`, of the same kind) is the one followed. A check that fails for a
   * passing reason (429, 5xx, no answer) is asked again inside the deadline. Each start and each check is bounded by
   * what is left of `timeoutMs` (at least 1 s), and a start is not asked again with less than 5 s left after its
   * wait. `params` get the checks the call itself runs, before any request (describe: `outcomes` an array of strings,
   * ValidationError('outcomes')), as PY.
   *
   * Throws BasisApiError: whatever the start refuses (a cooldown longer than 30 s or past the deadline, the other
   * limits, `job_running` for another job of this wallet, bad input, 503 `drafting_unavailable`); a start with no
   * answer until the deadline throws its own error; status 0 `timeout` when the job still runs after `timeoutMs` (it
   * is cancelled first); `drafting_failed` (the job failed: `job.error` in the message, the job as `body`); `draft_cancelled` (cancelled by
   * cancelDraftJob, maybe from another client of this wallet); `job_not_found` (the job is gone); status 0 `aborted`
   * on the AbortSignal of withOptions (the job is cancelled too). Key or session.
   */
  async runDraftJob<K extends DraftKind>(kind: K, params: DraftParamsByKind[K], options?: RunDraftJobOptions | null): Promise<DraftResultByKind[K]> {
    const path = (Object.prototype.hasOwnProperty.call(DRAFT_PATHS, kind) ? DRAFT_PATHS[kind] : undefined) as string | undefined;
    if (!path) throw new ValidationError('kind', `kind must be draft, headline, answers or describe, got ${String(kind)}.`);
    const p = optsOf(params, RUN_DRAFT_KEYS[kind]);
    const opts = optsOf(options, RUN_DRAFT_JOB_KEYS);
    const total = opts.timeoutMs != null
      ? checkTimeoutMs(opts.timeoutMs, 'timeoutMs')
      : (this.client.apiAiTimeoutMs ?? DEFAULT_API_AI_TIMEOUT_MS);
    const minGap = opts.pollIntervalMs ?? DRAFT_POLL_MS;
    if (typeof minGap !== 'number' || !Number.isFinite(minGap) || minGap < 0 || minGap > MAX_TIMEOUT_MS) {
      throw new ValidationError('pollIntervalMs', `pollIntervalMs must be a number of ms from 0 to ${MAX_TIMEOUT_MS}, got ${String(minGap)}.`);
    }
    checkDraftParams(kind, p);
    const what = `runDraftJob(${kind})`;
    const signal = this.signalFor();
    const deadline = Date.now() + total;

    let start: unknown;
    let lost = false;
    /** The job_running refusal whose job is followed (a start whose answer was lost), else null. */
    let adopted: BasisApiError | null = null;
    for (;;) {
      try {
        const bound = Math.max(1_000, Math.min(this.timeoutFor({ kind: 'ai' }), deadline - Date.now()));
        start = await this.withOptions({ timeoutMs: bound }).draftCall(path, { ...p, async: true }, ANY_KEYS);
        break;
      } catch (e) {
        if (e instanceof BasisApiError && e.code === 'aborted') throw e;
        let wait: number;
        if (noAnswer(e)) {
          lost = true;
          wait = DRAFT_NO_ANSWER_RETRY_MS;
        } else if (e instanceof BasisApiError && e.status === 429 && e.code === 'job_running' && lost
            && typeof (e.body as { jobId?: unknown } | null)?.jobId === 'string'
            && DRAFT_JOB_ID.test((e.body as { jobId: string }).jobId)) {
          adopted = e;
          break;
        } else if (e instanceof BasisApiError && e.status === 429 && e.code === 'gate_busy') {
          wait = draftRetryMs(e, DRAFT_BUSY_RETRY_MS);
        } else if (e instanceof BasisApiError && e.status === 429 && e.code === 'cooldown') {
          wait = draftRetryMs(e, DRAFT_COOLDOWN_MAX_MS);
          if (wait > DRAFT_COOLDOWN_MAX_MS) throw e;
        } else {
          throw e;
        }
        if (Date.now() + wait + DRAFT_START_MIN_LEFT_MS >= deadline) throw e;
        await draftPause(wait, what, signal);
      }
    }

    let job: DraftJob<DraftResultByKind[K]>;
    let gap: number;
    let next: number;
    if (adopted) {
      job = { id: (adopted.body as { jobId: string }).jobId, kind, status: 'running', elapsedMs: 0 };
      gap = minGap;
      next = Date.now();
    } else {
      const started = start as Partial<DraftJobStart<DraftResultByKind[K]>> | null;
      if (!started || typeof started !== 'object' || !isDraftJob(started.job)) return start as DraftResultByKind[K];
      job = started.job as DraftJob<DraftResultByKind[K]>;
      const hint = Number(started.pollAfterMs);
      const first = Number.isFinite(hint) && hint > 0 ? Math.min(hint, MAX_TIMEOUT_MS) : 0;
      gap = Math.max(minGap, first);
      next = Date.now() + first;
    }
    try {
      while (job.status === 'running') {
        if (next >= deadline) {
          await this.cancelDraftQuietly(job.id);
          throw new BasisApiError(0, 'timeout', `${what}: the AI draft was still running after ${total} ms, so it was ` +
            'cancelled. Start it again with a longer timeoutMs, or split draftMarket into draftMarketHeadline + ' +
            'draftMarketAnswers.', job);
        }
        await draftPause(next - Date.now(), what, signal);
        const asked = Date.now();
        next = asked + gap;
        try {
          const bound = Math.max(1_000, Math.min(this.timeoutFor({}), deadline - asked));
          const r = await this.withOptions({ timeoutMs: bound }).draftJobRequest<DraftResultByKind[K]>('GET', job.id);
          if (!r || !isDraftJob(r.job)) throw new BasisApiError(200, null, `${what}: the job check answered no job`, r);
          job = r.job;
        } catch (e) {
          if (e instanceof BasisApiError && e.code === 'aborted') throw e;
          if (noAnswer(e)) {
            next = Math.max(next, Date.now() + Math.max(gap, DRAFT_NO_ANSWER_RETRY_MS));
            continue;
          }
          if (!(e instanceof BasisApiError)) throw e;
          const passing = e.status === 429 || (e.status >= 500 && e.code !== 'gate_disabled');
          if (!passing) throw e;
          next = Math.max(next, Date.now() + draftRetryMs(e, gap));
        }
        if (adopted && job.kind !== kind) throw adopted;
      }
    } catch (e) {
      if (e instanceof BasisApiError && e.code === 'aborted') await this.cancelDraftQuietly(job.id);
      throw e;
    }

    if (job.status === 'done') {
      if (job.result && typeof job.result === 'object') return job.result;
      throw new BasisApiError(200, null, `${what}: the finished job carries no result`, job);
    }
    if (job.status === 'cancelled') {
      throw new BasisApiError(200, 'draft_cancelled', `${what}: the AI draft job was cancelled (cancelDraftJob, maybe ` +
        'from another client of this wallet).', job);
    }
    throw new BasisApiError(200, 'drafting_failed', `${what}: the AI draft ${job.status === 'failed' ? 'failed' : `ended as ${String(job.status)}`}` +
      ` (${job.error ?? 'no reason given'}). Start it again; draftMarketHeadline + draftMarketAnswers are two shorter ` +
      'calls than one draftMarket.', job);
  }

  /**
   * One drafting call: `async` goes out only when true (the plain call's body stays as declared); null fields are
   * absent (never sent as JSON null), as None in PY; params that are not an object, or with a key outside `keys` (the
   * call's own list), throw ValidationError('options') before any request; errors get a hint.
   */
  private async draftCall(path: string, params: object, keys: OptionKeys<any>): Promise<any> {
    const { async: given, ...rest } = withoutNulls(optsOf(params as Record<string, unknown>, keys));
    const background = given === undefined ? false : toBool(given, 'async');
    try {
      return await this.request('POST', path, { auth: AUTH, body: background ? { ...rest, async: true } : rest, kind: 'ai' });
    } catch (e) {
      throw withDraftHint(e);
    }
  }

  /** GET or DELETE /api/v1/markets/drafts/{jobId}; `timeoutMs` bounds this one request. */
  private async draftJobRequest<R>(method: 'GET' | 'DELETE', jobId: string, timeoutMs?: number): Promise<DraftJobResponse<R>> {
    const id = checkDraftJobId(jobId);
    try {
      return await this.request(method, `/api/v1/markets/drafts/${seg(id)}`, { auth: AUTH, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    } catch (e) {
      throw withDraftHint(e, e instanceof BasisApiError && e.status === 404 && e.code !== 'job_not_found' ? NO_DRAFT_JOBS_HINT : undefined);
    }
  }

  /** Cancels a job, ignoring the caller's AbortSignal (it may be the reason) and any error: best effort. */
  private async cancelDraftQuietly(jobId: string): Promise<void> {
    try {
      const view = this.withOptions();
      view._call = { ...view._call, signal: undefined };
      await view.draftJobRequest('DELETE', jobId);
    } catch {
    }
  }

  /**
   * POST /api/v1/markets/approve: ask BASIS to approve a market for the authenticated wallet. Key or session.
   *
   * Approved: pass `signed.*`, `deadline` and `signature` unchanged to `createMarket` on `verifyingContract`
   * (= `host`), from this wallet (`createMarket` does this for you, and re-checks the signature locally).
   * A rejection (HTTP 200) is returned with `approved: false`. A route error throws BasisApiError with its `code`
   * (`bad_body`, `seed_invalid`, `rate_limited_wallet`, `daily_wallet_cap`, `gate_busy`, `gate_disabled`, `signer_unset`, ...).
   * 503 `screening_slow`: the review is still running and caches its verdict, so send the same market again after
   * `retryAfter` seconds (`retryAfterMs` in the body). This wrapper does not retry.
   * Each approval is single-use; rate limits apply per wallet and per day.
   *
   * `endTime` (unix seconds, 0 = open-ended, the default) is always sent: the route requires it and signs it into
   * `contentHash`, so it must equal the `endTime` given to `createMarket`. The answer's `signed` carries it. It must
   * be a whole number (ValidationError('endTime') otherwise), and `outcomes` an array (ValidationError('outcomes')),
   * both before any request. `seedAmount` (raw pair-asset units) and `privateEvent` go only with `main`; when given
   * they are checked before any request either way: `seedAmount` a whole number (ValidationError('seedAmount')),
   * `privateEvent` true or false (ValidationError('privateEvent')). null is absent, as None in PY (`description` too).
   * `name`, `symbol` and every outcome are signed into `contentHash`, so each must be well-formed text (no lone
   * surrogate): ValidationError('name' / 'symbol' / 'outcomes') before any request.
   */
  async approveMarket(params: ApproveMarketParams): Promise<MarketApprovalResponse> {
    const p = optsOf(params, APPROVE_MARKET_KEYS);
    checkOutcomes(p.outcomes);
    checkText(p.name, 'name');
    checkText(p.symbol, 'symbol');
    for (const o of p.outcomes) checkText(o, 'outcomes');
    const seedAmount = p.seedAmount == null ? undefined : toUint(p.seedAmount, 'seedAmount');
    const privateEvent = p.privateEvent == null ? undefined : toBool(p.privateEvent, 'privateEvent');
    const body: Record<string, unknown> = {
      marketType: p.marketType,
      name: p.name,
      symbol: p.symbol,
      outcomes: p.outcomes,
      endTime: endTimeNumber(p.endTime),
    };
    if (p.description != null) body.description = p.description;
    if (p.main) {
      body.main = p.main;
      if (seedAmount !== undefined) body.seedAmount = seedAmount.toString();
      if (privateEvent !== undefined) body.privateEvent = privateEvent;
    }

    const json = await this.request<any>('POST', '/api/v1/markets/approve', { auth: AUTH, body, kind: 'ai' });
    if (!json || typeof json !== 'object') {
      throw new BasisApiError(200, null, 'POST /api/v1/markets/approve failed [200]: the answer is not a JSON object', json);
    }
    if (json.approved !== true) {
      return {
        approved: false,
        decision: 'reject',
        category: json.category ?? undefined,
        reason: json.reason ?? undefined,
        escalated: json.escalated,
        model: json.model,
        cached: json.cached,
      };
    }
    return {
      approved: true,
      decision: 'approve',
      marketType: json.marketType ?? p.marketType,
      signed: {
        name: String(json.signed?.name),
        symbol: String(json.signed?.symbol),
        outcomes: (json.signed?.outcomes ?? []).map(String),
        ...(json.signed?.endTime !== undefined && json.signed?.endTime !== null ? { endTime: json.signed.endTime } : {}),
      },
      signature: json.signature,
      deadline: BigInt(json.deadline),
      contentHash: json.contentHash,
      verifyingContract: json.verifyingContract,
      signer: json.moderator,
      chainId: typeof json.chainId === 'number' ? json.chainId : undefined,
      host: json.host,
      escalated: json.escalated,
      model: json.model,
    };
  }
}
