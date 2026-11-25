import { BasisError, ValidationError } from '../core/errors';
import { ANY_KEYS, optionKeys, optsOf } from '../core/opts';
import type { ApiErrorBody } from './types';

/** Default deadline of an ordinary API request (headers and body), ms. Client option `apiTimeoutMs`. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;
/** Default deadline of an upload (image, metadata, project image) and of an image download, ms. `apiUploadTimeoutMs`. */
export const DEFAULT_API_UPLOAD_TIMEOUT_MS = 120_000;
/** Default deadline of the AI routes (market approval, market drafting), ms. `apiAiTimeoutMs`. */
export const DEFAULT_API_AI_TIMEOUT_MS = 330_000;
/** Longest timeout any option takes, ms (2^31-1: setTimeout wraps larger values to 1 ms). */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** Name of the API's SIWE session cookie on the site. */
export const SESSION_COOKIE_NAME = '__Host-basis_session';
/** The same cookie on a local dev server, which runs on plain http (a `__Host-` cookie needs Secure). */
export const DEV_SESSION_COOKIE_NAME = 'basis_auth_session';

/** True when a `Cookie` header value holds the SIWE session cookie under either name, with a value. */
export function hasSessionCookie(cookie: string | null | undefined): boolean {
  if (!cookie) return false;
  return cookie.split(';').some((pair) => {
    const i = pair.indexOf('=');
    if (i <= 0 || pair.slice(i + 1).trim() === '') return false;
    const name = pair.slice(0, i).trim();
    return name === SESSION_COOKIE_NAME || name === DEV_SESSION_COOKIE_NAME;
  });
}

/**
 * How a request authenticates (from the spec's per-operation `security`):
 * - `none`: public, sends no credentials.
 * - `key`: `X-API-Key` only (SIWE is not accepted).
 * - `session`: the SIWE session cookie only.
 * - `keyOrSession`: either; the API key alone when it is the signer's (the server lets a sent key decide, even beside a
 *   session cookie, and rate limits it on the key's bucket), else the session.
 * - `anyKeyOrSession`: either, for public data that is the same whoever asks (`GET /api/v1/stats/*`): the key whoever
 *   it belongs to (as `key` requests), else the signer's session; a key of another wallet then goes too (it reads
 *   nothing of that wallet's), so a signer switch never stops such a read. Neither: AuthRequiredError.
 * - `optional`: public; sends one credential of the signer, never both: its confirmed session, else its own API key
 *   (a route that knows its caller either way, e.g. the Feed of a wallet, where a sent key wins on the server).
 * - `optionalSession`: public; sends the signer's confirmed session only, never the key (routes that read only the
 *   session, e.g. `GET /api/auth/onboarding`).
 * A request sent with `includeSession` (the session's own routes: verify, `GET /api/auth/me`, logout) never carries the
 * API key: those routes read only the session.
 *
 * A request carries the session only when the SDK confirmed that the session holds the current signer's wallet
 * (`client.sessionWallets`, from the verify answer, `GET /api/auth/me` and logout). When the client holds a session
 * that does not (signer switched, signer signed out, wallet unknown), `session` requests (and `keyOrSession` ones without
 * the signer's API key) throw AuthRequiredError before sending instead of acting for another wallet; `optional` and
 * `optionalSession` ones go without the session.
 *
 * The API key counts as the signer's when `client.apiKeyWallet` is the signer's wallet, or when the client has no
 * signer (a key-only client). After a signer switch, or when the SDK does not know whose key it holds
 * (`apiKeyWallet` null), `keyOrSession` and `optional` requests go without the key (`keyOrSession`: with the signer's
 * confirmed session, else AuthRequiredError with a `detail`), so a write never acts for the key's wallet instead of
 * the signer's. `key` and `anyKeyOrSession` requests (public data) send the key whoever the signer is.
 */
export type AuthMode = 'none' | 'key' | 'session' | 'keyOrSession' | 'anyKeyOrSession' | 'optional' | 'optionalSession';

/**
 * How the SIWE session cookie travels (client option `cookieMode`):
 * - `explicit` (Node, Deno, Bun, servers): the SDK reads the session from the verify answer's `Set-Cookie` and sends it
 *   as a `Cookie` header itself (`client.sessionCookie`).
 * - `browser`: the browser keeps the session cookie (HttpOnly, never readable by JavaScript) and attaches it to
 *   requests sent with `credentials: 'include'`. The SDK tracks whether the signer is signed in from the verify answer
 *   and `GET /api/auth/me` (`client.hasSession`, `client.refreshSession()`); `client.sessionCookie` stays null.
 */
export type CookieMode = 'browser' | 'explicit';

/**
 * The cookie mode of this runtime: `browser` in a page (window and document exist) or a web worker, else `explicit`.
 * Electron renderers and jsdom count as browsers; pass `cookieMode` to override.
 */
export function detectCookieMode(): CookieMode {
  const g = globalThis as { window?: unknown; document?: unknown; importScripts?: unknown };
  if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') return 'browser';
  if (typeof g.importScripts === 'function') return 'browser';
  return 'explicit';
}

