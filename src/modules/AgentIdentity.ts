import { Address, BaseError, ContractFunctionRevertedError, getAddress, Hex, isHex, keccak256, toBytes, toHex } from 'viem';
import { isZeroAddress } from '../config/addresses';
import { base64ToUtf8, utf8ToBase64 } from '../core/base64';
import { BaseModule, TxResult } from '../core/BaseModule';
import { BasisError, TxNotConfirmedError, ValidationError, WalletRequiredError } from '../core/errors';
import { decodeEvents } from '../core/events';
import { PIN_POLL_MS, PIN_WAIT_MS, retryPinnedAt } from '../core/pinned';
import { SignerUnavailableError, type AgentSyncPayload, type PendingSync, type SignedAgentSyncBody, type SyncResult } from '../core/sync';
import { checkText, toAddress, toUint } from '../core/units';
import { checkKeys, isPlainOptions, optionKeys, optsOf } from '../core/opts';
import { BasisApiError } from '../api/core';
import type { Agent, AgentApplied, AgentList, AgentLookup, AgentRegistration } from '../api/content';


const identityRegistryAbi = [
  {"inputs":[{"name":"agentURI","type":"string"}],"name":"register","outputs":[{"name":"agentId","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"register","outputs":[{"name":"agentId","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"agentId","type":"uint256"}],"name":"getAgentWallet","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"agentId","type":"uint256"},{"name":"metadataKey","type":"string"}],"name":"getMetadata","outputs":[{"name":"","type":"bytes"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"agentId","type":"uint256"},{"name":"metadataKey","type":"string"},{"name":"metadataValue","type":"bytes"}],"name":"setMetadata","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"agentId","type":"uint256"},{"name":"newURI","type":"string"}],"name":"setAgentURI","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"spender","type":"address"},{"name":"agentId","type":"uint256"}],"name":"isAuthorizedOrOwner","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"name":"agentId","type":"uint256"}],"name":"tokenURI","outputs":[{"name":"","type":"string"}],"stateMutability":"view","type":"function"},
  {"anonymous":false,"inputs":[{"indexed":true,"name":"agentId","type":"uint256"},{"indexed":false,"name":"agentURI","type":"string"},{"indexed":true,"name":"owner","type":"address"}],"name":"Registered","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"name":"agentId","type":"uint256"},{"indexed":false,"name":"newURI","type":"string"},{"indexed":true,"name":"updatedBy","type":"address"}],"name":"URIUpdated","type":"event"},
  {"anonymous":false,"inputs":[{"indexed":true,"name":"agentId","type":"uint256"},{"indexed":true,"name":"indexedMetadataKey","type":"string"},{"indexed":false,"name":"metadataKey","type":"string"},{"indexed":false,"name":"metadataValue","type":"bytes"}],"name":"MetadataSet","type":"event"},
  {"inputs":[{"name":"tokenId","type":"uint256"}],"name":"ERC721NonexistentToken","type":"error"},
] as const;

/** An ERC-8004 registration-v1 service entry (e.g. `{ name: 'A2A', endpoint: 'https://.../agent-card.json', version: '0.3.0' }`). */
export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}
const AGENT_SERVICE_KEYS = optionKeys<AgentService>({ name: true, endpoint: true, version: true });

export interface AgentConfig {
  name?: string;
  description?: string;
  image?: string;
  capabilities?: string[];
  /** Registration-file `services`; default `[{ name: 'web', endpoint: <the BASIS site of the client's API> }]`. */
  services?: AgentService[];
}
const AGENT_CONFIG_KEYS = optionKeys<AgentConfig>({ name: true, description: true, image: true, capabilities: true, services: true });

/**
 * Outcome of `agent.register` / `agent.registerAndSync` / `agent.update`. Nothing is thrown once the tx is confirmed.
 */
export interface AgentRegisterResult {
  /** The tx (registerAndSync: the one passed in, or null when the API already had the agent). */
  hash: Hex | null;
  /** From the registry's `Registered` event (update: the id passed in); null when the receipt has none. */
  agentId: bigint | null;
  /** The token URI now on chain, from the `Registered` / `URIUpdated` event (recovery path: read from chain); else null. */
  uri: string | null;
  /**
   * True when the tx's `POST /api/v1/sync` failed and waits in `client.pendingSyncs` (when delivered, the route answers
   * `ignored`: the registry is not a BASIS contract); null when this call sent no tx.
   */
  txSyncQueued: boolean | null;
  /**
   * `POST /api/agents`: `ok` with status `registered`, or `queued` for `client.flushPendingSyncs()`; null when the API
   * already had the agent. With a session or a key it is `client.syncAgentRegistration`; for a wallet that cannot sign
   * in yet, the signed first sync (signed again for every attempt and at every flush).
   */
  registration: SyncResult | null;
  /**
   * What the delivered `POST /api/agents` applied to the wallet's profile (`registration.applied`): the registration
   * name as username and its image as avatar, each with `reason` when not (`taken`, `reserved`, `unusable`,
   * `chosen_name_kept`, `unreadable`, `pin_failed`, ...). Null when nothing was delivered or the API did not say.
   */
  applied: AgentApplied | null;
  /** E.g. an expected event missing from the logs. The tx is confirmed either way: never resend it. */
  warnings: string[];
}

/** Reasons the API kept the profile as it was on purpose (nothing to fix): no warning for these. */
const APPLIED_ON_PURPOSE = ['no_name', 'no_image', 'chosen_name_kept', 'chosen_photo_kept'];

/**
 * `registration.applied` for the result; logs one warning when the registration name or image was not used for a reason
 * the caller can fix (a taken or reserved name, an unreadable image, ...). The name part only when `config` names the
 * agent: an unnamed one is "Basis Agent", whose username is soon taken.
 */
function appliedFrom(wallet: string, registration: SyncResult | null, config?: AgentConfig): AgentApplied | null {
  const a = registration?.ok ? registration.applied ?? null : null;
  if (!a) return null;
  const not: string[] = [];
  const named = !!config?.name;
  if (named && !a.username.applied && !APPLIED_ON_PURPOSE.includes(a.username.reason ?? '')) not.push(`the name was not used as the username (${a.username.reason ?? 'no reason given'})`);
  if (!a.photo.applied && !APPLIED_ON_PURPOSE.includes(a.photo.reason ?? '')) not.push(`the image was not used as the avatar (${a.photo.reason ?? 'no reason given'})`);
  if (not.length) console.warn(`[basis-sdk] agent of ${wallet} is synced, but ${not.join(' and ')}. agent.update(agentId, config) with another name or image tries again.`);
  return a;
}

/**
 * `create({ agent })` registered the agent (or tried to) but could not finish onboarding: its first sync with BASIS
 * failed, or the sign-in after it did. The tx is confirmed: never register again (it would mint a second identity).
 * `agentId` and `txHash` say what is on chain (null when unknown); the message says what to do next.
 */
export class AgentOnboardingError extends BasisError {
  constructor(
    message: string,
    /** The agent's ERC-8004 id, null when the tx's `Registered` event could not be read. */
    public readonly agentId: bigint | null,
    /** The registration tx, null when none was sent (the API already had the agent). */
    public readonly txHash: Hex | null,
    /** The failed first sync (`POST /api/agents`), null when the failure came after it. */
    public readonly registration: SyncResult | null,
  ) {
    super(message);
    this.name = 'AgentOnboardingError';
  }
}

/** API limits of `POST /api/agents`, checked before the tx (a 400 after it could never be delivered). */
const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
/** Agent.agentId is an Int on the API. */
const MAX_AGENT_ID = 2147483647n;
/** Set by the registry at registration; only the signed `setAgentWallet` changes it (not in the SDK). */
const RESERVED_METADATA_KEY = 'agentWallet';
/** The registry metadata key that marks an agent registered elsewhere as a BASIS one (any non-empty value). */
export const BASIS_METADATA_KEY = 'basis';
const URI_PREFIX = 'data:application/json;base64,';
/** A `data:` registration file as the API reads it: JSON, an optional charset, base64 or not. */
const DATA_URI = /^data:application\/json(?:;charset=[A-Za-z0-9_-]+)?(;base64)?,([\s\S]*)$/i;
/** A registration file the API fetches and the SDK does not read (it then trusts the API's own check). */
const REMOTE_URI = /^(https|ipfs):\/\//i;
/** Local clock off by more than this from the API's: the signed sync's Issued time is taken from the API's clock. */
const CLOCK_SKEW_MS = 60_000;
/** A transaction hash: 0x + 64 hex digits (PY `_TX_HASH`). */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/**
 * Selectors of the registry's `register` overloads (ERC-8004: with a URI and metadata entries, with a URI, bare): the
 * only calls that mint an identity. Same list as PY `_REGISTER_SELECTORS`.
 */
const REGISTER_SELECTORS: readonly string[] = ['register(string,(string,bytes)[])', 'register(string)', 'register()']
  .map((sig) => keccak256(toBytes(sig)).slice(0, 10));

