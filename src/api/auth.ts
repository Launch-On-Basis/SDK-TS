import { ApiCore, AuthRequiredError, apiErrorFrom, hasSessionCookie, seg, withoutNulls, type ApiResponse } from './core';
import { checkKeys, isPlainOptions, optionKeys, optsOf } from '../core/opts';

/** Onboarding tour state of a wallet. */
export type OnboardingStatus = 'pending' | 'skipped' | 'completed';

export interface OnboardingState {
  status: OnboardingStatus;
  /** ISO time of the wallet's first sign-in. */
  firstSignInAt: string;
}

/**
 * `GET /api/auth/onboarding`: `{ signedIn: false }` when this session does not hold the wallet. `termsAccepted`: the
 * wallet (or the BASIS account it belongs to) accepted the current Terms of Service.
 */
export type OnboardingInfo = { signedIn: false } | (OnboardingSaved & { termsAccepted?: boolean });

/** `POST /api/auth/onboarding` answer. */
export type OnboardingSaved = { signedIn: true } & OnboardingState;

/**
 * SDK-added to answers that set the session cookie: the `name=value` pairs (`; `-joined) to send as `Cookie` from
 * now on; null when the answer set none, or only expired ones (the server cleared the session). Always null in browser
 * cookie mode: the browser keeps the cookie and never shows `Set-Cookie` to JavaScript.
 */
export type WithSessionCookie<T> = T & { sessionCookie: string | null };

/** `POST /api/auth/verify` answer. */
export interface SiweVerifyResult {
  ok: true;
  /** The signed-in wallet, lower-case. */
  address: string;
  /** null when the onboarding row could not be written (the sign-in still succeeds). */
  onboarding: OnboardingState | null;
}

/** SiweVerifyResult plus the session cookie the SDK read from `Set-Cookie`: it holds every wallet of the session. */
export type VerifyResult = WithSessionCookie<SiweVerifyResult>;

/**
 * `DELETE /api/auth/me` answer; `sessionCookie` is the reissued session (the remaining wallets under a new session id),
 * null after a whole-session logout.
 */
export type LogoutResult = WithSessionCookie<{ ok: true; message: string }>;

/** `GET /api/auth/twitter` answer; `sessionCookie` carries the PKCE verifier the OAuth callback needs. */
export type TwitterAuthUrl = WithSessionCookie<{ url: string }>;

/** `GET /api/auth/me` without `address`. */
export interface SessionSummary {
  isLoggedIn: false;
  /** Wallets in this session, lower-case. */
  addresses: string[];
}

/** `GET /api/auth/me?address=`: whether that wallet is signed in. */
export interface SessionStatus {
  isLoggedIn: boolean;
  address: string;
  allAddresses: string[];
}

export type SessionInfo = SessionSummary | SessionStatus;