/** Query value: undefined / null are dropped, bigint and numbers become decimal strings, booleans `true` / `false`. */
export type QueryValue = string | number | bigint | boolean | null | undefined;
export type Query = { [name: string]: QueryValue };

/** What ApiCore reads from the client (BasisClient satisfies it). */
export interface ApiHost {
  readonly apiDomain: string;
  readonly apiKey: string | null;
  /**
   * The lower-case wallet the API key belongs to, null when unknown (or no key). `keyOrSession` and `optional`
   * requests send the key only when this is the signer's wallet, or when there is no signer (see AuthMode).
   */
  readonly apiKeyWallet: string | null;
  readonly sessionCookie: string | null;
  /** How the session cookie travels (default `explicit`): see CookieMode. */
  readonly cookieMode?: CookieMode;
  /**
   * Browser cookie mode: true while the browser holds a SIWE session for the signer, as far as the SDK knows (verify
   * answer, `GET /api/auth/me`, logout). Session requests are then sent with `credentials: 'include'`.
   */
  readonly hasSession?: boolean;
  /**
   * The active signer's address, sent as `X-Wallet-Address` with the session cookie: the server then acts for this
   * wallet of a multi-wallet session (without it, for the wallet signed in last). Undefined without a signer.
   */
  readonly account?: string;
  /**
   * Lower-case wallets the SDK confirmed are in its SIWE session (verify answer, `GET /api/auth/me`, logout). The
   * session is sent only for a signer in this list. Undefined: the host does not track them (no wallet check).
   */
  readonly sessionWallets?: readonly string[];
  /** Receives what an auth answer says about the session (verify, `GET /api/auth/me`, logout); BasisClient keeps it. */
  _noteSession?(update: SessionUpdate): void;
  /** Deadline of an ordinary request, ms (default DEFAULT_API_TIMEOUT_MS). */
  readonly apiTimeoutMs?: number;
  /** Deadline of an upload or image download, ms (default DEFAULT_API_UPLOAD_TIMEOUT_MS). */
  readonly apiUploadTimeoutMs?: number;
  /** Deadline of an AI route (approve, draft*), ms (default DEFAULT_API_AI_TIMEOUT_MS). */
  readonly apiAiTimeoutMs?: number;
}

/**
 * What an auth answer says about the session (ApiHost._noteSession): `cookie` the new `Cookie` value (explicit mode;
 * null = cleared, undefined = unchanged), `wallets` the session's wallets (replaces the list), `remove` a wallet
 * signed out.
 */
export interface SessionUpdate {
  cookie?: string | null;
  wallets?: readonly string[];
  remove?: string;
}

/** Which client deadline a request uses: `default` (apiTimeoutMs), `upload` (apiUploadTimeoutMs), `ai` (apiAiTimeoutMs). */
export type RequestKind = 'default' | 'upload' | 'ai';

/** Per-call options (`api.withOptions(...)`). null is absent (as None in PY). */
export interface CallOptions {
  /**
   * Deadline of each request, ms, from sending to the last body byte (overrides the client's apiTimeoutMs /
   * apiUploadTimeoutMs / apiAiTimeoutMs). Past it the request throws BasisApiError with code `timeout` (status 0).
   */
  timeoutMs?: number;
  /**
   * Cancels the request: BasisApiError with code `aborted` (status 0). An AbortSignal (`new AbortController().signal`,
   * `AbortSignal.timeout(ms)`); anything else throws ValidationError('signal') in withOptions.
   */
  signal?: AbortSignal;
}
const CALL_OPTIONS_KEYS = optionKeys<CallOptions>({ timeoutMs: true, signal: true });

/**
 * True when `v` is an AbortSignal: an instance of this runtime's AbortSignal, or (a signal from another realm or a
 * polyfill) an object with a boolean `aborted` and `addEventListener` / `removeEventListener`, all fetchWithDeadline
 * uses.
 */
function isAbortSignal(v: unknown): v is AbortSignal {
  if (typeof AbortSignal === 'function' && v instanceof AbortSignal) return true;
  if (!v || typeof v !== 'object') return false;
  const s = v as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  return typeof s.aborted === 'boolean' && typeof s.addEventListener === 'function' && typeof s.removeEventListener === 'function';
}

/**
 * A shallow copy of `o` without the keys whose value is null or undefined: an optional field given as null is absent
 * (as None in PY), never sent as JSON null. null `o` gives {}.
 */
export function withoutNulls<T extends object>(o: T | null | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export interface RequestOptions extends CallOptions {
  /** Default `none`. */
  auth?: AuthMode;
  query?: Query;
  /** JSON body (bigints are sent as decimal strings). */
  body?: unknown;
  /** Multipart body; the boundary header is set by fetch. */
  form?: FormData;
  headers?: Record<string, string>;
  /** Which client deadline applies (default `default`); `timeoutMs` and `api.withOptions` override it. */
  kind?: RequestKind;
  /**
   * Send the session even when the SDK knows of none for the signer (sign-in, `GET /api/auth/me`, logout): explicit
   * mode the session cookie when the client has one, browser mode the browser's cookies (`credentials: 'include'`).
   */
  includeSession?: boolean;
}

/** A fully read API answer: the body was read within the request's deadline. */
export interface ApiResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  /** The body as text ('' when empty). */
  readonly text: string;
}

