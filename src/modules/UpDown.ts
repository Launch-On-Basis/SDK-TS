import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { AggregatorV3Abi, ERC20Abi, EcosystemTokenAbi, FactoryAbi, MainTokenAbi, MultiUpDownAbi, SwapAbi, TaxesAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { FEATURES } from '../config/features';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { BasisError, NotDeployedError, ValidationError } from '../core/errors';
import { addMissingEventWarning } from '../core/events';
import { checkDeadline as checkExplicitDeadline, isAssetPaused, pairAssetPaused, refusePausedAsset } from '../core/loans';
import { pinnedClient } from '../core/pinned';
import { isRevertNamed, zeroUnlessRpc } from '../core/revert';
import { type AmountOf, amountOf, optAmount } from '../core/amounts';
import { optionKeys, optsOf } from '../core/opts';
import { Amount, BPS, optUint, parseAmount, toAddress, toAmount, toBool, toUint, validateSlippageBps } from '../core/units';
import type { BetRoute } from './MarketReader';


/** Timeframe ids: 0=5m, 1=15m, 2=1h, 3=4h, 4=24h (`tfDuration(tf)` has the seconds). */
export const Timeframe = { FIVE_MIN: 0, FIFTEEN_MIN: 1, ONE_HOUR: 2, FOUR_HOUR: 3, ONE_DAY: 4 } as const;
export type Timeframe = (typeof Timeframe)[keyof typeof Timeframe];

/** Side enum: 0=None, 1=Bull, 2=Bear. */
export const Side = { NONE: 0, BULL: 1, BEAR: 2 } as const;
export type Side = (typeof Side)[keyof typeof Side];
/** A bet side: 'bull' | 'bear' or the enum value (1 | 2). */
export type SideInput = 'bull' | 'bear' | 1 | 2;

/** Outcome enum: 0=Pending, 1=BullWins, 2=BearWins, 3=Canceled. */
export const Outcome = { PENDING: 0, BULL_WINS: 1, BEAR_WINS: 2, CANCELED: 3 } as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

/** An Up/Down asset: its on-chain label (case-insensitive, e.g. "BTC") or its raw index. */
export type UpDownAssetRef = string | number;

/** Slices per claim allowed by `claim`: 1-25. */
const MAX_CLAIM_SLICES = 25;

/** Default bet deadline: latest block time + 600 s (a later bet reverts "Deadline"). */
const BET_DEADLINE_SECONDS = 600;


/**
 * Settling failed because the price feed has no usable round past the round's `endTime` yet. Transient: wait for
 * the feed to tick and retry, or use `advanceRound` (it polls the feed).
 * - `NoUpdateAfterEndTime`: the feed has not updated since the round's `endTime`.
 * - `NoValidPriceInWindow`: no recent feed price from `endTime` on differs from the start price (a flat price never
 *   settles; the round ends with `cancelCurrentRoundAndStartNext`).
 * - `WaitTimeout`: `advanceRound` polled the feed for `maxWaitMs` without an update past `endTime`.
 */
export class OracleNotReadyError extends BasisError {
  readonly asset: number;
  readonly tf: number;
  readonly endTime: bigint;
  readonly contractError: 'NoUpdateAfterEndTime' | 'NoValidPriceInWindow' | 'WaitTimeout';
  constructor(message: string, asset: number, tf: number, endTime: bigint, contractError: OracleNotReadyError['contractError']) {
    super(message);
    this.name = 'OracleNotReadyError';
    this.asset = asset;
    this.tf = tf;
    this.endTime = endTime;
    this.contractError = contractError;
  }
}


/** One listed asset, with the feed's and settle asset's decimals. */
export interface UpDownAssetInfo {
  index: number;
  /** On-chain label (e.g. "BTC"); lookups are case-insensitive. */
  label: string;
  /** Chainlink-style feed (AggregatorV3). */
  priceFeed: Address;
  /** The feed's decimals: round prices are scaled by this (not always 8). */
  feedDecimals: number;
  /** The asset's own pool token (18 dec): bet amounts, pools and shares are in it. */
  poolToken: Address;
  /** The asset's own pause flag (there is also a global one, `paused()`). */
  paused: boolean;
  /** The asset's main. */
  main: Address;
  /** That main's pair asset: the default bet input and what claims pay out in. */
  settle: Address;
  settleDecimals: number;
  settleSymbol: string;
  /** The asset's odds-floor setting, pool tokens; it sets the minimum net bet (see `minNetBet`). */
  virtFloor: bigint;
}

/** A round (`getRound`). Pools, odds weights (`virt*`) and seed are pool-token raw (18 dec). */
export interface UpDownRound {
  /** Unix seconds. */
  startTime: bigint;
  /** Unix seconds; betting closes `BET_LOCK` before it. */
  endTime: bigint;
  /** Unix seconds, 0 while pending. */
  settledAt: bigint;
  /** Feed price, scaled by `priceDecimals`. */
  startPrice: bigint;
  /** Feed price, scaled by `priceDecimals`; 0 while pending and on a canceled round. */
  endPrice: bigint;
  endPriceRoundId: bigint;
  virtBull: bigint;
  virtBear: bigint;
  bullPool: bigint;
  bearPool: bigint;
  sharesBull: bigint;
  sharesBear: bigint;
  seedBonus: bigint;
  outcome: Outcome;
  /** The asset feed's `decimals()` (the scale of `startPrice` / `endPrice`). */
  priceDecimals: number;
}

/** A wallet's bet on a round (`getUserBet`). Amounts are pool-token raw (18 dec). */
export interface UpDownUserBet {
  side: Side;
  /** Net stake (after the bet fee). 0 = no bet. */
  amount: bigint;
  shares: bigint;
  /** Set at the first claim (also a partial one). */
  claimed: boolean;
  /** Set at the first claim: the bet won (false = refund). */
  wasWin: boolean;
  /** Pool tokens still owed after a partial claim (0 before the first claim and once fully claimed). */
  pending: bigint;
}

/** A bet quote; amounts feed `betBull` / `betBear` directly. */
export interface UpDownBetQuote {
  /** Shares the bet would mint in this block. */
  shares: bigint;
  /** `minShares` for the bet: shares minus the slippage, never 0. */
  minShares: bigint;
  /** Pool tokens credited after conversion and the bet fee (raw, 18 dec). */
  netAmount: bigint;
  /** How the input is converted: 'direct' (pool token, settle asset, main), 'cross' (another BASIS token) or 'hop' (an outside token). */
  route: BetRoute;
  inputToken: Address;
  /** Raw input units. */
  inputAmount: bigint;
  /** Token / amount after the first conversion step (what the share quote was taken with). */
  convertedToken: Address;
  convertedAmount: bigint;
  /** First-step path: `[]` for a direct input, the `trading.quoteCross` path for 'cross', `[input, settle]` for 'hop'. */
  path: Address[];
  /** Minimum net bet, pool tokens. */
  minNetBet: bigint;
  /** The bet fee, bps of the gross pool tokens (read live for the bettor). */
  feeBps: number;
  /**
   * The bet fee, pool tokens (raw, 18 dec), worked out from `netAmount` and `feeBps`: never below the fee taken, at
   * most 1 wei above it (rounding: two gross amounts can net the same).
   */
  fee: bigint;
  /** The round the bet goes into (`currentRoundId`). */
  roundId: bigint;
  /** That round's end, unix seconds. */
  endTime: bigint;
  /** When betting on it closes: `endTime - BET_LOCK`, unix seconds. */
  closesAt: bigint;
  /** `currentSlippageThreshold`, bps (it tightens as the round runs). */
  slippageThreshold: bigint;
  /** The bettor already holds the other side of this round: the bet would revert (`AlreadyBetOnOtherSide`). */
  otherSide: boolean;
  /** The bettor's allowance of `inputToken` to the Up/Down contract, raw (0 for a 0x0 bettor). */
  allowance: bigint;
  /** `allowance < inputAmount`: `bet` sends an approve first (it approves on its own). */
  needsApproval: boolean;
  /**
   * What this bet alone would pay if its side wins, settle asset (unit 'pairAsset'): an estimate at the current pools
   * with this bet added, valued as a claim would pay it. Every later bet moves it. It leaves out a stake the bettor
   * already holds in the round (`quoteCurrentPayout` covers that one). null when the payout cannot be priced right
   * now, or when that read fails (an RPC failure too): it is for display only and never fails the quote.
   */
  potentialPayout: Amount | null;
}

export interface UpDownQuoteOptions {
  /** Input token; default the asset's settle asset. */
  input?: Address;
  /** Default the signer, else 0x0 (prices an unreferred wallet). */
  bettor?: Address;
  /** Default `client.slippageBps.updown` (3%). */
  slippageBps?: number;
}
const UPDOWN_QUOTE_KEYS = optionKeys<UpDownQuoteOptions>({ input: true, bettor: true, slippageBps: true });

export interface UpDownMinBetOptions {
  /** Input token; default the asset's settle asset. Any input `quoteBet` takes. */
  input?: Address;
  /** Default the signer, else 0x0 (prices an unreferred wallet). */
  bettor?: Address;
}
const UPDOWN_MIN_BET_KEYS = optionKeys<UpDownMinBetOptions>({ input: true, bettor: true });

/** The smallest bet a wallet can place on an asset in one input token (`minBetInput`). */
export interface UpDownMinBetInput {
  /**
   * Raw input-token units. For the pool token it is exact; for any other input it is estimated from the current
   * conversion with a 1% margin, so it moves with the price.
   */
  minInput: bigint;
  inputToken: Address;
  /** Net pool tokens (after the bet fee) the bet must credit: the larger of `minNetBet` and the precision floor. */
  minNetAmount: bigint;
  /** `minNetBet(asset)`, pool tokens. */
  minNetBet: bigint;
  /**
   * Raw settle asset: the net stake must be worth at least this, or its fee rounds to nothing and the bet reverts with
   * no reason. 0 when the bettor pays no fee.
   */
  precisionFloor: bigint;
  /** The bet fee, bps (read live for the bettor). */
  feeBps: number;
}

export interface UpDownBetOptions {
  /**
   * Input token; default the asset's settle asset. Also accepted: the pool token, the asset's main, any BASIS token
   * and an outside token with a hop route.
   */
  input?: Address;
  /** Explicit minimum shares, raw (a whole number, never 0; checked before anything is sent). Default: the quote minus `slippageBps`. */
  minShares?: bigint;
  /** Default `client.slippageBps.updown` (3%). */
  slippageBps?: number;
  /**
   * Settle (or cancel) the current round first when it has ended but nobody advanced it, then bet on the new one.
   * Default true (a real boolean). Expected races (someone else advanced, oracle not ready) are swallowed; the bet's
   * own checks follow. The cheap checks (amount, options, pauses, deadline, balance, whether the bet can convert, the
   * minimum net bet, and whether the round the advance opens would still take bets) run before the advance is sent; if
   * the bet still throws after an advance was sent, the error carries it as `err.advanced` (`AdvanceRoundResult`).
   */
  autoAdvance?: boolean;
  /** Pause after a successful auto-advance so load-balanced RPCs catch up (ms, whole number). Default 500. */
  autoAdvanceDelayMs?: number;
  /** How long auto-advance waits for the feed (ms, whole number). Default 30000. */
  autoAdvanceMaxWaitMs?: number;
  /**
   * Unix seconds (chain time) after which the bet reverts ("Deadline"). Checked on every bet, whatever the input.
   * Default: the latest block's time + 600. Either way it is capped at the observed round's betting cutoff
   * (`endTime - BET_LOCK`, `quote.closesAt`), so the bet can only land in the round it was checked against, never
   * in the next one; the result's `deadline` is what was sent. One already past (before the latest block time; a
   * deadline equal to the time of the block that runs the bet still counts) is rejected up front with
   * `ValidationError('Deadline')`, before any approval or auto-advance is sent, and again after the approval (nothing
   * more is sent then).
   */
  deadline?: bigint | number;
}
const UPDOWN_BET_KEYS = optionKeys<UpDownBetOptions>({
  input: true, minShares: true, slippageBps: true, autoAdvance: true, autoAdvanceDelayMs: true, autoAdvanceMaxWaitMs: true,
  deadline: true,
});

export interface UpDownBetResult extends TxResult {
  /**
   * The round the bet landed in, from the bet's event (the round it was checked against when the event is missing).
   * Always that round: the deadline is capped at its betting cutoff.
   */
  roundId: bigint;
  minShares: bigint;
  /** The deadline sent with the bet (unix seconds, chain time): at most the round's betting cutoff. */
  deadline: bigint;
  quote: UpDownBetQuote;
  /**
   * From the bet's event (null, with a `warnings` entry, if it is missing): the shares this bet minted, raw (18 dec;
   * they can differ from `quote.shares` when the block changed).
   */
  shares: bigint | null;
  /** Net stake credited, pool tokens (after the fee). */
  netAmount: Amount | null;
  /** The bet fee taken, pool tokens. */
  fee: Amount | null;
  /** What was sent, in the input token. */
  paid: Amount | null;
  /** The auto-advance write sent before the bet (its own tx, already synced), or null when none was sent. */
  advanced: AdvanceRoundResult | null;
}

export interface UpDownClaimOptions {
  /** Share of the remaining entitlement to claim now, 1-10000 (a whole number or a bigint). Default 10000 (all). A partial claim leaves `pending`. */
  fractionBps?: number | bigint;
  /** Equal sell chunks, 1-25 (a whole number or a bigint; more slices = less slippage on large payouts). Default 1. */
  slices?: number | bigint;
  /** Explicit minimum payout, raw settle asset (a whole number, never 0; checked before anything is sent). Default: the quote minus `slippageBps`. */
  minOut?: bigint;
  /** Default `client.slippageBps.updown` (3%). */
  slippageBps?: number;
}
const UPDOWN_CLAIM_KEYS = optionKeys<UpDownClaimOptions>({ fractionBps: true, slices: true, minOut: true, slippageBps: true });

export interface UpDownClaimResult extends TxResult {
  /** The payout floor sent, in the settle asset (unit 'pairAsset'). */
  minOut: Amount;
  /**
   * From the claim's event (null, with a `warnings` entry, if it is missing): what this claim paid, settle asset.
   */
  payout: Amount | null;
  /** Pool tokens sold by this claim. */
  tokens: Amount | null;
  /** Pool tokens still owed after it (0 = fully claimed; claim again for the rest). */
  remaining: Amount | null;
  /** true = a win, false = a refund (a canceled round, or a settled one nobody won). */
  won: boolean | null;
}

export interface AdvanceRoundOptions {
  /** Feed poll interval while waiting (ms, whole number). Default 8000. */
  pollIntervalMs?: number;
  /** Max wait for the feed before `OracleNotReadyError('WaitTimeout')` (ms, whole number). Default 360000. */
  maxWaitMs?: number;
}
const ADVANCE_ROUND_KEYS = optionKeys<AdvanceRoundOptions>({ pollIntervalMs: true, maxWaitMs: true });

/**
 * What a failed `bet` may carry: the auto-advance write it sent before failing (its own confirmed, synced tx), so a
 * caller can report it. Set only when an advance was sent.
 */
export interface UpDownBetErrorInfo {
  advanced?: AdvanceRoundResult;
}

/** The round a settle / cancel opened. Times unix seconds, price raw in feed decimals. */
export interface UpDownNextRound {
  roundId: bigint;
  startTime: bigint;
  endTime: bigint;
  startPrice: bigint;
  /** Its seed bonus, pool tokens. */
  seedBonus: Amount;
}

/**
 * A settle / cancel write with the figures from its events. Fields are null (with a `warnings` entry) when the event
 * that fills them is missing.
 */
export interface UpDownRoundEndResult extends TxResult {
  /** The round this tx closed. */
  roundId: bigint | null;
  /** BullWins / BearWins, or Canceled (a cancel, or a settle of a round without bets). */
  outcome: Outcome | null;
  /** The end price, feed decimals; 0 on a cancel. */
  endPrice: bigint | null;
  /** Settled with nobody on the winning side, so every bet is refunded at claim. */
  noWinner: boolean | null;
  /** Pool tokens this round rolled into the next round's seed. */
  carryover: Amount | null;
  /** The round the tx opened. */
  nextRound: UpDownNextRound | null;
}

export interface AdvanceRoundResult extends UpDownRoundEndResult {
  /** 'settle' = `settleCurrentRound` (a round with no bets settles as a cancel without waiting for the feed), 'cancel' = `cancelCurrentRoundAndStartNext`. */
  mode: 'settle' | 'cancel';
}

export interface UpDownLobbyOptions {
  /** Assets to include (labels or indexes); default every listed asset. */
  assets?: UpDownAssetRef[];
  /** Timeframes to include; default all (0-4). */
  timeframes?: number[];
}
const UPDOWN_LOBBY_KEYS = optionKeys<UpDownLobbyOptions>({ assets: true, timeframes: true });

/** One `(asset, tf)` of the lobby. */
export interface UpDownLobbyTimeframe {
  tf: number;
  /** `currentRoundId(asset, tf)`; 0 = never started. */
  roundId: bigint;
  /** The current round; null when never started. */
  round: UpDownRound | null;
  /** `currentBullProbability`, scaled by 1e18 (0 when not started). */
  bullProbability: bigint;
  /** `currentSlippageThreshold`, bps (it tightens as the round runs). */
  slippageThreshold: bigint;
  /** When betting closes: `endTime - BET_LOCK` (0 when not started). */
  closesAt: bigint;
  /**
   * A bet can be placed now: nothing paused, betting switched on (`UpDownLobby.hostListed`), the main's pair active and
   * its trading enabled, and the round pending with `chainTime + BET_LOCK < endTime`. The minimum bet, the one-side
   * rule and the input's own route are per bet (see `quoteBet`).
   */
  bettable: boolean;
  /** The round has ended but is still pending: `advanceRound` (or a bet with auto-advance) moves it on. */
  needsAdvance: boolean;
}

/** One asset of the lobby. Feed fields are null when the feed cannot be read. */
export interface UpDownLobbyAsset {
  index: number;
  label: string;
  /** The asset's own pause flag (the global one is `UpDownLobby.paused`). */
  paused: boolean;
  priceFeed: Address;
  feedDecimals: number;
  /** The feed's latest price, scaled by `feedDecimals`. */
  price: bigint | null;
  /** When the feed last updated, unix seconds. */
  priceUpdatedAt: bigint | null;
  /** `chainTime - priceUpdatedAt`, seconds (never negative). */
  priceAge: bigint | null;
  /** Older than `PRICE_STALENESS()`: a round that needs a fresh start price cannot open on it (StalePrice). */
  priceStale: boolean | null;
  poolToken: Address;
  main: Address;
  settle: Address;
  settleDecimals: number;
  settleSymbol: string;
  /** The main's trading pair is active (not paused). */
  pairActive: boolean;
  /** Trading on the main has opened. */
  mainTradingEnabled: boolean;
  timeframes: UpDownLobbyTimeframe[];
}

/** Every asset x timeframe at one block (all reads pinned to `blockNumber`). */
export interface UpDownLobby {
  blockNumber: bigint;
  /** That block's timestamp: what `bettable`, `needsAdvance` and `priceAge` are measured against. */
  chainTime: bigint;
  /** Global pause flag. */
  paused: boolean;
  /** `BET_LOCK()`, seconds (one value for every asset). */
  betLock: bigint;
  /** Betting is switched on for Up/Down; while false every bet reverts ("hosts only"). */
  hostListed: boolean;
  assets: UpDownLobbyAsset[];
}

/** A round to check for a claim. */
export interface UpDownClaimRef {
  asset: UpDownAssetRef;
  tf: number;
  roundId: bigint | number;
}

export interface UpDownClaimable {
  asset: number;
  label: string;
  tf: number;
  roundId: bigint;
  /** `quoteClaimPayout`: what a full one-slice claim pays now, settle asset. */
  payout: Amount;
  /**
   * `payout > 0`. A 0 quote means "not quotable now", not certainly "nothing to claim": the bet lost or was claimed,
   * the round is pending, or the payout cannot be priced right now.
   */
  quotable: boolean;
}

export interface UpDownClaimables {
  user: Address;
  blockNumber: bigint;
  items: UpDownClaimable[];
  /** Sum of the payouts per settle asset, in first-seen order. */
  totals: { settle: Address; amount: Amount }[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The 'pair asset paused' message for a bet paid in `input`, a BASIS token of another pair, while that pair's asset is
 * paused. Same text as markets `buy` and in PY.
 */
const inputSalePaused = (input: Address, factoryToken: boolean) =>
  `no bet paid in ${input} can be placed: the bet sells it for this asset` +
  (factoryToken ? ', and every sale pays out your pending holder rewards on it in this asset' : '');

/**
 * The other pair asset a bet paid in `input` needs unpaused, when it is not the settle asset `settle` (checked on its
 * own): for a main of another pair, or a factory token on one. Null for anything else (a token of the asset's own
 * main `main`, or an outside token). `factoryToken`: paying in it also pays out the bettor's pending holder rewards on
 * it, in that asset. Same rule as markets `buy`.
 */
async function inputSaleAsset(client: BasisClient, input: Address, main: Address, settle: Address): Promise<{ asset: Address; symbol: string; factoryToken: boolean } | null> {
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
  if (eq(root, main)) return null;
  const info = await mains.get(root);
  if (eq(info.pairAsset, settle)) return null;
  return { asset: info.pairAsset, symbol: info.pairSymbol, factoryToken };
}

/**
 * A time option in ms: a whole number (number or bigint), `dflt` when left out (undefined or null, as PY None); else
 * `ValidationError(field)`.
 */
function msOption(v: unknown, field: string, dflt: number): number {
  if (v == null) return dflt;
  return Number(toUint(v as number, field));
}

/** A whole number given as a JS number or a bigint (PY: any int), as a number; null for anything else. */
function wholeNumberOf(v: unknown): number | null {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}


/**
 * Up/Down price rounds (`client.addresses.upDown`): every asset and timeframe, keyed `(asset, tf)`. Assets are
 * resolved by their on-chain label (case-insensitive) or raw index. `client.updown.asset('BTC')` returns a view with
 * the asset fixed. Anyone can call `settleCurrentRound`, `cancelCurrentRoundAndStartNext` and `advanceRound`. There
 * may be no assets listed yet (`assets()`).
 *
 * Up/Down is not enabled yet: while `FEATURES.upDown` is false, `deployed` is false and every call (`asset()` too)
 * throws `NotDeployedError` ("Up/Down is not enabled yet.") before any network call.
 *
 * Inputs, checked before any read: an address a caller passes (`input`, `bettor`, `user`, `inputToken`) is 0x plus 40
 * hex characters, a mixed-case one with a correct checksum (else `ValidationError` named after it); an optional
 * parameter or option given as null takes its default, as None in PY (required ones still refuse null); an options
 * argument that is not a plain object (a positional value such as `claim(asset, tf, roundId, 5000)`) is
 * `ValidationError('options')`.
 */
export class UpDownModule extends BaseModule {
  private labelIndex: Promise<Map<string, number[]>> | null = null;
  private countCache: Promise<number> | null = null;
  private constantsCache: Promise<{
    betLock: bigint; finalizeWindow: bigint; priceStaleness: bigint; tfCount: number; carryoverBps: bigint;
  }> | null = null;
  private feedDecimals = new Map<string, Promise<number>>();
  private views = new Map<string, UpDownAsset>();

  constructor(client: BasisClient) {
    super(client);
    const notEnabled = () => new NotDeployedError('MultiUpDown', client.chainId, 'Up/Down is not enabled yet.');
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (FEATURES.upDown) return Reflect.get(target, prop, receiver);
        if (prop === 'deployed') return false;
        if (prop === 'address') throw notEnabled();
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || prop === 'constructor') return value;
        if (prop === 'asset') return () => { throw notEnabled(); };
        return () => Promise.reject(notEnabled());
      },
    });
  }

  /** True when Up/Down is enabled (`FEATURES.upDown`) and has an address on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.upDown);
  }

  /** The Up/Down contract address (throws `NotDeployedError` when zero, or while Up/Down is not enabled). */
  get address(): Address {
    return this.require(this.client.addresses.upDown, 'MultiUpDown');
  }

  /** The signer, else 0x0 (for quotes). */
  private get quoter(): Address {
    return this.client.account ?? zeroAddress;
  }


  /**
   * A view with `asset` fixed (no RPC until a method is called). Views are cached per ref: an index and a label never
   * share one (`asset(1)` and `asset('#1')` are two views).
   */
  asset(ref: UpDownAssetRef): UpDownAsset {
    if (typeof ref !== 'number' && typeof ref !== 'string') return new UpDownAsset(this, ref);
    const key = typeof ref === 'number' ? `index:${ref}` : `label:${ref.trim().toLowerCase()}`;
    let v = this.views.get(key);
    if (!v) {
      v = new UpDownAsset(this, ref);
      this.views.set(key, v);
    }
    return v;
  }

  /** Number of listed assets. */
  async assetCount(): Promise<number> {
    const n = await this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assetCount' });
    return Number(n);
  }

  /** Every listed asset, in index order (fresh reads; feed and settle decimals cached). */
  async assets(): Promise<UpDownAssetInfo[]> {
    const n = await this.assetCount();
    return Promise.all(Array.from({ length: n }, (_, i) => this.readAsset(i)));
  }

  /** One asset by label or index. Throws `ValidationError('InvalidAsset')` for an unknown one. */
  async getAsset(ref: UpDownAssetRef): Promise<UpDownAssetInfo> {
    return this.readAsset(await this.resolveAsset(ref));
  }

  /**
   * The index of an asset. Labels are matched case-insensitively against each asset's label (cached; re-read once on a
   * miss, since assets can be added). A label listed twice is ambiguous: pass the index.
   */
  async resolveAsset(ref: UpDownAssetRef): Promise<number> {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref > 255) throw new ValidationError('InvalidAsset', `Asset indexes are 0-255, got ${ref}.`);
      let count = await this.cachedCount();
      if (ref >= count) {
        this.countCache = null;
        count = await this.cachedCount();
      }
      if (ref >= count) throw new ValidationError('InvalidAsset', `Asset ${ref} does not exist (assetCount = ${count}).`);
      return ref;
    }
    if (typeof ref !== 'string') {
      throw new ValidationError('InvalidAsset', `An asset is a label or an index 0-255, got ${String(ref)}.`);
    }
    const key = ref.trim().toLowerCase();
    if (!key) throw new ValidationError('InvalidAsset', 'Empty asset label.');
    let hit = (await this.labels()).get(key);
    if (!hit) {
      this.labelIndex = null;
      this.countCache = null;
      hit = (await this.labels()).get(key);
    }
    if (!hit) {
      const known = [...(await this.labels()).keys()].join(', ') || 'none';
      throw new ValidationError('InvalidAsset', `No Up/Down asset labelled "${ref}" (known: ${known}).`);
    }
    if (hit.length > 1) {
      throw new ValidationError('InvalidAsset', `The label "${ref}" is used by assets ${hit.join(', ')}; pass the index instead.`);
    }
    return hit[0];
  }

  private cachedCount(): Promise<number> {
    if (!this.countCache) {
      this.countCache = this.assetCount();
      this.countCache.catch(() => { this.countCache = null; });
    }
    return this.countCache;
  }

  private labels(): Promise<Map<string, number[]>> {
    if (!this.labelIndex) {
      this.labelIndex = (async () => {
        const n = await this.assetCount();
        const rows = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [i] })),
        );
        const m = new Map<string, number[]>();
        rows.forEach((r, i) => {
          const k = r[3].trim().toLowerCase();
          m.set(k, [...(m.get(k) ?? []), i]);
        });
        return m;
      })();
      this.labelIndex.catch(() => { this.labelIndex = null; });
    }
    return this.labelIndex;
  }

  private async readAsset(index: number): Promise<UpDownAssetInfo> {
    const [priceFeed, poolToken, paused, label, main, settle, virtFloor] = await this.publicClient.readContract({
      address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [index],
    });
    const [feedDecimals, meta] = await Promise.all([this.feedDecimalsOf(priceFeed), this.client.mains.tokenMeta(settle)]);
    return {
      index, label, priceFeed, feedDecimals, poolToken, paused, main, settle,
      settleDecimals: meta.decimals, settleSymbol: meta.symbol, virtFloor,
    };
  }

  /** `decimals()` of a price feed (cached per feed). */
  private feedDecimalsOf(feed: Address): Promise<number> {
    const id = feed.toLowerCase();
    let p = this.feedDecimals.get(id);
    if (!p) {
      p = this.publicClient.readContract({ address: feed, abi: AggregatorV3Abi, functionName: 'decimals' }).then(Number);
      this.feedDecimals.set(id, p);
      p.catch(() => this.feedDecimals.delete(id));
    }
    return p;
  }


  /** `BET_LOCK()`: seconds before `endTime` when betting closes. */
  async BET_LOCK(): Promise<bigint> {
    return (await this.constants()).betLock;
  }

  /** `FINALIZE_WINDOW()`: seconds after `endTime` during which a round can be settled; after it, only canceled. */
  async FINALIZE_WINDOW(): Promise<bigint> {
    return (await this.constants()).finalizeWindow;
  }

  /** `PRICE_STALENESS()`: seconds; a round needing a fresh start price cannot open on an older feed update. */
  async PRICE_STALENESS(): Promise<bigint> {
    return (await this.constants()).priceStaleness;
  }

  /** `swap()`. */
  async swap(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'swap' });
  }

  /** `taxes()`. */
  async taxes(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'taxes' });
  }

  /** `factory()`. */
  async factory(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'factory' });
  }

  /** Global pause flag (bets revert; settle and claim still work). Each asset also has its own (`getAsset().paused`). */
  async paused(): Promise<boolean> {
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'paused' });
  }

  /** Round duration of a timeframe, seconds. */
  async tfDuration(tf: number): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'tfDuration', args: [await this.tfArg(tf)] });
  }

  private constants() {
    if (!this.constantsCache) {
      const address = this.address;
      this.constantsCache = Promise.all([
        this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'BET_LOCK' }),
        this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'FINALIZE_WINDOW' }),
        this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'PRICE_STALENESS' }),
        this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'TF_COUNT' }),
        this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'CARRYOVER_BPS' }),
      ]).then(([betLock, finalizeWindow, priceStaleness, tfCount, carryoverBps]) => ({
        betLock, finalizeWindow, priceStaleness, tfCount: Number(tfCount), carryoverBps,
      }));
      this.constantsCache.catch(() => { this.constantsCache = null; });
    }
    return this.constantsCache;
  }

  private async tfArg(tf: number): Promise<number> {
    const { tfCount } = await this.constants();
    if (!Number.isInteger(tf) || tf < 0 || tf >= tfCount) {
      throw new ValidationError('InvalidTimeframe', `Timeframes are 0-${tfCount - 1} (5m, 15m, 1h, 4h, 24h), got ${tf}.`);
    }
    return tf;
  }

  /** The asset, then the timeframe, one after the other (as PY). */
  private async args(asset: UpDownAssetRef, tf: number): Promise<[number, number]> {
    const a = await this.resolveAsset(asset);
    return [a, await this.tfArg(tf)];
  }

  private sideArg(side: SideInput): 1 | 2 {
    if (side === 'bull' || side === Side.BULL) return 1;
    if (side === 'bear' || side === Side.BEAR) return 2;
    throw new ValidationError('side', `Side must be 'bull' | 'bear' (1 | 2), got ${String(side)}.`);
  }

  private async chainNow(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }

  private async settleAmount(asset: number, raw: bigint): Promise<Amount> {
    const settle = (await this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [asset] }))[5];
    const meta = await this.client.mains.tokenMeta(settle);
    return toAmount(raw, meta.decimals, 'pairAsset', settle, meta.symbol);
  }


  /** Current round id of `(asset, tf)`; 0 = never started. */
  async currentRoundId(asset: UpDownAssetRef, tf: number): Promise<bigint> {
    const [a, t] = await this.args(asset, tf);
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'currentRoundId', args: [a, t] });
  }

  /** A round plus the feed's `priceDecimals`. A round id past the current one reads back zeroed. */
  async getRound(asset: UpDownAssetRef, tf: number, roundId: bigint | number): Promise<UpDownRound> {
    const rid = toUint(roundId, 'roundId');
    const [a, t] = await this.args(asset, tf);
    const [r, info] = await Promise.all([
      this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'getRound', args: [a, t, rid] }),
      this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [a] }),
    ]);
    return toRound(r, await this.feedDecimalsOf(info[0]));
  }

  /** The current round and its id, or null when `(asset, tf)` was never started. */
  async getCurrentRound(asset: UpDownAssetRef, tf: number): Promise<{ roundId: bigint; round: UpDownRound } | null> {
    const roundId = await this.currentRoundId(asset, tf);
    if (roundId === 0n) return null;
    return { roundId, round: await this.getRound(asset, tf, roundId) };
  }

  /** `user`'s bet on a round (`amount` 0 = no bet). `user` defaults to the signer (also for null). */
  async getUserBet(asset: UpDownAssetRef, tf: number, roundId: bigint | number, user?: Address | null): Promise<UpDownUserBet> {
    const rid = toUint(roundId, 'roundId');
    const who = user == null ? this.account : toAddress(user, 'user');
    const [a, t] = await this.args(asset, tf);
    const b = await this.publicClient.readContract({
      address: this.address, abi: MultiUpDownAbi, functionName: 'getUserBet', args: [a, t, rid, who],
    });
    return { side: b.side as Side, amount: b.amount, shares: b.shares, claimed: b.claimed, wasWin: b.wasWin, pending: b.pending };
  }

  /** Implied bull probability of the current round, scaled by 1e18 (0 when not started). */
  async currentBullProbability(asset: UpDownAssetRef, tf: number): Promise<bigint> {
    const [a, t] = await this.args(asset, tf);
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'currentBullProbability', args: [a, t] });
  }

  /** Slippage threshold of the current round, bps (it tightens as the round runs). */
  async currentSlippageThreshold(asset: UpDownAssetRef, tf: number): Promise<bigint> {
    const [a, t] = await this.args(asset, tf);
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'currentSlippageThreshold', args: [a, t] });
  }

  /** Carry-over waiting to seed the next round, pool tokens (raw, 18 dec). */
  async pendingCarryover(asset: UpDownAssetRef, tf: number): Promise<bigint> {
    const [a, t] = await this.args(asset, tf);
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'pendingCarryover', args: [a, t] });
  }

  /** Odds weight each new round opens with (per side), pool tokens (raw, 18 dec). */
  async protocolVirtBase(asset: UpDownAssetRef, tf: number): Promise<bigint> {
    const [a, t] = await this.args(asset, tf);
    return this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'protocolVirtBase', args: [a, t] });
  }

  /**
   * Smallest net bet, pool tokens (raw, 18 dec), compared with the stake after conversion and the bet fee. A smaller
   * bet reverts `InvalidAmount`.
   */
  async minNetBet(asset: UpDownAssetRef): Promise<bigint> {
    const a = await this.resolveAsset(asset);
    const virtFloor = (await this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [a] }))[6];
    return virtFloor / BPS;
  }

  /**
   * The smallest bet `bettor` can place on `asset` in `input` (raw input units). The bet must net at least `minNetBet`
   * pool tokens after the fee, and enough that its fee does not round to nothing (below that the bet reverts with no
   * reason): `minNetAmount` is the larger of the two. For the pool token the answer is exact. For any other input the
   * net stake is estimated from a probe of one whole input token, scaled to the target and confirmed, with a 1% margin.
   * It does not need an open round. `input` defaults to the settle asset, `bettor` to the signer, else 0x0 (both also
   * for null). Throws `ValidationError('quote')` when the pool token or the input cannot be priced right now, 'pair not
   * active' while the main's pair is paused (for any input but the pool token, and for the pool token when the bettor
   * pays a bet fee; priced or not, as `quoteBet`), and 'above cap' when an outside hop on the input's route cannot take
   * a probe of it right now (its message says when waiting clears it, or to send less); an RPC failure on the way is
   * `BasisRpcError`, never 'quote'.
   */
  async minBetInput(asset: UpDownAssetRef, opts: UpDownMinBetOptions | null = {}): Promise<UpDownMinBetInput> {
    const o = optsOf(opts, UPDOWN_MIN_BET_KEYS);
    const inputIn = o.input == null ? undefined : toAddress(o.input, 'input');
    const bettorIn = o.bettor == null ? undefined : toAddress(o.bettor, 'bettor');
    const info = await this.readAsset(await this.resolveAsset(asset));
    const input = inputIn ?? info.settle;
    const bettor = bettorIn ?? this.quoter;
    const feeBps = await this.client.taxes.getTaxRate(info.poolToken, bettor);
    const rate = BigInt(feeBps);
    if (rate >= BPS) throw new ValidationError('quote', `A bet fee of ${feeBps} bps leaves no stake: no bet on ${info.label} can pass.`);
    const minNetBet = info.virtFloor / BPS;
    let precisionFloor = 0n;
    let minNetAmount = minNetBet;
    if (rate > 0n) {
      precisionFloor = ceilDiv(ceilDiv(BPS, rate) * 12n, 10n);
      const probe = minNetBet * 100n > 0n ? minNetBet * 100n : 10n ** 18n;
      const value = await this.client.trading.getAmountsOut(probe, [info.poolToken, info.main, info.settle])
        .catch((e: unknown) => zeroUnlessRpc(e, 'Swap', 'getAmountsOut'));
      if (value === 0n) {
        await this.refusePausedPair(info, 'bet');
        throw new ValidationError('quote', `The ${info.label} pool token cannot be priced in ${info.settleSymbol} right now.`);
      }
      const precisionNet = ceilDiv(precisionFloor * probe, value);
      if (precisionNet > minNetAmount) minNetAmount = precisionNet;
    }
    const result = (minInput: bigint): UpDownMinBetInput => ({ minInput, inputToken: input, minNetAmount, minNetBet, precisionFloor, feeBps });
    if (eq(input, info.poolToken)) {
      if (rate > 0n) await this.refusePausedPair(info, 'bet');
      return result(minNetAmount > 0n ? ((minNetAmount - 1n) * BPS) / (BPS - rate) + 1n : 0n);
    }

    const { decimals } = await this.client.mains.tokenMeta(input);
    let x = 10n ** BigInt(decimals);
    let got = 0n;
    for (let i = 0; i < 4 && got === 0n; i++) {
      got = await this.estimateNet(info, input, x, bettor, feeBps).catch((e: unknown) => {
        if (e instanceof ValidationError && e.rule === 'above cap') throw e;
        return zeroUnlessRpc(e, undefined, 'quoteBetInput');
      });
      if (got === 0n) x *= 1000n;
    }
    await this.refusePausedPair(info, 'bet');
    if (got === 0n) throw new ValidationError('quote', `${input} does not convert into the ${info.label} pool token right now.`);
    for (let i = 0; i < 3; i++) {
      x = (ceilDiv(x * minNetAmount, got) * 101n) / 100n + 1n;
      got = await this.estimateNet(info, input, x, bettor, feeBps);
      if (got >= minNetAmount) break;
    }
    return result(x);
  }

  /**
   * The net pool tokens a bet of `raw` `input` would credit: step 1 of `quoteBet`, then the quote into the pool token,
   * minus the bet fee. Needs no open round. 0 when the pool-token quote is refused right now; an RPC failure is
   * rethrown (`BasisRpcError`), and so is a refusal of step 1 (`quoteBetInput`).
   */
  private async estimateNet(info: UpDownAssetInfo, input: Address, raw: bigint, bettor: Address, feeBps?: number): Promise<bigint> {
    const step1 = await this.client.marketReader.quoteBetInput({
      input, amount: raw, pairAsset: info.settle, main: info.main, marketToken: info.poolToken, bettor,
    });
    const tok = step1.token.toLowerCase();
    const path: Address[] | null | undefined = tok === info.poolToken.toLowerCase() ? null
      : tok === info.main.toLowerCase() ? [info.main, info.poolToken]
        : tok === info.settle.toLowerCase() ? [info.settle, info.main, info.poolToken] : undefined;
    const [gross, rate] = await Promise.all([
      path === null ? step1.amount : path === undefined ? 0n : this.client.trading.getAmountsOut(step1.amount, path)
        .catch((e: unknown) => zeroUnlessRpc(e, 'Swap', 'getAmountsOut')),
      feeBps ?? this.client.taxes.getTaxRate(info.poolToken, bettor),
    ]);
    return gross - (gross * BigInt(rate)) / BPS;
  }


  /**
   * `quoteSharesForInput`: shares a bet of `amount` (raw `inputToken` units) mints now, and the net pool tokens it
   * credits. `inputToken` must be the pool token, the settle asset or the main; anything else quotes (0, 0)
   * (use `quoteBet`). (0, 0) also when the round is not bettable. Exact only in this block: never use it raw as
   * `minShares`. `user` defaults to the signer, else 0x0 (also for null).
   */
  async quoteSharesForInput(
    asset: UpDownAssetRef, tf: number, side: SideInput, inputToken: Address, amount: bigint, user?: Address | null,
  ): Promise<{ shares: bigint; netAmount: bigint }> {
    const s = this.sideArg(side);
    const token = toAddress(inputToken, 'inputToken');
    const raw = toUint(amount, 'amount');
    const who = user == null ? this.quoter : toAddress(user, 'user');
    const [a, t] = await this.args(asset, tf);
    const [shares, netAmount] = await this.publicClient.readContract({
      address: this.address, abi: MultiUpDownAbi, functionName: 'quoteSharesForInput', args: [a, t, s, token, raw, who],
    });
    return { shares, netAmount };
  }

  /**
   * The full bet quote for any accepted input (pool token, settle asset, the asset's main, any BASIS token, an outside
   * token with a hop route): step 1 `marketReader.quoteBetInput` (cross / hop conversion toward the settle asset or the
   * main), step 2 `quoteSharesForInput`, then `minShares` = shares minus `slippageBps` (default 3%).
   * `amount` is raw input units or a human amount in the input's decimals. Also returns the bet fee (`feeBps`, `fee`),
   * the round (`roundId`, `endTime`, `closesAt`), `slippageThreshold`, the step-1 `path`, `otherSide` (the bettor
   * already holds the other side: the bet would revert; a flag, not an error), the approval (`allowance`,
   * `needsApproval`; `bet` approves on its own) and `potentialPayout` (what this bet alone would pay if its side wins).
   * Throws `ValidationError`, in the order checked, when the round is not bettable ('BettingClosed'), the main's pair
   * is paused and the bet needs it ('pair not active', as markets `quoteBet`: any input but the pool token, or any bet
   * that pays a fee; quoted or not, such a bet reverts), the bet fee would be worth less than one raw settle unit
   * ('precision': the bet would revert with no reason), the input converts to 0 pool tokens or the net stake is below
   * `minNetBet` ('InvalidAmount'), or the side is too skewed to mint a share ('ZeroShares'). Step 1's own refusals ('no
   * route', 'above cap', ...) come first, as they are. `minBetInput` gives the smallest bet that passes.
   */
  async quoteBet(asset: UpDownAssetRef, tf: number, side: SideInput, amount: bigint | string | number, opts: UpDownQuoteOptions | null = {}): Promise<UpDownBetQuote> {
    const o = optsOf(opts, UPDOWN_QUOTE_KEYS);
    const inputIn = o.input == null ? undefined : toAddress(o.input, 'input');
    const bettorIn = o.bettor == null ? undefined : toAddress(o.bettor, 'bettor');
    const slippageBps = o.slippageBps ?? undefined;
    if (slippageBps !== undefined) validateSlippageBps(slippageBps);
    const s = this.sideArg(side);
    const [a, t] = await this.args(asset, tf);
    const info = await this.readAsset(a);
    const input = inputIn ?? info.settle;
    const raw = await this.parseBetAmount(amount, input);
    if (raw <= 0n) throw new ValidationError('amount', 'The bet amount must be above 0.');
    const bettor = bettorIn ?? this.quoter;

    const step1 = await this.client.marketReader.quoteBetInput({
      input, amount: raw, pairAsset: info.settle, main: info.main, marketToken: info.poolToken, bettor,
    });
    const address = this.address;
    const [{ shares, netAmount }, feeBps, roundId, slippageThreshold, betLock] = await Promise.all([
      this.quoteSharesForInput(a, t, s, step1.token, step1.amount, bettor),
      this.client.taxes.getTaxRate(info.poolToken, bettor),
      this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'currentRoundId', args: [a, t] }),
      this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'currentSlippageThreshold', args: [a, t] }),
      this.BET_LOCK(),
    ]);
    const minNetBet = info.virtFloor / BPS;
    if (shares === 0n) await this.refuseClosedRound(info, t, roundId, betLock);
    if (!eq(input, info.poolToken) || feeBps > 0) await this.refusePausedPair(info, 'bet');
    const fee = feeOf(netAmount, feeBps);
    if (netAmount < info.virtFloor) await this.checkFeeSells(info, netAmount, feeBps, fee);
    if (netAmount === 0n) {
      throw new ValidationError(
        'InvalidAmount',
        `The bet converts to 0 pool tokens on ${info.label} tf=${t} (too small, or the input cannot be priced right now), so it would revert. Bet more (see minBetInput).`,
      );
    }
    if (netAmount < minNetBet) {
      throw new ValidationError('InvalidAmount', `The bet nets ${netAmount} pool tokens after the fee, below the minimum net bet of ${minNetBet}. Bet more (see minBetInput).`);
    }
    if (shares === 0n) {
      throw new ValidationError(
        'ZeroShares',
        `The bet would mint 0 shares on ${info.label} tf=${t} round ${roundId}: that side is too skewed for a bet this small. Bet more.`,
      );
    }
    const minShares = await this.resolveMin(undefined, slippageBps, async () => shares, 'updown', 'minShares');
    const [round, bet, allowance, { carryoverBps }] = await Promise.all([
      this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'getRound', args: [a, t, roundId] }),
      isZeroAddress(bettor)
        ? null
        : this.publicClient.readContract({ address, abi: MultiUpDownAbi, functionName: 'getUserBet', args: [a, t, roundId, bettor] }),
      isZeroAddress(bettor)
        ? 0n
        : this.publicClient.readContract({ address: input, abi: ERC20Abi, functionName: 'allowance', args: [bettor, address] }),
      this.constants(),
    ]);
    const winTokens = payoutIfWin(round, s, netAmount, shares, carryoverBps);
    const winRaw = winTokens === null
      ? null
      : await this.client.trading.getAmountsOut(winTokens, [info.poolToken, info.main, info.settle]).catch(() => null);
    return {
      shares, minShares, netAmount, route: step1.route, inputToken: input, inputAmount: raw,
      convertedToken: step1.token, convertedAmount: step1.amount, path: [...step1.path], minNetBet,
      feeBps, fee, roundId, endTime: round.endTime, closesAt: round.endTime - betLock, slippageThreshold,
      otherSide: bet !== null && bet.side !== Side.NONE && bet.side !== s,
      allowance, needsApproval: allowance < raw,
      potentialPayout: winRaw === null ? null : toAmount(winRaw, info.settleDecimals, 'pairAsset', info.settle, info.settleSymbol),
    };
  }

  /**
   * When `quoteSharesForInput` gave 0 shares: (0, 0) comes back for a round that is not open ('BettingClosed'). On an
   * open round it returns, and the quote's next checks name the cause (the fee, the minimum bet, the share check).
   */
  private async refuseClosedRound(info: UpDownAssetInfo, tf: number, roundId: bigint, betLock: bigint): Promise<void> {
    const [round, now] = await Promise.all([
      this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'getRound', args: [info.index, tf, roundId] }),
      this.chainNow(),
    ]);
    if (roundId === 0n || round.outcome !== Outcome.PENDING || now + betLock + 1n >= round.endTime) {
      throw new ValidationError(
        'BettingClosed',
        `No shares for this bet on ${info.label} tf=${tf}: the round is not open for bets (not started, settled, or within BET_LOCK of its end).`,
      );
    }
  }

  /**
   * 'precision' when the bet fee is worth less than one raw settle unit: such a bet reverts with no reason (possible
   * near the minimum net bet on a 6-decimal settle asset). `fee` (from the net stake) can be 1 wei above the real fee,
   * so the smallest fee consistent with the net stake is valued: the check never passes a bet that reverts, and at
   * worst asks for a slightly larger bet at the exact boundary. An RPC failure of the valuation is `BasisRpcError`,
   * never 'precision'. The caller (`quoteBet`) has already found the main's pair active.
   */
  private async checkFeeSells(info: UpDownAssetInfo, netAmount: bigint, feeBps: number, fee: bigint): Promise<void> {
    if (fee === 0n) return;
    const low = feeLowOf(netAmount, feeBps, fee);
    const valued = low > 0n ? low : fee;
    const value = await this.client.trading.getAmountsOut(valued, [info.poolToken, info.main, info.settle])
      .catch((e: unknown) => zeroUnlessRpc(e, 'Swap', 'getAmountsOut'));
    if (value === 0n) {
      throw new ValidationError(
        'precision',
        `The bet fee (${fee} pool tokens) sells for less than one raw unit of ${info.settleSymbol}, so the bet would revert. Bet more (see minBetInput).`,
      );
    }
  }

  /** `user`'s estimated full payout on the current round if their side wins (settle asset). `user` defaults to the signer. */
  async quoteCurrentPayout(asset: UpDownAssetRef, tf: number, user?: Address | null): Promise<Amount> {
    const who = user == null ? this.account : toAddress(user, 'user');
    const [a, t] = await this.args(asset, tf);
    const raw = await this.publicClient.readContract({
      address: this.address, abi: MultiUpDownAbi, functionName: 'quoteCurrentPayout', args: [a, t, who],
    });
    return this.settleAmount(a, raw);
  }

  /**
   * What `claim` would pay `user` now for the whole remaining entitlement in one slice (settle asset): after a partial
   * claim, the value of what is still owed. 0 when there is nothing to claim (no bet, lost, all claimed, pending).
   * `user` defaults to the signer.
   */
  async quoteClaimPayout(asset: UpDownAssetRef, tf: number, roundId: bigint | number, user?: Address | null): Promise<Amount> {
    const rid = toUint(roundId, 'roundId');
    const who = user == null ? this.account : toAddress(user, 'user');
    const [a, t] = await this.args(asset, tf);
    const raw = await this.publicClient.readContract({
      address: this.address, abi: MultiUpDownAbi, functionName: 'quoteClaimPayout', args: [a, t, rid, who],
    });
    return this.settleAmount(a, raw);
  }


  /**
   * The Up/Down lobby in one pass, every read pinned to the latest block: per asset its label, pause flag, feed price
   * and age, pool token, main and settle asset, whether its pair is active and its main's trading open; per timeframe
   * the current round id and round, bull probability, slippage threshold, when betting closes, `bettable` now and
   * `needsAdvance`. Global: pause, `BET_LOCK`, `hostListed`. `assets` / `timeframes`
   * (null or left out = all) must be arrays when given (`ValidationError('assets' / 'timeframes')`, before any read).
   */
  async getLobby(opts: UpDownLobbyOptions | null = {}): Promise<UpDownLobby> {
    const o = optsOf(opts, UPDOWN_LOBBY_KEYS);
    const assetRefs = o.assets ?? null;
    const tfRefs = o.timeframes ?? null;
    if (assetRefs !== null && !Array.isArray(assetRefs)) throw new ValidationError('assets', 'assets must be an array of asset labels or indexes.');
    if (tfRefs !== null && !Array.isArray(tfRefs)) throw new ValidationError('timeframes', 'timeframes must be an array of timeframes.');
    const address = this.address;
    const pc = pinnedClient(this.publicClient);
    const block = await this.publicClient.getBlock();
    const blockNumber = block.number;
    const now = block.timestamp;
    const { betLock, priceStaleness, tfCount } = await this.constants();
    const indexes = assetRefs !== null
      ? [...new Set(await Promise.all(Array.from(assetRefs, (r) => this.resolveAsset(r))))]
      : Array.from(
        { length: Number(await pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'assetCount', blockNumber })) },
        (_, i) => i,
      );
    const tfs = tfRefs !== null
      ? [...new Set(await Promise.all(Array.from(tfRefs, (t) => this.tfArg(t))))]
      : Array.from({ length: tfCount }, (_, i) => i);

    const [paused, taxesAddr, swapAddr] = await Promise.all([
      pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'paused', blockNumber }),
      pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'taxes', blockNumber }),
      pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'swap', blockNumber }),
    ]);
    const hostListed = await pc.readContract({
      address: taxesAddr, abi: TaxesAbi, functionName: 'isPrediction', args: [address], blockNumber,
    });

    const assets = await Promise.all(indexes.map(async (i): Promise<UpDownLobbyAsset> => {
      const [priceFeed, poolToken, assetPaused, label, main, settle] = await pc.readContract({
        address, abi: MultiUpDownAbi, functionName: 'assets', args: [i], blockNumber,
      });
      const [feedDecimals, meta, feed, pair, mainTradingEnabled] = await Promise.all([
        this.feedDecimalsOf(priceFeed),
        this.client.mains.tokenMeta(settle),
        pc.readContract({ address: priceFeed, abi: AggregatorV3Abi, functionName: 'latestRoundData', blockNumber })
          .catch(() => null),
        pc.readContract({ address: swapAddr, abi: SwapAbi, functionName: 'pairs', args: [main], blockNumber }),
        pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'tradingEnabled', blockNumber }),
      ]);
      const pairActive = pair[2];
      const open = !paused && !assetPaused && hostListed && pairActive && mainTradingEnabled;
      const priceUpdatedAt = feed ? feed[3] : null;
      const priceAge = priceUpdatedAt === null ? null : now > priceUpdatedAt ? now - priceUpdatedAt : 0n;

      const timeframes = await Promise.all(tfs.map(async (tf): Promise<UpDownLobbyTimeframe> => {
        const roundId = await pc.readContract({
          address, abi: MultiUpDownAbi, functionName: 'currentRoundId', args: [i, tf], blockNumber,
        });
        const [r, bullProbability, slippageThreshold] = await Promise.all([
          roundId === 0n
            ? null
            : pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'getRound', args: [i, tf, roundId], blockNumber }),
          pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'currentBullProbability', args: [i, tf], blockNumber }),
          pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'currentSlippageThreshold', args: [i, tf], blockNumber }),
        ]);
        const round = r ? toRound(r, feedDecimals) : null;
        const pendingEnd = round !== null && round.outcome === Outcome.PENDING ? round.endTime : null;
        return {
          tf, roundId, round, bullProbability, slippageThreshold,
          closesAt: round ? round.endTime - betLock : 0n,
          bettable: open && pendingEnd !== null && now + betLock < pendingEnd,
          needsAdvance: pendingEnd !== null && now > pendingEnd,
        };
      }));

      return {
        index: i, label, paused: assetPaused, priceFeed, feedDecimals,
        price: feed ? feed[1] : null, priceUpdatedAt, priceAge, priceStale: priceAge === null ? null : priceAge > priceStaleness,
        poolToken, main, settle, settleDecimals: meta.decimals, settleSymbol: meta.symbol,
        pairActive, mainTradingEnabled, timeframes,
      };
    }));

    return { blockNumber, chainTime: now, paused, betLock, hostListed, assets };
  }

  /**
   * Claim quotes for a list of rounds (e.g. the API's claimable list): `quoteClaimPayout` for each, pinned to the latest
   * block, with the totals per settle asset. `user` defaults to the signer (also for null). A 0 payout means "not
   * quotable now". `rounds` must be an array of `{ asset, tf, roundId }` objects (`ValidationError('rounds')`, before
   * any read).
   */
  async getClaimable(user: Address | null | undefined, rounds: UpDownClaimRef[]): Promise<UpDownClaimables> {
    const who = user == null ? this.account : toAddress(user, 'user');
    if (!Array.isArray(rounds)) throw new ValidationError('rounds', 'rounds must be an array of rounds.');
    const given = Array.from(rounds as unknown[], (r) => {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        throw new ValidationError('rounds', `Each round is an object { asset, tf, roundId }, got ${Array.isArray(r) ? 'an array' : String(r)}.`);
      }
      const ref = r as UpDownClaimRef;
      return { asset: ref.asset, tf: ref.tf, roundId: toUint(ref.roundId, 'roundId') };
    });
    const address = this.address;
    const pc = pinnedClient(this.publicClient);
    const refs: { asset: number; tf: number; roundId: bigint }[] = [];
    for (const r of given) {
      const [a, t] = await this.args(r.asset, r.tf);
      refs.push({ asset: a, tf: t, roundId: r.roundId });
    }
    const blockNumber = (await this.publicClient.getBlock()).number;
    const infos = new Map<number, Promise<{ label: string; settle: Address; decimals: number; symbol: string }>>();
    const infoOf = (a: number) => {
      let p = infos.get(a);
      if (!p) {
        p = (async () => {
          const row = await pc.readContract({ address, abi: MultiUpDownAbi, functionName: 'assets', args: [a], blockNumber });
          const meta = await this.client.mains.tokenMeta(row[5]);
          return { label: row[3], settle: row[5], decimals: meta.decimals, symbol: meta.symbol };
        })();
        infos.set(a, p);
      }
      return p;
    };
    const items = await Promise.all(refs.map(async (r): Promise<UpDownClaimable> => {
      const [info, raw] = await Promise.all([
        infoOf(r.asset),
        pc.readContract({
          address, abi: MultiUpDownAbi, functionName: 'quoteClaimPayout', args: [r.asset, r.tf, r.roundId, who], blockNumber,
        }),
      ]);
      return {
        asset: r.asset, label: info.label, tf: r.tf, roundId: r.roundId,
        payout: toAmount(raw, info.decimals, 'pairAsset', info.settle, info.symbol), quotable: raw > 0n,
      };
    }));
    const sums = new Map<string, Amount>();
    for (const it of items) {
      const k = it.payout.asset.toLowerCase();
      const prev = sums.get(k);
      const p = it.payout;
      sums.set(k, toAmount((prev?.raw ?? 0n) + p.raw, p.decimals, 'pairAsset', p.asset, p.symbol));
    }
    const totals = [...sums.values()].map((amount) => ({ settle: amount.asset, amount }));
    return { user: who, blockNumber, items, totals };
  }


  /** Bet Up on the current round of `(asset, tf)`. See `bet` for the flow. */
  async betBull(asset: UpDownAssetRef, tf: number, amount: bigint | string | number, opts: UpDownBetOptions | null = {}): Promise<UpDownBetResult> {
    return this.bet(asset, tf, 'bull', amount, optsOf(opts, UPDOWN_BET_KEYS));
  }

  /** Bet Down on the current round of `(asset, tf)`. See `bet` for the flow. */
  async betBear(asset: UpDownAssetRef, tf: number, amount: bigint | string | number, opts: UpDownBetOptions | null = {}): Promise<UpDownBetResult> {
    return this.bet(asset, tf, 'bear', amount, optsOf(opts, UPDOWN_BET_KEYS));
  }

  /** bigint = raw units; string / number = human amount in `token`'s decimals (truncated). Others: ValidationError. */
  private async parseBetAmount(amount: bigint | string | number, token: Address): Promise<bigint> {
    if (typeof amount === 'bigint') return amount;
    if (typeof amount !== 'string' && typeof amount !== 'number') {
      throw new ValidationError('amount', `The bet amount must be a number, got ${String(amount)}.`);
    }
    return parseAmount(amount, (await this.client.mains.tokenMeta(token)).decimals);
  }

  /**
   * Place a bet. `amount` is raw input units or a human amount in the input's decimals; the input defaults to the
   * asset's settle asset. Flow, in order: the option checks, before any read (the input address, `deadline`,
   * `minShares`, `slippageBps`, the auto-advance options, the side) → the global pause → the asset (`InvalidAsset`) →
   * its own pause → the timeframe (`InvalidTimeframe`) → the amount (above 0, read in the input's decimals) → an
   * explicit deadline → balance → whether the bet can go through now ('convert closed': Up/Down is not taking bets
   * right now; 'pair not active': the main's pair is paused; 'Trading is not enabled': trading on the main has not
   * opened, for a bet that buys or sells the main; 'pair asset paused': the settle asset, or the pair asset of another
   * pair whose BASIS token you pay in, is paused by its issuer (paying in a factory token of another pair also pays out
   * your pending holder rewards on it, in that asset); a bet paid in the pool token with no bet fee skips these) → when
   * the round has ended unadvanced and `autoAdvance` is on: the round the advance would open (refused with
   * `BettingClosed`, nothing sent, when it would already be inside `BET_LOCK`) and the minimum net bet
   * (`InvalidAmount`, estimated), then the advance → betting window (`now + BET_LOCK < endTime`) → one side per round
   * → quote (`quoteBet`, min net bet; an explicit `minShares` above the quoted shares is
   * `ValidationError('MinSharesNotMet')` on a direct route: the pool token, the settle asset or the main) → approve the
   * input to the contract → re-check that the same round is still open (else `ValidationError('BettingClosed')`,
   * nothing sent but the approval) → the bet (deadline default: latest block time + 600; explicit or default, capped at
   * the round's betting cutoff `endTime - BET_LOCK`, so the bet can never roll into the next round). The result adds
   * the round the bet landed in (`roundId`), `shares`, `netAmount`, `fee` and `paid` (Amounts) from the bet's event,
   * and `advanced` (the auto-advance write, or null).
   * An error thrown after an auto-advance was sent carries that advance as `err.advanced` (`UpDownBetErrorInfo`).
   * The options (input address, `deadline`, `minShares`, `slippageBps`, the auto-advance ones) and the side are checked
   * before any read; null options take their defaults.
   */
  async bet(asset: UpDownAssetRef, tf: number, side: SideInput, amount: bigint | string | number, opts: UpDownBetOptions | null = {}): Promise<UpDownBetResult> {
    const o = optsOf(opts, UPDOWN_BET_KEYS);
    const me = this.account;
    const inputIn = o.input == null ? undefined : toAddress(o.input, 'input');
    const explicitDeadline = optUint(o.deadline, 'deadline');
    const explicitMinShares = optUint(o.minShares, 'minShares');
    if (explicitMinShares === 0n) throw new ValidationError('minShares', 'A zero minShares is never sent; omit it to derive it from a quote.');
    const slippageBps = o.slippageBps ?? undefined;
    if (slippageBps !== undefined) validateSlippageBps(slippageBps);
    const autoAdvance = toBool(o.autoAdvance, 'autoAdvance', true);
    const advanceDelayMs = msOption(o.autoAdvanceDelayMs, 'autoAdvanceDelayMs', 500);
    const advanceMaxWaitMs = msOption(o.autoAdvanceMaxWaitMs, 'autoAdvanceMaxWaitMs', 30_000);
    const s = this.sideArg(side);
    if (await this.paused()) throw new ValidationError('Paused', 'Up/Down is paused: no bets right now.');
    const a = await this.resolveAsset(asset);
    const info = await this.readAsset(a);
    if (info.paused) throw new ValidationError('Paused', `Up/Down asset ${info.label} is paused: no bets on it right now.`);
    const t = await this.tfArg(tf);
    const input = inputIn ?? info.settle;
    const raw = await this.parseBetAmount(amount, input);
    if (raw <= 0n) throw new ValidationError('amount', 'The bet amount must be above 0.');
    const checkDeadline = (now: bigint) => {
      if (explicitDeadline !== undefined) checkExplicitDeadline(explicitDeadline, now);
    };

    if (explicitDeadline !== undefined) checkDeadline(await this.chainNow());

    const balance = await this.balanceOf(input, me);
    if (balance < raw) {
      const meta = await this.client.mains.tokenMeta(input);
      throw new ValidationError('balance', `Insufficient ${meta.symbol}: have ${toAmount(balance, meta.decimals, 'token', input, meta.symbol).formatted}, need ${toAmount(raw, meta.decimals, 'token', input, meta.symbol).formatted}.`);
    }
    await this.checkConvert(info, input, me);

    let advanced: AdvanceRoundResult | null = null;
    try {
      if (autoAdvance) {
        const [cur, nowPre] = await Promise.all([this.getCurrentRound(a, t), this.chainNow()]);
        if (cur && cur.round.outcome === Outcome.PENDING && nowPre > cur.round.endTime) {
          await this.precheckBeforeAdvance(info, t, cur.round.endTime, nowPre, input, raw, me);
          try {
            advanced = await this.advanceRound(a, t, { maxWaitMs: advanceMaxWaitMs });
            if (advanceDelayMs > 0) await sleep(advanceDelayMs);
          } catch (e) {
            if (!isAdvanceRace(e)) throw e;
          }
        }
      }
      return await this.placeBet(me, a, t, s, info, input, raw, explicitDeadline, explicitMinShares, slippageBps, checkDeadline, advanced);
    } catch (e) {
      if (advanced && e !== null && typeof e === 'object') (e as UpDownBetErrorInfo).advanced = advanced;
      throw e;
    }
  }

  /**
   * Before an auto-advance, the checks that need no open round. First the round the advance would open, worked out
   * from the latest block (the next block can carry the same timestamp): when even the next block would be inside its
   * `BET_LOCK`, the advance would open a round nobody can bet on now, so nothing is sent ('BettingClosed'). Then the
   * minimum net bet, from the estimated net stake (`estimateNet`): 'InvalidAmount'.
   */
  private async precheckBeforeAdvance(
    info: UpDownAssetInfo, tf: number, prevEnd: bigint, now: bigint, input: Address, raw: bigint, bettor: Address,
  ): Promise<void> {
    const [betLock, dur] = await Promise.all([this.BET_LOCK(), this.tfDuration(tf)]);
    const tExec = now + 1n;
    const chainEnd = prevEnd + dur;
    const nextEnd = chainEnd > now ? chainEnd : (now / dur) * dur + dur;
    if (tExec + betLock >= nextEnd) {
      throw new ValidationError(
        'BettingClosed',
        `${info.label} tf=${tf}: the round an advance would open ends at ${nextEnd}, already inside its ${betLock}s bet lock (chain time ${now}). ` +
          'Nothing was sent; bet on the round after it.',
      );
    }
    const net = await this.estimateNet(info, input, raw, bettor);
    const minNetBet = info.virtFloor / BPS;
    if (net === 0n) {
      throw new ValidationError(
        'InvalidAmount',
        `The bet converts to 0 pool tokens on ${info.label} tf=${tf} (too small, or the input cannot be priced right now), so it would revert. Bet more (see minBetInput).`,
      );
    }
    if (net < minNetBet) {
      throw new ValidationError('InvalidAmount', `The bet nets about ${net} pool tokens after the fee, below the minimum net bet of ${minNetBet}. Bet more (see minBetInput).`);
    }
  }

  /**
   * Whether a bet paid in `input` can go through now, in order (as markets `checkBuy` does): betting switched on for
   * Up/Down ('convert closed'), the main's pair active ('pair not active'), then, for a bet that buys or sells the main
   * (paid in anything but the pool token or the main, or with a bet fee), the main's trading open ('Trading is not
   * enabled'), then no asset the bet moves paused by its issuer ('pair asset paused'): the pair asset of another pair
   * whose BASIS token is paid in (paying in a factory token also pays out the bettor's pending holder rewards on it),
   * then the settle asset. A bet paid in the pool token with no bet fee needs none of these.
   * The same reads as `getLobby`'s `hostListed`, `pairActive` and `mainTradingEnabled`, plus the issuer pause.
   */
  private async checkConvert(info: UpDownAssetInfo, input: Address, bettor: Address): Promise<void> {
    const inPool = eq(input, info.poolToken);
    const inMain = eq(input, info.main);
    const fee = (inPool || inMain) && (await this.client.taxes.getTaxRate(info.poolToken, bettor)) > 0;
    if (inPool && !fee) return;
    const address = this.address;
    const listed = await this.publicClient.readContract({
      address: await this.taxes(), abi: TaxesAbi, functionName: 'isPrediction', args: [address],
    });
    if (!listed) throw new ValidationError('convert closed', `Up/Down (${address}) cannot convert a bet right now: no bets.`);
    if (!(await this.pairActive(info.main))) throw this.pairNotActive(info, 'bet');
    if ((!inPool && !inMain) || fee) {
      const open = (await this.client.mains.get(info.main)).tradingEnabled
        || (await this.publicClient.readContract({ address: info.main, abi: MainTokenAbi, functionName: 'tradingEnabled' }));
      if (!open) {
        throw new ValidationError(
          'Trading is not enabled',
          `Trading on main ${info.main} has not opened yet: no bets on ${info.label} that buy or sell it until it does.`,
        );
      }
      if (!inPool && !inMain && !eq(input, info.settle)) {
        const sale = await inputSaleAsset(this.client, input, info.main, info.settle);
        if (sale && (await isAssetPaused(this.client, sale.asset))) {
          throw pairAssetPaused(sale.asset, sale.symbol, inputSalePaused(input, sale.factoryToken));
        }
      }
      if (await isAssetPaused(this.client, info.settle)) {
        throw pairAssetPaused(info.settle, info.settleSymbol, 'no bet that pays in or converts through it can be placed');
      }
    }
  }

  /** Whether the main's pair is active, read now. */
  private async pairActive(main: Address): Promise<boolean> {
    const pair = await this.publicClient.readContract({ address: await this.swap(), abi: SwapAbi, functionName: 'pairs', args: [main] });
    return pair[2];
  }

  /**
   * 'pair not active' when `info`'s main is on a paused pair, read now (`pairActive`): bets and claims that need the
   * pair revert, and a quote of 0 then means the pause, not the amount. Returns when the pair is active.
   */
  private async refusePausedPair(info: UpDownAssetInfo, action: 'bet' | 'claim'): Promise<void> {
    if (!(await this.pairActive(info.main))) throw this.pairNotActive(info, action);
  }

  /** The 'pair not active' refusal of a bet or a claim on `info`. */
  private pairNotActive(info: UpDownAssetInfo, action: 'bet' | 'claim'): ValidationError {
    const what = action === 'bet'
      ? 'no bets that convert through it until the pair is active again'
      : 'the payout sells through it, so no claim until the pair is active again';
    return new ValidationError('pair not active', `${info.label} settles through main ${info.main}, which is on a paused pair: ${what}.`);
  }

  /**
   * `bet` from the betting-window check on (after any auto-advance). The window (`now + BET_LOCK < endTime`) is
   * checked for the next block (chain time + 1): a bet the latest block would still take can land a second later and
   * revert on chain.
   */
  private async placeBet(
    me: Address, a: number, t: number, s: 1 | 2, info: UpDownAssetInfo, input: Address, raw: bigint,
    explicitDeadline: bigint | undefined, explicitMinShares: bigint | undefined, slippageBps: number | undefined,
    checkDeadline: (now: bigint) => void, advanced: AdvanceRoundResult | null,
  ): Promise<UpDownBetResult> {
    const roundId = await this.currentRoundId(a, t);
    if (roundId === 0n) throw new ValidationError('NoActiveRound', `${info.label} tf=${t} has not been started.`);
    const [round, betLock, now, myBet] = await Promise.all([
      this.getRound(a, t, roundId), this.BET_LOCK(), this.chainNow(), this.getUserBet(a, t, roundId, me),
    ]);
    if (round.outcome !== Outcome.PENDING || now + 1n + betLock >= round.endTime) {
      throw new ValidationError(
        'BettingClosed',
        `Betting is closed on ${info.label} tf=${t} round ${roundId} (it locks ${betLock}s before the end at ${round.endTime}; chain time ${now}). Bet on the next round.`,
      );
    }
    checkDeadline(now);
    if (myBet.side !== Side.NONE && myBet.side !== s) {
      throw new ValidationError('AlreadyBetOnOtherSide', `You already bet ${myBet.side === Side.BULL ? 'Up' : 'Down'} on round ${roundId}. One side per round.`);
    }

    const quote = await this.quoteBet(a, t, s, raw, { input, bettor: me, slippageBps });
    if (quote.route === 'direct' && explicitMinShares !== undefined && explicitMinShares > quote.shares) {
      throw new ValidationError(
        'MinSharesNotMet',
        `minShares ${explicitMinShares} is above the shares this bet mints now (${quote.shares}), so it would be refused: lower it, or omit it to derive it from the quote.`,
      );
    }
    const minShares = await this.resolveMin(explicitMinShares, slippageBps, async () => quote.shares, 'updown', 'minShares');
    const mi = await this.client.mains.get(info.main);
    const [poolFmt, inputFmt] = await Promise.all([amountOf(this.client, info.poolToken, mi), amountOf(this.client, input, mi)]);

    await this.ensureAllowance(input, this.address, raw);
    const closesAt = round.endTime - betLock;
    const [ridNow, nowAfter] = await Promise.all([this.currentRoundId(a, t), this.chainNow()]);
    if (ridNow !== roundId || nowAfter + 1n + betLock >= round.endTime) {
      const moved = ridNow !== roundId ? `, current round ${ridNow}` : '';
      throw new ValidationError(
        'BettingClosed',
        `Betting on ${info.label} tf=${t} round ${roundId} closed while the bet was being prepared (it locked at ${closesAt}; ` +
          `chain time ${nowAfter}${moved}). The bet was not sent (an approval already made stays). Bet on the next round.`,
      );
    }
    checkDeadline(nowAfter);

    const wanted = explicitDeadline ?? await this.blockDeadline(BET_DEADLINE_SECONDS);
    const deadline = wanted < closesAt ? wanted : closesAt;
    const tx = await this.send({
      address: this.address, abi: MultiUpDownAbi, functionName: s === 1 ? 'betBull' : 'betBear',
      args: [a, t, input, raw, minShares, deadline], contract: 'MultiUpDown',
    });
    const placed = this.events(tx, MultiUpDownAbi, 'BetPlaced', this.address)
      .find((e) => e.asset === a && e.tf === t && e.user.toLowerCase() === me.toLowerCase());
    if (!placed) addMissingEventWarning(tx, 'MultiUpDown', 'BetPlaced', ['shares', 'netAmount', 'fee', 'paid']);
    if (placed && placed.roundId !== roundId) {
      tx.warnings.push(`MultiUpDown.BetPlaced: the bet landed in round ${placed.roundId}, not in round ${roundId} it was checked against.`);
    }
    return {
      ...tx, roundId: placed?.roundId ?? roundId, minShares, deadline, quote,
      shares: placed?.shares ?? null, netAmount: optAmount(poolFmt, placed?.amount), fee: optAmount(poolFmt, placed?.fee),
      paid: optAmount(inputFmt, placed?.paid), advanced,
    };
  }


  /**
   * Claim a settled round (win or refund), paid in the asset's settle asset. Defaults: all of it (`fractionBps`
   * 10000) in one slice. A partial claim leaves the rest in `getUserBet().pending` for a later claim.
   * `minOut` (raw settle asset, a whole number, never 0; checked before anything is sent) defaults to
   * `quoteClaimPayout × fractionBps / 10000` minus `slippageBps` (3%); the single-sell quote of the whole entitlement is
   * a lower bound for a smaller or sliced sell. The result's `minOut` is the floor sent, as an `Amount` (settle asset).
   * Pre-checks run in this order: NoActiveRound, NothingToClaim (no bet), RoundNotSettled, 'fraction 1-10000',
   * NothingToClaim (nothing owed, or the fraction rounds to 0 pool tokens), 'slices 1-25', then the payout: something
   * owed that cannot be priced now is 'pair not active' while the main's pair is paused, as markets `redeem`, else
   * NothingToClaim; then 'precision' (a slice worth less than one raw settle unit reverts the claim with no reason: use
   * fewer slices), then 'pair asset paused' (the issuer of the settle asset paused it: the payout is made in it).
   * The result adds `payout`, `tokens`, `remaining` and `won` from the claim's event.
   * `roundId`, `minOut` and `slippageBps` are checked before any read; null options take their defaults.
   */
  async claim(asset: UpDownAssetRef, tf: number, roundId: bigint | number, opts: UpDownClaimOptions | null = {}): Promise<UpDownClaimResult> {
    const o = optsOf(opts, UPDOWN_CLAIM_KEYS);
    const me = this.account;
    const rid = toUint(roundId, 'roundId');
    const fractionIn: unknown = o.fractionBps ?? 10000;
    const slicesIn: unknown = o.slices ?? 1;
    const explicitMinOut = optUint(o.minOut, 'minOut');
    if (explicitMinOut === 0n) throw new ValidationError('minOut', 'A zero minOut is never sent; omit it to derive it from a quote.');
    const slippageBps = o.slippageBps ?? undefined;
    if (slippageBps !== undefined) validateSlippageBps(slippageBps);
    const [a, t] = await this.args(asset, tf);

    const current = await this.currentRoundId(a, t);
    if (rid === 0n || rid > current) throw new ValidationError('NoActiveRound', `Round ${rid} does not exist (current is ${current}).`);
    const [round, bet, payout] = await Promise.all([
      this.getRound(a, t, rid), this.getUserBet(a, t, rid, me), this.quoteClaimPayout(a, t, rid, me),
    ]);
    if (bet.amount === 0n) throw new ValidationError('NothingToClaim', `${me} has no bet on round ${rid}.`);
    if (round.outcome === Outcome.PENDING) throw new ValidationError('RoundNotSettled', `Round ${rid} is not settled yet.`);
    const fractionBps = wholeNumberOf(fractionIn);
    if (fractionBps === null || fractionBps < 1 || fractionBps > 10000) {
      throw new ValidationError('fraction 1-10000', `fractionBps must be 1-10000, got ${String(fractionIn)}.`);
    }
    const entitlement = entitlementOf(round, bet);
    if (entitlement === 0n) throw new ValidationError('NothingToClaim', `Nothing to claim on round ${rid} for ${me} (lost, or already claimed).`);
    const payNow = fractionBps === 10000 ? entitlement : (entitlement * BigInt(fractionBps)) / BPS;
    if (payNow === 0n) {
      throw new ValidationError('NothingToClaim', `${fractionBps} bps of the ${entitlement} pool tokens still owed on round ${rid} rounds to 0. Claim a larger fraction.`);
    }
    const slices = wholeNumberOf(slicesIn);
    if (slices === null || slices < 1 || slices > MAX_CLAIM_SLICES) {
      throw new ValidationError(`slices 1-${MAX_CLAIM_SLICES}`, `slices must be 1-${MAX_CLAIM_SLICES}, got ${String(slicesIn)}.`);
    }
    if (payout.raw === 0n) {
      await this.refusePausedPair(await this.readAsset(a), 'claim');
      throw new ValidationError('NothingToClaim', `Nothing to claim on round ${rid} for ${me} right now: the payout cannot be priced.`);
    }
    if (slices > 1 || payNow !== entitlement) await this.checkSliceSells(a, payNow, slices);

    const expected = (payout.raw * BigInt(fractionBps)) / BPS;
    const minOut = await this.resolveMin(explicitMinOut, slippageBps, async () => expected, 'updown', 'minOut');
    const info = await this.readAsset(a);
    await refusePausedAsset(this.client, info.settle, info.settleSymbol, 'no claim can pay it out');
    const mi = await this.client.mains.get(info.main);
    const [poolFmt, settleFmt] = await Promise.all([amountOf(this.client, info.poolToken, mi), amountOf(this.client, info.settle, mi)]);
    const tx = await this.send({
      address: this.address, abi: MultiUpDownAbi, functionName: 'claim',
      args: [a, t, rid, fractionBps, BigInt(slices), minOut], contract: 'MultiUpDown',
    });
    const mine = <E extends { asset: number; tf: number; roundId: bigint; user: Address }>(e: E) =>
      e.asset === a && e.tf === t && e.roundId === rid && e.user.toLowerCase() === me.toLowerCase();
    const won = this.events(tx, MultiUpDownAbi, 'BetWon', this.address).find(mine);
    const refunded = won ? undefined : this.events(tx, MultiUpDownAbi, 'BetRefunded', this.address).find(mine);
    if (!won && !refunded) addMissingEventWarning(tx, 'MultiUpDown', 'BetWon / BetRefunded', ['payout', 'tokens', 'remaining', 'won']);
    const ev = won ?? refunded;
    return {
      ...tx, minOut: settleFmt(minOut),
      payout: optAmount(settleFmt, won ? won.payout : refunded ? refunded.amount : null),
      tokens: optAmount(poolFmt, ev?.tokens), remaining: optAmount(poolFmt, ev?.remaining), won: won ? true : refunded ? false : null,
    };
  }

  /**
   * 'precision' when a claim of `payNow` in `slices` chunks has a chunk worth less than one raw settle unit (the claim
   * would revert with no reason). An RPC failure of the valuation is `BasisRpcError`, never 'precision'.
   */
  private async checkSliceSells(asset: number, payNow: bigint, slices: number): Promise<void> {
    const info = await this.readAsset(asset);
    const base = payNow / BigInt(slices);
    const chunk = base > 0n ? base : payNow;
    const value = await this.client.trading.getAmountsOut(chunk, [info.poolToken, info.main, info.settle])
      .catch((e: unknown) => zeroUnlessRpc(e, 'Swap', 'getAmountsOut'));
    if (value > 0n) return;
    throw new ValidationError(
      'precision',
      slices > 1 && base > 0n
        ? `Each of the ${slices} slices (${chunk} pool tokens) sells for less than one raw unit of ${info.settleSymbol}, so the claim would revert. Use fewer slices.`
        : `This claim (${chunk} pool tokens) sells for less than one raw unit of ${info.settleSymbol}, so it would revert. Claim a larger fraction.`,
    );
  }


  /**
   * Settle the current round of `(asset, tf)` and open the next one. Anyone may call, after `endTime` and within
   * `FINALIZE_WINDOW`. One attempt, no polling (see `advanceRound`). A round without bets settles as a cancel
   * (no feed price needed). The result adds the round's outcome, end price, `noWinner`, carry-over and the round it
   * opened, from the tx's events (`UpDownRoundEndResult`).
   * @throws OracleNotReadyError when the feed has no usable price past `endTime` yet (retry later)
   */
  async settleCurrentRound(asset: UpDownAssetRef, tf: number): Promise<UpDownRoundEndResult> {
    void this.account;
    const [a, t] = await this.args(asset, tf);
    const { roundId, round } = await this.preCheckTiming(a, t, 'settle');
    const poolFmt = await this.poolAmountOf(a);
    let tx: TxResult;
    try {
      tx = await this.send({ address: this.address, abi: MultiUpDownAbi, functionName: 'settleCurrentRound', args: [a, t], contract: 'MultiUpDown' });
    } catch (e) {
      for (const name of ['NoUpdateAfterEndTime', 'NoValidPriceInWindow'] as const) {
        if (isRevertNamed(e, name)) {
          throw new OracleNotReadyError(
            `The price feed has no usable update past round ${roundId}'s end (${round.endTime}) yet (${name}). ` +
              'Retry settleCurrentRound shortly, or use advanceRound, which polls the feed.',
            a, t, round.endTime, name,
          );
        }
      }
      throw e;
    }
    return this.roundEnd(tx, a, t, poolFmt);
  }

  /**
   * Cancel the current round of `(asset, tf)` (bets refund at claim, the seed rolls forward) and open the next one.
   * Anyone may call, once `endTime + FINALIZE_WINDOW` has passed. The result is the same as `settleCurrentRound`'s
   * (outcome Canceled, end price 0).
   */
  async cancelCurrentRoundAndStartNext(asset: UpDownAssetRef, tf: number): Promise<UpDownRoundEndResult> {
    void this.account;
    const [a, t] = await this.args(asset, tf);
    await this.preCheckTiming(a, t, 'cancel');
    const poolFmt = await this.poolAmountOf(a);
    const tx = await this.send({ address: this.address, abi: MultiUpDownAbi, functionName: 'cancelCurrentRoundAndStartNext', args: [a, t], contract: 'MultiUpDown' });
    return this.roundEnd(tx, a, t, poolFmt);
  }

  /** Formatter for raw pool-token amounts of `asset` (resolved before a write, so the result needs no RPC). */
  private async poolAmountOf(asset: number): Promise<AmountOf> {
    const info = await this.readAsset(asset);
    return amountOf(this.client, info.poolToken, await this.client.mains.get(info.main));
  }

  /**
   * The figures of a settle / cancel from its events; pool-token figures through `poolFmt`.
   */
  private roundEnd(tx: TxResult, asset: number, tf: number, poolFmt: AmountOf): UpDownRoundEndResult {
    const ours = <E extends { asset: number; tf: number }>(e: E) => e.asset === asset && e.tf === tf;
    const settled = this.events(tx, MultiUpDownAbi, 'RoundSettled', this.address).find(ours);
    const opened = this.events(tx, MultiUpDownAbi, 'NewRound', this.address).find(ours);
    if (!settled) addMissingEventWarning(tx, 'MultiUpDown', 'RoundSettled', ['roundId', 'outcome', 'endPrice', 'noWinner', 'carryover']);
    if (!opened) addMissingEventWarning(tx, 'MultiUpDown', 'NewRound', ['nextRound']);
    const rid = settled?.roundId;
    const noWinner = settled ? this.events(tx, MultiUpDownAbi, 'RoundNoWinner', this.address).some((e) => ours(e) && e.roundId === rid) : null;
    const carryover = settled
      ? this.events(tx, MultiUpDownAbi, 'CarryoverCaptured', this.address)
        .filter((e) => ours(e) && e.fromRoundId === rid).reduce((s, e) => s + e.amount, 0n)
      : null;
    return {
      ...tx,
      roundId: rid ?? null,
      outcome: settled ? (settled.outcome as Outcome) : null,
      endPrice: settled?.endPrice ?? null,
      noWinner,
      carryover: optAmount(poolFmt, carryover),
      nextRound: opened
        ? { roundId: opened.roundId, startTime: opened.startTime, endTime: opened.endTime, startPrice: opened.startPrice, seedBonus: poolFmt(opened.seedBonus) }
        : null,
    };
  }

  /**
   * Settle-or-cancel helper: inside the finalize window it waits for the feed to update past `endTime` (polling, up
   * to `maxWaitMs`, default 6 min) and settles; after the window it cancels. A round without bets settles at once.
   * Can take minutes on a slow feed.
   * @throws ValidationError when the round is not started, already settled or still running;
   *   OracleNotReadyError when the feed stays stale for `maxWaitMs` or settle finds no valid price.
   */
  async advanceRound(asset: UpDownAssetRef, tf: number, opts: AdvanceRoundOptions | null = {}): Promise<AdvanceRoundResult> {
    const o = optsOf(opts, ADVANCE_ROUND_KEYS);
    void this.account;
    const pollIntervalMs = msOption(o.pollIntervalMs, 'pollIntervalMs', 8000);
    const maxWaitMs = msOption(o.maxWaitMs, 'maxWaitMs', 360_000);
    const [a, t] = await this.args(asset, tf);
    const cur = await this.getCurrentRound(a, t);
    if (!cur) throw new ValidationError('NoActiveRound', `Asset ${a} tf=${t} has not been started.`);
    const { roundId, round } = cur;
    const [now, fw] = await Promise.all([this.chainNow(), this.FINALIZE_WINDOW()]);
    if (now <= round.endTime) {
      throw new ValidationError('TooEarlyToSettle', `Round ${roundId} is still running: ${round.endTime - now}s left (ends at ${round.endTime}).`);
    }
    if (round.outcome !== Outcome.PENDING) {
      throw new ValidationError('RoundAlreadySettled', `Round ${roundId} is already settled (outcome ${round.outcome}).`);
    }
    if (now > round.endTime + fw) {
      return { ...(await this.cancelCurrentRoundAndStartNext(a, t)), mode: 'cancel' };
    }
    if (round.sharesBull > 0n || round.sharesBear > 0n) {
      await this.waitForOracle(a, t, round.endTime, pollIntervalMs, maxWaitMs);
    }
    return { ...(await this.settleCurrentRound(a, t)), mode: 'settle' };
  }

  /** Polls the asset's feed until it has updated at or after `endTime` (needed to settle). */
  private async waitForOracle(asset: number, tf: number, endTime: bigint, pollIntervalMs: number, maxWaitMs: number): Promise<void> {
    const feed = (await this.publicClient.readContract({ address: this.address, abi: MultiUpDownAbi, functionName: 'assets', args: [asset] }))[0];
    const start = Date.now();
    for (;;) {
      const [, , , updatedAt] = await this.publicClient.readContract({ address: feed, abi: AggregatorV3Abi, functionName: 'latestRoundData' });
      if (updatedAt >= endTime) return;
      if (Date.now() - start >= maxWaitMs) break;
      await sleep(pollIntervalMs);
    }
    throw new OracleNotReadyError(
      `The price feed ${feed} has not updated past the round's end (${endTime}) after ${Math.round(maxWaitMs / 1000)}s. ` +
        'It may be stalled; once the finalize window has passed, advanceRound cancels the round instead.',
      asset, tf, endTime, 'WaitTimeout',
    );
  }

  /**
   * In this order (time first). settle: NoActiveRound, TooEarlyToSettle (`now <= endTime`),
   * RoundAlreadySettled, TooLateForValidPrice (`now + 1 > endTime + FINALIZE_WINDOW`: an upper bound, checked for the
   * next block); cancel: NoActiveRound, TooEarlyToSettle (`now <= endTime + FINALIZE_WINDOW`), RoundAlreadySettled.
   * Chain time (`now` = the latest block's).
   */
  private async preCheckTiming(asset: number, tf: number, mode: 'settle' | 'cancel'): Promise<{ roundId: bigint; round: UpDownRound }> {
    const cur = await this.getCurrentRound(asset, tf);
    if (!cur) throw new ValidationError('NoActiveRound', `Asset ${asset} tf=${tf} has not been started.`);
    const { roundId, round } = cur;
    const [now, fw] = await Promise.all([this.chainNow(), this.FINALIZE_WINDOW()]);
    const deadline = round.endTime + fw;
    const notSettled = () => {
      if (round.outcome !== Outcome.PENDING) {
        throw new ValidationError('RoundAlreadySettled', `Round ${roundId} is already settled (outcome ${round.outcome}).`);
      }
    };
    if (mode === 'settle') {
      if (now <= round.endTime) {
        throw new ValidationError('TooEarlyToSettle', `Round ${roundId} has not ended: ${round.endTime - now}s left (ends at ${round.endTime}).`);
      }
      notSettled();
      if (now + 1n > deadline) {
        throw new ValidationError(
          'TooLateForValidPrice',
          `The settle window ends at ${deadline} (chain time ${now}), before a settle sent now can land; call cancelCurrentRoundAndStartNext once it has passed (or advanceRound).`,
        );
      }
    } else {
      if (now <= deadline) {
        throw new ValidationError('TooEarlyToSettle', `The settle window is open for ${deadline - now}s more; call settleCurrentRound (or advanceRound) until it closes.`);
      }
      notSettled();
    }
    return { roundId, round };
  }
}

