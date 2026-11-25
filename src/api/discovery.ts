import { ValidationError } from '../core/errors';
import { ApiCore, apiErrorFrom } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { E18, MainFilterParams, Pagination, RawAmount, UsdE18, UsdSource } from './types';


/** Extra blocks of `GET /api/v1/mains` (live chain reads, cached 15 s). */
export type MainsInclude = 'cashHeld' | 'market';

/** `market` block of a main (`include=market`). Prices in whole pair asset per whole main x 1e18; chain values are
 * null when their read failed. */
export interface MainsListMarket {
  priceE18?: E18 | null;
  /** The raw price as the chain returns it. */
  priceRaw?: RawAmount | null;
  priceUsdE18?: UsdE18;
  usdSource?: UsdSource;
  /** Net amount paid in, pair units (includes amounts bought with leverage). */
  liquidity?: RawAmount | null;
  /** Market depth, pair units; null unless `priceFrom` is 'live'. */
  depth?: RawAmount | null;
  liquidityUsdE18?: UsdE18;
  depthUsdE18?: UsdE18;
  /** Main wei: the circulating supply, as the token page shows it. */
  circulatingSupply?: RawAmount | null;
  mcapUsdE18?: UsdE18;
  change24hBps?: number | null;
  volume24hUsdE18?: UsdE18;
  volume24hUsdCovered?: number;
  /** null when the 24 h stats read failed. */
  trades24h?: number | null;
  priceFrom?: 'live' | 'sync' | null;
  priceBlock?: number | null;
}

/** One main of `GET /api/v1/mains` (addresses lower-case). */
export interface MainsListRow {
  /** Deployment-config key (e.g. `stasis-usdg`); null for a main on chain but not in the config. */
  key?: string | null;
  /** On-chain name(); null until indexed. */
  name?: string | null;
  /** On-chain symbol(); the config label until indexed. */
  symbol?: string | null;
  label?: string | null;
  main?: string;
  pairAsset?: string;
  pairSymbol?: string | null;
  pairDecimals?: number;
  vault?: string;
  /** How the pair asset is priced in USD. */
  usdKind?: UsdSource;
  configured?: boolean;
  /** main, pairAsset and vault are all deployed. */
  live?: boolean;
  indexed?: boolean;
  /** Whether the pair is active, as indexed; null when not indexed. */
  active?: boolean | null;
  /** ISO time trading was enabled (indexed); null = not enabled or not indexed. */
  tradingEnabledAt?: string | null;
  /** `include=cashHeld`: the main's pair-asset balance, pair units. */
  cashHeld?: RawAmount | null;
  /** `include=market` only. */
  market?: MainsListMarket | null;
}

export interface MainsList {
  network?: string;
  chainId?: number;
  /** Key of the main the dapp shows first. */
  uiDefaultMain?: string;
  data?: MainsListRow[];
}


/** Feature switches (`/api/v1/config`, `/api/v1/status`). */
export interface ApiFeatures {
  trading: boolean;
  loans: boolean;
  leverage: boolean;
  liquidations: boolean;
  crossSwap: boolean;
  vesting: boolean;
  markets: boolean;
  privateMarkets: boolean;
  resolver: boolean;
  updown: boolean;
  referrals: boolean;
  agents: boolean;
  vault: boolean;
  mainLens: boolean;
}

/**
 * Contract name to EIP-55 address; null when not deployed on this network, or not published (the sites publish none of
 * the BASIS contracts today: the SDK carries its own book; the outside ERC-8004 registry is listed).
 */
export interface ApiConfigContracts {
  SWAP?: string | null;
  TAXES?: string | null;
  FACTORY?: string | null;
  LOANS?: string | null;
  LEVERAGE?: string | null;
  LIQUIDATOR?: string | null;
  HOP_EXECUTOR?: string | null;
  VESTING?: string | null;
  PREDICTION?: string | null;
  PRIVATE?: string | null;
  RESOLVER?: string | null;
  READER?: string | null;
  REDEMPTION_READER?: string | null;
  UPDOWN?: string | null;
  MAINLENS?: string | null;
  STAKING?: string | null;
  ERC8004_REGISTRY?: string | null;
  WRAPPED_NATIVE?: string | null;
  BOND_TOKEN?: string | null;
}

