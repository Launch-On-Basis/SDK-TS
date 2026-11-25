import { ApiCore, seg } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { Cursor, CursorPage, E18, Pagination, RawAmount, UsdE18, UsdSource } from './types';

/** What a token is (registry). */
export type TokenKind = 'main' | 'token' | 'reversed' | 'market' | 'marketPrivate' | 'updownPool';

/** Indexed market lifecycle status. */
export type TokenPredictionStatus =
  | 'active' | 'awaiting_proposal' | 'proposed' | 'proposed_closed' | 'voting' | 'veto_window' | 'disputed'
  | 'vetoed' | 'awaiting_finalize' | 'resolved' | 'invalidated' | 'unknown';

export type TokenSort = 'newest' | 'oldest' | 'volume24h' | 'change24h' | 'mcap' | 'trades24h';

/** Side of an AMM leg. */
export type TokenTradeType = 'buy' | 'sell' | 'leverage_buy' | 'leverage_sell';

/** What an AMM leg is. */
export type TradeLegRole =
  | 'trade' | 'route_hop' | 'cross_leg' | 'leverage_open' | 'leverage_exit' | 'loan_exit' | 'liquidation' | 'protocol'
  | 'convert';

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type TokenHistoryInterval = '1h' | '4h' | '1d';
export type TokenRewardKind = 'distributed' | 'claimed' | 'recycled' | 'creator_payout';
export type TokenEventName =
  | 'CreatorFeeSet' | 'RewardsFeeSet' | 'Bonded' | 'FreezeLifted' | 'WhiteListedWallet' | 'WhitelistRemoved'
  | 'DevShareSet';

/** Window bound of a history route: unix seconds (ms above 1e12 and ISO dates are accepted too). */
export type TimeBound = number | string;

/** A token row of GET /api/v1/tokens. Prices are x 1e18 decimal strings; supply and liquidity are raw units. */
export interface TokenSummary {
  id: number | null;
  address: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  /** Creator wallet from the posted metadata (for a market or pool token see `creator` / `host`). */
  dev: string | null;
  image: string | null;
  multiplier: number | null;
  isPrediction: boolean;
  predictionType: string | null;
  predictionStatus: string | null;
  /** ISO. */
  createdAt: string | null;
  /** ISO. */
  lastActivityAt: string | null;
  chainId: number;
  /** The main the token trades against; a main names itself. */
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  kind: TokenKind | null;
  reversed: boolean | null;
  hybridMultiplier: number | null;
  rewardsEnabled: boolean | null;
  frozen: boolean | null;
  /** Raw main-token units (18 decimals); "0" = no presale. */
  presaleTarget: RawAmount | null;
  presaleComplete: boolean | null;
  listed: boolean | null;
  creator: string | null;
  host: string | null;
  hasMetadata: boolean;
  createdBlock: number | null;
  /** Whole pair-asset units per whole token x 1e18. */
  priceE18: E18 | null;
  /** Main per whole token x 1e18; null on a main. */
  priceMainE18: E18 | null;
  priceUsdE18: UsdE18;
  usdSource: UsdSource;
  change24hBps: number | null;
  changeUsd24hBps: number | null;
  /** Wallet trades in the last 24 h. A swap through several tokens counts once on each. */
  trades24h: number;
  /** USD x 1e18 traded on this token in the last 24 h. A multi-token swap adds to each: do not sum across tokens. */
  volume24hUsdE18: UsdE18;
  volumeUsdSource: UsdSource;
  volumeUsdCovered: number;
  /** Token wei. */
  circulatingSupply: RawAmount | null;
  mcapUsdE18: UsdE18;
  mcapUsdSource: UsdSource;
  /** Units of `quoteAsset`. */
  liquidity: RawAmount | null;
  /** Market depth, units of `quoteAsset`. */
  depth: RawAmount | null;
  quoteAsset: string | null;
  quoteDecimals: number | null;
}

