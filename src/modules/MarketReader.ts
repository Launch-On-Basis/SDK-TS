import { zeroAddress } from 'viem';
import type { Address, ContractFunctionReturnType, Hex } from 'viem';
import type { BasisClient } from '../BasisClient';
import {
  EcosystemTokenAbi, FactoryAbi, FactoryTokenAbi, HopExecutorAbi, RedemptionReaderAbi, SwapAbi, TrancheMarketAbi, TrancheMarketPrivateAbi, TrancheReaderAbi,
} from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule } from '../core/BaseModule';
import { NotDeployedError, ValidationError } from '../core/errors';
import { checkCrossHop, type CrossRouteToken, routeTokenOf } from '../core/crossHop';
import { quoteHopWithinCaps } from '../core/loans';
import { classifyError, isRevertNamed, zeroUnlessRpc } from '../core/revert';
import { MainRef, pairAmount } from '../core/mains';
import { optionKeys, optsOf } from '../core/opts';
import { OUTCOME_INVALID, OUTCOME_UNRESOLVED } from '../core/ranking';
import { Amount, BPS, minWithSlippage, toAddress, toUint } from '../core/units';
import type { MarketStatus } from './MarketsBase';

/** A market host: 'public' (`client.addresses.tranche`), 'private' (`tranchePrivate`) or a host address. */
export type HostRef = 'public' | 'private' | Address;
export type HostKind = 'public' | 'private';

type RawHostMarketData = ContractFunctionReturnType<typeof TrancheMarketAbi, 'view', 'getMarketData'>;

/**
 * `getMarketData(market)` as both hosts return it (`usdc` = the market's pair asset, `ecosystem` = its main), with the
 * odds total named `totalOddsWeight` as everywhere in the SDK (sum of the outcomes' `oddsWeight`, market tokens).
 */
export type HostMarketData = Omit<RawHostMarketData, 'totalVirtualReserve'> & { totalOddsWeight: bigint };

/** A market with its host, main and pair asset resolved. */
export interface MarketContext {
  market: Address;
  host: Address;
  kind: HostKind;
  /** The market's main. */
  main: Address;
  /** The market's pair asset. */
  pairAsset: Address;
  data: HostMarketData;
}

/** One outcome. Odds weight, cost and shares are raw market-token / share units (18 dec). */
export interface OutcomeInfo {
  outcomeId: number;
  name: string;
  oddsWeight: bigint;
  totalCost: bigint;
  circulatingShares: bigint;
  /**
   * The odds, scaled by 1e18 (1e18 = certain). Not the order book's price, which is in the pair asset
   * (`orderBook.getSharePrice`).
   */
  pricePerShare: bigint;
  /** Implied probability in basis points (0-10000). */
  probability: number;
  /** Tranche-aware: true for every outcome in the final ranking, not only the winner. */
  hasWon: boolean;
}

/** Sizes for a market on `main`, with the host's seed floor. Raw units as noted. */
export interface MarketSizes {
  /** One unit of the main, raw pair asset. */
  unit: bigint;
  /** Seeds must be a multiple of this, raw pair asset. */
  seedStep: bigint;
  /** Smallest bet in market tokens (18 dec), after conversion, before the bet fee. */
  minBet: bigint;
  /** Opening odds weight per outcome, market tokens. */
  perOutcome: bigint;
  /** Whole opening pool, market tokens. */
  totalPool: bigint;
  /** Seed floor, raw pair asset (on the private host: of a market that is not a private event). */
  minSeed: bigint;
  /** Private host only: seed floor of a private-event market, raw pair asset (may be 0). */
  minSeedPrivateEvent?: bigint;
  kind: HostKind;
}

/** A redemption quote. Values are raw pair asset of the market. */
export interface RedemptionQuote {
  /** false = the market token has not bonded yet (it still redeems). */
  bonded: boolean;
  /** Market tokens asked about. */
  tokenAmount: bigint;
  /** Face value at the spot price (no price impact), raw pair asset. */
  valueAtSpot: bigint;
  /** Proceeds of one full sell, raw pair asset. */
  singleOut: bigint;
  /** Proceeds with `recommendedSlices`, raw pair asset. */
  slicedOut: bigint;
  impactSingleBps: number;
  impactSlicedBps: number;
  recommendedSlices: number;
  /** false → redeem `suggestedFractionBps` now and the rest later. */
  fitsInOneTx: boolean;
  /** Set when `!fitsInOneTx` (1-10000), else 0. */
  suggestedFractionBps: number;
}

/** A sliced sell simulation: total and per-slice proceeds, raw pair asset. */
export interface SlicedSell {
  totalOut: bigint;
  perSlice: bigint[];
}

/** A payout quote: market tokens (raw, 18 dec) and what they sell for in the pair asset. */
export interface PayoutQuote {
  tokenPayout: bigint;
  pairPayout: Amount;
}

export type BetRoute = 'direct' | 'cross' | 'hop';

/** `quoteBetInput` arguments (raw units). */
export interface QuoteBetInputParams {
  input: Address;
  amount: bigint;
  pairAsset: Address;
  main: Address;
  marketToken?: Address | null;
  bettor?: Address | null;
}
const QUOTE_BET_INPUT_KEYS = optionKeys<QuoteBetInputParams>({ input: true, amount: true, pairAsset: true, main: true, marketToken: true, bettor: true });

/** `quoteBet` arguments (raw units). */
export interface QuoteBetParams {
  market: Address;
  outcome: number;
  input: Address;
  amount: bigint;
  host?: HostRef | null;
  bettor?: Address | null;
  slippageBps?: number | null;
}
const QUOTE_BET_KEYS = optionKeys<QuoteBetParams>({ market: true, outcome: true, input: true, amount: true, host: true, bettor: true, slippageBps: true });

/** `redeemPlan` arguments. */
export interface RedeemPlanParams {
  market: Address;
  user?: Address | null;
  fractionBps?: number | null;
  slices?: number | null;
  slippageBps?: number | null;
  minOut?: bigint | null;
  host?: HostRef | null;
}
const REDEEM_PLAN_KEYS = optionKeys<RedeemPlanParams>({
  market: true, user: true, fractionBps: true, slices: true, slippageBps: true, minOut: true, host: true,
});

/** Step 1 of the bet quote chain. */
export interface BetInputQuote {
  /** The token step 2 is quoted with (the input itself, the market's main or its pair asset). */
  token: Address;
  /** Raw units of `token`. */
  amount: bigint;
  route: BetRoute;
  /** The swap path (cross) or `[input, pairAsset]` (hop); empty for direct. */
  path: Address[];
}

