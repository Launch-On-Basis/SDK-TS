import { Address, Hex, isAddressEqual, maxUint256 } from 'viem';
import type { BasisClient } from '../BasisClient';
import { errorText } from '../core/redact';
import { EcosystemTokenAbi, FactoryAbi, FactoryTokenAbi, MainTokenAbi, SwapAbi, TaxesAbi, TrancheMarketAbi } from '../abis';
import { IMAGE_MAX_BYTES, METADATA_MAX_LENGTH, sniffImage } from '../api/content';
import { AuthRequiredError, BasisApiError, credentialsFor, fetchWithDeadline } from '../api/core';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, TxResult } from '../core/BaseModule';
import { BasisError, NotDeployedError, TxNotConfirmedError, ValidationError } from '../core/errors';
import { BasisContractError } from '../core/revert';
import { addMissingEventWarning } from '../core/events';
import { checkDeadline, isAssetPaused, pairAssetPaused, pairAssetPausedMessage, refusePausedAsset } from '../core/loans';
import { type AmountOf, amountOf, optAmount, pairAmountOf } from '../core/amounts';
import { pairAmount, type MainInfo, type MainRef } from '../core/mains';
import {
  verifyMarketApproval,
  type MarketApproval,
  type MarketApprovalSigned,
  type MarketType,
} from '../core/marketApproval';
import { ANY_KEYS, type KeyMap, type OptionKeys, optionKeys, optsOf } from '../core/opts';
import { normalizeRanking, OUTCOME_INVALID, OUTCOME_UNRESOLVED } from '../core/ranking';
import { Amount, checkText, optUint, parseAmount, toAddress, toAmount, toBool, toUint } from '../core/units';
import { checkMetadataFields, trimAscii } from './metadataFields';
import type { MarketReaderModule } from './MarketReader';

/** The ABI used for the calls both market hosts share; host-only calls use each module's own ABI. */
const HOST_ABI = TrancheMarketAbi;

const MAX_TRANCHES = 10;
/** Outcome ids are 0-255: a market never has more than 255 outcomes. */
const HARD_MAX_OUTCOMES = 255n;
/** Slices of a sliced redeem, 1-25. */
const MAX_SLICES = 25;
/** Default `buy` deadline: latest block timestamp + 10 min (it bounds the conversion of the input). */
const BUY_DEADLINE_SECONDS = 600;
/** What a bet cannot do while the issuer of the pair asset it moves has paused it (`pairAssetPaused`). */
const BET_PAUSED = 'no bet that pays in or converts through it can be placed';

/**
 * What a bet paid in `input`, a BASIS token of another pair, cannot do while that pair's asset is paused: the bet sells
 * it for that asset first, and selling a factory token also pays out the bettor's pending holder rewards in it.
 * Same text in PY (and in Up/Down).
 */
const inputSalePaused = (input: Address, factoryToken: boolean) =>
  `no bet paid in ${input} can be placed: the bet sells it for this asset` +
  (factoryToken ? ', and every sale pays out your pending holder rewards on it in this asset' : '');

/**
 * The other pair's asset a bet paid in `input` is first sold for, when `input` is a BASIS token of a pair other than
 * the market's own `pair` (checked on its own); null for any other input. `factoryToken`: that sale also pays out the
 * bettor's pending holder rewards in that asset. Same rule in PY and in Up/Down.
 */
async function inputSaleAsset(client: BasisClient, input: Address, main: Address, pair: Address): Promise<{ asset: Address; symbol: string; factoryToken: boolean } | null> {
  const mains = client.mains;
  let root: Address = input;
  let factoryToken = false;
  if (!(await mains.isMain(input))) {
    const factory = client.addresses.factory;
    if (isZeroAddress(factory)) return null;
    if (!(await client.publicClient.readContract({ address: factory, abi: FactoryAbi, functionName: 'isEcosystemToken', args: [input] }))) return null;
    root = await client.publicClient.readContract({ address: input, abi: EcosystemTokenAbi, functionName: 'quoteToken' });
    factoryToken = true;
    if (!(await mains.isMain(root))) return null;
  }
  if (isAddressEqual(root, main)) return null;
  const info = await mains.get(root);
  if (isAddressEqual(info.pairAsset, pair)) return null;
  return { asset: info.pairAsset, symbol: info.pairSymbol, factoryToken };
}
/** Largest `presaleTokens` (it counts whole tokens of 18 decimals). */
const MAX_PRESALE_TOKENS = maxUint256 / 10n ** 18n;
/** File extension of an uploaded market image, by its type (the upload's file name). */
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * Input limits of a market approval request. The API refuses a request outside them with a 400 before any review: no
 * tx, no review spent.
 */
const GATE_LIMITS = {
  maxName: 200,
  maxDescription: 2000,
  maxOutcomes: 150,
  maxOutcomeLen: 120,
  minEndAheadS: 60n * 60n + 60n,
  maxEndAheadS: 1825n * 86_400n,
} as const;
const GATE_SYMBOL = /^[A-Za-z0-9]{1,16}$/;

/** The site's outcome picture ids: a library category, then a picture name. */
const ART_ID_RE = /^(answers|coins|crypto|money|politics|flags|sports|weather|science|tech|entertainment|time|animals|shapes|glyphs)\/[a-z0-9][a-z0-9-]{0,47}$/;
/** POST /api/metadata reads at most this many `outcomeArt` entries. */
const MAX_ART_ENTRIES = 200;
/**
 * The site serves each library picture at /outcome-art/<id>.<ext>: svg for these
 * sets, webp for the rest. The check asks that format first and the other one after a 404, so a set the site moves to
 * the other format is still found.
 */
const ART_SVG_SETS = new Set(['coins', 'flags', 'glyphs']);
/**
 * A picture every library has: when picked ids answer 404 and none is found, its lookup tells a missing id from a site
 * that serves no library.
 */
const ART_PROBE_ID = 'answers/yes';
/** Deadline of one picture check (a HEAD of its file), and how many run at once. */
const ART_CHECK_TIMEOUT_MS = 10_000;
const ART_CHECK_CONCURRENCY = 8;

/** A caller's `main`: an address (strict: `toAddress`) or an address-book key, passed on as given. */
const mainArg = (m: MainRef): MainRef => (typeof m === 'string' && /^0x/i.test(m) ? toAddress(m, 'main') : m);

/** Common options of `createMarket` on both hosts. */
export interface CreateMarketParams {
  /**
   * Market name (the market token's name). With gating on, BASIS approves it and the approved text is sent. Gating on
   * and no `approval` given: at most 200 characters. Name and symbol must be strings and `outcomes` an array of strings,
   * each well-formed text: anything else (a number, a boolean, null in the list, a lone UTF-16 surrogate) is
   * `ValidationError` 'name' / 'symbol' / 'outcomes' before any read, never converted to text.
   */
  name: string;
  /** Market token symbol. Gating on and no `approval` given: 1-16 letters or digits. */
  symbol: string;
  /** Outcome labels, 2 to the host's limit (at most 255). Gating on and no `approval` given: at most 150, each at most 120 characters. */
  outcomes: string[];
  /**
   * Unix seconds; 0 = open-ended, otherwise at least 60 s ahead of chain time. Gating on and no `approval` given: at
   * least 3660 s and at most 1825 days ahead (the approval route's clock; the later of chain time and this machine's
   * clock stands in for it).
   */
  endTime: number | bigint;
  /** Payout slices per finishing position in bps: 1-10 entries, not more than the outcomes, each a whole number of at least the outcome count (a number or bigint: strings and booleans are refused), never increasing, sum 10000. Default `[10000]` (winner takes all). */
  trancheBP?: (number | bigint)[];
  /**
   * Main the market settles through (address or address-book key). Default: the default main. Its pair must be active
   * ('pair not active' otherwise) and, with a seed above 0, its trading open ('Trading is not enabled') and its pair
   * asset not paused by its issuer ('pair asset paused': the seed is paid in it).
   */
  main?: MainRef;
  /**
   * Invite-only presale on the market token: needs `presaleTokens > 0`. The seed buys into the presale in the creation
   * tx, so a seed that buys the whole presale ends the freeze at once.
   * A real boolean (anything else: `ValidationError('frozen')`). Default false.
   */
  frozen?: boolean;
  /** Presale size of the market token in whole tokens, at most (2^256 - 1) / 1e18 ('presaleTokens'). 0 = none. Default 0. */
  presaleTokens?: number | bigint;
  /**
   * Creator seed in the main's pair asset: raw bigint, or a human string/number.
   * At least the floor (`getMinSeed`) and a multiple of the seed step; 0 is allowed only when the floor is 0. Default
   * (left out or null, as None in PY): the floor. A boolean or anything else that is not an amount:
   * `ValidationError('seed')`. Risk of a seed of 0: the creator holds no shares, and if no ranked outcome has a bettor
   * the whole pot goes to the protocol.
   */
  seed?: bigint | string | number;
  /** Sent to the approval route (at most 2000 characters) and to the metadata in `createMarketWithMetadata`. */
  description?: string;
  /**
   * An approval you already hold (from `client.api.approveMarket`, or the `approval` of an error a failed create
   * threw: see `createMarket`). Omit it to request one when gating is on.
   */
  approval?: MarketApproval;
}
const CREATE_MARKET_KEY_MAP: KeyMap<CreateMarketParams> = {
  name: true, symbol: true, outcomes: true, endTime: true, trancheBP: true, main: true, frozen: true, presaleTokens: true,
  seed: true, description: true, approval: true,
};

/**
 * An error `createMarket` / `createMarketWithMetadata` threw after it held a valid approval that it did not use up: the
 * chain-clock read after the review, the seed approval or the create tx failed or was refused before anything was
 * created (not a `TxNotConfirmedError` of the create itself, which may still be mined, nor a refusal of the approval
 * itself: 'Approval expired' or 'endTime' no longer far enough ahead, or the host's revert 'Approval expired' /
 * 'Approval already used'). `approval` is that approval: an approval stays
 * valid until its `deadline` (about an hour) and is single-use, so pass it back
 * (`createMarket({ ...params, approval: e.approval })`) to try again without another review
 * (`(e as Partial<ErrorWithMarketApproval>).approval`; PY: `e.approval`).
 */