/** GET /api/v1/tokens/{address}: the summary plus config, supply, holders, floor and liquidity in USD. */
export interface TokenDetail extends TokenSummary {
  predictionStatus: TokenPredictionStatus | null;
  /** ISO market close time; null = open-ended. */
  endTime: string | null;
  eventType: string | null;
  website: string | null;
  telegram: string | null;
  twitterx: string | null;
  creatorFeeBps: number;
  rewardsFeeBps: number;
  /** [] without metadata (nullable per the spec). */
  predictionOptions: Array<{ index: number; name: string }> | null;
  projectedVetted: boolean | null;
  priceSource: 'index' | null;
  /** Token wei; a main's is read live from the chain (cached 60 s). */
  totalSupply: RawAmount | null;
  /** Token wei still locked in vesting. */
  lockedSupply: RawAmount | null;
  /** `index`: the supply is from indexed data; `chain`: read live from the chain (a main); null = unknown. */
  supplySource: 'index' | 'chain' | null;
  holdersCount: number;
  protocolHolders: number;
  /** Price floor, main per whole token x 1e18 (factory tokens only). Measured in the main, whose price can move. */
  floorMainE18: E18 | null;
  /** Price floor, pair per whole token x 1e18. Measured in the pair token, which can itself move. */
  floorE18: E18 | null;
  floorUsdE18: UsdE18;
  floorUsdSource: UsdSource;
  liquidityUsdE18: UsdE18;
  liquidityUsdSource: UsdSource;
  depthUsdE18: UsdE18;
  depthUsdSource: UsdSource;
  virtualLiquidityUsdE18: UsdE18;
  virtualLiquidityUsdSource: UsdSource;
  /** null without a factory row. */
  autoVest: { enabled: boolean; durationDays: number; gradual: boolean } | null;
  /** null without a factory row. `completedAt` is ISO. */
  presale: { target: RawAmount; complete: boolean; completedAt: string | null } | null;
}

/** An OHLC candle: whole units as JS numbers (charts only); `time` is the bucket start, unix seconds. */
export interface TokenCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TokenCandles {
  data: TokenCandle[];
  interval: string;
  count: number;
  /** The window held more than 50,000 ticks (for quote=pair, or the main's ticks were cut): the oldest candles may be missing. */
  truncated: boolean;
  main: string | null;
  quote: { mode: 'token' | 'pair' | 'usd'; asset: string | null; symbol: string; decimals: number | null } | null;
}

/** One AMM leg of a token (GET /api/v1/tokens/{address}/trades). */
export interface TokenTrade {
  id: number;
  /** The token the leg trades. */
  contractAddress: string;
  type: TokenTradeType;
  /** Token wei. */
  amountToken: RawAmount;
  /** Units of `quoteAsset` (the main for a factory token, the pair asset for a main). */
  amountQuote: RawAmount;
  quoteAsset: string | null;
  quoteDecimals: number | null;
  user: string;
  /** Whole pair-asset units per whole token x 1e18 (display hint). */
  priceE18: E18 | null;
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  pairSymbol: string | null;
  /**
   * On a `trade` / `cross_leg` leg: the trade's USD before fees (the figure GET /api/v1/trades shows and the 24 h volume
   * sums); on any other leg the leg's own value (= legValueUsdE18).
   */
  valueUsdE18: UsdE18;
  /** USD x 1e18 of this leg itself (a buy after the swap fee, a sell before it). */
  legValueUsdE18: UsdE18;
  usdSource: UsdSource;
  legRole: TradeLegRole;
  tradeLogIndex: number | null;
  isPresale: boolean;
  /** Only with include=protocol. */
  userIsProtocol?: boolean;
  /** The contract the tx was sent to, when the trade came through another contract (null otherwise). */
  viaContract: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO. */
  timestamp: string;
}

/** One user trade (GET /api/v1/trades): a spot buy / sell or a cross-pair swap. */
export interface SwapTrade {
  kind: 'spot' | 'cross';
  trader: string;
  traderIsProtocol: boolean;
  traderPending: boolean;
  /** null on a cross swap. */
  side: 'buy' | 'sell' | null;
  tokenIn: string;
  tokenOut: string;
  /** Units of tokenIn. */
  amountIn: RawAmount;
  /** Units of tokenOut. */
  amountOut: RawAmount;
  /** Units of taxToken; null on a cross swap. */
  tax: RawAmount | null;
  taxToken: string | null;
  token: string | null;
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  /** Units of pairAsset. */
  valuePair: RawAmount | null;
  valueUsdE18: UsdE18;
  usdSource: UsdSource;
  /** Cross swaps: the output side. */
  mainOut: string | null;
  pairAssetOut: string | null;
  pairDecimalsOut: number | null;
  valuePairOut: RawAmount | null;
  valueUsdOutE18: UsdE18;
  usdSourceOut: UsdSource;
  sellFee: RawAmount | null;
  buyFee: RawAmount | null;
  sellOut: RawAmount | null;
  buyIn: RawAmount | null;
  recipient: string | null;
  isPresale: boolean | null;
  viaContract: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO. */
  blockTime: string;
}