/** True when `input` (a tx's calldata) calls one of the registry's `register` overloads. */
function isRegisterCall(input: unknown): boolean {
  return typeof input === 'string' && REGISTER_SELECTORS.includes(input.slice(0, 10).toLowerCase());
}

/** A request that got no HTTP answer: a network or CORS failure (fetch's own error) or a timeout (status 0). */
function isTransportFailure(e: unknown): boolean {
  return !(e instanceof BasisApiError) || e.status === 0;
}

/** The `registrations` entry of a registration file: the agentId on `registry` of chain `chainId`. */
export interface AgentRegistrationRef {
  agentId: bigint | number;
  chainId: number;
  registry: string;
}
const AGENT_REGISTRATION_REF_KEYS = optionKeys<AgentRegistrationRef>({ agentId: true, chainId: true, registry: true });

/** The fields of `buildAgentSyncMessage`. */
export interface AgentSyncMessageParams {
  site: string;
  wallet: string;
  agentId: bigint | number;
  termsVersion: string;
  issued?: Date | null;
}
const AGENT_SYNC_MESSAGE_KEYS = optionKeys<AgentSyncMessageParams>({ site: true, wallet: true, agentId: true, termsVersion: true, issued: true });

/** True when `v` is not a string, or a well-formed one (no lone surrogate: `checkText`). */
function wellFormed(v: unknown): boolean {
  try {
    checkText(v, 'text');
    return true;
  } catch {
    return false;
  }
}

/**
 * `services` (left out or null: none given) checked: a list of `{ name, endpoint, version? }` strings, each well-formed
 * text (the registration file goes on chain).
 */
function checkServices(services: unknown): void {
  if (services === undefined || services === null) return;
  if (!Array.isArray(services)) throw new ValidationError('agentServiceInvalid', 'services must be a list of { name, endpoint, version? }.');
  services.forEach((s: any, i) => {
    const ok = s && typeof s === 'object' && !Array.isArray(s) && typeof s.name === 'string' && s.name !== '' && typeof s.endpoint === 'string' && s.endpoint !== ''
      && (s.version === undefined || s.version === null || typeof s.version === 'string');
    if (!ok) throw new ValidationError('agentServiceInvalid', `services[${i}] needs a non-empty string name and endpoint (version: an optional string).`);
    checkKeys<AgentService>(s, AGENT_SERVICE_KEYS, 'agentServiceInvalid', `services[${i}]`);
    for (const k of ['name', 'endpoint', 'version'] as const) {
      if (!wellFormed(s[k])) throw new ValidationError('agentServiceInvalid', `services[${i}].${k} is not valid UTF-8 text.`);
    }
  });
}

function normalizeServices(services: AgentService[] | undefined, home: string): AgentService[] {
  if (services === undefined || services === null) return [{ name: 'web', endpoint: home }];
  checkServices(services);
  return services.map((s) => (s.version ? { name: s.name, endpoint: s.endpoint, version: s.version } : { name: s.name, endpoint: s.endpoint }));
}

/** `read()`, or null when the node does not know the tx (viem's TransactionNotFound / ReceiptNotFound); else it throws. */
async function orNotFound<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return (await read()) ?? null;
  } catch (e) {
    if (/NotFound/.test((e as Error)?.name ?? '')) return null;
    throw e;
  }
}

/** What a value is, for a refusal message. */
function shownValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'string' ? `'${v}'` : typeof v === 'object' ? 'an object' : String(v);
}

/**
 * `config` checked as an AgentConfig before anything is read or sent: left out (undefined / null), or a plain object whose
 * `name`, `description` and `image` are strings, `capabilities` a list of strings and `services` a list of
 * `{ name, endpoint, version? }` strings; each field may be left out (undefined / null). Every string must be
 * well-formed text (no lone surrogate: the registration file goes on chain, and a lone surrogate would be stored as
 * U+FFFD). Else ValidationError naming the field: `agent` (not an object, or a key it does not have), `name`,
 * `description`, `image`, `capabilities`, `agentServiceInvalid` (services, also an entry with another key). Same rule as
 * PY `_check_agent_config` (None there is "left out").
 */
function checkAgentConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  const proto = typeof config === 'object' && config !== null ? Object.getPrototypeOf(config) : undefined;
  if (typeof config !== 'object' || Array.isArray(config) || (proto !== Object.prototype && proto !== null)) {
    throw new ValidationError('agent', `the agent config must be an object { name?, description?, image?, capabilities?, services? }, got ${shownValue(config)}.`);
  }
  checkKeys<AgentConfig>(config as AgentConfig, AGENT_CONFIG_KEYS, 'agent');
  const c = config as Record<string, unknown>;
  for (const field of ['name', 'description', 'image'] as const) {
    const v = c[field];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new ValidationError(field, `agent ${field} must be a string, got ${shownValue(v)}.`);
    }
    checkText(v, field);
  }
  const caps = c.capabilities;
  if (caps !== undefined && caps !== null && (!Array.isArray(caps) || !caps.every((x) => typeof x === 'string'))) {
    throw new ValidationError('capabilities', `agent capabilities must be a list of strings, e.g. ['trading'], got ${Array.isArray(caps) ? 'a list with a non-string' : shownValue(caps)}.`);
  }
  if (Array.isArray(caps)) caps.forEach((x) => checkText(x, 'capabilities'));
  checkServices(c.services);
}

/** The origin of `site` (an absolute http(s) URL: lower-case host, no default port, no path), else ValidationError('site'). */
function siteOrigin(site: string): string {
  let u: URL | null = null;
  try {
    u = typeof site === 'string' ? new URL(site) : null;
  } catch {  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) {
    throw new ValidationError('site', `site must be the BASIS site the agent belongs to, an absolute http(s) URL (the client's apiDomain), got ${JSON.stringify(site)}.`);
  }
  return u.origin;
}

/**
 * The ERC-8004 registration URI of an agent of the BASIS site `site` (the client's `apiDomain`, e.g.
 * `https://paper.launchonbasis.com`): `data:application/json;base64,<compact JSON, UTF-8>` in the registration-v1 shape
 * plus the BASIS fields (`website`: the site, `protocol: 'basis'`, `capabilities`). No wallet goes in a link: the
 * default `services` entry is `{ name: 'web', endpoint: <the site> }`. Unset `description` / `image` are left out (never
 * null). `registration` (known once the agent is minted; null = not given) adds `registrations: [{ agentId,
 * agentRegistry: 'eip155:<chainId>:<registry>' }]`. Same bytes as PY `build_agent_metadata_uri`. Throws ValidationError
 * (`site` for a site that is not an http(s) URL; `agentId` for a registration without a valid one; for `config` the
 * rules of `agent.register`: `agent` not an object, `name` / `description` / `image` not a string, `capabilities` not
 * a list of strings, `agentServiceInvalid` for a malformed `services` entry; the field's rule for text with a lone
 * surrogate: "<field> is not valid UTF-8 text.").
 */
export function buildAgentMetadataUri(site: string, config?: AgentConfig, registration?: AgentRegistrationRef | null): string {
  const home = siteOrigin(site);
  checkAgentConfig(config);
  const metadata: Record<string, unknown> = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: config?.name || 'Basis Agent',
  };
  if (config?.description) metadata.description = config.description;
  if (config?.image) metadata.image = config.image;
  metadata.services = normalizeServices(config?.services, home);
  metadata.website = home;
  metadata.protocol = 'basis';
  metadata.active = true;
  if (registration != null) {
    if (isPlainOptions(registration)) checkKeys<AgentRegistrationRef>(registration, AGENT_REGISTRATION_REF_KEYS, 'registration');
    const id = toUint(registration.agentId, 'agentId');
    metadata.registrations = [{
      agentId: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
      agentRegistry: `eip155:${registration.chainId}:${getAddress(registration.registry)}`,
    }];
  }
  metadata.capabilities = config?.capabilities || ['trading'];
  metadata.supportedTrust = ['reputation'];
  const json = JSON.stringify(metadata);
  const base64 = utf8ToBase64(json);
  return `${URI_PREFIX}${base64}`;
}

/**
 * The JSON object of a `data:application/json` token URI (base64 or not, an optional charset; as the BASIS API reads
 * it), or null for any other URI (https, ipfs, ...) or undecodable content. Same result as PY `parse_agent_metadata_uri`.
 */
export function parseAgentMetadataUri(uri: string): Record<string, unknown> | null {
  if (typeof uri !== 'string') return null;
  const m = DATA_URI.exec(uri.trim());
  if (!m) return null;
  try {
    const md = JSON.parse(m[1] ? base64ToUtf8(m[2]) : decodeURIComponent(m[2]));
    return md && typeof md === 'object' && !Array.isArray(md) ? md : null;
  } catch {
    return null;
  }
}