export type ErrorWithMarketApproval = Error & { approval: MarketApproval };

/**
 * Refuses an explicit floor (`explicit`, raw; undefined = not given) above `quoted`, what the SDK's exact quote shows
 * the write gets now (`what` names it): the host would refuse it with no reason, so it is
 * `ValidationError(field)` before any approval. A floor at or under the quote passes. Same text in PY.
 */
function refuseAboveQuote(explicit: bigint | undefined, quoted: bigint, field: string, what: string): void {
  if (explicit !== undefined && explicit > quoted) {
    throw new ValidationError(field, `${field} ${explicit} is above ${what} now (${quoted}), so it would be refused: lower it, or omit it to derive it from the quote.`);
  }
}

/** Host revert reasons that say the approval itself can no longer be used. PY: _DEAD_APPROVAL_REASONS. */
const DEAD_APPROVAL_REASONS: readonly string[] = ['Approval expired', 'Approval already used'];

/**
 * A refusal that says the approval itself can no longer be used: it expired, or its signed endTime is too close now
 * (the SDK's own checks), or the host reverted the create with 'Approval expired' / 'Approval already used'. Such an
 * error carries no approval. PY: _dead_approval.
 */
function deadApproval(e: unknown): boolean {
  if (e instanceof ValidationError) return e.rule === 'Approval expired' || e.rule === 'endTime';
  return e instanceof BasisContractError && e.reason !== null && DEAD_APPROVAL_REASONS.includes(e.reason);
}

/** `e` with `approval` attached (an Error only; anything else is passed on as it is). */
function handBack(e: unknown, approval: MarketApproval | null): unknown {
  if (approval && e instanceof Error) {
    Object.defineProperty(e, 'approval', { value: approval, enumerable: true, configurable: true, writable: true });
  }
  return e;
}

export interface CreateMarketResult extends TxResult {
  /** The new market token (`MarketCreated`; null when the event is missing). */
  market: Address | null;
  /** The approval that was used (null when gating is off). */
  approval: MarketApproval | null;
  /** The strings sent on chain (the approved ones when gating is on). */
  sent: MarketApprovalSigned;
  /** Seed paid, in the main's pair asset (`MarketSeeded.seedAmount`; 0 for an unseeded market). Null when the event is missing. */
  seedAmount: Amount | null;
  /** Market tokens the seed converted to (`MarketSeeded.seedToken`; unit `token`, 18 decimals, the market's symbol). Null when the event is missing. */
  seedTokens: Amount | null;
  /**
   * The creator's shares on each outcome from the seed, the same on every outcome (the seed's rounding dust goes to
   * outcome 0's stake, not to its shares). Null when the event is missing.
   */
  sharesPerOutcome: bigint | null;
  /** Whether the market token is still invite-only right after the tx (read after it confirmed; null when that read failed). */
  frozen: boolean | null;
}

export interface MarketMetadataOptions {
  /** URL of the market image (give `imageUrl` or `imageFile`): downloaded and resized to 512x512 WebP before the tx. */
  imageUrl?: string;
  /** Raw image data (alternative to `imageUrl`): png, jpeg, gif or webp by its bytes, at most 5 MB. */
  imageFile?: Blob | Uint8Array;
  /** An https link (a bare host gets https://), at most 191 characters as the site stores it. */
  website?: string;
  /** A t.me link or handle. */
  telegram?: string;
  /** An X handle or profile link. */
  twitterx?: string;
  /**
   * Outcome pictures from the site's built-in library: `{ <outcome label>: <picture id> }`, e.g. `{ Yes: 'answers/yes' }`.
   * Checked before any approval request or tx: each key an outcome label, each id a library id (`<category>/<name>`),
   * each picture used once, and each id one the site's library has (its picture file is looked up on the API's site:
   * an id it does not have is refused, `ValidationError('outcomeArt')` naming them). When that lookup gets no answer
   * (network, timeout, another status; a browser page on another origin cannot read it), or the site serves no
   * picture library, nothing is sent: `ValidationError('outcomeArtUnreachable')`, try again. Set once with the
   * metadata: the API keeps the first metadata of a market (409 `exists` after it). Left out or null (as None in PY):
   * no pictures.
   */
  outcomeArt?: Record<string, string> | null;
}
const MARKET_METADATA_KEY_MAP: KeyMap<MarketMetadataOptions> = {
  imageUrl: true, imageFile: true, website: true, telegram: true, twitterx: true, outcomeArt: true,
};
/** The keys of `createMarket` on the public host (the private host adds `privateEvent`: PrivateMarkets.ts). */
const CREATE_MARKET_KEYS = optionKeys<CreateMarketParams>(CREATE_MARKET_KEY_MAP);
/** The keys of `createMarketWithMetadata` on the public host. */
const CREATE_MARKET_WITH_METADATA_KEYS = optionKeys<CreateMarketParams & MarketMetadataOptions>({ ...CREATE_MARKET_KEY_MAP, ...MARKET_METADATA_KEY_MAP });

/** Why an upload after the create failed. The market exists: finish with `retryMarketMetadata`, never create again. */
export interface MarketUploadError {
  /** 'market': the market address is unknown (MarketCreated missing); 'image' / 'metadata': that upload failed. */
  stage: 'market' | 'image' | 'metadata';
  /** API error code (`bad_body`, `forbidden`, ...), 'auth_required' without credentials, else null. */
  code: string | null;
  /** HTTP status of the API answer, null when there was none. */
  status: number | null;
  message: string;
  /** The original error. */
  cause?: unknown;
}

/** Outcome of the uploads (`createMarketWithMetadata`, `retryMarketMetadata`). */
export interface MarketMetadataResult {
  /** Hosted image URL; null when the image step failed. */
  imageUrl: string | null;
  /** Pinned metadata JSON; null when the metadata step failed. */
  metadata: { url: string; cid: string } | null;
  /** null when both uploads went through. */
  uploadError: MarketUploadError | null;
}

export interface CreateMarketWithMetadataResult extends CreateMarketResult, MarketMetadataResult {}

/** `retryMarketMetadata`: one image source, plus the metadata fields. */
export interface RetryMarketMetadataOptions extends MarketMetadataOptions {
  description?: string;
  /** An image already hosted for this market (the `imageUrl` of a result whose metadata step failed): not uploaded again. */
  hostedImageUrl?: string;
}
const RETRY_MARKET_METADATA_KEYS = optionKeys<RetryMarketMetadataOptions>({ ...MARKET_METADATA_KEY_MAP, description: true, hostedImageUrl: true });

export type MarketStatus = 'unresolved' | 'resolved' | 'invalid';

/** `getMarketData`, with the pair asset / main named and `finalOutcome` decoded. */
export interface MarketData {
  marketToken: Address;
  creator: Address;
  /** The market's main. */
  main: Address;
  /** The market's pair asset: seeds, order fills and redemptions settle in it. */
  pairAsset: Address;
  marketName: string;
  creationTime: bigint;
  /** Unix seconds; 0 = open-ended. */
  endTime: bigint;
  /** ranking[0] on a resolved market, 254 = INVALID, 255 = unresolved. */
  finalOutcome: number;
  resolved: boolean;
  status: MarketStatus;
  /** The first-placed outcome, or null when unresolved or INVALID. */
  winner: number | null;
  /** Market tokens (18 decimals) outside the outcome pools. */
  generalPot: bigint;
  /** Market tokens (18 decimals). */
  totalOddsWeight: bigint;
  /** Private host: invite-only market. Always false on the public host. */
  isPrivate: boolean;
}

export interface OutcomeState {
  /** The outcome's weight in the odds: its share of all outcomes' weights is its odds. Market tokens (18 decimals). */
  oddsWeight: bigint;
  /** Market tokens staked on the outcome (18 decimals). */
  totalCost: bigint;
  /** Shares (18 decimals). */
  circulatingShares: bigint;
}

export interface MarketBuyOptions {
  /** Token paid in: the pair asset (default), the market's main, the market token, any BASIS token, or a routed outside token. */
  input?: Address;
  /** Explicit share floor in raw shares, never 0 (a fraction, a string or 0: `ValidationError('minShares')`). Default: from `marketReader.quoteBet` minus the slippage. */
  minShares?: bigint;
  /** Explicit floor on the converted market-token amount in raw units, never 0 (else `ValidationError('minTokens')`). Default: from the quote. */
  minTokens?: bigint;
  /** Overrides the client's trade slippage for the derived minimums. */
  slippageBps?: number;
  /** Unix seconds (chain time) after which the bet reverts "Deadline". Default: latest block + 600 s. */
  deadline?: bigint | number;
}
const MARKET_BUY_KEYS = optionKeys<MarketBuyOptions>({ input: true, minShares: true, minTokens: true, slippageBps: true, deadline: true });

/** Why a bet is refused (`checkBuy` reasons): the rule names `buy` throws as `ValidationError`. */
export const BUY_BLOCK_REASONS = [
  'host paused',
  'market resolved',
  'Betting closed',
  'Outcome proposed',
  'voting started',
  'outcome',
  'not whitelisted',
  'not invited',
  'convert closed',
  'pair not active',
  'Trading is not enabled',
  'pair asset paused',
] as const;
export type BuyBlockReason = (typeof BUY_BLOCK_REASONS)[number];

/** `checkBuy`: may `buyer` bet on this market and outcome right now? */
export interface BuyCheck {
  canBet: boolean;
  /** The first rule that refuses the bet; null when it is allowed. */
  reason: BuyBlockReason | null;
  /** A readable explanation of `reason`; null when the bet is allowed. */
  message: string | null;
}

export interface CheckBuyOptions {
  /** The bettor. Default: the signer. */
  buyer?: Address;
  /** The token paid in. Default: the market's pair asset. */
  input?: Address;
}
const CHECK_BUY_KEYS = optionKeys<CheckBuyOptions>({ buyer: true, input: true });

/** A refused bet (internal form of `BuyCheck`). */
export interface BuyBlock {
  reason: BuyBlockReason;
  message: string;
}