export interface ApiConfigMain {
  key?: string;
  label?: string | null;
  main?: string | null;
  pairAsset?: string | null;
  pairSymbol?: string;
  pairDecimals?: number;
  mainDecimals?: number;
  vault?: string | null;
  /** The highest supply multiplier a token created on this main may use. */
  maxSupplyMultiplier?: number;
  usdSource?: string;
  live?: boolean;
}

export interface ApiConfigPathRule {
  lengths?: number[];
  paths?: string[][];
  note?: string;
}

export interface ApiConfigRange {
  min?: number;
  max?: number;
}

/** `GET /api/v1/config`: network, contracts, mains, path rules, create limits, EIP-712 domain, feature switches. */
export interface ApiConfig {
  apiVersion?: string;
  /** The deployment: `robinhood` (the real site) or `robinhood-paper` (the paper site). */
  network?: string;
  /** True on the paper site (play money; the same chain id as the real site, its own contracts). */
  paper?: boolean;
  chainId?: number;
  chainName?: string;
  nativeSymbol?: string;
  deploymentBlock?: number | null;
  contracts?: ApiConfigContracts;
  legacyLoanHubs?: string[];
  /** Key of the main the dapp opens on. */
  defaultMain?: string;
  mains?: ApiConfigMain[];
  bond?: { token?: string | null; symbol?: string; decimals?: number; usdSource?: string };
  /** Swap path rules ("pairAsset" = the main's pair asset, "token" = a factory token quoted in that main). */
  pathRules?: {
    buyTokens?: ApiConfigPathRule;
    sellTokens?: ApiConfigPathRule;
    leverageBuy?: ApiConfigPathRule;
    swapCross?: { enabled?: boolean; note?: string };
    wrappedNative?: string | null;
  };
  createLimits?: {
    hybridMultiplier?: ApiConfigRange;
    /** Bps of the main's seed (1000..100000). */
    startLPBps?: ApiConfigRange;
    autoVestDays?: ApiConfigRange;
    /** `max` is always null: the cap is per main (`mains[].maxSupplyMultiplier`). */
    supplyMultiplier?: { min?: number; max?: number | null; maxPerMain?: string };
    frozenNeedsPresale?: boolean;
    fee?: string;
  };
  /** EIP-712 domain and types of the market approval. */
  eip712?: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContracts?: { public?: string | null; private?: string | null };
    primaryType?: string;
    types?: { MarketApproval?: { name?: string; type?: string }[] };
  };
  features?: ApiFeatures;
  /** The current Terms of Service: the version a signed agent sync must accept (`buildAgentSyncMessage`). */
  terms?: { version?: string; url?: string };
  /** Paths of the other discovery documents. */
  discovery?: { status?: string; contracts?: string; openapi?: string; agent?: string };
}

/** `GET /api/v1/status`: chain head vs synced data. Times are unix seconds. */
export interface ApiStatus {
  network?: string;
  chainId?: number;
  headBlock?: number | null;
  headTime?: number | null;
  /** Newest synced tx from any source (not a lag measure). */
  lastSyncedBlock?: number | null;
  lastSyncedTime?: number | null;
  /** The sync worker's cursor. */
  lastBackfilledBlock?: number | null;
  lastBackfilledTime?: number | null;
  /** headBlock - lastBackfilledBlock; null when either is unknown. */
  lagBlocks?: number | null;
  /** headTime - lastBackfilledTime (a quiet chain raises it too); null when either is unknown. */
  lagSeconds?: number | null;
  partialTxs?: number;
  rawTxs?: number;
  unconfirmedTxs?: number;
  features?: ApiFeatures;
  checkedAt?: number;
}


export interface ContractsJsonMain {
  key?: string;
  label?: string | null;
  /** On-chain name() (cached 10 min); null when the read failed. */
  name?: string | null;
  symbol?: string | null;
  main?: string;
  pairAsset?: string;
  vault?: string;
  pairSymbol?: string;
  pairDecimals?: number;
}

/**
 * `GET /contracts.json`: network and chain id, plus EIP-55 addresses when the site publishes them (keys follow the SDK
 * address book; `tranche` / `tranchePrivate` / `trancheReader` repeat `marketTrading` / `privateMarket` / `reader`).
 * The sites publish no addresses today: the file is then `{ chain, chainId, network, live, note }`.
 */
