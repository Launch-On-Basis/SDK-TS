
import { ValidationError } from './errors';
import { didYouMean } from './opts';
import { errorText } from './redact';
import { nonceBlock } from './replacement';
import { PLATFORM, loadFs, loadPath } from '../platform/node';

/** `POST /api/v1/sync {txHash, source}`: one post per write (it decodes every event, order-book events included). */
export const SYNC_ROUTE = '/api/v1/sync';
/** `source` sent with every sync: the API labels its record "sdk". */
export const SYNC_SOURCE = 'sdk';
/** `POST /api/agents`: records an ERC-8004 registration (after its tx sync, which the route answers `ignored`). */
export const AGENT_SYNC_ROUTE = '/api/agents';

/**
 * Attempts of one agent sync delivery at most (`kind: 'agent'` / `'agentSigned'`), the first included: two retries,
 * whatever `attempts` says above it. POST /api/agents counts every post against the wallet's quota (10 an hour), so a
 * 503 `unavailable` (the API could not read the registry) retried 6 times would spend most of it. PY: the same.
 */
export const AGENT_SYNC_MAX_ATTEMPTS = 3;
/** An agent sync waits this many times a tx sync's backoff between its attempts (default 5 s, then 10 s). PY: the same. */
export const AGENT_RETRY_DELAY_FACTOR = 5;
/**
 * Browser cookie mode: how long one delivery's signed first sync is sent again on its retries instead of a new wallet
 * prompt, ms (half the 10 minutes the API takes an Issued time for; an older one is signed anew). TS only: PY signs with
 * a local key, which asks no one.
 */
const SIGNED_SYNC_REUSE_MS = 5 * 60_000;

/** Agent.agentId is an Int on the API (0..2^31-1). */
const MAX_AGENT_ID = 2147483647;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface SyncOptions {
  /**
   * Total attempts per sync, first one included (default 6). An agent sync (`POST /api/agents`) makes at most
   * AGENT_SYNC_MAX_ATTEMPTS (3): each post counts against the wallet's hourly quota there.
   */
  attempts?: number;
  /**
   * Delay before the first retry; doubled for each next one (default 1000 → 1s, 2s, 4s, 8s, 16s). An agent sync waits
   * AGENT_RETRY_DELAY_FACTOR (5) times as long (5 s, then 10 s).
   */
  baseDelayMs?: number;
  /**
   * Cap for one wait (default 60000): a backoff step, or a 429's wait until `X-RateLimit-Reset` / `Retry-After`
   * (the API's rate-limit window is 60 s, so one capped wait normally clears it).
   */
  maxDelayMs?: number;
  /** Timeout of one HTTP attempt (default 15000). */
  timeoutMs?: number;
  /**
   * Node only: append each sync that failed for good to this JSON-lines file, so another process can flush it. The
   * browser build has no file system: setting it there throws ValidationError('queueFile').
   */
  queueFile?: string;
}

/** Body of `POST /api/agents` (kept with a queued agent registration). */
export interface AgentSyncPayload {
  /** The registering wallet (the API key's / session's wallet). */
  wallet: string;
  /**
   * ERC-8004 token id from the `Registered` event: a whole number (or bigint, as PY takes any int) 0..2147483647. A
   * queued entry keeps it as a number. Anything else (null, a boolean, a string, a fraction) is refused at delivery:
   * logged, not sent, not queued.
   */
  agentId: number | bigint;
  /** At most 100 characters (server default "Basis Agent"). */
  name?: string;
  /** At most 500 characters. */
  description?: string;
}

/** Credentials for `POST /api/agents` (the tx sync sends none). */
export interface SyncAuth {
  apiKey?: string | null;
  /**
   * The wallet the API key belongs to: the key goes only with an agent entry of that wallet (any case). An entry of
   * another wallet, or any entry when this is not set (the key's wallet is unknown), is posted without the key (the API
   * would answer 403 `forbidden`, which is final, and the entry would be lost), or kept unposted (`auth_required`) when
   * no credential is left. The client passes its signer's (recorded when the key is set, made or loaded); a standalone
   * flush passes the wallet its key belongs to.
   */
  apiKeyWallet?: string | null;
  /** `Cookie` header value of the SIWE session. */
  sessionCookie?: string | null;
  /**
   * Browser cookie mode: the browser holds the SIWE session (an HttpOnly cookie JavaScript cannot read). The post is
   * then sent with `credentials: 'include'` (and `X-Wallet-Address`) instead of a `Cookie` header.
   */
  browserSession?: boolean;
  /**
   * How the client's session cookie travels. `browser`: a post sent without the session goes with
   * `credentials: 'omit'`, so the browser cannot attach its HttpOnly session cookie (the server would prefer that
   * session, possibly another wallet's, over the API key); and the signed first sync is signed once per delivery, not
   * once per attempt (each signature is a wallet prompt there).
   */
  cookieMode?: 'browser' | 'explicit';
  /**
   * The wallets the client's SIWE session holds (any case): the session goes only with an agent entry of one of them.
   * An entry of another wallet, or any entry when this is not set, is posted without the session (key only), or kept
   * unposted (`auth_required`) when there is no key: a queued registration of wallet A never goes out with wallet B's
   * session after a signer switch.
   */
  sessionWallets?: readonly string[];
  /**
   * Signs the first sync of `wallet`'s agent `agentId` (`kind: 'agentSigned'` entries): resolves to the
   * `POST /api/agents` body `{agentId, message, signature}`, signed now (a new Issued time each call). The client passes
   * its own; it throws `SignerUnavailableError` for another wallet than its signer. Without it such entries stay queued
   * (code `signer_required`).
   */
  signAgentSync?: (wallet: string, agentId: number) => Promise<SignedAgentSyncBody>;
}

/** Body of the signed first sync (`POST /api/agents` without a sign-in). */
export interface SignedAgentSyncBody {
  agentId: number;
  /** The exact text the agent wallet signed (`buildAgentSyncMessage`). */
  message: string;
  signature: string;
}

/** Thrown by a `signAgentSync` that holds no signer for the wallet asked for: the entry stays queued (`signer_required`). */
export class SignerUnavailableError extends Error {
  readonly code = 'signer_required';
  constructor(message: string) {
    super(message);
    this.name = 'SignerUnavailableError';
  }
}

/** A sync that could not be delivered (kept in `client.pendingSyncs`, one JSON line in `queueFile`). */
export interface PendingSync {
  /**
   * Absent: the tx sync of `hash`. `agent`: the `POST /api/agents` of `agent` with a key or session, registered by tx
   * `hash`. `agentSigned`: the signed first sync of `agent.wallet`'s agent `agent.agentId` (signed again at delivery).
   * The queue file writes `tx` for a tx sync.
   */
  kind?: 'agent' | 'agentSigned';
  /** Transaction hash. */
  hash: string;
  /** kind `agent`: the body to post; kind `agentSigned`: the wallet and agentId (no signed message is ever kept). */
  agent?: AgentSyncPayload;
  /**
   * The API the entry belongs to (the client's `apiDomain` when it was queued). A flush against another API leaves it
   * queued, untouched. Absent on lines of older queue files: any API flushes those.
   */
  apiDomain?: string;
  /** Attempts made so far (all flushes included). */
  attempts: number;
  lastError: string;
  /** `code` of the last error answer (e.g. `chain_mismatch`, `rate_limited`, `sync_failed`), null when there was none. */
  code: string | null;
  /** ISO time of the last failure. */
  at: string;
  /** ISO time the entry was first queued (absent on lines of older queue files: `at` stands in). */
  queuedAt?: string;
  /**
   * The tx's sender (`from`) and the contract it called (`to`): on every tx line the write pipeline queues (lines
   * of an older queue file may carry neither, or a sender only; a line rewritten to a replacement's hash keeps no
   * `to`). `agent.registerAndSync` reads on chain only the lines of its wallet (or with no sender) whose `to` is the
   * identity registry or absent. A tx sent but not seen confirmed (code `not_confirmed`) also has its nonce (when
   * known: an injected wallet picks it) and the latest block before sending: the flush checks such an entry on the
   * chain with them (`checkQueuedTx`).
   */
  from?: string;
  to?: string;
  nonce?: number;
  block?: number;
}

/**
 * The tx behind a sync (`client.syncTx(hash, meta)`, `client.queueSync(hash, reason, meta)`): its sender, the contract
 * it called, and for a tx sent but not seen confirmed its nonce and the latest block before sending. Each is recorded
 * on the queue line when given (null or absent: not known).
 */
export interface QueuedTxMeta {
  from?: string;
  to?: string;
  nonce?: number;
  block?: number;
}

export interface FlushResult {
  /** Entries delivered by this flush. */
  synced: number;
  /** Entries still failing (kept queued) or rejected for good (400 / reverted, dropped). */
  failed: number;
}

/** What an agent sync applied to the wallet's profile from its registration file (`AgentRegistration.applied`). */
export interface AgentApplied {
  /** The registration name as username: `reason` says why not (`no_name`, `unusable`, `reserved`, `taken`, `chosen_name_kept`, ...). */
  username: { applied: boolean; username?: string; reason?: string };
  /** The registration image as the avatar: `reason` says why not (`no_image`, `chosen_photo_kept`, `unreadable`, ...). */
  photo: { applied: boolean; reason?: string };
}

