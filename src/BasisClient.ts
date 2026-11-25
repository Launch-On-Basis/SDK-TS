import { createPublicClient, createWalletClient, getAddress, http, PublicClient, WalletClient, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BasisAPI } from './api';
import { BasisApiError } from './api/core';
import {
  checkTimeoutMs, type CookieMode, credentialsFor, DEFAULT_API_AI_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS,
  DEFAULT_API_UPLOAD_TIMEOUT_MS, detectCookieMode, hasSessionCookie, sessionAuthError, type SessionUpdate,
} from './api/core';
import type { LogoutResult, SessionStatus, SessionSummary, VerifyResult } from './api/auth';
import { AddressBook, isZeroAddress, mergeAddressBook } from './config/addresses';
import { ChainConfig, ChainKey, chainAddressBook, resolveChain } from './config/chains';
import { BasisError, ValidationError, WalletRequiredError } from './core/errors';
import { errorText } from './core/redact';
import { ANY_KEYS, didYouMean, optionKeys, optsOf } from './core/opts';
import { DEFAULT_SLIPPAGE_BPS, SlippageKind, toBool, validateSlippageBps } from './core/units';
import { MainsModule } from './core/mains';
import {
  AgentSyncPayload, checkApiDomain, FlushResult, PendingSync, readSyncQueueFile, SyncAuth, SyncEngine, SyncOptions, SyncResult,
} from './core/sync';
import type { QueueChain, QueuedTxMeta } from './core/sync';
import { contractsFlagMismatch } from './core/contractsJson';
import { type Claimables, type GetClaimablesOptions, getClaimables } from './core/claimables';
import { AgentIdentityModule, AgentConfig, AgentOnboardingError, type AgentRegisterResult } from './modules/AgentIdentity';
import { FactoryModule } from './modules/Factory';
import { TradingModule } from './modules/Trading';
import { HopExecutorModule } from './modules/HopExecutor';
import { TaxesModule } from './modules/Taxes';
import { ReferralsModule } from './modules/Referrals';
import { PaperModule } from './modules/Paper';
import { MarketReaderModule } from './modules/MarketReader';
import { OrderBookModule } from './modules/OrderBook';
import { MarketResolverModule } from './modules/MarketResolver';
import { PredictionMarketsModule } from './modules/PredictionMarkets';
import { PrivateMarketsModule } from './modules/PrivateMarkets';
import { UpDownModule } from './modules/UpDown';
import { LoansModule } from './modules/Loans';
import { LiquidationModule } from './modules/Liquidation';
import { VaultModule } from './modules/Vault';
import { VestingModule } from './modules/Vesting';
import { LeverageSimulatorModule } from './modules/LeverageSimulator';
import { MainLensModule } from './modules/MainLens';

/**
 * Options of `new BasisClient()` / `BasisClient.create()`. An unknown key throws ValidationError('options'); a known one
 * set to null counts as left out (its default), as None in PY. `auth`, `rotateApiKey`, `contractsCheck` and `agent` are
 * `create()` only: `new BasisClient()` makes no request, so it refuses them when they ask for create() work (`auth` or
 * `rotateApiKey` true, `contractsCheck` 'warn' or 'strict', an agent: ValidationError('options')) and lets their no-op
 * values pass (false, 'off'). PY's constructor has none of these keywords.
 */
export interface BasisClientOptions {
  /**
   * Network preset ('robinhoodPaper' default, 'robinhood') or a custom chain config; any other value (an
   * unknown name, '') throws ValidationError('chain').
   */
  chain?: ChainKey | ChainConfig;
  /**
   * RPC URL; defaults to the chain preset's public one, which is fine to try the SDK. Pass your own for production:
   * Robinhood Chain's public RPC rate-limits after a few dozen calls, has no SLA, and its load-balanced nodes can answer
   * a block or two behind. A custom chain config without `rpcUrl` needs it here; with neither, or a value that is not a
   * string: ValidationError('rpcUrl') (never a fallback to some local node).
   */
  rpcUrl?: string;
  /**
   * Deadline of one RPC request try, ms (default 30000, at most 2147483647; same default in PY), in all: viem's http
   * transport must get the answer (its status and headers) within it, from connecting to the node's work (the body
   * read after that is not timed; PY's deadline is per read instead: requests' connect and read timeouts). A request
   * that fails in a way worth retrying (viem's list, PY's too: no answer in time, a network error, HTTP 403 / 408 / 413 /
   * 429 / 500 / 502 / 503 / 504, a body that is not JSON, JSON-RPC error -1 / -32005 / -32603; never 400 / 401 / 404
   * or another JSON-RPC error such as a revert) is tried again up to 3 times, 150 ms, 300 ms and 600 ms apart
   * (`RPC_RETRY_COUNT`, the same count and waits in PY), each try with its own deadline, so an RPC that never answers
   * fails after about 4 x this deadline. An HTTP error answer with a Retry-After header sets the wait before the next
   * try instead (viem's rule: its whole seconds, as given; PY honours it too, seconds or an HTTP date, at most 5 s). A
   * broadcast is never tried again. Applies to the `rpcUrl` transport (reads and, with `privateKey`, sends); an
   * injected `walletClient` keeps its own transport. Anything else: ValidationError('rpcTimeoutMs').
   */
  rpcTimeoutMs?: number;
  privateKey?: `0x${string}`;
  /**
   * Injected signer for environments where no raw private key exists:
   * embedded wallets (Privy, Web3Auth, Magic), browser wallets, MPC custody.
   * Build it with an account set and this client's chain, e.g.:
   *   createWalletClient({ account: address, chain: robinhood, transport: custom(eip1193Provider) })
   * Without an account, or with a `chain` other than the client's: ValidationError('walletClient'). Each write also
   * checks the wallet's current network and throws viem's ChainMismatchError before signing when it differs.
   * Mutually exclusive with `privateKey` (privateKey wins if both are set).
   */
  walletClient?: WalletClient;
  apiKey?: string;
  /**
   * The API to sign in to and sync with; defaults to the chain preset's (`robinhood` https://launchonbasis.com,
   * `robinhoodPaper` https://paper.launchonbasis.com). There is no global default: a paper client never reaches the real
   * API unless this option says so, and a custom chain config without `apiDomain` needs it here
   * (`ValidationError('apiDomain')` otherwise). It must be the API's origin: an absolute https URL with no path, query
   * or fragment (plain http only for localhost and 127.0.0.1, so the API key and the session never go out in clear
   * text); a trailing slash is dropped. Anything else throws `ValidationError('apiDomain')`.
   */
  apiDomain?: string;
  /**
   * How the SIWE session cookie travels (default: detected, `browser` in a web page or web worker, else `explicit`).
   * `explicit` (Node): the SDK reads the session from `Set-Cookie` and sends it as a `Cookie` header
   * (`client.sessionCookie`). `browser`: the browser keeps the HttpOnly cookie; requests that need the session are sent
   * with `credentials: 'include'`, and the SDK learns the session state from the verify answer and `GET /api/auth/me`
   * (`client.hasSession`, `client.refreshSession()`); `client.sessionCookie` stays null. Anything else throws
   * ValidationError('cookieMode').
   */
  cookieMode?: CookieMode;
  /**
   * Address overrides over the chain preset (e.g. a local node's addresses): a plain `{ ... }` (a Map or a class
   * instance: ValidationError('addresses')). `mains` replaces the list as a whole. A custom chain config's own
   * `addresses` are checked the same way first (an unknown key, a bad checksum or a non-plain object there:
   * ValidationError('chain')), over an empty book: a key it leaves out is zero (not deployed).
   */
  addresses?: Partial<AddressBook>;
  /**
   * Default slippage in bps for automatic minimums: `trade` (swaps, market buys, redeem) and `updown` (bets), in a
   * plain `{ ... }`. Each a whole number from 0 to 9999, or null / undefined for its default; no other key
   * (`ValidationError('slippageBps')` otherwise, a Map or a class instance too).
   */
  slippageBps?: Partial<Record<SlippageKind, number | null>>;
  /**
   * How long a write waits for its receipt after sending (default 180000 ms, at most 2147483647). When the wait fails
   * the write throws `TxNotConfirmedError` (with `txHash`; do not resend) and queues the hash's sync.
   */
  receiptTimeoutMs?: number;
  /**
   * In `create()`: SIWE login + API key provisioning when a signer is given (default true).
   * Set false to run contract-only, without the API: `create()` then makes no API writes, so the `agent` option is
   * skipped (with a warning); the agent methods (`client.agent.registerAndSync()` and the others) still work when called
   * directly. In browser cookie mode a session this browser already holds for the signer (`GET /api/auth/me`) is reused
   * instead of asking for a new signature. true or false only (ValidationError('auth') otherwise).
   */
  auth?: boolean;
  /**
   * In `create()` without `apiKey`: when the wallet already has an API key (the server never shows it again), delete it
   * and create a new one, like a first key (default false: `create()` then throws and asks for the key).
   * Opt-in: anything still using the old key stops working. true or false only (ValidationError('rotateApiKey')).
   */
  rotateApiKey?: boolean;
  /**
   * Called once with the full key when `ensureApiKey` (or `create()`) creates an API key, to store it (the server never
   * shows it again). The SDK itself only logs a masked hint (`bsk_****abcd`); the key is also on `client.apiKey`.
   * Awaited; an error it throws is logged (masked) and does not fail the call.
   */
  onApiKeyCreated?: (key: string) => void | Promise<void>;
  /**
   * Deadline of an ordinary API request, ms, from sending to the last body byte (default 30000). Past it the request
   * throws BasisApiError code `timeout` (status 0); nothing is retried. Per call: `client.api.withOptions({ timeoutMs })`.
   * Every API timeout option (and receiptTimeoutMs) takes 1 to 2147483647 ms (ValidationError otherwise).
   */
  apiTimeoutMs?: number;
  /** Deadline of an upload (image, metadata, project image) and of an image download, ms (default 120000). */
  apiUploadTimeoutMs?: number;
  /** Deadline of the AI routes (approveMarket, draftMarket*), ms (default 330000: the review can take minutes). */
  apiAiTimeoutMs?: number;
  /**
   * In `create()`: compare the client with `${apiDomain}/contracts.json` (`checkContracts`): the chain id, and the
   * deployment (`network`: the real site and the paper site share chain 4663), plus the addresses when the file
   * publishes them (the sites publish none today: a warning says so). 'off' (default) skips it, 'warn' logs mismatches,
   * 'strict' throws on them, and also when the check could not be made (the file unreachable, a non-2xx answer such as
   * 429 or 5xx, not a JSON object, no numeric chainId or no network / paper field) or the file says BASIS is not live
   * there (`live: false`); anything else throws
   * ValidationError('contractsCheck').
   */
  contractsCheck?: 'off' | 'warn' | 'strict';
  /**
   * Post-tx backend sync: retries with exponential backoff (default 6 attempts: 1s, 2s, 4s, 8s, 16s; a 429 waits until
   * the rate-limit reset, at most `maxDelayMs` = 60s), then queues in `pendingSyncs` (and `queueFile`, Node only).
   * A write returns once its sync is done or queued.
   */
  sync?: SyncOptions;
  /**
   * ERC-8004 Agent Identity: register the signer as a BASIS agent (or find the one it has) in `create()`; `true` or an
   * `AgentConfig` (`{}` counts as one), else ValidationError('agent'); the config's fields are type-checked up front
   * (`agent.register`), and so are the API's limits (`agentNameTooLong` above 100 characters, `agentDescriptionTooLong`
   * above 500), before any request. A registration of the signer that an earlier run sent and saw mined (its line in
   * the sync queue, the identity the signer's) is finished with its txHash (`registerAndSync(config, txHash)`), never
   * minted again. A wallet signs in only when it is linked to a BASIS account or is a registered agent, so with
   * this option a new agent wallet is registered and synced with a signed message first (which accepts the BASIS
   * Terms), then signed in. One agent, one wallet: the API never records a wallet linked to a person's BASIS account as
   * an agent, and on an API that tells such wallets apart before a tx (`/api/v1/config` `paper: true`: the paper site)
   * `create()` refuses one before anything is sent (ValidationError('wallet_in_account')). While a transaction of the
   * wallet is still pending, a new registration is refused (ValidationError('agentTxPending')): it may be an earlier
   * one. Skipped with `auth: false` (contract-only).
   */
  agent?: boolean | AgentConfig;
}