/** True when `endpoint` is on launchonbasis.com or one of its subdomains (paper.launchonbasis.com). */
function isBasisHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'launchonbasis.com' || host.endsWith('.launchonbasis.com');
  } catch {
    return false;
  }
}

/**
 * True when a registration file carries the BASIS mark, by the API's rule: `protocol: "basis"` (any case), or a
 * `services` entry named BASIS (any case) or pointing at launchonbasis.com (or a subdomain). The registry's `basis`
 * metadata key is the other mark (`agent.isBasisAgent` reads both). Same rule as PY `is_basis_registration`.
 */
export function isBasisRegistration(md: Record<string, unknown> | null | undefined): boolean {
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  const protocol = typeof md.protocol === 'string' ? md.protocol.trim().slice(0, 32) : '';
  if (protocol.toLowerCase() === 'basis') return true;
  if (!Array.isArray(md.services)) return false;
  return md.services.slice(0, 32).some((s: unknown) => {
    const e = s as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.endpoint !== 'string') return false;
    return e.name.slice(0, 64).trim().toLowerCase() === 'basis' || isBasisHost(e.endpoint.slice(0, 512));
  });
}

/**
 * True when `uri` is a `data:` registration file carrying the BASIS mark (`isBasisRegistration`). False for an https or
 * ipfs file (the SDK does not fetch it) and for anything unreadable.
 */
export function isBasisAgentUri(uri: string): boolean {
  return isBasisRegistration(parseAgentMetadataUri(uri));
}

/** First line of the signed agent sync message. */
export const AGENT_SYNC_TITLE = 'BASIS agent sync';

/**
 * The text an agent wallet signs for its FIRST `POST /api/agents` (`api.registerAgentSigned`), before it can sign in.
 * The API checks every line: `site` is the API's host, `issued` within 10 minutes of the server's clock, `termsVersion`
 * the current one (`GET /api/v1/config` `terms.version`). Signing it accepts the BASIS Terms. Same text as PY
 * `build_agent_sync_message`.
 */
export function buildAgentSyncMessage(p: AgentSyncMessageParams): string {
  const o = optsOf(p, AGENT_SYNC_MESSAGE_KEYS);
  return [
    AGENT_SYNC_TITLE,
    `Site: ${o.site}`,
    `Wallet: ${getAddress(o.wallet)}`,
    `Agent: ${toUint(o.agentId, 'agentId').toString()}`,
    `Issued: ${(o.issued ?? new Date()).toISOString()}`,
    `Terms: I accept the BASIS Terms of Service, version ${o.termsVersion}.`,
  ].join('\n');
}

/** Whether an agent carries the BASIS mark: `unknown` for an https / ipfs registration file without the metadata key. */
type BasisMark = 'yes' | 'no' | 'unknown';

/**
 * ERC-8004 agent identity (external Identity Registry) plus the backend agent API. `deployed` is false on a chain whose
 * address book has no registry, and every call that needs it throws `NotDeployedError` there.
 * A wallet signs in to the API only when it is linked to a BASIS account or is a registered agent, so a new agent's
 * first `POST /api/agents` is a signed message (`syncSigned`); `register` / `registerAndSync` / `update` send it when
 * the client has neither a session nor an API key of the signer's wallet (`client.apiKeyWallet`), or when the signer's
 * last sign-in answered `wallet_not_linked`.
 * One agent, one wallet: the API never records a wallet linked to a person's BASIS account as an agent.
 */
export class AgentIdentityModule extends BaseModule {
  /**
   * @internal How a gap between the wallet's pending and latest nonce is read before a registration is refused
   * (`agentTxPending`): `reads` reads `delayMs` apart (about 2 s in all), refused only when every one shows the gap. A
   * load-balanced RPC can answer the pending count from a node that has the last tx and the latest count from one a
   * block behind. PY: `AgentIdentityModule._PENDING_NONCE_RECHECK`.
   */
  static _pendingNonceRecheck = { reads: 5, delayMs: 500 };

  /**
   * @internal How long `registerAndSync` looks for a block with every tx of the wallet its nonce check saw mined, before
   * the identity read (`identityOnceMined`): the latest block is read again every `pollMs`, up to `waitMs`. PY:
   * `AgentIdentityModule._MINED_BLOCK_WAIT`.
   */
  static _minedBlockWait = { waitMs: PIN_WAIT_MS, pollMs: PIN_POLL_MS };

  /**
   * @internal Sync-queue entries `create({ agent })` read before its onboarding flush, which posts a mined tx's sync and
   * drops its line: `_refuseIfRegistrationPending` checks them with the live queue. Empty outside that call.
   */
  _earlierEntries: PendingSync[] = [];

  /**
   * @internal True while `create({ agent })` runs `registerAndSync`: a `register` of the signer whose tx sync the sync
   * queue holds (any code), mined without a revert with its identity still the signer's, is finished with
   * its txHash (the `registerAndSync(config, txHash)` path) instead of refused: the onboarding flush drops its line, so a
   * later run would have no evidence of it left. Outside create() such a tx is refused (`agentTxPending`, naming the
   * hash to pass). PY: `_finish_queued`.
   */
  _finishQueued = false;

  /**
   * Browser cookie mode: lower-case signers whose last session read before an agent tx (`GET /api/auth/me`) got no
   * answer from the API at all: the sign-in prompt is not asked for them (it could not work either). It decides the
   * prompt only: every agent write reads the session again (no prompt), and a read that answers takes the signer off
   * (one blip never refuses the client's later writes). A sign-in that was asked for and failed is not listed: it
   * stopped its write, and the next one asks again.
   */
  private readonly signInTried = new Set<string>();

  /** True when the address book has an ERC-8004 registry for this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.erc8004Registry);
  }

  /** ERC-8004 Identity Registry: a per-chain address from the address book (`NotDeployedError` when zero). */
  get registryAddress(): Address {
    return this.require(this.client.addresses.erc8004Registry, 'ERC8004Registry');
  }

  private read<T>(functionName: 'balanceOf' | 'ownerOf' | 'tokenURI' | 'getAgentWallet' | 'getMetadata' | 'isAuthorizedOrOwner', args: readonly unknown[]): Promise<T> {
    return this.client.publicClient.readContract({
      address: this.registryAddress, abi: identityRegistryAbi, functionName, args: args as any,
    }) as Promise<T>;
  }

  /**
   * True when `wallet` owns any ERC-8004 identity on the registry (any protocol: the registry is shared). `wallet`: a
   * 0x address (a mixed-case one must carry its EIP-55 checksum; ValidationError('wallet') otherwise).
   */
  async hasIdentity(wallet: Address): Promise<boolean> {
    const w = toAddress(wallet, 'wallet');
    return (await this.read<bigint>('balanceOf', [w])) > 0n;
  }

  /**
   * True when agent `agentId` carries the BASIS mark, by the API's rule: the registry's `basis` metadata key, or a
   * registration file with `protocol: "basis"` or a BASIS services entry (`isBasisRegistration`). An https or ipfs file
   * is not fetched: without the metadata key it reads false here (`isRegistered` then trusts the API's record).
   */
  async isBasisAgent(agentId: bigint): Promise<boolean> {
    return (await this.basisMark(toUint(agentId, 'agentId'))) === 'yes';
  }

  private async basisMark(agentId: bigint): Promise<BasisMark> {
    const uri = await this.getAgentURI(agentId);
    if (isBasisAgentUri(uri)) return 'yes';
    const mark = await this.getMetadata(agentId, BASIS_METADATA_KEY);
    if (typeof mark === 'string' && mark.length > 2) return 'yes';
    return REMOTE_URI.test(String(uri).trim()) ? 'unknown' : 'no';
  }

  /** Whether `wallet` may act as agent `agentId` (its owner or the agent wallet declared on the registry), and the owner. */
  private async controls(wallet: string, agentId: bigint): Promise<{ ok: boolean; owner: Address }> {
    const owner = await this.ownerOf(agentId);
    if (owner.toLowerCase() === wallet.toLowerCase()) return { ok: true, owner };
    const declared = await this.getAgentWallet(agentId);
    return { ok: !isZeroAddress(declared) && declared.toLowerCase() === wallet.toLowerCase(), owner };
  }

  /** The API's agent row of `wallet` (`GET /api/agents/{wallet}`), or null when it has none. API errors are thrown. */
  private async apiRow(wallet: string): Promise<Agent | null> {
    const lookup = await this.client.api.getAgent(wallet);
    const row = lookup?.isAgent ? lookup.agent : null;
    return row && typeof row.wallet === 'string' && row.wallet.toLowerCase() === wallet.toLowerCase() ? row : null;
  }