/** Outcome of one sync with its retries (`client.syncTx`). */
export interface SyncResult {
  /** True when the API accepted the transaction: a 2xx whose body acknowledges the posted hash (or agent). */
  ok: boolean;
  /**
   * The API's `status`: `synced` | `already_synced` | `partial` | `ignored` (no BASIS event) on a 2xx;
   * `pending` | `reverted` | `error` on a 422; null when the answer had none (network error, other statuses).
   * An agent registration (`client.syncAgentRegistration`) says `registered` when delivered.
   */
  status: string | null;
  /**
   * `code` of the last error answer (`pending`, `sync_failed`, `reverted`, `rate_limited`, `chain_mismatch`, ...), else
   * null; `unacknowledged` for a 2xx whose body did not acknowledge the post (empty, not JSON, another hash).
   */
  code: string | null;
  /** HTTP status of the last answer; 0 for a network error, a timeout (body read included) or a hash never posted. */
  httpStatus: number;
  attempts: number;
  /** True when it was kept in `pendingSyncs` (+ `queueFile`) for `flushPendingSyncs()`. */
  queued: boolean;
  /** Last error ('' when delivered). */
  lastError: string;
  /**
   * An agent registration that was delivered: what the API applied to the wallet's profile from the registration file
   * (the name as username, the image as avatar, each with `reason` when not). Null when the answer did not say (an API
   * without it); absent on a tx sync.
   */
  applied?: AgentApplied | null;
}

/** Outcome of `deliverSync`: a `SyncResult` without the queueing, plus whether queueing is worth it. */
export interface DeliveryResult extends Omit<SyncResult, 'queued'> {
  /** False for a permanent rejection (400, 422 reverted, 409, malformed hash or body): flushing it later cannot help. */
  queue: boolean;
}

export const DEFAULT_SYNC_OPTIONS = { attempts: 6, baseDelayMs: 1000, maxDelayMs: 60000, timeoutMs: 15000 } as const;

/** Largest ms option: 2^31 - 1 (setTimeout's limit; a larger delay would fire at once). Same rule in PY. */
export const MAX_SYNC_MS = 2_147_483_647;
const OPTION_KEYS = ['attempts', 'baseDelayMs', 'maxDelayMs', 'timeoutMs', 'queueFile'] as const;

type ResolvedSyncOptions = { attempts: number; baseDelayMs: number; maxDelayMs: number; timeoutMs: number; queueFile?: string };

/** What the last answer said (kept on the result). */
type Answer = { status: string | null; code: string | null; httpStatus: number; error: string };

/** Outcome of one HTTP attempt. */
type Attempt = Answer & (
  /** `applied`: an agent sync's answer about the profile (`SyncResult.applied`). */
  | { kind: 'ok'; applied?: AgentApplied | null }
  /** `waitMs`: the server's wait (429), used instead of the backoff step. */
  | { kind: 'retry'; waitMs?: number }
  /** No retry. `queue`: keep it for a later flush; otherwise it is dropped. */
  | { kind: 'stop'; queue: boolean }
);

const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Defaults + `o` (undefined and null values are ignored, as PY None; `o` itself null or undefined: the defaults),
 * validated: an unknown key throws `ValidationError('sync')`, a bad value `ValidationError('sync.<option>')`. The ms
 * options run from 0 to `MAX_SYNC_MS`.
 */
export function resolveSyncOptions(o: SyncOptions | null = {}): ResolvedSyncOptions {
  if (o == null) o = {};
  const proto = typeof o === 'object' ? Object.getPrototypeOf(o) : undefined;
  if (typeof o !== 'object' || Array.isArray(o) || (proto !== Object.prototype && proto !== null)) {
    throw new ValidationError('sync', `sync options must be an object, got ${Array.isArray(o) ? 'an array' : typeof o === 'object' ? 'an object that is not a plain { ... }' : typeof o}`);
  }
  for (const k of Object.keys(o)) {
    if (!(OPTION_KEYS as readonly string[]).includes(k)) {
      throw new ValidationError('sync', `unknown sync option '${k}' (expected one of ${OPTION_KEYS.join(', ')})${didYouMean([k], OPTION_KEYS)}`);
    }
  }
  const r = { ...DEFAULT_SYNC_OPTIONS, ...stripAbsent(o) } as ResolvedSyncOptions;
  if (PLATFORM === 'browser' && r.queueFile) {
    throw new ValidationError(
      'queueFile',
      'sync.queueFile needs a file system (Node.js only); the browser build of basis-sdk has none. Leave it out: queued ' +
      'syncs stay in client.pendingSyncs for client.flushPendingSyncs().',
    );
  }
  if (!Number.isInteger(r.attempts) || r.attempts < 1) {
    throw new ValidationError('sync.attempts', `sync.attempts must be an integer >= 1, got ${String(r.attempts)}`);
  }
  for (const k of ['baseDelayMs', 'maxDelayMs', 'timeoutMs'] as const) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0 || r[k] > MAX_SYNC_MS) {
      throw new ValidationError(`sync.${k}`, `sync.${k} must be a number of ms from 0 to ${MAX_SYNC_MS}, got ${String(r[k])}`);
    }
  }
  if (r.queueFile !== undefined && (typeof r.queueFile !== 'string' || !r.queueFile)) {
    throw new ValidationError('sync.queueFile', `sync.queueFile must be a non-empty path, got ${JSON.stringify(r.queueFile)}`);
  }
  return r;
}

/** `o` without its undefined and null values (an option not given; `o` null: nothing). */
function stripAbsent<T extends object>(o: T | null | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null)) as Partial<T>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The `applied` of an agent sync's answer (`{username: {applied, ...}, photo: {applied, ...}}`), or null. */
function appliedOf(v: unknown): AgentApplied | null {
  const part = (x: unknown) => (x && typeof x === 'object' && typeof (x as { applied?: unknown }).applied === 'boolean' ? x : null);
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const username = part(o.username);
  const photo = part(o.photo);
  return username && photo ? ({ username, photo } as AgentApplied) : null;
}

/** `Retry-After` in ms (delta-seconds or an HTTP date), or undefined. */
function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/**
 * A 429's wait in ms: until `X-RateLimit-Reset` (epoch seconds, measured from the answer's `Date` header when present so
 * a skewed local clock does not matter), else `Retry-After`; undefined when neither is usable.
 */
function rateLimitWaitMs(h: Headers): number | undefined {
  const reset = Number(h.get('X-RateLimit-Reset') ?? NaN);
  if (Number.isFinite(reset) && reset > 0) {
    const date = Date.parse(h.get('Date') ?? '');
    return Math.max(0, reset * 1000 - (Number.isNaN(date) ? Date.now() : date));
  }
  return retryAfterMs(h.get('Retry-After'));
}

type Route = 'tx' | 'agent' | 'agentSigned';

/** The `status` values of a 2xx `POST /api/v1/sync` answer. */
const SYNC_OK_STATUSES: readonly string[] = ['synced', 'already_synced', 'partial', 'ignored'];

/** 403 codes of `POST /api/agents` that no retry or flush can change (a person's wallet, not the agent's, no BASIS mark). */
const FINAL_AGENT_403: readonly (string | null)[] = ['wallet_in_account', 'forbidden', 'not_branded'];

/** Lower case, no trailing slash: how two `apiDomain`s are compared. */
export const sameApiDomain = (a: string, b: string): boolean =>
  String(a).replace(/\/+$/, '').toLowerCase() === String(b).replace(/\/+$/, '').toLowerCase();

/** Hosts an `apiDomain` may reach over plain http (a local server: nothing leaves the machine). */
const LOCAL_HTTP_HOSTS = ['localhost', '127.0.0.1'];

/**
 * `raw` as an `apiDomain`, without trailing slashes: an absolute https URL with no path, query, fragment or user info
 * (plain http only for localhost and 127.0.0.1: an API key or session would go out in clear text), else
 * ValidationError('apiDomain'). The client's rule (`BasisClient` checks its own with it) and the standalone sync
 * helpers'. Same rule in PY (`check_api_domain`).
 */
