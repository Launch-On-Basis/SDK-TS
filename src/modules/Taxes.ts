import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { ERC20Abi, EcosystemTokenAbi, TaxesAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { Amount, toAddress, toAmount, toBool, toUint } from '../core/units';

/** A dev share of 100%, in basis points. */
const TOTAL_BASIS_POINTS = 10_000n;
/** Most share wallets a token can have. */
const MAX_SHARES = 10;

/** A token's fee settings. All rates in basis points of the trade. */
export interface TokenTaxInfo {
  /** The token is a main (paused or not). Mains pay the base rate only. */
  isMain: boolean;
  /** Hybrid multiplier (100 for a main; the reversed setting on a reversed token). */
  hybridMultiplier: number;
  rewardsEnabled: boolean;
  dev: Address;
  baseRate: number;
  creatorFee: number;
  rewardsFee: number;
  /** base + creator + rewards, for a wallet that is neither whitelisted nor referred (a referred one pays a lower base). */
  totalRate: number;
  /** 0 for a main. */
  maxCreatorFee: number;
  /** 0 for a main or a token without rewards. */
  maxRewardsFee: number;
  /** Reversed (meme+) token. */
  reversed: boolean;
}

/** Cooldown state of a token's creator and rewards fees. Times are unix seconds. */
export interface FeeCooldowns {
  /** Seconds between two changes (0 = no cooldown). */
  creatorFeeCooldown: number;
  rewardsFeeCooldown: number;
  /** Last change (0 = never set; the first setting is free). */
  creatorFeeSetAt: number;
  rewardsFeeSetAt: number;
  /**
   * Earliest time of the next change: `setAt + cooldown`, or 0 before the first setting. A time in the past also means
   * "can change now" (it stays a past timestamp once the cooldown ran out); use `canChange*`.
   */
  creatorFeeNextChangeAt: number;
  rewardsFeeNextChangeAt: number;
  /** The fee can be changed now (next change time reached at the latest block's timestamp). */
  canChangeCreatorFee: boolean;
  canChangeRewardsFee: boolean;
}

/** `setCreatorFee` result: the fee set, read from the tx's log (null with a warning when it is missing). */
export interface SetCreatorFeeResult extends TxResult {
  creatorFee: number | null;
}

/** `setRewardsFee` result: the fee set, read from the tx's log (null with a warning when it is missing). */
export interface SetRewardsFeeResult extends TxResult {
  rewardsFee: number | null;
}

/** `addDevShare` / `removeDevShare` result: the wallet's share now, read from the tx's log (0 after a removal; null when missing). */
export interface DevShareResult extends TxResult {
  basisPoints: number | null;
}

/**
 * Trade fees: the base rate, dev-set creator / rewards fees, dev share wallets and referral earnings (who referred whom
 * is `client.referrals`). Fees are read live, in bps. Earnings are per pair asset and returned as `Amount` in pair-asset
 * units.
 */
export class TaxesModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** Whether the `taxes` address is set on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.taxes);
  }

  private get address(): Address {
    return this.require(this.client.addresses.taxes, 'Taxes');
  }



  /**
   * The base fee in bps, read live: before the referral discount and without a token's creator / rewards fees (the
   * rate loan actions pay).
   */
  async getBaseRate(): Promise<number> {
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'baseRate' }));
  }

  /**
   * The fee `user` pays on `token`'s side of a trade, in bps, for an explicit base `baseBps`: the base (lower when
   * `user` has a referrer) plus the token's creator and rewards fees (mains: base only); 0 for a fee-whitelisted wallet.
   * For quoting a side that charges a different base, such as one leg of a cross-pair swap; `getTaxRate` is this with
   * the live base rate.
   */
  async getTaxRateBase(token: Address, user: Address, baseBps: number | bigint): Promise<number> {
    token = toAddress(token, 'token');
    user = toAddress(user, 'user');
    const bps = toUint(baseBps, 'baseBps');
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'getTaxRateBase', args: [token, user, bps] }));
  }

  /**
   * The fee `user` pays trading `token`, in bps, read live: the base rate (lower when `user` has a referrer) plus the
   * token's creator and rewards fees (mains: base only). 0 for a fee-whitelisted wallet.
   */
  async getTaxRate(token: Address, user: Address): Promise<number> {
    token = toAddress(token, 'token');
    user = toAddress(user, 'user');
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'getTaxRate', args: [token, user] }));
  }

  /** Every fee setting of a token in one call. */
  async getTokenTaxInfo(token: Address): Promise<TokenTaxInfo> {
    const i = await this.publicClient.readContract({
      address: this.address, abi: TaxesAbi, functionName: 'getTokenTaxInfo', args: [toAddress(token, 'token')],
    });
    return {
      isMain: i.isMain,
      hybridMultiplier: Number(i.hybridMultiplier),
      rewardsEnabled: i.rewardsEnabled,
      dev: i.dev,
      baseRate: Number(i.baseRate),
      creatorFee: Number(i.creatorFee),
      rewardsFee: Number(i.rewardsFee),
      totalRate: Number(i.totalRate),
      maxCreatorFee: Number(i.maxCreatorFee),
      maxRewardsFee: Number(i.maxRewardsFee),
      reversed: i.reversed,
    };
  }

  /** The creator-fee cap in bps, read live. */
  async getMaxCreatorFee(): Promise<number> {
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'MAX_CREATOR_FEE' }));
  }

  /** The rewards-fee cap in bps for a token with these settings, read live. */
  async getMaxRewardsFee(hybridMultiplier: number | bigint, reversed: boolean): Promise<number> {
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'maxRewardsFee', args: [toUint(hybridMultiplier, 'hybridMultiplier'), toBool(reversed, 'reversed')] }));
  }

  /** True when `wallet` is fee-whitelisted (pays no trade fee). */
  async isWhitelisted(wallet: Address): Promise<boolean> {
    return this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'isWhitelisted', args: [toAddress(wallet, 'wallet')] });
  }

  /**
   * Cooldown settings and the last change of `token`'s creator and rewards fees, and whether each can change now
   * (against the latest block's timestamp).
   */
  async getFeeCooldowns(token: Address): Promise<FeeCooldowns> {
    token = toAddress(token, 'token');
    const [cc, rc, cAt, rAt, block] = await Promise.all([
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'creatorFeeCooldown' }),
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'rewardsFeeCooldown' }),
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'creatorFeeSetAt', args: [token] }),
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'rewardsFeeSetAt', args: [token] }),
      this.publicClient.getBlock(),
    ]);
    const creatorNext = cAt === 0n ? 0 : Number(cAt + cc);
    const rewardsNext = rAt === 0n ? 0 : Number(rAt + rc);
    const now = Number(block.timestamp);
    return {
      creatorFeeCooldown: Number(cc),
      rewardsFeeCooldown: Number(rc),
      creatorFeeSetAt: Number(cAt),
      rewardsFeeSetAt: Number(rAt),
      creatorFeeNextChangeAt: creatorNext,
      rewardsFeeNextChangeAt: rewardsNext,
      canChangeCreatorFee: now >= creatorNext,
      canChangeRewardsFee: now >= rewardsNext,
    };
  }


  /**
   * Set `token`'s creator fee (bps on top of the base rate, paid to the dev and share wallets).
   * Caller: the token's dev, or on a prediction market token the market's creator (holding the whole dev share).
   * At most `getMaxCreatorFee()`; one change per cooldown (`getFeeCooldowns`), the first setting is free.
   * Refused on a main, paused or not.
   */
  async setCreatorFee(token: Address, bps: number | bigint): Promise<SetCreatorFeeResult> {
    const me = this.account;
    const value = toUint(bps, 'bps');
    token = toAddress(token, 'token');
    const info = await this.getTokenTaxInfo(token);
    if (info.isMain) throw new ValidationError('not on MAIN', 'Fees cannot be set on a main.');
    if (info.dev.toLowerCase() !== me.toLowerCase()) {
      const [isHost, share] = await Promise.all([
        this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'isPrediction', args: [info.dev] }),
        this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devBasisPoints', args: [token, me] }),
      ]);
      if (!(isHost && share === TOTAL_BASIS_POINTS)) {
        throw new ValidationError('only dev', `Only the token's creator (${info.dev}) can set its creator fee.`);
      }
    }
    if (value > BigInt(info.maxCreatorFee)) {
      throw new ValidationError('over max', `Creator fee ${value} bps is above the max of ${info.maxCreatorFee} bps.`);
    }
    await this.checkCooldown(token, 'creator');
    const tx = await this.send({ address: this.address, abi: TaxesAbi, functionName: 'setCreatorFee', args: [token, value], contract: 'Taxes' });
    const ev = this.expectEvent(tx, TaxesAbi, 'CreatorFeeSet', this.address, 'Taxes', ['creatorFee']);
    return { ...tx, creatorFee: ev ? Number(ev.bps) : null };
  }

  /**
   * Set `token`'s rewards fee (bps on top of the base rate, paid to the token's holders). Caller: the token's dev.
   * Needs a rewards-enabled token; at most `getTokenTaxInfo(token).maxRewardsFee`; one change per cooldown
   * (`getFeeCooldowns`). Refused on a main, paused or not.
   */
  async setRewardsFee(token: Address, bps: number | bigint): Promise<SetRewardsFeeResult> {
    const me = this.account;
    const value = toUint(bps, 'bps');
    token = toAddress(token, 'token');
    const info = await this.getTokenTaxInfo(token);
    if (info.isMain) throw new ValidationError('not on MAIN', 'Fees cannot be set on a main.');
    if (info.dev.toLowerCase() !== me.toLowerCase()) {
      throw new ValidationError('only dev', `Only the token's creator (${info.dev}) can set its rewards fee.`);
    }
    if (!info.rewardsEnabled) throw new ValidationError('rewards off', 'This token was created without holder rewards.');
    if (value > BigInt(info.maxRewardsFee)) {
      throw new ValidationError('over max', `Rewards fee ${value} bps is above the max of ${info.maxRewardsFee} bps for this token.`);
    }
    await this.checkCooldown(token, 'rewards');
    const tx = await this.send({ address: this.address, abi: TaxesAbi, functionName: 'setRewardsFee', args: [token, value], contract: 'Taxes' });
    const ev = this.expectEvent(tx, TaxesAbi, 'RewardsFeeSet', this.address, 'Taxes', ['rewardsFee']);
    return { ...tx, rewardsFee: ev ? Number(ev.bps) : null };
  }

  private async checkCooldown(token: Address, kind: 'creator' | 'rewards'): Promise<void> {
    const c = await this.getFeeCooldowns(token);
    const next = kind === 'creator' ? c.creatorFeeNextChangeAt : c.rewardsFeeNextChangeAt;
    if (!(kind === 'creator' ? c.canChangeCreatorFee : c.canChangeRewardsFee)) {
      throw new ValidationError('fee cooldown', `The ${kind} fee was changed recently; it can change again at ${new Date(next * 1000).toISOString()}.`);
    }
  }


  /** Wallets sharing `token`'s creator income (their shares: `getDevBasisPoints`). The unallocated rest goes to its dev. */
  async getDevWallets(token: Address): Promise<Address[]> {
    return [...(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'getDevWallets', args: [toAddress(token, 'token')] }))];
  }

  /** `wallet`'s share of `token`'s creator income, in basis points of 10000. */
  async getDevBasisPoints(token: Address, wallet: Address): Promise<number> {
    token = toAddress(token, 'token');
    wallet = toAddress(wallet, 'wallet');
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devBasisPoints', args: [token, wallet] }));
  }

  /** Total basis points of `token`'s creator income given to share wallets (<= 10000). */
  async getDevTotalAllocated(token: Address): Promise<number> {
    return Number(await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devTotalAllocated', args: [toAddress(token, 'token')] }));
  }

  /**
   * Set `wallet`'s share of `token`'s creator income to `basisPoints` (of 10000; replaces an existing share).
   * Caller: the token's dev. Total shares <= 100%, at most 10 share wallets. Not on mains (paused or not).
   * Refused, in this order, with 'Cannot set for MAINTOKEN', 'Only DEV can add shares', 'Invalid wallet',
   * 'Basis points must be >0', 'Exceeds 100%' or 'Max 10 shares'.
   */
  async addDevShare(token: Address, wallet: Address, basisPoints: number | bigint): Promise<DevShareResult> {
    const me = this.account;
    const bp = toUint(basisPoints, 'basisPoints');
    token = toAddress(token, 'token');
    wallet = toAddress(wallet, 'wallet');
    await this.checkDevShareCaller(token, me, 'Only DEV can add shares');
    if (isZeroAddress(wallet)) throw new ValidationError('Invalid wallet', 'A share wallet address is required.');
    if (bp <= 0n) throw new ValidationError('Basis points must be >0', 'The share must be above 0 basis points.');
    const [oldBp, allocated, wallets] = await Promise.all([
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devBasisPoints', args: [token, wallet] }),
      this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devTotalAllocated', args: [token] }),
      this.getDevWallets(token),
    ]);
    const newTotal = allocated - oldBp + bp;
    if (newTotal > TOTAL_BASIS_POINTS) {
      throw new ValidationError('Exceeds 100%', `Shares would total ${newTotal} of ${TOTAL_BASIS_POINTS} basis points.`);
    }
    if (oldBp === 0n && wallets.length >= MAX_SHARES) {
      throw new ValidationError('Max 10 shares', `A token can have at most ${MAX_SHARES} share wallets.`);
    }
    const tx = await this.send({ address: this.address, abi: TaxesAbi, functionName: 'addDevShare', args: [token, wallet, bp], contract: 'Taxes' });
    const ev = this.expectEvent(tx, TaxesAbi, 'DevShareSet', this.address, 'Taxes', ['basisPoints']);
    return { ...tx, basisPoints: ev ? Number(ev.basisPoints) : null };
  }

  /** Remove `wallet`'s share of `token`'s creator income (it goes back to the dev). Caller: the token's dev. */
  async removeDevShare(token: Address, wallet: Address): Promise<DevShareResult> {
    const me = this.account;
    token = toAddress(token, 'token');
    wallet = toAddress(wallet, 'wallet');
    await this.checkDevShareCaller(token, me, 'Only DEV can remove shares');
    if ((await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devBasisPoints', args: [token, wallet] })) === 0n) {
      throw new ValidationError('no share', `${wallet} has no share of this token's creator income.`);
    }
    const tx = await this.send({ address: this.address, abi: TaxesAbi, functionName: 'removeDevShare', args: [token, wallet], contract: 'Taxes' });
    const ev = this.expectEvent(tx, TaxesAbi, 'DevShareSet', this.address, 'Taxes', ['basisPoints']);
    return { ...tx, basisPoints: ev ? Number(ev.basisPoints) : null };
  }

  /** Refuses a main (paused or not) and any caller that is not the token's dev. */
  private async checkDevShareCaller(token: Address, me: Address, rule: string): Promise<void> {
    if (await this.client.mains.isMain(token)) throw new ValidationError('Cannot set for MAINTOKEN', 'Dev shares cannot be set on a main.');
    const dev = await this.publicClient.readContract({ address: token, abi: EcosystemTokenAbi, functionName: 'DEV' });
    if (dev.toLowerCase() !== me.toLowerCase()) throw new ValidationError(rule, `Only the token's creator (${dev}) can change its dev shares.`);
  }

  /**
   * Running total `dev` has earned from `token` (creator fees, including the creator's part of loan fees), never reset,
   * in the token's pair asset.
   */
  async getCreatorEarnings(token: Address, dev: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    dev = toAddress(dev, 'dev');
    const main = await this.client.mains.mainOf(token);
    const info = await this.client.mains.get(main);
    const raw = await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'tokenDevEarnings', args: [token, dev] });
    return toAmount(raw, info.pairDecimals, 'pairAsset', info.pairAsset, info.pairSymbol);
  }

  /**
   * Everything `token` has paid to its creator side, never reset: share wallets plus the dev, including payouts that
   * could not reach their recipient (the per-recipient `getCreatorEarnings` leaves those out). In the token's pair asset.
   */
  async getTotalCreatorIncome(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const main = await this.client.mains.mainOf(token);
    const info = await this.client.mains.get(main);
    const raw = await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'totalDevTaxCollected', args: [token] });
    return toAmount(raw, info.pairDecimals, 'pairAsset', info.pairAsset, info.pairSymbol);
  }

  /** Running total `dev` has earned across all tokens paid in `pairAsset` (default: the default main's pair asset). */
  async getDevTotalEarnings(dev: Address, pairAsset?: Address): Promise<Amount> {
    dev = toAddress(dev, 'dev');
    const meta = await this.pairAssetMeta(pairAsset);
    const raw = await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'devTotalEarnings', args: [dev, meta.asset] });
    return toAmount(raw, meta.decimals, 'pairAsset', meta.asset, meta.symbol);
  }


  /** The referral registry fees use, read live (the one `client.referrals` talks to). */
  async getReferralsAddress(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'referrals' });
  }

  /**
   * `wallet`'s referrer as fees see it: null when none is set or when it is a protocol wallet.
   * To set one: `client.referrals.setReferrer`.
   */
  async getReferrer(wallet: Address): Promise<Address | null> {
    const r = await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'referrerOf', args: [toAddress(wallet, 'wallet')] });
    return isZeroAddress(r) ? null : r;
  }

  /**
   * The wallet that fees paid through `payer` are credited to: the user behind a protocol contract acting for them
   * (loans, the vault, vesting), else `payer` itself.
   */
  async payerOf(payer: Address): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'payerOf', args: [toAddress(payer, 'payer')] });
  }

  /** What `referrer` has received from referrals (both levels) in `pairAsset` (default: the default main's pair asset). */
  async getReferralEarnings(referrer: Address, pairAsset?: Address): Promise<Amount> {
    referrer = toAddress(referrer, 'referrer');
    const meta = await this.pairAssetMeta(pairAsset);
    const raw = await this.publicClient.readContract({ address: this.address, abi: TaxesAbi, functionName: 'referralEarnings', args: [referrer, meta.asset] });
    return toAmount(raw, meta.decimals, 'pairAsset', meta.asset, meta.symbol);
  }


  /** Decimals and symbol of a pair asset; the default main's pair asset when omitted. */
  private async pairAssetMeta(pairAsset?: Address): Promise<{ asset: Address; decimals: number; symbol: string }> {
    if (pairAsset == null) {
      const m = await this.client.mains.default();
      return { asset: m.pairAsset, decimals: m.pairDecimals, symbol: m.pairSymbol };
    }
    const asset = toAddress(pairAsset, 'pairAsset');
    const { decimals, symbol } = await this.client.mains.tokenMeta(asset);
    return { asset, decimals, symbol };
  }
}
