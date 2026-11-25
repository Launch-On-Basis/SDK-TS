import { ValidationError } from '../core/errors';
import { ApiCore, seg } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { Cursor, CursorPage, E18, Pagination, PublicPersonRef, RawAmount, UsdE18, UsdSource } from './types';

/** A USD source name (the non-null UsdSource values). */
export type UsdSourceName = NonNullable<UsdSource>;

/** A sum over priced rows: `totalUsdE18` is null unless every row is priced. */
export interface WalletUsdTotal {
  totalUsdE18?: UsdE18;
  usdCovered?: number;
  n?: number;
  usdSources?: UsdSourceName[];
}

/**
 * Offset paging (`pagination.page` / `total`): `offset` wins over `page` and is rounded down to a page start (a
 * multiple of limit); limit 1..100.
 */
export interface WalletPageParams {
  page?: number;
  offset?: number;
  limit?: number;
}
const WALLET_PAGE_KEYS = optionKeys<WalletPageParams>({ page: true, offset: true, limit: true });

/** A time window: unix seconds (ISO 8601 strings are accepted too). Default: the beginning .. now. */
export interface WalletWindowParams {
  from?: number | string;
  to?: number | string;
}
const WALLET_WINDOW_KEYS = optionKeys<WalletWindowParams>({ from: true, to: true });


export type WalletTransactionType = 'buy' | 'sell' | 'leverage_buy' | 'leverage_sell';

/** What a trade leg is (`protocol` legs are never listed on a wallet). */
export type WalletLegRole =
  | 'trade' | 'route_hop' | 'cross_leg' | 'leverage_open' | 'leverage_exit' | 'loan_exit' | 'liquidation' | 'protocol'
  | 'convert';

/** `legRole` filter values: WalletLegRole without `protocol`. */
export type WalletLegRoleFilter = Exclude<WalletLegRole, 'protocol'>;

export interface WalletTransactionsParams {
  /** `pagination.nextCursor` of the previous page. */
  cursor?: Cursor;
  /** 1..100, default 20. */
  limit?: number;
  type?: WalletTransactionType;
  /** `all`: also the hop leg of routed trades. */
  legs?: 'all';
  /** Only legs of this role (replaces the default, which leaves out route_hop). */
  legRole?: WalletLegRoleFilter;
  /** A main key (e.g. `stasis-usdg`) or main address. */
  main?: string;
}
const WALLET_TRANSACTIONS_KEYS = optionKeys<WalletTransactionsParams>({ cursor: true, limit: true, type: true, legs: true, legRole: true, main: true });

/** One AMM leg of a wallet (spec `Trade` plus `userArg`). */
export interface WalletTransaction {
  id?: number;
  /** The token this leg trades. */
  contractAddress?: string;
  type?: WalletTransactionType;
  amountToken?: RawAmount;
  /** Raw units of `quoteAsset` (`quoteDecimals`). */
  amountQuote?: RawAmount;
  quoteAsset?: string | null;
  quoteDecimals?: number | null;
  user?: string;
  /** Whole pair-asset units per whole token x 1e18; null when the token's main is not configured. */
  priceE18?: E18 | null;
  main?: string | null;
  pairAsset?: string | null;
  pairDecimals?: number | null;
  pairSymbol?: string | null;
  /**
   * On a `trade` / `cross_leg` leg: the trade's USD before fees (the figure GET /api/v1/trades shows and the 24 h volume
   * sums); on any other leg the leg's own value (= legValueUsdE18).
   */
  valueUsdE18?: UsdE18;
  /** USD x 1e18 of this leg itself (a buy after the swap fee, a sell before it). */
  legValueUsdE18?: UsdE18;
  usdSource?: UsdSource;
  legRole?: WalletLegRole;
  tradeLogIndex?: number | null;
  isPresale?: boolean;
  userIsProtocol?: boolean;
  txHash?: string;
  logIndex?: number;
  blockNumber?: number;
  /** ISO 8601. */
  timestamp?: string;
  /** The account the chain records for the leg; it can differ from `user` (e.g. on a loan exit). */
  userArg?: string | null;
}


export interface WalletPairBalance {
  main?: string;
  mainKey?: string;
  pairAsset?: string;
  pairSymbol?: string;
  pairDecimals?: number;
  balanceRaw?: RawAmount;
  /** Whole units as an exact decimal string. */
  balance?: string;
  valueUsdE18?: UsdE18;
}