export interface ContractsJson {
  /** The network's display name. */
  chain?: string;
  chainId?: number;
  /** The network key: `robinhood` (the real site) or `robinhood-paper` (the paper site). */
  network?: string;
  /** False while the site is not live on its chain yet. */
  live?: boolean;
  /** Why the file carries no addresses (not live yet, or not published). */
  note?: string;
  deploymentBlock?: number;
  swap?: string;
  factory?: string;
  taxes?: string;
  leverage?: string;
  mainLens?: string;
  loanHub?: string;
  vesting?: string;
  liquidator?: string;
  hopExecutor?: string;
  marketTrading?: string;
  privateMarket?: string;
  tranche?: string;
  tranchePrivate?: string;
  resolver?: string;
  reader?: string;
  trancheReader?: string;
  redemptionReader?: string;
  upDown?: string;
  erc8004Registry?: string;
  bondToken?: string;
  bondDecimals?: number;
  wrappedNative?: string;
  mains?: ContractsJsonMain[];
  /** Deprecated single-main key (the default main's pair asset): use `mains[].pairAsset`. */
  usdb?: string;
  /** Deprecated single-main key (the default main): use `mains[].main`. */
  mainToken?: string;
  /** Deprecated single-main key (the vault): use `mains[].vault`. */
  staking?: string;
  /** Path of GET /api/v1/config. */
  config?: string;
  /** Path of GET /api/v1/status. */
  status?: string;
}

/** `GET /.well-known/agent.json`. */
export interface AgentManifest {
  schema_version?: string;
  name?: string;
  description?: string;
  url?: string;
  logo?: string;
  docs?: { llms_txt?: string; sdk?: string; api?: string; openapi?: string };
  api?: { config?: string; status?: string; contracts?: string; auth?: string };
  chain?: { name?: string; chain_id?: number };
  agent_registration?: { standard?: string; endpoint?: string };
  integrations?: Record<string, string>;
  social?: Record<string, string>;
}

/** `GET /.well-known/ai-plugin.json`. */
export interface AiPluginManifest {
  schema_version?: string;
  name_for_human?: string;
  name_for_model?: string;
  description_for_human?: string;
  description_for_model?: string;
  auth?: { type?: string; authorization_type?: string; custom_auth_header?: string };
  api?: { type?: string; url?: string };
  logo_url?: string;
  contact_email?: string;
  legal_info_url?: string;
}


/** One pair asset, bond asset or native coin of `GET /api/v1/prices`. */
export interface PriceRow {
  asset?: string;
  symbol?: string | null;
  decimals?: number | null;
  role?: ('pair' | 'bond' | 'native')[];
  mains?: string[];
  priceUsdE18?: UsdE18;
  /** The configured price source kind; null when none is configured. */
  source?: UsdSource;
  usdSource?: UsdSource;
  feed?: string | null;
  maxAgeSec?: number | null;
  /** ISO time the price is for; null when there is no fresh price. */
  updatedAt?: string | null;
  sourceRef?: string | null;
  stale?: boolean;
}

export interface PricesList {
  data?: PriceRow[];
  network?: string;
  chainId?: number;
  /** ISO time. */
  asOf?: string;
}

/** One token of `GET /api/v1/prices/tokens` (its last indexed price). */
export interface TokenPriceRow {
  address?: string;
  found?: boolean;
  main?: string | null;
  pairAsset?: string | null;
  pairDecimals?: number | null;
  /** Pair per whole token x 1e18; null when not found. */
  priceE18?: E18 | null;
  /** Main per whole token x 1e18; null when not found. */
  priceMainE18?: E18 | null;
  priceUsdE18?: UsdE18;
  usdSource?: UsdSource;
  block?: number | null;
  /** ISO time. */
  time?: string | null;
}

export interface TokenPricesList {
  data?: TokenPriceRow[];
  chainId?: number;
}


/**
 * Trades in a window: count, USD volume and rows with a USD value. `volumeUsdE18` sums the priced rows: a lower bound
 * when `partial` is true, null only when the window has rows and none is priced.
 */
export interface StatsWindow {
  n?: number;
  volumeUsdE18?: UsdE18;
  usdCovered?: number;
  /** Some rows of the window have no USD value. */
  partial?: boolean;
}

