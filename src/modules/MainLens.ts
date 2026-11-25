import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { MainLensAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule } from '../core/BaseModule';
import { getPartialLoanSellAmounts, type PartialLoanSellAmounts } from '../core/loans';
import type { MainRef } from '../core/mains';
import { decodeRevert } from '../core/revert';
import { toAddress, toBool, toUint } from '../core/units';

/**
 * `client.mainLens`: read-only quotes for the mains (every method takes the main first).
 * Amounts raw (main tokens 18 dec, pair asset in its own decimals). Reverts are decoded.
 */
export class MainLensModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the main lens is deployed on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.mainLens);
  }

  get address(): Address {
    return this.require(this.client.addresses.mainLens, 'MainLens');
  }

  /** Pair asset in (raw) to buy `tokenAmountOut` main tokens on `main`, before fees. 0 for 0. */
  async calculateMainPairForTokens(main: MainRef, tokenAmountOut: bigint): Promise<bigint> {
    const args = [this.client.mains.addressOf(main), toUint(tokenAmountOut, 'tokenAmountOut')] as const;
    return this.decoded('calculateMainPairForTokens', () =>
      this.publicClient.readContract({ address: this.address, abi: MainLensAbi, functionName: 'calculateMainPairForTokens', args }));
  }

  /** Main tokens in (raw) to sell for `pairAmountOut` raw pair asset on `main`, before fees. 0 for 0. */
  async calculateTokensForMainPair(main: MainRef, pairAmountOut: bigint): Promise<bigint> {
    const args = [this.client.mains.addressOf(main), toUint(pairAmountOut, 'pairAmountOut')] as const;
    return this.decoded('calculateTokensForMainPair', () =>
      this.publicClient.readContract({ address: this.address, abi: MainLensAbi, functionName: 'calculateTokensForMainPair', args }));
  }

  /**
   * How many leverage positions `user` ever opened on `token` on `main` (open and closed; at most one is open at a
   * time: `trading.getOpenLeverage`).
   */
  async getLeverageCountForUserAndToken(main: MainRef, user: Address, token: Address): Promise<bigint> {
    const args = [this.client.mains.addressOf(main), toAddress(user, 'user'), toAddress(token, 'token')] as const;
    return this.decoded('getLeverageCountForUserAndToken', () =>
      this.publicClient.readContract({ address: this.address, abi: MainLensAbi, functionName: 'getLeverageCountForUserAndToken', args }));
  }

  /**
   * What a partial sell of `percentage` (1-100) % of leverage position (or, with `isLeverage` false, loan) `loanId` of
   * `user` on `main` would use up and leave to sell (raw collateral-token units). A loan that is not open (repaid, sold
   * or never opened) throws `ValidationError('Loan not active')`. Reverts "Invalid percentage" / "Already liquidated" /
   * "cannot sell off with no profit" come back as `BasisContractError`.
   */
  async getPartialLoanSellAmounts(
    main: MainRef, loanId: bigint, user: Address, percentage: number | bigint, isLeverage = true,
  ): Promise<PartialLoanSellAmounts> {
    const mainAddr = this.client.mains.addressOf(main);
    const id = toUint(loanId, 'loanId');
    const pct = toUint(percentage, 'percentage');
    const lev = toBool(isLeverage, 'isLeverage');
    return getPartialLoanSellAmounts(this.client, mainAddr, id, toAddress(user, 'user'), pct, lev);
  }

  private async decoded<T>(functionName: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      throw decodeRevert(e, { contract: 'MainLens', functionName, abi: MainLensAbi });
    }
  }
}