export interface WalletHolding {
  address?: string;
  symbol?: string | null;
  main?: string | null;
  isMain?: boolean;
  /** Raw balance (`decimals`, 18). */
  balanceWei?: RawAmount;
  /** Whole tokens as an exact decimal string. */
  balance?: string;
  pairAsset?: string | null;
  pairDecimals?: number | null;
  /** Raw pair units per whole token (latest synced price); null when unknown. */
  pricePairRaw?: RawAmount | null;
  priceUsdE18?: UsdE18;
  valueUsdE18?: UsdE18;
  /**
   * USD x 1e18 the bought tokens still held cost, `lockedFromTrades` included (average cost, after fees); "0" when the
   * ledger has no leg for the token; null when a leg has no USD or the history cannot be followed (a liquidation).
   */
  costBasisUsdE18?: UsdE18;
  /** USD x 1e18 realized by the bought part of the wallet's sells (may be negative); null when withheld. */
  realizedPnlUsdE18?: UsdE18;
  /** Bought tokens still held, wherever they sit; includes `lockedFromTrades`, which is not in `balance`. */
  heldFromTrades?: RawAmount;
  /** The part of heldFromTrades outside the wallet: still vesting, on a hub loan or staked in the vault. */
  lockedFromTrades?: RawAmount;
  decimals?: number;
}

/** A main's stored vault position net of its loan (pending rewards not counted). */
export interface WalletVaultLine {
  main?: string;
  vault?: string;
  /** Main tokens staked (18 decimals). */
  staked?: RawAmount;
  pledged?: RawAmount;
  hasActiveLoan?: boolean;
  /** Raw pair units; null while the vault loan is not synced. */
  debtRaw?: RawAmount | null;
  pairAsset?: string;
  pairDecimals?: number;
  valueUsdE18?: UsdE18;
}

export interface WalletLoanLine {
  id?: string;
  source?: 'hub' | 'leverage';
  main?: string;
  token?: string;
  collateralWei?: RawAmount;
  fullAmountRaw?: RawAmount;
  pairAsset?: string | null;
  pairDecimals?: number | null;
  netUsdE18?: UsdE18;
}

/** Unvested tokens of a stored schedule (token units, 18 decimals). */
export interface WalletVestingLine {
  vestingContract?: string;
  vestingId?: number;
  token?: string;
  main?: string | null;
  totalAmount?: RawAmount;
  claimedAmount?: RawAmount;
  /** totalAmount - claimedAmount. */
  remaining?: RawAmount;
  /** A vesting loan holds the vesting while non-zero. */
  activeLoanId?: number;
  /**
   * The vesting loan's debt, raw pair units of the vesting's main; null without a loan, or while the loan is not
   * synced.
   */
  loanDebtRaw?: RawAmount | null;
  /** USD of `remaining`, less the vesting loan's debt (floored at 0); null while that debt is unknown. */
  valueUsdE18?: UsdE18;
  usdSource?: UsdSource;
}

/** Prediction shares valued at the stored odds. */
export interface WalletPredictionLine {
  marketToken?: string;
  host?: string;
  hostKind?: 'public' | 'private' | null;
  main?: string | null;
  resolved?: boolean;
  /** Held outcomes only (18 decimals) with the stored odds. */
  shares?: Array<{ outcomeId?: number; shares?: RawAmount; probabilityE18?: E18 | null }>;
  /** Market-token wei; null when resolved or an odds value is unknown. */
  valueTokens?: RawAmount | null;
  valueUsdE18?: UsdE18;
  usdSource?: UsdSource;
}

/** An open Up/Down stake (round not settled in the index). */
export interface WalletUpDownStake {
  contract?: string;
  asset?: number | null;
  tf?: number;
  roundId?: number;
  main?: string | null;
  poolToken?: string | null;
  settleAsset?: string | null;
  settleDecimals?: number | null;
  status?: 'open';
  side?: 'bull' | 'bear';
  /** Pool-token wei, net of the fee. */
  stake?: RawAmount;
  shares?: RawAmount;
  /** Unix seconds; null while the round is not indexed. */
  endTime?: number | null;
  paidUsdE18?: UsdE18;
  usdSource?: UsdSource;
}

export interface WalletCostBasisToken {
  token?: string;
  heldFromTrades?: RawAmount;
  /** The part of heldFromTrades outside the wallet: still vesting, on a hub loan or staked in the vault. */
  lockedFromTrades?: RawAmount;
  costBasisUsdE18?: UsdE18;
  realizedPnlUsdE18?: UsdE18;
  buys?: number;
  sells?: number;
}