/** An order-book fill of a market token. Amounts in units of pairAsset; shares have 18 decimals. */
export interface TokenOrderFill {
  orderId: number;
  outcomeId: number;
  buyer: string;
  seller: string;
  shares: RawAmount;
  basePair: RawAmount;
  /** Fee included. */
  buyerPaid: RawAmount;
  /** After the fee. */
  sellerNet: RawAmount;
  main: string | null;
  pairAsset: string | null;
  pairDecimals: number | null;
  valueUsdE18: UsdE18;
  usdSource: UsdSource;
  host: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO. */
  blockTime: string;
}

/** A token comment. */
export interface TokenComment {
  id: number;
  author: string;
  content: string;
  tradeType: string | null;
  txHash: string | null;
  /** ISO. */
  createdAt: string;
}

/** A whitelisted wallet. `buyAmount` / `capTokens`: the most tokens (18 decimals) it may buy while frozen. */
export interface TokenWhitelistEntry {
  walletAddress: string;
  buyAmount: RawAmount;
  note: string | null;
  txHash: string | null;
  /** ISO. */
  timestamp: string;
  /** Added by the protocol, not by the creator. */
  auto: boolean;
  capTokens: RawAmount;
  /** The cap is 2^256 - 1. */
  unlimited: boolean;
}

/** One wallet's whitelist state (GET .../whitelist?wallet=). */
export interface TokenWhitelistStatus {
  whitelisted: boolean;
  entry: {
    walletAddress: string;
    buyAmount: RawAmount;
    note: string | null;
    txHash: string | null;
    timestamp: string;
    auto: boolean;
    removedAt: string | null;
  } | null;
  /** The wallet is the token's creator. */
  isDev: boolean;
  whitelistPhaseOver: boolean;
  frozen: boolean | null;
  presaleComplete: boolean | null;
  /** The list gates buys (frozen and presale not complete). */
  enforced: boolean;
  capTokens: RawAmount | null;
  unlimited: boolean | null;
}

export interface TokenHolder {
  wallet: string;
  /** Token wei. */
  balance: RawAmount;
  /** Of circulatingSupply. */
  shareBps: number | null;
  isProtocol: boolean;
}

export interface TokenHolders {
  token: string;
  main: string | null;
  holdersCount: number;
  protocolHolders: number;
  circulatingSupply: RawAmount | null;
  data: TokenHolder[];
  pagination: Pagination;
}

/** Bounds echoed by the windowed histories (unix seconds; null when not given). */
interface TokenWindow {
  token: string;
  from: number | null;
  to: number | null;
}

/** A per-group total of a windowed history, in units of pairAsset. */
interface TokenTotal {
  pairAsset: string | null;
  symbol: string | null;
  decimals: number | null;
  amount: RawAmount;
  amountUsdE18: UsdE18;
  usdSource: UsdSource;
  usdCovered: number;
  n: number;
}

export interface TokenReward {
  kind: TokenRewardKind;
  /** Claimer, recycler or payout recipient; null on a distribution. */
  account: string | null;
  accountIsProtocol: boolean;
  /** Units of pairAsset. */
  amount: RawAmount;
  pairAsset: string | null;
  symbol: string | null;
  decimals: number | null;
  main: string | null;
  amountUsdE18: UsdE18;
  usdSource: UsdSource;
  /** Distributions only: an internal accounting figure (read `amount` for what was paid). */
  perShare: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds. */
  time: number;
}

export interface TokenRewardTotal extends TokenTotal {
  kind: TokenRewardKind;
}

export interface TokenRewards extends TokenWindow, CursorPage<TokenReward> {
  /** Per kind and pair asset over the window (not the page). */
  totals: TokenRewardTotal[];
}

