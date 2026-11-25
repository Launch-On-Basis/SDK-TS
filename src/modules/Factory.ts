import { type Address, getAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import { ERC20Abi, FactoryAbi, FactoryTokenAbi, MainTokenAbi, SwapAbi } from '../abis';
import { IMAGE_MAX_BYTES, METADATA_MAX_LENGTH, sniffImage } from '../api/content';
import { apiKeyStateOf, AuthRequiredError, BasisApiError } from '../api/core';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, TxResult } from '../core/BaseModule';
import { addMissingEventWarning } from '../core/events';
import { BasisError, NotDeployedError, TxNotConfirmedError, ValidationError } from '../core/errors';
import { amountOf } from '../core/amounts';
import { refusePausedAsset } from '../core/loans';
import { type KeyMap, optionKeys, optsOf } from '../core/opts';
import { mainAmount, pairAmount, type MainInfo } from '../core/mains';
import { Amount, checkText, MAX_UINT256, parseAmount, toAddress, toBool, toUint } from '../core/units';
import { checkMetadataFields, trimAscii } from './metadataFields';

/** The contract's recycle window: a flagged contract holder has 7 days to claim. */
const RECYCLE_WINDOW = 7 * 24 * 3600;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/**
 * The site's ticker rule (its create form): 1-10 letters or digits, typed letters taken as upper case. ASCII only: the
 * form keeps nothing else.
 */
const TICKER_RE = /^[A-Za-z0-9]{1,10}$/;

/**
 * The ticker as it goes on chain: trimmed of ASCII whitespace and upper-cased, after the site's rule (rule `symbol`,
 * checked before any read): a string, well-formed text (the `checkText` message for a lone surrogate), not empty, then
 * 1-10 letters or digits (A-Z, a-z, 0-9; a lower-case letter is sent upper case, as the site's form does). PY:
 * `_check_ticker`.
 */
function checkTicker(raw: unknown): string {
  checkText(raw, 'symbol');
  const s = typeof raw === 'string' ? trimAscii(raw) : '';
  if (!s) throw new ValidationError('symbol', 'symbol is required (a non-empty string).');
  if (!TICKER_RE.test(s)) {
    throw new ValidationError('symbol', `symbol (the ticker) must be 1-10 letters or digits (A-Z, 0-9), as the site takes it; got ${JSON.stringify(s)}.`);
  }
  return s.toUpperCase();
}

/**
 * The token name as it goes on chain: trimmed as the site's create form trims it (JS `trim()`: whitespace, line
 * terminators, no-break spaces and the BOM), then refused when that leaves nothing (a non-string included) or it is not
 * well-formed text (rule `name`, before any read). PY: `_check_name`.
 */
function checkName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new ValidationError('name', 'name is required (a non-empty string).');
  checkText(name, 'name');
  return name;
}

/**
 * Options for creating a factory token. An optional field set to null is the same as leaving it out (its default).
 */
export interface CreateTokenParams {
  /**
   * The ticker: 1-10 letters or digits (A-Z, 0-9), the site's rule, checked before any read (rule `symbol`; a lone
   * surrogate gets the not-valid-text message). ASCII whitespace around it is trimmed and a lower-case letter is sent
   * upper case (`'doge'` goes on chain as `DOGE`), as the site's form does.
   */
  symbol: string;
  /**
   * The token's name: trimmed as the site's form trims it (JS `trim()`: whitespace, no-break spaces, the BOM); empty
   * after the trim, or not well-formed text, is refused before any read (rule `name`).
   */
  name: string;
  /**
   * Hybrid multiplier, 1-100. Normal token: higher keeps more of the price as a floor.
   * Reversed (meme+) token: higher is closer to a fixed-supply token.
   * The floor is measured in the pair asset, which can move itself.
   */
  hybridMultiplier: number | bigint;
  /**
   * Launch liquidity in basis points of the main's seed: 1000-100000, i.e. 10% to 1000%. Higher also means a larger
   * launch supply (see `reversed`).
   */
  startLP: number | bigint;
  /** Invite-only presale: only whitelisted wallets may buy until the target is hit. Needs `presaleTokens > 0`. Default false. */
  frozen?: boolean | null;
  /** Presale size as a whole-token count (not wei, not pair asset). 0 = no presale. Default 0. */
  presaleTokens?: number | bigint | null;
  /** Launch supply multiplier: 1 up to the main's maximum (read live; the refusal names it). Default 1. */
  supplyMultiplier?: number | bigint | null;
  /** Holder rewards (paid in the pair asset). Fixed for life. Default false. */
  rewardsEnabled?: boolean | null;
  /** Presale buys are paid out vested (auto-vest). Default false. */
  autoVest?: boolean | null;
  /** Auto-vest duration in whole days, 1-990 (only used when `autoVest`). */
  autoVestDuration?: number | bigint | null;
  /** Auto-vest releases gradually (true) or as a cliff (false). Default false. */
  gradualAutovest?: boolean | null;
  /**
   * Create a reversed (meme+) token. Its presale must fit in half the launch supply, which grows with `startLP` and
   * `supplyMultiplier`; a bigger presale is refused at simulation (`BasisContractError`, reason
   * 'presale above half the launch supply'), before any gas is spent. Default false.
   */
  reversed?: boolean | null;
  /** Main the token trades against (address or address-book key). Default: the default main. */
  main?: Address | string | null;
}
const CREATE_TOKEN_KEY_MAP: KeyMap<CreateTokenParams> = {
  symbol: true, name: true, hybridMultiplier: true, startLP: true, frozen: true, presaleTokens: true, supplyMultiplier: true,
  rewardsEnabled: true, autoVest: true, autoVestDuration: true, gradualAutovest: true, reversed: true, main: true,
};
const CREATE_TOKEN_KEYS = optionKeys<CreateTokenParams>(CREATE_TOKEN_KEY_MAP);

export interface CreateTokenResult extends TxResult {
  /** The new token, read from the tx's log; null with a warning when the event is missing (the tx is confirmed). */
  token: Address | null;
  /** The creator (the signer), read from the tx's log; null when the event is missing. */
  creator: Address | null;
}

/**
 * The token's metadata fields, checked before the tx as POST /api/metadata checks them: description at most 5000
 * characters; `website` an https link (a bare host gets https://), `telegram` a t.me link or handle, `twitterx` an X
 * handle or profile link, each at most 191 characters as the site stores it. Sent as given (the site normalises).
 * null = not given (left out of the upload).
 */