/** A raw round plus the feed's decimals. */
function toRound(
  r: {
    startTime: bigint; endTime: bigint; settledAt: bigint; startPrice: bigint; endPrice: bigint; endPriceRoundId: bigint;
    virtBull: bigint; virtBear: bigint; bullPool: bigint; bearPool: bigint; sharesBull: bigint; sharesBear: bigint;
    seedBonus: bigint; outcome: number;
  },
  priceDecimals: number,
): UpDownRound {
  return {
    startTime: r.startTime,
    endTime: r.endTime,
    settledAt: r.settledAt,
    startPrice: r.startPrice,
    endPrice: r.endPrice,
    endPriceRoundId: r.endPriceRoundId,
    virtBull: r.virtBull,
    virtBear: r.virtBear,
    bullPool: r.bullPool,
    bearPool: r.bearPool,
    sharesBull: r.sharesBull,
    sharesBear: r.sharesBear,
    seedBonus: r.seedBonus,
    outcome: r.outcome as Outcome,
    priceDecimals,
  };
}

/**
 * The pool tokens `claim` still owes on a settled round: `pending` after a first claim; else the stake back on a
 * canceled round or one nobody won, the stake plus winnings for a winner, 0 for a loser (and while pending).
 */
function entitlementOf(r: UpDownRound, b: UpDownUserBet): bigint {
  if (b.amount === 0n) return 0n;
  if (b.claimed) return b.pending;
  if (r.outcome === Outcome.PENDING) return 0n;
  if (r.outcome === Outcome.CANCELED) return b.amount;
  const bullWins = r.outcome === Outcome.BULL_WINS;
  const winnerPool = bullWins ? r.bullPool - r.seedBonus / 2n : r.bearPool - (r.seedBonus - r.seedBonus / 2n);
  if (winnerPool === 0n) return b.amount;
  if (b.side !== (bullWins ? Side.BULL : Side.BEAR)) return 0n;
  const winnerShares = bullWins ? r.sharesBull : r.sharesBear;
  return b.amount + (b.shares * (r.bullPool + r.bearPool - winnerPool)) / winnerShares;
}