export interface StatsByMainRow {
  /** null = rows not attributed to a main. */
  main?: string | null;
  pairAsset?: string | null;
  pairSymbol?: string | null;
  pairDecimals?: number | null;
  total?: StatsWindow;
  h24?: StatsWindow;
  /** Pair units. */
  valuePair?: RawAmount;
  valuePair24h?: RawAmount;
  usdSource?: UsdSource;
}

export interface StatsVolumeByPairAsset {
  pairAsset?: string;
  pairSymbol?: string | null;
  pairDecimals?: number | null;
  valuePair?: RawAmount;
  valuePair24h?: RawAmount;
}

/** `GET /api/v1/stats`: platform activity (no TVL: see getStatsMains). */
export interface PlatformStats {
  network?: string;
  chainId?: number;
  chainName?: string;
  counts?: {
    agents?: number;
    tokens?: number;
    predictionMarkets?: number;
    assetsCreated?: number;
    loansTotal?: number;
    loansActive?: number;
    vaultEvents?: number;
  };
  /** Distinct indexed transactions that touched a BASIS contract. */
  txns?: { total?: number; h24?: number; d7?: number; d30?: number };
  /** One row per user trade (spot and cross swaps, AMM bets, order-book fills, Up/Down bets). */
  trades?: { total?: StatsWindow; h24?: StatsWindow; d7?: StatsWindow; d30?: StatsWindow };
  uniqueTraders?: { total?: number; h24?: number };
  byMain?: StatsByMainRow[];
  volumeByPairAsset?: StatsVolumeByPairAsset[];
  /** ISO time. */
  timestamp?: string;
}

/** One component of value held by a main, in `unit` (`pair` or `main`) raw units. */
export interface StatsHeldValue {
  /** null when the chain read failed (never a fake 0). */
  amount?: RawAmount | null;
  unit?: 'pair' | 'main';
  usdE18?: UsdE18;
  usdSource?: UsdSource;
}

/** Value held across many pools (market pots, Up/Down pools). */
/** `amount` is null when `failed` > 0. */
export interface StatsHeldPool extends StatsHeldValue {
  count?: number;
  priced?: number;
  /** Holdings whose balance read failed. */
  failed?: number;
}

/** One main of `GET /api/v1/stats/mains`. Components overlap: never sum them. */
export interface StatsMainsRow {
  key?: string;
  main?: string;
  pairAsset?: string | null;
  pairSymbol?: string;
  pairDecimals?: number;
  vault?: string | null;
  priceUsdE18?: UsdE18;
  usdSource?: UsdSource;
  liquidity?: StatsHeldValue;
  depth?: StatsHeldValue;
  cashHeld?: StatsHeldValue;
  openInterest?: StatsHeldValue & { positions?: number | null };
  vaultStaked?: StatsHeldValue;
  vaultPledged?: StatsHeldValue;
  vaultRewardsHeld?: StatsHeldValue;
  marketPots?: StatsHeldPool;
  updownPools?: StatsHeldPool;
}

export interface StatsMains {
  network?: string;
  chainId?: number;
  note?: string;
  /** ISO time. */
  asOf?: string;
  data?: StatsMainsRow[];
}

export type StatsFeesGroupBy = 'main' | 'token' | 'category';

/** A fee flow in the row's asset (raw units); USD at the time of each event. */
export interface StatsFeeFlow {
  amount?: RawAmount;
  usdE18?: UsdE18;
  usdCovered?: number;
  n?: number;
}

/** One group x asset of `GET /api/v1/stats/fees` (the zero address = the native coin). */
export interface StatsFeesRow {
  /** The main, token or category; null = rows with no main or token. */
  group?: string | null;
  asset?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  usdSource?: UsdSource;
  fees?: StatsFeeFlow & {
    basePart?: RawAmount;
    creatorPaid?: RawAmount;
    creatorRedirected?: RawAmount;
    retained?: RawAmount;
  };
  /** null for groupBy=category. */
  referralPaid?: StatsFeeFlow | null;
  /** null for groupBy=category. */
  buyback?: StatsFeeFlow | null;
  /** groupBy=main only, else null. */
  vaultYield?: (StatsFeeFlow & { stasisAdded?: RawAmount }) | null;
}

export interface StatsFees {
  data?: StatsFeesRow[];
  pagination?: Pagination;
  groupBy?: StatsFeesGroupBy;
  /** Window start, unix seconds. */
  from?: number;
  /** Window end (exclusive), unix seconds. */
  to?: number;
}

