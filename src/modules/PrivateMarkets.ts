import { Address, Hex, isAddressEqual } from 'viem';
import type { BasisClient } from '../BasisClient';
import { FactoryTokenAbi, TrancheMarketPrivateAbi } from '../abis';
import type { TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { addMissingEventWarning } from '../core/events';
import { pairAmountOf } from '../core/amounts';
import { ANY_KEYS, type KeyMap, optionKeys, optsOf } from '../core/opts';
import type { MainRef } from '../core/mains';
import { KEY_INVALID, normalizeRanking, OUTCOME_INVALID, rankingKey, validateRanking } from '../core/ranking';
import { parseAmount, toAddress, toBool } from '../core/units';
import type { Amount } from '../core/units';
import {
  BuyBlock,
  CreateCall,
  CreateMarketParams,
  CreateMarketResult,
  CreateMarketWithMetadataResult,
  MarketData,
  MarketMetadataOptions,
  MarketsBase,
  MarketStatus,
  MarketWhitelistResult,
} from './MarketsBase';

/** A voter panel holds the creator plus up to 10 appointed voters. */
const MAX_VOTERS = 11;
const ZERO_KEY = `0x${'0'.repeat(64)}` as Hex;

export interface CreatePrivateMarketParams extends CreateMarketParams {
  /** Invite-only bettors; uses the private-event seed floor (see `getMinSeed`). Not bound by the approval. Default false. */
  privateEvent?: boolean;
}
const CREATE_PRIVATE_MARKET_KEY_MAP: KeyMap<CreatePrivateMarketParams> = {
  name: true, symbol: true, outcomes: true, endTime: true, trancheBP: true, main: true, frozen: true, presaleTokens: true,
  seed: true, description: true, approval: true, privateEvent: true,
};
const CREATE_PRIVATE_MARKET_KEYS = optionKeys<CreatePrivateMarketParams>(CREATE_PRIVATE_MARKET_KEY_MAP);
const CREATE_PRIVATE_MARKET_WITH_METADATA_KEYS = optionKeys<CreatePrivateMarketParams & MarketMetadataOptions>({
  ...CREATE_PRIVATE_MARKET_KEY_MAP, imageUrl: true, imageFile: true, website: true, telegram: true, twitterx: true, outcomeArt: true,
});

/** Options of `getMinSeed`. */
export interface PrivateMinSeedOptions {
  /** The invite-only (private-event) floor (default false: the floor of other private-host markets). */
  privateEvent?: boolean | null;
}
const PRIVATE_MIN_SEED_KEYS = optionKeys<PrivateMinSeedOptions>({ privateEvent: true });

/** A ranking with its tie bits (bit i: entry i tied with entry i-1). Empty = INVALID. */
export interface RankingResult {
  ranking: number[];
  tieMask: bigint;
}

export interface VoterKey extends RankingResult {
  /** bytes32 key of the voter's ranking: zero = not voted. */
  key: Hex;
  voted: boolean;
  /** The voter voted INVALID. */
  invalid: boolean;
}

/** One panel voter and their vote. */
export interface PanelVoter extends VoterKey {
  voter: Address;
  isCreator: boolean;
}

/** `vote`: the key recorded (`RankedVote`). */
export interface PrivateVoteResult extends TxResult {
  /** The key recorded for the vote (KEY_INVALID for an empty ranking). Null when the event is missing. */
  key: Hex | null;
}

/** `finalize`: the result, from the host's `Resolved` / `RankedResolved` / `NoWinnerSwept` logs. */
export interface PrivateFinalizeResult extends TxResult {
  /** 'resolved' (a ranking won) or 'invalid' (INVALID won: cost-basis refunds). Null when `Resolved` is missing. */
  status: Exclude<MarketStatus, 'unresolved'> | null;
  /** ranking[0], or 254 for INVALID. Null when the event is missing. */
  finalOutcome: number | null;
  /** The winning ranking ([] for INVALID). Null when the event is missing. */
  ranking: number[] | null;
  tieMask: bigint | null;
  /** Pair asset the protocol kept because every ranked outcome had no backers (the market's pair asset; 0 when none). */
  swept: Amount;
}

/** `manageVoter`: the panel change logged (`MarketVoterSet`). */
export interface ManageVoterResult extends TxResult {
  voter: Address;
  /** The voter's status now (true = on the panel). Null when the event is missing. */
  status: boolean | null;
}

/** `togglePrivateEventBuyers` / `manageWhitelist`: the wallets whose bet right was set (`PrivateBuyerSet`), plus the token's whitelist logs. */
export interface PrivateBuyersResult extends MarketWhitelistResult {
  /** Wallets whose bet right was set to the status sent (toggle skips the creator: always allowed). */
  buyersSet: Address[];
}

/** The voter panel of a private market and its voting clock. */
export interface VoterPanel {
  market: Address;
  creator: Address;
  /** The creator plus up to 10 appointed voters, each with their vote. */
  voters: PanelVoter[];
  /** Panel voters who have voted. */
  votedCount: number;
  /** Unix seconds of the first vote; 0 = nobody voted (the panel can still change). */
  firstVoteTime: bigint;
  /** The voting window, seconds. */
  votingWindow: bigint;
  /** firstVoteTime + votingWindow; 0 before the first vote. */
  votingEndsAt: bigint;
  /** The window has run (chain time >= votingEndsAt): `finalize` is open unless the tally needs the creator's tie-break. */
  votingOver: boolean;
  resolved: boolean;
  /** Key of the winning ranking (zero when unresolved / INVALID). */
  finalKey: Hex;
}

/**
 * The private prediction-market host: ranked / multi-winner markets resolved by the creator's voter panel (creator +
 * up to 10 voters), plurality after a voting window that opens with the first vote.
 *
 * BASIS can void a private market in case of abuse. That only puts the market in refund mode: it can't pick a result.
 */
export class PrivateMarketsModule extends MarketsBase {
  readonly marketType = 'private' as const;
  protected readonly contractName = 'TrancheMarketPrivate' as const;

  constructor(client: BasisClient) {
    super(client);
  }

  protected get hostEntry(): Address | undefined {
    return this.client.addresses.tranchePrivate;
  }


  /**
   * Create a private market (see `CreatePrivateMarketParams`). BASIS approves each new market: with gating on, an
   * approval is requested from `client.api.approveMarket` (marketType "private") unless `approval` is passed, verified
   * locally, and its approved strings are sent verbatim. The seed may be 0 where the floor is 0. An error after the
   * approval that leaves it unused carries it as `approval` (`ErrorWithMarketApproval`): pass it back as `approval` to
   * try again without another review.
   */
  async createMarket(params: CreatePrivateMarketParams): Promise<CreateMarketResult> {
    const p = optsOf(params, CREATE_PRIVATE_MARKET_KEYS);
    return this.createMarketInternal(p, toBool(p.privateEvent ?? undefined, 'privateEvent', false), ANY_KEYS);
  }

  /** `createMarket`, then upload the image (`imageUrl` or `imageFile`, checked first) and register the metadata (with `outcomeArt`, the outcome pictures). */
  async createMarketWithMetadata(params: CreatePrivateMarketParams & MarketMetadataOptions): Promise<CreateMarketWithMetadataResult> {
    const p = optsOf(params, CREATE_PRIVATE_MARKET_WITH_METADATA_KEYS);
    return this.createMarketWithMetadataInternal(p, toBool(p.privateEvent ?? undefined, 'privateEvent', false), ANY_KEYS);
  }

  protected async minSeedUnits(privateEvent: boolean): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.address, abi: TrancheMarketPrivateAbi, functionName: privateEvent ? 'minSeedPrivate' : 'minSeedPublic',
    });
  }

  protected async precheckCreateHost(): Promise<void> {
  }

  protected async sendCreate(c: CreateCall): Promise<TxResult> {
    return this.send({
      address: this.address,
      abi: TrancheMarketPrivateAbi,
      functionName: 'createMarket',
      args: [
        {
          marketName: c.name,
          symbol: c.symbol,
          endTime: c.endTime,
          optionNames: c.outcomes,
          trancheBP: c.trancheBP,
          maintoken: c.main,
          privateEvent: c.privateEvent,
          frozen: c.frozen,
          bonding: c.presaleTokens,
          seedAmount: c.seed,
        },
        c.deadline,
        c.signature,
      ],
      value: c.value,
      contract: this.contractName,
    });
  }

  /**
   * As on chain: invite-only markets need the bettor invited (checked first), then a dated market closes at endTime and
   * an open-ended one at the first vote. A proposal plays no part here: the panel resolves.
   */
  protected async precheckBuyHost(market: Address, md: MarketData, buyer: Address, closed: BuyBlock | null): Promise<BuyBlock | null> {
    const [canBuy, firstVote] = await Promise.all([
      md.isPrivate ? this.canUserBuy(market, buyer) : Promise.resolve(true),
      md.endTime === 0n ? this.getFirstVoteTime(market) : Promise.resolve(0n),
    ]);
    if (!canBuy) return { reason: 'not invited', message: `Market ${market} is invite-only and ${buyer} is not on its buyer list.` };
    if (closed) return closed;
    if (firstVote !== 0n) return { reason: 'voting started', message: `Voting has started on open-ended market ${market}: betting is closed.` };
    return null;
  }


  /**
   * Cast your ranked vote: `ranking` lists outcomes in finish order (every outcome in a slot below K = the
   * number of payout slices, ties included); `tieMask` bit i ties entry i with entry i-1. An empty ranking votes
   * INVALID. Voters only, once, after `endTime` (open-ended: any time after creation). Checked first, before any read:
   * `ranking` an array ('ranking') of whole numbers 0-255 ('rankingEntry'), and with picks `tieMask` a uint256 bigint
   * ('tieMask'; an empty ranking ignores it).
   */
  async vote(market: Address, ranking: number[], tieMask: bigint = 0n): Promise<PrivateVoteResult> {
    market = toAddress(market, 'market');
    const voter = this.account;
    const picks = normalizeRanking(ranking);
    if (picks.length) rankingKey(picks, tieMask);
    const md = await this.requireMarket(market);
    const [isVoter, key, now] = await Promise.all([
      this.isMarketVoter(market, voter),
      this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'voterKey', args: [market, voter] }),
      this.chainTime(),
    ]);
    if (!isVoter) throw new ValidationError('not a voter', `${voter} is not a voter on market ${market}.`);
    if (key !== ZERO_KEY) throw new ValidationError('already voted', `${voter} has already voted on market ${market}.`);
    if (md.resolved) throw new ValidationError('market resolved', `Market ${market} is already resolved.`);
    const start = md.endTime === 0n ? md.creationTime : md.endTime;
    if (now < start) {
      throw new ValidationError('voting not open', `Voting opens at ${start} (chain time ${now}).`);
    }
    if (picks.length === 0) {
      tieMask = 0n;
    } else {
      const [n, bp] = await Promise.all([this.getNumOutcomes(market), this.getTrancheBP(market)]);
      validateRanking(picks, tieMask, n, bp.length);
    }
    const host = this.address;
    const tx = await this.send({
      address: host, abi: TrancheMarketPrivateAbi, functionName: 'vote', args: [market, picks, tieMask], contract: this.contractName,
    });
    const ev = this.events(tx, TrancheMarketPrivateAbi, 'RankedVote', host).find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.voter, voter));
    if (!ev) addMissingEventWarning(tx, this.contractName, 'RankedVote', ['key']);
    return { ...tx, key: ev ? ev.key : null };
  }

  /** Vote a single winner: `ranking = [outcome]` (valid only on a winner-takes-all market, one payout slice). */
  async voteOutcome(market: Address, outcome: number): Promise<PrivateVoteResult> {
    return this.vote(market, [outcome], 0n);
  }

  /** Vote INVALID (empty ranking): a win for INVALID refunds every bettor's cost basis. */
  async voteInvalid(market: Address): Promise<PrivateVoteResult> {
    return this.vote(market, [], 0n);
  }

  /**
   * Tally the votes and resolve. Anyone may call it once the voting window (`getVotingWindow`) has passed since the
   * first vote. The result has the outcome (`status`, `finalOutcome`, `ranking`, `tieMask`) and what the protocol kept
   * when every ranked outcome had no backers.
   */
  async finalize(market: Address): Promise<PrivateFinalizeResult> {
    market = toAddress(market, 'market');
    const md = await this.requireMarket(market);
    if (md.resolved) throw new ValidationError('market resolved', `Market ${market} is already resolved.`);
    const [first, window, now] = await Promise.all([this.getFirstVoteTime(market), this.getVotingWindow(), this.chainTime()]);
    if (first === 0n) throw new ValidationError('no votes', `Nobody has voted on market ${market} yet.`);
    if (now < first + window) throw new ValidationError('voting window open', `The voting window closes at ${first + window} (chain time ${now}).`);
    await this.precheckTally(market, md.creator);
    const pairOf = pairAmountOf(await this.client.mains.get(md.main));
    const host = this.address;
    const tx = await this.send({ address: host, abi: TrancheMarketPrivateAbi, functionName: 'finalize', args: [market], contract: this.contractName });
    const mine = <T extends { marketToken: Address }>(l: T[]) => l.filter((e) => isAddressEqual(e.marketToken, market));
    const resolved = mine(this.events(tx, TrancheMarketPrivateAbi, 'Resolved', host))[0];
    const ranked = mine(this.events(tx, TrancheMarketPrivateAbi, 'RankedResolved', host))[0];
    const swept = mine(this.events(tx, TrancheMarketPrivateAbi, 'NoWinnerSwept', host)).reduce((t, e) => t + e.usdcToTaxes, 0n);
    if (!resolved) addMissingEventWarning(tx, this.contractName, 'Resolved', ['status', 'finalOutcome', 'ranking', 'tieMask']);
    const fo = resolved ? Number(resolved.finalOutcome) : null;
    const invalid = fo === OUTCOME_INVALID;
    return {
      ...tx,
      status: fo === null ? null : invalid ? 'invalid' : 'resolved',
      finalOutcome: fo,
      ranking: fo === null ? null : invalid ? [] : ranked ? ranked.ranking.map(Number) : null,
      tieMask: fo === null ? null : invalid ? 0n : ranked ? ranked.tieMask : null,
      swept: pairOf(swept),
    };
  }


  /**
   * Add (`status` true) or remove a voter. Creator only; locked after the first vote; at most 11 voters including the
   * creator. `status` must be a real boolean (`ValidationError('status')` otherwise, before any read).
   */
  async manageVoter(market: Address, voter: Address, status: boolean): Promise<ManageVoterResult> {
    status = toBool(status, 'status');
    market = toAddress(market, 'market');
    voter = toAddress(voter, 'voter');
    const md = await this.requireCreator(market);
    if (/^0x0{40}$/i.test(voter)) throw new ValidationError('voter', 'voter must not be the zero address.');
    const [first, voters, isVoter] = await Promise.all([this.getFirstVoteTime(market), this.getVoters(market), this.isMarketVoter(market, voter)]);
    if (first !== 0n) throw new ValidationError('voters locked', 'Voters cannot change after the first vote.');
    if (status) {
      if (isVoter) throw new ValidationError('already a voter', `${voter} is already a voter.`);
      if (voters.length >= MAX_VOTERS) throw new ValidationError('too many voters', `A market has at most ${MAX_VOTERS} voters (the creator included).`);
    } else {
      if (!isVoter) throw new ValidationError('not a voter', `${voter} is not a voter.`);
      if (voter.toLowerCase() === md.creator.toLowerCase()) throw new ValidationError('creator', 'The creator cannot be removed from the panel.');
    }
    const host = this.address;
    const tx = await this.send({
      address: host, abi: TrancheMarketPrivateAbi, functionName: 'manageVoter', args: [market, voter, status], contract: this.contractName,
    });
    const ev = this.events(tx, TrancheMarketPrivateAbi, 'MarketVoterSet', host).find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.voter, voter));
    if (!ev) addMissingEventWarning(tx, this.contractName, 'MarketVoterSet', ['status']);
    return { ...tx, voter, status: ev ? ev.status : null };
  }

  /**
   * Allow (`status` true) or disallow wallets to bet on an invite-only (`privateEvent`) market. Creator only. Allowing
   * also whitelists them on the market token with an unlimited cap, but the token skips wallets already listed (their
   * cap stays, e.g. a lower one set by `manageWhitelist`: see `capUnchanged`). The creator is always allowed and skipped.
   * `status` must be a real boolean (`ValidationError('status')`); `buyers` a non-empty array ('no wallets provided'
   * otherwise) of addresses (rule `buyers`), checked before any read.
   */
  async togglePrivateEventBuyers(market: Address, buyers: Address[], status: boolean): Promise<PrivateBuyersResult> {
    status = toBool(status, 'status');
    market = toAddress(market, 'market');
    buyers = this.walletList(buyers, 'buyers');
    const md = await this.requireCreator(market);
    if (!md.isPrivate) throw new ValidationError('not invite-only', `Market ${market} is not an invite-only (privateEvent) market.`);
    if (!status) await this.requireWhitelisted(market, buyers.filter((b) => b.toLowerCase() !== md.creator.toLowerCase()));
    const tx = await this.send({
      address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'togglePrivateEventBuyers', args: [market, buyers, status], contract: this.contractName,
    });
    const requested = status ? buyers.filter((b) => !isAddressEqual(b, md.creator)) : [];
    return this.buyersResult(tx, market, requested, status);
  }

  /**
   * Whitelist (`status` true, with a presale cap per wallet) or de-list wallets on the market token, and set
   * their bet right. Creator only. The token skips wallets already listed, so their cap does not change
   * (`capUnchanged` in the result; the creator is always listed, with cap 0): to change a cap, de-list first, then
   * list again. For bets the whitelist is a yes/no gate; the cap limits only direct buys of the market token.
   * @param amount presale cap per wallet: raw 18-decimal tokens (bigint) or a human string/number (ignored when removing).
   * @param tag a label stored with the entries ('' for none; null too); well-formed text (rule `tag`), checked before any read.
   * @param status a real boolean (`ValidationError('status')` otherwise).
   * @param wallets a non-empty array ('no wallets provided' otherwise) of addresses (rule `wallets`), checked before any read.
   */
  async manageWhitelist(market: Address, wallets: Address[], amount: bigint | string | number, tag: string | null, status: boolean): Promise<PrivateBuyersResult> {
    status = toBool(status, 'status');
    market = toAddress(market, 'market');
    wallets = this.walletList(wallets, 'wallets');
    const t = this.whitelistTag(tag);
    await this.requireCreator(market);
    if (!status) await this.requireWhitelisted(market, wallets);
    const tx = await this.send({
      address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'manageWhitelist',
      args: [market, wallets, parseAmount(amount, 18), t, status], contract: this.contractName,
    });
    return this.buyersResult(tx, market, status ? wallets : [], status);
  }

  /** The `PrivateBuyerSet` logs of `market` with this status, plus the token's whitelist logs. */
  private buyersResult(tx: TxResult, market: Address, requested: readonly Address[], status: boolean): PrivateBuyersResult {
    const buyersSet = this.events(tx, TrancheMarketPrivateAbi, 'PrivateBuyerSet', this.address)
      .filter((e) => isAddressEqual(e.marketToken, market) && e.status === status).map((e) => e.user);
    return { ...this.whitelistResult(tx, market, requested, status), buyersSet };
  }

  /** De-listing: every wallet must be on the market token's whitelist, once (the token reverts "Wallet is not whitelisted"). */
  private async requireWhitelisted(market: Address, wallets: Address[]): Promise<void> {
    const seen = new Set<string>();
    for (const w of wallets) {
      if (seen.has(w.toLowerCase())) throw new ValidationError('duplicate wallet', `${w} is listed twice: the second removal would revert.`);
      seen.add(w.toLowerCase());
    }
    const listed = await Promise.all(wallets.map((w) => this.publicClient.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'whitelisted', args: [w] })));
    const missing = wallets.filter((_, i) => !listed[i]);
    if (missing.length) {
      throw new ValidationError('not whitelisted', `Not on market token ${market}'s whitelist, so they cannot be removed: ${missing.join(', ')}.`);
    }
  }

  /**
   * The tally reverts with no reason when no panel voter has voted, and on a tie for the lead while the creator has not
   * voted. Once the creator has voted, a tie goes to their choice if it is one of the tied leaders; if not, the market
   * resolves INVALID.
   */
  private async precheckTally(market: Address, creator: Address): Promise<void> {
    const voters = await this.getVoters(market);
    const keys = await Promise.all(voters.map((v) => this.publicClient.readContract({
      address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'voterKey', args: [market, v],
    })));
    const counts = new Map<string, number>();
    for (const k of keys) if (k !== ZERO_KEY) counts.set(k, (counts.get(k) ?? 0) + 1);
    if (counts.size === 0) throw new ValidationError('no votes', `No panel voter has voted on market ${market} yet.`);
    const max = Math.max(...counts.values());
    const leaders = [...counts.values()].filter((c) => c === max).length;
    const creatorKey = keys[voters.findIndex((v) => v.toLowerCase() === creator.toLowerCase())] ?? ZERO_KEY;
    if (leaders > 1 && creatorKey === ZERO_KEY) {
      throw new ValidationError('creator must break the tie', `The vote on market ${market} is tied and the creator (${creator}) has not voted: only their vote can break it.`);
    }
  }


  /**
   * Seed floor for a new private market on `main` (default: the default main), in its pair asset: the invite-only floor
   * with `privateEvent`, else the floor of other markets. May be 0.
   */
  async getMinSeed(main?: MainRef, opts: PrivateMinSeedOptions | null = {}): Promise<Amount> {
    const o = optsOf(opts, PRIVATE_MIN_SEED_KEYS);
    return this.minSeedAmount(main, toBool(o.privateEvent ?? undefined, 'privateEvent', false));
  }

  async getVoters(market: Address): Promise<Address[]> {
    market = toAddress(market, 'market');
    return [...await this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'getVoters', args: [market] })];
  }

  async isMarketVoter(market: Address, voter: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    voter = toAddress(voter, 'voter');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'isMarketVoter', args: [market, voter] });
  }

  /** Unix seconds of the first vote; 0 = nobody voted. */
  async getFirstVoteTime(market: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'firstVoteTime', args: [market] });
  }

  /** A voter's vote: its key and the ranking behind it (zero key = not voted; INVALID key = voted INVALID). */
  async getVoterKey(market: Address, voter: Address): Promise<VoterKey> {
    market = toAddress(market, 'market');
    voter = toAddress(voter, 'voter');
    const key = await this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'voterKey', args: [market, voter] });
    if (key === ZERO_KEY) return { key, voted: false, invalid: false, ranking: [], tieMask: 0n };
    if (key.toLowerCase() === KEY_INVALID.toLowerCase()) return { key, voted: true, invalid: true, ranking: [], tieMask: 0n };
    return { key, voted: true, invalid: false, ...await this.getRanking(market, key) };
  }

  /** Key of the winning ranking (zero when unresolved or INVALID). */
  async getFinalKey(market: Address): Promise<Hex> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'finalKey', args: [market] });
  }

  /** The ranking and tie bits stored under `key` (a `voterKey` or the `finalKey`). */
  async getRanking(market: Address, key: Hex): Promise<RankingResult> {
    market = toAddress(market, 'market');
    const [ranking, tieMask] = await this.publicClient.readContract({
      address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'getRanking', args: [market, key],
    });
    return { ranking: ranking.map(Number), tieMask };
  }

  /** Tie bits of the result, via `getRanking(market, finalKey)`. */
  async getFinalTieMask(market: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    const key = await this.getFinalKey(market);
    if (key === ZERO_KEY) return 0n;
    return (await this.getRanking(market, key)).tieMask;
  }

  /**
   * May `user` bet on this invite-only market? The creator is always allowed (set at creation, with
   * no `PrivateBuyerSet` event). The whole invite list is in the API: `client.api.getMarket(market).invited` /
   * `invitedCount` (built from `PrivateBuyerSet`, so it never lists the creator); a wallet's voter and buyer roles:
   * `client.api.getWalletRoles(wallet).privateMarkets`.
   */
  async canUserBuy(market: Address, user: Address): Promise<boolean> {
    market = toAddress(market, 'market');
    user = toAddress(user, 'user');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'userCanBuyEvent', args: [market, user] });
  }

  /**
   * The voter panel with every voter's vote (key, ranking, INVALID), the first vote time, the window and its end,
   * and the final key. Reads only. The invite list is in the API (`client.api.getMarket(market).invited`; the creator
   * is always allowed but not listed there); `canUserBuy` answers one wallet; which panels a wallet sits on:
   * `client.api.getWalletRoles(wallet).privateMarkets`.
   */
  async getVoterPanel(market: Address): Promise<VoterPanel> {
    market = toAddress(market, 'market');
    const md = await this.requireMarket(market);
    const [voters, firstVoteTime, votingWindow, finalKey, now] = await Promise.all([
      this.getVoters(market), this.getFirstVoteTime(market), this.getVotingWindow(), this.getFinalKey(market), this.chainTime(),
    ]);
    const keys = await Promise.all(voters.map((v) => this.getVoterKey(market, v)));
    const panel = voters.map((voter, i) => ({ voter, isCreator: voter.toLowerCase() === md.creator.toLowerCase(), ...keys[i] }));
    const votingEndsAt = firstVoteTime === 0n ? 0n : firstVoteTime + votingWindow;
    return {
      market, creator: md.creator, voters: panel, votedCount: panel.filter((v) => v.voted).length,
      firstVoteTime, votingWindow, votingEndsAt, votingOver: firstVoteTime !== 0n && now >= votingEndsAt,
      resolved: md.resolved, finalKey,
    };
  }

  /** Minimum voting time in seconds (15 min): finalize opens this long after the first vote. */
  async getVotingWindow(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketPrivateAbi, functionName: 'VOTING_WINDOW' });
  }
}