/**
 * Every top-level key of BasisClientOptions: anything else throws ValidationError('options') (a typo such as `chian`
 * would otherwise give a client on the default chain, not the one meant). The type keeps it in step with the interface.
 * PY takes the same options as keyword arguments (`BasisClient(...)` / `BasisClient.create(...)`, snake_case), minus
 * the browser-only `walletClient` and `cookieMode`; an unknown keyword is a TypeError there. A known option set to
 * null counts as left out (its default), as None does in PY.
 */
const OPTION_KEYS: Record<keyof BasisClientOptions, true> = {
  chain: true, rpcUrl: true, rpcTimeoutMs: true, privateKey: true, walletClient: true, apiKey: true, apiDomain: true,
  cookieMode: true, addresses: true, slippageBps: true, receiptTimeoutMs: true, auth: true, rotateApiKey: true, onApiKeyCreated: true,
  apiTimeoutMs: true, apiUploadTimeoutMs: true, apiAiTimeoutMs: true, contractsCheck: true, sync: true, agent: true,
};

/**
 * Options only `create()` uses (it signs in, makes the API key, checks contracts.json, registers the agent): the
 * constructor makes no request, so it refuses one that asks for that work (`auth` / `rotateApiKey` true,
 * `contractsCheck` 'warn' / 'strict', an agent) instead of ignoring it; their no-op values (false, 'off') do nothing
 * there and pass. PY's constructor has no such keywords.
 */
const CREATE_ONLY_KEYS = ['auth', 'rotateApiKey', 'contractsCheck', 'agent'] as const;

/** Options of `ensureApiKey`. */
export interface EnsureApiKeyOptions {
  /** Delete the wallet's existing key and make a new one (default false). */
  rotate?: boolean | null;
}
const ENSURE_API_KEY_KEYS = optionKeys<EnsureApiKeyOptions>({ rotate: true });

/** The `contractsCheck` modes of `create()`. */
const CONTRACTS_CHECK_MODES = ['off', 'warn', 'strict'] as const;

/**
 * A plain `{ ... }` (its prototype Object.prototype, or none): the one object kind an option object may be, as in
 * `optsOf`. A Map, a class instance (getters on its prototype) or an array is not: read as one, it would be empty and
 * its values lost without a word. PY: a dict.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What a value is, for a refusal message (same words in PY where the types match). */
function shown(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return isPlainObject(v) ? 'an object' : 'an object that is not a plain { ... }';
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * `options` checked before anything else: undefined (no options) or a plain object whose keys are all
 * BasisClientOptions keys, else ValidationError('options'). Same rule in PY: keyword arguments only. Returns a copy
 * without the options set to null (left out, as PY None).
 */
function checkOptions(options: unknown): BasisClientOptions {
  if (options === undefined) return {};
  if (!isPlainObject(options)) {
    throw new ValidationError('options',
      `BasisClient options must be a plain object, e.g. { chain: 'robinhoodPaper', privateKey }, got ${shown(options)}.`);
  }
  const unknown = Object.keys(options).filter((k) => !Object.prototype.hasOwnProperty.call(OPTION_KEYS, k));
  if (unknown.length) {
    throw new ValidationError('options',
      `Unknown BasisClient option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. `
      + `Known: ${Object.keys(OPTION_KEYS).join(', ')}.${didYouMean(unknown, Object.keys(OPTION_KEYS))}`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== null) out[k] = v;
  }
  return out as BasisClientOptions;
}

/**
 * The `slippageBps` option checked: undefined, or a plain object whose keys are `trade` / `updown` (each value is
 * checked by validateSlippageBps), else ValidationError('slippageBps'): a Map or a class instance is refused too (read
 * as an object it would be empty, and the defaults would apply without a word). A key set to undefined or null is left
 * out (its default), as None in PY and as inside the `sync` option; an unknown key is refused whatever its value. Same
 * rule in PY (a dict).
 */
function checkSlippageKeys(v: unknown): Partial<Record<SlippageKind, number>> {
  if (v === undefined) return {};
  if (!isPlainObject(v)) {
    throw new ValidationError('slippageBps', `slippageBps must be an object { trade?, updown? } of bps, got ${shown(v)}.`);
  }
  const known = Object.keys(DEFAULT_SLIPPAGE_BPS);
  const unknown = Object.keys(v).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new ValidationError('slippageBps', `Unknown slippageBps key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. Known: ${known.join(', ')}.${didYouMean(unknown, known)}`);
  }
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) as Partial<Record<SlippageKind, number>>;
}

export type {
  ClaimableSection, Claimables, ClaimablesFailure, GetClaimablesOptions, HolderRewardClaimable, LiquidationClaimable,
  SkippedMarket, SkippedToken, VaultClaimable, VestingClaimable,
} from './core/claimables';

export class BasisClient {
  public readonly chainConfig: ChainConfig;
  public readonly chainId: number;
  /** Resolved addresses: chain preset + overrides. */
  public readonly addresses: AddressBook;
  public readonly slippageBps: Record<SlippageKind, number>;
  /** How long a write waits for its receipt after sending, in ms (option `receiptTimeoutMs`, default 180000). */
  public readonly receiptTimeoutMs: number;
  /** Deadline of an ordinary API request, ms (option `apiTimeoutMs`, default 30000). */
  public readonly apiTimeoutMs: number;
  /** Deadline of an API upload or image download, ms (option `apiUploadTimeoutMs`, default 120000). */
  public readonly apiUploadTimeoutMs: number;
  /** Deadline of an AI API route (approveMarket, draftMarket*), ms (option `apiAiTimeoutMs`, default 330000). */
  public readonly apiAiTimeoutMs: number;
  /** The RPC URL in use (option, else the chain preset's). */
  public readonly rpcUrl: string;
  /** Deadline of one RPC request, ms (option `rpcTimeoutMs`, default 30000; retried up to `RPC_RETRY_COUNT` times). */
  public readonly rpcTimeoutMs: number;
  /** How the SIWE session cookie travels: `explicit` (the SDK sends `Cookie`) or `browser` (option `cookieMode`). */
  public readonly cookieMode: CookieMode;