  /**
   * True when `wallet` acts as a BASIS agent: it owns the agent, or is the agent wallet the owner declared on the
   * registry, and the agent carries the BASIS mark (identities of other protocols do not count). With `agentId`: that
   * agent; a registration file the SDK does not read (https, ipfs) counts when the API records this agent for `wallet`.
   * Without: the registry cannot list a wallet's identities, so the API's row for `wallet` (`GET /api/agents/{wallet}`)
   * names the id, checked on chain the same way (an https / ipfs file then counts: the API checked it); false when the
   * API has none. API errors are thrown. `wallet`: a 0x address (ValidationError('wallet') otherwise, before any read).
   * `agentId` left out or null: none given (as PY None).
   * Never guard a `register()` with it: right after a register whose `POST /api/agents` still waits in
   * `client.pendingSyncs` it is false although the wallet holds a BASIS identity, and a register would mint a second
   * one. Use `registerAndSync(config)` for that.
   */
  async isRegistered(wallet: Address, agentId?: bigint | null): Promise<boolean> {
    wallet = toAddress(wallet, 'wallet');
    this.registryAddress;
    if (agentId !== undefined && agentId !== null) {
      const id = toUint(agentId, 'agentId');
      if (!(await this.controls(wallet, id)).ok) return false;
      const mark = await this.basisMark(id);
      if (mark !== 'unknown') return mark === 'yes';
      const row = await this.apiRow(wallet);
      return row !== null && BigInt(row.agentId) === id;
    }
    const row = await this.apiRow(wallet);
    if (!row) return false;
    const id = BigInt(row.agentId);
    return (await this.controls(wallet, id)).ok && (await this.basisMark(id)) !== 'no';
  }

  /**
   * Extract the agentId from a registration transaction receipt: the first `Registered` event emitted by the
   * registry, or null.
   */
  async getAgentIdFromTx(txHash: `0x${string}`): Promise<bigint | null> {
    const registry = this.registryAddress;
    const receipt = await this.client.publicClient.getTransactionReceipt({ hash: txHash });
    return decodeEvents(receipt, identityRegistryAbi, 'Registered', registry)[0]?.agentId ?? null;
  }

  /**
   * @internal Checks `config` as an AgentConfig before anything is read or sent: its types (ValidationError `agent` not
   * an object, `name` / `description` / `image` not a string, `capabilities` not a list of strings,
   * `agentServiceInvalid` for services) and the API's limits of `POST /api/agents` (`agentNameTooLong` above 100
   * characters, `agentDescriptionTooLong` above 500), the checks `register` makes before its tx. `create({ agent })`
   * runs it up front, so a bad config stops before the sign-in and the API key. PY: `_check_config`.
   */
  _checkConfig(config: unknown): void {
    this.agentFields(config as AgentConfig | undefined);
  }

  /**
   * The `POST /api/agents` body fields from `config` (name defaults to "Basis Agent"); checks the config's types and
   * the API's limits.
   */
  private agentFields(config?: AgentConfig): { name: string; description?: string } {
    checkAgentConfig(config);
    const name = config?.name || 'Basis Agent';
    const description = config?.description || undefined;
    if (name.length > MAX_NAME) throw new ValidationError('agentNameTooLong', `agent name is ${name.length} characters; the API takes at most ${MAX_NAME}.`);
    if (description && description.length > MAX_DESCRIPTION) {
      throw new ValidationError('agentDescriptionTooLong', `agent description is ${description.length} characters; the API takes at most ${MAX_DESCRIPTION}.`);
    }
    return { name, description };
  }

  /**
   * True when this client records its agent with the signed first sync: it has neither a session nor an API key of the
   * signer's wallet (`client.apiKeyWallet`: another wallet's key, or one whose wallet is not known, never goes with the
   * signer's record), or the current signer's last sign-in answered `wallet_not_linked` (a key made before the sign-in
   * rule would be refused the same way; after a signer switch the new signer is not taken for the old one). PY:
   * `_uses_signed_sync`.
   */
  private usesSignedSync(): boolean {
    const signer = this.client.account?.toLowerCase();
    const ownKey = !!this.client.apiKey && signer !== undefined && this.client.apiKeyWallet?.toLowerCase() === signer;
    return this.client._walletNotLinked || (!this.client.hasSession && !ownKey);
  }

  /**
   * Refuses (ValidationError, nothing sent, no gas spent) when the API cannot record an agent: `GET /api/v1/status`
   * (else `/api/v1/config`) must report `features.agents: true` (an ERC-8004 registry is configured there) for this
   * client's chain. API errors are thrown as they are.
   */
  private async requireApiRecordsAgents(action: string): Promise<void> {
    const status = await this.client.api.getStatus();
    const features = status?.features ?? (await this.client.api.getConfig())?.features;
    if (typeof status?.chainId === 'number' && status.chainId !== this.client.chainId) {
      throw new ValidationError('agentApiWrongChain',
        `${action}: the API at ${this.client.apiDomain} serves chain ${status.chainId}, this client is on chain ${this.client.chainId}, so it cannot record this agent. Nothing was sent.`);
    }
    if (features?.agents !== true) {
      throw new ValidationError('agentsNotSupported',
        `${action}: the API at ${this.client.apiDomain} cannot record agents on chain ${this.client.chainId} (features.agents is ${features ? String(features.agents) : 'missing'}: no ERC-8004 registry configured there). Nothing was sent, no gas spent.`);
    }
  }

  /**
   * Why the API in `config` takes no signed first sync, or null when it does: it must name the Terms version, and the
   * real site (`paper: false`) records an agent only for a signed-in wallet today.
   */
  private signedSyncRefusal(action: string, config: { paper?: boolean; terms?: { version?: string } } | null | undefined): ValidationError | null {
    if (!config?.terms?.version) {
      return new ValidationError('termsVersionUnknown',
        `${action}: ${this.client.apiDomain}/api/v1/config names no terms.version, so this API takes no signed agent sync. Nothing was sent, no gas spent.`);
    }
    if (config.paper === false) {
      return new ValidationError('agentSignedSyncUnavailable', this.client._walletNotLinked
        ? `${action}: this wallet cannot sign in at ${this.client.apiDomain} yet (wallet_not_linked), and that site takes no agent sync without a sign-in. Agents onboard on the paper site for now (chain: 'robinhoodPaper'). Nothing was sent, no gas spent.`
        : `${action}: the real site (${this.client.apiDomain}) records an agent only for a signed-in wallet: sign in first (BasisClient.create() with this signer, or client.authenticate()), then register. Nothing was sent, no gas spent.`);
    }
    return null;
  }

  /** Throws (before a tx) the `signedSyncRefusal` of the API's current config. API errors are thrown as they are. */
  private async requireSignedSync(action: string): Promise<void> {
    const refusal = this.signedSyncRefusal(action, await this.client.api.getConfig());
    if (refusal) throw refusal;
  }

  /**
   * @internal One agent, one wallet: refuses (ValidationError('wallet_in_account'), nothing sent) a signed-in wallet
   * that the API let in through a person's BASIS account. The paper site signs in only a person's linked wallet or an
   * agent, so a session there whose wallet has no agent row is a person's. Other APIs (`paper` not true in
   * `/api/v1/config`), clients without a session (before a registry tx the checks sign in first, a key-only client
   * too) and wallets that cannot sign in are not checked. API errors are thrown.
   */
  async _refuseIfPersonWallet(action: string): Promise<void> {
    if (!this.client.hasSession || this.client._walletNotLinked) return;
    if ((await this.client.api.getConfig())?.paper !== true) return;
    const wallet = this.account;
    if (await this.apiRow(wallet)) return;
    throw new ValidationError('wallet_in_account',
      `${action}: ${wallet} signs in through a BASIS account (X, Google or email), and the API never records such a wallet as an agent `
      + '(403 wallet_in_account). An agent needs a wallet of its own: make a new wallet for the agent and use its key. Nothing was sent, no gas spent.');
  }

  /**
   * @internal The signed first sync body of `wallet`'s agent `agentId`, signed now: the Terms version from
   * `GET /api/v1/config`, the Issued time from the API's clock (its Date header) when the local clock is more than 60 s
   * off. Throws SignerUnavailableError when the client has no signer for `wallet` (a queued entry then waits for one),
   * ValidationError when the API takes no signed sync, and API errors of the config read.
   */
  async _signSyncBody(wallet: string, agentId: number | bigint): Promise<SignedAgentSyncBody> {
    const walletClient = this.client.walletClient;
    const account = walletClient?.account;
    if (!walletClient || !account || account.address.toLowerCase() !== String(wallet).toLowerCase()) {
      throw new SignerUnavailableError(`the signed sync of agent ${String(agentId)} needs the signer of ${wallet}, which this client does not hold`);
    }
    const id = toUint(agentId, 'agentId');
    if (id > MAX_AGENT_ID) throw new ValidationError('agentId', `agentId must be an integer 0..${MAX_AGENT_ID} (the API stores an Int), got ${id}.`);
    const { config, serverSkewMs } = await this.client.api._getConfigWithClock();
    const refusal = this.signedSyncRefusal('agent sync', config);
    if (refusal) throw refusal;
    const issued = serverSkewMs !== null && Math.abs(serverSkewMs) > CLOCK_SKEW_MS ? new Date(Date.now() + serverSkewMs) : undefined;
    const message = buildAgentSyncMessage({
      site: new URL(this.client.apiDomain).host, wallet: account.address, agentId: id, termsVersion: config!.terms!.version!, issued,
    });
    const signature = await walletClient.signMessage({ account, message });
    return { agentId: Number(id), message, signature };
  }