/**
 * Pool tokens a new bet (`net` stake, `shares`) on `side` would be owed if that side wins, at the current pools with
 * this bet added (as `quoteCurrentPayout` estimates it). null when the winning side would hold nothing.
 */
function payoutIfWin(
  r: { bullPool: bigint; bearPool: bigint; sharesBull: bigint; sharesBear: bigint; seedBonus: bigint },
  side: 1 | 2, net: bigint, shares: bigint, carryoverBps: bigint,
): bigint | null {
  const bull = side === Side.BULL;
  const seed = r.seedBonus;
  const seedHalf = bull ? seed / 2n : seed - seed / 2n;
  const winnerPool = (bull ? r.bullPool : r.bearPool) + net - seedHalf;
  const winnerShares = (bull ? r.sharesBull : r.sharesBear) + shares;
  if (winnerPool <= 0n || winnerShares <= 0n) return null;
  const matched = seed > winnerPool ? winnerPool : seed;
  const loserReal = r.bullPool + r.bearPool + net - winnerPool - seed;
  const loserSeedHalf = bull ? matched - matched / 2n : matched / 2n;
  const carry = ((loserReal + loserSeedHalf) * carryoverBps) / BPS;
  return net + (shares * (loserReal + matched - carry)) / winnerShares;
}