  public publicClient: PublicClient;
  public walletClient?: WalletClient;
  public apiDomain: string;

  public api: BasisAPI;

  public mains: MainsModule;
  public factory: FactoryModule;
  public trading: TradingModule;
  public hopExecutor: HopExecutorModule;
  public taxes: TaxesModule;
  /** Referrals: who referred whom. Your earnings are read with `taxes.getReferralEarnings`. */
  public referrals: ReferralsModule;
  /** The paper site's play tokens (`claim`, tUSDG / tNVDA / tETH). Refuses on the real site. */
  public paper: PaperModule;
  public loans: LoansModule;
  public liquidation: LiquidationModule;
  public vault: VaultModule;
  public vesting: VestingModule;
  public leverageSimulator: LeverageSimulatorModule;
  /** Read-only quotes that take the main first (partial loan sells, leverage count, main/pair conversions). */
  public mainLens: MainLensModule;
  public marketReader: MarketReaderModule;
  public orderBook: OrderBookModule;
  public resolver: MarketResolverModule;
  public predictionMarkets: PredictionMarketsModule;
  public privateMarkets: PrivateMarketsModule;
  public updown: UpDownModule;
  public agent: AgentIdentityModule;
  /**
   * What `create({ agent })` did with the agent (`agent.registerAndSync`): the agentId, the tx, the first sync and what
   * the API applied to the profile (`applied`: the name as username, the image as avatar). Null when the option was
   * not used or the registration failed before an answer (see the warning it logged).
   */
  public agentRegistration: AgentRegisterResult | null = null;

  /** Backend sync engine (retries + pending queue). */
  private readonly _sync: SyncEngine;

  private _sessionCookie: string | null = null;
  /** Lower-case wallets confirmed in the SIWE session (verify answer, GET /api/auth/me, logout). */
  private _sessionWallets: string[] = [];
  private _apiKey: string | null = null;
  /**
   * The lower-case wallet the API key belongs to: the signer's when the key comes with one (or `ensureApiKey` makes or
   * loads it). A queued agent entry of another wallet never goes out with this key (PY: `_api_key_wallet`).
   */
  private _apiKeyWallet: string | null = null;
  private readonly _onApiKeyCreated?: (key: string) => void | Promise<void>;
  /**
   * The lower-case wallet whose last sign-in answered `wallet_not_linked` (cleared when that wallet signs in), null when
   * none: the flag holds for that wallet only, never for a signer switched in after it.
   */
  private _noDoorWallet: string | null = null;
  /** When (Date.now()) the last `wallet_not_linked` answer came, null when none: the browser waits it out once. */
  private _noDoorAt: number | null = null;

  /**
   * @internal True when the current signer's last sign-in answered `wallet_not_linked`: it cannot sign in yet, so its
   * agent record goes through the signed first sync whatever credentials the client holds. False for any other signer
   * (after a switch the new signer is tried on its own). PY: `_wallet_not_linked`.
   */
  get _walletNotLinked(): boolean {
    const signer = this.account?.toLowerCase();
    return signer !== undefined && this._noDoorWallet === signer;
  }

  /**
   * @internal How `create({ agent })` signs in again after an agent's first sync: the API may still answer
   * `wallet_not_linked` for a few seconds (each server process remembers a refusal up to 5 s), so it retries with a
   * doubling wait from `firstDelayMs` for `windowMs` in all. Browser cookie mode (each sign-in a wallet prompt) signs in
   * once instead: first it waits until `browserWaitMs` after the last `wallet_not_linked` answer and reads the agent's
   * record (again with the doubling wait while it does not show, within `windowMs`). PY: `_AGENT_SIGN_IN_RETRY`
   * (no browser mode there).
   */
  static _agentSignInRetry: { windowMs: number; firstDelayMs: number; browserWaitMs?: number } = {
    windowMs: 30_000, firstDelayMs: 1_000, browserWaitMs: 6_000,
  };

  /** Session cookie for authenticated API requests (explicit cookie mode; always null in browser cookie mode). */
  get sessionCookie(): string | null {
    return this._sessionCookie;
  }

  /**
   * True when the client can send a SIWE session for its current signer: it holds the session (explicit mode the
   * session cookie; browser cookie mode a session the browser holds as far as the SDK knows) and the signer's wallet
   * is one of `sessionWallets`. False without a signer, and after a signer switch until `authenticate()` (or
   * `refreshSession()` finds the new signer in the session).
   */
  get hasSession(): boolean {
    const held = this.cookieMode === 'browser' ? this._sessionWallets.length > 0 : hasSessionCookie(this._sessionCookie);
    const a = this.account?.toLowerCase();
    return held && a !== undefined && this._sessionWallets.includes(a);
  }

  /**
   * Lower-case wallets the SDK confirmed are in its SIWE session: the wallet the verify answer signed in, the
   * session's wallets from `GET /api/auth/me` (`refreshSession()`, `api.getMe`), minus wallets signed out (`logout`).
   * Session requests go out only for a signer in this list; otherwise they throw AuthRequiredError (sign in again).
   */
  get sessionWallets(): readonly string[] {
    return [...this._sessionWallets];
  }

  /** @internal ApiHost hook: what an auth answer said about the session (see SessionUpdate). */
  _noteSession(u: SessionUpdate): void {
    if (u.cookie !== undefined && this.cookieMode !== 'browser') this._sessionCookie = u.cookie;
    if (u.wallets) this._sessionWallets = [...new Set(u.wallets.map((w) => String(w).toLowerCase()))];
    if (u.remove) {
      const gone = u.remove.toLowerCase();
      this._sessionWallets = this._sessionWallets.filter((w) => w !== gone);
    }
    if (this.cookieMode !== 'browser' && !hasSessionCookie(this._sessionCookie)) this._sessionWallets = [];
  }

  /** API key for v1 data endpoints. */
  get apiKey(): string | null {
    return this._apiKey;
  }

  /**
   * The lower-case wallet `apiKey` belongs to: the signer's when the key came with one (the `apiKey` option), or the
   * signer `ensureApiKey` made it for; null when not known (a key passed without a signer, until `ensureApiKey` finds
   * its hint among a signer's keys). API requests send the key for that wallet's signer only (or without a signer), so
   * after a signer switch the old wallet's key never acts for the new one. PY: `api_key_wallet`.
   */
  get apiKeyWallet(): string | null {
    return this._apiKeyWallet;
  }

  /**
   * Sets the API key of a running client (e.g. one stored for the signer after a wallet switch), as the `apiKey` option
   * does: the current signer is recorded as the key's wallet (`apiKeyWallet`; null without a signer, then
   * `ensureApiKey` confirms it before it counts as a signer's). null, undefined or '' removes the key. Anything but a
   * string: ValidationError('apiKey'). PY: `client.api_key = key` / `client.set_api_key(key)`.
   */
  setApiKey(key: string | null | undefined): void {
    if (key != null && typeof key !== 'string') {
      throw new ValidationError('apiKey', `apiKey must be a string (bsk_...) or null, got ${shown(key)}.`);
    }
    this._apiKey = key || null;
    this._apiKeyWallet = key ? this.account?.toLowerCase() ?? null : null;
  }

  /** Prediction-market hosts: `public` (resolved through `client.resolver`) and `private` (resolved by the creator). */
  get hosts(): { public: Address; private: Address } {
    return { public: this.addresses.tranche, private: this.addresses.tranchePrivate };
  }

  /** The signer's address, or undefined in read-only mode. */
  get account(): Address | undefined {
    return this.walletClient?.account?.address;
  }