  /**
   * The first sync of this signer's agent `agentId` without a sign-in, sent once: signs `buildAgentSyncMessage` (the
   * Terms version from `GET /api/v1/config`, the Issued time from the API's clock when the local one is more than 60 s
   * off) and posts it (`api.registerAgentSigned`). Signing accepts the BASIS Terms. For a wallet that cannot sign in yet
   * (BasisApiError code `wallet_not_linked`); afterwards `client.authenticate()` works. `register`, `registerAndSync`
   * and `update` send it on their own (retried, and queued for `client.flushPendingSyncs()`, which signs it again).
   * Also the way to sync an agent registered elsewhere (mark it first: `setMetadata(agentId, 'basis', '1')`). Throws
   * WalletRequiredError, ValidationError (`termsVersionUnknown`, `agentSignedSyncUnavailable` on the real site) and API
   * refusals (BasisApiError: 401 `invalid_signature`, 403 `not_branded` / `wallet_in_account` / `forbidden`, 429).
   */
  async syncSigned(agentId: bigint | number): Promise<AgentRegistration> {
    const account = this.client.walletClient?.account;
    if (!account) throw new WalletRequiredError();
    const body = await this._signSyncBody(account.address, toUint(agentId, 'agentId'));
    return this.client.api.registerAgentSigned(body);
  }

  /**
   * The `POST /api/agents` of `agentId` after a confirmed tx: `client.syncAgentRegistration` (a session or the signer's
   * API key; a 403 `wallet_not_linked` answer turns into the signed sync), else the signed first sync (retried, queued). A
   * missing id is reported (and logged), never thrown.
   */
  private async recordAgent(hash: Hex, wallet: string, agentId: bigint | null, fields: { name: string; description?: string }): Promise<SyncResult> {
    if (agentId === null) {
      const lastError = `no Registered event from ${this.registryAddress} in tx ${hash}: POST /api/agents not sent`;
      console.error(`[basis-sdk] agent registration of ${wallet}: ${lastError}`);
      return { ok: false, status: null, code: null, httpStatus: 0, attempts: 0, queued: false, lastError };
    }
    if (this.usesSignedSync()) return this.client._syncAgentSigned(hash, { wallet, agentId: Number(agentId) });
    const agent: AgentSyncPayload = { wallet, agentId: Number(agentId), ...fields };
    if (agent.description === undefined) delete agent.description;
    return this.client.syncAgentRegistration(hash, agent);
  }

  private txSyncQueued(hash: Hex): boolean {
    return this.client.pendingSyncs.some((e) => !e.kind && e.hash.toLowerCase() === hash.toLowerCase());
  }

  /**
   * The checks before a registry tx whose agent the API must record: `features.agents`; without a session (an API key
   * alone too), a sign-in first (`trySignIn`) unless the signer's wallet is known to have no door yet
   * (`wallet_not_linked`, noted for that wallet only); a sign-in skipped there (browser cookie mode, no answer from the
   * API) leaves the wallet unchecked, so it goes on only when the API already lists it as an agent
   * (`refuseUncheckedWallet`); then for the signed first sync the Terms version (and not the real site), else (signed
   * in) not a person's wallet.
   */
  private async preTxChecks(action: string): Promise<void> {
    await this.requireApiRecordsAgents(action);
    if (!this.client.hasSession && !this.client._walletNotLinked && !(await this.trySignIn())) {
      await this.refuseUncheckedWallet(action);
    }
    if (this.usesSignedSync()) await this.requireSignedSync(action);
    else await this._refuseIfPersonWallet(action);
  }

  /**
   * After a skipped sign-in (browser cookie mode: `GET /api/auth/me` got no answer from the API) and still no session:
   * the SDK cannot tell a person's wallet from a new one, and the API never records a wallet of a person's BASIS account
   * as an agent (403 `wallet_in_account`, final, once the gas is spent). So the tx goes on only when the API's row
   * (`GET /api/agents/{wallet}`) shows the signer already acts as an agent; else ValidationError
   * `agentSignInUnavailable`, nothing sent. API errors of that read are thrown (nothing sent). PY has no such skip: a
   * failed sign-in stops there.
   */
  private async refuseUncheckedWallet(action: string): Promise<void> {
    if (this.client.hasSession) return;
    const wallet = this.account;
    if (await this.apiRow(wallet)) return;
    throw new ValidationError('agentSignInUnavailable',
      `${action}: the sign-in before the tx got no answer from ${this.client.apiDomain} (a page on another site without `
      + `credentialed CORS, or the API unreachable), so the SDK cannot tell whether ${wallet} belongs to a BASIS account `
      + '(X, Google or email), which the API never records as an agent. Nothing was sent, no gas spent. Register from a '
      + "page on the API's own site (or one that proxies /api), or from Node with the agent's own key.");
  }

  /**
   * A sign-in before the tx of a client without a session (`auth: false`, with or without an API key): a wallet linked
   * to a person's BASIS account signs in, and `_refuseIfPersonWallet` then refuses it before any gas is spent (its
   * record would get 403 `wallet_in_account`, final, after the mint: an orphaned identity). Signed in, the client keeps
   * the session. `wallet_not_linked` (a new wallet, noted by `authenticate`) goes on with the signed first sync. Any
   * other failure (429, 5xx, no answer, a declined signature prompt) stops the write before the tx: its error is thrown
   * as it is, nothing was sent (without the sign-in the SDK cannot tell a person's wallet from a new one). PY:
   * `_try_sign_in`.
   * Browser cookie mode (each sign-in is a wallet prompt): a session the browser already holds for the signer is taken
   * first (`refreshSession()`, no prompt), on every agent write; when that read gets no answer from the API at all (a
   * page on another site without credentialed CORS, where a sign-in would fail the same way) the sign-in prompt is
   * skipped (`signInTried`), and the caller then lets only a wallet the API lists as an agent go on
   * (`refuseUncheckedWallet`). The next agent write reads the session again: one that answers goes on as usual (a
   * blip refuses only the write it hit). A sign-in that failed is asked for again on the next agent write (that write
   * stopped before its tx). Resolves to false when the sign-in was skipped, else true.
   */
  private async trySignIn(): Promise<boolean> {
    if (this.client.cookieMode === 'browser') {
      const signer = this.account.toLowerCase();
      try {
        const held = await this.client.refreshSession();
        this.signInTried.delete(signer);
        if (held) return true;
      } catch (e) {
        if (isTransportFailure(e)) this.signInTried.add(signer);
        else this.signInTried.delete(signer);
      }
      if (this.signInTried.has(signer)) return false;
    }
    try {
      await this.client.authenticate();
    } catch (e) {
      if (e instanceof BasisApiError && e.code === 'wallet_not_linked') return true;
      throw e;
    }
    return true;
  }