/** A full bet quote; every amount is raw and feeds `buy` directly. */
export interface BetQuote {
  /** Shares quoted (18 dec). */
  shares: bigint;
  /** `minShares` for `buy`: shares minus slippage, never 0. */
  minShares: bigint;
  /** Market tokens that reach the pot after the bet fee. */
  netToken: bigint;
  /** Market tokens the input converts to, before the bet fee (the amount `minTokens` and `minBet` apply to). */
  tokens: bigint;
  /** `minTokens` for `buy` (a floor on market tokens, before the fee): `tokens` minus slippage, at least `minBet`. */
  minTokens: bigint;
  route: BetRoute;
  convertedToken: Address;
  convertedAmount: bigint;
  /** Bet fee in bps for the bettor (read live). */
  feeBps: number;
  host: Address;
}

/** The smallest bet a wallet can place in `inputToken`. */
export interface MinBetInput {
  /** Raw input-token units (with a 1% margin over the estimate). */
  minInput: bigint;
  /** Market tokens (before the fee) the bet must convert to: max(minBet, the precision floor in tokens). */
  minTokens: bigint;
  /** The market's minimum bet, market tokens. */
  minBet: bigint;
  /** Raw pair asset: a smaller bet reverts. 0 when fee-free. */
  precisionFloor: bigint;
  feeBps: number;
}

/** The arguments for `redeem` (fractionBps, slices, minOut), with the quote behind them. */
export interface RedeemPlan {
  fractionBps: number;
  slices: number;
  /** Whole remaining entitlement, market tokens. */
  entitlement: bigint;
  /** Market tokens sold now: entitlement × fractionBps / 10000. */
  payNow: bigint;
  /** Proceeds of `payNow` in `slices`, raw pair asset (`simulateSlicedSell`). */
  expectedOut: bigint;
  /** `minOut` for `redeem`: expectedOut minus slippage, never 0. */
  minOut: bigint;
  recommendedSlices: number;
  /** 0 when the whole entitlement fits in one transaction. */
  suggestedFraction: number;
  host: Address;
}

/** An outcome with its live odds. */
export interface LiveOutcome extends OutcomeInfo {
  /** Live odds, scaled by 1e18 (0 when the pool is empty). */
  oddsE18: bigint;
}

/**
 * Live state of a market, read from the chain (the fields the API serves from its database or no longer serves).
 * Raw units: market tokens / shares 18 dec; `Amount`s in the market's pair asset.
 */
export interface MarketLive {
  market: Address;
  host: Address;
  kind: HostKind;
  main: Address;
  pairAsset: Address;
  marketName: string;
  creator: Address;
  creationTime: bigint;
  /** Unix seconds; 0 = open-ended. */
  endTime: bigint;
  resolved: boolean;
  status: MarketStatus;
  /** ranking[0] on a resolved market, 254 = INVALID, 255 = unresolved. */
  finalOutcome: number;
  /** Private host: invite-only market (`privateEvent`). Always false on the public host. */
  isPrivate: boolean;
  /** The host is paused: no bets, no new markets. */
  paused: boolean;
  /** The market token is in its whitelist phase: only whitelisted wallets may bet. */
  frozen: boolean;
  numOutcomes: number;
  /** `marketSizes` for this market (its real outcome count). */
  sizes: MarketSizes;
  outcomes: LiveOutcome[];
  generalPot: bigint;
  totalOddsWeight: bigint;
  /** Market tokens in the pot. */
  pot: bigint;
  /** What the whole pot sells for now, in the pair asset. */
  potValue: Amount;
  /** What one market token (1e18) sells for now, in the pair asset. */
  tokenSellValue: Amount;
  /** The result in finish order (empty when unresolved or INVALID). */
  finalRanking: number[];
  /** Public host: bitmask of the outcomes tied for first (0 when unresolved / INVALID). Null on the private host. */
  finalWinnersMask: bigint | null;
  /** Private host: key of the winning ranking (zero when unresolved / INVALID). Null on the public host. */
  finalKey: Hex | null;
}

/**
 * What `user` can redeem on a market now. Zero payout and a null `quote` when unresolved or nothing is owed.
 * `getRedeemables` also returns an entry for a market it could not read (`skipped` set, zero payout).
 */
export interface Redeemable {
  market: Address;
  /** The market's host; the host given (or zero) on a skipped entry. */
  host: Address;
  /** null on a skipped entry. */
  kind: HostKind | null;
  user: Address;
  resolved: boolean;
  status: MarketStatus;
  /** Market tokens still owed. */
  tokenPayout: bigint;
  /** What they sell for in one go, in the pair asset. */
  pairPayout: Amount;
  /** `quoteRedemption(market, tokenPayout)`: single vs sliced, recommended slices, suggested fraction. */
  quote: RedemptionQuote | null;
  /**
   * `getRedeemables` only: why the market was skipped instead of read (null when it was read). 'unknown host': the
   * host given is not in the address book (no RPC made); 'unknown market': no address-book host lists the market.
   */
  skipped: 'unknown host' | 'unknown market' | null;
}

/** A market for `getRedeemables`, with its host when known (e.g. the API's `host` field), to skip the host probe. */
export interface RedeemableRef {
  market: Address;
  /** 'public' / 'private' / a host address. A host address not in the address book skips the market ('unknown host'). */
  host?: HostRef;
}

/** Slices of a host's sliced redeem, 1-25. */
const HOST_MAX_SLICES = 25;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const statusOf = (resolved: boolean, fo: number): MarketStatus =>
  !resolved || fo === OUTCOME_UNRESOLVED ? 'unresolved' : fo === OUTCOME_INVALID ? 'invalid' : 'resolved';
/** A caller's `main`: an address (strict: `toAddress`) or an address-book key, passed on as given. */
const mainArg = (m: MainRef): MainRef => (typeof m === 'string' && /^0x/i.test(m) ? toAddress(m, 'main') : m);
/** An optional caller address: `fallback` when omitted or null (as None in PY), else strict (`toAddress`). */
const optAddress = (v: Address | null | undefined, field: string, fallback: Address): Address => (v == null ? fallback : toAddress(v, field));

/**
 * Read-only views over prediction markets: outcomes, share quotes, sizes, payouts, sliced redemption quotes and the
 * bet quote chain (any accepted input token → shares). Most calls take the host first.
 */