export type StatsLeaderboardMetric = 'volume' | 'fees' | 'updown' | 'pnl';
export type StatsPeriod = '24h' | '7d' | '30d' | 'all';

/** One wallet of `GET /api/v1/stats/leaderboard`. The `pnl`-only fields are absent for other metrics. */
export interface StatsLeaderboardRow {
  rank?: number;
  wallet?: string;
  /** USD x 1e18, null unless every row has one; metric=pnl: the P&L (may be negative). */
  valueUsdE18?: UsdE18;
  /** Sum over the rows that have a USD value (the ranking key). */
  pricedUsdE18?: UsdE18;
  usdCovered?: number;
  n?: number;
  /** metric=fees only (else null): fees paid through a loan on this wallet's behalf. */
  viaRelay?: number | null;
  realizedUsdE18?: UsdE18;
  unrealizedUsdE18?: UsdE18;
  trades?: number;
  tokens?: number;
  items?: number;
  feesUsdE18?: UsdE18;
  spotUsdE18?: UsdE18;
  predictionsUsdE18?: UsdE18;
  updownUsdE18?: UsdE18;
  /** How many wallets of the BASIS account this row adds up (one row per account; metric=pnl: the ranked ones). */
  wallets?: number;
}

export interface StatsLeaderboard {
  data?: StatsLeaderboardRow[];
  pagination?: Pagination;
  metric?: StatsLeaderboardMetric;
  period?: StatsPeriod;
  /** Window start, unix seconds; null for period=all. */
  since?: number | null;
}


const MAX_PRICE_ADDRESSES = 100;

/** Options of `getMains`: the extra blocks to add (one or a list). */
export interface MainsParams {
  include?: MainsInclude | MainsInclude[];
}
const MAINS_KEYS = optionKeys<MainsParams>({ include: true });
const MAIN_FILTER_KEYS = optionKeys<MainFilterParams>({ main: true });

/** Options of `getStatsFees`: the window [from, to) in unix seconds, the grouping and the page. */
export interface StatsFeesParams {
  from?: number;
  to?: number;
  groupBy?: StatsFeesGroupBy;
  page?: number;
  limit?: number;
}
const STATS_FEES_KEYS = optionKeys<StatsFeesParams>({ from: true, to: true, groupBy: true, page: true, limit: true });

/** Options of `getStatsLeaderboard`. */
export interface StatsLeaderboardParams {
  metric?: StatsLeaderboardMetric;
  period?: StatsPeriod;
  page?: number;
  limit?: number;
}
const STATS_LEADERBOARD_KEYS = optionKeys<StatsLeaderboardParams>({ metric: true, period: true, page: true, limit: true });

export class DiscoveryApi extends ApiCore {
  /**
   * GET /api/v1/mains: the mains, their pair assets and indexed state. `include` adds live `cashHeld` and/or
   * `market` blocks (one chain read each). No auth.
   */
  async getMains(options: MainsParams = {}): Promise<MainsList> {
    const given = optsOf(options, MAINS_KEYS).include;
    const include = Array.isArray(given) ? given.join(',') || undefined : (given ?? undefined);
    return this.request('GET', '/api/v1/mains', { query: { include } });
  }

  /** GET /api/v1/config: everything needed before a first call (network, contracts, mains, limits, EIP-712). No auth. */
  async getConfig(): Promise<ApiConfig> {
    return this.request('GET', '/api/v1/config');
  }

  /**
   * @internal `GET /api/v1/config` with the API's clock: `serverSkewMs` is the answer's `Date` header (plus its `Age`,
   * for an answer a cache kept) minus the local clock, null without a usable `Date`. Non-2xx throws BasisApiError.
   */
  async _getConfigWithClock(): Promise<{ config: ApiConfig; serverSkewMs: number | null }> {
    const res = await this.send('GET', '/api/v1/config');
    if (!res.ok) throw apiErrorFrom(res, 'GET /api/v1/config');
    let config: ApiConfig = {};
    try {
      const j = res.text ? JSON.parse(res.text) : {};
      if (j && typeof j === 'object' && !Array.isArray(j)) config = j;
    } catch {  }
    const date = Date.parse(res.headers.get('date') ?? '');
    const age = Number(res.headers.get('age') ?? '');
    const serverSkewMs = Number.isNaN(date) ? null : date + (Number.isFinite(age) && age > 0 ? age * 1000 : 0) - Date.now();
    return { config, serverSkewMs };
  }