  /**
   * Register the signer as an ERC-8004 agent. The registration file links the client's BASIS site
   * (`buildAgentMetadataUri(client.apiDomain, config)`). The tx goes through the standard write pipeline (its
   * `/api/v1/sync` is awaited), then the registration is recorded with `POST /api/agents` (`client.syncAgentRegistration`:
   * retried, queued for `client.flushPendingSyncs()` on failure; without a session or an API key of the signer's
   * wallet, or after a sign-in that answered `wallet_not_linked`: the signed first sync, signed again for every attempt).
   * Without a session (an API key alone too) it signs in first (browser cookie mode: a session the browser holds is
   * taken first; a page that gets no answer from the API skips it, and then goes on only for a wallet the API already
   * lists as an agent, else ValidationError `agentSignInUnavailable`, nothing sent): a wallet that can (a person's linked wallet) is
   * refused before the tx (`wallet_in_account`) and keeps the session; a new wallet (`wallet_not_linked`) goes on with
   * the signed first sync; any other failure of that sign-in (429, 5xx, no answer, a declined prompt) stops before the
   * tx, its error thrown as it is (nothing sent).
   * A warning says when the name (when `config` gives one) or the image was not used. Never throws after the
   * tx is confirmed: the outcome is in `agentId`, `txSyncQueued`, `registration` and `warnings`. Before the tx it
   * throws ValidationError (the config's types: `agent` not an object, `name` / `description` / `image` not a string,
   * `capabilities` not a list of strings, `agentServiceInvalid`; `agentNameTooLong`, `agentDescriptionTooLong`, `agentsNotSupported` /
   * `agentApiWrongChain` when the API cannot record agents, `termsVersionUnknown` / `agentSignedSyncUnavailable` when
   * the signed sync cannot work there, `wallet_in_account` for a signed-in wallet of a person's BASIS account) and API
   * errors from those checks. A receipt that cannot be read after sending throws `TxNotConfirmedError` whose `note`
   * says to call `registerAndSync(config, txHash)` once the tx is mined (the agentId, and so `POST /api/agents`, comes
   * from the receipt); calling `register` again would mint a second identity.
   */
  async register(config?: AgentConfig): Promise<AgentRegisterResult> {
    const wallet = this.account;
    const fields = this.agentFields(config);
    const uri = buildAgentMetadataUri(this.client.apiDomain, config);
    const registry = this.registryAddress;
    await this.preTxChecks('agent.register');

    let tx: TxResult;
    try {
      tx = await this.send({
        address: registry, abi: identityRegistryAbi, functionName: 'register', args: [uri],
        contract: 'ERC8004Registry',
      });
    } catch (e) {
      if (e instanceof TxNotConfirmedError) {
        throw e.withNote(
          `The agent is NOT recorded with the API yet (POST /api/agents needs the agentId from the mined tx). Once the tx is mined, `
          + `call agent.registerAndSync(config, '${e.txHash}'); do not call register() again (it would mint a second identity).`,
        );
      }
      throw e;
    }

    const ev = this.expectEvent(tx, identityRegistryAbi, 'Registered', registry, 'ERC8004Registry', ['agentId', 'uri']);
    const agentId = ev?.agentId ?? null;
    const txSyncQueued = this.txSyncQueued(tx.hash);
    const registration = await this.recordAgent(tx.hash, wallet, agentId, fields);
    return { hash: tx.hash, agentId, uri: ev?.agentURI ?? null, txSyncQueued, registration, applied: appliedFrom(wallet, registration, config), warnings: tx.warnings };
  }

  /**
   * The owner of agent `agentId`, or null when the registry reverts the read (no such token: on a node a block or two
   * behind, an identity minted just now). Other errors (RPC) are thrown.
   */
  private async ownerOrNull(agentId: bigint): Promise<Address | null> {
    try {
      return await this.ownerOf(agentId);
    } catch (e) {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
      throw e;
    }
  }

  /**
   * @internal Refuses (ValidationError('agentTxPending'), nothing sent) a new registration of `wallet` while one of its
   * transactions may still be an earlier registration:
   * - its pending nonce stays above its latest one (a tx from it is still pending): read again over about 2 s
   *   (`_pendingNonceRecheck`) and refused only when the gap persists, since a load-balanced RPC can answer the two
   *   counts from nodes a block apart;
   * - or the sync queue (`pendingSyncs`, the `queueFile`, and the lines `create({ agent })` read before its onboarding
   *   flush) holds a tx sync line of it (any code: sent but not seen confirmed, or mined with its sync post failed; a
   *   line naming another sender, or a target other than the registry, is skipped unread: only a line to the registry
   *   or with no target recorded (an older line), is read) whose tx, read on chain, is a
   *   `register` call of it to the registry that is still pending, or mined without a revert while the agentId of its
   *   `Registered` event is still owned by `wallet` (or not visible yet: the identity read may lag behind it). A tx to
   *   the registry that is not a `register` call (setAgentURI, setMetadata), a mined one whose identity the wallet no
   *   longer owns, and a queued tx the node does not know at all are not counted.
   * Returns what the identity read must cover (`identityOnceMined`): `count`, the wallet's nonce count the reads saw
   * (the highest pending count, or the last latest one when higher), and `gapClosed`, true when a gap was seen and
   * closed during the re-reads (a pending tx of `wallet` mined meanwhile, maybe an earlier registration). While
   * `_finishQueued` is set (create({ agent })), a queued register that is mined without a revert and whose agent the
   * registry shows owned by `wallet` is not refused but returned as `minedHash` (the first one; any other queued
   * register still pending or not visible yet is refused as before): the caller records it with its txHash. RPC errors
   * are thrown. PY: `_refuse_if_registration_pending` (a `(count, gap_closed, mined_hash)` tuple).
   */
  async _refuseIfRegistrationPending(action: string, wallet: Address): Promise<{ count: number; gapClosed: boolean; minedHash?: Hex }> {
    const pc = this.client.publicClient;
    const { reads, delayMs } = AgentIdentityModule._pendingNonceRecheck;
    let pending = 0;
    let latest = 0;
    let highest = 0;
    let gap = false;
    for (let i = 0; ; i++) {
      [pending, latest] = await Promise.all([
        pc.getTransactionCount({ address: wallet, blockTag: 'pending' }),
        pc.getTransactionCount({ address: wallet, blockTag: 'latest' }),
      ]);
      highest = Math.max(highest, pending);
      if (pending > latest) gap = true;
      if (pending <= latest || i + 1 >= reads) break;
      await new Promise((ok) => setTimeout(ok, delayMs));
    }
    if (pending > latest) {
      const n = pending - latest;
      throw new ValidationError('agentTxPending',
        `${action}: ${wallet} has ${n} transaction${n > 1 ? 's' : ''} still pending (nonce ${latest}${n > 1 ? ` to ${pending - 1}` : ''}): `
        + 'one may be an earlier registration, and registering now could mint a second identity. Nothing was sent. Wait until '
        + 'it is mined, then call this again; for a registration of yours, pass its txHash: registerAndSync(config, txHash).');
    }
    const registry = this.registryAddress;
    const me = wallet.toLowerCase();
    const seen = new Set<string>();
    let minedHash: Hex | undefined;
    for (const e of [...await this.client._queuedTxEntries(), ...this._earlierEntries]) {
      if (e.kind != null || typeof e.hash !== 'string' || seen.has(e.hash.toLowerCase())) continue;
      seen.add(e.hash.toLowerCase());
      const from: unknown = e.from;
      if (typeof from === 'string' && from.toLowerCase() !== me) continue;
      const to: unknown = e.to;
      if (typeof to === 'string' && to.toLowerCase() !== registry.toLowerCase()) continue;
      const hash = e.hash as Hex;
      const tx = await orNotFound(() => pc.getTransaction({ hash }));
      if (!tx || tx.from.toLowerCase() !== me || (tx.to ?? '').toLowerCase() !== registry.toLowerCase()) continue;
      if (!isRegisterCall(tx.input)) continue;
      const mined = tx.blockNumber !== null;
      let agentId: bigint | null = null;
      if (mined) {
        const receipt = await orNotFound(() => pc.getTransactionReceipt({ hash }));
        if (receipt) {
          if (receipt.status !== 'success') continue;
          agentId = decodeEvents({ logs: receipt.logs ?? [] }, identityRegistryAbi, 'Registered', registry)[0]?.agentId ?? null;
          if (agentId === null) continue;
          const owner = await this.ownerOrNull(agentId);
          if (owner !== null && owner.toLowerCase() !== me) continue;
          if (owner !== null && this._finishQueued) {
            minedHash ??= hash;
            continue;
          }
        }
      }
      const line = e.code === 'not_confirmed' ? 'a registration sent but not seen confirmed' : 'a registration whose sync is still queued';
      throw new ValidationError('agentTxPending',
        `${action}: the sync queue holds tx ${e.hash} from ${wallet} to the identity registry, ${line} `
        + `(${mined ? 'mined since' : 'still pending'})${agentId !== null ? `: agent ${agentId} is this wallet's` : ''}. Registering now could mint a `
        + `second identity. Nothing was sent. ${mined ? 'Pass it' : 'Once it is mined, pass it'}: registerAndSync(config, '${e.hash}'). `
        + 'client.flushPendingSyncs() clears the queued line once the tx is mined (it posts the tx\'s sync).');
    }
    const count = Math.max(highest, latest);
    return minedHash ? { count, gapClosed: gap, minedHash } : { count, gapClosed: gap };
  }