export interface BuyResult extends TxResult {
  input: Address;
  /** Input-token amount paid (`Amount` in the input token). */
  amount: Amount;
  /** Share floor sent (raw shares, 18 decimals). */
  minShares: bigint;
  /** Market-token floor sent (`Amount` in the market token). */
  minTokens: Amount;
  /** The deadline sent (unix seconds). */
  deadline: bigint;
  /** Shares minted (18 decimals; `SharesTraded.shares`). Null when the event is missing. */
  shares: bigint | null;
  /** Market tokens the input converted to, before the bet fee (`BetFunded.tokens`). Null when the event is missing. */
  tokens: Amount | null;
  /** Market tokens that reached the pot after the fee (`SharesTraded`). Null when the event is missing. */
  netTokens: Amount | null;
  /** Bet fee in market tokens (`SharesTraded.fee`). Null when the event is missing. */
  fee: Amount | null;
}

export interface RedeemOptions {
  /** Share of the remaining entitlement to sell now, 1-10000 bps. Default 10000 (or the plan's). */
  fractionBps?: number;
  /** Sell in 1-25 equal slices. Default: `marketReader.redeemPlan`'s choice. */
  slices?: number;
  /** Explicit floor on the pair asset received (never 0). Default: from the plan. */
  minOut?: bigint;
  slippageBps?: number;
}
const REDEEM_KEYS = optionKeys<RedeemOptions>({ fractionBps: true, slices: true, minOut: true, slippageBps: true });

export interface RedeemResult extends TxResult {
  fractionBps: number;
  slices: number;
  /** The floor sent, in the market's pair asset. */
  minOut: Amount;
  /** Pair asset received (`SharesRedeemed.payout`). Null when the event is missing. */
  payout: Amount | null;
  /** Market tokens sold for it (`SharesRedeemed.tokens`). Null when the event is missing. */
  tokens: Amount | null;
  /** Market tokens still owed after this redeem (`SharesRedeemed.remaining`; redeem again for them). Null when the event is missing. */
  remaining: Amount | null;
}

/** `disableFreeze`: false once `FreezeLifted` is in the logs (null when the event is missing). */
export interface MarketDisableFreezeResult extends TxResult {
  frozen: boolean | null;
}

/** Whitelist writes: what the market token did (`WhiteListedWallet` / `WhitelistRemoved` logs). */
export interface MarketWhitelistResult extends TxResult {
  /** Wallets newly listed, with the cap sent. */
  listed: Address[];
  /** Wallets asked for that were already listed: the token keeps their old cap (de-list first to change it). */
  capUnchanged: Address[];
  /** Wallets removed. */
  removed: Address[];
}

/** What `createMarket` sends, before the host-specific struct is built. */
export interface CreateCall {
  name: string;
  symbol: string;
  outcomes: string[];
  endTime: bigint;
  trancheBP: number[];
  main: Address;
  frozen: boolean;
  presaleTokens: bigint;
  seed: bigint;
  privateEvent: boolean;
  deadline: bigint;
  signature: Hex;
  value: bigint;
}

/** Shared logic of the two prediction-market hosts, public and private. */
export abstract class MarketsBase extends BaseModule {
  /** `public` = resolved by proposal, dispute and vote; `private` = resolved by the creator's voter panel. */
  abstract readonly marketType: MarketType;
  protected abstract readonly contractName: 'TrancheMarket' | 'TrancheMarketPrivate';
  /** The host address from the address book (may be zero). */
  protected abstract get hostEntry(): Address | undefined;

  /** The host's seed floor, before it is sized to the main. */
  protected abstract minSeedUnits(privateEvent: boolean): Promise<bigint>;
  /** Host-specific create pre-checks. */
  protected abstract precheckCreateHost(host: Address): Promise<void>;
  /**
   * Host-specific buy rules in the host's own order, with `closed` (the shared endTime rule, null while a dated market
   * is open and on an open-ended one) placed where the host checks it: the first rule that refuses `buyer`, or null.
   */
  protected abstract precheckBuyHost(market: Address, md: MarketData, buyer: Address, closed: BuyBlock | null): Promise<BuyBlock | null>;
  /** Send `createMarket` with the host's own struct. */
  protected abstract sendCreate(c: CreateCall): Promise<TxResult>;
  /** Tie bits of the result (bit i: ranking entry i tied with entry i-1). 0 when unresolved, INVALID or untied. */
  abstract getFinalTieMask(market: Address): Promise<bigint>;

  constructor(client: BasisClient) {
    super(client);
  }

  /** True when this host has an address on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.hostEntry);
  }

  /** The host contract address (throws `NotDeployedError` when zero). */
  get address(): Address {
    return this.require(this.hostEntry, this.contractName);
  }

  protected get reader(): MarketReaderModule {
    const r = (this.client as unknown as { marketReader?: MarketReaderModule }).marketReader;
    if (!r) throw new BasisError('[basis-sdk] client.marketReader is not available; it is needed for market sizes and quotes.');
    return r;
  }

  protected async chainTime(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }

