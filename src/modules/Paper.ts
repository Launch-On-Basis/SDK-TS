import { getAddress, type Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { PaperAssetAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, TxResult } from '../core/BaseModule';
import { BasisError, NotDeployedError, ValidationError } from '../core/errors';
import { Amount, toAddress, toAmount } from '../core/units';

/** `claim` result: what was minted, read from the tx's log (null with a warning when it is missing). */
export interface PaperClaimResult extends TxResult {
  amount: Amount | null;
}

/**
 * The paper site's play tokens (tUSDG, tNVDA, tETH; the pair assets of STASIS, tNVDA+ and tETH+). Every wallet claims
 * a fixed amount of each, once (`getClaimAmount`); the tokens have no value. Works on the `robinhoodPaper` preset (and
 * a custom paper config): on the real site every call throws `ValidationError('paper only')` before any
 * RPC call.
 *
 * `token` everywhere: a paper token's address, or a main key (its pair asset); default: the default main's pair asset.
 */
export class PaperModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True on a paper deployment (`chainConfig.paper`). */
  get available(): boolean {
    return this.client.chainConfig.paper === true;
  }

  /**
   * Mints one claim of the token (`getClaimAmount`) to the signer, once per wallet: refused with 'already claimed'
   * after that. Adds `amount`, read from the tx's log (null with a warning when it is missing).
   */
  async claim(token?: Address | string): Promise<PaperClaimResult> {
    const t = this.tokenOf(token);
    const me = this.account;
    const [claimed, meta] = await Promise.all([this.claimedBy(t, me), this.client.mains.tokenMeta(t)]);
    if (claimed) throw new ValidationError('already claimed', `This wallet already claimed ${meta.symbol}: one claim per wallet.`);
    const tx = await this.send({ address: t, abi: PaperAssetAbi, functionName: 'claim', args: [], contract: 'PaperAsset' });
    const ev = this.expectEvent(tx, PaperAssetAbi, 'Claimed', t, 'PaperAsset', ['amount']);
    return { ...tx, amount: ev ? toAmount(ev.amount, meta.decimals, 'token', t, meta.symbol) : null };
  }

  /** True once `wallet` (default: the signer) has claimed `token`. */
  async hasClaimed(token?: Address | string, wallet?: Address): Promise<boolean> {
    const t = this.tokenOf(token);
    return this.claimedBy(t, wallet == null ? this.account : toAddress(wallet, 'wallet'));
  }

  /** What one claim of `token` mints. */
  async getClaimAmount(token?: Address | string): Promise<Amount> {
    const t = this.tokenOf(token);
    const [raw, meta] = await Promise.all([
      this.publicClient.readContract({ address: t, abi: PaperAssetAbi, functionName: 'claimAmount' }),
      this.client.mains.tokenMeta(t),
    ]);
    return toAmount(raw, meta.decimals, 'token', t, meta.symbol);
  }

  private claimedBy(token: Address, wallet: Address): Promise<boolean> {
    return this.publicClient.readContract({ address: token, abi: PaperAssetAbi, functionName: 'hasClaimed', args: [wallet] });
  }

  /** The token of a call, from the address book, without RPC calls. The paper guard of every method. */
  private tokenOf(token?: Address | string): Address {
    if (!this.available) {
      throw new ValidationError('paper only', `Paper tokens exist on the paper deployment only, not on ${this.client.chainConfig.key}.`);
    }
    if (typeof token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(token)) return toAddress(token, 'token');
    const book = this.client.addresses;
    const key = token ?? book.defaultMain;
    const entry = book.mains.find((m) => m.key === key);
    if (!entry) throw new BasisError(`[basis-sdk] Unknown main "${String(key)}". Known keys: ${book.mains.map((m) => m.key).join(', ') || '(none)'}`);
    if (isZeroAddress(entry.pairAsset)) throw new NotDeployedError('PaperAsset', this.client.chainId);
    return getAddress(entry.pairAsset);
  }
}