export interface WalletPortfolio {
  address?: string;
  /** Always true (the not-deployed case is a 503). */
  deployed?: boolean;
  pairBalances?: WalletPairBalance[];
  holdings?: WalletHolding[];
  vaults?: WalletVaultLine[];
  loans?: WalletLoanLine[];
  /** Not in the totals. */
  vesting?: WalletVestingLine[];
  holdingsCount?: number;
  /** USD x 1e18 of every priced line (spot, pair balances, vaults and loans net of debt). */
  totalUsdE18?: string;
  /** Lines with a balance and no USD price. */
  unpriced?: number;
  note?: string;
  /** Not in the totals (most recent 50 markets). */
  predictions?: WalletPredictionLine[];
  /** True when the wallet has more markets than `predictions` lists. */
  predictionsTruncated?: boolean;
  /** Not in the totals (most recent 50 open rounds). */
  updown?: WalletUpDownStake[];
  /** True when the wallet has more open rounds than `updown` lists. */
  updownTruncated?: boolean;
  costBasis?: { tokens?: WalletCostBasisToken[]; realizedPnlUsdE18?: UsdE18; note?: string };
}


export interface WalletFeesParams extends WalletWindowParams {
  /** One row per asset and fee category. */
  byCategory?: boolean;
}
const WALLET_FEES_KEYS = optionKeys<WalletFeesParams>({ from: true, to: true, byCategory: true });

export interface WalletFeeRow {
  /** Null while the unit is not known yet; the zero address is the native coin. */
  pairAsset?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  nativeCoin?: boolean;
  /** Only with byCategory. */
  category?: string;
  fees?: RawAmount;
  baseFees?: RawAmount;
  retained?: RawAmount;
  feesUsdE18?: UsdE18;
  usdSource?: UsdSource;
  usdCovered?: number;
  n?: number;
}

export interface WalletFees {
  wallet?: string;
  /** ISO 8601 window applied. */
  from?: string;
  to?: string;
  data?: WalletFeeRow[];
  total?: WalletUsdTotal;
  relayUnresolved?: WalletFeeRow[];
  nativeCoinCategories?: string[];
}

export interface WalletEarningRow {
  /** Null while the unit is not known yet. */
  pairAsset?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  amount?: RawAmount;
  amountUsdE18?: UsdE18;
  usdSource?: UsdSource;
  usdCovered?: number;
  n?: number;
}

export interface WalletEarnings {
  wallet?: string;
  /** ISO 8601 window applied. */
  from?: string;
  to?: string;
  data?: WalletEarningRow[];
  total?: WalletUsdTotal;
  byToken?: Array<WalletEarningRow & { token?: string }>;
  /** Creator shares sent to the protocol instead: earned by nobody. */
  redirected?: WalletEarningRow[];
  holderRewards?: Array<WalletEarningRow & { token?: string; main?: string | null }>;
  holderRewardsTotal?: WalletUsdTotal;
}


export interface WalletReferralsParams extends WalletWindowParams, WalletPageParams {
  /** Levels 1..5, default 2. */
  depth?: number;
}
const WALLET_REFERRALS_KEYS = optionKeys<WalletReferralsParams>({ from: true, to: true, page: true, offset: true, limit: true, depth: true });

export interface ReferralAssetAmount {
  pairAsset?: string | null;
  pairDecimals?: number | null;
  symbol?: string | null;
  amount?: RawAmount;
  amountUsdE18?: UsdE18;
  usdSource?: UsdSource;
  usdCovered?: number;
  n?: number;
}

export interface OnchainReferral {
  wallet?: string;
  referrer?: string;
  level?: number;
  earned?: Array<ReferralAssetAmount & { amountL1?: RawAmount | null; amountL2?: RawAmount | null }>;
  feesGenerated?: Array<ReferralAssetAmount & { viaRelay?: number }>;
}