  constructor(options: BasisClientOptions = {}) {
    options = checkOptions(options);
    const asksForCreate = (k: (typeof CREATE_ONLY_KEYS)[number]): boolean => {
      const v = options[k] as unknown;
      if (v === undefined || v === false) return false;
      if (k === 'contractsCheck') return v !== 'off';
      return true;
    };
    const createOnly = CREATE_ONLY_KEYS.filter(asksForCreate);
    if (createOnly.length) {
      const names = createOnly.map((k) => `"${k}"`).join(', ');
      throw new ValidationError('options',
        `${createOnly.length > 1 ? 'Options' : 'Option'} ${names} ${createOnly.length > 1 ? 'are' : 'is'} create() only: new BasisClient() makes no `
        + 'request (no sign-in, no API key, no contracts.json check, no agent registration). Use BasisClient.create({ ... }) for '
        + `${createOnly.length > 1 ? 'them' : 'it'}, or leave ${createOnly.length > 1 ? 'them' : 'it'} out.`);
    }
    this.chainConfig = resolveChain(options.chain);
    this.chainId = this.chainConfig.chain.id;
    this.addresses = mergeAddressBook(chainAddressBook(this.chainConfig), options.addresses);
    this.slippageBps = { ...DEFAULT_SLIPPAGE_BPS, ...checkSlippageKeys(options.slippageBps) };
    for (const [k, v] of Object.entries(this.slippageBps)) validateSlippageBps(v, `slippageBps.${k}`);
    this.receiptTimeoutMs = checkTimeoutMs(options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS, 'receiptTimeoutMs');
    this.rpcTimeoutMs = checkTimeoutMs(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, 'rpcTimeoutMs');
    this.apiTimeoutMs = checkTimeoutMs(options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS, 'apiTimeoutMs');
    this.apiUploadTimeoutMs = checkTimeoutMs(options.apiUploadTimeoutMs ?? DEFAULT_API_UPLOAD_TIMEOUT_MS, 'apiUploadTimeoutMs');
    this.apiAiTimeoutMs = checkTimeoutMs(options.apiAiTimeoutMs ?? DEFAULT_API_AI_TIMEOUT_MS, 'apiAiTimeoutMs');
    if (options.onApiKeyCreated !== undefined && typeof options.onApiKeyCreated !== 'function') {
      throw new ValidationError('onApiKeyCreated', 'onApiKeyCreated must be a function.');
    }
    this._onApiKeyCreated = options.onApiKeyCreated;
    if (options.cookieMode !== undefined && options.cookieMode !== 'browser' && options.cookieMode !== 'explicit') {
      throw new ValidationError('cookieMode', `cookieMode must be 'browser' or 'explicit', got ${String(options.cookieMode)}.`);
    }
    this.cookieMode = options.cookieMode ?? detectCookieMode();
    const rpcUrl: unknown = options.rpcUrl || this.chainConfig.rpcUrl;
    if (typeof rpcUrl !== 'string' || !rpcUrl) {
      throw new ValidationError('rpcUrl', rpcUrl
        ? `rpcUrl must be the RPC's URL (a string), got ${shown(rpcUrl)}.`
        : `Chain "${this.chainConfig.key}" names no RPC: pass the rpcUrl option (or rpcUrl in the chain config).`);
    }
    this.rpcUrl = rpcUrl;
    const chain = this.chainConfig.chain;
    const apiDomain = options.apiDomain || this.chainConfig.apiDomain;
    if (!apiDomain) {
      throw new ValidationError('apiDomain', `Chain "${this.chainConfig.key}" names no API: pass the apiDomain option (or apiDomain in the chain config).`);
    }
    this.apiDomain = checkApiDomain(apiDomain);
    this._sync = new SyncEngine(() => this.apiDomain, options.sync, () => this.syncAuth(),
      () => this.publicClient as unknown as QueueChain);

    const transport = () => http(rpcUrl, { timeout: this.rpcTimeoutMs, retryCount: RPC_RETRY_COUNT, retryDelay: RPC_RETRY_DELAY_MS });
    this.publicClient = createPublicClient({ chain, transport: transport() }) as PublicClient;

    if (options.privateKey) {
      this.walletClient = createWalletClient({ account: privateKeyToAccount(options.privateKey), chain, transport: transport() });
    } else if (options.walletClient) {
      if (!options.walletClient.account) {
        throw new ValidationError('walletClient',
          'Injected walletClient must have an account set. ' +
          'Build it with createWalletClient({ account, chain, transport: custom(provider) }).'
        );
      }
      const walletChainId = options.walletClient.chain?.id;
      if (walletChainId !== undefined && walletChainId !== this.chainId) {
        throw new ValidationError('walletClient',
          `The walletClient is on chain ${walletChainId}, but this client is on chain ${this.chainId} ` +
          `(${this.chainConfig.key}). Build the walletClient with this client's chain (client.chainConfig.chain).`
        );
      }
      this.walletClient = options.walletClient;
    }

    if (options.apiKey) {
      this._apiKey = options.apiKey;
      this._apiKeyWallet = this.account?.toLowerCase() ?? null;
    }

    this.api = new BasisAPI(this);
    this.mains = new MainsModule(this);
    this.factory = new FactoryModule(this);
    this.trading = new TradingModule(this);
    this.hopExecutor = new HopExecutorModule(this);
    this.taxes = new TaxesModule(this);
    this.referrals = new ReferralsModule(this);
    this.paper = new PaperModule(this);
    this.loans = new LoansModule(this);
    this.liquidation = new LiquidationModule(this);
    this.vault = new VaultModule(this);
    this.vesting = new VestingModule(this);
    this.leverageSimulator = new LeverageSimulatorModule(this);
    this.mainLens = new MainLensModule(this);
    this.marketReader = new MarketReaderModule(this);
    this.orderBook = new OrderBookModule(this);
    this.resolver = new MarketResolverModule(this);
    this.predictionMarkets = new PredictionMarketsModule(this);
    this.privateMarkets = new PrivateMarketsModule(this);
    this.updown = new UpDownModule(this);
    this.agent = new AgentIdentityModule(this);
  }

  /**
   * Async factory method that creates a fully initialized BasisClient.
   *
   * - Checks that the RPC serves the configured chain.
   * - If a signer is provided and `auth !== false`: SIWE login, then provisions an API key (unless one is given;
   *   `rotateApiKey: true` replaces a key the wallet already has). Browser cookie mode: a session the browser already
   *   holds for the signer is reused (`refreshSession()`), so a page reload asks for no new signature.
   * - The API signs in only a wallet linked to a BASIS account (on the website: X, Google or email, then Account >
   *   Wallets) or a registered agent; any other wallet gets BasisApiError code `wallet_not_linked` (without the `agent`
   *   option its message adds the SDK's ways in: `agent: true` for an agent's wallet, `auth: false` to run without the
   *   API). With the `agent` option such a wallet registers on ERC-8004 and sends the signed first sync
   *   (`agent.registerAndSync`), then signs in (retried for about 30 s while the API still answers `wallet_not_linked`;
   *   browser cookie mode signs in once, after waiting that answer out). When that first sync fails after the mint,
   *   `create()` throws AgentOnboardingError with the agentId, the tx hash and what to do next; running `create()`
   *   again never mints a second identity, and finishes a registration an earlier run saw mined (its sync-queue line).
   * - With the `agent` option and a wallet that signs in through a person's BASIS account (the paper site lets no other
   *   wallet in that is not an agent yet): ValidationError('wallet_in_account') before the API key or any tx, since an
   *   agent needs a wallet of its own.
   * - With `auth: false` the `agent` option is skipped (contract-only, no API writes; a warning says so).
   * - Optionally compares the client with the dapp's `/contracts.json` (`contractsCheck`), right after the RPC check:
   *   before the sign-in, the API key and any agent tx.
   * - The options are checked before any request: ValidationError `options` (not a plain object, an unknown key),
   *   `auth` / `rotateApiKey` (true or false only), `contractsCheck` ('off', 'warn' or 'strict'), `agent` and the agent
   *   config's fields, plus the constructor's checks. An option set to null counts as left out (its default), as None
   *   in PY. These four options are create() only: the constructor refuses them when they ask for create() work (auth or
   *   rotateApiKey true, contractsCheck warn or strict, an agent), and lets their no-op values pass.
   */
  static async create(options: BasisClientOptions = {}): Promise<BasisClient> {
    const opts = checkOptions(options);
    const clientOptions: BasisClientOptions = { ...opts };
    for (const k of CREATE_ONLY_KEYS) delete clientOptions[k];
    const client = new BasisClient(clientOptions);
    const agent = opts.agent;
    if (agent !== undefined && typeof agent !== 'boolean' && (agent === null || typeof agent !== 'object' || Array.isArray(agent))) {
      throw new ValidationError('agent', `agent must be true, false or an agent config object, got ${agent === null ? 'null' : typeof agent}.`);
    }
    const auth = toBool(opts.auth, 'auth', true);
    const rotateApiKey = toBool(opts.rotateApiKey, 'rotateApiKey', false);
    const contractsCheck = opts.contractsCheck === undefined ? 'off' : opts.contractsCheck;
    if (!(CONTRACTS_CHECK_MODES as readonly unknown[]).includes(contractsCheck)) {
      throw new ValidationError('contractsCheck', `contractsCheck must be 'off', 'warn' or 'strict', got ${shown(contractsCheck)}.`);
    }
    const wantsAgent = agent === true || typeof agent === 'object';
    const agentConfig = typeof agent === 'object' ? agent : undefined;
    if (agentConfig) client.agent._checkConfig(agentConfig);
    const signer = !!client.walletClient;

    await client.validateRpc();
    if (contractsCheck !== 'off') {
      await client.checkContracts(contractsCheck);
    }

    if (wantsAgent && signer && !auth) {
      console.warn(
        '[basis-sdk] create(): the agent option is skipped with auth: false (contract-only: no API writes). Call '
        + 'client.agent.registerAndSync(config) yourself to register and sync the agent.',
      );
    }

    let agentDone = false;
    if (signer && auth) {
      const resumed = client.cookieMode === 'browser' && await client.refreshSession().catch(() => false);
      if (!resumed) {
        try {
          await client.authenticate();
        } catch (e) {
          const noDoor = e instanceof BasisApiError && e.code === 'wallet_not_linked';
          if (noDoor && !wantsAgent) throw noDoorHint(e as BasisApiError);
          if (!noDoor) throw e;
          await client.onboardAgent(agentConfig);
          agentDone = true;
        }
      }
      if (wantsAgent && !agentDone) {
        try {
          await client.agent._refuseIfPersonWallet('create({ agent })');
        } catch (e) {
          if (e instanceof ValidationError) throw e;
        }
      }
      if (!opts.apiKey) {
        await client.ensureApiKey({ rotate: rotateApiKey });
      }
    }

    if (wantsAgent && signer && !agentDone && auth) {
      client.agent._finishQueued = true;
      try {
        client.agentRegistration = await client.agent.registerAndSync(agentConfig);
      } catch (err) {
        console.warn('Agent registration warning:', errorText(err));
      } finally {
        client.agent._finishQueued = false;
      }
    }

    return client;
  }