export interface TokenMetadataFields {
  description?: string | null;
  website?: string | null;
  telegram?: string | null;
  twitterx?: string | null;
}
const TOKEN_METADATA_KEY_MAP: KeyMap<TokenMetadataFields> = { description: true, website: true, telegram: true, twitterx: true };

export interface CreateTokenWithMetadataParams extends CreateTokenParams, TokenMetadataFields {
  /** URL of the token image (give `imageUrl` or `imageFile`): downloaded and resized to 512x512 WebP before the tx. */
  imageUrl?: string | null;
  /**
   * Image bytes (alternative to `imageUrl`): png, jpeg, gif or webp (told by the bytes), at most 5 MB; sent as is.
   * null = not given.
   */
  imageFile?: Blob | Uint8Array | null;
}
const CREATE_TOKEN_WITH_METADATA_KEYS = optionKeys<CreateTokenWithMetadataParams>({
  ...CREATE_TOKEN_KEY_MAP, ...TOKEN_METADATA_KEY_MAP, imageUrl: true, imageFile: true,
});

/** Image source for `retryTokenMetadata`: exactly one of the three (null = not given). */
export interface RetryTokenMetadataParams extends TokenMetadataFields {
  imageUrl?: string | null;
  imageFile?: Blob | Uint8Array | null;
  /** An image already hosted for this token (the `imageUrl` of a result whose metadata step failed): not uploaded again. */
  hostedImageUrl?: string | null;
}
const RETRY_TOKEN_METADATA_KEYS = optionKeys<RetryTokenMetadataParams>({ ...TOKEN_METADATA_KEY_MAP, imageUrl: true, imageFile: true, hostedImageUrl: true });

/** Why an upload after the create failed. The token exists: finish with `factory.retryTokenMetadata`, never create again. */
export interface TokenUploadError {
  /** 'token': the token address is unknown (its creation log missing); 'image' / 'metadata': that upload failed. */
  stage: 'token' | 'image' | 'metadata';
  /** API error code (`bad_body`, `forbidden`, `invalid_key`, ...), 'auth_required' without credentials, else null. */
  code: string | null;
  /** HTTP status of the API answer, null when there was none. */
  status: number | null;
  message: string;
  /** The original error. */
  cause?: unknown;
}

/** Outcome of the uploads (`createTokenWithMetadata`, `retryTokenMetadata`). */
export interface TokenMetadataResult {
  token: Address | null;
  /** Hosted image URL; null when the image step failed. */
  imageUrl: string | null;
  /** Pinned metadata JSON; null when the metadata step failed. */
  metadata: { url: string; cid: string } | null;
  /** null when both uploads went through. */
  uploadError: TokenUploadError | null;
}

export interface CreateTokenWithMetadataResult extends CreateTokenResult, TokenMetadataResult {
  token: Address | null;
}

/** A factory token's holder-reward state for one wallet. Share amounts are 18-decimal token wei. */
export interface RewardsInfo {
  token: Address;
  user: Address;
  rewardsEnabled: boolean;
  /** `user`'s reward shares (tokens held, in leverage and in vestings); 0 when excluded or rewards off. */
  shares: bigint;
  totalShares: bigint;
  /** Tokens counted for `user` while a leverage position holds them. */
  custodyCredit: bigint;
  /** Unclaimed tokens in `user`'s vestings, counted for them (paused while a vesting loan is open). */
  vestingCredit: bigint;
  /** Excluded wallets (protocol contracts and recycled contracts) earn nothing new. */
  excluded: boolean;
  /** Lifetime holder rewards claimed, in the pair asset. */
  claimed: Amount;
  /** Claimable now, in the pair asset. */
  claimable: Amount;
  /** When `user` (a contract) was flagged for recycling, unix seconds; 0 = not flagged. A claim clears the flag. */
  recycleFlaggedAt: number;
  /** From then on anyone may recycle `user`'s unclaimed rewards to all holders (`recycleFlaggedAt` + 7 days); 0 = not flagged. */
  recyclableAt: number;
  /** Last reward distribution, unix seconds (0 = none yet). */
  lastDistribution: number;
}

export interface DisableFreezeResult extends TxResult {
  /** true when the tx's log shows the freeze lifted; null with a warning when that log is missing. */
  freezeLifted: true | null;
}

export interface SetWhitelistedWalletResult extends TxResult {
  /** Wallets whitelisted by this tx (from its logs). */
  added: Address[];
  /** Wallets that were already whitelisted (skipped; their cap is unchanged). */
  skipped: Address[];
  /** Presale cap given to each added wallet, in the token (unit `token`, 18 decimals). */
  cap: Amount;
}

export interface RemoveWhitelistResult extends TxResult {
  /** The wallet removed, read from the tx's log; null with a warning when the event is missing. */
  removed: Address | null;
}

export interface ClaimRewardsResult extends TxResult {
  /**
   * Paid out by this claim, in the pair asset. 0 only for a holder flagged for recycling with nothing to pay: the claim
   * then just clears the flag.
   */
  claimed: Amount;
}

export interface BurnResult extends TxResult {
  /** Tokens this call took from the signer, 18-decimal wei (its `Transfer` out); null when missing. */
  burned: bigint | null;
}

export interface AddToRewardsResult extends TxResult {
  /** Pair asset shared out to the holders (the top-up plus any recycled rewards paid out with it); null when missing. */
  distributed: Amount | null;
  /** Rewards added per reward share, scaled by 1e36 (`distributed` is the amount); null when missing. */
  rewardsPerShare: bigint | null;
}