/** The on-chain fee referral of a wallet. */
export interface OnchainReferrals {
  referrer?: string | null;
  directCount?: number;
  indirectCount?: number;
  /** ISO 8601 window applied. */
  from?: string;
  to?: string;
  depth?: number;
  earnings?: Array<ReferralAssetAmount & { level?: number; wallets?: number }>;
  earningsTotal?: WalletUsdTotal;
  /**
   * Referral payouts meant for this wallet that it could not receive, sent to the protocol instead, per pair asset
   * over the window. Not earned: never in `earnings`.
   */
  redirected?: ReferralAssetAmount[];
  /** USD total of `redirected` (totalUsdE18 null unless every row is priced). */
  redirectedTotal?: WalletUsdTotal;
  /** The newest 100 redirect records of the window, newest first (`redirectsTruncated` when there are more). */
  redirects?: ReferralRedirect[];
  /** True when the window holds more than 100 redirect records (all are in getWalletActivity types `referral`). */
  redirectsTruncated?: boolean;
  referrals?: OnchainReferral[];
  referralsPagination?: Pagination;
}

/** One redirected referral payout (`onchain.redirects`): raw `amount` in `pairAsset` units. */
export interface ReferralRedirect {
  /** The token whose fee paid the referral. */
  token?: string;
  pairAsset?: string | null;
  pairDecimals?: number | null;
  symbol?: string | null;
  amount?: RawAmount;
  amountUsdE18?: UsdE18;
  usdSource?: UsdSource;
  /** Where the payout went: the protocol (its address is not served). */
  sentTo?: 'platform';
  txHash?: string;
  blockNumber?: number;
  logIndex?: number;
  /** Unix seconds (block time). */
  time?: number;
}

export interface WalletReferrals {
  wallet?: string;
  /** Null when on-chain referrals are not live on this network. */
  onchain?: OnchainReferrals | null;
  points?: { hasReferrer?: boolean; directCount?: number; indirectCount?: number; pointsStale?: boolean };
}

export interface MyReferrals {
  wallet?: string;
  /** Null when on-chain referrals are not live on this network. */
  onchain?: OnchainReferrals | null;
  referrer?: { wallet?: string; username?: string | null } | null;
  directCount?: number;
  indirectCount?: number;
  /** joinedAt: ISO 8601 (the block time the referrer was set). */
  referrals?: Array<{ wallet?: string; username?: string | null; layer?: number; joinedAt?: string }>;
}


export type ActivityRowType =
  | 'trade' | 'swap' | 'prediction' | 'book_fill' | 'loan' | 'vault' | 'vesting' | 'market' | 'referral' | 'updown'
  | 'fee' | 'creator_payout' | 'reward_claim' | 'transfer' | 'create' | 'liquidation';

/** Activity `types` filter values: ActivityRowType without `liquidation` (only on GET /tx/{hash}). */
export type ActivityFilterType = Exclude<ActivityRowType, 'liquidation'>;

export interface WalletActivityParams {
  /** Default all (liquidation rows are only on GET /tx/{hash}). Sent as a comma list. */
  types?: ActivityFilterType | readonly ActivityFilterType[];
  cursor?: Cursor;
  /** 1..100, default 20. */
  limit?: number;
}
const WALLET_ACTIVITY_KEYS = optionKeys<WalletActivityParams>({ types: true, cursor: true, limit: true });

/** One indexed row of any table (raw amounts with their asset and decimals). */
export interface ActivityRow {
  type?: ActivityRowType;
  action?: string;
  table?: string;
  txHash?: string;
  blockNumber?: number;
  logIndex?: number;
  /** ISO 8601. */
  time?: string;
  user?: string | null;
  token?: string | null;
  main?: string | null;
  amounts?: Array<{ role?: string; value?: RawAmount; asset?: string | null; decimals?: number | null }>;
  valueUsdE18?: UsdE18;
  usdSource?: UsdSource;
  /**
   * Table-specific fields (keys vary by type and action), e.g. referral `referral_paid {trader, level}`,
   * `referral_redirected {sentTo: 'platform', feeLogIndex}` (a payout the wallet could not receive, sent to the protocol:
   * not earned), `referrer_set {referrer}`; create `{kind}` (action `token_created` | `market_created`; a market's row
   * carries its seed in `amounts`, role `seed`, and the seed's USD in `valueUsdE18`).
   */
  details?: Record<string, unknown> | null;
}

export type IndexedTxStatus = 'synced' | 'partial' | 'reverted' | 'ignored' | 'dropped' | 'not_synced';

/** What the index holds for one transaction. */
export interface IndexedTx {
  txHash: string;
  status: IndexedTxStatus;
  blockNumber: number | null;
  /** ISO 8601 block time; null when not_synced. */
  time: string | null;
  from: string | null;
  to: string | null;
  basisLogs: number | null;
  confirmed: boolean | null;
  lastSyncedAt: string | null;
  rows: ActivityRow[];
}


