import { ApiCore } from './core';
import { AuthApi } from './auth';
import { ContentApi } from './content';
import { TokensApi } from './tokens';
import { MarketsApi } from './markets';
import { CreditApi } from './credit';
import { WalletApi } from './wallet';
import { UpDownApi } from './updown';
import { DiscoveryApi } from './discovery';
import { SocialApi } from './social';
import { SyncApi } from './sync';

export {
  ApiCore, BasisApiError, AuthRequiredError, DEFAULT_API_TIMEOUT_MS, DEFAULT_API_UPLOAD_TIMEOUT_MS, DEFAULT_API_AI_TIMEOUT_MS,
  detectCookieMode, DEV_SESSION_COOKIE_NAME, MAX_TIMEOUT_MS, SESSION_COOKIE_NAME,
} from './core';
export type {
  AuthMode, ApiHost, CookieMode, ApiResponse, CallOptions, Query, QueryValue, RequestKind, RequestOptions, CursorPageLike,
  NumberedPageLike, OffsetPageLike, RateLimitInfo, SessionUpdate,
} from './core';
export * from './types';
export * from './auth';
export * from './content';
export * from './tokens';
export * from './markets';
export * from './credit';
export * from './wallet';
export * from './updown';
export * from './discovery';
export * from './social';
export * from './sync';

/** Domain classes whose methods BasisAPI carries (order does not matter: a name may be defined once). */
const DOMAINS = [
  AuthApi, ContentApi, TokensApi, MarketsApi, CreditApi, WalletApi, UpDownApi, DiscoveryApi, SocialApi, SyncApi,
] as const;

/** Off-chain API client: every domain's methods on one flat object (`client.api.<method>`). */
export class BasisAPI extends ApiCore {}

export interface BasisAPI extends AuthApi, ContentApi, TokensApi, MarketsApi, CreditApi, WalletApi, UpDownApi,
  DiscoveryApi, SocialApi, SyncApi {}

for (const domain of DOMAINS) {
  for (const name of Object.getOwnPropertyNames(domain.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(BasisAPI.prototype, name)) {
      throw new Error(`[basis-sdk] BasisAPI: ${name} is defined by two API domains`);
    }
    Object.defineProperty(BasisAPI.prototype, name, Object.getOwnPropertyDescriptor(domain.prototype, name)!);
  }
}