/**
 * A non-2xx API answer, or no complete answer in time. `message` carries the server's `error` text; `code` its
 * machine-readable code. A request past its deadline throws status 0, code `timeout`; one cancelled by the caller's
 * AbortSignal status 0, code `aborted` (neither is retried: the request may have reached the server).
 */
export class BasisApiError extends BasisError {
  /** HTTP status; 0 when no complete answer was read (`timeout`, `aborted`). */
  public readonly status: number;
  /**
   * `code` from the `{error, code}` body (e.g. `bad_param`, `rate_limited`), null when the body has none; `timeout` /
   * `aborted` when no complete answer was read.
   */
  public readonly code: string | null;
  /** Parsed JSON body, or the raw text when it is not JSON. */
  public readonly body: unknown;
  /**
   * Seconds to wait before retrying: from `Retry-After` when the answer has one, else from the body's `retryAfterMs`,
   * else (429 and 503 with code `rate_limited` or none) from `X-RateLimit-Reset` (epoch seconds). Undefined otherwise:
   * a daily cap or a busy writer names no wait of its own.
   */
  public readonly retryAfter?: number;
  constructor(status: number, code: string | null, message: string, body: unknown, retryAfter?: number) {
    super(`[basis-sdk] ${message}`);
    this.name = 'BasisApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * The request needs credentials the client does not have, or would carry a SIWE session or an API key that is not the
 * signer's (`detail` says why). Thrown before any request is sent.
 */
export class AuthRequiredError extends BasisError {
  public readonly mode: AuthMode;
  /**
   * Set when the client holds a session or an API key that is not the signer's (signer switched, signed out, wallet
   * unknown).
   */
  public readonly detail: string | null;
  /**
   * `cookieMode` `browser`: the hint adds client.refreshSession() (the session is the browser's). `detail`: the
   * session (`about` `session`) or the API key (`about` `apiKey`) is not the signer's (why); the message then asks to
   * sign in again, or for the signer's own key.
   */
  constructor(mode: AuthMode, what: string, cookieMode: CookieMode = 'explicit', detail?: string, about: 'session' | 'apiKey' = 'session') {
    const need = mode === 'key'
      ? 'an API key (this route does not accept a SIWE session): pass apiKey or use BasisClient.create() with a signer'
      : mode === 'session'
        ? 'a SIWE session: use BasisClient.create() with a signer, or call client.authenticate()'
        : 'an API key or a SIWE session: use BasisClient.create() with a signer, or pass apiKey';
    const resume = cookieMode === 'browser' && mode !== 'key'
      ? ' (browser: await client.refreshSession() picks up a session this browser already holds)'
      : '';
    const again = cookieMode === 'browser'
      ? ' (or await client.refreshSession() when this browser already holds a session for the signer)'
      : '';
    super(!detail
      ? `[basis-sdk] Authentication required: ${what} needs ${need}${resume}.`
      : about === 'apiKey'
        ? `[basis-sdk] Authentication required: ${what} would go out with an API key that is not the signer's ` +
          `(${detail}). Sign the signer in with client.authenticate()${again}, or pass the signer's own key (apiKey).`
        : `[basis-sdk] Authentication required: ${what} would go out with a SIWE session that does not hold the ` +
          `signer's wallet (${detail}). Sign in again with client.authenticate()${again}.`);
    this.name = 'AuthRequiredError';
    this.mode = mode;
    this.detail = detail || null;
  }
}

/**
 * Encodes one path segment. "", "." and ".." throw ValidationError('pathSegment'): fetch would drop or collapse them
 * and send the request to another route (`getWalletLoanEvents('..')` to the caller's own `/api/v1/loans/events`).
 */
export function seg(v: string | number | bigint): string {
  const s = String(v);
  if (s === '' || s === '.' || s === '..') {
    throw new ValidationError('pathSegment', `a path argument cannot be ${s === '' ? 'empty' : `"${s}"`}: pass the address, id or name it asks for.`);
  }
  return encodeURIComponent(s);
}

/** Builds `?a=1&b=true` from a query object (see QueryValue); '' when nothing is left. */
export function buildQuery(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    p.set(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** A decimal number header (`12`, `1.5`, `1e3`, spaces around), NaN when absent, blank or anything else (PY: float()). */
function headerNumber(raw: string | null): number {
  if (raw === null || !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(raw)) return NaN;
  return Number(raw);
}

/**
 * `Retry-After` in whole seconds (a fraction is cut, a negative value is 0), undefined when absent, blank or not a
 * decimal number (an HTTP date too). Same as PY `_header_retry_after`.
 */
function headerRetryAfter(headers: Headers): number | undefined {
  const ra = headerNumber(headers.get('retry-after'));
  return Number.isFinite(ra) ? Math.max(0, Math.trunc(ra)) : undefined;
}

/** Seconds until a retry is allowed: `Retry-After` (whole seconds) or `X-RateLimit-Reset` (epoch seconds). */
export function retryAfterOf(headers: Headers): number | undefined {
  const ra = headerRetryAfter(headers);
  if (ra !== undefined) return ra;
  const reset = headerNumber(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  return undefined;
}

/**
 * `retryAfter` of an error answer, seconds: `Retry-After` when present, else the body's `retryAfterMs` (rounded up),
 * else `X-RateLimit-Reset` for a 429 or 503 whose code is `rate_limited` or absent. That header is the key's or the
 * session's per-minute bucket, so a refusal by another limit (`daily_wallet_cap`, `gate_busy`, ...) gets no wait from
 * it, and a 400 / 404 none at all (it carries the header too, but waiting does not help it).
 */
export function errorRetryAfter(status: number, headers: Headers, body?: unknown, code?: string | null): number | undefined {
  const ra = headerRetryAfter(headers);
  if (ra !== undefined) return ra;
  const ms = body && typeof body === 'object' ? (body as { retryAfterMs?: unknown }).retryAfterMs : undefined;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.ceil(Math.min(ms, MAX_TIMEOUT_MS) / 1000);
  if ((status === 429 || status === 503) && (code === 'rate_limited' || code === null || code === undefined)) {
    return retryAfterOf(headers);
  }
  return undefined;
}

/** Reads a non-2xx answer into a BasisApiError. */
export function apiErrorFrom(res: ApiResponse, what: string): BasisApiError {
  const text = res.text;
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch {  }
  const b = (body && typeof body === 'object' ? body : {}) as Partial<ApiErrorBody>;
  const msg = typeof b.error === 'string' ? b.error : (text || res.statusText || 'request failed');
  const code = typeof b.code === 'string' ? b.code : null;
  const hint = code === 'prelaunch' ? ` ${PRELAUNCH_HINT}` : '';
  return new BasisApiError(res.status, code, `${what} failed [${res.status}${code ? ` ${code}` : ''}]: ${msg}${hint}`, body, errorRetryAfter(res.status, res.headers, body, code));
}

/** Added to an API error with code `prelaunch` (the real site before its launch answers most routes with it). */
export const PRELAUNCH_HINT = "The real site is not live yet: use chain: 'robinhoodPaper' (the paper site) for now.";

/** Throws ValidationError(rule) unless `v` is a finite number of ms above 0 and at most MAX_TIMEOUT_MS. */
export function checkTimeoutMs(v: unknown, rule: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_TIMEOUT_MS) {
    throw new ValidationError(rule, `${rule} must be a number of ms above 0 and at most ${MAX_TIMEOUT_MS}, got ${String(v)}.`);
  }
  return v;
}

/**
 * Whether `host` can send its SIWE session for its current signer: `none` (no session held), `ok` (the session holds
 * the signer's wallet, or the host tracks no wallets), `mismatch` (held, but not confirmed for the signer).
 */
export function sessionStateOf(host: ApiHost): 'none' | 'ok' | 'mismatch' {
  const wallets = host.sessionWallets;
  const held = host.cookieMode === 'browser'
    ? (wallets ? wallets.length > 0 : host.hasSession === true)
    : hasSessionCookie(host.sessionCookie);
  if (!held) return 'none';
  if (!wallets) return 'ok';
  const a = host.account?.toLowerCase();
  return a !== undefined && wallets.includes(a) ? 'ok' : 'mismatch';
}

/** Why `host`'s session is not the signer's (the AuthRequiredError `detail`). */
export function sessionMismatchDetail(host: ApiHost): string {
  const a = host.account;
  const w = host.sessionWallets ?? [];
  if (!a) return `the client has no signer to match it against${w.length ? `; session wallets: ${w.join(', ')}` : ''}`;
  if (!w.length) return `the SDK knows no wallet of this session (signed out, or never confirmed); signer ${a}`;
  return `it was confirmed for ${w.join(', ')}, not for the signer ${a}`;
}

/**
 * Whether `host` can send its API key for its current signer on a `keyOrSession` / `optional` request: `none` (no
 * key), `ok` (the key's wallet, `apiKeyWallet`, is the signer's, or there is no signer), `mismatch` (the key belongs
 * to another wallet, or the SDK does not know whose it is).
 */
export function apiKeyStateOf(host: ApiHost): 'none' | 'ok' | 'mismatch' {
  if (!host.apiKey) return 'none';
  const a = host.account?.toLowerCase();
  if (a === undefined) return 'ok';
  const owner = host.apiKeyWallet;
  return typeof owner === 'string' && owner.toLowerCase() === a ? 'ok' : 'mismatch';
}

/** Why `host`'s API key is not the signer's (the AuthRequiredError `detail`). */
export function apiKeyMismatchDetail(host: ApiHost): string {
  const owner = host.apiKeyWallet;
  return typeof owner === 'string' && owner
    ? `the API key belongs to ${owner.toLowerCase()}, not to the signer ${host.account}`
    : `the SDK does not know which wallet the API key belongs to; signer ${host.account}`;
}

/**
 * The AuthRequiredError a `session` request of `host` would throw (no session, or one that is not the signer's),
 * null when it can go out. `what` names the request.
 */
export function sessionAuthError(host: ApiHost, what: string): AuthRequiredError | null {
  const state = sessionStateOf(host);
  const cm = host.cookieMode ?? 'explicit';
  if (state === 'none') return new AuthRequiredError('session', what, cm);
  if (state === 'mismatch') return new AuthRequiredError('session', what, cm, sessionMismatchDetail(host));
  return null;
}

/**
 * `fetch` with a deadline covering the whole answer (headers and body) and an optional caller AbortSignal. Returns
 * the response with its body read. Past the deadline: BasisApiError(0, 'timeout'); signal aborted: BasisApiError(0,
 * 'aborted'); other network errors are thrown as fetch throws them. Never retries.
 */
export async function fetchWithDeadline(
  url: string, init: RequestInit, deadline: { timeoutMs: number; signal?: AbortSignal; what: string },
): Promise<{ res: Response; body: Uint8Array }> {
  const { timeoutMs, signal, what } = deadline;
  const aborted = () => new BasisApiError(0, 'aborted', `${what} was aborted by the caller`, null);
  if (signal?.aborted) throw aborted();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = new Uint8Array(await res.arrayBuffer());
    return { res, body };
  } catch (e) {
    if (timedOut) {
      throw new BasisApiError(0, 'timeout', `${what} timed out after ${timeoutMs} ms without a complete answer`, null);
    }
    if (signal?.aborted) throw aborted();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The fetch `credentials` of a request: browser cookie mode `include` when it carries the session, else `omit` (the
 * browser would otherwise attach its HttpOnly session cookie same-origin); explicit mode none (no ambient cookies).
 */
export function credentialsFor(host: { readonly cookieMode?: CookieMode }, carriesSession: boolean): { credentials?: RequestCredentials } {
  if (host.cookieMode !== 'browser') return {};
  return { credentials: carriesSession ? 'include' : 'omit' };
}

const jsonBody = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** A page of a page-numbered list (`pagination.page` / `hasMore`; tokens, markets, orders, holders, loans, ...). */
export interface NumberedPageLike<T> {
  data: T[];
  pagination: { hasMore: boolean; page?: number };
}

/** A page of an offset-paged list (`pagination.offset` / `hasMore`; the Feed lists). */
export interface OffsetPageLike<T> {
  data: T[];
  pagination: { hasMore: boolean; offset?: number };
}

/** The `X-RateLimit-*` headers of the last API answer that carried them (`api.lastRateLimit`). */
export interface RateLimitInfo {
  /** Requests allowed per window (`X-RateLimit-Limit`), null when absent. */
  limit: number | null;
  /** Requests left in the window (`X-RateLimit-Remaining`), null when absent. */
  remaining: number | null;
  /** When the window resets, epoch seconds (`X-RateLimit-Reset`), null when absent. */
  reset: number | null;
  /** HTTP status of that answer. */
  status: number;
  /** `METHOD /path` of that request. */
  route: string;
  /** ISO time the answer was read. */
  at: string;
}

/** The rate-limit headers of `headers`, or null when it has none. */
export function rateLimitOf(headers: Headers, status: number, route: string): RateLimitInfo | null {
  const num = (name: string) => {
    const v = headers.get(name);
    const n = v === null || v.trim() === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const reset = num('x-ratelimit-reset');
  if (limit === null && remaining === null && reset === null) return null;
  return { limit, remaining, reset, status, route, at: new Date().toISOString() };
}

/** A page of a cursor-paged list. */
export interface CursorPageLike<T> {
  data: T[];
  pagination: { hasMore: boolean; nextCursor?: string | null };
}

/**
 * Base of every API domain class: request plumbing only. No retries here (the sync engine has its own);
 * a 429 throws a BasisApiError whose `retryAfter` says how long to wait. Every wrapper that takes an options / params
 * object (and withOptions, runDraftJob and the paginators) refuses a value of another kind, a number, string, bigint,
 * boolean, array or class instance, with ValidationError('options') before any request; left out or null = none given.
 * A key its type does not have is refused the same way, named with the key it most likely meant (a misspelt query key
 * would go out and the server would ignore it); the paginators leave that to the method they call.
 */
export class ApiCore {
  /** The API object that owns `lastRateLimit` (itself; a `withOptions` view inherits its source's). */
  protected _root: ApiCore = this;
  /** Per-call options of a `withOptions` view ({} on the client's own API object). */
  protected _call: CallOptions = {};
  /** Where `lastRateLimit` lives: read and written on `_root` only (PY `_last_rate_limit`). */
  private _lastRateLimit: RateLimitInfo | null = null;

  constructor(protected readonly client: ApiHost) {}

  /**
   * The `X-RateLimit-*` headers (limit, remaining, reset) of the last answer that carried them, 2xx included; null
   * until one did. Lets a caller slow down before a 429 (the key limit is 60 a minute). One value per client API
   * object: a `withOptions` view reads and writes the value of the API object it came from (live), so answers read
   * through a view land there too. Same in PY (`last_rate_limit`).
   */
  get lastRateLimit(): RateLimitInfo | null {
    return this._root._lastRateLimit;
  }

  set lastRateLimit(v: RateLimitInfo | null) {
    this._root._lastRateLimit = v;
  }

  /**
   * The same API with per-call options: `client.api.withOptions({ timeoutMs: 5000, signal }).getToken(address)`.
   * `timeoutMs` replaces the client's deadline (apiTimeoutMs, apiUploadTimeoutMs, apiAiTimeoutMs) for every request
   * made through the returned object, from sending to the last body byte; `signal` (an AbortSignal, else
   * ValidationError('signal')) cancels them. Options merge over those of the view it is called on; an option left
   * out, null or undefined is absent (as None in PY: the view keeps the one it inherits). `options` itself must be an
   * object (or left out, or null): anything else throws ValidationError('options'). Cheap: credentials, session and
   * `lastRateLimit` are shared.
   */
  withOptions(options?: CallOptions | null): this {
    const given = withoutNulls(optsOf(options, CALL_OPTIONS_KEYS));
    if (given.timeoutMs !== undefined) checkTimeoutMs(given.timeoutMs, 'timeoutMs');
    const signal: unknown = given.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      const got = typeof signal === 'object' ? 'an object that is not an AbortSignal' : typeof signal;
      throw new ValidationError('signal', `signal must be an AbortSignal (new AbortController().signal), got ${got}.`);
    }
    const view = Object.create(this) as this;
    view._call = { ...this._call, ...given };
    return view;
  }

  /** The deadline of a request, ms: the per-call option, else the request's own, else the client's for its kind. */
  protected timeoutFor(opts: { kind?: RequestKind; timeoutMs?: number } = {}): number {
    if (this._call.timeoutMs != null) return this._call.timeoutMs;
    if (opts.timeoutMs != null) return opts.timeoutMs;
    if (opts.kind === 'upload') return this.client.apiUploadTimeoutMs ?? DEFAULT_API_UPLOAD_TIMEOUT_MS;
    if (opts.kind === 'ai') return this.client.apiAiTimeoutMs ?? DEFAULT_API_AI_TIMEOUT_MS;
    return this.client.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  }

  /** The caller's AbortSignal for a request (per-call option, else the request's own). */
  protected signalFor(opts: { signal?: AbortSignal } = {}): AbortSignal | undefined {
    return this._call.signal ?? opts.signal;
  }

  /** `apiDomain` without trailing slashes. */
  protected get baseUrl(): string {
    return this.client.apiDomain.replace(/\/+$/, '');
  }

  /** Auth headers for `mode`; throws AuthRequiredError when the client cannot satisfy it. */
  protected authHeaders(mode: AuthMode, what: string): Record<string, string> {
    return this.authFor(mode, what).headers;
  }

  /**
   * Auth of a request in `mode`: its headers (the API key), and whether it carries the session (explicit mode the
   * `Cookie` header, browser mode `credentials: 'include'`). The session is carried only when it holds the signer's
   * wallet (sessionStateOf); the key on `keyOrSession` / `optional` requests only when it is the signer's
   * (apiKeyStateOf), and a `keyOrSession` request with the signer's key goes with the key alone. An `optional` request
   * carries one of them (the session first), an `optionalSession` one the session only, an `anyKeyOrSession` one any key
   * the client holds (the signer's first), else the session. Throws AuthRequiredError when the client cannot satisfy
   * `mode`, or when a `session` request (or a `keyOrSession` / `anyKeyOrSession` one without a key it may send) would
   * carry a session that is not the signer's, or a `keyOrSession` one has only a key that is not the signer's.
   */
  protected authFor(mode: AuthMode, what: string): { headers: Record<string, string>; session: boolean } {
    const cm = this.client.cookieMode ?? 'explicit';
    const key = this.client.apiKey;
    const headers: Record<string, string> = {};
    if (mode === 'none') return { headers, session: false };
    if (mode === 'key') {
      if (!key) throw new AuthRequiredError(mode, what, cm);
      headers['X-API-Key'] = key;
      return { headers, session: false };
    }
    if (mode === 'session') {
      const err = sessionAuthError(this.client, what);
      if (err) throw err;
      return { headers, session: true };
    }
    const state = sessionStateOf(this.client);
    const keyState = apiKeyStateOf(this.client);
    if (mode === 'keyOrSession') {
      if (keyState === 'ok') return { headers: { 'X-API-Key': key! }, session: false };
      if (state === 'ok') return { headers, session: true };
      if (keyState === 'mismatch') {
        const session = state === 'mismatch' ? `; the SIWE session: ${sessionMismatchDetail(this.client)}` : '';
        throw new AuthRequiredError(mode, what, cm, `${apiKeyMismatchDetail(this.client)}${session}`, 'apiKey');
      }
      if (state === 'mismatch') throw new AuthRequiredError(mode, what, cm, sessionMismatchDetail(this.client));
      throw new AuthRequiredError(mode, what, cm);
    }
    if (mode === 'anyKeyOrSession') {
      if (keyState === 'ok') return { headers: { 'X-API-Key': key! }, session: false };
      if (state === 'ok') return { headers, session: true };
      if (key) return { headers: { 'X-API-Key': key }, session: false };
      if (state === 'mismatch') throw new AuthRequiredError(mode, what, cm, sessionMismatchDetail(this.client));
      throw new AuthRequiredError(mode, what, cm);
    }
    if (mode === 'optionalSession') return { headers, session: state === 'ok' };
    if (state === 'ok') return { headers, session: true };
    if (keyState === 'ok') headers['X-API-Key'] = key!;
    return { headers, session: false };
  }

  /**
   * Sends a request and returns the answer with its body read (any status). Throws AuthRequiredError before sending;
   * BasisApiError `timeout` / `aborted` when no complete answer arrives in time (see withOptions). A request that
   * carries the session also sends `X-Wallet-Address` (the signer), so the server acts for the signer's wallet.
   * Browser cookie mode: such a request is sent with `credentials: 'include'`, every other one with
   * `credentials: 'omit'`, so the browser never attaches its session cookie to a request meant to go without it.
   * A request with `includeSession` (the session's own routes) goes without the API key.
   */
  protected async send(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const what = `${method} ${path}`;
    const auth = this.authFor(opts.auth ?? 'none', what);
    const authHeaders = opts.includeSession === true ? {} : auth.headers;
    const headers: Record<string, string> = { ...authHeaders, ...opts.headers };
    const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    const browser = this.client.cookieMode === 'browser';
    const carry = auth.session || opts.includeSession === true;
    if (carry && !browser && !has('cookie') && this.client.sessionCookie) headers.Cookie = this.client.sessionCookie;
    const account = this.client.account;
    if (account && (browser ? carry : has('cookie')) && !has('x-wallet-address')) headers['X-Wallet-Address'] = account;
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = jsonBody(opts.body);
    }
    const { res, body: bytes } = await fetchWithDeadline(
      `${this.baseUrl}${path}${buildQuery(opts.query)}`,
      { method, headers, body, ...credentialsFor(this.client, carry) },
      { timeoutMs: this.timeoutFor(opts), signal: this.signalFor(opts), what },
    );
    const rl = rateLimitOf(res.headers, res.status, what);
    if (rl) this._root.lastRateLimit = rl;
    const text = new TextDecoder().decode(bytes);
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, text };
  }

  /**
   * Sends a request and parses the answer: JSON (or text when the body is not JSON; undefined when empty).
   * Non-2xx throws BasisApiError.
   */
  protected async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, opts);
    if (!res.ok) throw apiErrorFrom(res, `${method} ${path}`);
    const text = res.text;
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { return text as T; }
  }

  /**
   * @internal The lower-case wallet the client's API key belongs to: `GET /api/v1/me/profile` sent with the key alone (no
   * session, whoever the signer is), which answers for the key's own wallet. Null when the answer names no wallet. No
   * key: AuthRequiredError before sending; a non-2xx answer throws BasisApiError (401 `invalid_key`: the key does not
   * work). `ensureApiKey` reads it before it takes a key of unknown wallet for the signer's (a 4-character hint match is
   * 1 in 65,536). PY: `_key_wallet`.
   */
  async _keyWallet(): Promise<string | null> {
    const me = await this.request<unknown>('GET', '/api/v1/me/profile', { auth: 'key' });
    const w = me && typeof me === 'object' ? (me as { wallet?: unknown }).wallet : undefined;
    return typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : null;
  }

  /**
   * Iterates every row of a cursor-paged list: calls `fn(params)`, yields `data`, then calls again with
   * `cursor: pagination.nextCursor` while `hasMore`. `fn` is called with this API as `this`, so
   * `api.paginate(api.getWalletTransactions...)` style methods taking one params object can be passed directly;
   * wrap the others: `api.paginate((p) => api.getTokenTrades(token, p), { limit: 100 })`.
   * Stops (with a warning) when the server hands back a cursor it already gave: a loop, never more rows.
   */
  async *paginate<T, const P extends object = { cursor?: string }>(
    fn: (params: P & { cursor?: string }) => Promise<CursorPageLike<T>>,
    params?: P,
  ): AsyncGenerator<T, void, undefined> {
    let p = { ...optsOf(params, ANY_KEYS) } as P & { cursor?: string };
    const seen = new Set<string>(p.cursor ? [p.cursor] : []);
    for (;;) {
      const page = await fn.call(this, p);
      for (const row of page.data ?? []) yield row;
      const next = page.pagination?.nextCursor;
      if (!page.pagination?.hasMore || !next) return;
      if (seen.has(next)) {
        console.warn(`[basis-sdk] paginate: the server repeated cursor ${next}; stopping (no new rows would come).`);
        return;
      }
      seen.add(next);
      p = { ...p, cursor: next };
    }
  }

  /**
   * Iterates every row of a page-numbered list: calls `fn(params)` from `params.page` (default 1), yields `data`, then
   * asks for the next page while `pagination.hasMore` and the page had rows. `fn` is called with this API as `this`;
   * wrap methods taking path arguments: `api.paginatePages((p) => api.getWalletMarkets(wallet, p), { limit: 100 })`.
   * `offset` is refused (ValidationError('offset')): the server lets it override `page`, so every request would answer
   * the same rows; start from a page instead. `page: null` / `offset: null` are absent (as None in PY): `fn` never
   * gets an `offset` key. Stops (with a warning) when a later answer is not the page asked for (`pagination.page`) or
   * repeats the previous page's rows.
   */
  async *paginatePages<T, const P extends object = { page?: number }>(
    fn: (params: P & { page: number }) => Promise<NumberedPageLike<T>>,
    params?: P,
  ): AsyncGenerator<T, void, undefined> {
    const { page: givenPage, offset: givenOffset, ...rest } = optsOf<object>(params, ANY_KEYS) as { page?: unknown; offset?: unknown } & Record<string, unknown>;
    if (givenOffset != null) {
      throw new ValidationError('offset', 'paginatePages walks pages: drop offset (the server lets it override page, so every request would answer the same rows) and pass page to start later.');
    }
    if (givenPage != null && (typeof givenPage !== 'number' || !Number.isInteger(givenPage) || givenPage < 1)) {
      throw new ValidationError('page', `page must be a whole number from 1, got ${String(givenPage)}.`);
    }
    let page = (givenPage as number | null | undefined) ?? 1;
    let previous: string | null = null;
    for (;;) {
      const res = await fn.call(this, { ...rest, page } as unknown as P & { page: number });
      const rows = res?.data ?? [];
      const answered = res?.pagination?.page;
      const signature = rows.length ? JSON.stringify(rows, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : null;
      const first = previous === null;
      if (!first && ((typeof answered === 'number' && answered !== page) || signature === previous)) {
        console.warn(`[basis-sdk] paginatePages: asked for page ${page}, the server answered ${typeof answered === 'number' ? `page ${answered}` : 'the previous page again'}; stopping.`);
        return;
      }
      for (const row of rows) yield row;
      if (!res?.pagination?.hasMore || !rows.length) return;
      previous = signature;
      page += 1;
    }
  }

  /**
   * Iterates every row of an offset-paged list (the Feed: `getFeed`, `getFeedByWallet`): calls `fn(params)` from
   * `params.offset` (default 0), yields `data`, then asks for `offset + data.length` while `pagination.hasMore` and the
   * page had rows. `fn` is called with this API as `this`; wrap methods taking path arguments:
   * `api.paginateOffset((p) => api.getFeedByWallet(name, p), { limit: 50 })`. Rows outside `data` (a post's
   * `comments`) go through an adapter that returns `{ data, pagination }`. `page` is refused (ValidationError('page'):
   * these routes read only `offset`). `offset: null` / `page: null` are absent (as None in PY): `fn` never gets a
   * `page` key. Stops (with a warning) when a later answer is not at the offset asked for (`pagination.offset`) or
   * repeats the previous page's rows.
   */
  async *paginateOffset<T, const P extends object = { offset?: number }>(
    fn: (params: P & { offset: number }) => Promise<OffsetPageLike<T>>,
    params?: P,
  ): AsyncGenerator<T, void, undefined> {
    const { page: givenPage, offset: givenOffset, ...rest } = optsOf<object>(params, ANY_KEYS) as { page?: unknown; offset?: unknown } & Record<string, unknown>;
    if (givenPage != null) {
      throw new ValidationError('page', 'paginateOffset walks offsets: drop page (offset-paged routes do not read it) and pass offset to start later.');
    }
    if (givenOffset != null && (typeof givenOffset !== 'number' || !Number.isInteger(givenOffset) || givenOffset < 0)) {
      throw new ValidationError('offset', `offset must be a whole number from 0, got ${String(givenOffset)}.`);
    }
    let offset = (givenOffset as number | null | undefined) ?? 0;
    let previous: string | null = null;
    for (;;) {
      const res = await fn.call(this, { ...rest, offset } as unknown as P & { offset: number });
      const rows = res?.data ?? [];
      const answered = res?.pagination?.offset;
      const signature = rows.length ? JSON.stringify(rows, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : null;
      const first = previous === null;
      if (!first && ((typeof answered === 'number' && answered !== offset) || signature === previous)) {
        console.warn(`[basis-sdk] paginateOffset: asked for offset ${offset}, the server answered ${typeof answered === 'number' && answered !== offset ? `offset ${answered}` : 'the previous page again'}; stopping.`);
        return;
      }
      for (const row of rows) yield row;
      if (!res?.pagination?.hasMore || !rows.length) return;
      previous = signature;
      offset += rows.length;
    }
  }
}
