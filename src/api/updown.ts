import { ValidationError } from '../core/errors';
import { ApiCore, seg } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { Cursor, Pagination, RawAmount, UsdE18, UsdSource } from './types';

/** Timeframe slug: 5m, 15m, 1h, 4h, 24h (= tf 0..4). */
export type UpDownTfSlug = '5m' | '15m' | '1h' | '4h' | '24h';
/** Timeframe: numeric 0..4 or its slug. */
export type UpDownTf = 0 | 1 | 2 | 3 | 4 | UpDownTfSlug;
/** An asset as the API takes it: its slug or its index (both from `getUpDownAssets()`). */
export type UpDownAssetParam = string | number;
export type UpDownSideStr = 'bull' | 'bear';
export type UpDownOutcomeStr = 'pending' | 'bull_wins' | 'bear_wins' | 'canceled';
/** Index state of a round: a round closed on chain stays awaiting_* until it is synced. */
export type UpDownRoundStatus = 'live' | 'awaiting_settle' | 'awaiting_cancel' | 'settled' | 'canceled';

const TF_SLUGS: readonly string[] = ['5m', '15m', '1h', '4h', '24h'];
const INT32_MAX = 2147483647;

function checkAsset(token: unknown): void {
  const ok = typeof token === 'number'
    ? Number.isInteger(token) && token >= 0 && token <= INT32_MAX
    : typeof token === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(token);
  if (!ok) throw new ValidationError('token', `token must be an asset slug or asset index (got ${JSON.stringify(token)})`);
}
function checkTf(tf: unknown): void {
  const ok = typeof tf === 'number'
    ? Number.isInteger(tf) && tf >= 0 && tf <= 4
    : typeof tf === 'string' && TF_SLUGS.includes(tf);
  if (!ok) throw new ValidationError('tf', `tf must be 0-4 or one of ${TF_SLUGS.join(', ')} (got ${JSON.stringify(tf)})`);
}
function checkRoundId(roundId: unknown): void {
  const n = typeof roundId === 'bigint' ? Number(roundId) : roundId;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > INT32_MAX) {
    const got = typeof roundId === 'bigint' ? String(roundId) : JSON.stringify(roundId);
    throw new ValidationError('roundId', `roundId must be an integer 1-${INT32_MAX} (got ${got})`);
  }
}

/** One timeframe of the deployment. */
export interface UpDownTimeframeInfo {
  slug: UpDownTfSlug;
  tf: number;
  durationSec: number;
}

/** One configured asset, joined with its indexed listing (`listed: false` and null fields before that). */
export interface UpDownAssetRow {
  slug: string;
  label: string;
  ticker: string;
  /** Asset index on the Up/Down contract. */
  asset: number;
  enabled: boolean;
  /** The asset's listing is indexed. */
  listed: boolean;
  /** Why the indexed row disagrees with the config (the market is switched off); null when it matches. */
  mismatch: string | null;
  mainKey: string;
  main: string | null;
  /** Settle asset (= pairAsset): payouts are paid in it. */
  settle: string | null;
  pairAsset: string | null;
  pairSymbol: string | null;
  pairDecimals: number | null;
  poolToken: string | null;
  priceFeed: string | null;
  paused: boolean | null;
  /** The feed's decimals; null until read. */
  priceDecimals: number | null;
  /** The asset's odds-floor setting (it sets the minimum stake), pool-token wei; null until read. */
  virtFloor: RawAmount | null;
  /** The smallest net stake accepted, pool-token wei; null until read. */
  minStakePoolTokens: RawAmount | null;
}

export interface UpDownAssets {
  /** The Up/Down contract address. */
  contract: string;
  timeframes: UpDownTimeframeInfo[];
  assets: UpDownAssetRow[];
}