  /** Is `main`'s pair active, read now? A paused pair refuses bets, seeds and redeems ("unknown pair" on chain). */
  protected async pairActive(main: Address, swap?: Address): Promise<boolean> {
    const s = swap ?? (await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'ecosystems', args: [main] }))[1];
    if (isZeroAddress(s)) return false;
    return this.publicClient.readContract({ address: s, abi: SwapAbi, functionName: 'isMain', args: [main] });
  }


  /**
   * Create a market. Pre-checks every host rule, then (gating on) gets an approval from the API unless one is
   * passed, verifies it locally and sends the approved strings verbatim; approves the seed in the pair asset and
   * sends the exact creation fee.
   */
  protected async createMarketInternal(
    paramsIn: CreateMarketParams | null | undefined, privateEvent: boolean, keys: OptionKeys<any> = CREATE_MARKET_KEYS,
  ): Promise<CreateMarketResult> {
    const params = optsOf(paramsIn, keys);
    const host = this.address;
    const sender = this.account;
    const pc = this.publicClient;

    checkMarketText(params.name, params.symbol, params.outcomes, true);
    const name = trimAscii(params.name);
    const symbol = trimAscii(params.symbol);
    const outcomes = params.outcomes.map((o) => trimAscii(o));
    if (outcomes.some((o) => !o)) throw new ValidationError('outcomes', 'Outcome labels must not be empty.');
    const endTime = toUint(params.endTime, 'endTime');
    const trancheIn: unknown = params.trancheBP ?? [10000];
    if (!Array.isArray(trancheIn)) throw new ValidationError('trancheBP', 'trancheBP must be an array of whole numbers of bps.');
    const frozen = toBool(params.frozen ?? undefined, 'frozen', false);
    const presaleTokens = toUint(params.presaleTokens ?? 0n, 'presaleTokens');
    if (presaleTokens > MAX_PRESALE_TOKENS) {
      throw new ValidationError('presaleTokens', `presaleTokens counts whole tokens and is at most ${MAX_PRESALE_TOKENS}; got ${presaleTokens}.`);
    }

    const mainIn = params.main ? mainArg(params.main) : undefined;
    let info: MainInfo;
    try {
      info = mainIn ? await this.client.mains.get(mainIn) : await this.client.mains.default();
    } catch (e) {
      if (!mainIn || !(e instanceof BasisError) || e instanceof NotDeployedError) throw e;
      throw new ValidationError('unknown main', `${mainIn} is not a main: ${e.message.replace(/^\[basis-sdk\] /, '')}`);
    }
    const main = info.main;

    const [paused, gating, signer, maxOutcomes, eco, minUnits, now] = await Promise.all([
      pc.readContract({ address: host, abi: HOST_ABI, functionName: 'paused' }),
      pc.readContract({ address: host, abi: HOST_ABI, functionName: 'gatingEnabled' }),
      pc.readContract({ address: host, abi: HOST_ABI, functionName: 'moderatorSigner' }),
      pc.readContract({ address: host, abi: HOST_ABI, functionName: 'MAX_OUTCOMES' }),
      pc.readContract({ address: host, abi: HOST_ABI, functionName: 'ecosystems', args: [main] }),
      this.minSeedUnits(privateEvent),
      this.chainTime(),
    ]);
    const [ecoFactory, ecoSwap, ecoAsset, ecoActive] = eco;

    if (paused) throw new ValidationError('host paused', `The ${this.marketType} market host is paused: no new markets.`);
    if (!ecoActive || isZeroAddress(ecoFactory)) {
      throw new ValidationError('ecosystem inactive', `Main ${info.symbol} (${main}) is not an active ecosystem on the ${this.marketType} market host.`);
    }
    await this.precheckCreateHost(host);
    const quoteToken = await pc.readContract({ address: main, abi: EcosystemTokenAbi, functionName: 'quoteToken' });
    if (quoteToken.toLowerCase() !== ecoAsset.toLowerCase()) {
      throw new ValidationError('asset mismatch', `The host registered ${ecoAsset} as ${info.symbol}'s pair asset, but the main pairs with ${quoteToken}.`);
    }
    const checkEndTime = (t: bigint) => {
      if (endTime !== 0n && endTime < t + 61n) {
        throw new ValidationError('endTime', `endTime must be 0 (open-ended) or at least 60 s ahead of the next block (${t + 61n}); got ${endTime}.`);
      }
    };
    checkEndTime(now);
    const outcomeCap = maxOutcomes < HARD_MAX_OUTCOMES ? maxOutcomes : HARD_MAX_OUTCOMES;
    const trancheBP = this.checkOutcomesAndTranches(outcomes.length, trancheIn, outcomeCap);
    if (gating && !params.approval) {
      const wall = BigInt(Math.floor(Date.now() / 1000));
      checkGateInputs({ name, symbol, outcomes, description: params.description, endTime }, now > wall ? now : wall);
    }

    const sizes = await this.reader.marketSizes(host, main, outcomes.length);
    const floor = minUnits * sizes.unit;
    const step = sizes.seedStep;
    const seed = params.seed == null ? floor : parseAmount(params.seed, info.pairDecimals, 'seed');
    if (seed < 0n) throw new ValidationError('seed', 'seed must not be negative.');
    if (seed < floor || (seed !== 0n && step > 0n && seed % step !== 0n)) {
      const f = pairAmount(floor, info);
      const st = pairAmount(step, info);
      throw new ValidationError(
        'seed',
        `seed must be at least ${f.formatted} ${f.symbol} and a multiple of ${st.formatted} ${st.symbol}` +
        `${floor === 0n ? ' (or 0)' : ''}; got ${pairAmount(seed, info).formatted}.`,
      );
    }
    if (!(await this.pairActive(main, ecoSwap))) {
      throw new ValidationError('pair not active', `Main ${info.symbol} (${main}) is on a paused pair: no market can be created on it until the pair is active again.`);
    }
    if (frozen && presaleTokens === 0n) {
      throw new ValidationError('frozen needs presale', 'A frozen (invite-only) market token needs presaleTokens > 0.');
    }
    const taxes = this.client.addresses.taxes;
    if (!isZeroAddress(taxes) && seed > 0n) {
      const registered = await pc.readContract({ address: taxes, abi: TaxesAbi, functionName: 'isPrediction', args: [host] });
      if (!registered) {
        throw new ValidationError('convert closed', `The ${this.marketType} host ${host} cannot convert a seed right now: no market can be seeded.`);
      }
    }
    if (seed > 0n && !(await pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'tradingEnabled' }))) {
      throw new ValidationError('Trading is not enabled', `Trading on main ${info.symbol} (${main}) has not opened yet: no seeded market can be created on it until it does.`);
    }
    if (seed > 0n) await refusePausedAsset(this.client, ecoAsset, info.pairSymbol, 'no seed can be paid in');

    const [feeWhitelisted, feeAmount] = await Promise.all([
      pc.readContract({ address: ecoFactory, abi: FactoryAbi, functionName: 'feeWhitelist', args: [host] }),
      pc.readContract({ address: ecoFactory, abi: FactoryAbi, functionName: 'feeAmount' }),
    ]);
    const value = feeWhitelisted ? 0n : feeAmount;
    const [seedBalance, nativeBalance] = await Promise.all([
      seed > 0n ? this.balanceOf(ecoAsset, sender) : Promise.resolve(0n),
      value > 0n ? pc.getBalance({ address: sender }) : Promise.resolve(0n),
    ]);
    if (seedBalance < seed) {
      throw new ValidationError('insufficient balance', `The seed needs ${pairAmount(seed, info).formatted} ${info.pairSymbol}; the wallet holds ${pairAmount(seedBalance, info).formatted}.`);
    }
    if (nativeBalance < value) {
      throw new ValidationError('insufficient balance', `The creation fee is ${value} wei of the native coin; the wallet holds ${nativeBalance}.`);
    }

    let approval: MarketApproval | null = null;
    let sent: MarketApprovalSigned = { name, symbol, outcomes };
    if (gating) {
      if (isZeroAddress(signer)) {
        throw new ValidationError('Signer unset', `The ${this.marketType} market host cannot check market approvals yet: no market can be created yet.`);
      }
      let contentHash: Hex | undefined;
      if (params.approval) {
        approval = params.approval;
      } else {
        const res = await this.client.api.approveMarket({
          marketType: this.marketType,
          name,
          symbol,
          description: params.description ?? undefined,
          outcomes,
          endTime,
          main,
          seedAmount: seed,
          privateEvent: this.marketType === 'private' ? privateEvent : undefined,
        });
        if (!res.approved) {
          throw new ValidationError('market rejected', `BASIS did not approve the market${res.category ? ` (${res.category})` : ''}: ${res.reason ?? 'no reason given'}.`);
        }
        if (res.verifyingContract.toLowerCase() !== host.toLowerCase()) {
          throw new ValidationError('Invalid approval', `The approval is for host ${res.verifyingContract}, not the ${this.marketType} host ${host}.`);
        }
        if (res.chainId != null && res.chainId !== this.client.chainId) {
          throw new ValidationError('Invalid approval', `The approval is for chain ${res.chainId}, not ${this.client.chainId}.`);
        }
        approval = { signature: res.signature, deadline: res.deadline, signed: res.signed };
        contentHash = res.contentHash;
      }
      sent = { name: approval.signed.name, symbol: approval.signed.symbol, outcomes: [...approval.signed.outcomes] };
      if (approval.signed.endTime != null && BigInt(approval.signed.endTime) !== endTime) {
        throw new ValidationError('Invalid approval', `The approval signs endTime ${approval.signed.endTime}, but ${endTime} was requested.`);
      }
      if (approval.deadline <= now) throw new ValidationError('Approval expired', `The approval expired at ${approval.deadline} (chain time ${now}). Request a new one.`);
      this.checkOutcomesAndTranches(sent.outcomes.length, trancheBP, outcomeCap);
      if (sent.outcomes.length !== outcomes.length) {
        throw new ValidationError('Invalid approval', `The approval signs ${sent.outcomes.length} outcomes, but ${outcomes.length} were requested.`);
      }
      await verifyMarketApproval({
        host,
        chainId: this.client.chainId,
        creator: sender,
        name: sent.name,
        symbol: sent.symbol,
        outcomes: sent.outcomes,
        endTime,
        deadline: approval.deadline,
        signature: approval.signature,
        expectedSigner: signer,
        contentHash,
      });
    }

    try {
      if (approval || endTime !== 0n) {
        const t = await this.chainTime();
        checkEndTime(t);
        if (approval && approval.deadline <= t) throw new ValidationError('Approval expired', `The approval expired at ${approval.deadline} (chain time ${t}). Request a new one.`);
      }
      if (seed > 0n) await this.ensureAllowance(ecoAsset, host, seed);
    } catch (e) {
      throw deadApproval(e) ? e : handBack(e, approval);
    }
    const pairOf = pairAmountOf(info);

    let tx: TxResult;
    try {
      tx = await this.sendCreate({
        name: sent.name,
        symbol: sent.symbol,
        outcomes: sent.outcomes,
        endTime,
        trancheBP,
        main,
        frozen,
        presaleTokens,
        seed,
        privateEvent,
        deadline: approval ? approval.deadline : 0n,
        signature: approval ? approval.signature : '0x',
        value,
      });
    } catch (e) {
      throw e instanceof TxNotConfirmedError || deadApproval(e) ? e : handBack(e, approval);
    }

    const created = this.events(tx, HOST_ABI, 'MarketCreated', host).find((e) => isAddressEqual(e.creator, sender));
    if (!created) addMissingEventWarning(tx, this.contractName, 'MarketCreated', ['market', 'frozen']);
    const market = created ? created.marketToken : null;
    const seeded = market ? this.events(tx, HOST_ABI, 'MarketSeeded', host).find((e) => isAddressEqual(e.marketToken, market)) : undefined;
    if (market && !seeded && seed > 0n) addMissingEventWarning(tx, this.contractName, 'MarketSeeded', ['seedAmount', 'seedTokens', 'sharesPerOutcome']);
    const noSeed = market && !seeded && seed === 0n;
    let frozenNow: boolean | null = null;
    if (market) {
      try {
        frozenNow = await pc.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'frozen' });
      } catch (e) {
        const msg = `Could not read frozen() of the new market ${market} after tx ${tx.hash}: ${errorText(e)}. The transaction is confirmed: do not resend it.`;
        tx.warnings.push(msg);
        console.warn(`[basis-sdk] ${msg}`);
      }
    }
    const tokensOf = (raw: bigint) => toAmount(raw, 18, 'token', market!, sent.symbol);
    return {
      ...tx, market, approval, sent,
      seedAmount: seeded ? pairOf(seeded.seedAmount) : noSeed ? pairOf(0n) : null,
      seedTokens: seeded ? tokensOf(seeded.seedToken) : noSeed ? tokensOf(0n) : null,
      sharesPerOutcome: seeded ? seeded.sharesPerOutcome : noSeed ? 0n : null,
      frozen: frozenNow,
    };
  }

  /**
   * createMarket, then the image upload and metadata registration. Checked before any approval request or gas: the
   * image argument, the metadata fields (description 5000 characters; website, telegram and twitterx as the API checks
   * them, see `MarketMetadataOptions`), `outcomeArt` against the outcome labels and the site's picture library, the API
   * credentials (an API key or a SIWE session), the image itself (an `imageUrl` is downloaded and resized to 512x512
   * WebP here; an `imageFile` must be png, jpeg, gif or webp by its bytes and at most 5 MB), then every create rule.
   * Never throws after the create tx: a failed upload comes back in `uploadError` (with a warning); finish it with
   * `retryMarketMetadata(market, ...)`. Calling this again would create a second market. A create whose receipt
   * cannot be read throws `TxNotConfirmedError` whose `note` points to `retryMarketMetadata` (no upload was made); an
   * unconfirmed seed approval created nothing, so its error has no note (and carries the approval, see
   * `ErrorWithMarketApproval`).
   */
  protected async createMarketWithMetadataInternal(
    paramsIn: (CreateMarketParams & MarketMetadataOptions) | null | undefined,
    privateEvent: boolean,
    keys: OptionKeys<any> = CREATE_MARKET_WITH_METADATA_KEYS,
  ): Promise<CreateMarketWithMetadataResult> {
    const params = optsOf(paramsIn, keys);
    if (!params.imageUrl && !params.imageFile) throw new ValidationError('imageRequired', 'Either imageUrl or imageFile is required.');
    if (params.imageUrl && params.imageFile) throw new ValidationError('imageRequired', 'Give imageUrl or imageFile, not both.');
    checkMetadataFields(params);
    checkMarketText(params.name, params.symbol, params.outcomes);
    const art = params.outcomeArt ?? undefined;
    if (art !== undefined) checkOutcomeArt(art, params.outcomes);
    this.client.api.checkUploadAuth();
    if (art !== undefined) await this.checkArtLibrary(art);
    const image = await this.prepareImage(params);

    let created: CreateMarketResult;
    try {
      created = await this.createMarketInternal(params, privateEvent, ANY_KEYS);
    } catch (e) {
      if (e instanceof TxNotConfirmedError && e.functionName === 'createMarket') {
        throw e.withNote(
          'The image and metadata were NOT uploaded (they need the market address). Once the tx is mined, read the market '
          + "(its MarketCreated log, or client.api.getWalletMarkets) and call retryMarketMetadata(market, ...); do not create the market again.",
        );
      }
      throw e;
    }
    if (!created.market) {
      const uploadError: MarketUploadError = {
        stage: 'market', code: null, status: null,
        message: `the market address is unknown (no MarketCreated log in ${created.hash}): find it with client.api.getWalletMarkets or the host's events, then call retryMarketMetadata.`,
      };
      created.warnings.push(`Market created (tx ${created.hash}) but ${uploadError.message} Do not create it again.`);
      return { ...created, imageUrl: null, metadata: null, uploadError };
    }
    const uploaded = await this.uploadMarketMetadata(created.market, image, null, params);
    if (uploaded.uploadError) {
      created.warnings.push(
        `Market ${created.market} was created (tx ${created.hash}) but the ${uploaded.uploadError.stage} upload failed: ` +
        `${uploaded.uploadError.message} Finish it with retryMarketMetadata(market, ...); do not create the market again.`,
      );
    } else {
      const rc = created.receipt as { from?: Address; to?: Address | null } | undefined;
      await this.client.syncTx(created.hash, { from: rc?.from, to: rc?.to ?? undefined });
    }
    return { ...created, ...uploaded };
  }

  /**
   * Finish the uploads of a market whose `createMarketWithMetadata` returned an `uploadError` (or any market the signer
   * created on this host). Give exactly one image source: `imageUrl` / `imageFile` (uploaded as in
   * createMarketWithMetadata) or `hostedImageUrl` (an image already hosted for it). Same pre-checks (`outcomeArt`
   * against the market's outcome names on chain and the site's picture library: a lookup that gets no answer refuses
   * with 'outcomeArtUnreachable' before any upload); sends no tx. Upload failures come back in `uploadError` (no
   * throw). `options` left out or null: none given (then 'imageRequired'), as in PY.
   */
  async retryMarketMetadata(market: Address, optionsIn?: RetryMarketMetadataOptions | null): Promise<MarketMetadataResult> {
    const options = optsOf(optionsIn, RETRY_MARKET_METADATA_KEYS);
    market = toAddress(market, 'market');
    const sources = [options.imageUrl, options.imageFile, options.hostedImageUrl].filter((v) => v !== undefined && v !== null && v !== '');
    if (sources.length !== 1) throw new ValidationError('imageRequired', 'Give exactly one of imageUrl, imageFile or hostedImageUrl.');
    checkMetadataFields(options);
    if (options.hostedImageUrl && options.hostedImageUrl.length > METADATA_MAX_LENGTH.image) {
      throw new ValidationError('metadataTooLong', `hostedImageUrl is ${options.hostedImageUrl.length} characters; the API takes at most ${METADATA_MAX_LENGTH.image}.`);
    }
    const art = options.outcomeArt ?? undefined;
    if (art !== undefined) checkOutcomeArt(art, null);
    await this.requireCreator(market);
    if (art !== undefined) checkOutcomeArt(art, await this.getOptionNames(market));
    this.client.api.checkUploadAuth();
    if (art !== undefined) await this.checkArtLibrary(art);
    const image = options.hostedImageUrl ? null : await this.prepareImage(options);
    return this.uploadMarketMetadata(market, image, options.hostedImageUrl ?? null, options);
  }

  /**
   * Each picked picture id against the site's library: a HEAD of its file on the API's site (`/outcome-art/<id>.svg` or
   * `.webp`: the format the site serves that set in first, the other one after a 404), a few at a time. Runs after
   * `checkOutcomeArt` (ids well formed, each once) and before any approval request, upload or tx; refuses, never warns:
   * - ids answered 404 / 410 in both formats: `ValidationError('outcomeArt')` naming them. When no picked id was found,
   *   a picture every library has (`answers/yes`) is looked up too: not found as well means the site serves no library
   *   (or did not answer), which is refused as below;
   * - ids that got no clear answer (network error, timeout, another status; a browser page on another origin cannot
   *   read the answer), or a site without the library: `ValidationError('outcomeArtUnreachable')` naming them. Nothing
   *   was sent: try again.
   */
  protected async checkArtLibrary(art: Record<string, string>): Promise<void> {
    const ids = Object.values(art);
    /** One file: 'ok', 'missing' (404 / 410), or why it could not be looked up. */
    const head = async (path: string): Promise<string> => {
      try {
        const { res } = await fetchWithDeadline(`${this.client.apiDomain}${path}`, { method: 'HEAD', ...credentialsFor(this.client, false) }, {
          timeoutMs: ART_CHECK_TIMEOUT_MS, what: `HEAD ${path}`,
        });
        if (res.ok) return 'ok';
        return res.status === 404 || res.status === 410 ? 'missing' : `HTTP ${res.status}`;
      } catch (e) {
        return errorText(e).replace(/^\[basis-sdk\] /, '');
      }
    };
    /** One id: its set's format first, the other format after a 404. */
    const one = async (id: string): Promise<string> => {
      const exts = ART_SVG_SETS.has(id.split('/')[0]) ? ['svg', 'webp'] : ['webp', 'svg'];
      const first = await head(`/outcome-art/${id}.${exts[0]}`);
      return first === 'missing' ? head(`/outcome-art/${id}.${exts[1]}`) : first;
    };
    /** Per id: 'ok', 'missing', or why it could not be looked up. */
    const answers = new Map<string, string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++];
        answers.set(id, await one(id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(ART_CHECK_CONCURRENCY, ids.length) }, worker));
    const missing = ids.filter((id) => answers.get(id) === 'missing');
    const unreachable = (which: string[], why: string): ValidationError => new ValidationError(
      'outcomeArtUnreachable',
      `Could not reach the site's picture library to check outcome picture${which.length === 1 ? '' : 's'} ${which.join(', ')} `
      + `(${why}). Nothing was sent: try again.`,
    );
    if (missing.length && !ids.some((id) => answers.get(id) === 'ok')) {
      const probe = answers.get(ART_PROBE_ID) ?? await one(ART_PROBE_ID);
      if (probe !== 'ok') {
        throw unreachable(ids, probe === 'missing' ? `${this.client.apiDomain} serves no picture library at /outcome-art` : probe);
      }
    }
    if (missing.length) {
      throw new ValidationError('outcomeArt', `outcomeArt picks ${missing.length === 1 ? 'a picture' : 'pictures'} the site's library does not have: ${missing.join(', ')}. Nothing was sent.`);
    }
    const unchecked = ids.filter((id) => answers.get(id) !== 'ok');
    if (unchecked.length) throw unreachable(unchecked, answers.get(unchecked[0])!);
  }

  /** The image bytes to upload, checked before any tx: downloaded and resized (`imageUrl`) or as given (`imageFile`). */
  private async prepareImage(o: { imageUrl?: string; imageFile?: Blob | Uint8Array | null }): Promise<{ bytes: Uint8Array; mime: string }> {
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

  /** Upload the image (unless already hosted) and the metadata of `market`. Never throws: failures go in `uploadError`. */
  private async uploadMarketMetadata(
    market: Address, image: { bytes: Uint8Array; mime: string } | null, hosted: string | null, fields: MarketMetadataOptions & { description?: string },
  ): Promise<MarketMetadataResult> {
    let imageUrl: string | null = hosted;
    try {
      if (image) imageUrl = await this.client.api.uploadImage(image.bytes, `${market}.${IMAGE_EXT[image.mime]}`, 'token', market);
    } catch (e) {
      return { imageUrl: null, metadata: null, uploadError: uploadErrorOf('image', e) };
    }
    try {
      const metadata = await this.client.api.updateMetadata({
        address: market, description: fields.description ?? undefined, image: imageUrl!,
        website: fields.website ?? undefined, telegram: fields.telegram ?? undefined, twitterx: fields.twitterx ?? undefined,
        ...(fields.outcomeArt != null ? { outcomeArt: fields.outcomeArt } : {}),
      });
      return { imageUrl, metadata, uploadError: null };
    } catch (e) {
      return { imageUrl, metadata: null, uploadError: uploadErrorOf('metadata', e) };
    }
  }

  /**
   * 2..cap outcomes; `bp`: 1-10 entries, at most the outcomes, each a whole number of at least n bps (a JS number or a
   * bigint; strings, booleans and fractions are refused, nothing is coerced), never increasing, sum 10000. Returns the
   * slices as numbers.
   */
  protected checkOutcomesAndTranches(n: number, bp: readonly unknown[], cap: bigint): number[] {
    if (n < 2 || BigInt(n) > cap) throw new ValidationError('outcomes', `A market needs 2-${cap} outcomes; got ${n}.`);
    if (bp.length < 1 || bp.length > MAX_TRANCHES) throw new ValidationError('trancheBP', `trancheBP needs 1-${MAX_TRANCHES} entries; got ${bp.length}.`);
    if (bp.length > n) throw new ValidationError('trancheBP', `trancheBP has ${bp.length} slices but the market has only ${n} outcomes.`);
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < bp.length; i++) {
      const v = bp[i];
      const b = typeof v === 'bigint' && v > 0n && v <= 10000n ? Number(v) : v;
      if (typeof b !== 'number' || !Number.isInteger(b) || b <= 0 || b > 10000) {
        throw new ValidationError('trancheBP', `trancheBP[${i}] must be a whole number of bps above 0; got ${typeof v === 'string' ? `'${v}'` : String(v)}.`);
      }
      if (b < n) throw new ValidationError('trancheBP', `Every slice must be at least ${n} bps on a market of ${n} outcomes; trancheBP[${i}] is ${b}.`);
      if (i > 0 && b > out[i - 1]) throw new ValidationError('trancheBP', `trancheBP must never increase: entry ${i} (${b}) is above entry ${i - 1} (${out[i - 1]}).`);
      out.push(b);
      sum += b;
    }
    if (sum !== 10000) throw new ValidationError('trancheBP', `trancheBP must sum to 10000; got ${sum}.`);
    return out;
  }


  /**
   * Bet on `outcome`. `amount` is raw input-token units (bigint) or a human string/number in the input's decimals.
   * Refused with `ValidationError(reason)` when `checkBuy` refuses it. The minimums come from `marketReader.quoteBet`
   * (never 0); explicit `minShares` / `minTokens` must be whole numbers above 0 (`ValidationError('minShares' /
   * 'minTokens')`, checked before any read). On a direct route (the input is the pair asset, the main or the market
   * token) an explicit floor above what the quote shows the bet gets now is refused under the same rule, before the
   * approval (the host would refuse it with no reason). The input is approved to the host. `opts.deadline` (default latest block +
   * 600 s) bounds the conversion of the input ("Deadline" revert); an explicit one before the latest block time is
   * refused (`ValidationError('Deadline')`, as `checkDeadline`: the host takes a deadline up to and including the time
   * of the block that runs it). A null option (or null `opts`) is left out, as None in
   * PY; an `opts` that is not an options object (a positional `minShares`, say) is `ValidationError('options')`, before
   * any read.
   */
  async buy(market: Address, outcome: number, amount: bigint | string | number, opts: MarketBuyOptions | null = {}): Promise<BuyResult> {
    const o = optsOf(opts, MARKET_BUY_KEYS);
    market = toAddress(market, 'market');
    const inputIn = o.input == null ? undefined : toAddress(o.input, 'input');
    const minSharesIn = optUint(o.minShares ?? undefined, 'minShares');
    const minTokensIn = optUint(o.minTokens ?? undefined, 'minTokens');
    if (minSharesIn === 0n) throw new ValidationError('minShares', 'A zero minShares is never sent; omit it to derive it from a quote.');
    if (minTokensIn === 0n) throw new ValidationError('minTokens', 'A zero minTokens is never sent; omit it to derive it from a quote.');
    const host = this.address;
    const buyer = this.account;
    const md = await this.requireMarket(market);
    const input = inputIn ?? md.pairAsset;
    const raw = typeof amount === 'bigint' ? amount : parseAmount(amount, (await this.client.mains.tokenMeta(input)).decimals);

    const block = await this.buyBlock(market, md, outcome, buyer, input);
    if (block) throw new ValidationError(block.reason, block.message);
    if (raw <= 0n) throw new ValidationError('amount', 'amount must be above 0.');
    const explicitDeadline = o.deadline == null ? undefined : toUint(o.deadline, 'deadline');
    if (explicitDeadline !== undefined) checkDeadline(explicitDeadline, await this.chainTime());
    const balance = await this.balanceOf(input, buyer);
    if (balance < raw) throw new ValidationError('insufficient balance', `The bet needs ${raw} raw units of ${input}; the wallet holds ${balance}.`);

    let minShares = minSharesIn;
    let minTokens = minTokensIn;
    const q = await this.reader.quoteBet({ market, outcome, input, amount: raw, host, bettor: buyer, slippageBps: o.slippageBps ?? undefined });
    minShares ??= q.minShares;
    minTokens ??= q.minTokens;
    if (minShares <= 0n) throw new ValidationError('minShares', 'The quote gives 0 shares: the bet is too small.');
    if (minTokens <= 0n) throw new ValidationError('minTokens', 'The quote gives 0 market tokens: the bet is too small.');
    if (q.route === 'direct') {
      refuseAboveQuote(minSharesIn, q.shares, 'minShares', 'the shares this bet buys');
      const f = BigInt(q.feeBps);
      const tokensMax = isAddressEqual(q.convertedToken, market) || f <= 0n || f >= 10_000n ? q.tokens : (q.netToken * 10_000n) / (10_000n - f);
      refuseAboveQuote(minTokensIn, tokensMax, 'minTokens', 'the market tokens this bet converts to');
    }

    await this.ensureAllowance(input, host, raw);
    const [inputOf, tokensOf] = await this.marketFormatters(market, md, input);
    const deadline = explicitDeadline ?? await this.blockDeadline(BUY_DEADLINE_SECONDS);
    const tx = await this.send({
      address: host, abi: HOST_ABI, functionName: 'buy',
      args: [market, outcome, input, raw, minTokens, minShares, deadline],
      contract: this.contractName,
    });
    const traded = this.events(tx, HOST_ABI, 'SharesTraded', host)
      .find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.buyer, buyer) && e.outcomeId === outcome);
    const funded = this.events(tx, HOST_ABI, 'BetFunded', host).find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.buyer, buyer));
    if (!traded) addMissingEventWarning(tx, this.contractName, 'SharesTraded', ['shares', 'netTokens', 'fee']);
    if (!funded) addMissingEventWarning(tx, this.contractName, 'BetFunded', ['tokens']);
    return {
      ...tx, input, amount: inputOf(raw), minShares, minTokens: tokensOf(minTokens), deadline,
      shares: traded ? traded.shares : null, tokens: optAmount(tokensOf, funded?.tokens),
      netTokens: optAmount(tokensOf, traded?.usdcSpent), fee: optAmount(tokensOf, traded?.fee),
    };
  }

  /**
   * Formatters for a market's write results, resolved before sending: `input` (default the market's pair asset) and the
   * market token (unit `token`). The pair asset is the market's own (`md.pairAsset`, its main's).
   */
  protected async marketFormatters(market: Address, md: MarketData, input?: Address): Promise<[AmountOf, AmountOf]> {
    const info = await this.client.mains.get(md.main);
    return Promise.all([amountOf(this.client, input ?? md.pairAsset, info), amountOf(this.client, market, info)]);
  }

  /**
   * Read-only bet eligibility: the rules `buy` checks before sending, in order. Host paused, market resolved, outcome
   * range; then on the public host endTime and a live proposal (dated or open-ended), on the private host the invite
   * list, endTime and the first vote (open-ended); then the frozen whitelist, whether bets can be paid in right now
   * ('convert closed') and the market's main is on an active pair ('pair not active'; a bet paid in the market token
   * itself with no fee is not affected), and, for a bet paid in anything but the market token or the main (or with a
   * bet fee), whether the main's trading has opened ('Trading is not enabled') and whether an issuer has paused an
   * asset the bet moves ('pair asset paused'): the pair asset of another pair that a BASIS token paid in is first sold
   * for (selling a factory token also pays out the bettor's pending holder rewards in it), then the market's own pair
   * asset. `reason` is the first rule that refuses, named as `buy` would throw it.
   * Amount, balance and minimums are not checked.
   */
  async checkBuy(market: Address, outcome: number, opts: CheckBuyOptions | null = {}): Promise<BuyCheck> {
    const o = optsOf(opts, CHECK_BUY_KEYS);
    market = toAddress(market, 'market');
    const buyerIn = o.buyer == null ? undefined : toAddress(o.buyer, 'buyer');
    const inputIn = o.input == null ? undefined : toAddress(o.input, 'input');
    const md = await this.requireMarket(market);
    const block = await this.buyBlock(market, md, outcome, buyerIn ?? this.account, inputIn ?? md.pairAsset);
    return block ? { canBet: false, reason: block.reason, message: block.message } : { canBet: true, reason: null, message: null };
  }

  /** The first rule that refuses a bet of `buyer` paying in `input`, or null (the host's rules, then conversion). */
  protected async buyBlock(market: Address, md: MarketData, outcome: number, buyer: Address, input: Address): Promise<BuyBlock | null> {
    const host = this.address;
    const [paused, n, now, frozen] = await Promise.all([
      this.publicClient.readContract({ address: host, abi: HOST_ABI, functionName: 'paused' }),
      this.getNumOutcomes(market),
      this.chainTime(),
      this.publicClient.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'frozen' }),
    ]);
    if (paused) return { reason: 'host paused', message: `The ${this.marketType} market host is paused: no bets.` };
    if (md.resolved) return { reason: 'market resolved', message: `Market ${market} is resolved: betting is over.` };
    if (!Number.isInteger(outcome) || outcome < 0 || outcome >= n) return { reason: 'outcome', message: `outcome must be 0-${n - 1}; got ${outcome}.` };
    const closed: BuyBlock | null = md.endTime !== 0n && now + 1n >= md.endTime
      ? { reason: 'Betting closed', message: `Betting closed at ${md.endTime} (chain time ${now}).` }
      : null;
    const hostBlock = await this.precheckBuyHost(market, md, buyer, closed);
    if (hostBlock) return hostBlock;
    if (frozen) {
      const wl = await this.publicClient.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'whitelisted', args: [buyer] });
      if (!wl) return { reason: 'not whitelisted', message: `Market token ${market} is frozen and ${buyer} is not on its whitelist.` };
    }
    const taxes = this.client.addresses.taxes;
    const inMarket = input.toLowerCase() === market.toLowerCase();
    const inMain = input.toLowerCase() === md.main.toLowerCase();
    const fee = (inMarket || inMain) && !isZeroAddress(taxes) && (await this.client.taxes.getTaxRate(market, buyer)) > 0;
    if (inMarket && !fee) return null;
    if (!isZeroAddress(taxes)) {
      const registered = await this.publicClient.readContract({ address: taxes, abi: TaxesAbi, functionName: 'isPrediction', args: [host] });
      if (!registered) return { reason: 'convert closed', message: `The ${this.marketType} host ${host} cannot convert a bet right now: no bets.` };
    }
    if (!(await this.pairActive(md.main))) {
      return { reason: 'pair not active', message: `Market ${market} settles through main ${md.main}, which is on a paused pair: no bets that convert through it until the pair is active again.` };
    }
    if ((!inMarket && !inMain) || fee) {
      const open = (await this.client.mains.get(md.main)).tradingEnabled
        || (await this.publicClient.readContract({ address: md.main, abi: MainTokenAbi, functionName: 'tradingEnabled' }));
      if (!open) {
        return {
          reason: 'Trading is not enabled',
          message: `Trading on main ${md.main} has not opened yet: no bets on market ${market} that buy or sell it until it does.`,
        };
      }
      if (!inMarket && !inMain && !isAddressEqual(input, md.pairAsset)) {
        const sale = await inputSaleAsset(this.client, input, md.main, md.pairAsset);
        if (sale && (await isAssetPaused(this.client, sale.asset))) {
          return { reason: 'pair asset paused', message: pairAssetPausedMessage(sale.asset, sale.symbol, inputSalePaused(input, sale.factoryToken)) };
        }
      }
      if (await isAssetPaused(this.client, md.pairAsset)) {
        return { reason: 'pair asset paused', message: pairAssetPausedMessage(md.pairAsset, (await this.client.mains.get(md.main)).pairSymbol, BET_PAUSED) };
      }
    }
    return null;
  }

  /**
   * Redeem a resolved market (winnings, or the cost-basis refund on INVALID) into the pair asset.
   * Sells `fractionBps` of the remaining entitlement in `slices`; defaults and `minOut` come from `marketReader.redeemPlan`.
   * The plan always runs, also when all three are given (they are then sent as given): it refuses a main on a paused
   * pair ('pair not active') and slices that pay out 0 ('dust slice'), which the host reverts with no reason; then
   * 'pair asset paused' (its issuer paused the pair asset the payout is made in). An
   * explicit `minOut` is a whole number above 0 (`ValidationError('minOut')`, checked before any read, as `buy`'s
   * minimums). A null option (or null `opts`) is left out, as None in PY; an `opts` that is not an
   * options object is `ValidationError('options')`, before any read.
   */
  async redeem(market: Address, opts: RedeemOptions | null = {}): Promise<RedeemResult> {
    const o = optsOf(opts, REDEEM_KEYS);
    market = toAddress(market, 'market');
    const minOutIn = optUint(o.minOut ?? undefined, 'minOut');
    if (minOutIn === 0n) throw new ValidationError('minOut', 'A zero minOut is never sent; omit it to derive it from a quote.');
    const fractionIn = o.fractionBps ?? undefined;
    const slicesIn = o.slices ?? undefined;
    const host = this.address;
    const user = this.account;
    const md = await this.requireMarket(market);
    if (!md.resolved) throw new ValidationError('market unresolved', `Market ${market} is not resolved yet.`);
    if (fractionIn !== undefined && (typeof fractionIn !== 'number' || !Number.isInteger(fractionIn) || fractionIn < 1 || fractionIn > 10000)) {
      throw new ValidationError('fraction 1-10000', `fractionBps must be 1-10000; got ${fractionIn}.`);
    }
    if (slicesIn !== undefined && (typeof slicesIn !== 'number' || !Number.isInteger(slicesIn) || slicesIn < 1 || slicesIn > MAX_SLICES)) {
      throw new ValidationError('slices 1-25', `slices must be 1-${MAX_SLICES}; got ${slicesIn}.`);
    }
    const owed = await this.quoteRedeem(market, user);
    if (owed === 0n) throw new ValidationError('Nothing to redeem', `${user} has nothing to redeem on market ${market}.`);

    const plan = await this.reader.redeemPlan({
      market, user, fractionBps: fractionIn, slices: slicesIn, minOut: minOutIn, slippageBps: o.slippageBps ?? undefined, host,
    });
    const fractionBps = Number(plan.fractionBps);
    const slices = Number(plan.slices);
    const minOut = plan.minOut;
    if (await isAssetPaused(this.client, md.pairAsset)) {
      throw pairAssetPaused(md.pairAsset, (await this.client.mains.get(md.main)).pairSymbol, 'no redemption can pay it out');
    }
    const [pairOf, tokensOf] = await this.marketFormatters(market, md);

    const tx = await this.send({
      address: host, abi: HOST_ABI, functionName: 'redeem',
      args: [market, fractionBps, BigInt(slices), minOut],
      contract: this.contractName,
    });
    const ev = this.events(tx, HOST_ABI, 'SharesRedeemed', host).find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.user, user));
    if (!ev) addMissingEventWarning(tx, this.contractName, 'SharesRedeemed', ['payout', 'tokens', 'remaining']);
    return {
      ...tx, fractionBps, slices, minOut: pairOf(minOut),
      payout: optAmount(pairOf, ev?.payout), tokens: optAmount(tokensOf, ev?.tokens), remaining: optAmount(tokensOf, ev?.remaining),
    };
  }

  /** End the market token's whitelist (frozen) phase. Creator only. `frozen` is false once the token logged `FreezeLifted`. */
  async disableFreeze(market: Address): Promise<MarketDisableFreezeResult> {
    market = toAddress(market, 'market');
    await this.requireCreator(market);
    const tx = await this.send({ address: this.address, abi: HOST_ABI, functionName: 'disableFreeze', args: [market], contract: this.contractName });
    const lifted = this.events(tx, FactoryTokenAbi, 'FreezeLifted', market).length > 0;
    if (!lifted) addMissingEventWarning(tx, 'FactoryToken', 'FreezeLifted', ['frozen']);
    return { ...tx, frozen: lifted ? false : null };
  }

  /**
   * A whitelist tag (a label stored on chain with the entries): left out or null = '' (as None in PY), else a string
   * (`ValidationError('tag')`) of well-formed text (`checkText`: a lone surrogate would go on chain as U+FFFD).
   */
  protected whitelistTag(tag: unknown): string {
    const t = tag ?? '';
    if (typeof t !== 'string') throw new ValidationError('tag', `tag must be a string, got ${String(t)}.`);
    checkText(t, 'tag');
    return t;
  }

  /**
   * The wallets of a whitelist write, checked before any read, as in PY: a non-empty array ('no wallets provided'
   * otherwise: left out, null, empty, one address as a string, a Set) of strict addresses (`toAddress`, the rule is
   * `field`).
   */
  protected walletList(v: unknown, field: 'wallets' | 'buyers'): Address[] {
    if (!Array.isArray(v) || v.length === 0) {
      throw new ValidationError('no wallets provided', `${field} must be a non-empty array of addresses, got ${Array.isArray(v) ? 'an empty array' : kindOf(v)}.`);
    }
    return v.map((w) => toAddress(w, field));
  }

  /**
   * What the market token logged for a whitelist write: wallets newly listed (`WhiteListedWallet`), the requested
   * ones it skipped because they were listed already (their cap is unchanged), and wallets removed.
   */
  protected whitelistResult(tx: TxResult, market: Address, requested: readonly Address[], adding: boolean): MarketWhitelistResult {
    const listed = this.events(tx, FactoryTokenAbi, 'WhiteListedWallet', market).map((e) => e.user);
    const removed = this.events(tx, FactoryTokenAbi, 'WhitelistRemoved', market).map((e) => e.user);
    const capUnchanged: Address[] = [];
    if (adding) {
      for (const w of requested) {
        if (!listed.some((l) => isAddressEqual(l, w)) && !capUnchanged.some((c) => isAddressEqual(c, w))) capUnchanged.push(w);
      }
    }
    return { ...tx, listed, capUnchanged, removed };
  }


  /** The market's data with `finalOutcome` decoded (254 = INVALID, 255 = unresolved). A zero `marketToken` means "not on this host". */
  async getMarketData(market: Address): Promise<MarketData> {
    market = toAddress(market, 'market');
    const d = await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getMarketData', args: [market] });
    const fo = Number(d.finalOutcome);
    const status: MarketStatus = !d.resolved || fo === OUTCOME_UNRESOLVED ? 'unresolved' : fo === OUTCOME_INVALID ? 'invalid' : 'resolved';
    return {
      marketToken: d.marketToken,
      creator: d.creator,
      main: d.ecosystem,
      pairAsset: d.usdc,
      marketName: d.marketName,
      creationTime: d.creationTime,
      endTime: d.endTime,
      finalOutcome: fo,
      resolved: d.resolved,
      status,
      winner: status === 'resolved' ? fo : null,
      generalPot: d.generalPot,
      totalOddsWeight: d.totalVirtualReserve,
      isPrivate: d.isPrivate,
    };
  }

  async getOutcome(market: Address, outcome: number): Promise<OutcomeState> {
    market = toAddress(market, 'market');
    const o = await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getOutcome', args: [market, outcome] });
    return { oddsWeight: o.virtualReserve, totalCost: o.totalCost, circulatingShares: o.circulatingShares };
  }

  /** Shares (18 decimals) `user` holds on `outcome`. */
  async getUserShares(market: Address, user: Address, outcome: number): Promise<bigint> {
    market = toAddress(market, 'market');
    user = toAddress(user, 'user');
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getUserShares', args: [market, user, outcome] });
  }

  /** The reference opening pool for `numOutcomes` (market tokens). A market's own sizes: `marketReader.marketSizes`. */
  async getOpeningPool(numOutcomes: number | bigint): Promise<{ perOutcome: bigint; totalPool: bigint }> {
    const [perOutcome, totalPool] = await this.publicClient.readContract({
      address: this.address, abi: HOST_ABI, functionName: 'getInitialReserves', args: [toUint(numOutcomes, 'numOutcomes')],
    });
    return { perOutcome, totalPool };
  }

  async getNumOutcomes(market: Address): Promise<number> {
    market = toAddress(market, 'market');
    return Number(await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getNumOutcomes', args: [market] }));
  }

  async getOptionNames(market: Address): Promise<string[]> {
    market = toAddress(market, 'market');
    return [...await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getOptionNames', args: [market] })];
  }

  async hasBettedOnMarket(market: Address, user: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    user = toAddress(user, 'user');
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'hasBettedOnMarket', args: [market, user] });
  }

  /** Payout slices in bps per finishing position. */
  async getTrancheBP(market: Address): Promise<number[]> {
    market = toAddress(market, 'market');
    return (await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getTrancheBP', args: [market] })).map(Number);
  }

  /** The result in finish order (empty when unresolved or INVALID). */
  async getFinalRanking(market: Address): Promise<number[]> {
    market = toAddress(market, 'market');
    return (await this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'getFinalRanking', args: [market] })).map(Number);
  }

  /**
   * Market tokens (18 decimals) `user` would receive if the market resolved now with (`ranking`, `tieMask`). 0 for an
   * invalid ranking, and for `[]` (INVALID): the host quotes only rankings here. For INVALID use `quoteInvalidRefund`.
   * Checked before any read: `ranking` an array of whole numbers 0-255 ('ranking' / 'rankingEntry'), `tieMask` a whole
   * number ('tieMask', as `marketReader.quoteScenario`: null is refused; left out = 0).
   */
  async quoteScenario(market: Address, ranking: readonly number[], tieMask: bigint | number = 0n, user?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const picks = normalizeRanking(ranking);
    const mask = toUint(tieMask, 'tieMask');
    const who = user == null ? this.account : toAddress(user, 'user');
    return this.publicClient.readContract({
      address: this.address, abi: HOST_ABI, functionName: 'quoteScenario', args: [market, picks, mask, who],
    });
  }

  /**
   * Market tokens (18 decimals) `user` (default the signer) would get back if the market resolved INVALID now. It is
   * based on an average cost, so it can differ from what was paid. `marketReader.quoteInvalidRefund` also gives its
   * value in the pair asset. Rules 'unknown market', 'market resolved' (then `quoteRedeem` gives what is owed).
   */
  async quoteInvalidRefund(market: Address, user?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    return (await this.reader.quoteInvalidRefund(this.address, market, who)).tokenPayout;
  }

  /** Market tokens (18 decimals) `user` can still redeem on a resolved market (0 when unresolved). */
  async quoteRedeem(market: Address, user?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'quoteRedeem', args: [market, who] });
  }

  /** Market tokens (18 decimals) left after a partial redeem (0 before the first redeem or when done). */
  async getPendingPayout(market: Address, user?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'pendingPayout', args: [market, who] });
  }

  /** Unix seconds the market resolved (any path, INVALID included); 0 = unresolved. */
  async getResolvedAt(market: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'resolvedAt', args: [market] });
  }

  /** Seed floor for a new market on `main` (default: the default main), in its pair asset. */
  protected async minSeedAmount(main: MainRef | undefined, privateEvent: boolean): Promise<Amount> {
    const info = main ? await this.client.mains.get(mainArg(main)) : await this.client.mains.default();
    const [units, sizes] = await Promise.all([this.minSeedUnits(privateEvent), this.reader.marketSizes(this.address, info.main, 2)]);
    return pairAmount(units * sizes.unit, info);
  }

  async isGatingEnabled(): Promise<boolean> {
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'gatingEnabled' });
  }

  /** The exact `msg.value` (native wei) `createMarket` needs on `main` (0 when no creation fee applies). */
  async getCreationFee(main?: MainRef): Promise<bigint> {
    const host = this.address;
    const m = main ? this.client.mains.addressOf(mainArg(main)) : this.client.mains.defaultAddress();
    const [factory] = await this.publicClient.readContract({ address: host, abi: HOST_ABI, functionName: 'ecosystems', args: [m] });
    if (isZeroAddress(factory)) throw new ValidationError('ecosystem inactive', `Main ${m} is not registered on the ${this.marketType} market host.`);
    const [whitelisted, fee] = await Promise.all([
      this.publicClient.readContract({ address: factory, abi: FactoryAbi, functionName: 'feeWhitelist', args: [host] }),
      this.publicClient.readContract({ address: factory, abi: FactoryAbi, functionName: 'feeAmount' }),
    ]);
    return whitelisted ? 0n : fee;
  }

  async isPaused(): Promise<boolean> {
    return this.publicClient.readContract({ address: this.address, abi: HOST_ABI, functionName: 'paused' });
  }


  /** The market's data; throws when the market is not on this host. */
  protected async requireMarket(market: Address): Promise<MarketData> {
    const md = await this.getMarketData(market);
    if (isZeroAddress(md.marketToken) || md.marketToken.toLowerCase() !== market.toLowerCase()) {
      throw new ValidationError('unknown market', `${market} is not a market on the ${this.marketType} host ${this.address}.`);
    }
    return md;
  }

  /** The market's data; throws unless the signer created it. */
  protected async requireCreator(market: Address): Promise<MarketData> {
    const md = await this.requireMarket(market);
    if (md.creator.toLowerCase() !== this.account.toLowerCase()) {
      throw new ValidationError('not creator', `Only the market's creator (${md.creator}) can do this.`);
    }
    return md;
  }
}