export function checkApiDomain(raw: string): string {
  const s = String(raw).replace(/\/+$/, '');
  const bad = (why: string) => new ValidationError('apiDomain',
    `apiDomain ${JSON.stringify(raw)} ${why}. Pass the API's origin, e.g. 'https://paper.launchonbasis.com'.`);
  if (s !== s.trim() || /[?#\\\s]/.test(s)) throw bad('must be a bare origin (no spaces, query or fragment)');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('is not an absolute URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('must start with https://');
  if (!u.hostname) throw bad('is not an absolute URL');
  if (u.protocol === 'http:' && !LOCAL_HTTP_HOSTS.includes(u.hostname)) {
    throw bad('must use https (plain http only for localhost and 127.0.0.1: an API key or session would go out in clear text)');
  }
  if (u.username || u.password) throw bad('must not carry a user name or password');
  if (u.pathname !== '/' && u.pathname !== '') throw bad('must have no path');
  return s;
}

/**
 * Why a 2xx answer is not an acknowledgement, or null when it is one. `body` is what the answer must echo.
 * tx route: `{success: true, status: SYNC_OK_STATUSES, chainId: integer, txHash: the posted hash (any case)}`.
 * agent routes: `{success: true, agent: {wallet: the posted wallet (any case), agentId: the posted id}}`.
 */
function ackProblem(route: Route, text: string, parsed: Record<string, unknown> | null, body: Record<string, unknown>): string | null {
  if (!text.trim()) return 'empty body';
  if (!parsed) return 'body is not a JSON object';
  if (parsed.success !== true) return 'success is not true';
  if (route === 'tx') {
    if (typeof parsed.status !== 'string' || !SYNC_OK_STATUSES.includes(parsed.status)) return `unknown status ${JSON.stringify(parsed.status)}`;
    if (!Number.isInteger(parsed.chainId)) return 'no chainId';
    if (typeof parsed.txHash !== 'string' || parsed.txHash.toLowerCase() !== String(body.txHash).toLowerCase()) {
      return `txHash ${JSON.stringify(parsed.txHash)} is not the posted one`;
    }
    return null;
  }
  const a = parsed.agent as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'no agent';
  if (typeof a.wallet !== 'string' || a.wallet.toLowerCase() !== String(body.wallet).toLowerCase()) {
    return `agent.wallet ${JSON.stringify(a.wallet)} is not the posted one`;
  }
  if (String(a.agentId) !== String(body.agentId)) return `agent.agentId ${JSON.stringify(a.agentId)} is not the posted one`;
  return null;
}

/** One POST, classified (see the tables at the top of this file). `expect`: what a 2xx must echo (default `body`). */
async function attemptOnce(
  route: Route, url: string, body: Record<string, unknown>, headers: Record<string, string>, timeoutMs: number,
  credentials?: RequestCredentials, expect: Record<string, unknown> = body,
): Promise<Attempt> {
  let res: Response;
  const timedOut = (e: unknown) => ['TimeoutError', 'AbortError'].includes((e as Error)?.name);
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(credentials ? { credentials } : {}),
      signal: timeoutMs > 0 && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    const error = timedOut(e) ? `timeout after ${timeoutMs}ms` : `network error: ${(e as Error)?.message ?? e}`;
    return { kind: 'retry', status: null, code: null, httpStatus: 0, error };
  }
  const s = res.status;
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    const error = timedOut(e)
      ? `timeout after ${timeoutMs}ms reading the body of an HTTP ${s} answer`
      : `network error reading the body of an HTTP ${s} answer: ${(e as Error)?.message ?? e}`;
    return { kind: 'retry', status: null, code: null, httpStatus: 0, error };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j;
  } catch {  }
  const status = str(parsed?.status);
  const code = str(parsed?.code);
  if (res.ok) {
    const why = ackProblem(route, text, parsed, expect);
    if (why) {
      return { kind: 'retry', status: null, code: 'unacknowledged', httpStatus: s, error: `HTTP ${s} without an acknowledgement (${why})${text ? `: ${short(text)}` : ''}` };
    }
    if (route !== 'tx') return { kind: 'ok', status: 'registered', code: null, httpStatus: s, error: '', applied: appliedOf(parsed!.applied) };
    const partial = status === 'partial' ? `partial: ${str(parsed!.projectError) ?? 'some events were not stored'}` : '';
    return { kind: 'ok', status, code: null, httpStatus: s, error: partial };
  }
  const a: Answer = { status, code, httpStatus: s, error: `HTTP ${s}${text ? `: ${short(text)}` : ''}` };
  if (s === 400) return { kind: 'stop', queue: false, ...a };
  if (route !== 'tx') {
    if (s === 409) return { kind: 'stop', queue: false, ...a };
    if (route === 'agentSigned' && (s === 401 || s === 403)) return { kind: 'stop', queue: false, ...a };
    if (s === 403 && FINAL_AGENT_403.includes(code)) return { kind: 'stop', queue: false, ...a };
    if (s === 403 && code === 'wallet_not_linked') return { kind: 'stop', queue: false, ...a };
    if (s === 429) return { kind: 'stop', queue: true, ...a };
    if (s === 503 && code === 'not_deployed') return { kind: 'stop', queue: true, ...a };
  } else if (s === 422) {
    const kind = code ?? (status === 'error' ? 'sync_failed' : status);
    if (kind === 'reverted') return { kind: 'stop', queue: false, ...a };
    return { kind: 'retry', ...a };
  }
  if (s === 429) return { kind: 'retry', waitMs: rateLimitWaitMs(res.headers), ...a };
  if (s === 503 && code === 'chain_mismatch') return { kind: 'stop', queue: true, ...a };
  if (s >= 500 || s === 408 || s === 425) return { kind: 'retry', ...a };
  return { kind: 'stop', queue: true, ...a };
}

/** Why an agent post was refused for good, for the log. */
function agentRefusal(a: Answer): string {
  if (a.httpStatus === 409) return 'that agentId is synced to another wallet that still controls it';
  if (a.code === 'wallet_in_account') return 'this wallet belongs to a BASIS account (X, Google or email), and an agent needs a wallet of its own';
  if (a.code === 'forbidden') return 'this wallet is neither the owner nor the agent wallet of that agentId on the registry';
  if (a.code === 'not_branded') return 'the agent carries no BASIS mark';
  if (a.code === 'invalid_signature') return 'the signed message was refused';
  return 'refused';
}

/**
 * True when the wallet declined to sign: EIP-1193 code 4001 (viem's UserRejectedRequestError), on the error or its
 * causes.
 */
function userRejected(e: unknown): boolean {
  let c = e as { code?: unknown; name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; c && typeof c === 'object' && i < 8; i++, c = c.cause as typeof c) {
    if (c.code === 4001 || c.name === 'UserRejectedRequestError') return true;
  }
  return false;
}

/**
 * A signing step's failure (`SyncAuth.signAgentSync`) as an attempt: no signer is queued, a ValidationError is final,
 * a declined signature stops and is queued (`user_rejected`: never asked again within this delivery).
 */
function signFailure(e: unknown): Attempt {
  const err = e as { code?: unknown; rule?: unknown; status?: unknown; message?: unknown } | null;
  const error = `could not sign the agent sync: ${errorText(e)}`;
  if (err?.code === 'signer_required') return { kind: 'stop', queue: true, status: null, code: 'signer_required', httpStatus: 0, error };
  if (userRejected(e)) return { kind: 'stop', queue: true, status: null, code: 'user_rejected', httpStatus: 0, error };
  if (typeof err?.rule === 'string') return { kind: 'stop', queue: false, status: null, code: err.rule, httpStatus: 0, error };
  const s = typeof err?.status === 'number' ? err.status : 0;
  const code = typeof err?.code === 'string' ? err.code : null;
  if (s === 0 || s >= 500 || s === 408 || s === 425 || s === 429) return { kind: 'retry', status: null, code, httpStatus: 0, error };
  return { kind: 'stop', queue: true, status: null, code, httpStatus: 0, error };
}

/**
 * The retry loop shared by the routes: POSTs `body` to `base + path` until delivered, stopped or out of attempts (an
 * agent route: at most AGENT_SYNC_MAX_ATTEMPTS, AGENT_RETRY_DELAY_FACTOR times further apart: its quota counts every
 * post). `body` may be a function, called for every attempt (the signed first sync signs afresh each time); `expect` is
 * what a 2xx must echo (default the body). Never throws; does not queue. `what` names the item in the logs.
 */
async function deliver(
  route: Route, base: string, path: string, body: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
  headers: Record<string, string>, what: string, o: ResolvedSyncOptions, credentials?: RequestCredentials,
  expect?: Record<string, unknown>,
): Promise<DeliveryResult> {
  const url = `${base}${path}`;
  const agentRoute = route !== 'tx';
  const attempts = agentRoute ? Math.min(o.attempts, AGENT_SYNC_MAX_ATTEMPTS) : o.attempts;
  const delayFactor = agentRoute ? AGENT_RETRY_DELAY_FACTOR : 1;
  let last: Answer = { status: null, code: null, httpStatus: 0, error: '' };
  for (let i = 1; i <= attempts; i++) {
    let a: Attempt | null = null;
    let b: Record<string, unknown> = {};
    if (typeof body === 'function') {
      try {
        b = await body();
      } catch (e) {
        a = signFailure(e);
      }
    } else {
      b = body;
    }
    if (!a) a = await attemptOnce(route, url, b, headers, o.timeoutMs, credentials, expect ?? b);
    if (a.kind === 'ok') {
      if (a.error) console.warn(`[basis-sdk] ${what} is ${a.error}`);
      const applied = route === 'tx' ? {} : { applied: a.applied ?? null };
      return { ok: true, status: a.status, code: null, httpStatus: a.httpStatus, attempts: i, lastError: '', queue: false, ...applied };
    }
    last = a;
    if (a.kind === 'stop') {
      if (a.code === 'chain_mismatch' || (route !== 'tx' && a.code === 'not_deployed')) {
        const why = a.code === 'chain_mismatch' ? 'is on another chain' : 'has no ERC-8004 registry';
        console.error(
          `[basis-sdk] ${what}: the API at ${base} ${why} (${a.code}: ${a.error}). ` +
          'Not retried; check apiDomain / the chain, then call client.flushPendingSyncs().',
        );
      } else if (route !== 'tx' && a.httpStatus === 429) {
        console.warn(`[basis-sdk] ${what} rate limited (${a.error}): the API takes 10 agent syncs an hour per wallet. Queued: call client.flushPendingSyncs() after the hour.`);
      } else if (route !== 'tx' && a.code === 'wallet_not_linked') {
        console.warn(`[basis-sdk] ${what}: this wallet cannot sign in yet (${a.error}); its agent needs the signed first sync.`);
      } else if (a.code === 'user_rejected') {
        console.warn(`[basis-sdk] ${what}: the wallet declined to sign it (not asked again now). Queued: client.flushPendingSyncs() asks once more.`);
      } else if (!a.queue && a.httpStatus === 0 && route === 'agentSigned') {
        console.error(`[basis-sdk] ${what} not sent: ${a.error} (not retried, not queued)`);
      } else if (!a.queue) {
        const why = a.httpStatus === 400
          ? ' (malformed request: SDK bug, please report)'
          : route !== 'tx' ? ` (${agentRefusal(a)}: not retried, not queued)` : ' (reverted: not retried, not queued)';
        (a.httpStatus === 400 || route !== 'tx' ? console.error : console.warn)(`[basis-sdk] ${what} rejected: ${a.error}${why}`);
      }
      return { ok: false, status: a.status, code: a.code, httpStatus: a.httpStatus, attempts: i, lastError: a.error, queue: a.queue };
    }
    if (i < attempts) {
      const backoff = Math.min(o.baseDelayMs * delayFactor * 2 ** (i - 1), o.maxDelayMs);
      await sleep(a.waitMs ? Math.min(a.waitMs, o.maxDelayMs) : backoff);
    }
  }
  return { ok: false, status: last.status, code: last.code, httpStatus: last.httpStatus, attempts, lastError: last.error, queue: true };
}