  /**
   * `create({ agent })` for a wallet the API does not let in yet (`wallet_not_linked`): finishes a first sync an earlier
   * run queued (`queueFile`), registers the agent (or finds it) with the signed first sync, then signs in. A failed
   * first sync after the mint throws AgentOnboardingError with the agentId, the tx hash and the next step.
   */
  private async onboardAgent(config?: AgentConfig): Promise<void> {
    let earlier: PendingSync[] = [];
    if (this.pendingSyncs.length || this._sync.options.queueFile) {
      earlier = await this._queuedTxEntries();
      await this.flushPendingSyncs().catch(() => undefined);
    }
    this.agent._earlierEntries = earlier;
    this.agent._finishQueued = true;
    const r = await this.agent.registerAndSync(config).finally(() => {
      this.agent._earlierEntries = [];
      this.agent._finishQueued = false;
    });
    this.agentRegistration = r;
    const reg = r.registration;
    if (reg && !reg.ok) {
      const id = r.agentId === null ? null : `${r.agentId}n`;
      const file = this._sync.options.queueFile;
      const fromClient = 'from a client made with auth: false';
      const next = r.agentId === null
        ? `Read its agentId with agent.getAgentIdFromTx('${r.hash}'), then call agent.syncSigned(agentId) ${fromClient} and create() again.`
        : reg.queued && file
          ? `It is queued in client.pendingSyncs and ${file}: run create() again (it finishes the queued sync with this signer), or call agent.syncSigned(${id}) first.`
          : reg.queued
            ? `It was queued in memory only (no sync.queueFile), and create() returns no client: call agent.syncSigned(${id}) ${fromClient}, then create() again.`
            : `Fix that, then call agent.syncSigned(${id}) ${fromClient} and create() again.`;
      throw new AgentOnboardingError(
        `[basis-sdk] Registered agent ${r.agentId ?? '(id unknown)'} on ERC-8004 (tx ${r.hash}), but BASIS did not take its first sync: `
        + `${reg.lastError} ${next} Do not call register() again: it would mint a second identity.`,
        r.agentId, r.hash, reg,
      );
    }
    await this.signInAfterAgentSync(r.agentId, r.hash);
    await this.flushPendingSyncs().catch(() => undefined);
  }

  /**
   * Signs in right after an agent's first sync. The API may still answer `wallet_not_linked` for a few seconds (each
   * server process remembers a refusal briefly), so that answer is retried with a doubling wait for about 30 s
   * (`BasisClient._agentSignInRetry`); then, or on any other failure, AgentOnboardingError says the agent is synced and
   * `create()` can run again. Browser cookie mode (each sign-in is a wallet prompt) signs in once, after waiting the
   * refusal out (`signInOnceAfterAgentSync`).
   */
  private async signInAfterAgentSync(agentId: bigint | null, hash: Hex | null): Promise<void> {
    if (this.cookieMode === 'browser') return this.signInOnceAfterAgentSync(agentId, hash);
    const { windowMs, firstDelayMs } = BasisClient._agentSignInRetry;
    const start = Date.now();
    let delay = firstDelayMs;
    for (;;) {
      try {
        await this.authenticate();
        return;
      } catch (e) {
        const left = windowMs - (Date.now() - start);
        const noDoor = e instanceof BasisApiError && e.code === 'wallet_not_linked';
        if (!noDoor || left <= 0) {
          const msg = errorText(e);
          throw new AgentOnboardingError(
            `[basis-sdk] Agent ${agentId ?? '(id unknown)'} is registered on ERC-8004 and synced with BASIS, but the sign-in `
            + `${noDoor ? 'still answers wallet_not_linked' : 'failed'} (${msg}). Run create() again in a minute: it signs in and does not register again.`,
            agentId, hash, null,
          );
        }
        await new Promise((ok) => setTimeout(ok, Math.min(delay, left)));
        delay *= 2;
      }
    }
  }

  /**
   * Browser cookie mode's sign-in after an agent's first sync: one wallet prompt, never one per retry. The API keeps a
   * `wallet_not_linked` answer up to 5 s per server process, so it waits until `browserWaitMs` (6 s) after the last
   * such answer this client got, reads the agent's record (`GET /api/agents/{wallet}`; while it does not show, again
   * with the doubling wait within `windowMs`; a failed read does not stop it), then signs in once. A failed sign-in:
   * AgentOnboardingError, as in the Node path (create() again signs in and does not register again).
   */
  private async signInOnceAfterAgentSync(agentId: bigint | null, hash: Hex | null): Promise<void> {
    const { windowMs, firstDelayMs, browserWaitMs = 0 } = BasisClient._agentSignInRetry;
    const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    const start = Date.now();
    const since = this._noDoorAt === null ? Infinity : start - this._noDoorAt;
    if (since < browserWaitMs) await sleep(browserWaitMs - since);
    const wallet = this.account;
    let delay = firstDelayMs;
    while (wallet) {
      let listed = false;
      try {
        listed = (await this.api.getAgent(wallet))?.isAgent === true;
      } catch {
        break;
      }
      const left = windowMs - (Date.now() - start);
      if (listed || left <= 0) break;
      await sleep(Math.min(delay, left));
      delay *= 2;
    }
    try {
      await this.authenticate();
    } catch (e) {
      const noDoor = e instanceof BasisApiError && e.code === 'wallet_not_linked';
      throw new AgentOnboardingError(
        `[basis-sdk] Agent ${agentId ?? '(id unknown)'} is registered on ERC-8004 and synced with BASIS, but the sign-in `
        + `${noDoor ? 'still answers wallet_not_linked' : 'failed'} (${errorText(e)}). Run create() again in a minute: it signs in and does not register again.`,
        agentId, hash, null,
      );
    }
  }

  /** Throws when the RPC is unreachable or serves another chain than the configured one. */
  async validateRpc(): Promise<void> {
    let rpcChainId: number;
    try {
      rpcChainId = await this.publicClient.getChainId();
    } catch (err: any) {
      throw new BasisError(`[basis-sdk] RPC endpoint unreachable: ${errorText(err)}`);
    }
    if (rpcChainId !== this.chainId) {
      throw new BasisError(
        `[basis-sdk] RPC returned chainId ${rpcChainId}, expected ${this.chainId} (${this.chainConfig.key}). ` +
        `Pass a matching rpcUrl or chain.`
      );
    }
  }