/** Activity of one asset x timeframe. USD at bet / claim time, null unless every row is priced. */
export interface UpDownStatsRow {
  /** Asset slug. */
  token: string;
  asset: number;
  tf: number;
  timeframe: UpDownTfSlug;
  main: string;
  /** Settle asset: the unit of `paidOut`. */
  settle: string;
  pairDecimals: number;
  pairSymbol: string;
  volumeUsdE18: UsdE18;
  usdSource: UsdSource;
  usdCovered: number;
  bets: number;
  volume24hUsdE18: UsdE18;
  volume24hUsdSource: UsdSource;
  usdCovered24h: number;
  bets24h: number;
  /** Distinct wallets that bet (all time). */
  bettors: number;
  rounds: number;
  roundsPlayed: number;
  bullWins: number;
  bearWins: number;
  /** Settled rounds nobody won (every bet refunded). */
  noWinner: number;
  canceled: number;
  pending: number;
  /** Every claim (wins and refunds), raw settle-asset units. */
  paidOut: RawAmount;
  paidOutUsdE18: UsdE18;
  paidOutUsdSource: UsdSource;
  paidOutUsdCovered: number;
  claims: number;
}

export interface UpDownStats {
  contract: string;
  /** Unix seconds: when the figures were computed (cached 60 s). */
  asOf: number;
  data: UpDownStatsRow[];
}

/** A round as indexed. Times are unix seconds. */
export interface UpDownRoundRow {
  /** The Up/Down contract address (`asset` identifies the market). */
  contract: string;
  asset: number;
  main: string;
  /** Settle asset (= pairAsset): payouts are paid in it. */
  settle: string;
  pairAsset: string;
  /** Stakes, pools, shares and seed are amounts of it. */
  poolToken: string;
  pairDecimals: number;
  pairSymbol: string;
  /** 0=5m, 1=15m, 2=1h, 3=4h, 4=24h. */
  tf: number;
  roundId: number;
  startTime: number;
  endTime: number;
  /** Null until settled or canceled in the index. */
  settledAt: number | null;
  /** Raw feed answer: divide by 10^priceDecimals. */
  startPrice: string;
  /** Raw feed answer; null on a canceled round. */
  endPrice: string | null;
  priceFeed: string;
  priceDecimals: number | null;
  endPriceRoundId: string | null;
  /** Pool-token wei. */
  bullPool: RawAmount;
  bearPool: RawAmount;
  sharesBull: RawAmount;
  sharesBear: RawAmount;
  seedBonus: RawAmount;
  outcome: UpDownOutcomeStr;
  status: UpDownRoundStatus;
  /** Settled with nobody on the winning side: the outcome stands, every bet is refunded. */
  noWinner: boolean;
  settler: string | null;
}

export interface UpDownRoundsParams {
  /** Required: asset slug or index. */
  token: UpDownAssetParam;
  tf?: UpDownTf;
  outcome?: UpDownOutcomeStr;
  /** Only no-winner (true) or only other (false) rounds. */
  noWinner?: boolean;
  /** `pagination.nextCursor` of the previous page (a roundId, or `<tf>:<roundId>` without a tf filter). */
  cursor?: string | null;
  /** 1..100, default 20. */
  limit?: number;
}
const UPDOWN_ROUNDS_KEYS = optionKeys<UpDownRoundsParams>({ token: true, tf: true, outcome: true, noWinner: true, cursor: true, limit: true });

export interface UpDownRoundsList {
  /** Asset slug. */
  token: string;
  asset: number;
  /** `{ "<tf>": highest indexed roundId }`: tells "not indexed yet" from "not created yet". */
  latestIndexed: Record<string, number | null>;
  rounds: UpDownRoundRow[];
  pagination: Pagination;
}

/** Cursor paging of the history lists (`blockNumber:logIndex`). */
export interface UpDownPageParams {
  cursor?: Cursor | null;
  /** 1..100, default 20. */
  limit?: number;
}
const UPDOWN_PAGE_KEYS = optionKeys<UpDownPageParams>({ cursor: true, limit: true });