/**
 * POSTs `{txHash, source: "sdk"}` to `apiDomain + SYNC_ROUTE` with retries and backoff. Never throws on a delivery
 * failure; does not queue (the engine does). Logs permanent rejections, a chain mismatch and partial syncs. An
 * `apiDomain` the client would refuse (`checkApiDomain`: https, plain http only for localhost) or bad options throw
 * ValidationError before anything is sent.
 */
export async function deliverSync(apiDomain: string, txHash: string, options: SyncOptions | null = {}): Promise<DeliveryResult> {
  return postSync(checkApiDomain(apiDomain), txHash, options);
}

/** `deliverSync` without the `apiDomain` check: the engine posts to its client's (checked when the client was made). */
async function postSync(apiDomain: string, txHash: string, options: SyncOptions | null = {}): Promise<DeliveryResult> {
  const o = resolveSyncOptions(options);
  if (typeof txHash !== 'string' || !HASH.test(txHash)) {
    const lastError = `invalid txHash ${JSON.stringify(txHash)}: expected 0x + 64 hex characters`;
    console.error(`[basis-sdk] sync not sent: ${lastError} (SDK bug, please report)`);
    return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, lastError, queue: false };
  }
  const body = { txHash, source: SYNC_SOURCE };
  return deliver('tx', apiDomain.replace(/\/+$/, ''), SYNC_ROUTE, body, {}, `sync of ${txHash}`, o, PLATFORM === 'browser' ? 'omit' : undefined);
}

/**
 * An agentId as a JSON-safe number: a bigint becomes a number (exact for every id the API takes; a bigint above 2^53
 * stays above the range, so it is still refused), any other value is left as it is (the strict check below judges it).
 */
const agentIdNumber = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v);

/**
 * `agent` as a POST /api/agents body, or why it cannot be one. `agentId`: a whole number or a bigint from 0 to
 * 2147483647 (sent as a number); null, a boolean, a string or a fraction is refused (same rule as PY `_agent_body`).
 */
function agentBody(agent: AgentSyncPayload): { body: Record<string, unknown> } | { error: string } {
  if (!agent || typeof agent.wallet !== 'string' || !ADDRESS.test(agent.wallet)) {
    return { error: `invalid wallet ${JSON.stringify(agent?.wallet)}: expected 0x + 40 hex characters` };
  }
  const id = agentIdNumber(agent.agentId);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id > MAX_AGENT_ID) {
    return { error: `agentId ${String(agent.agentId)} is outside 0..${MAX_AGENT_ID} (the API stores an Int)` };
  }
  const body: Record<string, unknown> = { wallet: agent.wallet, agentId: id };
  if (agent.name) body.name = agent.name;
  if (agent.description) body.description = agent.description;
  return { body };
}

/**
 * POSTs `agent` to `apiDomain + AGENT_SYNC_ROUTE` with `auth` (`X-API-Key` and / or the session `Cookie` with
 * `X-Wallet-Address`; in browser cookie mode the browser's session cookie, `credentials: 'include'`, and
 * `credentials: 'omit'` when the session does not go along), retried like a tx sync. The session goes only with an
 * entry of a wallet it holds (`auth.sessionWallets`), the key only with an entry of its own wallet
 * (`auth.apiKeyWallet`): a credential whose wallet is not known never goes along. Never throws on a delivery failure;
 * does not queue. Without credentials nothing is sent and the result asks to be queued (code `auth_required`); a
 * malformed body is logged and not queued. An `apiDomain` the client would refuse (`checkApiDomain`) or bad options
 * throw ValidationError before anything is sent.
 */
export async function deliverAgentSync(
  apiDomain: string, agent: AgentSyncPayload, auth: SyncAuth | null = {}, options: SyncOptions | null = {},
): Promise<DeliveryResult> {
  return postAgentSync(checkApiDomain(apiDomain), agent, auth, options);
}

/** True when `wallet` is one of `wallets` (any case). */
const holds = (wallets: readonly string[] | null | undefined, wallet: string): boolean =>
  Array.isArray(wallets) && wallets.some((w) => typeof w === 'string' && w.toLowerCase() === wallet.toLowerCase());

/** `deliverAgentSync` without the `apiDomain` check (the engine's own API). */
async function postAgentSync(
  apiDomain: string, agent: AgentSyncPayload, auth: SyncAuth | null = {}, options: SyncOptions | null = {},
): Promise<DeliveryResult> {
  const o = resolveSyncOptions(options);
  auth = auth ?? {};
  const what = `agent registration of ${agent?.wallet} (agentId ${agent?.agentId})`;
  const b = agentBody(agent);
  if ('error' in b) {
    console.error(`[basis-sdk] ${what} not sent: ${b.error}`);
    return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, lastError: b.error, queue: false };
  }
  if ((auth.sessionCookie || auth.browserSession) && !holds(auth.sessionWallets, agent.wallet)) {
    auth = { ...auth, sessionCookie: null, browserSession: false };
  }
  if (auth.apiKey && !(typeof auth.apiKeyWallet === 'string' && auth.apiKeyWallet.toLowerCase() === agent.wallet.toLowerCase())) {
    auth = { ...auth, apiKey: null };
  }
  if (!auth.apiKey && !auth.sessionCookie && !auth.browserSession) {
    const lastError = `POST ${AGENT_SYNC_ROUTE} needs an API key or a SIWE session of ${agent.wallet}: authenticate, then call client.flushPendingSyncs()`;
    return { ok: false, status: null, code: 'auth_required', httpStatus: 0, attempts: 0, lastError, queue: true };
  }
  const headers: Record<string, string> = {};
  if (auth.apiKey) headers['X-API-Key'] = auth.apiKey;
  if (auth.sessionCookie) {
    headers.Cookie = auth.sessionCookie;
    headers['X-Wallet-Address'] = agent.wallet;
  }
  const browser = !auth.sessionCookie && auth.browserSession === true;
  if (browser) headers['X-Wallet-Address'] = agent.wallet;
  const credentials: RequestCredentials | undefined = browser ? 'include' : auth.cookieMode === 'browser' || PLATFORM === 'browser' ? 'omit' : undefined;
  return deliver('agent', apiDomain.replace(/\/+$/, ''), AGENT_SYNC_ROUTE, b.body, headers, what, o, credentials);
}

/**
 * POSTs the signed first sync of `agent.wallet`'s agent `agent.agentId` to `apiDomain + AGENT_SYNC_ROUTE` without
 * credentials, retried like a tx sync, with the message signed afresh for every attempt by `auth.signAgentSync` (a new
 * Issued time; a message from an earlier delivery is never sent again). With `auth.cookieMode` 'browser' or in the
 * browser build (each signature a wallet prompt) it is signed once per delivery and that body goes again on the retries while younger than
 * SIGNED_SYNC_REUSE_MS (5 min; the API takes an Issued time up to 10 min old). A 2xx counts only when it echoes the wallet and agentId. Never
 * throws on a delivery failure; does not queue. Without `signAgentSync` nothing is sent and the result asks to be
 * queued (code `signer_required`); a malformed wallet or agentId is logged and not queued. An `apiDomain` the client
 * would refuse (`checkApiDomain`) or bad options throw ValidationError before anything is signed or sent.
 */
export async function deliverAgentSignedSync(
  apiDomain: string, agent: Pick<AgentSyncPayload, 'wallet' | 'agentId'>, auth: SyncAuth | null = {}, options: SyncOptions | null = {},
): Promise<DeliveryResult> {
  return postAgentSignedSync(checkApiDomain(apiDomain), agent, auth, options);
}