/**
 * The bet fee in pool tokens, worked out from the net stake and the fee rate (bps): the largest fee consistent with
 * `net`, never below the real fee and at most 1 wei above it (two gross amounts can net the same). 0 for a rate of 0
 * or >= 10000.
 */
function feeOf(netAmount: bigint, feeBps: number): bigint {
  const rate = BigInt(feeBps);
  if (rate <= 0n || rate >= BPS) return 0n;
  return (netAmount * BPS) / (BPS - rate) - netAmount;
}

/**
 * The smallest fee consistent with the net stake (`feeOf` is the largest). Equal to `fee` except at a rounding
 * boundary, where it is `fee - 1`.
 */
function feeLowOf(netAmount: bigint, feeBps: number, fee: bigint): bigint {
  const rate = BigInt(feeBps);
  if (rate <= 0n || rate >= BPS) return 0n;
  const x = netAmount * rate - BPS;
  const low = x < 0n ? 0n : x / (BPS - rate) + 1n;
  return low < fee ? low : fee;
}

/** Errors auto-advance may swallow: another caller advanced first, or the feed is not ready. */
function isAdvanceRace(e: unknown): boolean {
  if (e instanceof OracleNotReadyError) return true;
  const names = ['RoundAlreadySettled', 'TooEarlyToSettle', 'NoActiveRound', 'TooLateForValidPrice', 'PriceDriftTooLarge'];
  if (e instanceof ValidationError) return names.includes(e.rule);
  return names.some((n) => isRevertNamed(e, n));
}