  /**
   * Whether `wallet` holds an ERC-8004 identity at a block where all `count` of its txs are mined (`count`: the nonce
   * count `_refuseIfRegistrationPending` saw): the latest block, read again every `pollMs` up to `waitMs`
   * (`_minedBlockWait`) while its nonce count there is below `count` (a node a block behind can answer first), then
   * `balanceOf` pinned to that block (`retryPinnedAt`). The only identity read before a mint: a balance read at latest
   * from a lagging node can miss an identity another process minted in the last block; this one cannot (two reads more,
   * and no wait once the node is caught up). When no block shows those txs mined in time: ValidationError
   * ('agentTxPending'), nothing sent (`gapClosed`: one was pending a moment ago, else a node behind). RPC errors are
   * thrown (a node that still does not know the block: BasisRpcError). PY: `_identity_once_mined`.
   */
  private async identityOnceMined(action: string, wallet: Address, count: number, gapClosed = true): Promise<boolean> {
    const pc = this.client.publicClient;
    const registry = this.registryAddress;
    const { waitMs, pollMs } = AgentIdentityModule._minedBlockWait;
    const until = Date.now() + waitMs;
    for (;;) {
      const block = await pc.getBlockNumber({ cacheTime: 0 });
      const mined = await retryPinnedAt(() => pc.getTransactionCount({ address: wallet, blockNumber: block }), block);
      if (mined >= count) {
        const owned = await retryPinnedAt(() => pc.readContract({
          address: registry, abi: identityRegistryAbi, functionName: 'balanceOf', args: [wallet], blockNumber: block,
        }), block);
        return owned > 0n;
      }
      if (Date.now() >= until) {
        const [what, next] = gapClosed
          ? [`${wallet} had a transaction pending a moment ago (nonce ${count - 1}), and no block shows it mined yet`, 'Wait until it is mined, then call this again']
          : [`${wallet}'s last transaction (nonce ${count - 1}) shows in no block the RPC serves yet (a node behind)`, 'Call this again in a moment'];
        throw new ValidationError('agentTxPending',
          `${action}: ${what}: it may be an earlier registration, and registering now could mint a second identity. Nothing was sent. `
          + `${next}; for a registration of yours, pass its txHash: registerAndSync(config, txHash).`);
      }
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
  }

  /**
   * Registers the signer unless it already acts as a BASIS agent. It asks the API first:
   * - the API has the signer's agent and the signer is its owner or its declared agent wallet: returns it (no tx, no
   *   post). The API has it but the signer controls it no more: ValidationError `agentNotControlled` (nothing sent;
   *   `register(config)` mints a new identity), unless `txHash` names the one to record;
   * - the API has none and the signer owns no ERC-8004 identity: `register(config)`, unless a transaction of the
   *   signer may still be an earlier registration: ValidationError `agentTxPending` (nothing sent) while its pending
   *   nonce stays above its latest one for about 2 s (a tx from it is still pending), or while the sync queue
   *   (`pendingSyncs` and the `queueFile`) holds a `register` call of it whose tx sync is queued, whatever its code (still
   *   pending, or mined with an identity the signer still owns; in `create({ agent })` a mined one whose
   *   identity the registry shows the signer's is recorded with its txHash instead, as below). These checks come first and the
   *   identity is read after them, always at a block that has every tx of the signer they saw mined (never at latest,
   *   which a node behind can answer); when a pending tx of the signer was mined during the re-reads and the signer now
   *   holds an identity, it is refused (`agentTxPending`: it may be that earlier registration; pass its txHash);
   * - otherwise records the registration tx `txHash` (`POST /api/agents`, retried and queued like `register`).
   *   Throws ValidationError (nothing is sent) when `txHash` is missing (`agentTxHashRequired`: the registry cannot
   *   list a wallet's identities), holds no `Registered` event (`agentIdNotInTx`), names an agent the signer neither owns
   *   nor is the agent wallet of (`agentNotOwned`), or one without the BASIS mark (`agentNotBasis`; an https / ipfs file
   *   the SDK does not read is left to the API), plus the `register` pre-checks. `config` is type-checked first (the
   *   `register` rules), then `txHash` when given (null = not given): 0x + 64 hex digits, else ValidationError
   *   `txHash` ('' included), before any read. API lookup errors (429, 5xx, network) and RPC errors are thrown, never
   *   read as "not in the API" or "nothing pending".
   */
  async registerAndSync(config?: AgentConfig, txHash?: `0x${string}` | null): Promise<AgentRegisterResult> {
    checkAgentConfig(config);
    if (txHash != null && (typeof txHash !== 'string' || !TX_HASH.test(txHash))) {
      throw new ValidationError('txHash', `txHash must be a transaction hash (0x + 64 hex characters), got ${typeof txHash === 'string' ? JSON.stringify(txHash) : String(txHash)}.`);
    }
    const wallet = this.account;
    this.registryAddress;
    const row = await this.apiRow(wallet);
    if (row) {
      const id = BigInt(row.agentId);
      if ((await this.controls(wallet, id)).ok) {
        return { hash: null, agentId: id, uri: null, txSyncQueued: null, registration: null, applied: null, warnings: [] };
      }
      if (!txHash) {
        throw new ValidationError('agentNotControlled',
          `the API has agent ${id} for ${wallet}, but this wallet is neither its owner nor its agent wallet on the registry any more. `
          + 'Nothing was sent. register(config) mints a new identity for it; registerAndSync(config, txHash) records one you minted.');
      }
    }
    if (!txHash) {
      const seen = await this._refuseIfRegistrationPending('agent.registerAndSync', wallet);
      if (seen.minedHash) return this.recordFromTx(config, wallet, seen.minedHash);
      const owns = await this.identityOnceMined('agent.registerAndSync', wallet, seen.count, seen.gapClosed);
      if (!owns) return this.register(config);
      if (seen.gapClosed) {
        throw new ValidationError('agentTxPending',
          `agent.registerAndSync: ${wallet} had a transaction pending a moment ago (nonce ${seen.count - 1}) that is mined now, and the wallet holds `
          + 'an ERC-8004 identity: it may be an earlier registration whose sync with BASIS is still on its way. Registering now could mint a '
          + 'second identity. Nothing was sent. For a registration of yours, pass its txHash: registerAndSync(config, txHash).');
      }
      throw new ValidationError(
        'agentTxHashRequired',
        `${wallet} owns an ERC-8004 identity but the API has no BASIS agent for it, and the registry cannot list a wallet's identities. `
        + 'Nothing was sent. For a BASIS registration, pass its txHash: registerAndSync(config, txHash). For an identity registered '
        + "elsewhere, mark it first (setMetadata(agentId, 'basis', '1')), then syncSigned(agentId); register(config) mints a new BASIS identity instead.",
      );
    }
    return this.recordFromTx(config, wallet, txHash);
  }

  /**
   * `registerAndSync`'s txHash path: records registration tx `txHash` of `wallet` (`POST /api/agents`, retried and
   * queued like `register`) after its checks (`agentIdNotInTx`, `agentNotOwned`, `agentNotBasis`, the API's
   * `features.agents` and, for the signed first sync, the Terms version). Also how `create({ agent })` finishes a
   * mined registration it found in the sync queue.
   */
  private async recordFromTx(config: AgentConfig | undefined, wallet: Address, txHash: Hex): Promise<AgentRegisterResult> {
    const fields = this.agentFields(config);
    const agentId = await this.getAgentIdFromTx(txHash);
    if (agentId === null) throw new ValidationError('agentIdNotInTx', `tx ${txHash} has no Registered event from the registry.`);
    const c = await this.controls(wallet, agentId);
    if (!c.ok) {
      throw new ValidationError('agentNotOwned',
        `agent ${agentId} (from tx ${txHash}) belongs to ${c.owner}, and ${wallet} is neither its owner nor its agent wallet: the API would refuse it (403 forbidden). Nothing was sent.`);
    }
    const uri = await this.getAgentURI(agentId);
    if ((await this.basisMark(agentId)) === 'no') {
      throw new ValidationError('agentNotBasis',
        `agent ${agentId} carries no BASIS mark (protocol "basis" or a BASIS services entry in its registration file, or the registry's "basis" metadata key): `
        + `the API would refuse it (403 not_branded). setMetadata(${agentId}n, 'basis', '1') marks it; update(${agentId}n, config) rewrites its file as a BASIS registration. Nothing was sent.`);
    }
    await this.requireApiRecordsAgents('agent.registerAndSync');
    if (this.usesSignedSync()) await this.requireSignedSync('agent.registerAndSync');
    const registration = await this.recordAgent(txHash, wallet, agentId, fields);
    return { hash: txHash, agentId, uri, txSyncQueued: null, registration, applied: appliedFrom(wallet, registration, config), warnings: [] };
  }

  /**
   * Rewrites agent `agentId`'s registration (name, description, image, capabilities, services) on chain with
   * `setAgentURI`, the URI now carrying `registrations` (this agentId on this registry) and linking the client's BASIS
   * site, then re-posts it with `POST /api/agents` (the signed first sync for a wallet that cannot sign in yet, as in
   * `register`) so the API row follows. Also turns a non-BASIS identity of the signer into a BASIS one. Never throws
   * after the tx is confirmed. Before it: ValidationError (`agentNotOwned` when the signer is not the owner, the
   * `register` checks). A receipt that cannot be read after sending throws `TxNotConfirmedError` with both the tx sync
   * and the `POST /api/agents` queued: `client.flushPendingSyncs()` finishes it.
   */
  async update(agentId: bigint, config?: AgentConfig): Promise<AgentRegisterResult> {
    const wallet = this.account;
    const id = toUint(agentId, 'agentId');
    const fields = this.agentFields(config);
    const registry = this.registryAddress;
    const uri = buildAgentMetadataUri(this.client.apiDomain, config, { agentId: id, chainId: this.client.chainId, registry });
    const owner = await this.ownerOf(id);
    if (owner.toLowerCase() !== wallet.toLowerCase()) {
      throw new ValidationError('agentNotOwned', `agent ${id} belongs to ${owner}, not the signer ${wallet}: only its owner rewrites its registration here. Nothing was sent.`);
    }
    await this.preTxChecks('agent.update');
    const signed = this.usesSignedSync();

    let tx: TxResult;
    try {
      tx = await this.send({
        address: registry, abi: identityRegistryAbi, functionName: 'setAgentURI', args: [id, uri], contract: 'ERC8004Registry',
      });
    } catch (e) {
      if (e instanceof TxNotConfirmedError) {
        const reason = 'agent.update: receipt not read after sending';
        if (signed) {
          await this.client._queueAgentSigned(e.txHash, { wallet, agentId: Number(id) }, reason);
        } else {
          const agent: AgentSyncPayload = { wallet, agentId: Number(id), ...fields };
          if (agent.description === undefined) delete agent.description;
          await this.client.queueAgentSync(e.txHash, agent, reason);
        }
        throw e.withNote('The agent record (POST /api/agents) is queued too: client.flushPendingSyncs() posts both once the tx is mined.');
      }
      throw e;
    }
    const ev = this.expectEvent(tx, identityRegistryAbi, 'URIUpdated', registry, 'ERC8004Registry', ['uri']);
    const txSyncQueued = this.txSyncQueued(tx.hash);
    const registration = await this.recordAgent(tx.hash, wallet, id, fields);
    return { hash: tx.hash, agentId: id, uri: ev?.newURI ?? null, txSyncQueued, registration, applied: appliedFrom(wallet, registration, config), warnings: tx.warnings };
  }

  /**
   * Sync agent registration to the backend API (`client.api.registerAgent`).
   * Throws AuthRequiredError (before any request) when the client has neither an API key nor a session, ValidationError
   * for a `config` of the wrong types (the `register` rules), and BasisApiError on non-2xx.
   */
  async syncToApi(wallet: string, agentId: bigint, config?: AgentConfig): Promise<void> {
    checkAgentConfig(config);
    await this.client.api.registerAgent({
      wallet,
      agentId,
      name: config?.name || 'Basis Agent',
      description: config?.description || undefined,
    });
  }

  /**
   * Look up an agent by wallet address via the API (`client.api.getAgent`): `{ isAgent: false, agent: null }` when the
   * API has none. Errors (429, 5xx, network) are thrown.
   */
  async lookupFromApi(wallet: string): Promise<AgentLookup> {
    return this.client.api.getAgent(wallet);
  }

  /**
   * List all registered agents via the API (`client.api.getAgents`).
   */
  async listAgents(page: number = 1, limit: number = 20): Promise<AgentList> {
    return this.client.api.getAgents({ page, limit });
  }

  /** Owner of agent `agentId` (the registry's `ownerOf`; reverts `ERC721NonexistentToken` for an unknown id). */
  async ownerOf(agentId: bigint): Promise<Address> {
    return this.read<Address>('ownerOf', [toUint(agentId, 'agentId')]);
  }

  /**
   * True when `spender` may act for agent `agentId` (owner, approved, or operator): who may call `setAgentURI` /
   * `setMetadata`. `spender`: a 0x address (ValidationError('spender') otherwise, before the read).
   */
  async isAuthorizedOrOwner(spender: Address, agentId: bigint): Promise<boolean> {
    const s = toAddress(spender, 'spender');
    return this.read<boolean>('isAuthorizedOrOwner', [s, toUint(agentId, 'agentId')]);
  }

  /**
   * Get the tokenURI for a registered agent (on-chain). `agentId`: a whole number (`ValidationError('agentId')`).
   */
  async getAgentURI(agentId: bigint): Promise<string> {
    return this.read<string>('tokenURI', [toUint(agentId, 'agentId')]);
  }

  /**
   * Get the agent wallet of an agent ID (on-chain): the owner at registration, a wallet the owner declared later with
   * a signed `setAgentWallet`, zero for an unknown id. That wallet may sync the agent with BASIS too. `agentId`: a whole
   * number (`ValidationError('agentId')`).
   */
  async getAgentWallet(agentId: bigint): Promise<Address> {
    return this.read<Address>('getAgentWallet', [toUint(agentId, 'agentId')]);
  }

  /**
   * Get metadata for an agent by key (on-chain): the raw bytes as hex (`0x` when unset). `agentId`: a whole number
   * (`ValidationError('agentId')`); `key`: well-formed text (`ValidationError('metadataKey')`). Any value under the key
   * `basis` marks the agent as a BASIS one.
   */
  async getMetadata(agentId: bigint, key: string): Promise<Hex> {
    const id = toUint(agentId, 'agentId');
    if (typeof key !== 'string') throw new ValidationError('metadataKey', 'metadata key must be a string.');
    checkText(key, 'metadataKey');
    return this.read<Hex>('getMetadata', [id, key]);
  }

  /**
   * Update the agent's URI (on-chain). Owner or approved only (else the simulation reverts "Not authorized"). The
   * result adds `agentId` and `uri` from the `URIUpdated` event (null with a warning when missing). A readable
   * registration file without the BASIS mark adds a warning: unless the agent has the registry's `basis` metadata key,
   * the API would then refuse to (re-)record it. `update(agentId, config)` builds the URI and refreshes the API row too.
   * `newURI` with a lone surrogate (not text the chain can store as typed): ValidationError('newURI') before the tx.
   */
  async setAgentURI(agentId: bigint, newURI: string): Promise<TxResult & { agentId: bigint | null; uri: string | null }> {
    checkText(newURI, 'newURI');
    const registry = this.registryAddress;
    const tx = await this.send({
      address: registry, abi: identityRegistryAbi, functionName: 'setAgentURI', args: [toUint(agentId, 'agentId'), newURI],
      contract: 'ERC8004Registry',
    });
    const ev = this.expectEvent(tx, identityRegistryAbi, 'URIUpdated', registry, 'ERC8004Registry', ['agentId', 'uri']);
    if (!isBasisAgentUri(newURI) && !REMOTE_URI.test(String(newURI).trim())) {
      const msg = `agent ${agentId}: the new registration file carries no BASIS mark (protocol "basis" or a BASIS services entry), so unless the agent has `
        + `the registry's "basis" metadata key the BASIS API will refuse to record it (403 not_branded). Use update(agentId, config) to write a BASIS one, or setMetadata(agentId, 'basis', '1').`;
      tx.warnings.push(msg);
      console.warn(`[basis-sdk] ${msg}`);
    }
    return { ...tx, agentId: ev?.agentId ?? null, uri: ev?.newURI ?? null };
  }

  /**
   * Set on-chain metadata `key` of agent `agentId` (owner or approved). `value`: bytes as `Uint8Array` or a `0x` hex
   * string; any other string is stored as its UTF-8 bytes. The reserved key `agentWallet` is refused before the tx
   * (ValidationError `agentWalletReservedKey`): the registry sets it at registration and only a signed
   * `setAgentWallet` changes it. Any value under the key `basis` marks an agent registered elsewhere as a BASIS one.
   * A key or a text value with a lone surrogate is refused before the tx (`metadataKey` / `metadataValue`: "is not
   * valid UTF-8 text"). The result adds `agentId`, `key` and `value` (hex) from the `MetadataSet` event.
   */
  async setMetadata(agentId: bigint, key: string, value: Hex | Uint8Array | string): Promise<TxResult & { agentId: bigint | null; key: string | null; value: Hex | null }> {
    const id = toUint(agentId, 'agentId');
    if (typeof key !== 'string') throw new ValidationError('metadataKey', 'metadata key must be a string.');
    checkText(key, 'metadataKey');
    if (key === RESERVED_METADATA_KEY) {
      throw new ValidationError('agentWalletReservedKey',
        `"${RESERVED_METADATA_KEY}" is a reserved metadata key: the registry sets it to the owner at registration and only a signed setAgentWallet changes it. Nothing was sent.`);
    }
    let bytes: Hex;
    if (value instanceof Uint8Array) bytes = toHex(value);
    else if (typeof value === 'string') {
      const hex = isHex(value, { strict: true }) && value.length % 2 === 0;
      if (!hex) checkText(value, 'metadataValue');
      bytes = hex ? (value as Hex) : toHex(value);
    }
    else throw new ValidationError('metadataValue', 'metadata value must be bytes (Uint8Array or 0x hex) or a string.');
    const registry = this.registryAddress;
    const tx = await this.send({
      address: registry, abi: identityRegistryAbi, functionName: 'setMetadata', args: [id, key, bytes], contract: 'ERC8004Registry',
    });
    const ev = this.expectEvent(tx, identityRegistryAbi, 'MetadataSet', registry, 'ERC8004Registry', ['agentId', 'key', 'value']);
    return { ...tx, agentId: ev?.agentId ?? null, key: ev?.metadataKey ?? null, value: ev?.metadataValue ?? null };
  }
}