/** `deliverAgentSignedSync` without the `apiDomain` check (the engine's own API). */
async function postAgentSignedSync(
  apiDomain: string, agent: Pick<AgentSyncPayload, 'wallet' | 'agentId'>, auth: SyncAuth | null = {}, options: SyncOptions | null = {},
): Promise<DeliveryResult> {
  const o = resolveSyncOptions(options);
  auth = auth ?? {};
  const what = `signed agent sync of ${agent?.wallet} (agentId ${agent?.agentId})`;
  const b = agentBody({ wallet: agent?.wallet, agentId: agent?.agentId } as AgentSyncPayload);
  if ('error' in b) {
    console.error(`[basis-sdk] ${what} not sent: ${b.error}`);
    return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, lastError: b.error, queue: false };
  }
  const sign = auth.signAgentSync;
  if (typeof sign !== 'function') {
    const lastError = `the signed first sync of ${agent.wallet} needs that wallet's signer: call client.flushPendingSyncs() from a client with it`;
    return { ok: false, status: null, code: 'signer_required', httpStatus: 0, attempts: 0, lastError, queue: true };
  }
  const agentId = b.body.agentId as number;
  const expect = { wallet: agent.wallet, agentId };
  const once = auth.cookieMode === 'browser' || PLATFORM === 'browser';
  let signed: { body: Record<string, unknown>; at: number } | null = null;
  const body = async () => {
    if (once && signed && Date.now() - signed.at < SIGNED_SYNC_REUSE_MS) return signed.body;
    const at = Date.now();
    const s = await sign(agent.wallet, agentId);
    const fresh = { agentId: s.agentId, message: s.message, signature: s.signature } as Record<string, unknown>;
    if (once) signed = { body: fresh, at };
    return fresh;
  };
  const credentials: RequestCredentials | undefined = auth.cookieMode === 'browser' || PLATFORM === 'browser' ? 'omit' : undefined;
  return deliver('agentSigned', apiDomain.replace(/\/+$/, ''), AGENT_SYNC_ROUTE, body, {}, what, o, credentials, expect);
}


const entryKey = (e: PendingSync) => `${e.kind ?? 'tx'}:${String(e.hash).toLowerCase()}`;

/**
 * Merge entries by kind and hash (the later one wins, attempts as the max, the sender / target / nonce / block it lacks
 * and the earliest `queuedAt` taken from the earlier one).
 */
function dedupe(entries: PendingSync[]): PendingSync[] {
  const m = new Map<string, PendingSync>();
  for (const e of entries) {
    const prev = m.get(entryKey(e));
    if (!prev) {
      m.set(entryKey(e), e);
      continue;
    }
    const merged: PendingSync = { ...e, attempts: Math.max(prev.attempts, e.attempts) };
    if (merged.from == null && prev.from != null) merged.from = prev.from;
    if (merged.to == null && prev.to != null) merged.to = prev.to;
    if (merged.nonce == null && prev.nonce != null) merged.nonce = prev.nonce;
    if (merged.block == null && prev.block != null) merged.block = prev.block;
    const qa = [prev.queuedAt, e.queuedAt].filter((x): x is string => !!x).sort();
    if (qa.length) merged.queuedAt = qa[0];
    m.set(entryKey(e), merged);
  }
  return [...m.values()];
}

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * A queue-file agent body, checked loosely: delivery validates it. Its `agentId` is kept as the raw JSON value, never
 * converted (null, a boolean, a string or a fraction would otherwise turn into another id, and the file's copy wins
 * over memory in a flush): delivery's strict check refuses such a value (logged, not sent), as PY does.
 */
function agentFrom(v: unknown): AgentSyncPayload {
  const a = v as Partial<AgentSyncPayload> | null;
  if (!a || typeof a !== 'object' || typeof a.wallet !== 'string') throw new Error('no agent');
  const out: AgentSyncPayload = { wallet: a.wallet, agentId: a.agentId as number };
  if (typeof a.name === 'string') out.name = a.name;
  if (typeof a.description === 'string') out.description = a.description;
  return out;
}

/** One queue-file line as an entry; throws when it is malformed. */
function parseQueueLine(line: string): PendingSync {
  const e = JSON.parse(line) as Omit<Partial<PendingSync>, 'kind'> & { kind?: unknown };
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.hash !== 'string') throw new Error('no hash');
  const base: PendingSync = { hash: e.hash, attempts: Number(e.attempts) || 0, lastError: String(e.lastError ?? ''), code: str(e.code), at: String(e.at ?? '') };
  if (typeof e.from === 'string' && ADDRESS.test(e.from)) base.from = e.from;
  if (typeof e.to === 'string' && ADDRESS.test(e.to)) base.to = e.to;
  if (isUint(e.nonce)) base.nonce = e.nonce;
  if (isUint(e.block)) base.block = e.block;
  if (typeof e.queuedAt === 'string' && e.queuedAt) base.queuedAt = e.queuedAt;
  if (typeof e.apiDomain === 'string' && e.apiDomain) base.apiDomain = e.apiDomain;
  if (e.kind == null || e.kind === 'tx') return base;
  if (e.kind === 'agent' || e.kind === 'agentSigned') return { kind: e.kind, ...base, agent: agentFrom(e.agent) };
  throw new Error(`unknown kind ${String(e.kind)}`);
}

/** The queue-file line of `e`: its kind always named (`tx` for a tx sync). */
function toQueueLine(e: PendingSync): string {
  return JSON.stringify({ ...e, kind: e.kind ?? 'tx' });
}

/** `entry` with the known fields of `meta` (`from`, `to`, `nonce`, `block`); null: not known (as PY None), never written. */
function withMeta(entry: PendingSync, meta: QueuedTxMeta | null | undefined): PendingSync {
  const m: QueuedTxMeta = meta ?? {};
  if (m.from != null) entry.from = m.from;
  if (m.to != null) entry.to = m.to;
  if (m.nonce != null) entry.nonce = m.nonce;
  if (m.block != null) entry.block = m.block;
  return entry;
}

/** Delivers one queued entry by its kind (to an `apiDomain` already checked). */
function deliverEntry(apiDomain: string, e: PendingSync, options: SyncOptions, auth: SyncAuth): Promise<DeliveryResult> {
  if (e.kind === 'agent') return postAgentSync(apiDomain, e.agent!, auth, options);
  if (e.kind === 'agentSigned') return postAgentSignedSync(apiDomain, e.agent!, auth, options);
  return postSync(apiDomain, e.hash, options);
}

/**
 * What a flush did with an entry it took (by `entryKey`): delivered, dropped for good, kept with this update, or
 * skipped (another API's entry: left as it is).
 */
type Outcome = { kind: 'delivered' | 'dropped' | 'skipped' } | { kind: 'kept'; entry: PendingSync };


/**
 * A queued tx not found on chain (no receipt, not pending; its nonce unused, or used by a tx no node could find) is
 * dropped once queued this long.
 */
