import { type Address, encodeAbiParameters, type Hex, keccak256, parseAbi, zeroAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import { MarketResolverAbi, TrancheMarketAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { BasisRpcError, ValidationError } from '../core/errors';
import { type AmountOf, amountOf, pairAmountOf } from '../core/amounts';
import { addMissingEventWarning, decodeEvents } from '../core/events';
import { refusePausedAsset } from '../core/loans';
import { classifyError } from '../core/revert';
import { decodeRankingKey, KEY_EARLY, KEY_INVALID, normalizeRanking, rankingKey, type RankingKeyKind, validateRanking, validateTieMask } from '../core/ranking';
import { type Amount, toAddress, toUint } from '../core/units';

/** The resolver's optional extra rule on proposing. */
const ProposalRulesAbi = parseAbi(['function qualifiesForProposal(address proposer, address marketToken) view returns (bool)']);

/** Resolver settings, read live. Periods in seconds; bonds raw `BOND_TOKEN` units. */
export interface ResolverConstants {
  DISPUTE_PERIOD: number;
  PROPOSAL_PERIOD: number;
  VETO_PERIOD: number;
  PROPOSAL_BOND: bigint;
  MIN_QUORUM: number;
  EARLY_FAST_PERIOD: number;
  BOND_CAP: bigint;
  BOND_MAX: bigint;
  VETO_FLOOR: bigint;
  /** The flat bond a trusted proposer (`isTrustedProposer`) posts to propose or to dispute. */
  TRUSTED_BOND: bigint;
  BOND_TOKEN: Address;
  /** One whole `BOND_TOKEN`, in raw units. */
  BOND_UNIT: bigint;
}

/** A resolver key, decoded. `ranking` / `tieMask` are filled for ranking keys whose preimage is on chain. */
export interface DecodedKey {
  key: Hex;
  kind: RankingKeyKind;
  /** Plain uint8 outcome (legacy uint8 host only). */
  outcome?: number;
  ranking?: number[];
  tieMask?: bigint;
}

/** A market's dispute record. Keys are null when unset (bytes32 0). Bonds raw `BOND_TOKEN` units. */
export interface DisputeInfo {
  proposer: Address;
  disputer: Address;
  vetoer: Address;
  originalKey: DecodedKey | null;
  /** `unresolved` until someone disputes. */
  disputedKey: DecodedKey | null;
  vetoKey: DecodedKey | null;
  proposerBond: bigint;
  disputerBond: bigint;
  vetoBond: bigint;
  /** Proposal time until a dispute, then the dispute time; restarts when a round reopens. Unix seconds. */
  disputeStartTime: number;
}

/** The running leader of a voting round. */
export interface TallyInfo {
  leader: DecodedKey | null;
  leaderCount: number;
  totalVotes: number;
  /** An exact tie for the lead (finalizing reopens the round). */
  tie: boolean;
}

/** Whether an action is possible now; `reason` is the rule that blocks it. */
export interface ActionCheck {
  allowed: boolean;
  reason?: string;
}

/** Everything about a market's resolution in one read. Times are unix seconds (chain time). */
export interface ResolverStatus {
  market: Address;
  resolver: Address;
  /** The ranked host the market is registered on (zero = not a ranked market). */
  host: Address;
  now: number;
  hasProposal: boolean;
  /** INVALID is the live proposal, or a panel voter voted INVALID in the current round (`isInvalidLive`): no order fills. */
  invalidLive: boolean;
  inDispute: boolean;
  inVeto: boolean;
  isResolved: boolean;
  /** Host `finalOutcome`: ranking[0] on a ranked win, 254 INVALID, 255 UNRESOLVED. */
  finalOutcome: number;
  currentRound: number;
  dispute: DisputeInfo | null;
  tally: TallyInfo;
  /** Voters on the resolver's panel now (`getVoterCount`): a dispute resolves only with at least `MIN_QUORUM` votes. */
  voterCount: number;
  earlyResets: number;
  constants: ResolverConstants;
  /** Proposal bond for `user` now (base bond for the zero address). */
  requiredBond: bigint;
  /** What a dispute by `user` would post now (`getDisputeBond`); null with no live proposal. */
  disputeBond: bigint | null;
  /** What a veto would post now (`getVetoBond`); null with no live proposal. */
  vetoBond: bigint | null;
  deadlines: {
    /**
     * Dated markets: the creator may propose from `endTime`, anyone else from `endTime + 15 min`. 0 = any time. A trusted
     * proposer may propose INVALID before both.
     */
    proposeFromCreator: number;
    proposeFromOthers: number;
    /** Undisputed proposal: disputes are accepted before this; `finalizeUncontested` from it. */
    disputeUntil?: number;
    finalizeUncontestedFrom?: number;
    /** In dispute: votes up to and including this time. */
    voteUntil?: number;
    vetoFrom?: number;
    /** `finalizeMarket` from here (DISPUTE_PERIOD + VETO_PERIOD after the dispute / reopen). */
    finalizeFrom?: number;
    /** A quorum'd, strictly leading EARLY may finalize from here. */
    earlyFastFrom?: number;
  };
  /** Present when a user was given (or the client has a signer). Key-dependent rules (dispute/veto key) are not checked. */
  user?: {
    address: Address;
    isVoter: boolean;
    isTrustedProposer: boolean;
    hasVoted: boolean;
    actions: {
      /** Propose a ranking. */
      propose: ActionCheck;
      /** Propose INVALID: as `propose`, except that a trusted proposer may do it before the propose window opens. */
      proposeInvalid: ActionCheck;
      dispute: ActionCheck;
      finalizeUncontested: ActionCheck;
      vote: ActionCheck;
      veto: ActionCheck;
      finalizeMarket: ActionCheck;
    };
  };
}

/** A ranked write: the tx plus the key it submitted and the bond it posted (`Amount`s in `BOND_TOKEN`). */
export interface ResolverTxResult extends TxResult {
  /** The key submitted (computed and checked before sending; the event's key when the log is there). */
  key: Hex;
  /** The bond the SDK approved (in `BOND_TOKEN`; 0 for votes). */
  bond: Amount;
  /** Propose / dispute / veto: the bond taken, from `Proposal` / `DisputeStarted` / `Vetoed` (null when the event is missing; absent on votes). */
  bondPosted?: Amount | null;
  /** Votes: the voting round the vote counted in, from `Vote` (null when the event is missing; absent otherwise). */
  round?: number | null;
}

/** A bond paid out at finalization: `BondsDistributed` (`redirected` false) or `BondRedirected` to insurance (true). */
export interface BondPayout {
  to: Address;
  /** In `BOND_TOKEN`. */
  amount: Amount;
  /** The recipient could not receive the token: the amount went to the insurance wallet. */
  redirected: boolean;
}

/** `finalizeUncontested` / `finalizeMarket`: what the tx did, decoded from the resolver's events. */
export interface FinalizeResult extends TxResult {
  /**
   * `resolved` (`Resolved`), `reopened` (no quorum or a tie: `VoteReopened`, a fresh round) or `earlyReset` (EARLY
   * won: `EarlyReset`, the proposal is wiped and the next bond doubles). Null when none of these events is in the logs.
   */
  outcome: 'resolved' | 'reopened' | 'earlyReset' | null;
  /** The winning key when resolved (decode it with `decodeKey`), else null. */
  key: Hex | null;
  /** The voting round now current after a reopen or an EARLY reset (`VoteReopened` / `DisputeReset`), else null. */
  round: number | null;
  /** EARLY resets on the market so far, after an EARLY reset; else null. */
  earlyResets: number | null;
  /** Bonds paid out (own bond + capped bounty, or a refund), in log order. */
  payouts: BondPayout[];
  /**
   * `BOND_TOKEN` sent to insurance as seized bonds (`BondsSeized`; 0 when none): what the losing sides lost (see
   * `dispute`, `disputeEarly`, `veto` and `finalizeMarket`).
   */
  seized: Amount;
  /**
   * Pair asset the protocol kept because no ranked outcome had a bettor (`NoWinnerSwept`, only possible on a market
   * with no seed; 0 when none). Nobody can redeem that pot.
   */
  swept: Amount;
}

type RawDispute = readonly [Address, Address, Address, Hex, Hex, Hex, bigint, bigint, bigint, bigint];

interface Snapshot {
  resolver: Address;
  host: Address;
  marketExists: boolean;
  resolved: boolean;
  creator: Address;
  endTime: bigint;
  /** The market's main (zero when the market is not on a ranked host). */
  main: Address;
  dd: {
    proposer: Address; disputer: Address; vetoer: Address;
    originalKey: Hex; disputedKey: Hex; vetoKey: Hex;
    proposerBond: bigint; disputerBond: bigint; vetoBond: bigint; disputeStartTime: bigint;
  };
  inDispute: boolean;
  inVeto: boolean;
  round: bigint;
  tally: { leader: Hex; leaderCount: bigint; totalVotes: bigint; tie: boolean };
  c: ResolverConstants;
  /**
   * Latest block time. A rule that opens at a time (`block.timestamp >= X`) is checked against `now` itself: the next
   * block may carry the same time, so `now + 1` would pass one second early and let a bond approval mine before a
   * main tx that reverts. A rule that closes at a time (`block.timestamp < Y` / `<= Y`) is checked from `now + 1`
   * (the earliest a tx can be mined).
   */
  now: bigint;
}

/** The rule name of a proposal the optional proposal rule refuses (the revert reason). */
const RULES_RULE = 'Rules: not qualified';
const PROPOSE_DELAY = 15n * 60n;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The dispute bond of a live proposal (see `getDisputeBond`). */
function disputeBondFor(proposerBond: bigint, c: ResolverConstants, trusted: boolean): bigint {
  if (trusted) return c.TRUSTED_BOND;
  const bond = proposerBond < c.PROPOSAL_BOND ? c.PROPOSAL_BOND : proposerBond;
  return bond > c.BOND_CAP ? c.BOND_CAP : bond;
}

/** The veto bond of a live proposal (see `getVetoBond`). */
function vetoBondFor(proposerBond: bigint, c: ResolverConstants): bigint {
  const bond = proposerBond < c.VETO_FLOOR ? c.VETO_FLOOR : proposerBond;
  return bond > c.BOND_CAP ? c.BOND_CAP : bond;
}

/**
 * The market resolver: propose / dispute / vote / veto / finalize for ranked markets, plus every view.
 * Each market is resolved by the resolver it was created with; the module looks it up per market. Bonds are posted
 * in the resolver's `BOND_TOKEN` (the exact amount is approved per action).
 */
export class MarketResolverModule extends BaseModule {
  private resolverCache = new Map<string, Address>();
  private hostCache = new Map<string, Address>();
  private bondCache = new Map<string, Promise<{ token: Address; unit: bigint }>>();

  constructor(client: BasisClient) {
    super(client);
  }

  /** Whether the default resolver address is set on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.resolver);
  }

  private get defaultResolver(): Address {
    return this.require(this.client.addresses.resolver, 'MarketResolver');
  }


  /**
   * The resolver `market` was registered with, looked up on every known ranked host (`addresses.tranche`, then
   * `addresses.extraRankedHost` when set), else the default resolver (address book). Cached per market once found on
   * a host.
   */
  async resolverOf(market: Address): Promise<Address> {
    market = toAddress(market, 'market');
    const hit = this.resolverCache.get(market.toLowerCase());
    if (hit) return hit;
    for (const [host, extra] of this.rankedHosts()) {
      let r: Address;
      try {
        r = await this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'marketResolver', args: [market] });
      } catch (e) {
        if (!extra) throw e;
        continue;
      }
      if (!isZeroAddress(r)) {
        this.resolverCache.set(market.toLowerCase(), r);
        return r;
      }
    }
    return this.defaultResolver;
  }

  /** The ranked hosts the SDK knows, non-zero ones: `addresses.tranche`, then the optional `addresses.extraRankedHost` (flagged extra). */
  private rankedHosts(): [Address, boolean][] {
    const a = this.client.addresses;
    const out: [Address, boolean][] = [];
    if (!isZeroAddress(a.tranche)) out.push([a.tranche, false]);
    if (!isZeroAddress(a.extraRankedHost) && !(out.length && eq(a.extraRankedHost!, a.tranche))) out.push([a.extraRankedHost!, true]);
    return out;
  }

  /** `market`'s resolver, else (left out or null) the default one. */
  private async resolverFor(market?: Address | null): Promise<Address> {
    return market == null ? this.defaultResolver : this.resolverOf(market);
  }

  /** The ranked host `market` is registered on (`hostOf`; zero = not a ranked market). */
  async hostOf(market: Address): Promise<Address> {
    market = toAddress(market, 'market');
    const hit = this.hostCache.get(market.toLowerCase());
    if (hit) return hit;
    const resolver = await this.resolverOf(market);
    const h = await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'hostOf', args: [market] });
    if (!isZeroAddress(h)) this.hostCache.set(market.toLowerCase(), h);
    return h;
  }

  /** Whether `host` may register markets on the resolver (of `market`, else the default). */
  async isApprovedHost(host: Address, market?: Address): Promise<boolean> {
    host = toAddress(host, 'host');
    const address = await this.resolverFor(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'approvedHost', args: [host] });
  }

  private bondInfo(resolver: Address): Promise<{ token: Address; unit: bigint }> {
    const k = resolver.toLowerCase();
    let p = this.bondCache.get(k);
    if (!p) {
      p = Promise.all([
        this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'BOND_TOKEN' }),
        this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'BOND_UNIT' }),
      ]).then(([token, unit]) => ({ token, unit }));
      p.catch(() => this.bondCache.delete(k));
      this.bondCache.set(k, p);
    }
    return p;
  }


  /** Resolver settings of `market`'s resolver (else the default). Read live; never hardcode them. */
  async getConstants(market?: Address): Promise<ResolverConstants> {
    return this.readConstants(await this.resolverFor(market));
  }

  private async readConstants(address: Address): Promise<ResolverConstants> {
    const r = (fn: 'DISPUTE_PERIOD' | 'PROPOSAL_PERIOD' | 'VETO_PERIOD' | 'PROPOSAL_BOND' | 'MIN_QUORUM' | 'EARLY_FAST_PERIOD' | 'BOND_CAP' | 'BOND_MAX' | 'VETO_FLOOR' | 'TRUSTED_BOND') =>
      this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: fn });
    const [dp, pp, vp, pb, mq, efp, cap, max, floor, trusted, bond] = await Promise.all([
      r('DISPUTE_PERIOD'), r('PROPOSAL_PERIOD'), r('VETO_PERIOD'), r('PROPOSAL_BOND'), r('MIN_QUORUM'),
      r('EARLY_FAST_PERIOD'), r('BOND_CAP'), r('BOND_MAX'), r('VETO_FLOOR'), r('TRUSTED_BOND'), this.bondInfo(address),
    ]);
    return {
      DISPUTE_PERIOD: Number(dp), PROPOSAL_PERIOD: Number(pp), VETO_PERIOD: Number(vp), PROPOSAL_BOND: pb,
      MIN_QUORUM: Number(mq), EARLY_FAST_PERIOD: Number(efp), BOND_CAP: cap, BOND_MAX: max, VETO_FLOOR: floor,
      TRUSTED_BOND: trusted, BOND_TOKEN: bond.token, BOND_UNIT: bond.unit,
    };
  }


  /** The ranking behind a stored key (`[]`, 0n when the key was never seen on this market). */
  async getRanking(market: Address, key: Hex): Promise<{ ranking: number[]; tieMask: bigint }> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    const [ranking, tieMask] = await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'getRanking', args: [market, key] });
    return { ranking: ranking.map(Number), tieMask };
  }

  /**
   * The resolver's own key for a ranking, to cross-check `rankingKey()`. `[]` → KEY_INVALID. Checked first, nothing
   * coerced: picks are integers 0-255 (`normalizeRanking`, 'rankingEntry'), `tieMask` a uint256 bigint ('tieMask').
   */
  async rankingKeyOnChain(ranking: readonly number[], tieMask: bigint = 0n, market?: Address): Promise<Hex> {
    const picks = normalizeRanking(ranking);
    validateTieMask(tieMask);
    if (picks.length === 0) return KEY_INVALID;
    const address = await this.resolverFor(market);
    const base = await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'rankingKey', args: [picks] });
    if (tieMask === 0n) return base;
    return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [base, tieMask]));
  }

  /** Decode a key; ranking keys are looked up with `getRanking`. bytes32(0) (unset) → null. */
  async decodeKey(market: Address, key: Hex): Promise<DecodedKey | null> {
    market = toAddress(market, 'market');
    if (BigInt(key) === 0n) return null;
    const d = decodeRankingKey(key);
    const out: DecodedKey = { key, ...d };
    if (d.kind === 'ranking') {
      const { ranking, tieMask } = await this.getRanking(market, key);
      if (ranking.length > 0) {
        out.ranking = ranking;
        out.tieMask = tieMask;
      }
    }
    return out;
  }


  /** The dispute record with decoded keys, or null when there is no live proposal. */
  async getDisputeData(market: Address): Promise<DisputeInfo | null> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    const raw = await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'disputes', args: [market] });
    return this.decodeDispute(market, raw);
  }

  private async decodeDispute(market: Address, raw: RawDispute): Promise<DisputeInfo | null> {
    const [proposer, disputer, vetoer, ok, dk, vk, pb, db, vb, start] = raw;
    if (isZeroAddress(proposer)) return null;
    const [originalKey, disputedKey, vetoKey] = await Promise.all([this.decodeKey(market, ok), this.decodeKey(market, dk), this.decodeKey(market, vk)]);
    return {
      proposer, disputer, vetoer, originalKey, disputedKey, vetoKey,
      proposerBond: pb, disputerBond: db, vetoBond: vb, disputeStartTime: Number(start),
    };
  }

  /** Whether the market is resolved. */
  async isResolved(market: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'resolved', args: [market] });
  }

  /** Host `finalOutcome`: ranking[0] on a ranked win, 254 INVALID, 255 UNRESOLVED. */
  async getFinalOutcome(market: Address): Promise<number> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return Number(await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'finalOutcome', args: [market] }));
  }

  /** True while a proposal is live (proposal, dispute, voting or veto). No bets then, on dated and open-ended markets. */
  async hasProposal(market: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'hasProposal', args: [market] });
  }

  /**
   * True while INVALID is the live proposal, or a panel voter has voted INVALID in the current round. No orders fill
   * on the public host then. A dispute or veto naming INVALID does not count on its own, and a reopened round starts
   * clean.
   */
  async isInvalidLive(market: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'invalidLive', args: [market] });
  }

  async isInDispute(market: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'inDispute', args: [market] });
  }

  async isInVeto(market: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'inVeto', args: [market] });
  }

  /** The voting round now current (bumps on a reopen and after EARLY). */
  async getCurrentRound(market: Address): Promise<number> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return Number(await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'currentRound', args: [market] }));
  }

  /** Votes for `key` in `round` (use `rankingKey()` / KEY_EARLY / KEY_INVALID for the key). */
  async getVoteCount(market: Address, round: number | bigint, key: Hex): Promise<number> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return Number(await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'voteCount', args: [market, toUint(round, 'round'), key] }));
  }

  /** Running tally of `round` (default: the current round). */
  async getTally(market: Address, round?: number | bigint): Promise<TallyInfo> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    const r = round == null ? await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'currentRound', args: [market] }) : toUint(round, 'round');
    const [leader, leaderCount, totalVotes, tie] = await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'tallies', args: [market, r] });
    return { leader: await this.decodeKey(market, leader), leaderCount: Number(leaderCount), totalVotes: Number(totalVotes), tie };
  }

  async hasVoted(market: Address, round: number | bigint, voter: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    voter = toAddress(voter, 'voter');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'hasVoted', args: [market, toUint(round, 'round'), voter] });
  }

  /** What `voter` voted in `round`, decoded; null when they did not vote. */
  async getVoterChoice(market: Address, round: number | bigint, voter: Address): Promise<DecodedKey | null> {
    market = toAddress(market, 'market');
    voter = toAddress(voter, 'voter');
    const address = await this.resolverOf(market);
    const key = await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'voterChoice', args: [market, toUint(round, 'round'), voter] });
    return this.decodeKey(market, key);
  }

  /** Whether `addr` is on the resolver's voter panel. */
  async isVoter(addr: Address, market?: Address): Promise<boolean> {
    addr = toAddress(addr, 'addr');
    const address = await this.resolverFor(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'authorizedVoter', args: [addr] });
  }

  /**
   * How many voters are on the panel of `market`'s resolver (else the default resolver) now. A dispute resolves only with
   * at least `MIN_QUORUM` votes (each voter votes once a round), so a panel smaller than that reopens every round.
   */
  async getVoterCount(market?: Address): Promise<number> {
    const address = await this.resolverFor(market);
    return Number(await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'voterCount' }));
  }

  /**
   * Trusted proposers post the flat `TRUSTED_BOND` to propose or to dispute, skip the optional proposal rule, and may
   * propose INVALID on a dated market before its endTime (a cancelled event, a broken question).
   */
  async isTrustedProposer(addr: Address, market?: Address): Promise<boolean> {
    addr = toAddress(addr, 'addr');
    const address = await this.resolverFor(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'trustedProposer', args: [addr] });
  }

  /** EARLY cycles on `market` (each doubles the next proposal bond, up to `BOND_MAX`). */
  async getEarlyResets(market: Address): Promise<number> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    return Number(await this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'earlyResets', args: [market] }));
  }

  /** Proposal bond for `proposer` (default: the signer, else the zero address) now, raw `BOND_TOKEN`. */
  async getRequiredBond(market: Address, proposer?: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const who = proposer == null ? this.client.walletClient?.account?.address ?? zeroAddress : toAddress(proposer, 'proposer');
    const address = await this.resolverOf(market);
    return this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'requiredBond', args: [market, who] });
  }

  /**
   * What a dispute of the live proposal costs `disputer` (default: the signer, else the zero address), raw `BOND_TOKEN`:
   * about the proposal's bond, within the floor and cap of `getConstants`; a trusted proposer posts `TRUSTED_BOND`.
   * Null with no live proposal.
   */
  async getDisputeBond(market: Address, disputer?: Address): Promise<bigint | null> {
    market = toAddress(market, 'market');
    const who = disputer == null ? this.client.walletClient?.account?.address ?? zeroAddress : toAddress(disputer, 'disputer');
    const address = await this.resolverOf(market);
    const [dd, c, trusted] = await Promise.all([
      this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'disputes', args: [market] }),
      this.readConstants(address),
      this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'trustedProposer', args: [who] }),
    ]);
    return isZeroAddress(dd[0]) ? null : disputeBondFor(dd[6], c, trusted);
  }

  /**
   * What a veto costs, raw `BOND_TOKEN`: about the proposal's bond, within the floor and cap of `getConstants`, the same
   * for every wallet. Null with no live proposal.
   */
  async getVetoBond(market: Address): Promise<bigint | null> {
    market = toAddress(market, 'market');
    const address = await this.resolverOf(market);
    const [dd, c] = await Promise.all([
      this.publicClient.readContract({ address, abi: MarketResolverAbi, functionName: 'disputes', args: [market] }),
      this.readConstants(address),
    ]);
    return isZeroAddress(dd[0]) ? null : vetoBondFor(dd[6], c);
  }


  /**
   * One object with the whole resolution state of `market`: flags, the dispute record (keys decoded), the
   * current tally, deadlines and, for `user` (default: the signer), which actions are possible now.
   */
  async getStatus(market: Address, user?: Address): Promise<ResolverStatus> {
    market = toAddress(market, 'market');
    const who = user == null ? this.client.walletClient?.account?.address : toAddress(user, 'user');
    const s = await this.snapshot(market);
    const r = s.resolver;
    const [hasProposal, invalidLive, rawDispute, tally, voterCount, earlyResets, requiredBond, finalOutcome, userInfo] = await Promise.all([
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'hasProposal', args: [market] }),
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'invalidLive', args: [market] }),
      this.decodeDispute(market, [s.dd.proposer, s.dd.disputer, s.dd.vetoer, s.dd.originalKey, s.dd.disputedKey, s.dd.vetoKey, s.dd.proposerBond, s.dd.disputerBond, s.dd.vetoBond, s.dd.disputeStartTime]),
      this.decodeKey(market, s.tally.leader),
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'voterCount' }),
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'earlyResets', args: [market] }),
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'requiredBond', args: [market, who ?? zeroAddress] }),
      this.publicClient.readContract({ address: r, abi: MarketResolverAbi, functionName: 'finalOutcome', args: [market] }).catch(() => 255),
      who ? this.userFlags(r, market, s.round, who) : Promise.resolve(null),
    ]);

    const start = Number(s.dd.disputeStartTime);
    const end = Number(s.endTime);
    const c = s.c;
    const deadlines: ResolverStatus['deadlines'] = {
      proposeFromCreator: end,
      proposeFromOthers: end === 0 ? 0 : end + Number(PROPOSE_DELAY),
    };
    if (hasProposal && !s.inDispute && isZeroAddress(s.dd.disputer)) {
      deadlines.disputeUntil = start + c.PROPOSAL_PERIOD;
      deadlines.finalizeUncontestedFrom = start + c.PROPOSAL_PERIOD;
    }
    if (s.inDispute) {
      deadlines.voteUntil = start + c.DISPUTE_PERIOD;
      deadlines.vetoFrom = start + c.DISPUTE_PERIOD;
      deadlines.finalizeFrom = start + c.DISPUTE_PERIOD + c.VETO_PERIOD;
      deadlines.earlyFastFrom = start + c.EARLY_FAST_PERIOD;
    }

    const live = !isZeroAddress(s.dd.proposer);
    const status: ResolverStatus = {
      market, resolver: r, host: s.host, now: Number(s.now),
      hasProposal, invalidLive, inDispute: s.inDispute, inVeto: s.inVeto, isResolved: s.resolved,
      finalOutcome: Number(finalOutcome), currentRound: Number(s.round),
      dispute: rawDispute,
      tally: { leader: tally, leaderCount: Number(s.tally.leaderCount), totalVotes: Number(s.tally.totalVotes), tie: s.tally.tie },
      voterCount: Number(voterCount), earlyResets: Number(earlyResets), constants: c, requiredBond,
      disputeBond: live ? disputeBondFor(s.dd.proposerBond, c, userInfo?.isTrustedProposer ?? false) : null,
      vetoBond: live ? vetoBondFor(s.dd.proposerBond, c) : null,
      deadlines,
    };
    if (who && userInfo) {
      const act = (reason: string | null): ActionCheck => (reason ? { allowed: false, reason } : { allowed: true });
      const trusted = userInfo.isTrustedProposer;
      const propose = this.checkPropose(s, who, null, trusted);
      const proposeInvalid = this.checkPropose(s, who, KEY_INVALID, trusted);
      const rule = (propose === null || proposeInvalid === null) && (await this.proposalRuleRefusal(s, market, who, trusted)) ? RULES_RULE : null;
      status.user = {
        address: who, ...userInfo,
        actions: {
          propose: act(propose ?? rule),
          proposeInvalid: act(proposeInvalid ?? rule),
          dispute: act(this.checkDispute(s, who, null)),
          finalizeUncontested: act(this.checkFinalizeUncontested(s)),
          vote: act(this.checkVote(s, userInfo.isVoter, userInfo.hasVoted)),
          veto: act(this.checkVeto(s, who, null)),
          finalizeMarket: act(this.checkFinalizeMarket(s)),
        },
      };
    }
    return status;
  }

  private async userFlags(resolver: Address, market: Address, round: bigint, who: Address) {
    const [isVoter, isTrustedProposer, hasVoted] = await Promise.all([
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'authorizedVoter', args: [who] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'trustedProposer', args: [who] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'hasVoted', args: [market, round, who] }),
    ]);
    return { isVoter, isTrustedProposer, hasVoted };
  }

  /** Everything the pre-checks need, read fresh. */
  private async snapshot(market: Address): Promise<Snapshot> {
    const resolver = await this.resolverOf(market);
    const host = await this.hostOf(market);
    const [md, dd, inDispute, inVeto, round, c, block] = await Promise.all([
      isZeroAddress(host)
        ? Promise.resolve(null)
        : this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'getMarketData', args: [market] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'disputes', args: [market] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'inDispute', args: [market] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'inVeto', args: [market] }),
      this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'currentRound', args: [market] }),
      this.readConstants(resolver),
      this.publicClient.getBlock(),
    ]);
    const [leader, leaderCount, totalVotes, tie] = await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'tallies', args: [market, round] });
    const resolved = md ? md.resolved : await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'resolved', args: [market] }).catch(() => false);
    return {
      resolver, host,
      marketExists: md ? eq(md.marketToken, market) : false,
      resolved,
      creator: md?.creator ?? zeroAddress,
      endTime: md?.endTime ?? 0n,
      main: md?.ecosystem ?? zeroAddress,
      dd: {
        proposer: dd[0], disputer: dd[1], vetoer: dd[2], originalKey: dd[3], disputedKey: dd[4], vetoKey: dd[5],
        proposerBond: dd[6], disputerBond: dd[7], vetoBond: dd[8], disputeStartTime: dd[9],
      },
      inDispute, inVeto, round,
      tally: { leader, leaderCount, totalVotes, tie },
      c,
      now: block.timestamp,
    };
  }


  private checkMarket(s: Snapshot): string | null {
    if (isZeroAddress(s.host)) return 'Not a ranked market';
    if (!s.marketExists) return 'unknown market';
    if (s.resolved) return 'Already resolved';
    return null;
  }

  /**
   * `key`: the key to propose, null for any ranking. A dated market takes proposals from endTime (its creator) or
   * endTime + 15 min (everyone else); a trusted proposer may propose INVALID before that.
   */
  private checkPropose(s: Snapshot, me: Address, key: Hex | null, trusted: boolean): string | null {
    const m = this.checkMarket(s);
    if (m) return m;
    const earlyInvalid = trusted && key !== null && eq(key, KEY_INVALID);
    if (s.endTime !== 0n && !earlyInvalid && s.now < s.endTime + (eq(s.creator, me) ? 0n : PROPOSE_DELAY)) return 'Too early to propose';
    if (!isZeroAddress(s.dd.proposer)) return 'Already proposed';
    return null;
  }

  /**
   * The resolver's optional proposal rule, while it is on: null when it lets `who` propose, else why not. Trusted
   * proposers (`trusted`) skip it. A rule check that reverts counts as a refusal; an RPC failure throws
   * `BasisRpcError`.
   */
  private async proposalRuleRefusal(s: Snapshot, market: Address, who: Address, trusted: boolean): Promise<string | null> {
    if (trusted) return null;
    const pc = this.publicClient;
    const [on, rules] = await Promise.all([
      pc.readContract({ address: s.resolver, abi: MarketResolverAbi, functionName: 'proposalRulesOn' }),
      pc.readContract({ address: s.resolver, abi: MarketResolverAbi, functionName: 'proposalRules' }),
    ]);
    if (!on || isZeroAddress(rules)) return null;
    try {
      const ok = await pc.readContract({ address: rules, abi: ProposalRulesAbi, functionName: 'qualifiesForProposal', args: [who, market] });
      return ok ? null : `${who} does not meet the proposal rule on this market. It can still dispute or veto`;
    } catch (e) {
      const err = classifyError(e, { functionName: 'qualifiesForProposal' });
      if (err instanceof BasisRpcError) throw err;
      return `the proposal rule refused ${who}: ${err.message.replace(/^\[basis-sdk\] /, '')}`;
    }
  }

  private checkDispute(s: Snapshot, me: Address, key: Hex | null): string | null {
    const m = this.checkMarket(s);
    if (m) return m;
    if (isZeroAddress(s.dd.proposer)) return 'No proposal to dispute';
    if (s.inDispute) return 'Already in dispute';
    if (s.now + 1n >= s.dd.disputeStartTime + BigInt(s.c.PROPOSAL_PERIOD)) return 'Dispute period over';
    if (key !== null && eq(key, s.dd.originalKey)) return 'Must be different';
    if (eq(me, s.dd.proposer)) return 'Proposer cannot dispute self';
    return null;
  }

  private checkFinalizeUncontested(s: Snapshot): string | null {
    const m = this.checkMarket(s);
    if (m) return m;
    if (isZeroAddress(s.dd.proposer)) return 'noProposal';
    if (!isZeroAddress(s.dd.disputer)) return 'disputed';
    if (s.now < s.dd.disputeStartTime + BigInt(s.c.PROPOSAL_PERIOD)) return 'Wait more';
    return null;
  }

  private checkVote(s: Snapshot, isVoter: boolean, hasVoted: boolean): string | null {
    if (isZeroAddress(s.host)) return 'Not a ranked market';
    if (!s.inDispute) return 'Not voting';
    if (s.inVeto) return 'cannot vote during veto';
    if (s.now + 1n > s.dd.disputeStartTime + BigInt(s.c.DISPUTE_PERIOD)) return 'Disputed period ended';
    if (!isVoter) return 'Not an authorized voter';
    if (hasVoted) return 'Voted';
    return null;
  }

  private checkVeto(s: Snapshot, me: Address, key: Hex | null): string | null {
    if (isZeroAddress(s.host)) return 'Not a ranked market';
    if (!s.marketExists) return 'Invalid market';
    if (s.resolved) return 'Already resolved';
    if (!s.inDispute) return 'Veto only allowed on disputed/voting markets';
    if (s.inVeto) return 'Veto only allowed once';
    if (!isZeroAddress(s.dd.vetoer)) return 'Already vetoed';
    if (key !== null && eq(s.dd.disputedKey, key)) return 'Cant veto propose dispute outcome';
    if (s.now < s.dd.disputeStartTime + BigInt(s.c.DISPUTE_PERIOD)) return 'Veto window not started yet';
    if (eq(me, s.dd.proposer) || eq(me, s.dd.disputer)) return 'Party to the dispute cannot veto';
    if (key !== null && eq(key, s.dd.originalKey)) return 'Cannot veto back to the proposal';
    return null;
  }

  private checkFinalizeMarket(s: Snapshot): string | null {
    if (isZeroAddress(s.host)) return 'Not a ranked market';
    if (!s.inDispute) return 'notInDispute';
    if (s.resolved) return 'Already resolved';
    if (s.inVeto) return 'inVeto';
    const t = s.now;
    const start = s.dd.disputeStartTime;
    const fastEarly = eq(s.tally.leader, KEY_EARLY) && !s.tally.tie && s.tally.totalVotes >= BigInt(s.c.MIN_QUORUM) && t >= start + BigInt(s.c.EARLY_FAST_PERIOD);
    if (!fastEarly && t < start + BigInt(s.c.DISPUTE_PERIOD + s.c.VETO_PERIOD)) return 'Wait more';
    return null;
  }

  private fail(rule: string | null, action: string): void {
    if (!rule) return;
    const msg: Record<string, string> = {
      'Not a ranked market': 'This market is not registered on a ranked host with its resolver.',
      'unknown market': 'The market does not exist on its host.',
      'Invalid market': 'The market does not exist on its host.',
      noProposal: 'There is no proposal to finalize.',
      disputed: 'The proposal is disputed: use finalizeMarket after the vote.',
      notInDispute: 'The market is not in dispute.',
      inVeto: 'The market was vetoed: only BASIS can resolve it now.',
    };
    throw new ValidationError(rule, `${action}: ${msg[rule] ?? rule}.`);
  }

  /**
   * Validate a ranking against the market (client-side rules, then the host's own check). `[]` = INVALID, always
   * legal. Picks must be integers 0-255 (`rankingEntry`): nothing is coerced.
   */
  async checkRanking(market: Address, ranking: readonly number[], tieMask: bigint = 0n): Promise<void> {
    market = toAddress(market, 'market');
    const picks = normalizeRanking(ranking);
    if (picks.length === 0) return;
    rankingKey(picks, tieMask);
    const host = await this.hostOf(market);
    if (isZeroAddress(host)) throw new ValidationError('Not a ranked market', 'This market is not registered on a ranked host with its resolver.');
    const [n, bp, ok] = await Promise.all([
      this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'getNumOutcomes', args: [market] }),
      this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'getTrancheBP', args: [market] }).catch(() => null),
      this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'isValidRanking', args: [market, picks, tieMask] }),
    ]);
    if (bp) validateRanking(picks, tieMask, Number(n), bp.length);
    if (!ok) throw new ValidationError('Bad ranking', 'The host rejects this ranking (isValidRanking is false).');
  }

  /**
   * The bond's checks and its exact approval: 'pair asset paused' when the issuer of `BOND_TOKEN` has paused it (the
   * bond could not move and the tx would revert after the approval), then the balance ('bondBalance'), both before the
   * approval.
   */
  private async postBond(s: Snapshot, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    const token = s.c.BOND_TOKEN;
    await refusePausedAsset(this.client, token, null, 'the bond cannot be posted');
    const bal = await this.balanceOf(token);
    if (bal < amount) throw new ValidationError('bondBalance', `The bond is ${amount} raw BOND_TOKEN (${token}); the wallet holds ${bal}.`);
    await this.ensureAllowance(token, s.resolver, amount);
  }


  /**
   * Propose a result. `ranking` lists the finish order of the top-K slots (ties included per `tieMask`); `[]` proposes
   * INVALID. Bond: `getRequiredBond(market)` in `BOND_TOKEN`, approved exactly.
   * The creator may propose from `endTime`, anyone else 15 minutes later; open-ended markets any time. A trusted
   * proposer may propose INVALID (`[]`) on a dated market before that, for a cancelled event or a broken question; it
   * runs the normal dispute and vote steps. Every market takes no bets while a proposal is live. When the
   * resolver has its optional proposal rule on, a wallet the rule refuses gets `ValidationError('Rules: not qualified')`
   * before any bond is approved (trusted proposers skip the rule). `bondPosted` comes from the `Proposal` event.
   */
  async propose(market: Address, ranking: readonly number[], tieMask: bigint = 0n): Promise<ResolverTxResult> {
    market = toAddress(market, 'market');
    const me = this.account;
    const key = rankingKey(ranking, tieMask);
    const picks = normalizeRanking(ranking);
    const s = await this.snapshot(market);
    await this.preRanked(s, market, picks, tieMask);
    const trusted = await this.publicClient.readContract({ address: s.resolver, abi: MarketResolverAbi, functionName: 'trustedProposer', args: [me] });
    this.fail(this.checkPropose(s, me, key, trusted), 'propose');
    const refused = await this.proposalRuleRefusal(s, market, me, trusted);
    if (refused) throw new ValidationError(RULES_RULE, `propose: ${refused}.`);
    const bond = await this.publicClient.readContract({ address: s.resolver, abi: MarketResolverAbi, functionName: 'requiredBond', args: [market, me] });
    await this.postBond(s, bond);
    const bondOf = await this.bondOf(s);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'proposeRanked', args: [market, picks, tieMask], contract: 'MarketResolver' });
    const ev = this.marketEvent(tx, s.resolver, 'Proposal', market, ['bondPosted']);
    return { ...tx, key: ev?.outcomeKey ?? key, bond: bondOf(bond), bondPosted: ev ? bondOf(ev.bond) : null };
  }

  /** Winner-take-all proposal: `propose(market, [outcome], 0n)`. */
  async proposeOutcome(market: Address, outcome: number): Promise<ResolverTxResult> {
    return this.propose(market, [outcome], 0n);
  }

  /**
   * Dispute the live proposal with another result (`[]` = INVALID). Within PROPOSAL_PERIOD of the proposal, not by
   * the proposer, key must differ. Bond: `getDisputeBond`, approved exactly. `bondPosted` comes from the
   * `DisputeStarted` event. Risk: a losing dispute loses the bond to the winner and insurance. `ranking` must be an
   * array (anything else, null included, is `ValidationError('ranking')` before any read): EARLY is `disputeEarly`.
   */
  async dispute(market: Address, ranking: readonly number[], tieMask: bigint = 0n): Promise<ResolverTxResult> {
    return this.doDispute(market, false, ranking, tieMask);
  }

  /**
   * Dispute the proposal as EARLY (the event has not happened yet). Same bond as `dispute`. If EARLY wins you get your
   * bond back plus half the proposer's bond; the other half goes to insurance. The market is not resolved: the proposal is
   * wiped and the next proposal on it costs double.
   */
  async disputeEarly(market: Address): Promise<ResolverTxResult> {
    return this.doDispute(market, true, [], 0n);
  }

  /**
   * `early` true (only from `disputeEarly`) = an EARLY dispute, `ranking` unused; else `ranking` is the caller's, checked
   * strictly (`rankingKey`: a null or non-array ranking is 'ranking', never read as EARLY).
   */
  private async doDispute(market: Address, early: boolean, ranking: readonly number[], tieMask: bigint): Promise<ResolverTxResult> {
    market = toAddress(market, 'market');
    const me = this.account;
    const key = early ? KEY_EARLY : rankingKey(ranking, tieMask);
    const picks: number[] | null = early ? null : normalizeRanking(ranking);
    const s = await this.snapshot(market);
    await this.preRanked(s, market, picks, tieMask);
    this.fail(this.checkDispute(s, me, key), 'dispute');
    const trusted = await this.publicClient.readContract({ address: s.resolver, abi: MarketResolverAbi, functionName: 'trustedProposer', args: [me] });
    const bond = disputeBondFor(s.dd.proposerBond, s.c, trusted);
    await this.postBond(s, bond);
    const bondOf = await this.bondOf(s);
    const tx = picks === null
      ? await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'disputeRankedEarly', args: [market], contract: 'MarketResolver' })
      : await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'disputeRanked', args: [market, picks, tieMask], contract: 'MarketResolver' });
    const ev = this.marketEvent(tx, s.resolver, 'DisputeStarted', market, ['bondPosted']);
    return { ...tx, key: ev?.newOutcomeKey ?? key, bond: bondOf(bond), bondPosted: ev ? bondOf(ev.bond) : null };
  }

  /**
   * Panel vote (`[]` = INVALID). Authorized voters only, one vote per round, within DISPUTE_PERIOD of the dispute. The
   * key is computed (and the picks checked) before anything is read or sent. `round` comes from `Vote`.
   */
  async vote(market: Address, ranking: readonly number[], tieMask: bigint = 0n): Promise<ResolverTxResult> {
    market = toAddress(market, 'market');
    const key = rankingKey(ranking, tieMask);
    const picks = normalizeRanking(ranking);
    const s = await this.preVote(market, picks, tieMask);
    const bondOf = await this.bondOf(s);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'voteRanked', args: [market, picks, tieMask], contract: 'MarketResolver' });
    return this.voteResult(tx, s, market, key, bondOf);
  }

  /** Panel vote for EARLY. */
  async voteEarly(market: Address): Promise<ResolverTxResult> {
    market = toAddress(market, 'market');
    const s = await this.preVote(market, null, 0n);
    const bondOf = await this.bondOf(s);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'voteRankedEarly', args: [market], contract: 'MarketResolver' });
    return this.voteResult(tx, s, market, KEY_EARLY, bondOf);
  }

  /** `picks` null = EARLY. */
  private async preVote(market: Address, picks: number[] | null, tieMask: bigint): Promise<Snapshot> {
    const me = this.account;
    const s = await this.snapshot(market);
    await this.preRanked(s, market, picks, tieMask);
    const { isVoter, hasVoted } = await this.userFlags(s.resolver, market, s.round, me);
    this.fail(this.checkVote(s, isVoter, hasVoted), 'vote');
    return s;
  }

  private voteResult(tx: TxResult, s: Snapshot, market: Address, key: Hex, bondOf: AmountOf): ResolverTxResult {
    const ev = this.marketEvent(tx, s.resolver, 'Vote', market, ['round']);
    return { ...tx, key: ev?.outcomeKey ?? key, bond: bondOf(0n), round: ev ? Number(ev.round) : null };
  }

  /** Formatter for `BOND_TOKEN` amounts of the snapshot's resolver, resolved before sending. */
  private bondOf(s: Snapshot): Promise<AmountOf> {
    return amountOf(this.client, s.c.BOND_TOKEN);
  }

  /** Formatter for amounts in the market's pair asset, resolved before sending. */
  private async pairOf(s: Snapshot): Promise<AmountOf> {
    return pairAmountOf(await this.client.mains.get(s.main));
  }

  /**
   * Veto toward another result (`[]` = INVALID; EARLY is not allowed). From disputeStartTime + DISPUTE_PERIOD, once,
   * not by the proposer or disputer, key neither the proposal's nor the dispute's.
   * Bond: `getVetoBond`, approved exactly. After a veto only BASIS resolves the market.
   * `bondPosted` comes from the `Vetoed` event. Risk: a losing veto loses its whole bond to insurance. A winning veto
   * gets its bond back plus a quarter of the other two bonds, capped at 2x its own.
   */
  async veto(market: Address, ranking: readonly number[], tieMask: bigint = 0n): Promise<ResolverTxResult> {
    market = toAddress(market, 'market');
    const me = this.account;
    const key = rankingKey(ranking, tieMask);
    const picks = normalizeRanking(ranking);
    const s = await this.snapshot(market);
    await this.preRanked(s, market, picks, tieMask);
    this.fail(this.checkVeto(s, me, key), 'veto');
    const bond = vetoBondFor(s.dd.proposerBond, s.c);
    await this.postBond(s, bond);
    const bondOf = await this.bondOf(s);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'vetoRanked', args: [market, picks, tieMask], contract: 'MarketResolver' });
    const ev = this.marketEvent(tx, s.resolver, 'Vetoed', market, ['bondPosted']);
    return { ...tx, key: ev?.proposedKey ?? key, bond: bondOf(bond), bondPosted: ev ? bondOf(ev.bond) : null };
  }

  /** The first two rules of every ranked action: a ranked market, then a legal ranking (`null` / `[]` skip the second). */
  private async preRanked(s: Snapshot, market: Address, picks: number[] | null, tieMask: bigint): Promise<void> {
    if (isZeroAddress(s.host)) this.fail('Not a ranked market', 'resolver');
    if (picks && picks.length) await this.checkRanking(market, picks, tieMask);
  }

  /**
   * Resolve an undisputed proposal once PROPOSAL_PERIOD has passed (anyone; refunds the proposer's bond).
   * The result has `outcome` 'resolved', the winning `key` and the bond refund in `payouts`.
   */
  async finalizeUncontested(market: Address): Promise<FinalizeResult> {
    market = toAddress(market, 'market');
    const s = await this.snapshot(market);
    this.fail(this.checkFinalizeUncontested(s), 'finalizeUncontested');
    const [bondOf, pairOf] = await Promise.all([this.bondOf(s), this.pairOf(s)]);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'finalizeUncontested', args: [market], contract: 'MarketResolver' });
    return this.finalizeResult(tx, s, market, bondOf, pairOf);
  }

  /**
   * Close a disputed market after DISPUTE_PERIOD + VETO_PERIOD (or EARLY_FAST_PERIOD when EARLY leads alone with
   * a quorum). Anyone. Below MIN_QUORUM votes or an exact tie reopens a fresh round instead of resolving;
   * EARLY winning resets the proposal (and doubles the next bond) without resolving. On EARLY the proposer's bond is
   * lost (an EARLY disputer gets half of it, insurance the other half); a dispute that named a result loses its bond too. The result says which
   * one happened (`outcome`), with the bond payouts and seizures.
   */
  async finalizeMarket(market: Address): Promise<FinalizeResult> {
    market = toAddress(market, 'market');
    const s = await this.snapshot(market);
    this.fail(this.checkFinalizeMarket(s), 'finalizeMarket');
    const [bondOf, pairOf] = await Promise.all([this.bondOf(s), this.pairOf(s)]);
    const tx = await this.send({ address: s.resolver, abi: MarketResolverAbi, functionName: 'finalizeMarket', args: [market], contract: 'MarketResolver' });
    return this.finalizeResult(tx, s, market, bondOf, pairOf);
  }

  /** Decode a finalize receipt: Resolved / VoteReopened / EarlyReset (+ DisputeReset), bond payouts and seizures of `market`, the pot the protocol kept when no outcome won. */
  private finalizeResult(tx: TxResult, s: Snapshot, market: Address, bondOf: AmountOf, pairOf: AmountOf): FinalizeResult {
    const { resolver, host } = s;
    const mine = <T extends { marketToken: Address }>(list: T[]) => list.filter((e) => eq(e.marketToken, market));
    const resolved = mine(this.events(tx, MarketResolverAbi, 'Resolved', resolver))[0];
    const reopened = mine(this.events(tx, MarketResolverAbi, 'VoteReopened', resolver))[0];
    const early = mine(this.events(tx, MarketResolverAbi, 'EarlyReset', resolver))[0];
    const reset = mine(this.events(tx, MarketResolverAbi, 'DisputeReset', resolver))[0];
    const payouts: BondPayout[] = [];
    for (const log of tx.receipt.logs) {
      if (!eq(log.address, resolver)) continue;
      const one = { logs: [log] };
      const paid = decodeEvents(one, MarketResolverAbi, 'BondsDistributed', resolver)[0];
      if (paid && eq(paid.marketToken, market)) payouts.push({ to: paid.winner, amount: bondOf(paid.totalAmount), redirected: false });
      const red = decodeEvents(one, MarketResolverAbi, 'BondRedirected', resolver)[0];
      if (red && eq(red.marketToken, market)) payouts.push({ to: red.intended, amount: bondOf(red.amount), redirected: true });
    }
    const seized = mine(this.events(tx, MarketResolverAbi, 'BondsSeized', resolver)).reduce((t, e) => t + e.totalAmount, 0n);
    const swept = mine(this.events(tx, TrancheMarketAbi, 'NoWinnerSwept', host)).reduce((t, e) => t + e.usdcToTaxes, 0n);
    const outcome = resolved ? 'resolved' : early ? 'earlyReset' : reopened ? 'reopened' : null;
    if (!outcome) addMissingEventWarning(tx, 'MarketResolver', 'Resolved/VoteReopened/EarlyReset', ['outcome', 'key', 'round']);
    return {
      ...tx,
      outcome,
      key: resolved ? resolved.outcomeKey : null,
      round: reopened ? Number(reopened.round) : early && reset ? Number(reset.round) : null,
      earlyResets: early ? Number(early.resets) : null,
      payouts,
      seized: bondOf(seized),
      swept: pairOf(swept),
    };
  }

  /** The first `name` log of `market` from the resolver, or null with a warning naming `fields`. */
  private marketEvent<N extends 'Proposal' | 'DisputeStarted' | 'Vote' | 'Vetoed'>(tx: TxResult, resolver: Address, name: N, market: Address, fields: string[]) {
    const ev = this.events(tx, MarketResolverAbi, name, resolver).find((e) => eq(e.marketToken, market));
    if (ev) return ev;
    addMissingEventWarning(tx, 'MarketResolver', name, fields);
    return null;
  }
}