export interface TokenFee {
  /** spot_trade, cross_trade, bet_market, ... (see the spec). */
  category: string;
  payer: string | null;
  payerIsProtocol: boolean;
  payerResolved: string | null;
  source: string;
  sourceRole: string;
  trade: boolean;
  /** Units of pairAsset, as are the parts below. */
  amount: RawAmount;
  basePart: RawAmount;
  creatorPaid: RawAmount;
  creatorRedirected: RawAmount;
  retained: RawAmount;
  pairAsset: string | null;
  symbol: string | null;
  decimals: number | null;
  main: string | null;
  amountUsdE18: UsdE18;
  usdSource: UsdSource;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds. */
  time: number;
}

export interface TokenFeeTotal extends TokenTotal {
  category: string;
}

export interface TokenFees extends TokenWindow, CursorPage<TokenFee> {
  /** Per category and pair asset over the window (not the page). */
  totals: TokenFeeTotal[];
}

/** A token config event. */
export interface TokenEvent {
  event: TokenEventName;
  /** Fee events: the new fee in bps; DevShareSet: the recipient's share of the creator fee in bps (0 = removed). */
  bps: number | null;
  /** Whitelist events: the wallet; DevShareSet: the revenue-share recipient. */
  wallet: string | null;
  /** DevShareSet: true when the share was removed (bps 0); null otherwise. */
  removed?: boolean | null;
  /** WhiteListedWallet: token wei. */
  capTokens: RawAmount | null;
  tag: string | null;
  /** The tx sender. */
  actor: string;
  emitter: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds. */
  time: number;
}

export interface TokenEvents extends TokenWindow, CursorPage<TokenEvent> {}

/** One history bucket: the last price and state (null when none fell in it), mints, burns, supply. */
export interface TokenHistoryPoint {
  /** Bucket start, unix seconds. */
  time: number;
  reserveToken: RawAmount | null;
  reserveQuote: RawAmount | null;
  /** Quote per whole token x 1e18. */
  priceE18: E18 | null;
  priceUsdE18: UsdE18;
  syncs: number;
  minted: RawAmount;
  burned: RawAmount;
  supply: RawAmount;
}

export interface TokenHistory {
  token: string;
  main: string | null;
  quote: { asset: string | null; symbol: string | null; decimals: number | null } | null;
  interval: string;
  from: number;
  to: number;
  count: number;
  data: TokenHistoryPoint[];
}

export interface TokensQuery {
  /** Address, name or symbol (case-insensitive). */
  search?: string;
  /** Creator address. */
  dev?: string;
  isPrediction?: boolean;
  sort?: TokenSort;
  /** Direction for the figure sorts. */
  order?: 'asc' | 'desc';
  /** A main key or address. */
  main?: string;
  kind?: TokenKind;
  predictionStatus?: TokenPredictionStatus;
  page?: number;
  /** Wins over page; rounded down to a page start (a multiple of limit). */
  offset?: number;
  limit?: number;
}
const TOKENS_KEYS = optionKeys<TokensQuery>({
  search: true, dev: true, isPrediction: true, sort: true, order: true, main: true, kind: true, predictionStatus: true,
  page: true, offset: true, limit: true,
});

export interface TokenCandlesQuery {
  interval?: CandleInterval;
  /** Unix seconds (default 7 days ago). */
  from?: number;
  /** Unix seconds (default now). */
  to?: number;
  limit?: number;
  /** token (default): the main per token; pair: the pair asset; usd: USD. */
  quote?: 'token' | 'pair' | 'usd';
}
const TOKEN_CANDLES_KEYS = optionKeys<TokenCandlesQuery>({ interval: true, from: true, to: true, limit: true, quote: true });

export interface TokenTradesQuery {
  type?: TokenTradeType;
  /** Also return protocol legs. */
  include?: 'protocol';
  /** `all`: also the hop leg of routed trades (legRole route_hop), left out by default. */
  legs?: 'all';
  legRole?: TradeLegRole;
  from?: TimeBound;
  to?: TimeBound;
  cursor?: Cursor | null;
  limit?: number;
}
const TOKEN_TRADES_KEYS = optionKeys<TokenTradesQuery>({
  type: true, include: true, legs: true, legRole: true, from: true, to: true, cursor: true, limit: true,
});