/** What a value is in a refusal message, worded as the API's outcomes check words it (`typeof`; null is 'null'). */
const kindOf = (v: unknown): string => (v === null ? 'null' : typeof v);

/**
 * The market's strings go on chain and into the approval hash, checked in this order: `name`, then `symbol`, each a
 * string (left out or null passes unless `required`, then "<field> is required.", as is one that trims to nothing),
 * then `outcomes`, an array of strings (the check and message of the API's `approveMarket`). Anything else is refused,
 * never converted to text ("5", "null", "true" on chain): the rule is the field ('name', 'symbol', 'outcomes'). Each
 * must also be well-formed text (`checkText`): a lone UTF-16 surrogate would be sent as U+FFFD, another string than
 * the one typed (PY cannot encode it at all). Checked before any read, review or approval. Same rules and messages in
 * PY.
 */
function checkMarketText(name: unknown, symbol: unknown, outcomes: unknown, required = false): asserts outcomes is string[] {
  for (const [v, field] of [[name, 'name'], [symbol, 'symbol']] as const) {
    if (v != null && typeof v !== 'string') throw new ValidationError(field, `${field} must be a string, got ${kindOf(v)}.`);
    checkText(v, field);
    if (required && (typeof v !== 'string' || !trimAscii(v))) throw new ValidationError(field, `${field} is required.`);
  }
  if (!Array.isArray(outcomes) || outcomes.some((o) => typeof o !== 'string')) {
    const got = Array.isArray(outcomes) ? 'an array with a non-string entry' : kindOf(outcomes);
    throw new ValidationError('outcomes', `outcomes must be an array of answer strings, got ${got}.`);
  }
  for (const o of outcomes) checkText(o, 'outcomes');
}