/** Counts and totals of a wallet (also GET /me/stats). */
export interface WalletSummary {
  wallet?: string;
  trades?: number;
  volumeUsdE18?: UsdE18;
  volumeUsdCovered?: number;
  volumeN?: number;
  volumeUsdSources?: UsdSourceName[];
  feesPaidUsdE18?: UsdE18;
  feesPaidUsdCovered?: number;
  feesPaidN?: number;
  feesPaidUsdSources?: UsdSourceName[];
  referralEarnedUsdE18?: UsdE18;
  referralEarnedUsdCovered?: number;
  referralEarnedN?: number;
  referralEarnedUsdSources?: UsdSourceName[];
  tokensCreated?: number;
  marketsCreated?: number;
  /** time: ISO 8601. */
  firstSeen?: { time?: string; blockNumber?: number; txHash?: string } | null;
  agent?: { agentId?: number | null; name?: string | null; description?: string | null } | null;
  totalTrades?: number;
  buys?: number;
  sells?: number;
  crossSwaps?: number;
  leverageOpens?: number;
  loanSells?: number;
  totalPredictions?: number;
  bookFills?: number;
  upDownBets?: number;
  totalLoans?: number;
  activeLoans?: number;
  marketWins?: number;
  daysActive?: number;
}

export interface WalletProjectToken {
  address?: string;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  /** ISO 8601. */
  createdAt?: string | null;
  indexed?: boolean;
  main?: string | null;
  kind?: string | null;
  reversed?: boolean | null;
  hybridMultiplier?: number | null;
  createdBlock?: number | null;
  createdTx?: string | null;
  /** Token wei, from indexed data; null when not indexed. */
  totalSupply?: RawAmount | null;
  priceUsdE18?: UsdE18;
  usdSource?: UsdSource;
  mcapUsdE18?: UsdE18;
  mcapUsdSource?: UsdSource;
  frozen?: boolean | null;
  presaleComplete?: boolean | null;
}

export interface WalletProjectMarket {
  address?: string;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  /** ISO 8601. */
  createdAt?: string | null;
  indexed?: boolean;
  main?: string | null;
  host?: string | null;
  isPrivate?: boolean | null;
  /** Unix seconds; null until indexed. */
  endTime?: number | null;
  numOutcomes?: number | null;
  createdBlock?: number | null;
  createdTx?: string | null;
}

/** Paging of one WalletProjects list. */
export interface WalletProjectsPagination extends Pagination {
  /** The list holds the newest 1,000 rows of its kind and the wallet has more (`total` counts them all). */
  truncated?: boolean;
}

/** Tokens and markets a wallet created; each list offset paged with the same page / offset / limit. */
export interface WalletProjects {
  wallet?: string;
  tokens?: WalletProjectToken[];
  markets?: WalletProjectMarket[];
  tokensPagination?: WalletProjectsPagination;
  marketsPagination?: WalletProjectsPagination;
}

export interface WalletRoles {
  wallet?: string;
  whitelists?: Array<{
    token?: string;
    capTokens?: RawAmount;
    auto?: boolean;
    note?: string | null;
    txHash?: string;
    blockNumber?: number;
  }>;
  /** Every current whitelist of the wallet (`whitelists` holds at most 1000, newest first). */
  whitelistsTotal?: number;
  /** True when `whitelists` was cut at 1000. */
  whitelistsTruncated?: boolean;
  privateMarkets?: Array<{
    marketToken?: string;
    host?: string;
    voter?: boolean;
    buyer?: boolean;
    /** Null when the role comes only from creating the private market. */
    updatedBlock?: number | null;
  }>;
  /** Every active private-market role row of the wallet (`privateMarkets` holds at most 1000). */
  privateMarketsTotal?: number;
  /** True when `privateMarkets` was cut at 1000. */
  privateMarketsTruncated?: boolean;
}

export interface WalletFollow {
  wallet?: string;
  username?: string | null;
  avatarUrl?: string | null;
  /** Unix seconds. */
  followedAt?: number | null;
}

export interface WalletFollows {
  wallet?: string;
  data: WalletFollow[];
  pagination: Pagination;
}


export type PnlPeriod = 'week' | 'month' | 'all';