/** Options of `getUpDownStats`: one asset and / or one timeframe (default every one). */
export interface UpDownStatsParams {
  token?: UpDownAssetParam;
  tf?: UpDownTf;
}
const UPDOWN_STATS_KEYS = optionKeys<UpDownStatsParams>({ token: true, tf: true });

export interface UpDownSideBets {
  /** Distinct wallets. */
  bettors: number;
  /** Pool-token wei (= stake). */
  stakePoolTokens: RawAmount;
  sharesTotal: RawAmount;
  stake: RawAmount;
}

/** A gross amount paid in one input token (raw input-token units). */
export interface UpDownPaid {
  inputToken: string;
  amount: RawAmount;
}

export interface UpDownRoundBets {
  totalEvents: number;
  /** A wallet that bet both sides counts once. */
  distinctBettors: number;
  bull: UpDownSideBets;
  bear: UpDownSideBets;
  paidByToken: UpDownPaid[];
  /** USD of the gross paid amounts at bet time. */
  paidUsdE18: UsdE18;
  usdSource: UsdSource;
  stakeUsdCovered: number;
}

export interface UpDownRoundClaims {
  total: number;
  events: number;
  /** Distinct wallets that claimed a win. */
  won: number;
  refunded: number;
  fullyClaimed: number;
  /** Raw settle-asset units. */
  totalPayout: RawAmount;
  amountUsdE18: UsdE18;
  usdSource: UsdSource;
  amountUsdCovered: number;
}

/** One bet of a round (`placedAt` ISO 8601). */
export interface UpDownBettor {
  user: string;
  side: UpDownSideStr;
  inputToken: string | null;
  /** Raw inputToken units; null on rows indexed before the column. */
  paid: RawAmount | null;
  /** Pool-token wei. */
  stake: RawAmount;
  shares: RawAmount;
  fee: RawAmount | null;
  paidUsdE18: UsdE18;
  usdSource: UsdSource;
  claimed: boolean;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  placedAt: string;
}

/** Carryover captured from the round, pool-token wei. */
export interface UpDownCarry {
  /** `unknown`: a kind the index does not name yet. */
  kind: 'loser_cut' | 'seed_excess' | 'seed_rolled' | 'unknown';
  amount: RawAmount;
  txHash: string;
}

export interface UpDownRoundDetail {
  /** Asset slug. */
  token: string;
  asset: number;
  round: UpDownRoundRow;
  bets: UpDownRoundBets;
  claims: UpDownRoundClaims;
  /** Cursor-paged bettor list (`cursor` / `limit` of getUpDownRound). */
  bettors: { data: UpDownBettor[]; pagination: Pagination };
  carry: UpDownCarry[];
}

/** One (asset, tf, round) position of a wallet. Stakes are pool-token wei. */
export interface UpDownPosition {
  /** Asset slug ("unknown" when the asset is not indexed). */
  token: string;
  contract: string;
  asset: number | null;
  main: string | null;
  settle: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  tf: number;
  roundId: number;
  side: UpDownSideStr;
  /** Net of the fee. */
  stake: RawAmount;
  stakePoolTokens: RawAmount;
  /** Gross amounts paid, per input token. */
  paid: UpDownPaid[];
}

export interface UpDownActiveBet extends UpDownPosition {
  /** ISO 8601: first bet of the position. */
  placedAt: string;
  /** ISO 8601; null while the round is not indexed (read `getRound` on chain). */
  endTime: string | null;
}

/** Won or refunded position not fully claimed. The payout is `client.updown.quoteClaimPayout(...)` on chain. */
export interface UpDownClaimableBet extends UpDownPosition {
  outcome: Exclude<UpDownOutcomeStr, 'pending'>;
  refund: boolean;
  partlyClaimed: boolean;
  remainingPoolTokens: RawAmount | null;
}

export interface UpDownStakeByAsset {
  /** Asset slug. */
  token: string;
  asset: number | null;
  poolToken: string | null;
  amount: RawAmount;
}

export interface UpDownPayoutBySettle {
  settle: string | null;
  pairAsset: string | null;
  pairSymbol: string | null;
  pairDecimals: number | null;
  /** Raw settle-asset units. */
  amount: RawAmount;
}