export class MarketReaderModule extends BaseModule {
  private hostCache = new Map<string, Promise<{ host: Address; kind: HostKind }>>();
  private maxSlices: Promise<bigint> | null = null;

  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the market readers are deployed on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.trancheReader) && !isZeroAddress(this.client.addresses.redemptionReader);
  }

  private get reader(): Address {
    return this.require(this.client.addresses.trancheReader, 'TrancheReader');
  }

  private get redemption(): Address {
    return this.require(this.client.addresses.redemptionReader, 'RedemptionReader');
  }

  /** The signer, else 0x0 (quotes then price an unreferred wallet). */
  private get quoter(): Address {
    return this.client.account ?? zeroAddress;
  }


  /** Host address of a `HostRef` (no RPC). */
  resolveHost(host: HostRef): Address {
    if (host === 'public') return this.require(this.client.addresses.tranche, 'TrancheMarket');
    if (host === 'private') return this.require(this.client.addresses.tranchePrivate, 'TrancheMarketPrivate');
    const h = toAddress(host, 'host');
    if (isZeroAddress(h)) throw new ValidationError('host', 'Host address is zero.');
    return h;
  }

  /** 'public' or 'private' for a host. Unknown addresses are probed. */
  async hostKind(host: HostRef): Promise<HostKind> {
    if (host === 'public' || host === 'private') return host;
    const h = toAddress(host, 'host');
    const { tranche, tranchePrivate } = this.client.addresses;
    if (!isZeroAddress(tranche) && eq(h, tranche)) return 'public';
    if (!isZeroAddress(tranchePrivate) && eq(h, tranchePrivate)) return 'private';
    try {
      await this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'minSeed' });
      return 'public';
    } catch {
      return 'private';
    }
  }

  /** The host a market lives on, public tried first. Cached. */
  async hostOf(market: Address): Promise<{ host: Address; kind: HostKind }> {
    market = toAddress(market, 'market');
    const id = market.toLowerCase();
    let p = this.hostCache.get(id);
    if (!p) {
      p = this.findHost(market);
      this.hostCache.set(id, p);
      p.catch(() => this.hostCache.delete(id));
    }
    return p;
  }

  private async findHost(market: Address): Promise<{ host: Address; kind: HostKind }> {
    const { tranche, tranchePrivate } = this.client.addresses;
    const candidates: [Address, HostKind][] = [];
    if (!isZeroAddress(tranche)) candidates.push([tranche, 'public']);
    if (!isZeroAddress(tranchePrivate)) candidates.push([tranchePrivate, 'private']);
    if (candidates.length === 0) throw new NotDeployedError('TrancheMarket', this.client.chainId);
    for (const [host, kind] of candidates) {
      const md = await this.getMarketData(host, market);
      if (!isZeroAddress(md.marketToken) && eq(md.marketToken, market)) return { host, kind };
    }
    throw new ValidationError('unknown market', `${market} is not a market on the public or private host.`);
  }

  /** The host's market data, the odds total as `totalOddsWeight` (zero struct for an unknown market). */
  async getMarketData(host: HostRef, market: Address): Promise<HostMarketData> {
    market = toAddress(market, 'market');
    const { totalVirtualReserve, ...d } = await this.publicClient.readContract({
      address: this.resolveHost(host), abi: TrancheMarketAbi, functionName: 'getMarketData', args: [market],
    });
    return { ...d, totalOddsWeight: totalVirtualReserve };
  }

  /** Host, main, pair asset and market data of a market (host detected when omitted or null). Throws for an unknown market. */
  async marketContext(market: Address, host?: HostRef | null): Promise<MarketContext> {
    market = toAddress(market, 'market');
    let h: Address;
    let kind: HostKind;
    if (host == null) {
      ({ host: h, kind } = await this.hostOf(market));
    } else {
      h = this.resolveHost(host);
      kind = await this.hostKind(host);
    }
    const data = await this.getMarketData(h, market);
    if (isZeroAddress(data.marketToken) || !eq(data.marketToken, market)) {
      throw new ValidationError('unknown market', `${market} is not a market on host ${h}.`);
    }
    return { market, host: h, kind, main: data.ecosystem, pairAsset: data.usdc, data };
  }


  /** Every outcome with odds (`probability` bps, `pricePerShare` the odds × 1e18) and the tranche-aware `hasWon`. */
  async getAllOutcomes(host: HostRef, market: Address): Promise<OutcomeInfo[]> {
    market = toAddress(market, 'market');
    const rows = await this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'getAllOutcomes', args: [this.resolveHost(host), market],
    });
    return rows.map((o) => ({
      outcomeId: Number(o.outcomeId),
      name: o.name,
      oddsWeight: o.virtualReserve,
      totalCost: o.totalCost,
      circulatingShares: o.circulatingShares,
      pricePerShare: o.pricePerShare,
      probability: Number(o.probability),
      hasWon: o.hasWon,
    }));
  }

  /**
   * Shares for a bet against the pool, conversion and the buyer's fee included.
   * `inputToken` must be the market token, its pair asset or its main (anything else quotes (0, 0); use `quoteBet`).
   * `amount` raw input units; `netToken` = market tokens reaching the pot. `buyer` defaults to the signer, else 0x0.
   */
  async quoteShares(host: HostRef, market: Address, outcome: number, inputToken: Address, amount: bigint, buyer?: Address): Promise<{ shares: bigint; netToken: bigint }> {
    market = toAddress(market, 'market');
    inputToken = toAddress(inputToken, 'inputToken');
    const who = optAddress(buyer, 'buyer', this.quoter);
    const [shares, netToken] = await this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'quoteShares',
      args: [this.resolveHost(host), market, this.outcomeArg(outcome), inputToken, toUint(amount, 'amount'), who],
    });
    return { shares, netToken };
  }

  /**
   * Shares for an order-book buy with a budget of `amount` raw pair asset, sweeping `orderIds` first, the rest
   * against the pool (none = the pool only; left out or null: none, as None in PY). `user` defaults to the signer,
   * else 0x0. The inputs are checked before any read (`orderIds` an array, else 'orderIds'; each id a whole number,
   * 'orderId'); then the market: an unknown market is `ValidationError('unknown market')`.
   */
  async estimateSharesOut(host: HostRef, market: Address, outcome: number, amount: bigint, orderIds: readonly (bigint | number)[] | null = [], user?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const who = optAddress(user, 'user', this.quoter);
    const idsIn: unknown = orderIds ?? [];
    if (!Array.isArray(idsIn)) throw new ValidationError('orderIds', 'orderIds must be an array of order ids.');
    const ids = idsIn.map((i) => toUint(i, 'orderId'));
    const pick = this.outcomeArg(outcome);
    const raw = toUint(amount, 'amount');
    await this.marketContext(market, host);
    return this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'estimateSharesOut',
      args: [this.resolveHost(host), market, pick, raw, ids, who],
    });
  }

  /** `user`'s shares on every outcome, indexed by outcome id (18 dec). `user` defaults to the signer. */
  async getAllUserShares(host: HostRef, market: Address, user?: Address): Promise<bigint[]> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const r = await this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'getAllUserShares', args: [this.resolveHost(host), market, who],
    });
    return [...r];
  }

  /** Shares for parallel `(users[i], outcomeIds[i])` pairs (18 dec). Both must be arrays ('users' / 'outcomeIds'), checked before any read. */
  async getUserSharesBatch(host: HostRef, market: Address, users: readonly Address[], outcomeIds: readonly number[]): Promise<bigint[]> {
    market = toAddress(market, 'market');
    if (!Array.isArray(users as unknown)) throw new ValidationError('users', 'users must be an array of addresses.');
    if (!Array.isArray(outcomeIds as unknown)) throw new ValidationError('outcomeIds', 'outcomeIds must be an array of outcome ids.');
    if (users.length !== outcomeIds.length) throw new ValidationError('length mismatch', `users (${users.length}) and outcomeIds (${outcomeIds.length}) must be the same length.`);
    const wallets = users.map((u) => toAddress(u, 'users'));
    const r = await this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'getUserSharesBatch',
      args: [this.resolveHost(host), market, wallets, outcomeIds.map((o) => this.outcomeArg(o))],
    });
    return [...r];
  }

  /** What `amount` market tokens sell for now, in the market's pair asset. */
  async valueInPairAsset(host: HostRef, market: Address, amount: bigint): Promise<Amount> {
    market = toAddress(market, 'market');
    const h = this.resolveHost(host);
    const [raw, md] = await Promise.all([
      this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [h, market, toUint(amount, 'amount')] }),
      this.getMarketData(h, market),
    ]);
    return pairAmount(raw, await this.client.mains.get(md.ecosystem));
  }

  /**
   * `user`'s payout if the market resolved with (`ranking`, `tieMask`) now.
   * An invalid ranking quotes 0, and so does `[]` (INVALID): the hosts quote only rankings here. For INVALID use
   * `quoteInvalidRefund`. `user` defaults to the signer. Checked before any read: `ranking` an array ('ranking') of
   * outcome ids 0-255 ('outcome'), `tieMask` a whole number ('tieMask': null is refused; left out = 0).
   */
  async quoteScenario(host: HostRef, market: Address, ranking: readonly number[], tieMask: bigint | number = 0n, user?: Address): Promise<PayoutQuote> {
    market = toAddress(market, 'market');
    if (!Array.isArray(ranking as unknown)) throw new ValidationError('ranking', 'ranking must be an array of outcome ids.');
    const picks = ranking.map((r) => this.outcomeArg(r));
    const mask = toUint(tieMask, 'tieMask');
    const who = user == null ? this.account : toAddress(user, 'user');
    const h = this.resolveHost(host);
    const [[tokenPayout, pair], md] = await Promise.all([
      this.publicClient.readContract({
        address: this.reader, abi: TrancheReaderAbi, functionName: 'quoteScenarioUSDB',
        args: [h, market, picks, mask, who],
      }),
      this.getMarketData(h, market),
    ]);
    return { tokenPayout, pairPayout: pairAmount(pair, await this.client.mains.get(md.ecosystem)) };
  }

  /** `user`'s claim on a resolved market; 0 before resolution. `user` defaults to the signer. */
  async quoteRedeemValue(host: HostRef, market: Address, user?: Address): Promise<PayoutQuote> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const h = this.resolveHost(host);
    const [[tokenPayout, pair], md] = await Promise.all([
      this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'quoteRedeemUSDB', args: [h, market, who] }),
      this.getMarketData(h, market),
    ]);
    return { tokenPayout, pairPayout: pairAmount(pair, await this.client.mains.get(md.ecosystem)) };
  }

  /**
   * What `user` (default the signer) would get back if the market resolved INVALID now (`quoteScenario` quotes `[]`
   * as 0). It is based on an average cost, so it can differ from what the user paid. `pairPayout` = what the refund
   * sells for now. Rules 'unknown market', 'market resolved' (then `quoteRedeemValue` gives what is owed).
   */
  async quoteInvalidRefund(host: HostRef, market: Address, user?: Address): Promise<PayoutQuote> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const ctx = await this.marketContext(market, host);
    if (ctx.data.resolved) throw new ValidationError('market resolved', `Market ${market} is resolved: the redeem quote gives what is owed.`);
    const [outcomes, shares, info] = await Promise.all([
      this.getAllOutcomes(ctx.host, market),
      this.getAllUserShares(ctx.host, market, who),
      this.client.mains.get(ctx.main),
    ]);
    let totalCost = 0n;
    let userCost = 0n;
    for (const o of outcomes) {
      totalCost += o.totalCost;
      const s = shares[o.outcomeId] ?? 0n;
      if (s > 0n && o.circulatingShares > 0n) userCost += (s * o.totalCost) / o.circulatingShares;
    }
    const pot = ctx.data.generalPot;
    const tokenPayout = totalCost > 0n && pot > 0n ? userCost + (userCost * pot) / totalCost : userCost;
    const pair = tokenPayout === 0n
      ? 0n
      : await this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [ctx.host, market, tokenPayout] });
    return { tokenPayout, pairPayout: pairAmount(pair, info) };
  }

  /**
   * Sizes of a market of `numOutcomes` on `main`, with the host's seed floor.
   * Raw units: unit / seedStep / minSeed in pair asset, minBet / perOutcome / totalPool in market tokens.
   */
  async marketSizes(host: HostRef, main: MainRef, numOutcomes: number): Promise<MarketSizes> {
    return this.sizesOf(host, main, numOutcomes, true);
  }

  /** `marketSizes`; `creation` applies the 2 to outcome-limit rule (a creation rule: a live market keeps its outcome count). */
  private async sizesOf(host: HostRef, main: MainRef, numOutcomes: number, creation: boolean): Promise<MarketSizes> {
    const h = this.resolveHost(host);
    const mainAddr = this.client.mains.addressOf(mainArg(main));
    const n = Number(toUint(numOutcomes, 'numOutcomes'));
    const kind = await this.hostKind(host);
    if (creation) {
      const maxOutcomes = await this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'MAX_OUTCOMES' });
      const cap = maxOutcomes < 255n ? Number(maxOutcomes) : 255;
      if (n < 2 || n > cap) throw new ValidationError('outcomes', `A market needs 2 to ${cap} outcomes, got ${n}.`);
    }

    const [unit, seedStep, minBet, perOutcome, totalPool] = await this.publicClient.readContract({
      address: this.reader, abi: TrancheReaderAbi, functionName: 'sizesFor', args: [h, mainAddr, BigInt(n)],
    });
    if (kind === 'public') {
      const floor = await this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'minSeed' });
      return { unit, seedStep, minBet, perOutcome, totalPool, minSeed: floor * unit, kind };
    }
    const [pub, priv] = await Promise.all([
      this.publicClient.readContract({ address: h, abi: TrancheMarketPrivateAbi, functionName: 'minSeedPublic' }),
      this.publicClient.readContract({ address: h, abi: TrancheMarketPrivateAbi, functionName: 'minSeedPrivate' }),
    ]);
    return { unit, seedStep, minBet, perOutcome, totalPool, minSeed: pub * unit, minSeedPrivateEvent: priv * unit, kind };
  }


  /**
   * Live state of a market in one call: host `paused`, the token's `frozen`, `sizes`, the outcomes with live odds,
   * the pot and its sell value, one token's sell value, the final ranking and `finalWinnersMask` (public) or
   * `finalKey` (private). Host detected when omitted. `sizes` uses the market's real outcome count (no outcome limit:
   * that is a creation rule).
   */
  async getMarketLive(market: Address, host?: HostRef | null): Promise<MarketLive> {
    market = toAddress(market, 'market');
    const ctx = await this.marketContext(market, host);
    const h = ctx.host;
    const d = ctx.data;
    const [paused, frozen, outcomes, finalRanking, finalWinnersMask, finalKey, info] = await Promise.all([
      this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'paused' }),
      this.publicClient.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'frozen' }),
      this.getAllOutcomes(h, market),
      this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'getFinalRanking', args: [market] }),
      ctx.kind === 'public'
        ? this.publicClient.readContract({ address: h, abi: TrancheMarketAbi, functionName: 'finalWinnersMask', args: [market] })
        : Promise.resolve(null),
      ctx.kind === 'private'
        ? this.publicClient.readContract({ address: h, abi: TrancheMarketPrivateAbi, functionName: 'finalKey', args: [market] })
        : Promise.resolve(null),
      this.client.mains.get(ctx.main),
    ]);
    const pot = outcomes.reduce((s, o) => s + o.totalCost, d.generalPot);
    const sum = outcomes.reduce((s, o) => s + o.oddsWeight, 0n);
    const [sizes, potRaw, tokenRaw] = await Promise.all([
      this.sizesOf(h, ctx.main, outcomes.length, false),
      this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [h, market, pot] }),
      this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [h, market, 10n ** 18n] }),
    ]);
    const fo = Number(d.finalOutcome);
    return {
      market, host: h, kind: ctx.kind, main: ctx.main, pairAsset: ctx.pairAsset,
      marketName: d.marketName, creator: d.creator, creationTime: d.creationTime, endTime: d.endTime,
      resolved: d.resolved, status: statusOf(d.resolved, fo), finalOutcome: fo,
      isPrivate: d.isPrivate, paused, frozen,
      numOutcomes: outcomes.length, sizes,
      outcomes: outcomes.map((o) => ({ ...o, oddsE18: sum === 0n ? 0n : (o.oddsWeight * 10n ** 18n) / sum })),
      generalPot: d.generalPot, totalOddsWeight: d.totalOddsWeight,
      pot, potValue: pairAmount(potRaw, info), tokenSellValue: pairAmount(tokenRaw, info),
      finalRanking: finalRanking.map(Number), finalWinnersMask, finalKey,
    };
  }

  /**
   * What `user` (default the signer) can redeem on `market` now: the tokens owed, their one-shot value and, when
   * something is owed, `quoteRedemption` (single vs sliced). Host detected when omitted.
   */
  async getRedeemable(market: Address, user?: Address, host?: HostRef | null): Promise<Redeemable> {
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const ctx = await this.marketContext(market, host);
    const [[tokenPayout, pair], info] = await Promise.all([
      this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'quoteRedeemUSDB', args: [ctx.host, market, who] }),
      this.client.mains.get(ctx.main),
    ]);
    const quote = tokenPayout > 0n ? await this.quoteRedemption(market, tokenPayout) : null;
    const fo = Number(ctx.data.finalOutcome);
    return {
      market, host: ctx.host, kind: ctx.kind, user: who,
      resolved: ctx.data.resolved, status: statusOf(ctx.data.resolved, fo),
      tokenPayout, pairPayout: pairAmount(pair, info), quote, skipped: null,
    };
  }

  /**
   * `getRedeemable` for each market, in order: an address (host detected) or `{ market, host }` (host taken when it is
   * an address-book host). A market that cannot be placed does not fail the batch: its entry has `skipped` set
   * ('unknown host': the host given is not in the address book, no RPC; 'unknown market': no host lists it) and a zero
   * payout. A malformed market or host address throws `ValidationError` before any read, and so does a `markets` that
   * is not an array ('markets') or an entry that is neither a string nor a plain `{ market, host }` object ('market':
   * null, a number, an array, a Map or a class instance); other errors (RPC) reject. `user` defaults to the signer.
   */
  async getRedeemables(markets: readonly (Address | RedeemableRef)[], user?: Address): Promise<Redeemable[]> {
    if (!Array.isArray(markets as unknown)) throw new ValidationError('markets', 'markets must be an array of markets.');
    const who = user == null ? this.account : toAddress(user, 'user');
    const refs = Array.from(markets, (m, i): RedeemableRef => {
      const v: unknown = m;
      if (typeof v !== 'string' && (typeof v !== 'object' || v === null || Array.isArray(v)
          || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null))) {
        const shown = v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object that is not a plain { ... }'
          : typeof v === 'bigint' ? `${v}n` : typeof v === 'function' ? 'a function' : String(v);
        throw new ValidationError('market', `markets[${i}] must be a market address or a { market, host } object, got ${shown}.`);
      }
      const ref = (typeof v === 'string' ? { market: v } : v) as RedeemableRef;
      const h = ref.host == null ? undefined : ref.host === 'public' || ref.host === 'private' ? ref.host : toAddress(ref.host, 'host');
      return { market: toAddress(ref.market, 'market'), host: h };
    });
    return Promise.all(refs.map(async (ref) => {
      const host: HostRef | undefined = ref.host;
      if (host !== undefined && host !== 'public' && host !== 'private') {
        const { tranche, tranchePrivate } = this.client.addresses;
        const known = (!isZeroAddress(tranche) && eq(host, tranche)) || (!isZeroAddress(tranchePrivate) && eq(host, tranchePrivate));
        if (!known) return this.skippedRedeemable(ref.market, isZeroAddress(host) ? zeroAddress : host, who, 'unknown host');
      }
      try {
        return await this.getRedeemable(ref.market, who, host);
      } catch (e) {
        if (e instanceof ValidationError && e.rule === 'unknown market') {
          const h = host === undefined ? zeroAddress : this.resolveHost(host);
          return this.skippedRedeemable(ref.market, h, who, 'unknown market');
        }
        throw e;
      }
    }));
  }

  private skippedRedeemable(market: Address, host: Address, user: Address, why: 'unknown host' | 'unknown market'): Redeemable {
    return {
      market, host, kind: null, user, resolved: false, status: 'unresolved', tokenPayout: 0n,
      pairPayout: { raw: 0n, formatted: '0', decimals: 0, unit: 'pairAsset', asset: zeroAddress, symbol: '' }, quote: null, skipped: why,
    };
  }


  /**
   * Step 1 of the bet quote chain: convert `amount` of `input` toward the token step 2 quotes with, the way the bet
   * itself will.
   * - `marketToken`, `pairAsset`, `main` → `direct` (no call);
   * - a token on `main` → `cross`, step-2 token = main;
   * - another main, or a token on another main → `cross`, step-2 token = pairAsset;
   * - any other token → `hop`, step-2 token = pairAsset.
   * `bettor` is the trader of a `cross` quote (referral discount included; left out or null: the signer, else 0x0, as in
   * PY). Raw units throughout. An outside hop (the whole of a `hop`, and the last step of a `cross` from a token whose
   * pair asset is not the market's) is checked as a swap sent now, as `trading.swapCross` checks one: refused with
   * 'no route' when it has no route, and 'above cap' when the amount that reaches it is more than it takes right now
   * (the message says whether waiting about 12 s clears it, or to send less). A failure of the outside-hop quote is
   * classified: an RPC failure is `BasisRpcError`, a revert `BasisContractError`. Other read failures on the way come
   * as the RPC client threw them (the cross quote's as `trading.quoteCross` decodes it).
   */
  async quoteBetInput(params: QuoteBetInputParams): Promise<BetInputQuote> {
    const p = optsOf(params, QUOTE_BET_INPUT_KEYS);
    const input = toAddress(p.input, 'input');
    const pairAsset = toAddress(p.pairAsset, 'pairAsset');
    const main = toAddress(p.main, 'main');
    const marketToken = p.marketToken == null ? undefined : toAddress(p.marketToken, 'marketToken');
    const bettor = optAddress(p.bettor, 'bettor', this.quoter);
    const amount = toUint(p.amount, 'amount');
    if (amount <= 0n) throw new ValidationError('amount', 'The bet amount must be above 0.');
    if (eq(input, pairAsset) || eq(input, main) || (marketToken && eq(input, marketToken))) {
      return { token: input, amount, route: 'direct', path: [] };
    }

    let path: Address[] | null = null;
    let token: Address = pairAsset;
    let sold: CrossRouteToken[] | null = null;
    if (await this.client.mains.isMain(input)) {
      const itsPair = await this.client.mains.pairAssetOf(input);
      if (eq(itsPair, pairAsset)) {
        path = [input, itsPair];
      } else {
        path = [input, itsPair, pairAsset];
        sold = [{ address: input, kind: 'main', main: input, pair: itsPair }];
      }
    } else if (await this.isEcosystemToken(input)) {
      const itsMain = await this.publicClient.readContract({ address: input, abi: EcosystemTokenAbi, functionName: 'quoteToken' });
      if (!(await this.client.mains.isMain(itsMain))) {
        throw new ValidationError('unknown pair', `${input} trades against ${itsMain}, which is not a main on SWAP.`);
      }
      if (eq(itsMain, main)) {
        path = [input, main];
        token = main;
      } else {
        const itsPair = await this.client.mains.pairAssetOf(itsMain);
        if (eq(itsPair, pairAsset)) {
          path = [input, itsMain, pairAsset];
        } else {
          path = [input, itsMain, itsPair, pairAsset];
          sold = [
            { address: input, kind: 'token', main: itsMain, pair: itsPair },
            { address: itsMain, kind: 'main', main: itsMain, pair: itsPair },
          ];
        }
      }
    }

    if (path) {
      const hop = sold ? ` (${path[sold.length]} to ${path[sold.length + 1]})` : '';
      const out = await this.client.trading.quoteCross(path, amount, bettor).catch((e: unknown) => {
        if (isRevertNamed(e, 'above cap')) {
          throw new ValidationError('above cap', `${amount} of ${input} is above the outside route's caps on its way${hop}: send less.`);
        }
        throw e;
      });
      if (out <= 0n) throw new ValidationError('Zero sold', `${amount} of ${input} converts to nothing. Try a larger amount.`);
      if (sold) {
        const after = await Promise.all(path.slice(sold.length).map((t) => routeTokenOf(this.client, t)));
        await checkCrossHop(this.client, path, [...sold, ...after], amount, bettor, (ex, a, b, x) => this.hopQuote(ex, a, b, x));
      }
      return { token, amount: out, route: 'cross', path };
    }
    const exec = await this.client.trading.getHopExecutor();
    if (isZeroAddress(exec)) {
      throw new ValidationError('Buy: need asset/MAIN', `${input} is not a BASIS token and SWAP has no hop executor on chain ${this.client.chainId}.`);
    }
    const hops = await this.publicClient.readContract({ address: exec, abi: HopExecutorAbi, functionName: 'getRoute', args: [input, pairAsset] });
    if (hops.length === 0) throw new ValidationError('no route', `No outside route from ${input} to ${pairAsset}.`);
    const out = await quoteHopWithinCaps(this.client, exec, input, pairAsset, amount, (x) => this.hopQuote(exec, input, pairAsset, x));
    if (out <= 0n) throw new ValidationError('zero hop', `${amount} of ${input} converts to nothing. Try a larger amount.`);
    return { token: pairAsset, amount: out, route: 'hop', path: [input, pairAsset] };
  }

  /**
   * The full bet quote for any accepted input token (pair asset, the market's main, the market token, any BASIS token,
   * an outside token with a hop route): step 1 `quoteBetInput`, step 2 `quoteShares`, then the minimums for `buy`
   * with `slippageBps` (default `client.slippageBps.trade`).
   * Throws `ValidationError` when the bet is below `minBet` or below its precision floor (see `minBetInput`); a bet
   * that does not quote on a main whose pair is paused throws 'pair not active' instead.
   */
  async quoteBet(params: QuoteBetParams): Promise<BetQuote> {
    const p = optsOf(params, QUOTE_BET_KEYS);
    const market = toAddress(p.market, 'market');
    const input = toAddress(p.input, 'input');
    const bettor = optAddress(p.bettor, 'bettor', this.quoter);
    const ctx = await this.marketContext(market, p.host);
    const step1 = await this.quoteBetInput({ input, amount: p.amount, pairAsset: ctx.pairAsset, main: ctx.main, marketToken: market, bettor });
    const [{ shares, netToken }, feeBps, minBet] = await Promise.all([
      this.quoteShares(ctx.host, market, p.outcome, step1.token, step1.amount, bettor),
      this.client.taxes.getTaxRate(market, bettor),
      this.minBetOf(ctx),
    ]);
    if (shares === 0n) {
      await this.refusePausedPair(ctx, 'bet');
      throw new ValidationError('quote', `No shares for this bet (market resolved, outcome ${p.outcome} out of range, or the input does not convert).`);
    }

    const tokens = eq(step1.token, market) ? step1.amount : this.grossOf(netToken, feeBps);
    if (tokens < minBet) {
      throw new ValidationError('minBet', `The bet converts to ${tokens} market tokens, below the minimum bet of ${minBet}.`);
    }
    await this.checkFeeSells(ctx, tokens, feeBps);

    const bps = p.slippageBps ?? this.client.slippageBps.trade;
    const minShares = await this.resolveMin(undefined, bps, async () => shares, 'trade', 'minShares');
    let minTokens = minWithSlippage(tokens, bps);
    if (minTokens < minBet) minTokens = minBet;
    return {
      shares, minShares, netToken, tokens, minTokens,
      route: step1.route, convertedToken: step1.token, convertedAmount: step1.amount,
      feeBps, host: ctx.host,
    };
  }

  /**
   * The smallest bet `bettor` can place in `inputToken` (raw input units, 1% margin): the input must convert to at least
   * `minBet` and clear the precision floor (a smaller bet reverts without a reason).
   * `bettor` defaults to the signer, else 0x0. Throws 'quote' when the market or the input cannot be priced ('pair not
   * active' when that is because the market's main is on a paused pair), and 'above cap' when an outside hop on the
   * input's route cannot take a probe of it right now (its message says when waiting about 12 seconds clears it, or to
   * send less); an RPC failure of a probe is `BasisRpcError`, never 'quote'.
   */
  async minBetInput(host: HostRef | null | undefined, market: Address, inputToken: Address, bettor?: Address): Promise<MinBetInput> {
    market = toAddress(market, 'market');
    inputToken = toAddress(inputToken, 'inputToken');
    const who = optAddress(bettor, 'bettor', this.quoter);
    const ctx = await this.marketContext(market, host);
    const [minBet, feeBps] = await Promise.all([this.minBetOf(ctx), this.client.taxes.getTaxRate(market, who)]);

    let precisionFloor = 0n;
    let minTokens = minBet;
    if (feeBps > 0) {
      precisionFloor = ceilDiv(ceilDiv(BPS, BigInt(feeBps)) * 12n, 10n);
      const probe = minBet * 100n > 0n ? minBet * 100n : 10n ** 18n;
      const value = await this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [ctx.host, market, probe] });
      if (value === 0n) {
        await this.refusePausedPair(ctx, 'bet');
        throw new ValidationError('quote', `Market ${market} cannot be priced in its pair asset.`);
      }
      const precisionTokens = ceilDiv(precisionFloor * probe, value);
      if (precisionTokens > minTokens) minTokens = precisionTokens;
    }

    if (eq(inputToken, market)) {
      return { minInput: minTokens, minTokens, minBet, precisionFloor, feeBps };
    }

    const tokensFor = async (x: bigint): Promise<bigint> => {
      const s1 = await this.quoteBetInput({ input: inputToken, amount: x, pairAsset: ctx.pairAsset, main: ctx.main, marketToken: market, bettor: who });
      const { netToken } = await this.quoteShares(ctx.host, market, 0, s1.token, s1.amount, who);
      return this.grossOf(netToken, feeBps);
    };
    const { decimals } = await this.client.mains.tokenMeta(inputToken);
    let x = 10n ** BigInt(decimals);
    let got = 0n;
    for (let i = 0; i < 4 && got === 0n; i++) {
      got = await tokensFor(x).catch((e: unknown) => {
        if (e instanceof ValidationError && e.rule === 'above cap') throw e;
        return zeroUnlessRpc(e, undefined, 'quoteBetInput');
      });
      if (got === 0n) x *= 1000n;
    }
    if (got === 0n) {
      await this.refusePausedPair(ctx, 'bet');
      throw new ValidationError('quote', `${inputToken} does not convert into market ${market}.`);
    }
    for (let i = 0; i < 3; i++) {
      x = (ceilDiv(x * minTokens, got) * 101n) / 100n + 1n;
      got = await tokensFor(x);
      if (got >= minTokens) break;
    }
    return { minInput: x, minTokens, minBet, precisionFloor, feeBps };
  }


  /** Redemption quote: single vs sliced proceeds, recommended slices, partial plan. `amount` = market tokens. */
  async quoteRedemption(market: Address, amount: bigint): Promise<RedemptionQuote> {
    market = toAddress(market, 'market');
    const q = await this.publicClient.readContract({ address: this.redemption, abi: RedemptionReaderAbi, functionName: 'quoteRedemption', args: [market, toUint(amount, 'amount')] });
    return {
      bonded: q.bonded,
      tokenAmount: q.tokenAmount,
      valueAtSpot: q.usdAtSpot,
      singleOut: q.singleOut,
      slicedOut: q.slicedOut,
      impactSingleBps: Number(q.impactSingleBps),
      impactSlicedBps: Number(q.impactSlicedBps),
      recommendedSlices: Number(q.recommendedSlices),
      fitsInOneTx: q.fitsInOneTx,
      suggestedFractionBps: Number(q.suggestedFractionBps),
    };
  }

  /** Proceeds (raw pair asset) of selling `amount` market tokens in `slices` equal chunks (1 up to the reader's slice limit). */
  async simulateSlicedSell(market: Address, amount: bigint, slices: number): Promise<SlicedSell> {
    market = toAddress(market, 'market');
    const raw = toUint(amount, 'amount');
    const s = await this.slicesArg(slices);
    const [totalOut, perSlice] = await this.publicClient.readContract({
      address: this.redemption, abi: RedemptionReaderAbi, functionName: 'simulateSlicedSell', args: [market, raw, s],
    });
    return { totalOut, perSlice: [...perSlice] };
  }

  /** Same as `simulateSlicedSell`. */
  async quoteSlices(market: Address, amount: bigint, slices: number): Promise<SlicedSell> {
    market = toAddress(market, 'market');
    const raw = toUint(amount, 'amount');
    const s = await this.slicesArg(slices);
    const [totalOut, perSlice] = await this.publicClient.readContract({
      address: this.redemption, abi: RedemptionReaderAbi, functionName: 'quoteSlices', args: [market, raw, s],
    });
    return { totalOut, perSlice: [...perSlice] };
  }

  /** Face value of `amount` market tokens at the spot price (no price impact), raw pair asset. */
  async spotValue(market: Address, amount: bigint): Promise<bigint> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.redemption, abi: RedemptionReaderAbi, functionName: 'spotValue', args: [market, toUint(amount, 'amount')] });
  }

  /**
   * Arguments for `redeem` (fractionBps, slices, minOut):
   * payNow = the user's remaining entitlement × fractionBps / 10000, proceeds from `simulateSlicedSell(payNow, slices)`,
   * minOut = proceeds minus `slippageBps` (default `client.slippageBps.trade`). Defaults: `fractionBps` 10000, or the
   * reader's suggested fraction when the position cannot exit in one transaction; `slices` = the reader's recommendation
   * for `payNow` (1-25, the host's bound). Every slice must sell for at least 1 raw unit of the pair asset (the host
   * reverts with no reason otherwise): defaulted slices are lowered until each does; caller-chosen ones that do not are
   * refused with 'dust slice', and so is a single slice that sells for 0. An explicit `minOut` is returned as given.
   * A market whose main is on a paused pair is refused ('pair not active').
   * `user` defaults to the signer. A null option is left out, as None in PY.
   */
  async redeemPlan(params: RedeemPlanParams): Promise<RedeemPlan> {
    const p = optsOf(params, REDEEM_PLAN_KEYS);
    const market = toAddress(p.market, 'market');
    const user = p.user == null ? this.account : toAddress(p.user, 'user');
    const fractionIn = p.fractionBps ?? undefined;
    const slicesIn = p.slices ?? undefined;
    const ctx = await this.marketContext(market, p.host);
    if (!ctx.data.resolved) throw new ValidationError('market unresolved', `Market ${market} is not resolved yet.`);
    if (fractionIn !== undefined && (!Number.isInteger(fractionIn) || fractionIn < 1 || fractionIn > 10000)) {
      throw new ValidationError('fraction 1-10000', `fractionBps must be 1-10000, got ${fractionIn}.`);
    }
    if (slicesIn !== undefined && (!Number.isInteger(slicesIn) || slicesIn < 1 || slicesIn > HOST_MAX_SLICES)) {
      throw new ValidationError('slices 1-25', `slices must be 1-${HOST_MAX_SLICES}, got ${slicesIn}.`);
    }

    const entitlement = await this.publicClient.readContract({ address: ctx.host, abi: TrancheMarketAbi, functionName: 'quoteRedeem', args: [market, user] });
    if (entitlement === 0n) throw new ValidationError('Nothing to redeem', `${user} has nothing to redeem on ${market}.`);
    await this.refusePausedPair(ctx, 'redeem');

    const whole = await this.quoteRedemption(market, entitlement);
    const suggestedFraction = whole.fitsInOneTx ? 0 : whole.suggestedFractionBps;
    const fractionBps = fractionIn ?? (suggestedFraction > 0 ? suggestedFraction : 10000);
    const payNow = fractionBps === 10000 ? entitlement : (entitlement * BigInt(fractionBps)) / BPS;
    if (payNow === 0n) throw new ValidationError('Nothing to redeem', `fractionBps ${fractionBps} of ${entitlement} rounds to 0.`);

    const now = payNow === entitlement ? whole : await this.quoteRedemption(market, payNow);
    let slices = slicesIn ?? Math.min(Math.max(now.recommendedSlices, 1), HOST_MAX_SLICES);
    let sim = await this.simulateSlicedSell(market, payNow, slices);
    const dust = (n: number, perSlice: bigint[]) => {
      const base = payNow / BigInt(n);
      const rem = payNow - base * BigInt(n);
      return perSlice.some((out, i) => (i === 0 ? base + rem : base) > 0n && out === 0n);
    };
    while (dust(slices, sim.perSlice)) {
      if (slices === 1) {
        throw new ValidationError(
          'dust slice',
          `${payNow} market tokens sell for 0 of the pair asset (the redeem would revert)${fractionBps < 10000 ? ': redeem a larger fraction' : ''}.`,
        );
      }
      if (slicesIn !== undefined) {
        throw new ValidationError('dust slice', `With ${slices} slices of ${payNow / BigInt(slices)} market tokens a slice sells for 0 of the pair asset (the redeem would revert): use fewer slices.`);
      }
      slices = Math.max(1, Math.floor(slices / 2));
      sim = await this.simulateSlicedSell(market, payNow, slices);
    }
    const expectedOut = sim.totalOut;
    const minOut = await this.resolveMin(p.minOut ?? undefined, p.slippageBps ?? undefined, async () => expectedOut, 'trade', 'minOut');
    return {
      fractionBps, slices, entitlement, payNow, expectedOut, minOut,
      recommendedSlices: now.recommendedSlices, suggestedFraction, host: ctx.host,
    };
  }


  private outcomeArg(o: number): number {
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new ValidationError('outcome', `Outcome ids are 0-255, got ${o}.`);
    return o;
  }

  private async slicesArg(slices: number): Promise<bigint> {
    if (!this.maxSlices) {
      this.maxSlices = this.publicClient.readContract({ address: this.redemption, abi: RedemptionReaderAbi, functionName: 'MAX_SLICES' });
      this.maxSlices.catch(() => { this.maxSlices = null; });
    }
    const max = await this.maxSlices;
    if (!Number.isInteger(slices) || slices < 1 || BigInt(slices) > max) {
      throw new ValidationError(`slices 1-${max}`, `slices must be 1-${max}, got ${slices}.`);
    }
    return BigInt(slices);
  }

  /** The minimum bet of a market, market tokens. */
  private async minBetOf(ctx: MarketContext): Promise<bigint> {
    const r = await this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'sizesFor', args: [ctx.host, ctx.main, 2n] });
    return r[2];
  }

  /**
   * Market tokens before the bet fee, from the net amount. When two amounts net the same, the smaller one is used: it
   * keeps the minimum-bet check and `minTokens` on the safe side.
   */
  private grossOf(netToken: bigint, feeBps: number): bigint {
    const f = BigInt(feeBps);
    if (f <= 0n || f >= BPS) return netToken;
    const netOf = (g: bigint) => g - (g * f) / BPS;
    let g = (netToken * BPS) / (BPS - f);
    while (g > 0n && netOf(g - 1n) === netToken) g -= 1n;
    return g;
  }

  /** Refuses a bet under the precision floor (the host would revert it with no reason). */
  private async checkFeeSells(ctx: MarketContext, tokens: bigint, feeBps: number): Promise<void> {
    const fee = (tokens * BigInt(feeBps)) / BPS;
    if (fee === 0n) return;
    const v = await this.publicClient.readContract({ address: this.reader, abi: TrancheReaderAbi, functionName: 'valueInUsdb', args: [ctx.host, ctx.market, fee] });
    if (v === 0n) {
      await this.refusePausedPair(ctx, 'bet');
      throw new ValidationError('precision', `The bet fee (${fee} market tokens) sells for less than one raw unit of the pair asset; bet more (see minBetInput).`);
    }
  }

  /**
   * 'pair not active' when the market's main is on a paused pair, read now: it refuses bets and redeems ("unknown pair"
   * on chain).
   */
  private async refusePausedPair(ctx: MarketContext, action: 'bet' | 'redeem'): Promise<void> {
    const [, swap] = await this.publicClient.readContract({ address: ctx.host, abi: TrancheMarketAbi, functionName: 'ecosystems', args: [ctx.main] });
    const active = !isZeroAddress(swap) && (await this.publicClient.readContract({ address: swap, abi: SwapAbi, functionName: 'isMain', args: [ctx.main] }));
    if (active) return;
    const what = action === 'bet'
      ? 'no bets that convert through it until the pair is active again'
      : 'the payout sells through it, so no redeem until the pair is active again';
    throw new ValidationError('pair not active', `Market ${ctx.market} settles through main ${ctx.main}, which is on a paused pair: ${what}.`);
  }

  /**
   * Quote of an outside hop, net of its fee. A failure is classified (`classifyError`): an RPC failure is
   * `BasisRpcError`, a revert `BasisContractError`.
   */
  private async hopQuote(exec: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    try {
      const { result } = await this.publicClient.simulateContract({
        address: exec, abi: HopExecutorAbi, functionName: 'quoteHop', args: [tokenIn, tokenOut, amountIn], account: this.client.account,
      });
      return result;
    } catch (e) {
      throw classifyError(e, { contract: 'HopExecutor', functionName: 'quoteHop', abi: HopExecutorAbi });
    }
  }

  /** Is `token` a BASIS factory token? False when the factory is not deployed. */
  private async isEcosystemToken(token: Address): Promise<boolean> {
    const factory = this.client.addresses.factory;
    if (isZeroAddress(factory)) return false;
    return this.publicClient.readContract({ address: factory, abi: FactoryAbi, functionName: 'isEcosystemToken', args: [token] });
  }
}
