
/** Raw on-chain integer as a decimal string, in the units of the asset named beside it. */
export type RawAmount = string;

/**
 * Opaque public person reference (`person1_...`): what public lists show in place of a wallet. Not a wallet address, not
 * a credential and not a contract argument. `getFeedByWallet` takes it.
 */
export type PublicPersonRef = string;

/** USD x 1e18 as a decimal string; null = unknown (never 0, never 1:1). Comes with a `usdSource`. */
export type UsdE18 = string | null;

/** Where a USD value came from; null when the value is null. */
export type UsdSource = 'fixed' | 'feed' | 'hop' | 'offchain' | null;

/** A ratio or price x 1e18 as a decimal string. */
export type E18 = string;

/** History cursor `blockNumber:logIndex` (pass `nextCursor` back as `cursor`). */
export type Cursor = string;

/** The one `pagination` object: histories use `nextCursor`, sorted lists `page` / `total`. */
export interface Pagination {
  limit: number;
  hasMore: boolean;
  nextCursor?: Cursor | null;
  page?: number;
  total?: number;
}

/** A cursor-paged list. */
export interface CursorPage<T> {
  data: T[];
  pagination: Pagination;
}

/** Every API error body. */
export interface ApiErrorBody {
  error: string;
  code: string;
  /** bad_param on an enum value: the accepted values. */
  allowed?: string[];
  /** not_deployed: the feature that is not live on this network. */
  feature?: string;
}

/** Lists of one main: `main` is the main's address-book key or address (every main when left out). */
export interface MainFilterParams {
  main?: string;
}
