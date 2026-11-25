import { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { MarketResolverAbi, TrancheMarketAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import type { TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import type { MainRef } from '../core/mains';
import { normalizeRanking, validateTieMask } from '../core/ranking';
import { parseAmount, toAddress } from '../core/units';
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
  MarketWhitelistResult,
} from './MarketsBase';

/**
 * The public prediction-market host: ranked / multi-winner markets resolved by proposal, dispute and vote
 * (`client.marketResolver`). Each market keeps the resolver it was created with. When the seed floor (`getMinSeed`) is 0
 * a market may open without a seed.
 */
export class PredictionMarketsModule extends MarketsBase {
  readonly marketType = 'public' as const;
  protected readonly contractName = 'TrancheMarket' as const;

  constructor(client: BasisClient) {
    super(client);
  }

  protected get hostEntry(): Address | undefined {
    return this.client.addresses.tranche;
  }


  /**
   * Create a public market (see `CreateMarketParams`). BASIS approves each new market: with gating on, an approval is
   * requested from `client.api.approveMarket` (marketType "public") unless `approval` is passed, verified locally, and
   * its approved strings are sent verbatim. The seed may be 0 where the floor is 0. Returns the market token address.
   * An error after the approval that leaves it unused carries it as `approval` (`ErrorWithMarketApproval`): pass it
   * back as `approval` to try again without another review.
   */
  async createMarket(params: CreateMarketParams): Promise<CreateMarketResult> {
    return this.createMarketInternal(params, false);
  }

  /** `createMarket`, then upload the image (`imageUrl` or `imageFile`, checked first) and register the metadata (with `outcomeArt`, the outcome pictures). */
  async createMarketWithMetadata(params: CreateMarketParams & MarketMetadataOptions): Promise<CreateMarketWithMetadataResult> {
    return this.createMarketWithMetadataInternal(params, false);
  }

  protected async minSeedUnits(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'minSeed' });
  }

  protected async precheckCreateHost(host: Address): Promise<void> {
    const resolver = await this.publicClient.readContract({ address: host, abi: TrancheMarketAbi, functionName: 'resolver' });
    if (isZeroAddress(resolver)) throw new ValidationError('resolver unset', 'The public market host has no resolver: no market can be created.');
    const approved = await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'approvedHost', args: [host] });
    if (!approved) throw new ValidationError('Not an approved host', `The resolver ${resolver} does not approve the public host ${host}.`);
  }

  protected async sendCreate(c: CreateCall): Promise<TxResult> {
    return this.send({
      address: this.address,
      abi: TrancheMarketAbi,
      functionName: 'createMarket',
      args: [
        {
          marketName: c.name,
          symbol: c.symbol,
          endTime: c.endTime,
          optionNames: c.outcomes,
          trancheBP: c.trancheBP,
          maintoken: c.main,
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
   * endTime first, as on chain; then every market, dated or open-ended, takes no bets while its resolver holds a
   * proposal (a winning EARLY lifts the proposal and reopens betting until endTime).
   */
  protected async precheckBuyHost(market: Address, _md: MarketData, _buyer: Address, closed: BuyBlock | null): Promise<BuyBlock | null> {
    if (closed) return closed;
    const resolver = await this.getResolverOf(market);
    if (isZeroAddress(resolver)) return null;
    const proposed = await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'hasProposal', args: [market] });
    return proposed ? { reason: 'Outcome proposed', message: `A result has been proposed for market ${market}: no bets while the proposal is live.` } : null;
  }


  /**
   * Whitelist wallets on the frozen market token. Creator only. The token skips wallets already listed (the creator
   * always is, with cap 0): their cap is unchanged (listed in `capUnchanged`); to change a cap, `removeWhitelist`
   * first. For bets the whitelist is a yes/no gate: the cap limits only direct buys of the market token.
   * @param amount presale cap per wallet: raw 18-decimal tokens (bigint) or a human string/number.
   * @param wallets a non-empty array ('no wallets provided' otherwise) of addresses (rule `wallets`), checked before any read.
   * @param tag a label stored with the entries (default, also for null: ''); well-formed text (rule `tag`), checked before any read.
   */
  async setWhitelistedWallet(market: Address, wallets: Address[], amount: bigint | string | number, tag: string | null = ''): Promise<MarketWhitelistResult> {
    market = toAddress(market, 'market');
    wallets = this.walletList(wallets, 'wallets');
    const t = this.whitelistTag(tag);
    await this.requireCreator(market);
    const tx = await this.send({
      address: this.address, abi: TrancheMarketAbi, functionName: 'setWhitelistedWallet',
      args: [wallets, parseAmount(amount, 18), t, market], contract: this.contractName,
    });
    return this.whitelistResult(tx, market, wallets, true);
  }

  /** Remove a wallet from the market token's whitelist. Creator only. `removed` lists it once the token logged `WhitelistRemoved`. */
  async removeWhitelist(market: Address, wallet: Address): Promise<MarketWhitelistResult> {
    market = toAddress(market, 'market');
    wallet = toAddress(wallet, 'wallet');
    await this.requireCreator(market);
    const tx = await this.send({ address: this.address, abi: TrancheMarketAbi, functionName: 'removeWhitelist', args: [wallet, market], contract: this.contractName });
    return this.whitelistResult(tx, market, [], false);
  }


  /** Seed floor for a new public market on `main` (default: the default main), in its pair asset. */
  async getMinSeed(main?: MainRef): Promise<Amount> {
    return this.minSeedAmount(main, false);
  }

  /** Tie bits of the result (bit i: ranking entry i tied with entry i-1). */
  async getFinalTieMask(market: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'finalTieMask', args: [market] });
  }

  /** Bitmask of the outcomes tied for first (one bit for a single winner); 0 when unresolved or INVALID. */
  async getFinalWinnersMask(market: Address): Promise<bigint> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'finalWinnersMask', args: [market] });
  }

  /**
   * Is (`ranking`, `tieMask`) a legal result for this market? Picks must be integers 0-255 ('rankingEntry') and
   * `tieMask` a uint256 bigint ('tieMask'): nothing is coerced.
   */
  async isValidRanking(market: Address, ranking: number[], tieMask: bigint = 0n): Promise<boolean> {
    market = toAddress(market, 'market');
    const picks = normalizeRanking(ranking);
    validateTieMask(tieMask);
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'isValidRanking', args: [market, picks, tieMask] });
  }

  /** The resolver this market was created with: only it resolves the market. */
  async getResolverOf(market: Address): Promise<Address> {
    market = toAddress(market, 'market');
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'marketResolver', args: [market] });
  }

  /** The resolver new markets are registered with. */
  async getResolver(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: TrancheMarketAbi, functionName: 'resolver' });
  }
}