export interface UpDownNetBySettle {
  settle: string;
  pairSymbol: string | null;
  pairDecimals: number | null;
  /** Signed raw settle-asset units. */
  amount: string;
  positions: number;
}

/** Claimable positions per settle asset (no amounts). `pairSymbol` / `pairDecimals` null when the main is unknown. */
export interface UpDownUnclaimed {
  settle: string;
  pairAsset: string;
  pairSymbol: string | null;
  pairDecimals: number | null;
  positions: number;
}

/**
 * One history row (bet / won / refund); `time` ISO 8601. The API sends the bet-only fields (`side`, `inputToken`,
 * `paid`, `shares`, `fee`, `valueUsdE18`) on bet rows only and the claim-only fields (`payout`, `settle`,
 * `pairDecimals`, `tokens`, `remaining`, `amountUsdE18`) on won / refund rows only: absent on the other type.
 */
export interface UpDownHistoryRow {
  type: 'bet' | 'won' | 'refund';
  txHash: string;
  blockNumber: number;
  logIndex: number;
  time: string;
  /** Asset slug. */
  token: string;
  asset: number | null;
  tf: number;
  roundId: number;
  /** Pool-token wei (net of the fee on bet rows). */
  stake: RawAmount | null;
  /** Of `valueUsdE18` on bet rows, of `amountUsdE18` on claim rows. */
  usdSource: UsdSource;
  /** Bet rows only. */
  side?: UpDownSideStr | null;
  /** Bet rows only; null on rows indexed before the column. */
  inputToken?: string | null;
  /** Bet rows only: gross, raw input-token units; null on rows indexed before the column. */
  paid?: RawAmount | null;
  /** Bet rows only, pool-token wei. */
  shares?: RawAmount | null;
  /** Bet rows only, pool-token wei. */
  fee?: RawAmount | null;
  /** Bet rows only: USD of `paid` at bet time. */
  valueUsdE18?: UsdE18;
  /** Claim rows only: raw settle-asset units. */
  payout?: RawAmount | null;
  /** Claim rows only. */
  settle?: string | null;
  /** Claim rows only. */
  pairDecimals?: number | null;
  /** Claim rows only: pool-token wei sold by this claim / still owed after it. */
  tokens?: RawAmount | null;
  remaining?: RawAmount | null;
  /** Claim rows only: USD of `payout` at claim time. */
  amountUsdE18?: UsdE18;
}

/** The Up/Down record of a wallet (getMyUpDown / getWalletUpDown). */
export interface UpDownRecord {
  /** Lower-case address. */
  wallet: string;
  totalBetEvents: number;
  distinctRoundsBet: number;
  /** Sums wei across different pool tokens (legacy): use `stakes` or `stakeUsdE18`. */
  totalStake: RawAmount;
  stakes: UpDownStakeByAsset[];
  stakeUsdE18: UsdE18;
  stakeUsdSource: UsdSource;
  stakeUsdCovered: number;
  payouts: UpDownPayoutBySettle[];
  payoutUsdE18: UsdE18;
  payoutUsdSource: UsdSource;
  payoutUsdCovered: number;
  /** Closed positions: payout USD less paid USD. */
  netUsdE18: UsdE18;
  netUsdSource: UsdSource;
  netBySettle: UpDownNetBySettle[];
  wins: number;
  losses: number;
  refunds: number;
  activeBetsCount: number;
  claimableCount: number;
  activeBets: UpDownActiveBet[];
  /** Unpaged. */
  claimableBets: UpDownClaimableBet[];
  unclaimed: UpDownUnclaimed[];
  /** Cursor-paged (`cursor` / `limit`). */
  history: { data: UpDownHistoryRow[]; pagination: Pagination };
  /**
   * The wallet has more than 50,000 bets or claims: the summary, active bets and claimable list cover the newest
   * 50,000 of each. The paged history is not cut.
   */
  summaryCapped?: boolean;
}

