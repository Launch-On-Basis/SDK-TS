import { type Address, isAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import type { WalletMarket, WalletMarketsParams } from '../api/markets';
import { FactoryAbi, FactoryTokenAbi, MainTokenAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { type AmountOf, mainAmountOf, pairAmountOf } from './amounts';
import { ValidationError } from './errors';
import { errorText } from './redact';
import { type MainInfo, pairAmount } from './mains';
import { multicall, multicallSettled, type MulticallRead, type SettledRead } from './multicall';
import { optionKeys, optsOf } from './opts';
import { type Amount, toAddress, toAmount } from './units';
import type { Redeemable, RedeemableRef } from '../modules/MarketReader';
import type { UpDownClaimables, UpDownClaimRef } from '../modules/UpDown';
import type { WalletVesting } from '../modules/Vesting';

/** `getClaimables` sections, in result order. */
export type ClaimableSection = 'holderRewards' | 'markets' | 'upDown' | 'vesting' | 'vault' | 'liquidations';
export const CLAIMABLE_SECTIONS: readonly ClaimableSection[] = ['holderRewards', 'markets', 'upDown', 'vesting', 'vault', 'liquidations'];

/** A liquidation leftover still unclaimed more than 365 days after the liquidation can be taken. */
const CLAIM_PERIOD = 365n * 86_400n;
/** Leverage positions read per multicall. */
const LEVERAGE_PAGE = 100;
/** Factory tokens read per multicall in the chain scan. */
const SCAN_PAGE = 200;
/** Tokens checked for holder rewards per multicall (3 reads each). */
const REWARD_PAGE = 200;

/**
 * Inputs of `getClaimables`. A list left out (or null) is fetched (API lists, plus the chain for holder-reward tokens); a
 * list passed is used as given; `[]` skips that section. A list that is not an array (a string, a Set, an object) is
 * refused before any read, with the field's name as the rule.
 */
export interface GetClaimablesOptions {
  /**
   * Tokens to check for holder rewards. Default, with an API key: the API's tokens of the wallet (portfolio holdings,
   * every token it traded, its loan tokens); without one (a session-only or unauthenticated client): every factory
   * token (read from the chain in batches of 200), so a token held but never claimed from is found too. Either way plus,
   * from the chain, the tokens of its leverage positions, of its loans and of its beneficiary vestings (these earn
   * rewards for the wallet too). A list passed replaces all of these.
   */
  tokens?: Address[] | null;
  /**
   * Markets to check for redemptions (addresses or plain `{ market, host }` objects; any other entry: ValidationError
   * ('markets') naming its index, before any read). Default: the wallet's 'resolved' and 'invalidated' markets
   * (`api.getWalletMarkets`, every page).
   */
  markets?: (Address | RedeemableRef)[] | null;
  /** Up/Down rounds to quote. Default: `claimableBets` of the wallet's Up/Down record on this chain's Up/Down contract. */
  upDownRounds?: UpDownClaimRef[] | null;
  /**
   * Older loan-hub addresses to read on top of the address book's (`loans.atHub(hub)`): their loans count for the
   * liquidation leftovers and the holder-reward token list. Default: none.
   */
  loanHubs?: Address[] | null;
}
const GET_CLAIMABLES_KEYS = optionKeys<GetClaimablesOptions>({ tokens: true, markets: true, upDownRounds: true, loanHubs: true });

/** Holder rewards claimable on one factory token (`factory.claimRewards(token)`), in the token's pair asset. */
export interface HolderRewardClaimable {
  token: Address;
  amount: Amount;
}

/** A vesting with tokens claimable now (`vesting.claimTokens(id)`), in the vested token (unit 'main' for a main, else 'token'). */
export interface VestingClaimable {
  id: bigint;
  token: Address;
  claimable: Amount;
}

/** Vault rewards on one main (`vault.claim({ main })`), in the main. */
export interface VaultClaimable {
  main: Address;
  vault: Address;
  /** All unclaimed rewards (`earned`). */
  earned: Amount;
  /** What `claim` pays now: `min(earned, availableStasis)` (rewards backing a loan stay in the vault). */
  claimable: Amount;
}

/**
 * The owner's leftover of a liquidated position (unclaimed collateral). Claim it by `claimDeadline`
 * (365 days after the liquidation): once chain time is past that, it can be taken at any time.
 * - `hubLoan`: `loans.claimLiquidation(id)` (`id` = loan id) pays it to the wallet; on a loan hub other than the
 *   address book's, `loans.atHub(hub).claimLiquidation(id)`;
 * - `leverage`: `trading.claimLeverageLiquidation(main, id)` (`id` = position id) pays it to the wallet;
 * - `vestingLoan`: the loan of vesting `id` was liquidated; `vesting.repayLoanOnVesting(id)` settles it and returns
 *   `amount` to the schedule (not to the wallet; the schedule's claimable stays 0 until then). Listed even when
 *   `amount` is 0, since the schedule is frozen until settled.
 */
export interface LiquidationClaimable {
  kind: 'hubLoan' | 'leverage' | 'vestingLoan';
  /** The main the loan lives on. */
  main: Address;
  /** The loan hub the loan is on (`hubLoan`, `vestingLoan`); null for a leverage position. */
  hub: Address | null;
  /** The id to pass to the claim call: loan id, leverage position id, or vesting id. */
  id: bigint;
  /** `vestingLoan`: the vesting's loan id; null otherwise. */
  loanId: bigint | null;
  /** The collateral token. */
  token: Address;
  /** The leftover, in the collateral token (unit 'main' for a main, else 'token'). */
  amount: Amount;
  /** Unix seconds of the liquidation. */
  liquidatedAt: bigint;
  /** Unix seconds of the claim deadline (`liquidatedAt + 365 days`): after it the leftover can be taken. */
  claimDeadline: bigint;
  /** Amount > 0 and past `claimDeadline` at `blockTime`: it can be taken at any time, so claim it now. */
  claimExpired: boolean;
}

/**
 * A token with holder rewards that `getClaimables` could not value, so it is not in `holderRewards` (the others are):
 * the token it trades against is not a known main, so the asset its rewards are paid in is unknown.
 */
export interface SkippedToken {
  token: Address;
  /** The token it trades against. */
  quoteToken: Address;
  reason: 'unknown main';
}

/** A market `getRedeemables` could not place, so it was not read. */
export interface SkippedMarket {
  market: Address;
  /** The host the API (or the caller) gave; zero when none was given. */
  host: Address;
  /** 'unknown host': not an address-book host (no RPC made); 'unknown market': no address-book host lists the market. */
  reason: 'unknown host' | 'unknown market';
}

/**
 * A part of `getClaimables` that could not be read. `source` null: the whole section failed (its rows are empty);
 * otherwise one of the sources the section draws from failed and the section holds what the others gave: holder-reward
 * token lists ('portfolio' with an API key, 'chain' without one, 'leverage', 'loans', 'vesting') or liquidation reads
 * ('loans', 'leverage', 'vesting').
 */
export interface ClaimablesFailure {
  section: ClaimableSection;
  source: string | null;
  message: string;
  error: unknown;
}

/** Everything a wallet can claim now, per source, with the sum per asset (no USD: each asset is summed apart). */
export interface Claimables {
  user: Address;
  /** The latest block when the read started (the sections are read right after it, not pinned to it). */
  blockNumber: bigint;
  /** Unix seconds of that block (`claimExpired` is measured against it). */
  blockTime: bigint;
  /** `factory.getClaimableRewards` per token with `rewardsEnabled`, amount > 0. Tokens that are not factory tokens are skipped. */
  holderRewards: HolderRewardClaimable[];
  /** Reward tokens that trade against no known main: listed here instead of `holderRewards`, the others still read. */
  skippedTokens: SkippedToken[];
  /** `marketReader.getRedeemables`, `tokenPayout > 0` only. */
  markets: Redeemable[];
  /** Markets that could not be placed (unknown host or market), not read. */
  skippedMarkets: SkippedMarket[];
  /** `updown.getClaimable` over the rounds (every round given; a 0 payout = not quotable now). */
  upDown: UpDownClaimables;
  /** `vesting.getVestingsOf(user, { role: 'beneficiary' })` with `claimable > 0`. */
  vesting: VestingClaimable[];
  /** `vault.getPositions(user)` with `claimable > 0`. */
  vault: VaultClaimable[];
  /** Liquidation leftovers: loans, leverage positions, then vesting loans awaiting settlement. */
  liquidations: LiquidationClaimable[];
  /**
   * Sum per asset, first-seen order, non-zero only: holder rewards, market `pairPayout`, Up/Down payouts, vesting
   * claimables, vault `claimable`, and loan / leverage leftovers (vesting-loan leftovers return to their schedule
   * and are not counted). Each asset keeps its own decimals and unit ('pairAsset' for a main's pair asset, 'main' for a
   * main, 'token' for any other token: the rule of write results, used by every section).
   */
  totals: { asset: Address; amount: Amount }[];
  /** Sections skipped because their contract is not deployed here. */
  skipped: ClaimableSection[];
  /** Sections, or lists they draw from, that could not be read (API or RPC errors), in section order. */
  failed: ClaimablesFailure[];
}

/** A leverage position of the wallet, as read from the chain. */
interface LeverageRow {
  main: Address;
  id: bigint;
  token: Address;
  liquidationClaim: bigint;
  isLiquidated: boolean;
  timeOfClosure: bigint;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Addresses without duplicates (case-insensitive), first spelling kept. */
function uniqueAddresses(list: readonly Address[]): Address[] {
  return [...new Map(list.map((a) => [a.toLowerCase(), a] as const)).values()];
}

/**
 * Formatter per token by the `amountOf` rule of write results (a main: unit 'main'; a main's pair asset: 'pairAsset';
 * anything else: 'token'), from the cached mains list and token metadata, so no `isMain` read per row. One per call.
 */
function amountResolver(client: BasisClient): (token: Address) => Promise<AmountOf> {
  const cache = new Map<string, Promise<AmountOf>>();
  return (token) => {
    const k = token.toLowerCase();
    let p = cache.get(k);
    if (!p) {
      p = (async (): Promise<AmountOf> => {
        const mains = await client.mains.list();
        const main = mains.find((m) => eq(m.main, token));
        if (main) return mainAmountOf(main);
        const owner = mains.find((m) => eq(m.pairAsset, token));
        if (owner) return pairAmountOf(owner);
        const meta = await client.mains.tokenMeta(token);
        return (raw) => toAmount(raw, meta.decimals, 'token', token, meta.symbol);
      })();
      cache.set(k, p);
    }
    return p;
  };
}

function message(e: unknown): string {
  return errorText(e);
}

/** Every leverage position of `who` on every main (one multicall for the counts, one per 100 positions). */
async function readLeverages(client: BasisClient, who: Address): Promise<LeverageRow[]> {
  const mains = await client.mains.list();
  if (!mains.length) return [];
  const counts = await multicall(client, mains.map((m): MulticallRead => ({
    address: m.main, abi: MainTokenAbi, functionName: 'leverageCount', args: [who], contract: 'MainToken',
  }))) as bigint[];
  const ids: { main: Address; id: bigint }[] = [];
  mains.forEach((m, i) => { for (let id = 1n; id <= counts[i]; id++) ids.push({ main: m.main, id }); });
  const out: LeverageRow[] = [];
  for (let i = 0; i < ids.length; i += LEVERAGE_PAGE) {
    const page = ids.slice(i, i + LEVERAGE_PAGE);
    const rows = await multicall(client, page.map((p): MulticallRead => ({
      address: p.main, abi: MainTokenAbi, functionName: 'leverages', args: [who, p.id], contract: 'MainToken',
    })));
    page.forEach((p, j) => {
      const r = rows[j] as readonly unknown[];
      out.push({
        main: p.main, id: p.id, token: r[1] as Address, liquidationClaim: r[7] as bigint, isLiquidated: r[8] as boolean,
        timeOfClosure: r[11] as bigint,
      });
    });
  }
  return out;
}

/** Holder-reward tokens the API knows for `who` (API key): portfolio holdings, traded tokens and loan tokens. */
async function apiRewardTokens(client: BasisClient, who: Address): Promise<Address[]> {
  const p = await client.api.getWalletPortfolio(who);
  return [
    ...(p.holdings ?? []).filter((h) => !h.isMain && h.address).map((h) => h.address as Address),
    ...(p.costBasis?.tokens ?? []).flatMap((t) => (t.token ? [t.token as Address] : [])),
    ...(p.loans ?? []).flatMap((l) => (l.token ? [l.token as Address] : [])),
  ];
}

/** Every factory token, read in multicalls of `SCAN_PAGE`. */
async function chainRewardTokens(client: BasisClient): Promise<Address[]> {
  const factory = client.addresses.factory;
  const n = await client.publicClient.readContract({ address: factory, abi: FactoryAbi, functionName: 'allPairsLength' });
  const out: Address[] = [];
  for (let start = 0n; start < n; start += BigInt(SCAN_PAGE)) {
    const end = start + BigInt(SCAN_PAGE) < n ? start + BigInt(SCAN_PAGE) : n;
    const reads: MulticallRead[] = [];
    for (let i = start; i < end; i++) reads.push({ address: factory, abi: FactoryAbi, functionName: 'allPairs', args: [i], contract: 'Factory' });
    out.push(...((await multicall(client, reads)) as Address[]));
  }
  return out;
}

/**
 * A list field of the options (`tokens`, `markets`, `upDownRounds`, `loanHubs`): null / undefined = left out
 * (undefined back), an array is copied dense (a hole reads as undefined, which the entry checks refuse, as PY None),
 * anything else is refused with the field's name as the rule, before any read: a string, a Set or an object is never
 * read item by item.
 */
function givenList<T>(v: readonly T[] | null | undefined, field: string, what: string): T[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v as unknown)) throw new ValidationError(field, `${field} must be an array of ${what}.`);
  return Array.from(v);
}

/**
 * A market the caller listed, checked as `getRedeemables` checks its entries, before any read: a market address
 * (`toAddress`, rule `markets`), or a plain `{ market, host }` object whose `market` is one and whose `host` is left out
 * (or null: detected), 'public', 'private' or an address (`toAddress`, rule `host`). Anything else (null, undefined: a
 * hole, a number, an array, a Map, a class instance) is refused naming its index, rule `markets` (the list's name, as
 * for `tokens` and `loanHubs`). PY: `_market_ref`.
 */
function marketRef(m: unknown, i: number): Address | RedeemableRef {
  if (typeof m === 'string') return toAddress(m, 'markets');
  const proto = typeof m === 'object' && m !== null ? Object.getPrototypeOf(m) : undefined;
  if (typeof m !== 'object' || m === null || Array.isArray(m) || (proto !== Object.prototype && proto !== null)) {
    const shown = m === null ? 'null' : Array.isArray(m) ? 'an array' : typeof m === 'object' ? 'an object that is not a plain { ... }'
      : typeof m === 'bigint' ? `${m}n` : typeof m === 'function' ? 'a function' : String(m);
    throw new ValidationError('markets', `markets[${i}] must be a market address or a { market, host } object, got ${shown}.`);
  }
  const ref = m as { market?: unknown; host?: unknown };
  const market = toAddress(ref.market, 'markets');
  const h = ref.host;
  if (h == null) return { market };
  return { market, host: h === 'public' || h === 'private' ? h : toAddress(h, 'host') };
}

/** Implementation of `BasisClient.getClaimables` (see there). */
export async function getClaimables(client: BasisClient, user: Address | undefined, opts: GetClaimablesOptions | null = {}): Promise<Claimables> {
  const o: GetClaimablesOptions = optsOf(opts, GET_CLAIMABLES_KEYS);
  const who = user == null ? client.account : toAddress(user, 'user');
  if (!who) throw new ValidationError('user', 'Pass the wallet to read: the client has no signer.');
  const givenTokens = givenList(o.tokens, 'tokens', 'token addresses')?.map((t) => toAddress(t, 'tokens'));
  const givenMarkets = givenList(o.markets, 'markets', 'markets')?.map(marketRef);
  const givenRounds = givenList(o.upDownRounds, 'upDownRounds', 'rounds');
  const hubs = (givenList(o.loanHubs, 'loanHubs', 'loan hub addresses') ?? []).map((h) => {
    const a = toAddress(h, 'loanHubs');
    if (isZeroAddress(a)) throw new ValidationError('loanHubs', `Not a loan hub address: ${a}.`);
    return a;
  });
  const extraHubs = uniqueAddresses(hubs).filter((h) => !eq(h, client.addresses.loanHub));
  const block = await client.publicClient.getBlock();
  const blockNumber = block.number;
  const blockTime = block.timestamp;
  const skipped: ClaimableSection[] = [];
  const failed: ClaimablesFailure[] = [];
  const fail = (section: ClaimableSection, source: string | null, error: unknown) => {
    failed.push({ section, source, message: message(error), error });
  };
  /** Runs a section; an error is listed in `failed` (a caller's own bad input still throws). */
  const section = async <T>(name: ClaimableSection, deployed: boolean, empty: T, given: boolean, fn: () => Promise<T>): Promise<T> => {
    if (!deployed) {
      skipped.push(name);
      return empty;
    }
    try {
      return await fn();
    } catch (e) {
      if (given && e instanceof ValidationError) throw e;
      fail(name, null, e);
      return empty;
    }
  };
  const me = !client.apiKey && client.hasSession && !!client.account && eq(client.account, who);
  /** Vested and collateral tokens: unit by the write-result rule (a main is 'main'). */
  const formatterOf = amountResolver(client);

  const hubLoansP = Promise.all([
    client.loans.deployed ? client.loans.getUserLoans(who) : Promise.resolve([]),
    ...extraHubs.map((h) => client.loans.atHub(h).getUserLoans(who)),
  ]).then((lists) => lists.flat());
  const leveragesP = readLeverages(client, who);
  const vestingsP: Promise<WalletVesting[]> = client.vesting.deployed
    ? client.vesting.getVestingsOf(who, { role: 'beneficiary', includeLoan: true })
    : Promise.resolve([]);
  for (const p of [hubLoansP, leveragesP, vestingsP]) p.catch(() => undefined);

  const emptyRewards = { rows: [] as HolderRewardClaimable[], skipped: [] as SkippedToken[] };
  const holderRewardsJob = section('holderRewards', client.factory.deployed, emptyRewards, !!givenTokens, async () => {
    let tokens: Address[];
    if (givenTokens) {
      tokens = givenTokens;
    } else {
      const source = async (name: string, fn: () => Promise<Address[]>): Promise<Address[]> => {
        try {
          return await fn();
        } catch (e) {
          fail('holderRewards', name, e);
          return [];
        }
      };
      const lists = await Promise.all([
        client.apiKey ? source('portfolio', () => apiRewardTokens(client, who)) : source('chain', () => chainRewardTokens(client)),
        source('leverage', async () => (await leveragesP).map((p) => p.token)),
        source('loans', async () => (await hubLoansP).map((l) => l.collateralToken)),
        source('vesting', async () => (await vestingsP).map((v) => v.token)),
      ]);
      tokens = lists.flat();
    }
    const list = uniqueAddresses(tokens.filter((t) => isAddress(t, { strict: false })));
    const reads: SettledRead[] = [];
    for (let i = 0; i < list.length; i += REWARD_PAGE) {
      reads.push(...await multicallSettled(client, list.slice(i, i + REWARD_PAGE).flatMap((token): MulticallRead[] => [
        { address: token, abi: FactoryTokenAbi, functionName: 'rewardsEnabled', contract: 'FactoryToken' },
        { address: token, abi: FactoryTokenAbi, functionName: 'getClaimableRewards', args: [who], contract: 'FactoryToken' },
        { address: token, abi: FactoryTokenAbi, functionName: 'quoteToken', contract: 'FactoryToken' },
      ])));
    }
    const rows: HolderRewardClaimable[] = [];
    const skippedTokens: SkippedToken[] = [];
    await Promise.all(list.map(async (token, i) => {
      const [on, raw, main] = reads.slice(i * 3, i * 3 + 3);
      if (!(on.ok && on.result === true && raw.ok && (raw.result as bigint) > 0n && main.ok)) return;
      const quoteToken = main.result as Address;
      let info: MainInfo;
      try {
        info = await client.mains.get(quoteToken);
      } catch (e) {
        if (await client.mains.isMain(quoteToken).catch(() => true)) throw e;
        skippedTokens.push({ token, quoteToken, reason: 'unknown main' });
        return;
      }
      rows.push({ token, amount: pairAmount(raw.result as bigint, info) });
    }));
    const pos = new Map(list.map((t, i) => [t.toLowerCase(), i] as const));
    const byList = (x: { token: Address }, y: { token: Address }) => pos.get(x.token.toLowerCase())! - pos.get(y.token.toLowerCase())!;
    return { rows: rows.sort(byList), skipped: skippedTokens.sort(byList) };
  });

  const marketsJob = section('markets', client.marketReader.deployed, { rows: [] as Redeemable[], skipped: [] as SkippedMarket[] }, !!givenMarkets, async () => {
    let refs: (Address | RedeemableRef)[];
    if (givenMarkets) {
      refs = givenMarkets;
    } else {
      refs = [];
      for (const status of ['resolved', 'invalidated'] as const) {
        for await (const m of client.api.paginatePages((p) => client.api.getWalletMarkets(who, p), { status, limit: 100 })) {
          refs.push(m.host ? { market: m.marketToken as Address, host: m.host as Address } : (m.marketToken as Address));
        }
      }
    }
    const seen = new Set<string>();
    const unique = refs.filter((r) => {
      const k = (typeof r === 'string' ? r : r.market).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const all = await client.marketReader.getRedeemables(unique, who);
    return {
      rows: all.filter((r) => r.skipped === null && r.tokenPayout > 0n),
      skipped: all.filter((r) => r.skipped !== null).map((r): SkippedMarket => ({ market: r.market, host: r.host, reason: r.skipped! })),
    };
  });

  const emptyUpDown: UpDownClaimables = { user: who, blockNumber, items: [], totals: [] };
  const upDownJob = section('upDown', client.updown.deployed, emptyUpDown, !!givenRounds, async () => {
    let rounds = givenRounds;
    if (!rounds) {
      const record = me ? await client.api.getMyUpDown() : await client.api.getWalletUpDown(who);
      rounds = (record.claimableBets ?? [])
        .filter((b) => b.asset != null && eq(b.contract ?? '', client.addresses.upDown))
        .map((b) => ({ asset: b.asset as number, tf: b.tf, roundId: BigInt(b.roundId) }));
    }
    return client.updown.getClaimable(who, rounds);
  });

  const vestingJob = section('vesting', client.vesting.deployed, [] as VestingClaimable[], false, async () => {
    const rows = (await vestingsP).filter((v) => v.claimable > 0n);
    return Promise.all(rows.map(async (v) => ({ id: v.id, token: v.token, claimable: (await formatterOf(v.token))(v.claimable) })));
  });

  const vaultJob = section('vault', client.vault.deployed, [] as VaultClaimable[], false, async () => {
    return (await client.vault.getPositions(who)).flatMap((p) => {
      const raw = p.earned.raw < p.availableStasis.raw ? p.earned.raw : p.availableStasis.raw;
      if (raw <= 0n) return [];
      return [{ main: p.main, vault: p.vault, earned: p.earned, claimable: toAmount(raw, p.earned.decimals, p.earned.unit, p.earned.asset, p.earned.symbol) }];
    });
  });

  const liquidationsDeployed = client.loans.deployed || extraHubs.length > 0 || client.vesting.deployed || !isZeroAddress(client.addresses.swap);
  const liquidationsJob = section('liquidations', liquidationsDeployed, [] as LiquidationClaimable[], false, async () => {
    const out: LiquidationClaimable[] = [];
    const row = async (
      kind: LiquidationClaimable['kind'], main: Address, hub: Address | null, id: bigint, loanId: bigint | null, token: Address, raw: bigint, closedAt: bigint,
    ) => {
      const claimDeadline = closedAt + CLAIM_PERIOD;
      out.push({
        kind, main, hub, id, loanId, token, amount: (await formatterOf(token))(raw), liquidatedAt: closedAt, claimDeadline,
        claimExpired: raw > 0n && blockTime > claimDeadline,
      });
    };
    const part = async (source: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        fail('liquidations', source, e);
      }
    };
    await part('loans', async () => {
      for (const l of await hubLoansP) {
        if (l.isLiquidated && l.liquidationClaim > 0n) await row('hubLoan', l.ecosystem, l.hub, l.hubId, null, l.collateralToken, l.liquidationClaim, l.timeOfClosure);
      }
    });
    await part('leverage', async () => {
      for (const p of await leveragesP) {
        if (p.isLiquidated && p.liquidationClaim > 0n) await row('leverage', p.main, null, p.id, null, p.token, p.liquidationClaim, p.timeOfClosure);
      }
    });
    await part('vesting', async () => {
      const waiting = (await vestingsP).filter((v) => v.loan !== null && !v.loan.details.active);
      if (!waiting.length) return;
      const closure = await multicall(client, waiting.map((v): MulticallRead => ({
        address: v.loan!.details.ecosystem, abi: MainTokenAbi, functionName: 'loans', args: [v.loan!.hub, v.loan!.details.coreLoanId], contract: 'MainToken',
      })));
      for (const [i, v] of waiting.entries()) {
        const d = v.loan!.details;
        await row('vestingLoan', d.ecosystem, v.loan!.hub, v.id, v.loan!.loanId, d.collateralToken, d.liquidationClaim, (closure[i] as readonly unknown[])[11] as bigint);
      }
    });
    return out;
  });

  const [rewardsRes, marketsRes, upDown, vesting, vault, liquidations] = await Promise.all([
    holderRewardsJob, marketsJob, upDownJob, vestingJob, vaultJob, liquidationsJob,
  ]);
  const sums = new Map<string, Amount>();
  const add = (a: Amount) => {
    if (a.raw === 0n) return;
    const k = a.asset.toLowerCase();
    const prev = sums.get(k);
    sums.set(k, prev ? toAmount(prev.raw + a.raw, prev.decimals, prev.unit, prev.asset, prev.symbol) : a);
  };
  const holderRewards = rewardsRes.rows;
  holderRewards.forEach((r) => add(r.amount));
  marketsRes.rows.forEach((r) => add(r.pairPayout));
  upDown.items.forEach((r) => add(r.payout));
  vesting.forEach((r) => add(r.claimable));
  vault.forEach((r) => add(r.claimable));
  liquidations.filter((r) => r.kind !== 'vestingLoan').forEach((r) => add(r.amount));
  const order = (s: ClaimableSection) => CLAIMABLE_SECTIONS.indexOf(s);
  skipped.sort((x, y) => order(x) - order(y));
  failed.sort((x, y) => order(x.section) - order(y.section));
  return {
    user: who, blockNumber, blockTime, holderRewards, skippedTokens: rewardsRes.skipped, markets: marketsRes.rows,
    skippedMarkets: marketsRes.skipped, upDown,
    vesting, vault, liquidations, totals: [...sums.values()].map((amount) => ({ asset: amount.asset, amount })), skipped, failed,
  };
}