/**
 * The approval request's input rules, on the strings as the API trims them (its own `trim()`), with `now` its clock
 * (unix seconds). Only checked when an approval is requested.
 */
function checkGateInputs(p: { name: string; symbol: string; outcomes: readonly string[]; description?: unknown; endTime: bigint }, now: bigint): void {
  const L = GATE_LIMITS;
  const name = p.name.trim();
  if (!name || name.length > L.maxName) {
    throw new ValidationError('name', `The market approval takes a name of 1-${L.maxName} characters; got ${name.length}.`);
  }
  if (!GATE_SYMBOL.test(p.symbol.trim())) {
    throw new ValidationError('symbol', `The market approval takes a symbol of 1-16 letters or digits; got ${JSON.stringify(p.symbol)}.`);
  }
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (description.length > L.maxDescription) {
    throw new ValidationError('description', `The market approval takes a description of at most ${L.maxDescription} characters; got ${description.length}.`);
  }
  if (p.outcomes.length > L.maxOutcomes) {
    throw new ValidationError('outcomes', `The market approval takes at most ${L.maxOutcomes} outcomes; got ${p.outcomes.length}.`);
  }
  p.outcomes.forEach((o, i) => {
    const t = o.trim();
    if (!t || t.length > L.maxOutcomeLen) {
      throw new ValidationError('outcomes', `The market approval takes outcome labels of 1-${L.maxOutcomeLen} characters; outcome ${i} has ${t.length}.`);
    }
  });
  if (p.endTime !== 0n && p.endTime < now + L.minEndAheadS) {
    throw new ValidationError('endTime', `The market approval needs endTime 0 (open-ended) or at least ${L.minEndAheadS} s ahead (${now + L.minEndAheadS}); got ${p.endTime}.`);
  }
  if (p.endTime > now + L.maxEndAheadS) {
    throw new ValidationError('endTime', `The market approval needs endTime within 1825 days (${now + L.maxEndAheadS}); got ${p.endTime}.`);
  }
}