export interface TokenState {
  token: Address;
  /** A display flag BASIS can set on a project. It isn't a safety check or a recommendation, and it changes no trading rule. */
  projectedVetted: boolean;
  /** When the token was created, unix seconds. */
  creationTime: bigint;
  /** Wallets on the presale whitelist, the dev included (starts at 1). */
  totalWhitelisted: bigint;
  /**
   * Listed (`isEcosystemToken`): tradable and usable for loans and vesting. False once BASIS delists it; `creatorOf`
   * still names its creator.
   */
  listed: boolean;
  frozen: boolean;
  presaleComplete: boolean;
  /** Presale tokens sold, 18-decimal token wei. */
  presaleSold: bigint;
  /** Presale target, 18-decimal token wei (`presaleTokens * 1e18`). */
  presaleTarget: bigint;
  reversed: boolean;
  rewardsEnabled: boolean;
  hybridMultiplier: bigint;
  /** Buys are paid out vested (auto-vest), over `autoVestDuration` days, gradually or as a cliff. */
  autoVest: boolean;
  /** Whole days. */
  autoVestDuration: bigint;
  gradualAutoVesting: boolean;
  /** 18-decimal token wei. */
  totalSupply: bigint;
  /** Pair asset held by the token contract (holder rewards not paid out yet, and the like). */
  cashHeld: Amount;
  /** Main per token (unit 'main'). */
  tokenPrice: Amount;
  /** Pair asset per token (unit 'pairAsset', scaled by `pairUnit`). */
  pairPrice: Amount;
  main: Address;
  pairAsset: Address;
  dev: Address;
}

/** A wallet's presale whitelist entry on a factory token. Amounts are 18-decimal token wei. */
export interface WhitelistStatus {
  whitelisted: boolean;
  /** Cap of presale tokens the wallet may buy (max uint256 for the dev, 0 when not whitelisted). */
  maxBuy: bigint;
  /** Presale tokens bought so far (leverage buys count too and may pass the cap). */
  bought: bigint;
  /** `maxBuy - bought`, floored at 0. */
  remaining: bigint;
}