  /** GET /api/v1/status: chain head, sync position and lag (unix seconds), feature switches. No auth. */
  async getStatus(): Promise<ApiStatus> {
    return this.request('GET', '/api/v1/status');
  }

  /**
   * GET /contracts.json: network and chain id of the deployment, plus its EIP-55 contract addresses when the site
   * publishes them (none today). No auth.
   */
  async getContractsJson(): Promise<ContractsJson> {
    return this.request('GET', '/contracts.json');
  }

  /** GET /.well-known/agent.json: agent discovery manifest. No auth. */
  async getAgentManifest(): Promise<AgentManifest> {
    return this.request('GET', '/.well-known/agent.json');
  }

  /** GET /.well-known/ai-plugin.json: AI plugin manifest. No auth. */
  async getAiPluginManifest(): Promise<AiPluginManifest> {
    return this.request('GET', '/.well-known/ai-plugin.json');
  }

  /** GET /api/v1/prices: USD price and source of every pair asset, bond asset and the native coin. API key. */
  async getPrices(): Promise<PricesList> {
    return this.request('GET', '/api/v1/prices', { auth: 'key' });
  }

  /**
   * GET /api/v1/prices/tokens: current prices of 1 to 100 BASIS tokens (`found: false` for unknown ones and for
   * invite-only markets the caller may not see). API key. Counted as the server counts them: split on commas,
   * trimmed, lower-cased, without blanks and repeats (one row per distinct address, in the order given); anything other
   * than strings throws ValidationError('addresses').
   */
  async getTokenPrices(addresses: string | string[]): Promise<TokenPricesList> {
    const given: unknown[] = Array.isArray(addresses) ? addresses : [addresses];
    if (given.some((a) => typeof a !== 'string')) {
      throw new ValidationError('addresses', 'addresses must be an address string or an array of address strings');
    }
    const list = [...new Set((given as string[]).flatMap((a) => a.split(',')).map((a) => a.trim().toLowerCase()).filter(Boolean))];
    if (list.length < 1 || list.length > MAX_PRICE_ADDRESSES) {
      throw new ValidationError('addresses', `addresses must hold 1 to ${MAX_PRICE_ADDRESSES} addresses (got ${list.length})`);
    }
    return this.request('GET', '/api/v1/prices/tokens', { auth: 'key', query: { addresses: list.join(',') } });
  }

  /**
   * GET /api/v1/stats: platform activity (counts, txns, trades and volume per window, per-main volume).
   * `main` (key or address) keeps only that main's `byMain` row. No auth.
   */
  async getStats(options: MainFilterParams = {}): Promise<PlatformStats> {
    return this.request('GET', '/api/v1/stats', { query: { ...optsOf(options, MAIN_FILTER_KEYS) } });
  }

  /**
   * GET /api/v1/stats/mains: per main, each component of value held (liquidity, depth, cash, open interest, vault,
   * market pots, Up/Down pools) with its USD value; never summed. `main` (key or address) keeps one row. No auth.
   */
  async getStatsMains(options: MainFilterParams = {}): Promise<StatsMains> {
    return this.request('GET', '/api/v1/stats/mains', { query: { ...optsOf(options, MAIN_FILTER_KEYS) } });
  }

  /**
   * GET /api/v1/stats/fees: platform fee flows in [from, to) (unix seconds; default the last 30 days), one row per
   * group and asset, largest USD first. Offset paged (`page`, `limit` 1..100). API key or session.
   */
  async getStatsFees(options: StatsFeesParams = {}): Promise<StatsFees> {
    return this.request('GET', '/api/v1/stats/fees', { auth: 'anyKeyOrSession', query: { ...optsOf(options, STATS_FEES_KEYS) } });
  }

  /**
   * GET /api/v1/stats/leaderboard: wallets ranked by `metric` (volume, fees, updown, pnl) over `period`
   * (pnl takes 7d, 30d or all). Offset paged (`page`, `limit` 1..100). API key or session.
   */
  async getStatsLeaderboard(options: StatsLeaderboardParams = {}): Promise<StatsLeaderboard> {
    return this.request('GET', '/api/v1/stats/leaderboard', { auth: 'anyKeyOrSession', query: { ...optsOf(options, STATS_LEADERBOARD_KEYS) } });
  }
}