  /**
   * Compare the client with `${apiDomain}/contracts.json`: the chain id, and the deployment (the file's `network`,
   * `robinhood` or `robinhood-paper`, or an older file's `paper` flag, against the preset: real and paper share chain
   * 4663, so only these tell them apart). When the file publishes addresses, also every single-contract key, the vault
   * and pair-asset keys of the default main, and `mains`: keys the SDK does not know are ignored, a zero on both sides
   * means "not deployed" and matches. The sites publish no addresses today (the SDK carries its own book): a warning
   * then says the addresses were not compared. A `mains` entry that is not an object is skipped. A check that cannot
   * be made (the file unreachable or past 5 s, a non-2xx answer such as 429 or 5xx, a body that is not a JSON object,
   * an object that does not name the chain and deployment it describes: a numeric `chainId`, and `network` (a
   * non-empty string) or `paper` (true / false)) or a file that says BASIS is not live there (`live: false`, the real
   * site before its launch): 'strict' throws
   * BasisError saying why (nothing was confirmed), 'warn' logs it and goes on. Returns the mismatches; 'warn' logs them,
   * 'strict' throws BasisError on any (left out or null: 'warn'). Any other `mode` throws
   * ValidationError('contractsCheck') first.
   */
  async checkContracts(mode: 'warn' | 'strict' | null = 'warn'): Promise<string[]> {
    mode = mode ?? 'warn';
    if (mode !== 'warn' && mode !== 'strict') {
      throw new ValidationError('contractsCheck', `checkContracts mode must be 'warn' or 'strict', got ${shown(mode)}.`);
    }
    const m: 'warn' | 'strict' = mode;
    const file = `${this.apiDomain}/contracts.json`;
    const unchecked = (why: string): void => {
      const msg = `[basis-sdk] contractsCheck: ${file} ${why}, so the client was not compared with the deployment.`;
      if (m === 'strict') {
        throw new BasisError(`${msg} Retry later, or use contractsCheck: 'warn' (or 'off') to go on without the check.`);
      }
      console.warn(msg);
    };
    let remote: unknown = null;
    try {
      const res = await fetch(file, { signal: AbortSignal.timeout(5000), ...credentialsFor(this, false) });
      if (!res.ok) {
        unchecked(`answered HTTP ${res.status}`);
        return [];
      }
      const text = await res.text();
      try {
        remote = JSON.parse(text);
      } catch {
        unchecked('is not JSON');
        return [];
      }
    } catch (e) {
      if (e instanceof BasisError) throw e;
      unchecked(`could not be read (${errorText(e)})`);
      return [];
    }
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      unchecked('is not a JSON object');
      return [];
    }
    const r0 = remote as Record<string, unknown>;
    const mismatches = this.compareContracts(r0, m);
    if (!namesDeployment(r0)) {
      unchecked('does not say which chain and deployment it describes (it needs a numeric chainId, and network or paper)');
    }
    if (r0.live === false) {
      unchecked(`says BASIS is not live there${typeof r0.note === 'string' && r0.note ? ` ("${r0.note}")` : ''} (live: false)`);
    }
    return mismatches;
  }

  /** `checkContracts`' comparison of a readable `/contracts.json` object `remote` with the client. */
  private compareContracts(remote: any, mode: 'warn' | 'strict'): string[] {
    const mismatches: string[] = [];
    if (typeof remote.chainId === 'number' && remote.chainId !== this.chainId) {
      mismatches.push(`chainId: SDK ${this.chainId}, contracts.json ${remote.chainId}`);
    }
    const flag = contractsFlagMismatch(remote, this.chainConfig);
    if (flag) mismatches.push(flag);
    let published = 0;
    const flat: (keyof AddressBook)[] = [
      'swap', 'factory', 'taxes', 'leverage', 'mainLens', 'loanHub', 'vesting', 'liquidator', 'hopExecutor',
      'tranche', 'tranchePrivate', 'resolver', 'trancheReader', 'redemptionReader', 'upDown', 'bondToken', 'wrappedNative',
      'referrals',
    ];
    for (const key of flat) {
      const r = remote[key];
      const mine = this.addresses[key] as string;
      if (typeof r === 'string') published++;
      if (typeof r === 'string' && r.toLowerCase() !== mine.toLowerCase()) {
        mismatches.push(`${key}: SDK ${mine}, contracts.json ${r}`);
      }
    }
    const def = this.addresses.mains.find((m) => m.key === this.addresses.defaultMain);
    const pairs: [string, string, string | undefined][] = [
      ['staking', `mains[${this.addresses.defaultMain}].vault`, def?.vault],
      ['usdb', `mains[${this.addresses.defaultMain}].pairAsset`, def?.pairAsset],
    ];
    for (const [rk, label, mine] of pairs) {
      const r = remote[rk];
      if (typeof r === 'string') published++;
      if (typeof r === 'string' && !isZeroAddress(mine) && mine!.toLowerCase() !== r.toLowerCase()) {
        mismatches.push(`${rk}: SDK ${label} ${mine}, contracts.json ${r}`);
      }
    }
    const isEntry = (rm: unknown): rm is Record<string, unknown> => rm !== null && typeof rm === 'object' && !Array.isArray(rm);
    const remoteMains: Record<string, unknown>[] = Array.isArray(remote.mains) ? remote.mains.filter(isEntry) : [];
    if (remoteMains.length) published++;
    if (!published) {
      console.warn(
        `[basis-sdk] ${this.apiDomain}/contracts.json publishes no contract addresses (the SDK carries its own book): `
        + 'contractsCheck compared the chain id and the deployment only, not the addresses.',
      );
    }
    for (const rm of remoteMains) {
      const mine = this.addresses.mains.find((m) => m.key === rm.key);
      for (const field of ['main', 'pairAsset', 'vault'] as const) {
        const r = rm[field];
        const m = mine?.[field];
        if (typeof r === 'string' && !(isZeroAddress(r) && !m) && (m ?? '').toLowerCase() !== r.toLowerCase()) {
          mismatches.push(`mains[${String(rm.key)}].${field}: SDK ${m ?? '(missing)'}, contracts.json ${r}`);
        }
      }
    }

    if (mismatches.length) {
      const msg = `[basis-sdk] Mismatch with ${this.apiDomain}/contracts.json (${mismatches.length}):\n  ` + mismatches.join('\n  ');
      if (mode === 'strict') throw new BasisError(msg);
      console.warn(msg);
    }
    return mismatches;
  }

  /**
   * What `user` (default: the signer) can claim now, read from the chain: holder rewards per token, market redemptions,
   * Up/Down payouts, vesting claimables, vault rewards (the part `claim` pays) and liquidation leftovers (loans,
   * leverage positions, vesting loans awaiting settlement, each with its claim deadline), plus the sum per
   * asset. The market / round lists come from the API: pass them in, or leave one out to fetch it (API key; the signer
   * reading itself with only a session uses the /me routes). Holder-reward tokens come from the API with an API key,
   * from an on-chain scan of every factory token without one, plus the tokens of the user's leverage positions, loans
   * and beneficiary vestings either way; a token the SDK cannot value is listed in `skippedTokens`. `opts.loanHubs`:
   * older loan-hub addresses whose loans are read too. A section that cannot be read is listed in `failed` and the
   * others are still returned; sections whose contract is not deployed are listed in `skipped`.
   */
  async getClaimables(user?: Address | null, opts: GetClaimablesOptions | null = {}): Promise<Claimables> {
    const o = optsOf(opts, ANY_KEYS);
    return getClaimables(this, user ?? undefined, o);
  }

  /**
   * Credentials for agent registrations (`POST /api/agents`): the API key with the wallet it belongs to (an entry of
   * another wallet goes without it), and the session only when it holds the signer's wallet (hasSession). `cookieMode` lets the delivery send `credentials: 'omit'` in a browser when the
   * session does not go along.
   */
  private syncAuth(): SyncAuth & { cookieMode: CookieMode } {
    const session = this.hasSession;
    const browser = this.cookieMode === 'browser';
    return {
      apiKey: this._apiKey,
      apiKeyWallet: this._apiKeyWallet,
      sessionCookie: session && !browser ? this._sessionCookie : null,
      browserSession: session && browser,
      cookieMode: this.cookieMode,
      sessionWallets: this._sessionWallets,
      signAgentSync: (wallet: string, agentId: number) => this.agent._signSyncBody(wallet, agentId),
    };
  }

  /**
   * @internal The signed first sync of `agent.wallet`'s agent (no sign-in: a message the signer signs, again for every
   * attempt), after registration tx `txHash`: retried like `syncTx`; a failure worth retrying later is queued in
   * `pendingSyncs` (`kind: 'agentSigned'`, the wallet and agentId only) for `flushPendingSyncs()`, which signs it again
   * (it needs this signer). 400, 401, 403 and 409 are final. Never throws.
   */
  async _syncAgentSigned(txHash: string, agent: { wallet: string; agentId: number }): Promise<SyncResult> {
    try {
      return await this._sync.syncAgentSigned(txHash, agent);
    } catch (e) {
      const lastError = errorText(e);
      console.warn(`[basis-sdk] signed agent sync failed for ${txHash}:`, lastError);
      return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, queued: false, lastError };
    }
  }

  /** @internal Queues the signed first sync of `agent` (tx `txHash`) without posting it now. Never throws. */
  async _queueAgentSigned(txHash: string, agent: { wallet: string; agentId: number }, reason: string | null = 'not confirmed yet'): Promise<SyncResult> {
    if (typeof txHash === 'string' && !txHash.startsWith('0x')) txHash = `0x${txHash}`;
    return this._sync.queueAgentSigned(txHash, agent, reason ?? 'not confirmed yet');
  }

  /**
   * @internal The write pipeline's hand-off to an injected wallet (EIP-1193 / JSON-RPC account), which signs and
   * broadcasts itself; a local account is signed and broadcast by the pipeline (hash known before the broadcast). Not
   * public: it does no simulation, receipt wait or backend sync. Module writes call it from `BaseModule.send`, which
   * does those.
   * The SDK's chain goes with every request, so viem checks the wallet's current network (`eth_chainId`) and throws
   * its ChainMismatchError before anything is signed when the wallet is on another one.
   */
  async _writeContract(request: any): Promise<Hex> {
    if (!this.walletClient) throw new WalletRequiredError();
    return this.walletClient.writeContract({ ...request, chain: this.chainConfig.chain });
  }

  /**
   * Post a confirmed transaction to the backend (`POST /api/v1/sync {txHash, source: "sdk"}`). Every on-chain write
   * awaits this, order-book writes included (the route decodes their events).
   *
   * Retries network errors, timeouts, 5xx, 408, 425, 422 pending / sync_failed and 429 (waiting until
   * `X-RateLimit-Reset`) with exponential backoff (`sync` option), so a write takes longer when the API is down. A sync
   * that still fails, or that the API refuses as a chain mismatch (503) or with another 4xx, is logged and queued in
   * `pendingSyncs` (+ `queueFile`); retry it with `flushPendingSyncs()`. 400 and 422 reverted are logged, not queued.
   * `meta`: the tx's `{from, to}` when known (its sender and the contract it called), recorded on a queued line: the
   * write pipeline passes both (`agent.registerAndSync` reads on chain only a queued line of its wallet to the identity
   * registry, or one that names neither).
   *
   * Never throws: the tx is already confirmed, and an error would invite the caller to retry the write (double spend).
   */
  async syncTx(txHash: string, meta: QueuedTxMeta | null = {}): Promise<SyncResult> {
    if (typeof txHash === 'string' && !txHash.startsWith('0x')) txHash = `0x${txHash}`;
    try {
      return await this._sync.sync(txHash, meta ?? {});
    } catch (e) {
      const lastError = errorText(e);
      console.warn(`[basis-sdk] post-tx sync failed for ${txHash}:`, lastError);
      return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, queued: false, lastError };
    }
  }

  /**
   * Records an ERC-8004 registration made by tx `txHash` (`POST /api/agents` with the client's API key or session,
   * after the tx's own sync: the registry is not a BASIS contract, so `/api/v1/sync` stores the tx as `ignored`).
   * Retried like `syncTx`; a failure worth retrying later (no credentials, 401, 429, 503 not_deployed, retries spent)
   * is logged and queued in `pendingSyncs` (`kind: 'agent'`, + `queueFile`) for `flushPendingSyncs()`; 400, 409 and
   * 403 `wallet_in_account` / `forbidden` / `not_branded` are logged, not queued. A 403 `wallet_not_linked` (a key or
   * session of a wallet that cannot sign in yet) sends the signed first sync instead. `status` is `registered` when
   * delivered. Never throws.
   */
  async syncAgentRegistration(txHash: string, agent: AgentSyncPayload): Promise<SyncResult> {
    try {
      return await this._sync.syncAgent(txHash, agent);
    } catch (e) {
      const lastError = errorText(e);
      console.warn(`[basis-sdk] agent registration sync failed for ${txHash}:`, lastError);
      return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, queued: false, lastError };
    }
  }

  /**
   * Queues the tx sync of `txHash` without posting it now (`pendingSyncs` + `queueFile`, code `not_confirmed`), for a
   * tx that was sent but not seen confirmed: the write pipeline does this before throwing `TxNotConfirmedError`.
   * `meta`: the sent tx's `{from, to, nonce, block}` when known (sender, the contract it called, nonce, latest block
   * before sending).
   * `flushPendingSyncs()` checks such an entry on the chain first: it posts it once mined, keeps it while pending, and
   * drops it (logged) when its nonce went to a cancel or rewrites it to the replacement's hash after a speed-up.
   * Never throws.
   */
  async queueSync(txHash: string, reason: string | null = 'not confirmed yet', meta: QueuedTxMeta | null = {}): Promise<SyncResult> {
    if (typeof txHash === 'string' && !txHash.startsWith('0x')) txHash = `0x${txHash}`;
    return this._sync.queueTx(txHash, reason ?? 'not confirmed yet', 'not_confirmed', meta ?? {});
  }

  /**
   * Queues the `POST /api/agents` of `agent` (registration or update tx `txHash`) without posting it now
   * (`pendingSyncs` as a `kind: 'agent'` entry, + `queueFile`, code `not_confirmed`): agent.update does this before
   * throwing `TxNotConfirmedError`. `flushPendingSyncs()` posts it (after the tx's own sync). Never throws.
   */
  async queueAgentSync(txHash: string, agent: AgentSyncPayload, reason: string | null = 'not confirmed yet'): Promise<SyncResult> {
    if (typeof txHash === 'string' && !txHash.startsWith('0x')) txHash = `0x${txHash}`;
    return this._sync.queueAgent(txHash, agent, reason ?? 'not confirmed yet');
  }

  /**
   * Syncs that failed after every retry (live list, oldest first): tx syncs, and agent registrations
   * (`kind: 'agent'`). Retry them with `flushPendingSyncs()`.
   */
  get pendingSyncs(): PendingSync[] {
    return this._sync.pending;
  }

  /**
   * @internal The queued tx syncs (no `kind`) of this client: `pendingSyncs` plus the `queueFile` lines an earlier run
   * left (read without changing the file; a file that cannot be read adds nothing), one per hash. Never throws.
   * `agent.registerAndSync` looks here for a registration whose sync is still queued (any code). PY: `_queued_tx_entries`.
   */
  async _queuedTxEntries(): Promise<PendingSync[]> {
    const all = [...this._sync.pending];
    const file = this._sync.options.queueFile;
    if (file) {
      try {
        all.push(...await readSyncQueueFile(file));
      } catch {  }
    }
    const seen = new Set<string>();
    return all.filter((e) => {
      if (e.kind != null || typeof e.hash !== 'string') return false;
      const h = e.hash.toLowerCase();
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    });
  }

  /**
   * Retries every queued sync (memory, plus `queueFile` when set) with the client's retry policy (override with
   * `options`) and current credentials (agent registrations); what still fails stays queued and the file is rewritten
   * with it. A signed first sync the wallet declined to sign (code `user_rejected`) is asked for once per flush, never
   * again within it.
   */
  async flushPendingSyncs(options: SyncOptions | null = {}): Promise<FlushResult> {
    return this._sync.flush(options);
  }

  /**
   * Signs in with SIWE: fetches a nonce (`api.getNonce`), signs the message with the signer and verifies it
   * (`api.verify`), which adds the signer's wallet to the session. The answer's `sessionCookie` (every wallet of the
   * session) is sent from now on, for the signer's wallet (`sessionWallets`; after a signer switch, call this again).
   * A wallet the API does not let in yet throws BasisApiError code `wallet_not_linked`; until a sign-in of that wallet
   * works, the client then records that wallet's agent with the signed first sync (`agent.syncSigned`), whatever
   * credentials it holds (another signer switched in is not taken for it).
   * Browser cookie mode: the browser stores the cookie itself; the SDK then confirms the
   * session with `GET /api/auth/me` and throws BasisError when the browser did not keep the cookie (a cross-site API
   * without credentialed CORS, or blocked third-party cookies). Called by `create()`; needs a signer
   * (WalletRequiredError). A non-2xx answer throws BasisApiError. A nonce answer that is not a non-empty string of
   * letters and digits (EIP-4361's rule) throws ValidationError('siweNonce') before anything is signed. Returns the
   * verify answer.
   */
  async authenticate(): Promise<VerifyResult> {
    const account = this.walletClient?.account;
    if (!this.walletClient || !account) throw new WalletRequiredError();
    const nonce = siweNonceOf(await this.api.getNonce(account.address));
    const message = siweSignInMessage({
      domain: new URL(this.apiDomain).host, address: account.address, uri: this.apiDomain, chainId: this.chainId, nonce,
    });
    const signature = await this.walletClient.signMessage({ account, message });
    let result: VerifyResult;
    try {
      result = await this.api.verify(message, signature);
    } catch (e) {
      if (e instanceof BasisApiError && e.code === 'wallet_not_linked') {
        this._noDoorWallet = account.address.toLowerCase();
        this._noDoorAt = Date.now();
      }
      throw e;
    }
    if (this._noDoorWallet === account.address.toLowerCase()) {
      this._noDoorWallet = null;
      this._noDoorAt = null;
    }
    if (this.cookieMode === 'browser') {
      if (!(await this.refreshSession())) {
        throw new BasisError(
          `[basis-sdk] Signed in, but this browser did not keep the session cookie of ${this.apiDomain}. Serve the page ` +
          'from the API\'s origin (or proxy /api through it); a cross-site API needs credentialed CORS and a SameSite=None ' +
          'cookie. An API key (apiKey option) works without the session.',
        );
      }
    }
    return result;
  }

  /**
   * Reads the session state from the API (`GET /api/auth/me`, with the signer's address when there is a signer): true
   * when the signer's wallet (without a signer: any wallet) is signed in. The answer's wallets become
   * `sessionWallets`, so `hasSession` follows it: in browser cookie mode this is how the SDK learns of a session the
   * browser already holds (e.g. after a page reload); in both modes it confirms a session after a signer switch when
   * the new signer is already in it. The cookie is unchanged. A non-2xx answer throws BasisApiError.
   */
  async refreshSession(): Promise<boolean> {
    const account = this.account;
    return account
      ? ((await this.api.getMe(account)) as SessionStatus).isLoggedIn === true
      : (((await this.api.getMe()) as SessionSummary).addresses?.length ?? 0) > 0;
  }

  /**
   * Ensures an API key is available for the signer.
   *
   * - A key in hand (the `apiKey` option, or made by an earlier call) is returned when it belongs to the signer
   *   (`apiKeyWallet`) or there is no signer. A key whose wallet is not known (passed without a signer, a signer set
   *   later) becomes the signer's only when the signer's keys (listed with its session) show its hint (`bsk_****` +
   *   its last 4 characters) and the key itself names the signer's wallet (`GET /api/v1/me/profile` sent with the key
   *   alone: a hint matches another wallet's key 1 time in 65,536); a key it names for another wallet is recorded as
   *   that wallet's. Otherwise, and after a signer switch (the key belongs to the old wallet), the signer's key is made
   *   or asked for as below (the key in hand stays on the client until a new one replaces it, and goes out only for its
   *   own wallet). That GET's failure other than 401 / 403 (the key does not work) is thrown as it is.
   * - If the server reports an existing key, the SDK cannot retrieve the plaintext (only a masked hint is returned).
   *   Without `rotate` it throws ValidationError('apiKey') asking for the key; with `rotate: true` every existing key
   *   of the wallet is deleted and a new one created (anything still using the old key stops working).
   * - If no keys exist yet (or after the rotation), a new one is created. The server returns it **once**: it is kept on
   *   `client.apiKey`, passed to the `onApiKeyCreated` option when set, and returned. Only a masked hint
   *   (`bsk_****abcd`) is logged: store the key yourself for future runs.
   *
   * Needs a SIWE session holding the signer's wallet (`authenticate()`): AuthRequiredError('session') up front without
   * one. `rotate`: true or false, left out or null: false (ValidationError('rotate') otherwise). `opts` itself: left out,
   * null or `{ rotate }` (a value of another kind, e.g. `ensureApiKey(true)`: ValidationError('options')). @returns The
   * API key string.
   */
  async ensureApiKey(opts: EnsureApiKeyOptions | null = {}): Promise<string> {
    const o = optsOf(opts, ENSURE_API_KEY_KEYS);
    const rotate = toBool(o.rotate ?? undefined, 'rotate', false);
    const signer = this.account?.toLowerCase() ?? null;
    if (this._apiKey && (signer === null || this._apiKeyWallet === signer)) return this._apiKey;

    const noSession = sessionAuthError(this, 'ensureApiKey (GET/POST /api/v1/auth/keys)');
    if (noSession) throw noSession;

    const listData = await this.api.listApiKeys();
    const keys = Array.isArray(listData?.keys) ? listData.keys : [];

    const held = this._apiKey;
    if (held && this._apiKeyWallet === null && keys.some((k) => k?.keyHint === maskApiKey(held))) {
      const owner = await this.walletOfHeldKey();
      if (owner === signer) {
        this._apiKeyWallet = signer;
        return held;
      }
      if (owner !== null) this._apiKeyWallet = owner;
    }

    if (keys.length > 0) {
      if (!rotate) {
        throw new ValidationError('apiKey',
          (held ? `The API key this client holds (${maskApiKey(held)}) is not one of this wallet's keys. ` : '') +
          'An API key already exists for this wallet but the full key cannot be retrieved ' +
          '(the server only returns a masked hint). Pass your API key via the apiKey option ' +
          'when creating the client, e.g.: BasisClient.create({ privateKey, apiKey: "bsk_..." }), ' +
          'or replace it with BasisClient.create({ privateKey, rotateApiKey: true }).'
        );
      }
      for (const k of keys) {
        await this.api.deleteApiKey(k.id);
        console.warn(`[basis-sdk] Deleted the wallet's API key ${k.keyHint ?? k.id} (rotateApiKey).`);
      }
    }

    const createData = await this.api.createApiKey('basis-sdk-auto');
    const newKey: string = createData.key;
    this._apiKey = newKey;
    this._apiKeyWallet = signer;

    const hint = maskApiKey(newKey);
    if (this._onApiKeyCreated) {
      try {
        await this._onApiKeyCreated(newKey);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).split(newKey).join(hint);
        console.warn(`[basis-sdk] onApiKeyCreated failed for the new API key ${hint}: ${msg}`);
      }
    }
    console.warn(
      `[basis-sdk] New API key created (${hint}). The server shows it only once: read it from client.apiKey ` +
      `(or the onApiKeyCreated option), store it securely and pass it via the apiKey option on future runs.`
    );

    return newKey;
  }

  /**
   * The lower-case wallet the API key in hand belongs to (`api._keyWallet`: `GET /api/v1/me/profile` with the key
   * alone), null when the API refuses the key (401 / 403: it does not work, so it is no signer's) or names no wallet.
   * Any other failure (no answer, 429, 5xx) is thrown: nothing is decided on a guess (a rotation would delete keys).
   */
  private async walletOfHeldKey(): Promise<string | null> {
    try {
      return await this.api._keyWallet();
    } catch (e) {
      if (e instanceof BasisApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
  }

  /**
   * Signs `address` (default: the signer) out of the session (`api.logout`); with neither, ends the whole session.
   * The answer's `sessionCookie` (the remaining wallets, reissued) is sent from now on (null: the session ended,
   * nothing is sent) and the wallet leaves `sessionWallets`, so signing the signer out sets `hasSession` false even
   * when other wallets stay signed in. The API key is kept: it is not part of the session and stays valid (revoke it
   * with `api.deleteApiKey`). Needs a session (AuthRequiredError). Browser cookie mode: the browser applies the new
   * cookie; the request goes out even when the SDK knows of no session (the server answers 401 when there is none).
   */
  async logout(address?: string): Promise<LogoutResult> {
    return this.api.logout(address ?? this.account);
  }
}

/** Default receipt wait of a write after sending (both SDKs). */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;

/** Default deadline of one RPC request, ms (option `rpcTimeoutMs`; both SDKs). */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** How many times a failed RPC request is tried again (4 tries in all; both SDKs). */
export const RPC_RETRY_COUNT = 3;

/** The wait before the first RPC retry, ms, doubled for each next one (150, 300, 600; both SDKs). */
export const RPC_RETRY_DELAY_MS = 150;

/**
 * The SIWE (EIP-4361) sign-in text of `authenticate`: byte for byte what viem's `createSiweMessage` writes for these
 * fields (statement "Sign in to Basis API.", version 1, Issued At now in ISO form) and what PY's `authenticate` writes.
 * Built here, as in PY, so the nonce the API hands out is signed as it is (viem refuses one under 8 characters before
 * the API sees it; `siweNonceOf` checks only its characters); the API's own parser checks every field.
 */
function siweSignInMessage(p: { domain: string; address: string; uri: string; chainId: number; nonce: string }): string {
  return `${p.domain} wants you to sign in with your Ethereum account:\n${getAddress(p.address)}\n\nSign in to Basis API.\n\n`
    + `URI: ${p.uri}\nVersion: 1\nChain ID: ${p.chainId}\nNonce: ${p.nonce}\nIssued At: ${new Date().toISOString()}`;
}

/**
 * True when a `/contracts.json` object names what `checkContracts` compares: a numeric `chainId`, and the deployment
 * (`network` a non-empty string, or `paper` true / false). Without them a 'strict' check confirmed nothing. PY:
 * `_names_deployment`.
 */
function namesDeployment(r: Record<string, unknown>): boolean {
  return typeof r.chainId === 'number' && ((typeof r.network === 'string' && r.network !== '') || typeof r.paper === 'boolean');
}

/** EIP-4361's nonce: letters and digits only (no minimum length here: the API's parser judges that). PY: _SIWE_NONCE_RE. */
const SIWE_NONCE_RE = /^[A-Za-z0-9]+$/;

/**
 * The `nonce` of a `GET /api/auth/nonce` answer, or ValidationError('siweNonce') before anything is signed when it is
 * missing, not a string, empty or holds anything but ASCII letters and digits (a line break would add lines to the
 * signed text). Same rule and message as PY `_siwe_nonce_of`.
 */
function siweNonceOf(answer: unknown): string {
  const nonce = answer !== null && typeof answer === 'object' ? (answer as { nonce?: unknown }).nonce : undefined;
  if (typeof nonce === 'string' && SIWE_NONCE_RE.test(nonce)) return nonce;
  const got = nonce == null ? 'none' : typeof nonce !== 'string' ? 'not a string' : nonce === '' ? 'an empty string' : 'other characters';
  throw new ValidationError('siweNonce',
    `The API's sign-in nonce must be letters and digits only, got ${got}: nothing was signed. Try again; if it persists, the apiDomain may not be a BASIS API.`);
}

/**
 * `create()`'s `wallet_not_linked` answer without the `agent` option: the same BasisApiError (status, code, body,
 * retryAfter), its message adding the SDK's ways in (the API's own text names the website's). PY: `_no_door_hint`.
 */
function noDoorHint(e: BasisApiError): BasisApiError {
  const said = e.message.replace(/^\[basis-sdk\] /, '');
  return new BasisApiError(e.status, e.code,
    `${said} With the SDK: for an AI agent's own wallet, pass agent: true (BasisClient.create({ ..., agent: true })) to `
    + 'register it as a BASIS agent and sign it in; auth: false runs without the API (contract-only).', e.body, e.retryAfter);
}

/** A loggable hint of an API key: `bsk_****` + its last 4 characters (the server's `keyHint` format). */
export function maskApiKey(key: string): string {
  return `bsk_****${String(key).slice(-4)}`;
}
