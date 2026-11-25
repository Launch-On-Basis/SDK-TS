import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { ReferralsAbi, TaxesAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, TxResult } from '../core/BaseModule';
import { NotDeployedError, ValidationError } from '../core/errors';
import { retryPinned } from '../core/pinned';
import { errorText } from '../core/redact';
import { toAddress } from '../core/units';

/** `setReferrer` result: the referrer recorded, read from the tx's log (null with a warning when it is missing). */
export interface SetReferrerResult extends TxResult {
  referrer: Address | null;
}

/**
 * The referral registry: a wallet names its referrer once, here. What it earns and pays is `client.taxes`:
 * `taxes.getReferrer` (what fees count; a protocol wallet counts as none) and `taxes.getReferralEarnings`. A
 * registry can have a `previous` one, and a referrer set there leads.
 */
export class ReferralsModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** Whether the registry can be found on this chain (the `taxes` or the `referrals` address is set). */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.taxes) || !isZeroAddress(this.client.addresses.referrals);
  }

  /**
   * The registry: the one fees use, read live (`taxes.getReferralsAddress()`; fees only count referrers set there),
   * else, while `taxes` has no address on this chain, the address book's `referrals`. NotDeployedError when neither
   * is there.
   */
  async getAddress(): Promise<Address> {
    if (!isZeroAddress(this.client.addresses.taxes)) return this.client.taxes.getReferralsAddress();
    const book = this.client.addresses.referrals;
    if (isZeroAddress(book)) throw new NotDeployedError('Referrals', this.client.chainId);
    return book;
  }

  /** `wallet`'s entry in the registry (a previous registry's entry leads), or null. Fees use `taxes.getReferrer`. */
  async getReferrer(wallet: Address): Promise<Address | null> {
    wallet = toAddress(wallet, 'wallet');
    return this.referrerAt(await this.getAddress(), wallet);
  }

  /** Wallets that named `referrer` in this registry (direct, level 1). */
  async getReferralCount(referrer: Address): Promise<number> {
    referrer = toAddress(referrer, 'referrer');
    return Number(await this.publicClient.readContract({ address: await this.getAddress(), abi: ReferralsAbi, functionName: 'referralCount', args: [referrer] }));
  }

  /** True while nobody can set a referrer here (what is set stays). */
  async isClosed(): Promise<boolean> {
    return this.publicClient.readContract({ address: await this.getAddress(), abi: ReferralsAbi, functionName: 'closed' });
  }

  /** The registry before this one, or null for the first. */
  async getPrevious(): Promise<Address | null> {
    const p = await this.publicClient.readContract({ address: await this.getAddress(), abi: ReferralsAbi, functionName: 'previous' });
    return isZeroAddress(p) ? null : p;
  }

  /**
   * Name the signer's referrer. **Permanent: it can be set once and the wallet cannot change it.** The signer then pays
   * a lower base fee, and the referrer earns part of the signer's base fees (and a smaller part one level further down).
   * A wallet with a referrer in the previous registry locks that one in here instead of `referrer` (result `referrer`
   * and a warning say so). Refused, in this order, with 'closed'; 'referrer set' (the wallet already has one);
   * 'invalid referrer' (zero, or the signer itself); 'referral loop' (the referrer was referred by the signer).
   *
   * After the tx, the SDK reads whether fees count the new referrer (`taxes.getReferrer`, at the tx's block): a
   * protocol wallet can be named in the registry, but fees count it as no referrer (no discount, no earnings), and a
   * warning then says so. The tx is confirmed either way: never resend it (a failed read is a warning too).
   */
  async setReferrer(referrer: Address): Promise<SetReferrerResult> {
    const me = this.account;
    referrer = toAddress(referrer, 'referrer');
    const address = await this.getAddress();
    const [closed, previous, current] = await Promise.all([
      this.publicClient.readContract({ address, abi: ReferralsAbi, functionName: 'closed' }),
      this.publicClient.readContract({ address, abi: ReferralsAbi, functionName: 'previous' }),
      this.referrerAt(address, me),
    ]);
    if (closed) throw new ValidationError('closed', 'The referral registry is closed: no new referrer can be set.');
    const old = isZeroAddress(previous) ? null : await this.referrerAt(previous, me);
    if (!old && current) throw new ValidationError('referrer set', `This wallet already has a referrer (${current}); it cannot change it.`);
    if (!old) {
      if (isZeroAddress(referrer)) throw new ValidationError('invalid referrer', 'A referrer address is required.');
      if (referrer.toLowerCase() === me.toLowerCase()) throw new ValidationError('invalid referrer', 'A wallet cannot refer itself.');
    }
    const target = old ?? referrer;
    const above = await this.referrerAt(address, target);
    if (above && above.toLowerCase() === me.toLowerCase()) {
      throw new ValidationError('referral loop', `${target} was referred by this wallet.`);
    }
    const tx = await this.send({ address, abi: ReferralsAbi, functionName: 'setReferrer', args: [referrer], contract: 'Referrals' });
    const ev = this.expectEvent(tx, ReferralsAbi, 'ReferrerSet', address, 'Referrals', ['referrer']);
    if (ev?.referrer && ev.referrer.toLowerCase() !== referrer.toLowerCase()) {
      tx.warnings.push(`The previous registry's referrer ${ev.referrer} was locked in instead of ${referrer}.`);
    }
    await this.warnIfFeesIgnore(tx, me, ev?.referrer ?? referrer);
    return { ...tx, referrer: ev?.referrer ?? null };
  }

  /**
   * After a confirmed `setReferrer`: when fees count the signer's new referrer as none (a protocol wallet), a warning
   * says the discount and the earnings are lost. Read at the tx's block (a node a few blocks behind is retried), never
   * throws: a failed read is a warning too. Skipped while `taxes` has no address on this chain.
   */
  private async warnIfFeesIgnore(tx: TxResult, me: Address, named: Address): Promise<void> {
    const taxes = this.client.addresses.taxes;
    if (isZeroAddress(taxes)) return;
    try {
      const blockNumber = tx.receipt.blockNumber;
      const counted = await retryPinned(() => this.publicClient.readContract({
        address: taxes, abi: TaxesAbi, functionName: 'referrerOf', args: [me], blockNumber,
      }));
      if (isZeroAddress(counted)) {
        tx.warnings.push(
          `Fees count ${named} as no referrer (it is a protocol wallet): this wallet gets no fee discount and ${named} earns `
          + 'nothing from its fees. The referrer is set for good and cannot be changed.',
        );
      }
    } catch (e) {
      tx.warnings.push(`The referrer is set, but whether fees count it could not be read (${errorText(e)}): check with taxes.getReferrer.`);
    }
  }

  private async referrerAt(address: Address, wallet: Address): Promise<Address | null> {
    const r = await this.publicClient.readContract({ address, abi: ReferralsAbi, functionName: 'referrerOf', args: [wallet] });
    return isZeroAddress(r) ? null : r;
  }
}