/** One part of a wallet's P&L after fees (USD x 1e18). The `priced*` fields sum the counted items and are never null. */
export interface WalletPnlPart {
  totalUsdE18?: UsdE18;
  realizedUsdE18?: UsdE18;
  unrealizedUsdE18?: UsdE18;
  pricedSubtotalUsdE18?: UsdE18;
  pricedRealizedUsdE18?: UsdE18;
  pricedUnrealizedUsdE18?: UsdE18;
  feesUsdE18?: UsdE18;
  complete?: boolean;
  trades?: number;
  items?: number;
  missingItems?: number;
  missingHistory?: number;
  missingPrices?: number;
  estimated?: number;
}

export interface WalletPnlPosition extends WalletPnlPart {
  token?: string;
  main?: string | null;
  tokens?: number;
  missingTokens?: number;
  usdSource?: UsdSource;
}

export interface WalletPnl extends WalletPnlPart {
  wallet?: string;
  period?: PnlPeriod;
  /** Unix seconds of the answer (cached 60 s). */
  asOf?: number;
  tokens?: number;
  missingTokens?: number;
  spot?: WalletPnlPart & { tokens?: number; missingTokens?: number };
  predictions?: WalletPnlPart;
  updown?: WalletPnlPart;
  usdSources?: UsdSourceName[];
  positions?: WalletPnlPosition[];
  markets?: Array<WalletPnlPart & { marketToken?: string }>;
}


export interface LeaderboardParams extends WalletPageParams {
  /** Username or publicly visible X name (64 characters used). Wallet addresses are not searchable. */
  search?: string;
}
const LEADERBOARD_KEYS = optionKeys<LeaderboardParams>({ page: true, offset: true, limit: true, search: true });

/** Options of `getWalletPnl`: the period (default all). */
export interface WalletPnlParams {
  period?: PnlPeriod;
}
const WALLET_PNL_KEYS = optionKeys<WalletPnlParams>({ period: true });

export interface ProfileSocial {
  platform?: string;
  handle?: string;
  url?: string | null;
}

export interface LeaderboardEntry {
  rank?: number;
  /** Not a wallet address: see PublicPersonRef. */
  profileId?: PublicPersonRef;
  username?: string | null;
  avatarUrl?: string | null;
  tier?: string;
  tierEmoji?: string;
  socials?: ProfileSocial[];
}

/** The final testing-phase standings: points were removed, so they never change. */
export interface Leaderboard {
  data: LeaderboardEntry[];
  pagination: Pagination;
  /** Always true. */
  frozen?: boolean;
  frozenReason?: string;
  /** ISO time the standings were recorded; null when the table is empty. */
  takenAt?: string | null;
}

/** Agent block of the public profile (`agentId` is never null there). */
export interface ProfileAgent {
  agentId?: number;
  name?: string | null;
  description?: string | null;
}

/** `GET /api/v1/profile/{wallet}`: your own wallet's identity (owner only). */
export interface PublicProfile {
  wallet?: string;
  /** What public lists show in place of this wallet. */
  profileId?: PublicPersonRef;
  username?: string | null;
  avatarUrl?: string | null;
  /** The tier reached in the testing phase; null when the wallet was not on the leaderboard. */
  tier?: string | null;
  tierEmoji?: string | null;
  /** Final testing-phase rank; 0 when the wallet was not on the leaderboard. */
  rank?: number;
  socials?: ProfileSocial[];
  xHandle?: string | null;
  /** ISO 8601. */
  lastUpdated?: string | null;
  agent?: ProfileAgent | null;
  pointsStale?: boolean;
  /** Link to the wallet summary route. */
  stats?: string;
  followers?: number;
  following?: number;
}

export interface ProfileReferralCounts {
  hasReferrer?: boolean;
  directReferrals?: number;
  indirectReferrals?: number;
  totalReferrals?: number;
}

export interface ProfileReferrals extends ProfileReferralCounts {
  wallet?: string;
  /** The on-chain fee referral; null when on-chain referrals are not live on this network. */
  onchain?: (ProfileReferralCounts & { referrer?: string | null }) | null;
  pointsStale?: boolean;
  /** Link to the full on-chain block (GET /wallet/{address}/referrals). */
  details?: string;
}

/**
 * Activity `types` as the comma list the route takes; null is absent (as None in PY). A filter that names no type
 * (`[]`, `''`, only commas or spaces) would read as every type on the route: ValidationError('types') before any
 * request, as a list entry that is not a string. Same rule in PY.
 */