export interface TradesQuery {
  trader?: string;
  token?: string;
  /** A main key or address. */
  main?: string;
  kind?: 'spot' | 'cross';
  include?: 'protocol';
  from?: TimeBound;
  to?: TimeBound;
  cursor?: Cursor | null;
  limit?: number;
}
const TRADES_KEYS = optionKeys<TradesQuery>({
  trader: true, token: true, main: true, kind: true, include: true, from: true, to: true, cursor: true, limit: true,
});

export interface TokenFillsQuery {
  orderId?: number | bigint;
  outcomeId?: number | bigint;
  buyer?: string;
  seller?: string;
  cursor?: Cursor | null;
  limit?: number;
}
const TOKEN_FILLS_KEYS = optionKeys<TokenFillsQuery>({ orderId: true, outcomeId: true, buyer: true, seller: true, cursor: true, limit: true });

export interface TokenHoldersQuery {
  page?: number;
  offset?: number;
  limit?: number;
  /** exclude: wallets only. */
  protocol?: 'include' | 'exclude';
}
const TOKEN_HOLDERS_KEYS = optionKeys<TokenHoldersQuery>({ page: true, offset: true, limit: true, protocol: true });

export interface TokenRewardsQuery {
  kind?: TokenRewardKind;
  from?: TimeBound;
  to?: TimeBound;
  cursor?: Cursor | null;
  limit?: number;
}
const TOKEN_REWARDS_KEYS = optionKeys<TokenRewardsQuery>({ kind: true, from: true, to: true, cursor: true, limit: true });

export interface TokenFeesQuery {
  from?: TimeBound;
  to?: TimeBound;
  cursor?: Cursor | null;
  limit?: number;
}
const TOKEN_FEES_KEYS = optionKeys<TokenFeesQuery>({ from: true, to: true, cursor: true, limit: true });

export interface TokenEventsQuery {
  event?: TokenEventName;
  from?: TimeBound;
  to?: TimeBound;
  cursor?: Cursor | null;
  limit?: number;
}
const TOKEN_EVENTS_KEYS = optionKeys<TokenEventsQuery>({ event: true, from: true, to: true, cursor: true, limit: true });

export interface TokenHistoryQuery {
  interval?: TokenHistoryInterval;
  /** Unix seconds (default 90 intervals before `to`). */
  from?: number;
  /** Unix seconds (default now). */
  to?: number;
}
const TOKEN_HISTORY_KEYS = optionKeys<TokenHistoryQuery>({ interval: true, from: true, to: true });

/** Options of `getTokenComments`: a page. */
export interface TokenCommentsQuery {
  page?: number;
  limit?: number;
}
const TOKEN_COMMENTS_KEYS = optionKeys<TokenCommentsQuery>({ page: true, limit: true });

/** Options of `getTokenWhitelist`: one wallet's state, or a page of the list. */
export interface TokenWhitelistQuery {
  wallet?: string;
  page?: number;
  limit?: number;
}
const TOKEN_WHITELIST_KEYS = optionKeys<TokenWhitelistQuery>({ wallet: true, page: true, limit: true });

const tokenPath = (address: string | number, sub = '') => `/api/v1/tokens/${seg(address)}${sub}`;