/**
 * One asset of `client.updown` with the asset fixed: the module's methods minus the asset argument.
 * The label is resolved on the first call (`ValidationError('InvalidAsset')` if unknown). An options argument that is
 * not a plain object is `ValidationError('options')` (a rejected promise), before any read.
 */
export class UpDownAsset {
  constructor(private readonly m: UpDownModule, public readonly ref: UpDownAssetRef) {}

  /** The asset's index. */
  index(): Promise<number> { return this.m.resolveAsset(this.ref); }
  /** The asset's info, as `getAsset`. */
  info(): Promise<UpDownAssetInfo> { return this.m.getAsset(this.ref); }

  currentRoundId(tf: number) { return this.m.currentRoundId(this.ref, tf); }
  getRound(tf: number, roundId: bigint | number) { return this.m.getRound(this.ref, tf, roundId); }
  getCurrentRound(tf: number) { return this.m.getCurrentRound(this.ref, tf); }
  getUserBet(tf: number, roundId: bigint | number, user?: Address | null) { return this.m.getUserBet(this.ref, tf, roundId, user); }
  currentBullProbability(tf: number) { return this.m.currentBullProbability(this.ref, tf); }
  currentSlippageThreshold(tf: number) { return this.m.currentSlippageThreshold(this.ref, tf); }
  pendingCarryover(tf: number) { return this.m.pendingCarryover(this.ref, tf); }
  protocolVirtBase(tf: number) { return this.m.protocolVirtBase(this.ref, tf); }
  tfDuration(tf: number) { return this.m.tfDuration(tf); }
  /** See `UpDownModule.minNetBet`. */
  minNetBet() { return this.m.minNetBet(this.ref); }
  /** See `UpDownModule.minBetInput`. */
  async minBetInput(opts?: UpDownMinBetOptions | null) { return this.m.minBetInput(this.ref, optsOf(opts, UPDOWN_MIN_BET_KEYS)); }