/** An API key as listed (the full key is only returned at creation). */
export interface ApiKeyInfo {
  id: string;
  /** Masked hint, e.g. `bsk_****abcd`; null when the server cannot show one. */
  keyHint: string | null;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A freshly created API key: the only time the plain key is returned. */
export interface NewApiKey {
  id: string;
  /** `bsk_` prefixed key. */
  key: string;
  label: string | null;
  createdAt: string;
}

export interface TwitterChallenge {
  code: string;
  expiresAt: string;
  /** Seconds until expiry. */
  expiresIn: number;
  tweetTemplate: string;
}

export interface TwitterLinkResult {
  success: true;
  method: 'tweet-verification';
  username: string;
  displayName: string;
  tweetId: string;
}

export interface MySocial {
  platform: string;
  handle: string;
  url: string | null;
  isPublic: boolean;
}

export interface MyXAccount {
  username: string;
  displayName: string;
  profileImage: string;
  isPublic: boolean;
}

/** `GET /api/v1/me/profile`. tier, tierEmoji and rank are the wallet's final testing-phase standing: they never change. */
export interface MyProfile {
  wallet: string;
  username: string | null;
  avatarUrl: string | null;
  /** Null when the wallet was not on the testing-phase leaderboard. */
  tier: string | null;
  tierEmoji: string | null;
  /** 0 when the wallet was not on the testing-phase leaderboard. */
  rank: number;
  /** Always 0. */
  rankDelta: number;
  /** Always true: points were removed. */
  pointsStale: boolean;
  socials: MySocial[];
  xAccount: MyXAccount | null;
  /** Informational only; the server does not refresh on request. */
  stale: boolean;
  /** ISO time the testing-phase standings were recorded; null when the wallet was not on the leaderboard. */
  lastUpdated: string | null;
}

/** `UpdateProfilePayload.social`: links X; `handle` is the full X profile URL. */
export interface SocialLink {
  platform: 'x';
  handle: string;
}
const SOCIAL_LINK_KEYS = optionKeys<SocialLink>({ platform: true, handle: true });

/** Platforms `removeSocial` accepts. */
export type RemovableSocial = 'x' | 'discord' | 'telegram' | 'tiktok';

/**
 * `POST /api/v1/me/profile` body. One action per request; when several keys are set the server takes the first
 * in this order: username, social, removeSocial, avatar, toggleSocialPublic.
 */
export interface UpdateProfilePayload {
  /** 3-20 letters, digits or `_`. Usernames cannot be cleared. One rename every 7 days (429 `rename_cooldown`). */
  username?: string;
  social?: SocialLink;
  removeSocial?: RemovableSocial;
  toggleSocialPublic?: 'x';
  /**
   * The `cid` (or gateway `url`) `uploadImage` with purpose `avatar` returned to this same wallet; anything else
   * answers 400. null or '' = a random bundled BASIS avatar.
   */
  avatar?: string | null;
}
const UPDATE_PROFILE_KEYS = optionKeys<UpdateProfilePayload>({
  username: true, social: true, removeSocial: true, toggleSocialPublic: true, avatar: true,
});

export type ProfileAction =
  | 'username_set' | 'social_set' | 'social_removed' | 'avatar_set' | 'avatar_cleared' | 'social_toggled';

export interface UpdateProfileResult {
  success: boolean;
  action: ProfileAction;
  /** username_set. */
  username?: string;
  /** social_set, social_removed, social_toggled. */
  platform?: string;
  /** social_set: the stored handle. */
  handle?: string;
  /** avatar_set, avatar_cleared (bundled avatars use a relative path). */
  avatarUrl?: string;
  /** social_toggled. */
  isPublic?: boolean;
}

export type DailyCapPointCategory = 'trading' | 'prediction' | 'creator' | 'positions';
export type DailyCapCountCategory = 'social_x';

export interface DailyCapEntry<C extends string = string> {
  category: C;
  /** 0-100, rounded to 1 decimal. */
  percent: number;
}

export interface MyDailyCaps {
  /** Current UTC day, YYYY-MM-DD. */
  date: string;
  /** Seconds until the next 00:00 UTC reset. */
  resetsInSeconds: number;
  /** Always empty: points were removed. */
  pointCaps: DailyCapEntry<DailyCapPointCategory>[];
  /** Always empty: points were removed. */
  countCaps: DailyCapEntry<DailyCapCountCategory>[];
  /** Always true. */
  frozen?: boolean;
}

/** Social identities `unlinkSocial` accepts (a base platform also matches its `privy-` sibling). */
export type UnlinkablePlatform = 'twitter' | 'google' | 'discord' | 'github' | 'privy-google' | 'privy-twitter';

export interface UnlinkSocialResult {
  success: boolean;
  platform: UnlinkablePlatform;
  /** The handle that was unlinked. */
  username?: string;
  /** ISO time the handle can be linked again (7-day cooldown). */
  availableAt: string;
}

/** True when a Set-Cookie line deletes its cookie: `Max-Age` <= 0, or (without Max-Age) `Expires` in the past. */
function deletesCookie(setCookie: string): boolean {
  let maxAge: number | undefined;
  let expires: number | undefined;
  for (const attr of setCookie.split(';').slice(1)) {
    const i = attr.indexOf('=');
    const name = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const value = i < 0 ? '' : attr.slice(i + 1).trim();
    if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    if (name === 'expires' && Number.isFinite(Date.parse(value))) expires = Date.parse(value);
  }
  if (maxAge !== undefined) return maxAge <= 0;
  return expires !== undefined && expires <= Date.now();
}

/** The `name=value` pairs of a response's live Set-Cookie headers, `; `-joined; null when there are none. */
function sessionCookieOf(res: ApiResponse): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  const raw = setCookies.length ? setCookies : [headers.get('set-cookie')].filter((c): c is string => !!c);
  const pairs = raw.filter((c) => !deletesCookie(c)).map((c) => c.split(';')[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

/** Parses a JSON answer and adds its `sessionCookie`; non-2xx throws BasisApiError. */
function withSessionCookie<T>(res: ApiResponse, what: string): WithSessionCookie<T> {
  if (!res.ok) throw apiErrorFrom(res, what);
  return { ...(JSON.parse(res.text) as T), sessionCookie: sessionCookieOf(res) };
}

/** The wallet a SIWE message signs in (its second line), lower-case; null when it has none. */
function siweAddressOf(message: string): string | null {
  const line = String(message).split('\n')[1]?.trim() ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(line) ? line.toLowerCase() : null;
}

export class AuthApi extends ApiCore {
  /** GET /api/auth/nonce: a SIWE nonce for `address` (5 minutes, single use; an opaque string). Public. */
  async getNonce(address: string): Promise<{ nonce: string }> {
    return this.request('GET', '/api/auth/nonce', { query: { address } });
  }

  /**
   * POST /api/auth/verify: verifies a signed SIWE message and adds the wallet to the session (24 h). Public; sends
   * the session cookie (not the key) when there is one, so the session keeps its other wallets, as in a browser.
   * Returns the answer plus `sessionCookie`. The client keeps it (`client.sessionCookie`, explicit mode) and records
   * the signed-in wallet as the session's confirmed wallet (`client.sessionWallets`): session requests then go out
   * for that wallet only. Browser cookie mode: sent with `credentials: 'include'`, so the browser stores the session
   * cookie itself (`sessionCookie` is null). The message must name the site (`domain` its host, `uri` its origin) and the
   * deployment's chain: 422 `domain_mismatch` / `wrong_chain` otherwise, `invalid_nonce` for a used or old nonce.
   */
  async verify(message: string, signature: string): Promise<VerifyResult> {
    const res = await this.send('POST', '/api/auth/verify', { body: { message, signature }, includeSession: true });
    const out = withSessionCookie<SiweVerifyResult>(res, 'POST /api/auth/verify');
    const wallet = typeof out.address === 'string' && out.address ? out.address : siweAddressOf(message);
    const browser = this.client.cookieMode === 'browser';
    this.client._noteSession?.({
      ...(!browser && out.sessionCookie ? { cookie: out.sessionCookie } : {}),
      wallets: wallet ? [wallet] : [],
    });
    return out;
  }

  /**
   * GET /api/auth/me: this session's wallets; with `address`, whether that wallet is signed in.
   * Public; sends the session cookie when there is one, whichever wallet it holds (browser cookie mode: always the
   * browser's cookies). The client records the answer's wallets as the session's (`client.sessionWallets`).
   */
  getMe(): Promise<SessionSummary>;
  getMe(address: string): Promise<SessionStatus>;
  getMe(address?: string): Promise<SessionInfo>;
  async getMe(address?: string): Promise<SessionInfo> {
    const info = await this.request<SessionInfo>('GET', '/api/auth/me', { auth: 'optional', query: { address }, includeSession: true });
    const wallets = info && typeof info === 'object'
      ? ('allAddresses' in info ? info.allAddresses : (info as SessionSummary).addresses)
      : undefined;
    if (Array.isArray(wallets)) this.client._noteSession?.({ wallets: wallets.filter((w) => typeof w === 'string') });
    return info;
  }

  /**
   * DELETE /api/auth/me: signs `address` out of the session, or the whole session without one. Session (any wallet of
   * it: no signer check, signing out never acts for a wallet). The server revokes the old cookie's session id and
   * reissues the remaining wallets under a new one (or clears the cookie): the client keeps the answer's
   * `sessionCookie` (null = none left) and drops `address` (or every wallet) from `client.sessionWallets`.
   * Browser cookie mode: always sent with the browser's cookies (no AuthRequiredError: the browser may hold a session the
   * SDK does not know of; the server answers 401 when it has none); the browser applies the new cookie itself.
   */
  async logout(address?: string): Promise<LogoutResult> {
    const browser = this.client.cookieMode === 'browser';
    if (!browser && !hasSessionCookie(this.client.sessionCookie)) {
      throw new AuthRequiredError('session', 'DELETE /api/auth/me');
    }
    const res = await this.send('DELETE', '/api/auth/me', { query: { address }, includeSession: true });
    const out = withSessionCookie<{ ok: true; message: string }>(res, 'DELETE /api/auth/me');
    this.client._noteSession?.({
      ...(browser ? {} : { cookie: out.sessionCookie }),
      ...(address ? { remove: address } : { wallets: [] }),
    });
    return out;
  }

  /**
   * GET /api/auth/onboarding: onboarding state of `address` (created on first call); `{ signedIn: false }` when
   * this session does not hold the wallet. Public; sends the session cookie when there is one.
   */
  async getOnboarding(address: string): Promise<OnboardingInfo> {
    return this.request('GET', '/api/auth/onboarding', { auth: 'optionalSession', query: { address } });
  }

  /** POST /api/auth/onboarding: records that `address` skipped or completed the tour. Session holding the wallet. */
  async setOnboarding(
    address: string,
    status: 'skipped' | 'completed',
  ): Promise<OnboardingSaved> {
    return this.request('POST', '/api/auth/onboarding', { auth: 'session', body: { address, status } });
  }

  /**
   * POST /api/v1/auth/keys: creates an API key (one active per wallet); the only answer with the plain key. `label`
   * null is absent, as None in PY. Session.
   */
  async createApiKey(label?: string): Promise<NewApiKey> {
    return this.request('POST', '/api/v1/auth/keys', { auth: 'session', body: label == null ? {} : { label } });
  }

  /** GET /api/v1/auth/keys: the session wallet's active keys (masked `keyHint`, never the key). Session. */
  async listApiKeys(): Promise<{ keys: ApiKeyInfo[] }> {
    return this.request('GET', '/api/v1/auth/keys', { auth: 'session' });
  }

  /** DELETE /api/v1/auth/keys/{id}: deletes an API key (invalid at once). Session. */
  async deleteApiKey(id: string): Promise<{ ok: boolean; message: string }> {
    return this.request('DELETE', `/api/v1/auth/keys/${seg(id)}`, { auth: 'session' });
  }

  /**
   * GET /api/auth/twitter (with `Accept: application/json`): the X OAuth authorization URL for `wallet` (default: the
   * signer), sent as `X-Wallet-Address`; it must be in the session (403 `forbidden` otherwise). Session. The URL only
   * completes in a browser holding the returned `sessionCookie` (it carries the PKCE verifier); SDK and agent callers
   * link X with requestTwitterChallenge + verifyTwitter.
   */
  async getTwitterAuthUrl(wallet?: string): Promise<TwitterAuthUrl> {
    const res = await this.send('GET', '/api/auth/twitter', {
      auth: 'session', headers: { Accept: 'application/json', ...(wallet ? { 'X-Wallet-Address': wallet } : {}) },
    });
    return withSessionCookie(res, 'GET /api/auth/twitter');
  }

  /** POST /api/auth/twitter/challenge: a short-lived code to tweet, then pass the tweet to verifyTwitter. Key or session. */
  async requestTwitterChallenge(): Promise<TwitterChallenge> {
    return this.request('POST', '/api/auth/twitter/challenge', { auth: 'keyOrSession' });
  }

  /** POST /api/auth/twitter/verify-tweet: verifies a public tweet with the challenge code and links the X account. Key or session. */
  async verifyTwitter(tweetUrl: string): Promise<TwitterLinkResult> {
    return this.request('POST', '/api/auth/twitter/verify-tweet', { auth: 'keyOrSession', body: { tweetUrl } });
  }

  /** GET /api/v1/me/profile: the wallet's full profile, private socials included. Key or session. */
  async getMyProfile(): Promise<MyProfile> {
    return this.request('GET', '/api/v1/me/profile', { auth: 'keyOrSession' });
  }

  /**
   * POST /api/v1/me/profile: one profile action per call (see UpdateProfilePayload). A null field is absent (left out
   * of the body, as None in PY), except `avatar`, where null is a value (a random bundled avatar): so
   * `{ username: null, avatar: url }` sets the avatar. `payload` not an object, or a key it does not have (also inside
   * `social`: platform, handle): ValidationError('options' / 'social') before any request. Key or session.
   */
  async updateMyProfile(payload: UpdateProfilePayload): Promise<UpdateProfileResult> {
    const p = optsOf(payload, UPDATE_PROFILE_KEYS);
    if (isPlainOptions(p.social)) checkKeys<SocialLink>(p.social as SocialLink, SOCIAL_LINK_KEYS, 'social');
    const body: Record<string, unknown> = { ...withoutNulls(p) };
    if (p.avatar === null) body.avatar = null;
    return this.request('POST', '/api/v1/me/profile', { auth: 'keyOrSession', body });
  }

  /** GET /api/v1/me/daily-caps: kept for old clients: points were removed, so both lists are empty. Key or session. */
  async getMyDailyCaps(): Promise<MyDailyCaps> {
    return this.request('GET', '/api/v1/me/daily-caps', { auth: 'keyOrSession' });
  }

  /**
   * POST /api/v1/me/socials/unlink: unlinks an OAuth-verified social; the handle then has a 7-day cooldown.
   * No undo. Key or session.
   */
  async unlinkSocial(platform: UnlinkablePlatform): Promise<UnlinkSocialResult> {
    return this.request('POST', '/api/v1/me/socials/unlink', { auth: 'keyOrSession', body: { platform } });
  }
}