export const UNKNOWN_TX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Entry codes checked on the chain before posting (sent but not seen confirmed / the API's RPC was behind). */
const CHAIN_CHECKED_CODES: readonly (string | null)[] = ['not_confirmed', 'pending'];

/** The reads the chain check needs (a viem PublicClient has them). */
export interface QueueChain {
  getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{ status: string } | null | undefined>;
  getTransaction(a: { hash: `0x${string}` }): Promise<unknown>;
  getTransactionCount(a: { address: `0x${string}`; blockTag?: 'latest'; blockNumber?: bigint }): Promise<number>;
  getBlockNumber(a?: { cacheTime?: number }): Promise<bigint>;
  getBlock(a: { blockNumber: bigint; includeTransactions: true }): Promise<{ transactions: readonly unknown[] }>;
}

/** What a flush does with a tx entry (see the table above); `hash`: the replacement to post instead (`rewrite`). */
export type QueuedTxAction =
  | { action: 'post' }
  | { action: 'keep'; why: string }
  | { action: 'drop'; why: string }
  | { action: 'rewrite'; hash: string; why: string };

const notFound = (e: unknown) => /NotFound/.test((e as Error)?.name ?? '');

async function chainReceipt(c: QueueChain, hash: string) {
  try {
    return (await c.getTransactionReceipt({ hash: hash as `0x${string}` })) ?? null;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

async function chainTx(c: QueueChain, hash: string) {
  try {
    return (await c.getTransaction({ hash: hash as `0x${string}` })) ?? null;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

type MinedTx = { hash: string; from: string; to?: string | null; value?: bigint; nonce: number };

/**
 * The mined tx of `from` with `nonce`: the receipt wait's bisect of the sender's nonce (`nonceBlock`) from `startBlock`,
 * which moves up past state the node no longer keeps. Null when the lookup cannot finish: the tx sits in blocks the node
 * has no state for, the node is behind, or the RPC failed. It never means "no such tx": the caller saw the nonce used.
 */
async function findNonceTx(c: QueueChain, from: string, nonce: number, startBlock?: number): Promise<MinedTx | null> {
  try {
    const latest = await c.getBlockNumber({ cacheTime: 0 });
    const first = BigInt(Math.max(startBlock ?? 0, 0));
    const at = await nonceBlock(c, from as `0x${string}`, nonce, first - 1n, latest);
    const block = await c.getBlock({ blockNumber: at, includeTransactions: true });
    for (const t of block.transactions as MinedTx[]) {
      if (t && typeof t === 'object' && String(t.from).toLowerCase() === from.toLowerCase() && Number(t.nonce) === nonce) return t;
    }
  } catch {  }
  return null;
}

/**
 * What a flush does with tx entry `e` (see the table above). Never throws (a failed check is `post`).
 */
export async function checkQueuedTx(chain: QueueChain, e: PendingSync): Promise<QueuedTxAction> {
  const h = e.hash;
  const queued = Date.parse(e.queuedAt || e.at || '');
  const tooOld = Number.isFinite(queued) && Date.now() - queued > UNKNOWN_TX_MAX_AGE_MS;
  const hours = UNKNOWN_TX_MAX_AGE_MS / 3_600_000;
  try {
    if (await chainReceipt(chain, h)) return { action: 'post' };
    if (await chainTx(chain, h)) return { action: 'keep', why: 'still pending (in the mempool): not posted yet' };
    if (e.from && e.nonce != null) {
      if ((await chain.getTransactionCount({ address: e.from as `0x${string}`, blockTag: 'latest' })) > e.nonce) {
        if (await chainReceipt(chain, h)) return { action: 'post' };
        const t = await findNonceTx(chain, e.from, e.nonce, e.block);
        if (!t && tooOld) {
          return { action: 'drop', why: `nonce ${e.nonce} of ${e.from} was used, but the transaction was not found for over ${hours} h (no old state on the RPC)` };
        }
        if (!t) return { action: 'keep', why: `nonce ${e.nonce} of ${e.from} was used, but this node cannot find the transaction (no old state, or behind): not posted yet; an archive RPC settles it` };
        const th = String(t.hash).toLowerCase();
        if (th === h.toLowerCase()) return { action: 'post' };
        if (String(t.to ?? '').toLowerCase() === e.from.toLowerCase() && BigInt(t.value ?? 0n) === 0n) {
          return { action: 'drop', why: `never mined: cancelled in the wallet by ${th} (same nonce)` };
        }
        const rr = await chainReceipt(chain, th);
        if (!rr) return { action: 'keep', why: `replaced by ${th} (same nonce), whose receipt is not readable yet` };
        if (rr.status !== 'success') return { action: 'drop', why: `never mined: replaced by ${th} (same nonce), which reverted` };
        return { action: 'rewrite', hash: th, why: `never mined: replaced by ${th} (same nonce); syncing that one instead` };
      }
    }
    if (tooOld) return { action: 'drop', why: `unknown to the chain (no receipt, not pending) for over ${hours} h` };
    return { action: 'keep', why: 'not on chain (no receipt, not pending): not posted yet' };
  } catch {
    return { action: 'post' };
  }
}

/**
 * Retries `entries`; returns the counts, the entries still worth keeping and each entry's outcome. With `chain`, tx
 * entries of CHAIN_CHECKED_CODES are checked on the chain first (`checkQueuedTx`). Every tx entry goes before the agent
 * entries, and an agent entry whose tx entry (same hash) is kept as not seen mined (a CHAIN_CHECKED_CODES code: still
 * pending, not on chain, the API's RPC behind) is kept unposted, "waiting for its tx": the API would record the
 * registration as it was before that tx and the entry would be dropped as delivered.
 */
async function retryEntries(apiDomain: string, entries: PendingSync[], options: SyncOptions, auth: SyncAuth, chain?: QueueChain | null) {
  let synced = 0;
  let dropped = 0;
  const keep: PendingSync[] = [];
  const skipped: PendingSync[] = [];
  const outcomes = new Map<string, Outcome>();
  const unmined = new Map<string, string>();
  const declined = new Set<string>();
  const declinedHere = (x: PendingSync) => x.kind === 'agentSigned' && declined.has(String(x.agent?.wallet).toLowerCase());
  const notAskedAgain = (x: PendingSync): DeliveryResult => ({
    ok: false, status: null, code: 'user_rejected', httpStatus: 0, attempts: 0, queue: true,
    lastError: `the wallet ${x.agent?.wallet} declined to sign earlier in this flush: not asked again in it`,
  });
  const ordered = [...entries.filter((x) => x.kind == null), ...entries.filter((x) => x.kind != null)];
  for (let e of ordered) {
    const key = entryKey(e);
    const txHash = String(e.hash).toLowerCase();
    if (e.apiDomain && !sameApiDomain(e.apiDomain, apiDomain)) {
      skipped.push(e);
      outcomes.set(key, { kind: 'skipped' });
      continue;
    }
    if (e.kind != null && unmined.has(txHash)) {
      const kept = { ...e, lastError: `waiting for its tx ${e.hash}: ${unmined.get(txHash)}`, at: new Date().toISOString() };
      keep.push(kept);
      outcomes.set(key, { kind: 'kept', entry: kept });
      continue;
    }
    if (chain && e.kind == null && CHAIN_CHECKED_CODES.includes(e.code)) {
      const c = await checkQueuedTx(chain, e);
      if (c.action === 'keep') {
        const kept = { ...e, lastError: c.why, at: new Date().toISOString() };
        keep.push(kept);
        outcomes.set(key, { kind: 'kept', entry: kept });
        unmined.set(txHash, c.why);
        continue;
      }
      if (c.action === 'drop') {
        console.warn(`[basis-sdk] dropped the queued sync of ${e.hash}: ${c.why}`);
        dropped++;
        outcomes.set(key, { kind: 'dropped' });
        continue;
      }
      if (c.action === 'rewrite') {
        console.warn(`[basis-sdk] queued sync of ${e.hash}: ${c.why}`);
        const { to: _to, ...rest } = e;
        e = { ...rest, hash: c.hash, code: null, lastError: c.why };
      }
    }
    let r = declinedHere(e) ? notAskedAgain(e) : await deliverEntry(apiDomain, e, options, auth);
    if (e.kind === 'agent' && !r.ok && r.code === 'wallet_not_linked') {
      e = { ...e, kind: 'agentSigned', agent: { wallet: e.agent!.wallet, agentId: e.agent!.agentId } };
      const s = declinedHere(e) ? notAskedAgain(e) : await postAgentSignedSync(apiDomain, e.agent!, auth, options);
      r = { ...s, attempts: r.attempts + s.attempts };
    }
    if (!r.ok && r.code === 'user_rejected' && e.agent) declined.add(String(e.agent.wallet).toLowerCase());
    if (r.ok) {
      synced++;
      outcomes.set(key, { kind: 'delivered' });
    } else if (r.queue) {
      const kept = { ...e, attempts: e.attempts + r.attempts, lastError: r.lastError, code: r.code, at: new Date().toISOString() };
      keep.push(kept);
      outcomes.set(key, { kind: 'kept', entry: kept });
      if (e.kind == null && CHAIN_CHECKED_CODES.includes(r.code)) unmined.set(txHash, r.lastError);
    } else {
      dropped++;
      outcomes.set(key, { kind: 'dropped' });
    }
  }
  if (skipped.length) {
    const apis = [...new Set(skipped.map((x) => x.apiDomain))].join(', ');
    console.warn(`[basis-sdk] kept ${skipped.length} queued sync(s) of another API (${apis}) untouched: flush them with a client of that API.`);
  }
  return { synced, dropped, keep, skipped, outcomes };
}


const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

const fsp = loadFs;

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? '';
const randomId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const pid = () => (typeof process !== 'undefined' ? process.pid : 0);

/** Takes `<file>.lock`; returns the token to release it with. Throws after LOCK_WAIT_MS. */
async function lockQueueFile(file: string): Promise<string> {
  const fs = await fsp();
  const lock = `${file}.lock`;
  const token = randomId();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx');
      try {
        await h.writeFile(JSON.stringify({ pid: pid(), lang: 'ts', at: new Date().toISOString(), token }), 'utf8');
      } finally {
        await h.close();
      }
      return token;
    } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(errCode(e))) throw e;
    }
    await _breakStaleLock(lock);
    if (Date.now() > deadline) throw new Error(`sync queue ${file} is locked (${lock}); gave up after ${LOCK_WAIT_MS} ms`);
    await sleep(5 + Math.random() * 20);
  }
}

/**
 * Age in ms of the lock whose content is `content`: from its own `at` (ISO time written by its holder); when that is
 * unreadable (empty: the holder has not written it yet; or foreign), from the file's mtime read AFTER the content (a
 * newer lock only makes it younger). null when the file is gone.
 */
async function lockAgeMs(content: string, file: string): Promise<number | null> {
  let at: unknown;
  try {
    at = content.trim() ? (JSON.parse(content) as { at?: unknown })?.at : undefined;
  } catch {  }
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  if (Number.isFinite(t)) return Date.now() - t;
  try {
    return Date.now() - (await (await fsp()).stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes `lock` when it is older than LOCK_STALE_MS (its holder died), without removing a fresh one: staleness is
 * judged from the same content that is compared after the rename. `beforeRename`: test hook, called just before it.
 * @internal Exported for the tests only (not part of the API).
 */
export async function _breakStaleLock(lock: string, beforeRename?: () => Promise<void> | void): Promise<void> {
  const fs = await fsp();
  let seen: string;
  try {
    seen = await fs.readFile(lock, 'utf8');
  } catch {
    return;
  }
  const age = await lockAgeMs(seen, lock);
  if (age === null || age <= LOCK_STALE_MS) return;
  const aside = `${lock}.stale-${randomId()}`;
  if (beforeRename) await beforeRename();
  try {
    await fs.rename(lock, aside);
  } catch {
    return;
  }
  try {
    const now = await fs.readFile(aside, 'utf8');
    const fresh = now !== seen || (!now.trim() && ((await lockAgeMs(now, aside)) ?? 0) <= LOCK_STALE_MS);
    if (fresh) await fs.link(aside, lock).catch(() => undefined);
    else console.warn(`[basis-sdk] removed a stale sync queue lock ${lock}`);
  } catch {  } finally {
    await fs.unlink(aside).catch(() => undefined);
  }
}

/** How long a holder retries removing its lock while a waiter has it open (Windows: a sharing violation). */
const UNLOCK_RETRY_MS = 5_000;

/**
 * Removes the lock if it is still ours. On Windows a waiter reading the lock (the stale check; a PY process opens it
 * without delete sharing) makes the delete fail for a moment; retried, since a lock left behind looks held for 10 s and
 * is then broken as stale while other writers race for it (appends were lost that way).
 */
async function unlockQueueFile(file: string, token: string): Promise<void> {
  const fs = await fsp();
  const lock = `${file}.lock`;
  const deadline = Date.now() + UNLOCK_RETRY_MS;
  for (;;) {
    try {
      if ((await fs.readFile(lock, 'utf8')).includes(token)) await fs.unlink(lock);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errCode(e))) return;
      if (Date.now() > deadline) {
        console.warn(`[basis-sdk] could not remove the sync queue lock ${lock} (it is broken as stale in 10 s)`);
        return;
      }
      await sleep(2 + Math.random() * 8);
    }
  }
}

/** Runs `fn` holding the queue file's lock. */
async function withQueueLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const token = await lockQueueFile(file);
  try {
    return await fn();
  } finally {
    await unlockQueueFile(file, token);
  }
}

type QueueLines = { line: string; entry: PendingSync }[] & { bad: string[] };

/**
 * The file's lines (trimmed, non-empty) with their entries; `bad`: the lines that cannot be read (malformed, or a kind
 * this version does not know), logged and left out. A write moves them to `<file>.bad` (moveBadLines), never drops them.
 */
async function readQueueLines(file: string): Promise<QueueLines> {
  const out = Object.assign([] as { line: string; entry: PendingSync }[], { bad: [] as string[] });
  let text: string;
  try {
    text = await (await fsp()).readFile(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return out;
    throw e;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push({ line, entry: parseQueueLine(line) });
    } catch {
      out.bad.push(line);
      console.warn(`[basis-sdk] skipping an unreadable line in sync queue ${file}: ${short(line)}`);
    }
  }
  return out;
}

/**
 * Appends the unreadable `bad` lines of `file` to `<file>.bad` (call under the lock, before rewriting the file).
 * Returns the lines to keep in the file: none once they are moved, all of them when the move failed (never lost).
 */
async function moveBadLines(file: string, bad: string[]): Promise<string[]> {
  if (!bad.length) return [];
  try {
    await (await fsp()).appendFile(`${file}.bad`, bad.map((l) => `${l}\n`).join(''), 'utf8');
    console.warn(`[basis-sdk] moved ${bad.length} unreadable line(s) of sync queue ${file} to ${file}.bad`);
    return [];
  } catch (e) {
    console.warn(`[basis-sdk] could not move unreadable lines of sync queue ${file} to ${file}.bad (kept in place): ${(e as Error)?.message}`);
    return bad;
  }
}

/**
 * Entries of a JSON-lines sync queue (`[]` when the file does not exist; unreadable lines are left out here, and moved
 * to `<file>.bad` by the next write). Node only: the browser build throws ValidationError('queueFile').
 */
export async function readSyncQueueFile(file: string): Promise<PendingSync[]> {
  return (await readQueueLines(file)).map((l) => l.entry);
}

/** Replaces the file by `lines` with a temp file + rename, so a crash never leaves half a file. Call under the lock. */
async function replaceQueueFile(file: string, lines: string[]): Promise<void> {
  const fs = await fsp();
  const { dirname, basename, join } = await loadPath();
  const tmp = `${file}.tmp-${pid()}-${randomId()}`;
  try {
    const h = await fs.open(tmp, 'w');
    try {
      await h.writeFile(lines.map((l) => `${l}\n`).join(''), 'utf8');
      await h.sync();
    } finally {
      await h.close();
    }
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (e) {
        if (i >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(errCode(e))) throw e;
        await sleep(20);
      }
    }
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  try {
    const prefix = `${basename(file)}.tmp-`;
    const dir = dirname(file);
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(prefix)) continue;
      const p = join(dir, name);
      if (Date.now() - (await fs.stat(p)).mtimeMs > LOCK_STALE_MS) await fs.unlink(p).catch(() => undefined);
    }
  } catch {  }
}

