import { BasisError, ValidationError } from '../core/errors';
import type { AgentApplied } from '../core/sync';
import { loadImageResizer } from '../platform/node';
import { ApiCore, BasisApiError, credentialsFor, seg, withoutNulls } from './core';
import { optionKeys, optsOf } from '../core/opts';
import type { Pagination } from './types';

/** `purpose` of an image upload: `token` (needs the token/market address, caller must be its creator) or `avatar` (5 a month). */
export type ImagePurpose = 'token' | 'avatar';

/** Body of POST /api/metadata. The server reads name, symbol and creator from the chain. */
export interface MetadataPayload {
  address: string;
  /** At most 5000 characters. */
  description?: string;
  /** website / telegram / twitterx / image: at most 191 characters each. */
  website?: string;
  telegram?: string;
  twitterx?: string;
  /** Hosted URL from uploadImage. */
  image?: string;
  /**
   * A prediction market's outcome pictures from the site's built-in picture library: `{ <outcome name>: <picture id> }`.
   * The API matches each name to the market's outcomes on chain, keeps one picture per market and ignores unknown ids
   * (and the field on a token).
   */
  outcomeArt?: Record<string, string>;
}
const METADATA_PAYLOAD_KEYS = optionKeys<MetadataPayload>({
  address: true, description: true, website: true, telegram: true, twitterx: true, image: true, outcomeArt: true,
});

/** POST /api/metadata answer: the pinned metadata JSON. */
export interface MetadataResult {
  url: string;
  cid: string;
}

/** Fields of POST /api/projects/{address}; at least one (or an image) is required. */
export interface ProjectUpdatePayload {
  website?: string;
  telegram?: string;
  twitterx?: string;
  description?: string;
}
const PROJECT_UPDATE_KEYS = optionKeys<ProjectUpdatePayload>({ website: true, telegram: true, twitterx: true, description: true });

/** POST /api/projects/{address} answer: `project` is the stored project row. */
export interface ProjectUpdateResult {
  success: boolean;
  project: Record<string, unknown>;
}