/**
 * `outcomeArt` as POST /api/metadata reads it: an object of { <outcome label>: <picture id> } strings, at most 200
 * entries, each id well formed (`<category>/<name>`), each picture once, each key an outcome of `labels` (compared
 * trimmed with the site's own `trim()`, as it matches them; null = the shape only). The API drops a bad pick silently
 * (that outcome just gets no picture) and the metadata is set once, so a bad pick is refused before any approval
 * request or tx: its shape here, and an id the library does not have in `checkArtLibrary`. Only a plain { ... } (the
 * test `optsOf` uses): a Map, a Date or a class instance shows no entries and would send {}, losing the pictures.
 */
function checkOutcomeArt(art: unknown, labels: readonly string[] | null): void {
  if (art === null || typeof art !== 'object' || Array.isArray(art)
      || (Object.getPrototypeOf(art) !== Object.prototype && Object.getPrototypeOf(art) !== null)
      || Object.values(art).some((v) => typeof v !== 'string')) {
    throw new ValidationError('outcomeArt', 'outcomeArt must be an object of { <outcome label>: <picture id> } strings.');
  }
  const entries = Object.entries(art as Record<string, string>);
  if (entries.length > MAX_ART_ENTRIES) throw new ValidationError('outcomeArt', `outcomeArt takes at most ${MAX_ART_ENTRIES} pictures; got ${entries.length}.`);
  const names = labels ? new Set(labels.map((l) => l.trim())) : null;
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  for (const [key, id] of entries) {
    if (!ART_ID_RE.test(id)) {
      throw new ValidationError('outcomeArt', `outcomeArt[${JSON.stringify(key)}] is ${JSON.stringify(id)}, not a picture id of the library (like 'answers/yes').`);
    }
    if (seenIds.has(id)) throw new ValidationError('outcomeArt', `Picture ${id} is picked twice: each picture can be used once per market.`);
    seenIds.add(id);
    const name = key.trim();
    if (names && !names.has(name)) throw new ValidationError('outcomeArt', `outcomeArt names ${JSON.stringify(key)}, which is not an outcome of this market.`);
    if (seenNames.has(name)) throw new ValidationError('outcomeArt', `outcomeArt names outcome ${JSON.stringify(name)} twice.`);
    seenNames.add(name);
  }
}

/** A failed upload as a `MarketUploadError` (the original error kept as `cause`). */
function uploadErrorOf(stage: 'image' | 'metadata', e: unknown): MarketUploadError {
  const message = String((e as Error)?.message ?? e).replace(/^\[basis-sdk\] /, '');
  if (e instanceof BasisApiError) return { stage, code: e.code, status: e.status, message, cause: e };
  if (e instanceof AuthRequiredError) return { stage, code: 'auth_required', status: null, message, cause: e };
  return { stage, code: null, status: null, message, cause: e };
}