  quoteSharesForInput(tf: number, side: SideInput, inputToken: Address, amount: bigint, user?: Address | null) {
    return this.m.quoteSharesForInput(this.ref, tf, side, inputToken, amount, user);
  }
  async quoteBet(tf: number, side: SideInput, amount: bigint | string | number, opts?: UpDownQuoteOptions | null) {
    return this.m.quoteBet(this.ref, tf, side, amount, optsOf(opts, UPDOWN_QUOTE_KEYS));
  }
  quoteCurrentPayout(tf: number, user?: Address | null) { return this.m.quoteCurrentPayout(this.ref, tf, user); }
  quoteClaimPayout(tf: number, roundId: bigint | number, user?: Address | null) { return this.m.quoteClaimPayout(this.ref, tf, roundId, user); }

  async bet(tf: number, side: SideInput, amount: bigint | string | number, opts?: UpDownBetOptions | null) {
    return this.m.bet(this.ref, tf, side, amount, optsOf(opts, UPDOWN_BET_KEYS));
  }
  async betBull(tf: number, amount: bigint | string | number, opts?: UpDownBetOptions | null) { return this.m.betBull(this.ref, tf, amount, optsOf(opts, UPDOWN_BET_KEYS)); }
  async betBear(tf: number, amount: bigint | string | number, opts?: UpDownBetOptions | null) { return this.m.betBear(this.ref, tf, amount, optsOf(opts, UPDOWN_BET_KEYS)); }
  async claim(tf: number, roundId: bigint | number, opts?: UpDownClaimOptions | null) { return this.m.claim(this.ref, tf, roundId, optsOf(opts, UPDOWN_CLAIM_KEYS)); }
  settleCurrentRound(tf: number) { return this.m.settleCurrentRound(this.ref, tf); }
  cancelCurrentRoundAndStartNext(tf: number) { return this.m.cancelCurrentRoundAndStartNext(this.ref, tf); }
  async advanceRound(tf: number, opts?: AdvanceRoundOptions | null) { return this.m.advanceRound(this.ref, tf, optsOf(opts, ADVANCE_ROUND_KEYS)); }
}