/** A stored comment row (POST /api/comments answer). Times are ISO strings. */
export interface CommentRow {
  id: number;
  projectId: number;
  /** Lower-case address. */
  author: string;
  /** The author's username, null when the wallet has none. */
  authorName?: string | null;
  content: string;
  isHidden: boolean;
  tradeType: string | null;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** DELETE /api/comments answer. */
export interface DeleteCommentResult {
  ok: true;
  message?: string;
}

/** A registered ERC-8004 agent (spec `Agent`). */
export interface Agent {
  /** Lower-case address. */
  wallet: string;
  /** ERC-8004 token id. */
  agentId: number;
  /** null only on rows registered before the default name existed. */
  name: string | null;
  description: string | null;
  /** ISO time. */
  createdAt: string;
}

/** GET /api/agents answer (page-based: `pagination.page` / `total`). */
export interface AgentList {
  data: Agent[];
  pagination: Pagination;
}

/** GET /api/agents/{address} answer. */
export interface AgentLookup {
  isAgent: boolean;
  agent: Agent | null;
}

/** Body of POST /api/agents. */
export interface RegisterAgentParams {
  /** The authenticated wallet; left out (or null), the API takes the authenticated wallet. */
  wallet?: string;
  /** ERC-8004 token id the wallet owns or is the agent wallet of, 0..2147483647. */
  agentId: number | bigint;
  /**
   * At most 100 characters (the real site's default "Basis Agent"). The paper site takes the name, description and
   * capabilities from the registration file instead.
   */
  name?: string;
  /** At most 500 characters. */
  description?: string;
  /** Free text; the agent's tokenURI `capabilities` wins when present. */
  capabilities?: string;
}
const REGISTER_AGENT_KEYS = optionKeys<RegisterAgentParams>({ wallet: true, agentId: true, name: true, description: true, capabilities: true });

/** `POST /api/agents` without a sign-in: the agent wallet's signed sync message (`buildAgentSyncMessage`). */
export interface SignedAgentSyncParams {
  /** ERC-8004 token id, 0..2147483647; must match the message's `Agent:` line. */
  agentId: number | bigint;
  /** The exact text that was signed. */
  message: string;
  /** The agent wallet's EIP-191 signature of `message` (ERC-1271 for a contract wallet). */
  signature: string;
}
const SIGNED_AGENT_SYNC_KEYS = optionKeys<SignedAgentSyncParams>({ agentId: true, message: true, signature: true });

/** What an agent sync applied to the wallet's profile: defined with the sync engine, which reads it off the answer. */
export type { AgentApplied } from '../core/sync';

/** POST /api/agents answer (201). */
export interface AgentRegistration {
  success: boolean;
  agent: Agent;
  /** The paper site: what the sync applied to the profile (the username and photo, never over ones the wallet chose). */
  applied?: AgentApplied;
}

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';
export type BugCategory = 'sdk' | 'contracts' | 'api' | 'frontend' | 'docs';
export type BugStatus = 'pending' | 'verified' | 'duplicate' | 'invalid';

/** Body of POST /api/v1/bugs/reports. */
export interface BugReportInput {
  /** At most 191 characters. */
  title: string;
  /** At most 5000 characters. */
  description: string;
  severity: BugSeverity;
  category: BugCategory;
  /** HTTPS URL or tx hash (0x + 64 hex), at most 1000 characters. */
  evidence?: string;
}
const BUG_REPORT_INPUT_KEYS = optionKeys<BugReportInput>({ title: true, description: true, severity: true, category: true, evidence: true });

/** POST /api/v1/bugs/reports answer (201). */
export interface BugReportSubmission {
  success: boolean;
  report: { id: number; title: string; severity: BugSeverity; category: BugCategory; status: BugStatus; createdAt: string };
}

/** One of your bug reports. Times are ISO strings. */
export interface BugReport {
  id: number;
  wallet: string;
  title: string;
  description: string;
  severity: BugSeverity;
  category: BugCategory;
  evidence: string | null;
  status: BugStatus;
  /** A note from BASIS on the report, if any. */
  adminNote: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

/** GET /api/v1/bugs/reports answer (page-based). */
export interface BugReportList {
  data: BugReport[];
  pagination: Pagination;
}

/** Options of the page-based content lists (`offset` is an alternative to `page`, rounded down to a page start). */
export interface ContentPageOptions {
  page?: number;
  /** 1..100 (server default 20). */
  limit?: number;
  offset?: number;
}
const CONTENT_PAGE_KEYS = optionKeys<ContentPageOptions>({ page: true, limit: true, offset: true });

/** Options of `getBugReports`: a page, and the reports' status. */
export interface BugReportsQuery extends ContentPageOptions {
  status?: BugStatus;
}
const BUG_REPORTS_KEYS = optionKeys<BugReportsQuery>({ page: true, limit: true, offset: true, status: true });

/**
 * An error `setAvatar` threw after its upload went through (setting it on the profile failed): `avatarUrl` is the hosted
 * avatar, to set with `updateMyProfile({ avatar: e.avatarUrl })` without another upload (PY: `e.avatar_url`).
 */
export type ErrorWithAvatarUrl = Error & { avatarUrl: string };

/** POST /api/images size limit: 5 MB. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** POST /api/metadata field limits, in characters (the server answers 400 `bad_body` above them). */
export const METADATA_MAX_LENGTH = { description: 5000, website: 191, telegram: 191, twitterx: 191, image: 191 } as const;

/**
 * The image type from the leading bytes, by the server's rules: the 8-byte PNG signature, JPEG FF D8 FF, `RIFF....WEBP`,
 * GIF87a or GIF89a. Undefined for anything else (an empty file too).
 */
export function sniffImage(b: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  return undefined;
}

/**
 * The bytes as a Blob typed from their leading bytes (sniffImage). The server judges an upload by its bytes alone,
 * whatever its declared type or name, so an empty file, one over 5 MB, or bytes that are not png, jpeg, webp or gif
 * throw ValidationError('image') before any request.
 */
async function imageBlob(file: Blob | Uint8Array, filename: string): Promise<Blob> {
  const isBlob = file instanceof Blob;
  const size = isBlob ? file.size : file.byteLength;
  if (size === 0) throw new ValidationError('image', `image "${filename}" is empty`);
  if (size > IMAGE_MAX_BYTES) throw new ValidationError('image', `image "${filename}" is ${size} bytes; the API takes at most 5 MB (${IMAGE_MAX_BYTES} bytes)`);
  const head = isBlob ? new Uint8Array(await file.slice(0, 12).arrayBuffer()) : file.subarray(0, 12);
  const mime = sniffImage(head);
  if (!mime) throw new ValidationError('image', `cannot tell the image type of "${filename}" from its bytes: use jpeg, png, webp or gif`);
  if (isBlob) return file.type === mime ? file : new Blob([file], { type: mime });
  return new Blob([new Uint8Array(file)], { type: mime });
}

/** An http(s) URL with a host: the one input downloadImage takes (no data:, file: or other schemes). Same in PY. */
const IMAGE_URL = /^https?:\/\/[^\s/?#]+/i;

/**
 * downloadImage reads at most this many bytes of a file (20 MB): a larger one is refused from its Content-Length, or
 * while it downloads, before the rest is read. Same in PY.
 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** ValidationError('image') for a download over DOWNLOAD_MAX_BYTES. Same text in PY. */
const downloadTooLarge = (url: string) => new ValidationError(
  'image', `the file at ${url} is larger than 20 MB (${DOWNLOAD_MAX_BYTES} bytes): downloadImage reads at most that much.`,
);

/**
 * GET `url` with a deadline covering the whole answer and the caller's AbortSignal (as fetchWithDeadline), reading the
 * body as a stream and stopping at `maxBytes`: a Content-Length above it, or more bytes than that, throws
 * downloadTooLarge before the rest is read. A non-2xx answer comes back with an empty body (not read). Past the
 * deadline: BasisApiError(0, 'timeout'); signal aborted: BasisApiError(0, 'aborted'); network errors as fetch throws
 * them.
 */
async function fetchImageCapped(
  url: string, init: RequestInit, deadline: { timeoutMs: number; signal?: AbortSignal; what: string }, maxBytes: number,
): Promise<{ res: Response; body: Uint8Array }> {
  const { timeoutMs, signal, what } = deadline;
  const aborted = () => new BasisApiError(0, 'aborted', `${what} was aborted by the caller`, null);
  if (signal?.aborted) throw aborted();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const drop = (res: Response) => res.body?.cancel().catch(() => undefined);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      await drop(res);
      return { res, body: new Uint8Array(0) };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drop(res);
      throw downloadTooLarge(url);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw downloadTooLarge(url);
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { body.set(c, at); at += c.byteLength; }
    return { res, body };
  } catch (e) {
    if (e instanceof ValidationError) throw e;
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

/** `imageUrl` when it is an http(s) URL with a host; ValidationError('imageUrl') otherwise, before any download. */
function checkImageUrl(imageUrl: unknown): string {
  if (typeof imageUrl !== 'string' || !IMAGE_URL.test(imageUrl)) {
    const got = typeof imageUrl === 'string'
      ? `'${imageUrl.length > 80 ? `${imageUrl.slice(0, 80)}...` : imageUrl}'`
      : typeof imageUrl;
    throw new ValidationError('imageUrl', `imageUrl must be an http(s) URL of an image, got ${got}.`);
  }
  return imageUrl;
}

const MAX_AGENT_ID = 2147483647;

/** An agentId as the API takes it (a number 0..2147483647); ValidationError('agentId') otherwise. */
function agentIdNumber(raw: unknown): number {
  const id = typeof raw === 'bigint' ? Number(raw) : raw;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > MAX_AGENT_ID
      || (typeof raw === 'bigint' && BigInt(id) !== raw)) {
    const got = typeof raw === 'bigint' ? String(raw) : JSON.stringify(raw) ?? String(raw);
    throw new ValidationError('agentId', `agentId must be an integer 0..${MAX_AGENT_ID} (got ${got})`);
  }
  return id;
}

export class ContentApi extends ApiCore {
  /**
   * POST /api/images (multipart `file`, `purpose`, `address`): pins an image (jpeg, png, webp, gif; max 5 MB).
   * The part's type is taken from the bytes (see imageBlob); `filename` only names the part. Returns the hosted URL. `purpose` "token" needs the token/market `address` and the caller must be its creator;
   * "avatar" is capped at 5 a month. `filename` / `purpose` null take their defaults (as None in PY). Auth: key or session.
   */
  async uploadImage(
    file: Blob | Uint8Array,
    filename: string = 'image.png',
    purpose: ImagePurpose = 'token',
    address?: string,
  ): Promise<string> {
    filename ??= 'image.png';
    purpose ??= 'token';
    if (purpose === 'token' && !address) throw new ValidationError('address', 'address is required when purpose is "token"');
    const form = new FormData();
    form.append('file', await imageBlob(file, filename), filename);
    form.append('purpose', purpose);
    if (purpose === 'token') form.append('address', address!);
    const json = await this.request<{ url: string; cid: string }>('POST', '/api/images', { auth: 'keyOrSession', form, kind: 'upload' });
    return json.url;
  }

  /**
   * Downloads an image from an http(s) URL, turns it upright, resizes it to 512x512 (center-crop), converts it to WebP
   * and uploads it with uploadImage (Node: needs the optional `sharp` package; browser build: the canvas; the URL and
   * byte rules: see downloadImage). Returns the hosted URL. Missing credentials throw AuthRequiredError before the
   * download; a failed download throws BasisError (past the upload deadline, apiUploadTimeoutMs: BasisApiError code
   * `timeout`). `purpose` null is `token`, the default (as None in PY). Auth: key or session.
   */
  async uploadImageFromUrl(
    imageUrl: string,
    contractAddress?: string,
    purpose: ImagePurpose = 'token',
  ): Promise<string> {
    purpose ??= 'token';
    if (purpose === 'token' && !contractAddress) throw new ValidationError('address', 'address is required when purpose is "token"');
    this.checkUploadAuth();
    const webpBuffer = await this.downloadImage(imageUrl);
    const filename = contractAddress ? `${contractAddress}.webp` : `image_${Date.now()}.webp`;
    return this.uploadImage(webpBuffer, filename, purpose, contractAddress);
  }

  /**
   * Throws AuthRequiredError unless the client has an API key or a SIWE session (what the upload routes need).
   * Sends nothing: lets a caller check before a step that cannot be undone (factory.createTokenWithMetadata).
   */
  checkUploadAuth(): void {
    this.authHeaders('keyOrSession', 'POST /api/images');
  }

  /**
   * Downloads an image from a URL and returns it upright (EXIF orientation applied), resized to 512x512 (center-crop)
   * as WebP bytes, the form uploadImageFromUrl sends. `imageUrl`: an http(s) URL only (anything else, a data: URL
   * too, throws ValidationError('imageUrl') before any download). Node: needs the optional `sharp` package (checked
   * before the download: BasisError when missing). Browser build: resized with the canvas (OffscreenCanvas, else a
   * <canvas>; PNG where the browser cannot encode WebP, e.g. Safari), and the image host must allow the page's origin
   * (CORS). No API call and no credentials needed. A failed download (non-2xx, network) throws BasisError; past the
   * upload deadline (apiUploadTimeoutMs, body included) BasisApiError code `timeout`, a BasisError too; a file over
   * 20 MB (by its Content-Length, or counted while it streams in: the rest is not read) throws
   * ValidationError('image'); downloaded bytes that are not png, jpeg, webp or gif (by their leading bytes, as the API
   * judges an upload: so no SVG) throw ValidationError('image'); bytes that cannot be decoded throw.
   */
  async downloadImage(imageUrl: string): Promise<Uint8Array> {
    const url = checkImageUrl(imageUrl);
    const resize = await loadImageResizer();
    let response: Response;
    let bytes: Uint8Array;
    try {
      ({ res: response, body: bytes } = await fetchImageCapped(url, credentialsFor(this.client, false), {
        timeoutMs: this.timeoutFor({ kind: 'upload' }), signal: this.signalFor(), what: `GET ${url}`,
      }, DOWNLOAD_MAX_BYTES));
    } catch (e: any) {
      if (e instanceof BasisApiError || e instanceof ValidationError) throw e;
      throw new BasisError(`Failed to download image from ${url}: ${e?.message ?? e}`);
    }
    if (!response.ok) {
      throw new BasisError(`Failed to download image from ${url}: ${response.status}`);
    }
    if (!sniffImage(bytes.subarray(0, 12))) {
      throw new ValidationError('image', `the file at ${url} is not a png, jpeg, webp or gif image (judged by its bytes, as the API judges an upload)`);
    }
    return resize(bytes, 512, 90);
  }

  /**
   * Uploads an avatar (POST /api/images, purpose "avatar") and sets it on the profile (POST /api/v1/me/profile
   * `{avatar}`). `source`: an http(s) image URL (downloaded and resized, see uploadImageFromUrl) or the bytes;
   * there is no file-path input (PY also takes a path), so any other string throws before any request.
   * Returns the hosted avatar URL. When the upload went through but setting it on the profile failed, the error
   * carries the hosted URL as `avatarUrl` (`ErrorWithAvatarUrl`): finish with `updateMyProfile({ avatar: e.avatarUrl })`
   * instead of uploading again (avatar uploads are capped at 5 a month). Auth: key or session.
   */
  async setAvatar(
    source: string | Blob | Uint8Array,
    filename: string = 'avatar.webp',
  ): Promise<string> {
    if (typeof source === 'string' && !/^https?:\/\//i.test(source)) {
      throw new ValidationError('image', 'setAvatar: a string source must be an http(s) image URL (pass the bytes for a local file)');
    }
    filename ??= 'avatar.webp';
    const url = typeof source === 'string'
      ? await this.uploadImageFromUrl(source, undefined, 'avatar')
      : await this.uploadImage(source, filename, 'avatar');
    try {
      await this.request('POST', '/api/v1/me/profile', { auth: 'keyOrSession', body: { avatar: url } });
    } catch (e) {
      if (e instanceof Error) Object.defineProperty(e, 'avatarUrl', { value: url, enumerable: true, configurable: true, writable: true });
      throw e;
    }
    return url;
  }

  /**
   * POST /api/metadata: pins the metadata of a new token or market (caller must be its creator). `outcomeArt` (a
   * market's outcome pictures, `{ <outcome name>: <picture id> }`) must be a plain object of strings (a Map, a Date or
   * a class instance shows no entries and would send {}, losing the pictures for good), else
   * ValidationError('outcomeArt') before sending. A null field is absent (left out of the body, as None in PY).
   * One-shot: a second call answers 409 (BasisApiError code `exists`); later changes go through updateProject. Auth:
   * key or session.
   */
  async updateMetadata(payload: MetadataPayload): Promise<MetadataResult> {
    const body = withoutNulls(optsOf(payload, METADATA_PAYLOAD_KEYS));
    const art: unknown = body.outcomeArt;
    if (art !== undefined && (typeof art !== 'object' || art === null || Array.isArray(art)
        || (Object.getPrototypeOf(art) !== Object.prototype && Object.getPrototypeOf(art) !== null)
        || Object.values(art).some((v) => typeof v !== 'string'))) {
      throw new ValidationError('outcomeArt', 'outcomeArt must be an object of { <outcome name>: <picture id> } strings.');
    }
    return this.request('POST', '/api/metadata', { auth: 'keyOrSession', body, kind: 'upload' });
  }

  /**
   * POST /api/projects/{address}: updates a project's links / description (caller must be its developer).
   * With `image` (bytes or Blob) it is sent as multipart with the new image; otherwise as JSON.
   * Returns the updated project row. A null field (or a null `payload`, `imageFilename`) is absent, as None in PY. Auth:
   * key or session.
   */
  async updateProject(
    address: string,
    payload: ProjectUpdatePayload,
    image?: Blob | Uint8Array,
    imageFilename: string = 'image.png',
  ): Promise<ProjectUpdateResult> {
    imageFilename ??= 'image.png';
    const fields = Object.entries(withoutNulls(optsOf(payload, PROJECT_UPDATE_KEYS))) as [string, string][];
    if (fields.length === 0 && !image) throw new ValidationError('payload', 'updateProject needs at least one field or an image');
    const path = `/api/projects/${seg(address)}`;
    if (!image) return this.request('POST', path, { auth: 'keyOrSession', body: Object.fromEntries(fields) });

    const form = new FormData();
    for (const [k, v] of fields) form.append(k, String(v));
    form.append('image', await imageBlob(image, imageFilename), imageFilename);
    return this.request('POST', path, { auth: 'keyOrSession', form, kind: 'upload' });
  }

  /**
   * POST /api/comments: posts a comment (at most 2000 characters) as `authorAddress`, which must be the signed-in
   * wallet. One qualifying trade unlocks commenting for good: a buy of at least $25 in one trade on a token, a bet of
   * at least $5 on a market (the project's creator always may; else 403 `not_eligible`); then one comment per 30 s
   * (429 `cooldown`). Returns the stored row. Auth: key or session.
   */
  async createComment(projectId: number, content: string, authorAddress: string): Promise<CommentRow> {
    return this.request('POST', '/api/comments', { auth: 'keyOrSession', body: { projectId, content, authorAddress } });
  }

  /**
   * DELETE /api/comments: soft-deletes your own comment. `authorAddress` is optional: left out, the server uses the
   * authenticated wallet (the real site still asks for it). Auth: key or session.
   */
  async deleteComment(commentId: number, authorAddress?: string): Promise<DeleteCommentResult> {
    return this.request('DELETE', '/api/comments', { auth: 'keyOrSession', query: { id: commentId, authorAddress } });
  }

  /** GET /api/agents: registered agents, newest first. Page-based. Public. */
  async getAgents(options: ContentPageOptions = {}): Promise<AgentList> {
    return this.request('GET', '/api/agents', { query: { ...optsOf(options, CONTENT_PAGE_KEYS) } });
  }

  /** GET /api/agents/{address}: the agent registered for a wallet (`{isAgent: false, agent: null}` when none). Public. */
  async getAgent(address: string): Promise<AgentLookup> {
    return this.request('GET', `/api/agents/${seg(address)}`);
  }

  /**
   * POST /api/agents: records an on-chain ERC-8004 registration. The wallet must own `agentId` or be its declared agent
   * wallet, and the agent must carry the BASIS mark (`protocol: "basis"` or a BASIS services entry in its registration
   * file, or the registry's `basis` metadata key; the real site still asks for a base64 data URI with protocol
   * "basis"). 403 `wallet_in_account` for a wallet of a person's BASIS account (an agent needs its own), `forbidden`,
   * `not_branded`; 409 when the id is synced to another wallet that still controls it. `wallet` is optional: left out
   * (or null), the API takes the authenticated wallet; given, it must be that wallet (else 403 `forbidden`). `agentId`:
   * a whole number (or bigint) 0..2147483647; anything else (a string, boolean, null, a fraction) throws
   * ValidationError('agentId') before sending. `wallet`, `name`, `description`, `capabilities` null are absent (left
   * out of the body, as None in PY). Auth: key or session.
   */
  async registerAgent(params: RegisterAgentParams): Promise<AgentRegistration> {
    const p = optsOf(params, REGISTER_AGENT_KEYS);
    const id = agentIdNumber(p.agentId);
    return this.request('POST', '/api/agents', { auth: 'keyOrSession', body: { ...withoutNulls(p), agentId: id } });
  }

  /**
   * POST /api/agents with a signed message instead of a sign-in: the FIRST sync of an agent wallet, which cannot sign
   * in before it is an agent (a wallet signs in only when it is linked to a BASIS account or is a registered agent).
   * `message` is `buildAgentSyncMessage(...)` signed by the agent wallet; signing it accepts the BASIS Terms. 401
   * `invalid_signature` names the line that is wrong; 403 `not_branded` / `wallet_in_account` / `forbidden` as for
   * `registerAgent`. 30 signed syncs an hour per IP (and 10 agent syncs an hour per wallet). The paper site takes it;
   * the real site does not yet. No auth, sent once (no retries). `client.agent.syncSigned(agentId)` builds and signs it.
   */
  async registerAgentSigned(params: SignedAgentSyncParams): Promise<AgentRegistration> {
    const p = optsOf(params, SIGNED_AGENT_SYNC_KEYS);
    const id = agentIdNumber(p.agentId);
    if (typeof p.message !== 'string' || typeof p.signature !== 'string') {
      throw new ValidationError('agentSignedSync', 'registerAgentSigned needs the signed message and its signature.');
    }
    return this.request('POST', '/api/agents', { auth: 'none', body: { agentId: id, message: p.message, signature: p.signature } });
  }

  /**
   * POST /api/v1/bugs/reports: submits a bug report (5 a day per wallet; 409 `duplicate` for a near-copy,
   * 403 `blocked`). `evidence` null is absent (left out of the body, as None in PY). Auth: key or session.
   */
  async submitBugReport(report: BugReportInput): Promise<BugReportSubmission> {
    return this.request('POST', '/api/v1/bugs/reports', { auth: 'keyOrSession', body: withoutNulls(optsOf(report, BUG_REPORT_INPUT_KEYS)) });
  }

  /** GET /api/v1/bugs/reports: your bug reports. Page-based. Auth: key or session. */
  async getBugReports(options: BugReportsQuery = {}): Promise<BugReportList> {
    return this.request('GET', '/api/v1/bugs/reports', { auth: 'keyOrSession', query: { ...optsOf(options, BUG_REPORTS_KEYS) } });
  }
}