export class UpDownApi extends ApiCore {
  /** GET /api/v1/updown/assets: the deployment's assets and timeframes (the source of slugs / indexes). API key. */
  async getUpDownAssets(): Promise<UpDownAssets> {
    return this.request('GET', '/api/v1/updown/assets', { auth: 'key' });
  }

  /**
   * GET /api/v1/updown/stats: activity per asset x timeframe (cached 60 s). Defaults: every listed asset, every
   * timeframe. API key.
   */
  async getUpDownStats(params: UpDownStatsParams = {}): Promise<UpDownStats> {
    const { token, tf }: UpDownStatsParams = optsOf(params, UPDOWN_STATS_KEYS);
    if (token != null) checkAsset(token);
    if (tf != null) checkTf(tf);
    return this.request('GET', '/api/v1/updown/stats', { auth: 'key', query: { token, tf } });
  }

  /**
   * GET /api/v1/updown/rounds: indexed rounds of one asset, newest first per timeframe. API key; cursor paged, rows in
   * `rounds`: `api.paginate(async (p: UpDownRoundsParams) => { const r = await api.getUpDownRounds(p);
   * return { data: r.rounds, pagination: r.pagination }; }, { token: 'btc' })`.
   */
  async getUpDownRounds(params: UpDownRoundsParams): Promise<UpDownRoundsList> {
    const p = optsOf(params, UPDOWN_ROUNDS_KEYS);
    checkAsset(p.token);
    if (p.tf != null) checkTf(p.tf);
    const { token, tf, outcome, noWinner, cursor, limit } = p;
    return this.request('GET', '/api/v1/updown/rounds', {
      auth: 'key', query: { token, tf, outcome, noWinner, cursor, limit },
    });
  }

  /**
   * GET /api/v1/updown/rounds/{token}/{tf}/{roundId}: one indexed round with bet / claim aggregates, its carryover and
   * a cursor-paged bettor list (`bettors`). API key. 404 `not_indexed` while the round is not indexed. Page the
   * bettors with `api.paginate((p: UpDownPageParams) => api.getUpDownRound(token, tf, id, p).then((r) => r.bettors))`.
   */
  async getUpDownRound(
    token: UpDownAssetParam,
    tf: UpDownTf,
    roundId: bigint | number,
    params: UpDownPageParams = {},
  ): Promise<UpDownRoundDetail> {
    const p = optsOf(params, UPDOWN_PAGE_KEYS);
    checkAsset(token);
    checkTf(tf);
    checkRoundId(roundId);
    return this.request('GET', `/api/v1/updown/rounds/${seg(token)}/${seg(tf)}/${seg(roundId)}`, {
      auth: 'key', query: { cursor: p.cursor, limit: p.limit },
    });
  }

  /**
   * GET /api/v1/me/updown: the Up/Down record of the authenticated wallet (summary, active and claimable bets,
   * history). Key or session; `history` is cursor paged:
   * `api.paginate((p: UpDownPageParams) => api.getMyUpDown(p).then((r) => r.history))`.
   * Payouts of `claimableBets` are quoted on chain (`client.updown.quoteClaimPayout`).
   */
  async getMyUpDown(params: UpDownPageParams = {}): Promise<UpDownRecord> {
    const p = optsOf(params, UPDOWN_PAGE_KEYS);
    return this.request('GET', '/api/v1/me/updown', {
      auth: 'keyOrSession', query: { cursor: p.cursor, limit: p.limit },
    });
  }

  /** GET /api/v1/wallet/{address}/updown: a wallet's Up/Down record (as getMyUpDown). API key; history cursor paged. */
  async getWalletUpDown(address: string, params: UpDownPageParams = {}): Promise<UpDownRecord> {
    const p = optsOf(params, UPDOWN_PAGE_KEYS);
    return this.request('GET', `/api/v1/wallet/${seg(address)}/updown`, {
      auth: 'key', query: { cursor: p.cursor, limit: p.limit },
    });
  }
}