export class TokensApi extends ApiCore {
  /** GET /api/v1/tokens: every registered token, with or without metadata. API key. Offset paging (page / offset). */
  async getTokens(options: TokensQuery = {}): Promise<{ data: TokenSummary[]; pagination: Pagination }> {
    return this.request('GET', '/api/v1/tokens', { auth: 'key', query: { ...optsOf(options, TOKENS_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}: one token's details. API key. */
  async getToken(address: string): Promise<{ data: TokenDetail }> {
    return this.request('GET', tokenPath(address), { auth: 'key' });
  }

  /** GET /api/v1/tokens/{address}/candles: OHLC candles (chart numbers, unix-second buckets). API key. */
  async getTokenCandles(address: string, options: TokenCandlesQuery = {}): Promise<TokenCandles> {
    return this.request('GET', tokenPath(address, '/candles'), { auth: 'key', query: { ...optsOf(options, TOKEN_CANDLES_KEYS) } });
  }

  /**
   * GET /api/v1/tokens/{address}/trades: the token's AMM legs, newest first. API key. Cursor paging. The hop leg of a
   * routed trade (legRole route_hop) is left out unless `legs: 'all'` or `legRole: 'route_hop'`.
   */
  async getTokenTrades(address: string, options: TokenTradesQuery = {}): Promise<CursorPage<TokenTrade>> {
    return this.request('GET', tokenPath(address, '/trades'), { auth: 'key', query: { ...optsOf(options, TOKEN_TRADES_KEYS) } });
  }

  /** GET /api/v1/trades: user trades (spot and cross swaps), newest first; platform-wide without filters. API key. Cursor paging. */
  async getTrades(options: TradesQuery = {}): Promise<CursorPage<SwapTrade>> {
    return this.request('GET', '/api/v1/trades', { auth: 'key', query: { ...optsOf(options, TRADES_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/fills: order-book fills of a market token, newest first. API key. Cursor paging. */
  async getTokenFills(address: string, options: TokenFillsQuery = {}): Promise<CursorPage<TokenOrderFill>> {
    return this.request('GET', tokenPath(address, '/fills'), { auth: 'key', query: { ...optsOf(options, TOKEN_FILLS_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/comments: comments of a token (address or numeric project id). API key. Page paging. */
  async getTokenComments(
    address: string | number,
    options: TokenCommentsQuery = {},
  ): Promise<{ data: TokenComment[]; pagination: Pagination }> {
    return this.request('GET', tokenPath(address, '/comments'), { auth: 'key', query: { ...optsOf(options, TOKEN_COMMENTS_KEYS) } });
  }

  /**
   * GET /api/v1/tokens/{address}/whitelist: the whitelisted wallets (page paging), or with `wallet` that wallet's
   * state. API key.
   */
  async getTokenWhitelist(address: string, options: { wallet: string }): Promise<TokenWhitelistStatus>;
  async getTokenWhitelist(
    address: string,
    options?: { wallet?: undefined; page?: number; limit?: number },
  ): Promise<{ data: TokenWhitelistEntry[]; pagination: Pagination }>;
  async getTokenWhitelist(
    address: string,
    options: TokenWhitelistQuery = {},
  ): Promise<TokenWhitelistStatus | { data: TokenWhitelistEntry[]; pagination: Pagination }> {
    return this.request('GET', tokenPath(address, '/whitelist'), { auth: 'key', query: { ...optsOf(options, TOKEN_WHITELIST_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/holders: holders by balance, largest first. API key. Offset paging (page / offset). */
  async getTokenHolders(address: string, options: TokenHoldersQuery = {}): Promise<TokenHolders> {
    return this.request('GET', tokenPath(address, '/holders'), { auth: 'key', query: { ...optsOf(options, TOKEN_HOLDERS_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/rewards: holder rewards and creator payouts, with window totals. API key. Cursor paging. */
  async getTokenRewards(address: string, options: TokenRewardsQuery = {}): Promise<TokenRewards> {
    return this.request('GET', tokenPath(address, '/rewards'), { auth: 'key', query: { ...optsOf(options, TOKEN_REWARDS_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/fees: fees charged on the token, with window totals. API key. Cursor paging. */
  async getTokenFees(address: string, options: TokenFeesQuery = {}): Promise<TokenFees> {
    return this.request('GET', tokenPath(address, '/fees'), { auth: 'key', query: { ...optsOf(options, TOKEN_FEES_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/events: config history (fees, dev shares, bonding, freeze, whitelist). API key. Cursor paging. */
  async getTokenEvents(address: string, options: TokenEventsQuery = {}): Promise<TokenEvents> {
    return this.request('GET', tokenPath(address, '/events'), { auth: 'key', query: { ...optsOf(options, TOKEN_EVENTS_KEYS) } });
  }

  /** GET /api/v1/tokens/{address}/history: price and supply per bucket from stored events. API key. */
  async getTokenHistory(address: string, options: TokenHistoryQuery = {}): Promise<TokenHistory> {
    return this.request('GET', tokenPath(address, '/history'), { auth: 'key', query: { ...optsOf(options, TOKEN_HISTORY_KEYS) } });
  }
}