/** Factory tokens: creation, registry reads, and each token's dev settings and reads. */
export class FactoryModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the factory has an address on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.factory);
  }

  private get factory(): Address {
    return this.require(this.client.addresses.factory, 'Factory');
  }


  /**
   * Create a factory token (a reversed one when `reversed`). Checks the create rules before the tx (the reversed-presale
   * limit is checked at simulation) and sends the exact creation fee. Returns the new token's address, read from the
   * tx's log. `params` is a plain object with `CreateTokenParams` keys only (anything else, a misspelt key such as
   * `rewardEnabled` included, is refused before any read, rule `options`).
   */
  async createToken(params: CreateTokenParams): Promise<CreateTokenResult> {
    return this.sendCreate(await this.buildCreateParams(optsOf(params, CREATE_TOKEN_KEYS)));
  }

  /**
   * Create a token, then upload its image and register its metadata (POST /api/images, POST /api/metadata; they need
   * the token address, so they run after the tx). Checked before any gas is spent: the image argument, the metadata
   * fields (description 5000 characters; website an https link, telegram a t.me link or handle, twitterx an X handle,
   * each at most 191 characters as the site stores it), the symbol (the site's ticker rule, 1-10 letters or digits,
   * rule `symbol`), the name (not empty once trimmed, rule `name`), the API credentials (an API key or a SIWE
   * session), every create rule, the image itself (an `imageUrl` is downloaded and resized to 512x512 WebP here; an
   * `imageFile` must be png, jpeg, gif or webp by its bytes and at most 5 MB) and, last, the API key's wallet (see
   * below).
   *
   * The key check: a key the client counts as the signer's (the `apiKey` option with a signer is taken as the signer's)
   * goes to GET /api/v1/me/profile, sent with the key alone, once per key and signer; when the answer names another
   * wallet, or none, the create is refused with `ValidationError('apiKey')` (the uploads after the fee would be
   * refused). An API failure there (an invalid or revoked key, 429, network) is thrown as it came. Nothing is sent in
   * either case. Uploads that go with the SIWE session are not checked (the sign-in confirmed its wallet).
   *
   * Never throws after the create tx: if an upload still fails, the result carries the token, `imageUrl` / `metadata`
   * (null for the failed step) and `uploadError`, plus a warning. Finish with `retryTokenMetadata(token, ...)`;
   * calling this method again would launch a second token. A receipt that cannot be read after sending throws
   * `TxNotConfirmedError` whose `note` points to `retryTokenMetadata` (no upload was made).
   */
  async createTokenWithMetadata(options: CreateTokenWithMetadataParams): Promise<CreateTokenWithMetadataResult> {
    const o = optsOf(options, CREATE_TOKEN_WITH_METADATA_KEYS);
    if (!o.imageUrl && o.imageFile == null) {
      throw new ValidationError('imageRequired', 'Either imageUrl or imageFile is required.');
    }
    if (o.imageUrl && o.imageFile != null) {
      throw new ValidationError('imageRequired', 'Give imageUrl or imageFile, not both.');
    }
    checkMetadataFields(o);
    checkTicker(o.symbol);
    checkName(o.name);
    this.client.api.checkUploadAuth();
    const built = await this.buildCreateParams(o);
    const image = await this.prepareImage(o);
    await this.confirmUploadKey();

    let created: CreateTokenResult;
    try {
      created = await this.sendCreate(built);
    } catch (e) {
      if (e instanceof TxNotConfirmedError) {
        throw e.withNote(
          'The image and metadata were NOT uploaded (they need the token address). Once the tx is mined, read the token '
          + '(its TokenCreated log, or factory.getTokensByCreator) and call factory.retryTokenMetadata(token, ...); do not create the token again.',
        );
      }
      throw e;
    }
    if (!created.token) {
      const uploadError: TokenUploadError = {
        stage: 'token', code: null, status: null,
        message: `the token address is unknown (no TokenCreated log in ${created.hash}): find it with factory.getTokensByCreator, then call factory.retryTokenMetadata.`,
      };
      created.warnings.push(`Token created (tx ${created.hash}) but ${uploadError.message} Do not create it again.`);
      return { ...created, imageUrl: null, metadata: null, uploadError };
    }
    const uploaded = await this.uploadTokenMetadata(created.token, image, null, o);
    if (uploaded.uploadError) {
      created.warnings.push(
        `Token ${created.token} was created (tx ${created.hash}) but the ${uploaded.uploadError.stage} upload failed: ` +
        `${uploaded.uploadError.message} Finish it with factory.retryTokenMetadata(token, ...); do not create the token again.`,
      );
    }
    return { ...created, ...uploaded, token: created.token };
  }

  /**
   * Finish the uploads of a token whose `createTokenWithMetadata` returned an `uploadError` (or any token the signer
   * created). Give exactly one image source: `imageUrl` / `imageFile` (uploaded as in createTokenWithMetadata) or
   * `hostedImageUrl` (an image already hosted for it, e.g. the result's `imageUrl` when only the metadata failed).
   * Same pre-checks as createTokenWithMetadata, and `hostedImageUrl` a string (ValidationError('hostedImageUrl')); sends
   * no tx. Upload failures come back in `uploadError` (no throw). The API keeps one metadata record per token (409
   * `exists` once it is set). `options` is a plain object (rule `options` for anything else, before any read).
   */
  async retryTokenMetadata(token: Address, options: RetryTokenMetadataParams): Promise<TokenMetadataResult> {
    const o = optsOf(options, RETRY_TOKEN_METADATA_KEYS);
    token = toAddress(token, 'token');
    const sources = [o.imageUrl, o.imageFile, o.hostedImageUrl].filter((v) => v !== undefined && v !== null && v !== '');
    if (sources.length !== 1) {
      throw new ValidationError('imageRequired', 'Give exactly one of imageUrl, imageFile or hostedImageUrl.');
    }
    checkMetadataFields(o);
    if (o.hostedImageUrl != null && typeof o.hostedImageUrl !== 'string') {
      throw new ValidationError('hostedImageUrl', 'hostedImageUrl must be a string: the URL of an image already hosted for this token.');
    }
    if (o.hostedImageUrl && o.hostedImageUrl.length > METADATA_MAX_LENGTH.image) {
      throw new ValidationError('metadataTooLong', `hostedImageUrl is ${o.hostedImageUrl.length} characters; the API takes at most ${METADATA_MAX_LENGTH.image}.`);
    }
    this.client.api.checkUploadAuth();
    const image = o.hostedImageUrl ? null : await this.prepareImage(o);
    return this.uploadTokenMetadata(token, image, o.hostedImageUrl ?? null, o);
  }

  /** The exact `msg.value` a create needs from `sender` (default: the signer): 0 when fee-whitelisted, else `getFeeAmount()`. Native wei. */
  async getCreationFee(sender?: Address): Promise<bigint> {
    const who = sender == null ? this.account : toAddress(sender, 'sender');
    const [whitelisted, fee] = await Promise.all([this.isFeeWhitelisted(who), this.getFeeAmount()]);
    return whitelisted ? 0n : fee;
  }

  /**
   * Before a create whose uploads go with the API key (the client counts the key as the signer's): the key's wallet
   * (`api._keyWallet`: one GET /api/v1/me/profile with the key alone) must be the signer, else
   * `ValidationError('apiKey')`: a key of another wallet would have the uploads refused after the fee. Confirmed once
   * per key and signer on this client. Uploads that go with the session (no key, or a key of another wallet beside the
   * signer's session) are not checked.
   */
  private async confirmUploadKey(): Promise<void> {
    const key = this.client.apiKey;
    if (!key || apiKeyStateOf(this.client) !== 'ok') return;
    const signer = this.account.toLowerCase();
    if (this.confirmedKey && this.confirmedKey.key === key && this.confirmedKey.wallet === signer) return;
    const wallet = await this.client.api._keyWallet();
    if (wallet !== signer) {
      throw new ValidationError('apiKey', wallet
        ? `The API key belongs to ${wallet}, not to the signer ${signer}: the image and metadata uploads after the create would be refused. Pass the signer's own API key (or sign in with it). Nothing was sent.`
        : `The API did not say which wallet the API key belongs to (GET /api/v1/me/profile named none), so the uploads after the create could not be confirmed for the signer ${signer}. Nothing was sent.`);
    }
    this.confirmedKey = { key, wallet: signer };
  }

  /** The API key `confirmUploadKey` confirmed for a signer (lower case), null before the first check. */
  private confirmedKey: { key: string; wallet: string } | null = null;

  /** Send a validated create with the exact fee and read the new token from the factory's log. */
  private async sendCreate(built: Awaited<ReturnType<FactoryModule['buildCreateParams']>>): Promise<CreateTokenResult> {
    const factory = this.factory;
    const { p, reversed } = built;
    const value = await this.getCreationFee(this.account);
    const tx = reversed
      ? await this.send({ address: factory, abi: FactoryAbi, functionName: 'createReversedTokenFor', args: [p], value, contract: 'Factory' })
      : await this.send({ address: factory, abi: FactoryAbi, functionName: 'createTokenFor', args: [p], value, contract: 'Factory' });
    const ev = this.expectEvent(tx, FactoryAbi, 'TokenCreated', factory, 'Factory', ['token', 'creator']);
    return { ...tx, token: ev?.tokenAddress ?? null, creator: ev?.creator ?? null };
  }

  /**
   * The image bytes to upload, checked before any tx: downloaded and resized (`imageUrl`) or as given (`imageFile`; null
   * is not given).
   */
  private async prepareImage(o: { imageUrl?: string | null; imageFile?: Blob | Uint8Array | null }): Promise<{ bytes: Uint8Array; mime: string }> {
    const bytes = o.imageFile != null
      ? (o.imageFile instanceof Blob ? new Uint8Array(await o.imageFile.arrayBuffer()) : new Uint8Array(o.imageFile))
      : await this.client.api.downloadImage(o.imageUrl!);
    const mime = sniffImage(bytes.subarray(0, 12));
    if (!mime) throw new ValidationError('imageType', 'The image must be png, jpeg, gif or webp (told by its bytes).');
    if (bytes.byteLength > IMAGE_MAX_BYTES) {
      throw new ValidationError('imageTooLarge', `The image is ${bytes.byteLength} bytes; the API takes at most 5 MB (${IMAGE_MAX_BYTES} bytes).`);
    }
    return { bytes, mime };
  }

  /** Upload the image (unless already hosted) and the metadata of `token`. Never throws: failures go in `uploadError`. */
  private async uploadTokenMetadata(
    token: Address, image: { bytes: Uint8Array; mime: string } | null, hosted: string | null, fields: TokenMetadataFields,
  ): Promise<TokenMetadataResult> {
    let imageUrl: string | null = hosted;
    try {
      if (image) imageUrl = await this.client.api.uploadImage(image.bytes, `${token}.${IMAGE_EXT[image.mime]}`, 'token', token);
    } catch (e) {
      return { token, imageUrl: null, metadata: null, uploadError: uploadErrorOf('image', e) };
    }
    try {
      const metadata = await this.client.api.updateMetadata({
        address: token, description: fields.description ?? undefined, image: imageUrl!,
        website: fields.website ?? undefined, telegram: fields.telegram ?? undefined, twitterx: fields.twitterx ?? undefined,
      });
      return { token, imageUrl, metadata, uploadError: null };
    } catch (e) {
      return { token, imageUrl, metadata: null, uploadError: uploadErrorOf('metadata', e) };
    }
  }

  /** Validate params against the create rules (the main first) and build the create struct. */
  private async buildCreateParams(params: CreateTokenParams) {
    const symbol = checkTicker(params.symbol);
    const name = checkName(params.name);

    const hybridMultiplier = toUint(params.hybridMultiplier, 'hybridMultiplier');
    const startLP = toUint(params.startLP, 'startLP');
    const presaleTokens = toUint(params.presaleTokens ?? 0n, 'presaleTokens');
    if (presaleTokens > MAX_UINT256 / 10n ** 18n) {
      throw new ValidationError('presaleTokens', `presaleTokens counts whole tokens and is at most ${MAX_UINT256 / 10n ** 18n}; got ${presaleTokens}.`);
    }
    const supplyMultiplier = toUint(params.supplyMultiplier ?? 1n, 'supplyMultiplier');
    const frozen = toBool(params.frozen, 'frozen', false);
    const rewardsEnabled = toBool(params.rewardsEnabled, 'rewardsEnabled', false);
    const autoVest = toBool(params.autoVest, 'autoVest', false);
    const gradualAutovest = toBool(params.gradualAutovest, 'gradualAutovest', false);
    const reversed = toBool(params.reversed, 'reversed', false);
    const autoVestDuration = autoVest ? toUint(params.autoVestDuration ?? 0n, 'autoVestDuration') : 0n;

    let info: MainInfo;
    try {
      info = params.main ? await this.client.mains.get(params.main) : await this.client.mains.default();
    } catch (e) {
      if (!params.main || !(e instanceof BasisError) || e instanceof NotDeployedError) throw e;
      throw new ValidationError('unknown main', `${params.main} is not a main: ${e.message.replace(/^\[basis-sdk\] /, '')}`);
    }
    const main = info.main;
    const swap = this.require(this.client.addresses.swap, 'Swap');
    const pc = this.publicClient;
    const [active, registeredPair, maxSupplyMultiplier] = await Promise.all([
      pc.readContract({ address: swap, abi: SwapAbi, functionName: 'isMain', args: [main] }),
      pc.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'getPair', args: [main, info.pairAsset] }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'MAX_SUPPLY_MULTIPLIER' }),
    ]);
    if (!active) throw new ValidationError('unknown pair', `Main ${info.symbol} (${main}) is not active on SWAP.`);
    if (registeredPair.toLowerCase() !== main.toLowerCase()) {
      throw new ValidationError('MainNotRegistered', `Main ${info.symbol} (${main}) is not registered in the factory.`);
    }

    if (hybridMultiplier < 1n || hybridMultiplier > 100n) {
      throw new ValidationError('invalid multiplier', `hybridMultiplier must be 1-100, got ${hybridMultiplier}.`);
    }
    if (autoVest && (autoVestDuration < 1n || autoVestDuration > 990n)) {
      throw new ValidationError('auto-vest duration 1-990 days', `autoVestDuration must be 1-990 days, got ${autoVestDuration}.`);
    }
    if (frozen && presaleTokens === 0n) {
      throw new ValidationError('frozen needs presale', 'A frozen (invite-only) token needs presaleTokens > 0.');
    }
    if (startLP < 1000n || startLP > 100000n) {
      throw new ValidationError('invalid starting LP', `startLP is basis points of the main's seed, 1000-100000 (10%-1000%); got ${startLP}.`);
    }
    if (supplyMultiplier < 1n || supplyMultiplier > maxSupplyMultiplier) {
      throw new ValidationError('invalid supply multiplier', `supplyMultiplier must be 1-${maxSupplyMultiplier} for ${info.symbol}, got ${supplyMultiplier}.`);
    }

    return {
      reversed,
      p: {
        mainToken: main,
        symbol,
        name,
        hybridMultiplier,
        frozen,
        presaleTokens,
        startLP,
        supplyMultiplier,
        rewardsEnabled,
        autoVest,
        autoVestDuration,
        gradualAutovest,
      },
    };
  }


  /**
   * End the whitelist (frozen) phase early. Token dev only. Refused before any tx when the token is not frozen ('not
   * frozen': never was, the presale target was hit, or the phase already ended): the call would change nothing.
   * `freezeLifted` is read from the tx's log.
   */
  async disableFreeze(token: Address): Promise<DisableFreezeResult> {
    token = toAddress(token, 'token');
    if (!(await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'frozen' }))) {
      throw new ValidationError('not frozen', `Token ${token} is not frozen (never was, its presale target was hit, or the phase already ended): there is nothing to lift.`);
    }
    const tx = await this.send({ address: token, abi: FactoryTokenAbi, functionName: 'disableFreeze', args: [], contract: 'FactoryToken' });
    const lifted = this.events(tx, FactoryTokenAbi, 'FreezeLifted', token).length > 0;
    if (!lifted) addMissingEventWarning(tx, 'FactoryToken', 'FreezeLifted', ['freezeLifted']);
    return { ...tx, freezeLifted: lifted ? true : null };
  }

  /**
   * Whitelist wallets for the frozen presale. Token dev only. Already-whitelisted wallets are skipped (their cap stays).
   * @param amount cap of tokens each wallet may buy in the presale: raw 18-decimal wei (bigint) or a human
   * string/number; above 0 ('cap': a 0 cap whitelists a wallet that can buy nothing).
   * The whitelist only gates buys while the token is frozen and its presale runs, so the call is refused when it would
   * have no effect: 'Presale over' (the presale target was hit) or 'not frozen' (never frozen, or `disableFreeze` ended
   * the phase; it cannot be turned back on).
   * The result lists the wallets this tx `added` (from its logs) and the `skipped` ones.
   * @param tag a label stored with the entries (default, also for null: ''); well-formed text (rule `tag`)
   */
  async setWhitelistedWallet(
    token: Address, wallets: Address[], amount: bigint | string | number, tag: string | null = '',
  ): Promise<SetWhitelistedWalletResult> {
    token = toAddress(token, 'token');
    if (!Array.isArray(wallets) || !wallets.length) throw new ValidationError('no wallets provided', 'wallets must be a non-empty array.');
    tag ??= '';
    if (typeof tag !== 'string') throw new ValidationError('tag', `tag must be a string, got ${String(tag)}.`);
    checkText(tag, 'tag');
    const list = wallets.map((w, i) => toAddress(w, `wallets[${i}]`));
    const cap = parseAmount(amount, 18, 'cap');
    if (cap === 0n) throw new ValidationError('cap', 'The presale cap must be above 0: a wallet whitelisted with cap 0 can buy nothing.');
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [frozen, presaleComplete] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'frozen' }),
      this.publicClient.readContract({ ...c, functionName: 'presaleComplete' }),
    ]);
    if (presaleComplete) throw new ValidationError('Presale over', `Token ${token} finished its presale: the whitelist no longer gates anything.`);
    if (!frozen) {
      throw new ValidationError('not frozen', `Token ${token} is not frozen (never was, or disableFreeze ended the phase): anyone may buy its presale, so the whitelist has no effect.`);
    }
    const fmt = await amountOf(this.client, token);
    const tx = await this.send({
      address: token, abi: FactoryTokenAbi, functionName: 'setWhitelistedWallet', args: [list, cap, tag], contract: 'FactoryToken',
    });
    const added = this.events(tx, FactoryTokenAbi, 'WhiteListedWallet', token).map((e) => getAddress(e.user));
    const isAdded = new Set(added.map((a) => a.toLowerCase()));
    return { ...tx, added, skipped: list.filter((w) => !isAdded.has(w.toLowerCase())), cap: fmt(cap) };
  }

  /** Remove a wallet from the presale whitelist. Token dev only. `removed` is read from the tx's log. */
  async removeWhitelist(token: Address, wallet: Address): Promise<RemoveWhitelistResult> {
    token = toAddress(token, 'token');
    wallet = toAddress(wallet, 'wallet');
    const tx = await this.send({ address: token, abi: FactoryTokenAbi, functionName: 'removeWhitelist', args: [wallet], contract: 'FactoryToken' });
    const ev = this.expectEvent(tx, FactoryTokenAbi, 'WhitelistRemoved', token, 'FactoryToken', ['removed']);
    return { ...tx, removed: ev?.user ?? null };
  }


  /**
   * Claim holder rewards (paid in the pair asset). Refused before any tx: 'rewards off' (the token has holder rewards
   * off), 'nothing to claim' (nothing claimable now, `getClaimableRewards` 0: the tx would pay nothing; a holder flagged
   * for recycling may still claim 0, which clears the flag), then 'pair asset paused' (its issuer paused the pair asset,
   * so nothing can be paid out). `claimed` is what this claim paid.
   */
  async claimRewards(token: Address): Promise<ClaimRewardsResult> {
    token = toAddress(token, 'token');
    const me = this.account;
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [enabled, info, claimable, flaggedAt] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'rewardsEnabled' }),
      this.mainInfoOf(token),
      this.publicClient.readContract({ ...c, functionName: 'getClaimableRewards', args: [me] }),
      this.publicClient.readContract({ ...c, functionName: 'recycleFlaggedAt', args: [me] }),
    ]);
    if (!enabled) throw new ValidationError('rewards off', `Token ${token} has holder rewards off; there is nothing to claim.`);
    if (claimable === 0n && flaggedAt === 0n) {
      throw new ValidationError('nothing to claim', `${me} has no holder rewards to claim on ${token} right now.`);
    }
    if (claimable > 0n) await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'no holder rewards can be paid out');
    const tx = await this.send({ ...c, functionName: 'claimRewards', args: [], contract: 'FactoryToken' });
    const paid = this.events(tx, FactoryTokenAbi, 'RewardsClaimed', token)
      .filter((e) => e.investor.toLowerCase() === me.toLowerCase())
      .reduce((sum, e) => sum + e.claimableNow, 0n);
    return { ...tx, claimed: pairAmount(paid, info) };
  }

  /**
   * Top up a factory token's holder rewards (anyone may call it): `amount` of the main's pair asset is shared out to the
   * holders at once. `amount`: raw pair-asset units (bigint, the pair asset's decimals) or a human string/number.
   * Refused before any tx for 0 ('cannot be zero'), and with 'rewards off' or 'no shares' (no eligible holders yet):
   * the money would go to the protocol instead of the holders; and, before the approval, while the pair asset's issuer
   * has paused it ('pair asset paused': it cannot move). Approves the pair asset to the token when short.
   */
  async addToRewards(token: Address, amount: bigint | string | number): Promise<AddToRewardsResult> {
    token = toAddress(token, 'token');
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const info = await this.mainInfoOf(token);
    const raw = parseAmount(amount, info.pairDecimals);
    if (raw === 0n) throw new ValidationError('cannot be zero', 'The rewards top-up must be above 0.');
    const [enabled, totalShares] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'rewardsEnabled' }),
      this.publicClient.readContract({ ...c, functionName: 'totalShares' }),
    ]);
    if (!enabled) {
      throw new ValidationError('rewards off', `Token ${token} has holder rewards off: addToRewards would send the money to the protocol instead of the holders.`);
    }
    if (totalShares === 0n) {
      throw new ValidationError('no shares', `Token ${token} has no reward shares yet (no eligible holders): addToRewards would send the money to the protocol instead of the holders. Top up after the first buy.`);
    }
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'the top-up cannot be paid in');
    await this.ensureAllowance(info.pairAsset, token, raw);
    const tx = await this.send({ ...c, functionName: 'addToRewards', args: [raw], contract: 'FactoryToken' });
    const ev = this.expectEvent(tx, FactoryTokenAbi, 'RewardsDistributed', token, 'FactoryToken', ['distributed', 'rewardsPerShare']);
    return { ...tx, distributed: ev ? pairAmount(ev.rewardsToBeAdded, info) : null, rewardsPerShare: ev?.rewardsPerShareToday ?? null };
  }

  /**
   * Burn `amount` of a bonded factory token you hold: raw 18-decimal wei (bigint) or a human string/number. The tokens
   * are gone for good and you get nothing for them; the holders who keep theirs gain from it. Refused before any tx for
   * 0 ('cannot be zero'), a main ('FactoryToken'), a token still in its presale ('has not bonded yet') or more than you
   * hold ('insufficient balance'). An amount below the minimum burn is refused at simulation ("min burn").
   */
  async burn(token: Address, amount: bigint | string | number): Promise<BurnResult> {
    token = toAddress(token, 'token');
    const raw = parseAmount(amount, 18);
    if (raw === 0n) throw new ValidationError('cannot be zero', 'The burn amount must be above 0.');
    if (await this.client.mains.isMain(token)) throw new ValidationError('FactoryToken', `${token} is a main: only factory tokens can be burned.`);
    const me = this.account;
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [bonded, held] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'presaleComplete' }),
      this.publicClient.readContract({ ...c, functionName: 'balanceOf', args: [me] }),
    ]);
    if (!bonded) throw new ValidationError('has not bonded yet', `Token ${token} is still in its presale: only a bonded token can be burned.`);
    if (held < raw) throw new ValidationError('insufficient balance', `Burning ${raw} needs that many tokens; ${me} holds ${held}.`);
    const tx = await this.send({ ...c, functionName: 'burn', args: [raw], contract: 'FactoryToken' });
    const out = this.events(tx, FactoryTokenAbi, 'Transfer', token).filter((e) => e.from.toLowerCase() === me.toLowerCase());
    if (!out.length) addMissingEventWarning(tx, 'FactoryToken', 'Transfer', ['burned']);
    return { ...tx, burned: out.length ? out.reduce((sum, e) => sum + e.value, 0n) : null };
  }

  /** Claimable holder rewards of `user` (default: the signer), in the pair asset. 0 when rewards are off. */
  async getClaimableRewards(token: Address, user?: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const who = user == null ? this.account : toAddress(user, 'user');
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getClaimableRewards', args: [who] }),
      this.mainInfoOf(token),
    ]);
    return pairAmount(raw, info);
  }

  /**
   * `user`'s (default: the signer) holder-reward state on `token`: shares, total shares, custody credit, excluded,
   * lifetime claimed and claimable (pair asset), the recycle flag of a contract holder and the last distribution.
   */
  async getRewardsInfo(token: Address, user?: Address): Promise<RewardsInfo> {
    token = toAddress(token, 'token');
    const who = user == null ? this.account : toAddress(user, 'user');
    const pc = this.publicClient;
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [info, rewardsEnabled, shares, totalShares, custodyCredit, vestingCredit, excluded, claimed, claimable, flaggedAt, lastDistribution] = await Promise.all([
      this.mainInfoOf(token),
      pc.readContract({ ...c, functionName: 'rewardsEnabled' }),
      pc.readContract({ ...c, functionName: 'shares', args: [who] }),
      pc.readContract({ ...c, functionName: 'totalShares' }),
      pc.readContract({ ...c, functionName: 'custodyCredit', args: [who] }),
      pc.readContract({ ...c, functionName: 'vestingCredit', args: [who] }),
      pc.readContract({ ...c, functionName: 'isExcluded', args: [who] }),
      pc.readContract({ ...c, functionName: 'claimedRewards', args: [who] }),
      pc.readContract({ ...c, functionName: 'getClaimableRewards', args: [who] }),
      pc.readContract({ ...c, functionName: 'recycleFlaggedAt', args: [who] }),
      pc.readContract({ ...c, functionName: 'lastDistribution' }),
    ]);
    const flagged = Number(flaggedAt);
    return {
      token: getAddress(token),
      user: getAddress(who),
      rewardsEnabled,
      shares,
      totalShares,
      custodyCredit,
      vestingCredit,
      excluded,
      claimed: pairAmount(claimed, info),
      claimable: pairAmount(claimable, info),
      recycleFlaggedAt: flagged,
      recyclableAt: flagged === 0 ? 0 : flagged + RECYCLE_WINDOW,
      lastDistribution: Number(lastDistribution),
    };
  }


  /** Presale, pricing, cash, listing and identity state of a factory token. */
  async getTokenState(token: Address): Promise<TokenState> {
    token = toAddress(token, 'token');
    const pc = this.publicClient;
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const info = await this.mainInfoOf(token);
    const [frozen, presaleComplete, presaleSold, presaleTarget, reversed, rewardsEnabled, hybridMultiplier, autoVest,
      autoVestDuration, gradualAutoVesting, totalSupply, tokenPrice, pairPrice, dev, cashHeld, listed,
      projectedVetted, creationTime, totalWhitelisted] = await Promise.all([
      pc.readContract({ ...c, functionName: 'frozen' }),
      pc.readContract({ ...c, functionName: 'presaleComplete' }),
      pc.readContract({ ...c, functionName: 'presaleSold' }),
      pc.readContract({ ...c, functionName: 'presaleTarget' }),
      pc.readContract({ ...c, functionName: 'reversed' }),
      pc.readContract({ ...c, functionName: 'rewardsEnabled' }),
      pc.readContract({ ...c, functionName: 'hybridMultiplier' }),
      pc.readContract({ ...c, functionName: 'autoVest' }),
      pc.readContract({ ...c, functionName: 'autoVestDuration' }),
      pc.readContract({ ...c, functionName: 'gradualAutoVesting' }),
      pc.readContract({ ...c, functionName: 'totalSupply' }),
      pc.readContract({ ...c, functionName: 'getTokenPrice' }),
      pc.readContract({ ...c, functionName: 'getPairPrice' }),
      pc.readContract({ ...c, functionName: 'DEV' }),
      pc.readContract({ address: info.pairAsset, abi: ERC20Abi, functionName: 'balanceOf', args: [token] }),
      this.isEcosystemToken(token),
      pc.readContract({ ...c, functionName: 'projectedVetted' }),
      pc.readContract({ ...c, functionName: 'creationTime' }),
      pc.readContract({ ...c, functionName: 'totalWhitelisted' }),
    ]);
    return {
      token: getAddress(token),
      projectedVetted,
      creationTime,
      totalWhitelisted,
      listed,
      frozen,
      presaleComplete,
      presaleSold,
      presaleTarget,
      reversed,
      rewardsEnabled,
      hybridMultiplier,
      autoVest,
      autoVestDuration,
      gradualAutoVesting,
      totalSupply,
      cashHeld: pairAmount(cashHeld, info),
      tokenPrice: mainAmount(tokenPrice, info),
      pairPrice: pairAmount(pairPrice, info),
      main: info.main,
      pairAsset: info.pairAsset,
      dev,
    };
  }

  /** Presale tokens sold so far, 18-decimal token wei. */
  async getPresaleSold(token: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: toAddress(token, 'token'), abi: FactoryTokenAbi, functionName: 'presaleSold' });
  }

  /** `user`'s (default: the signer) presale whitelist entry on `token`: whitelisted, cap, bought, remaining. */
  async getWhitelistStatus(token: Address, user?: Address): Promise<WhitelistStatus> {
    token = toAddress(token, 'token');
    const who = user == null ? this.account : toAddress(user, 'user');
    const c = { address: token, abi: FactoryTokenAbi } as const;
    const [whitelisted, maxBuy, bought] = await Promise.all([
      this.publicClient.readContract({ ...c, functionName: 'whitelisted', args: [who] }),
      this.publicClient.readContract({ ...c, functionName: 'whitelistMaxBuyForUser', args: [who] }),
      this.publicClient.readContract({ ...c, functionName: 'whitelistBoughtByUser', args: [who] }),
    ]);
    return { whitelisted, maxBuy, bought, remaining: maxBuy > bought ? maxBuy - bought : 0n };
  }

  /**
   * Pair asset held by a factory token or a main, unit 'pairAsset'.
   * For a factory token this is pair asset not yet paid out (holder rewards).
   */
  async getCashHeld(tokenOrMain: Address): Promise<Amount> {
    tokenOrMain = toAddress(tokenOrMain, 'tokenOrMain');
    const info = (await this.client.mains.isMain(tokenOrMain))
      ? await this.client.mains.get(tokenOrMain)
      : await this.mainInfoOf(tokenOrMain);
    const raw = await this.publicClient.readContract({ address: info.pairAsset, abi: ERC20Abi, functionName: 'balanceOf', args: [tokenOrMain] });
    return pairAmount(raw, info);
  }

  /** Price in main per token (unit 'main', 18 decimals). */
  async getTokenPrice(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getTokenPrice' }),
      this.mainInfoOf(token),
    ]);
    return mainAmount(raw, info);
  }

  /** Price in the main's pair asset per token (unit 'pairAsset', scaled by `pairUnit`). */
  async getPairPrice(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getPairPrice' }),
      this.mainInfoOf(token),
    ]);
    return pairAmount(raw, info);
  }

  /**
   * Floor price per token (unit 'pairAsset'). The floor is measured in the pair asset, which can move itself.
   */
  async getFloorPrice(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'calculateFloor' }),
      this.mainInfoOf(token),
    ]);
    return pairAmount(raw, info);
  }

  /**
   * Floor price per token (unit 'main'). This floor is measured in the main, whose price can move.
   */
  async getTokenFloor(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'calculateTokenFloor' }),
      this.mainInfoOf(token),
    ]);
    return mainAmount(raw, info);
  }

  /**
   * The token's liquidity figure: main tokens for a factory token (unit 'main'), the pair asset for a main (unit
   * 'pairAsset', scaled by `pairUnit`). On a factory token it is neither the liquidity added at launch nor the main the
   * token holds.
   */
  async getLiquidity(tokenOrMain: Address): Promise<Amount> {
    tokenOrMain = toAddress(tokenOrMain, 'tokenOrMain');
    if (await this.client.mains.isMain(tokenOrMain)) {
      const [raw, info] = await Promise.all([
        this.publicClient.readContract({ address: tokenOrMain, abi: MainTokenAbi, functionName: 'getLiquidity' }),
        this.client.mains.get(tokenOrMain),
      ]);
      return pairAmount(raw, info);
    }
    const [raw, info] = await Promise.all([
      this.publicClient.readContract({ address: tokenOrMain, abi: FactoryTokenAbi, functionName: 'getLiquidity' }),
      this.mainInfoOf(tokenOrMain),
    ]);
    return mainAmount(raw, info);
  }

  /** Live ERC-20 `totalSupply()` of a factory token or a main, 18-decimal wei. */
  async getTotalSupply(tokenOrMain: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: toAddress(tokenOrMain, 'tokenOrMain'), abi: ERC20Abi, functionName: 'totalSupply' });
  }


  /**
   * Listed: tradable and usable for loans and vesting (set at creation; BASIS can delist a token, which turns it
   * false). For provenance ("created by this factory") use `creatorOf`.
   */
  async isEcosystemToken(token: Address): Promise<boolean> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'isEcosystemToken', args: [toAddress(token, 'token')] });
  }

  async getTokensByCreator(creator: Address): Promise<readonly Address[]> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'getTokensByCreator', args: [toAddress(creator, 'creator')] });
  }

  async getTokenCountByCreator(creator: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'getTokenCountByCreator', args: [toAddress(creator, 'creator')] });
  }

  /** Creator of a factory token (zero address when not created by this factory). */
  async creatorOf(token: Address): Promise<Address> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'creatorOf', args: [toAddress(token, 'token')] });
  }

  /** Creation fee in native wei (before the fee whitelist; see `getCreationFee`). */
  async getFeeAmount(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'feeAmount' });
  }

  /** True when `addr` (default: the signer) creates tokens without a fee. */
  async isFeeWhitelisted(addr?: Address): Promise<boolean> {
    const who = addr == null ? this.account : toAddress(addr, 'addr');
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'feeWhitelist', args: [who] });
  }

  /** V2 registry lookup (either order): the pair address, or zero. */
  async getPair(a: Address, b: Address): Promise<Address> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'getPair', args: [toAddress(a, 'a'), toAddress(b, 'b')] });
  }

  async allPairsLength(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'allPairsLength' });
  }

  /** Registry entry `index` (a whole number below `allPairsLength()`). */
  async allPairs(index: number | bigint): Promise<Address> {
    return this.publicClient.readContract({ address: this.factory, abi: FactoryAbi, functionName: 'allPairs', args: [toUint(index, 'index')] });
  }


  /** MainInfo of the main a factory token trades against. */
  private async mainInfoOf(token: Address): Promise<MainInfo> {
    const main = await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'quoteToken' });
    return this.client.mains.get(main);
  }
}

/** A failed upload as a `TokenUploadError` (the original error kept as `cause`). */
function uploadErrorOf(stage: 'image' | 'metadata', e: unknown): TokenUploadError {
  const message = String((e as Error)?.message ?? e).replace(/^\[basis-sdk\] /, '');
  if (e instanceof BasisApiError) return { stage, code: e.code, status: e.status, message, cause: e };
  if (e instanceof AuthRequiredError) return { stage, code: 'auth_required', status: null, message, cause: e };
  return { stage, code: null, status: null, message, cause: e };
}