/**
 * Appends `e` to the queue file (under the lock, temp file + rename). Logs instead of throwing; resolves whether the
 * line was written.
 */
async function appendQueueFile(file: string, e: PendingSync): Promise<boolean> {
  try {
    await withQueueLock(file, async () => {
      const read = await readQueueLines(file);
      const kept = await moveBadLines(file, read.bad);
      await replaceQueueFile(file, [...kept, ...read.map((l) => l.line), toQueueLine(e)]);
    });
    return true;
  } catch (err) {
    console.warn(`[basis-sdk] could not append to sync queue ${file}: ${(err as Error)?.message}`);
    return false;
  }
}

/** A flush's view of the file: its entries and the exact lines they came from. */
async function snapshotQueueFile(file: string): Promise<{ entries: PendingSync[]; lines: Set<string> }> {
  const read = await withQueueLock(file, () => readQueueLines(file));
  return { entries: read.map((l) => l.entry), lines: new Set(read.map((l) => l.line)) };
}

/**
 * Writes a flush's result into the file as it is NOW (re-read under the lock): the `taken` lines with an outcome are
 * removed (delivered, dropped) or replaced once by their updated entry (kept); every other line, appended since the
 * snapshot included, stays. A kept entry no longer in the file (memory only, or removed by another flusher) is added.
 */
async function commitQueueFile(file: string, taken: Set<string>, outcomes: Map<string, Outcome>): Promise<void> {
  await withQueueLock(file, async () => {
    const read = await readQueueLines(file);
    const out: string[] = await moveBadLines(file, read.bad);
    const present = new Set<string>();
    for (const { line, entry } of read) {
      const k = entryKey(entry);
      const o = outcomes.get(k);
      if (o && o.kind !== 'skipped' && taken.has(line)) {
        if (o.kind === 'kept' && !present.has(k)) {
          out.push(toQueueLine(o.entry));
          present.add(k);
        }
        continue;
      }
      out.push(line);
      present.add(k);
    }
    for (const [k, o] of outcomes) if (o.kind === 'kept' && !present.has(k)) out.push(toQueueLine(o.entry));
    await replaceQueueFile(file, out);
  });
}

/**
 * Standalone flush of a sync queue file (e.g. from a cron job or another process): retries every entry against
 * `apiDomain`, then removes the entries it delivered (or that were rejected for good) and updates the ones still
 * failing. Entries appended meanwhile, by this process or another (TS or PY), are kept. Agent registrations need
 * `auth`: an API key with `apiKeyWallet` (the wallet the key belongs to: it goes only with that wallet's entries), or
 * a session cookie with `sessionWallets` (the wallets it holds); a credential without its wallet goes with no entry,
 * and without one the entries stay queued (auth_required). With `chain` (a viem
 * PublicClient on the chain of the entries), sent-but-unconfirmed entries are checked on the chain first
 * (`checkQueuedTx`: posted once mined, dropped or rewritten when their nonce went to another tx). Node only: the
 * browser build throws ValidationError('queueFile'). An `apiDomain` the client would refuse (`checkApiDomain`: https,
 * plain http only for localhost) throws ValidationError('apiDomain') before the file is read.
 */
export async function flushSyncQueueFile(
  file: string, apiDomain: string, options: SyncOptions | null = {}, auth: SyncAuth | null = {}, chain?: QueueChain | null,
): Promise<FlushResult> {
  const api = checkApiDomain(apiDomain);
  const o = resolveSyncOptions(options);
  const snap = await snapshotQueueFile(file);
  const { synced, dropped, keep, outcomes } = await retryEntries(api, dedupe(snap.entries), o, auth ?? {}, chain);
  try {
    await commitQueueFile(file, snap.lines, outcomes);
  } catch (err) {
    console.warn(`[basis-sdk] could not rewrite sync queue ${file}: ${(err as Error)?.message}`);
  }
  return { synced, failed: keep.length + dropped };
}


/** The client's sync engine: `client.syncTx` and `client.syncAgentRegistration` go through it. */
export class SyncEngine {
  /** Syncs that failed after every retry, oldest first. */
  readonly pending: PendingSync[] = [];
  readonly options: ResolvedSyncOptions;

  /**
   * `auth`: the client's current credentials, read at each agent delivery (the tx sync sends none). `chain`: the
   * client's publicClient, for the flush's chain check of sent-but-unconfirmed entries (`checkQueuedTx`).
   */
  constructor(
    private readonly apiDomain: () => string, options: SyncOptions | null = {}, private readonly auth: () => SyncAuth = () => ({}),
    private readonly chain: () => QueueChain | null | undefined = () => null,
  ) {
    this.options = resolveSyncOptions(options);
  }

  /**
   * Delivers one sync with retries; on a failure worth retrying later, logs and queues it (with `meta`: the tx's
   * sender and target when known, see `QueuedTxMeta`). Never throws.
   */
  async sync(txHash: string, meta: QueuedTxMeta | null = {}): Promise<SyncResult> {
    const { queue, ...r } = await postSync(this.apiDomain(), txHash, this.options);
    if (r.ok || !queue) return { ...r, queued: false };
    const entry: PendingSync = { hash: txHash, attempts: r.attempts, lastError: r.lastError, code: r.code, at: new Date().toISOString() };
    const where = await this.enqueue(withMeta(entry, meta));
    console.warn(
      `[basis-sdk] sync of confirmed tx ${txHash} failed after ${r.attempts} attempt(s): ${r.lastError}. ` +
      `Queued in client.pendingSyncs${where}; call client.flushPendingSyncs() to retry.`,
    );
    return { ...r, queued: true };
  }