function typesList(t: WalletActivityParams['types'] | null): string | undefined {
  if (t == null) return undefined;
  const list: unknown[] = typeof t === 'string' ? [t] : Array.isArray(t) ? t : [t];
  if (list.some((x) => typeof x !== 'string')) {
    throw new ValidationError('types', 'types must be an activity type or a list of them (strings), e.g. [\'trade\', \'loan\'].');
  }
  const joined = (list as string[]).join(',');
  if (!joined.split(',').some((x) => x.trim())) {
    throw new ValidationError('types', 'types names no activity type: give at least one (e.g. [\'trade\']), or leave it out for every type.');
  }
  return joined;
}

export class WalletApi extends ApiCore {
  /**
   * GET /api/v1/wallet/:address/transactions: the wallet's AMM legs, newest first (API key).
   * Cursor-paged: `api.paginate((p: WalletTransactionsParams) => api.getWalletTransactions(wallet, p), { limit: 100 })`.
   */
  async getWalletTransactions(
    address: string,
    params: WalletTransactionsParams = {},
  ): Promise<CursorPage<WalletTransaction>> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/transactions`, { auth: 'key', query: { ...optsOf(params, WALLET_TRANSACTIONS_KEYS) } });
  }

  /**
   * GET /api/v1/wallet/:address/activity: every kind of activity of the wallet in one feed, newest first (API key).
   * Cursor-paged like getWalletTransactions; `types` is sent as a comma list. `create` = the tokens and markets the
   * wallet created; `referral` includes payouts redirected to the protocol (`referral_redirected`, not earned).
   * `types: null` (or null params) is absent: every type, as None in PY. A `types` that names no type (`[]`, `''`) is
   * ValidationError('types') before any request (the route would read it as every type).
   */
  async getWalletActivity(
    address: string,
    params: WalletActivityParams = {},
  ): Promise<CursorPage<ActivityRow>> {
    const p = optsOf(params, WALLET_ACTIVITY_KEYS);
    return this.request('GET', `/api/v1/wallet/${seg(address)}/activity`, {
      auth: 'key', query: { ...p, types: typesList(p.types) },
    });
  }

  /** GET /api/v1/tx/:hash: what the index holds for one transaction (status and its rows) (API key). */
  async getTx(hash: string): Promise<IndexedTx> {
    return this.request('GET', `/api/v1/tx/${seg(hash)}`, { auth: 'key' });
  }

  /** GET /api/v1/wallet/:address/portfolio: holdings, pair balances, vaults, loans and positions in USD x 1e18 (API key). */
  async getWalletPortfolio(address: string): Promise<WalletPortfolio> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/portfolio`, { auth: 'key' });
  }

  /** GET /api/v1/wallet/:address/summary: counts and totals of a wallet (API key). Own wallet: getMyStats. */
  async getWalletSummary(address: string): Promise<WalletSummary> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/summary`, { auth: 'key' });
  }

  /**
   * GET /api/v1/wallet/:address/pnl: P&L after fees (spot + predictions + Up/Down) for a period, default all (API key).
   * Counts bought tokens only: tokens received or given away (transfers, vestings, vault rewards) are left out.
   */
  async getWalletPnl(address: string, params: WalletPnlParams = {}): Promise<WalletPnl> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/pnl`, { auth: 'key', query: { ...optsOf(params, WALLET_PNL_KEYS) } });
  }

  /** GET /api/v1/wallet/:address/roles: token whitelists and private-market roles of a wallet (API key). */
  async getWalletRoles(address: string): Promise<WalletRoles> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/roles`, { auth: 'key' });
  }

  /**
   * GET /api/v1/wallet/:address/projects: tokens and markets the wallet created (API key).
   * Offset-paged: both lists take the same page / offset / limit (default 20).
   */
  async getWalletProjects(address: string, params: WalletPageParams = {}): Promise<WalletProjects> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/projects`, { auth: 'key', query: { ...optsOf(params, WALLET_PAGE_KEYS) } });
  }

  /** GET /api/v1/wallet/:address/fees: fees the wallet paid per pair asset (and category) in a window (API key). */
  async getWalletFees(address: string, params: WalletFeesParams = {}): Promise<WalletFees> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/fees`, { auth: 'key', query: { ...optsOf(params, WALLET_FEES_KEYS) } });
  }

  /** GET /api/v1/wallet/:address/earnings: creator payouts and holder rewards in a window (API key). */
  async getWalletEarnings(address: string, params: WalletWindowParams = {}): Promise<WalletEarnings> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/earnings`, { auth: 'key', query: { ...optsOf(params, WALLET_WINDOW_KEYS) } });
  }

  /**
   * GET /api/v1/wallet/:address/referrals: on-chain referral tree and earnings, plus the referral counts (API key).
   * `onchain.referrals` is offset-paged (page / offset / limit, default 50).
   */
  async getWalletReferrals(address: string, params: WalletReferralsParams = {}): Promise<WalletReferrals> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/referrals`, { auth: 'key', query: { ...optsOf(params, WALLET_REFERRALS_KEYS) } });
  }

  /**
   * GET /api/v1/wallet/:address/followers: wallets following this one, newest first; offset-paged (API key). Rows keep
   * the address; `username` and `avatarUrl` are null (profile privacy).
   */
  async getWalletFollowers(address: string, params: WalletPageParams = {}): Promise<WalletFollows> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/followers`, { auth: 'key', query: { ...optsOf(params, WALLET_PAGE_KEYS) } });
  }

  /**
   * GET /api/v1/wallet/:address/following: wallets this one follows, newest first; offset-paged (API key). Rows keep
   * the address; `username` and `avatarUrl` are null (profile privacy).
   */
  async getWalletFollowing(address: string, params: WalletPageParams = {}): Promise<WalletFollows> {
    return this.request('GET', `/api/v1/wallet/${seg(address)}/following`, { auth: 'key', query: { ...optsOf(params, WALLET_PAGE_KEYS) } });
  }

  /** GET /api/v1/me/stats: getWalletSummary for the authenticated wallet (API key or session). */
  async getMyStats(): Promise<WalletSummary> {
    return this.request('GET', '/api/v1/me/stats', { auth: 'keyOrSession' });
  }

  /** GET /api/v1/me/projects: getWalletProjects for the authenticated wallet; offset-paged (API key or session). */
  async getMyProjects(params: WalletPageParams = {}): Promise<WalletProjects> {
    return this.request('GET', '/api/v1/me/projects', { auth: 'keyOrSession', query: { ...optsOf(params, WALLET_PAGE_KEYS) } });
  }

  /**
   * GET /api/v1/me/referrals: who referred you, the wallets you referred (levels 1-2) and the on-chain block
   * (API key or session). `onchain.referrals` is offset-paged.
   */
  async getMyReferrals(params: WalletReferralsParams = {}): Promise<MyReferrals> {
    return this.request('GET', '/api/v1/me/referrals', { auth: 'keyOrSession', query: { ...optsOf(params, WALLET_REFERRALS_KEYS) } });
  }

  /** GET /api/v1/me/fees: getWalletFees for the authenticated wallet (API key or session). */
  async getMyFees(params: WalletFeesParams = {}): Promise<WalletFees> {
    return this.request('GET', '/api/v1/me/fees', { auth: 'keyOrSession', query: { ...optsOf(params, WALLET_FEES_KEYS) } });
  }

  /** GET /api/v1/me/earnings: getWalletEarnings for the authenticated wallet (API key or session). */
  async getMyEarnings(params: WalletWindowParams = {}): Promise<WalletEarnings> {
    return this.request('GET', '/api/v1/me/earnings', { auth: 'keyOrSession', query: { ...optsOf(params, WALLET_WINDOW_KEYS) } });
  }

  /** GET /api/v1/leaderboard: the final testing-phase standings, frozen for good; rows carry `profileId`; offset-paged. No auth. */
  async getLeaderboard(params: LeaderboardParams = {}): Promise<Leaderboard> {
    return this.request('GET', '/api/v1/leaderboard', { query: { ...optsOf(params, LEADERBOARD_KEYS) } });
  }

  /**
   * GET /api/v1/profile/:wallet: identity of your own wallet (public socials, agent, follow counts, final testing-phase
   * standing). Owner only (API key or session): another wallet answers 404. Public profiles are browsed by username.
   */
  async getPublicProfile(wallet: string): Promise<PublicProfile> {
    return this.request('GET', `/api/v1/profile/${seg(wallet)}`, { auth: 'keyOrSession' });
  }

  /** GET /api/v1/profile/:wallet/referrals: referral counts of any wallet, off-chain and on-chain (API key). */
  async getPublicProfileReferrals(wallet: string): Promise<ProfileReferrals> {
    return this.request('GET', `/api/v1/profile/${seg(wallet)}/referrals`, { auth: 'key' });
  }
}