  /**
   * Delivers the `POST /api/agents` of a registration made by tx `txHash`, with retries; on a failure worth retrying
   * later (no credentials included), logs and queues it as a `kind: 'agent'` entry. Never throws.
   */
  async syncAgent(txHash: string, agent: AgentSyncPayload): Promise<SyncResult> {
    const { queue, ...r } = await postAgentSync(this.apiDomain(), agent, this.auth(), this.options);
    if (!r.ok && r.code === 'wallet_not_linked') {
      const s = await this.syncAgentSigned(txHash, { wallet: agent.wallet, agentId: agent.agentId });
      return { ...s, attempts: r.attempts + s.attempts };
    }
    if (r.ok || !queue) return { ...r, queued: false };
    const where = await this.enqueue({ kind: 'agent', hash: txHash, agent: { ...agent }, attempts: r.attempts, lastError: r.lastError, code: r.code, at: new Date().toISOString() });
    console.warn(
      `[basis-sdk] agent registration of ${agent.wallet} (agentId ${agent.agentId}, tx ${txHash}) failed after ${r.attempts} attempt(s): ` +
      `${r.lastError}. Queued in client.pendingSyncs${where}; call client.flushPendingSyncs() to retry.`,
    );
    return { ...r, queued: true };
  }

  /**
   * Delivers the signed first sync of `agent.wallet`'s agent `agent.agentId` (registered by tx `txHash`), signed afresh
   * for every attempt; on a failure worth retrying later, logs and queues it as a `kind: 'agentSigned'` entry (the
   * wallet and agentId only: a flush signs it again). Never throws.
   */
  async syncAgentSigned(txHash: string, agent: Pick<AgentSyncPayload, 'wallet' | 'agentId'>): Promise<SyncResult> {
    const { queue, ...r } = await postAgentSignedSync(this.apiDomain(), agent, this.auth(), this.options);
    if (r.ok || !queue) return { ...r, queued: false };
    const where = await this.enqueue({
      kind: 'agentSigned', hash: txHash, agent: { wallet: agent.wallet, agentId: agent.agentId }, attempts: r.attempts,
      lastError: r.lastError, code: r.code, at: new Date().toISOString(),
    });
    console.warn(
      `[basis-sdk] signed agent sync of ${agent.wallet} (agentId ${agent.agentId}, tx ${txHash}) failed after ${r.attempts} attempt(s): ` +
      `${r.lastError}. Queued in client.pendingSyncs${where} (a flush signs it again); ` +
      'call client.flushPendingSyncs() to retry.',
    );
    return { ...r, queued: true };
  }

  /**
   * Queues the signed first sync of `agent` (tx `txHash`) as a `kind: 'agentSigned'` entry without posting it (e.g. an
   * agent.update whose receipt could not be read). `flush()` signs and delivers it after the tx entry. Never throws.
   */
  async queueAgentSigned(txHash: string, agent: Pick<AgentSyncPayload, 'wallet' | 'agentId'>, lastError: string, code = 'not_confirmed'): Promise<SyncResult> {
    try {
      const where = await this.enqueue({ kind: 'agentSigned', hash: txHash, agent: { wallet: agent.wallet, agentId: agent.agentId }, attempts: 0, lastError, code, at: new Date().toISOString() });
      console.warn(
        `[basis-sdk] signed agent sync of ${agent.wallet} (agentId ${agent.agentId}, tx ${txHash}) queued without posting (${code}: ${lastError}). ` +
        `Kept in client.pendingSyncs${where}; call client.flushPendingSyncs() once it is mined.`,
      );
    } catch (e) {
      console.warn(`[basis-sdk] could not queue the signed agent sync of ${txHash}: ${(e as Error)?.message ?? e}`);
    }
    return { ok: false, status: null, code, httpStatus: 0, attempts: 0, queued: true, lastError };
  }

  /**
   * Queues the tx sync of `txHash` without posting it (e.g. a sent tx whose receipt could not be read: the API would
   * answer 422 pending). `flush()` delivers it later. `meta`: the sent tx's sender, target, nonce and block before
   * sending when known (the flush's chain check uses them). Never throws.
   */
  async queueTx(txHash: string, lastError: string, code = 'not_confirmed', meta: QueuedTxMeta | null = {}): Promise<SyncResult> {
    try {
      const entry: PendingSync = { hash: txHash, attempts: 0, lastError, code, at: new Date().toISOString() };
      const where = await this.enqueue(withMeta(entry, meta));
      console.warn(
        `[basis-sdk] sync of tx ${txHash} queued without posting (${code}: ${lastError}). ` +
        `Kept in client.pendingSyncs${where}; call client.flushPendingSyncs() once it is mined.`,
      );
    } catch (e) {
      console.warn(`[basis-sdk] could not queue the sync of ${txHash}: ${(e as Error)?.message ?? e}`);
    }
    return { ok: false, status: null, code, httpStatus: 0, attempts: 0, queued: true, lastError };
  }

  /**
   * Queues the `POST /api/agents` of `agent` (tx `txHash`) as a `kind: 'agent'` entry without posting it (e.g. an
   * agent.update whose receipt could not be read). `flush()` delivers it after the tx entry. Never throws.
   */
  async queueAgent(txHash: string, agent: AgentSyncPayload, lastError: string, code = 'not_confirmed'): Promise<SyncResult> {
    try {
      const where = await this.enqueue({ kind: 'agent', hash: txHash, agent: { ...agent }, attempts: 0, lastError, code, at: new Date().toISOString() });
      console.warn(
        `[basis-sdk] agent registration of ${agent.wallet} (agentId ${agent.agentId}, tx ${txHash}) queued without posting (${code}: ${lastError}). ` +
        `Kept in client.pendingSyncs${where}; call client.flushPendingSyncs() once it is mined.`,
      );
    } catch (e) {
      console.warn(`[basis-sdk] could not queue the agent registration of ${txHash}: ${(e as Error)?.message ?? e}`);
    }
    return { ok: false, status: null, code, httpStatus: 0, attempts: 0, queued: true, lastError };
  }

  /**
   * Keeps `entry` (replacing one of the same kind and hash) and appends it to `queueFile`, tagged with the API it
   * belongs to (`apiDomain`). Resolves where it is kept, for the logs after `client.pendingSyncs`: `''`,
   * `' and <file>'`, or `' only (<file> could not be written)'` when the append failed.
   */
  private async enqueue(entry: PendingSync): Promise<string> {
    if (entry.apiDomain === undefined) entry.apiDomain = this.apiDomain().replace(/\/+$/, '');
    if (entry.agent && typeof entry.agent.agentId === 'bigint') entry.agent = { ...entry.agent, agentId: Number(entry.agent.agentId) };
    const i = this.pending.findIndex((e) => entryKey(e) === entryKey(entry));
    if (entry.queuedAt === undefined) entry.queuedAt = (i >= 0 ? this.pending[i].queuedAt : undefined) || entry.at || new Date().toISOString();
    if (i >= 0) this.pending.splice(i, 1);
    this.pending.push(entry);
    const file = this.options.queueFile;
    if (!file) return '';
    return (await appendQueueFile(file, entry)) ? ` and ${file}` : ` only (${file} could not be written)`;
  }

  /**
   * Retries every queued entry (memory + `queueFile`); keeps what still fails. The file is updated under its lock:
   * only the entries this flush delivered (or that were rejected for good) leave it; entries appended meanwhile stay.
   */
  async flush(options: SyncOptions | null = {}): Promise<FlushResult> {
    resolveSyncOptions(options);
    const opts = resolveSyncOptions({ ...this.options, ...stripAbsent(options) });
    const file = this.options.queueFile;
    const taken = this.pending.splice(0, this.pending.length);
    let snap: { entries: PendingSync[]; lines: Set<string> } = { entries: [], lines: new Set() };
    if (file) {
      try {
        snap = await snapshotQueueFile(file);
      } catch (e) {
        console.warn(`[basis-sdk] could not read sync queue ${file}: ${(e as Error)?.message}`);
      }
    }
    let r: Awaited<ReturnType<typeof retryEntries>>;
    try {
      r = await retryEntries(this.apiDomain(), dedupe([...taken, ...snap.entries]), opts, this.auth(), this.chain());
    } catch (e) {
      this.pending.splice(0, this.pending.length, ...dedupe([...taken, ...this.pending]));
      throw e;
    }
    const fromMemory = new Set(taken.map(entryKey));
    const skipped = r.skipped.filter((e) => fromMemory.has(entryKey(e)));
    this.pending.splice(0, this.pending.length, ...dedupe([...skipped, ...r.keep, ...this.pending]));
    if (file) {
      try {
        await commitQueueFile(file, snap.lines, r.outcomes);
      } catch (e) {
        console.warn(`[basis-sdk] could not rewrite sync queue ${file}: ${(e as Error)?.message}`);
      }
    }
    return { synced: r.synced, failed: r.keep.length + r.dropped };
  }
}
