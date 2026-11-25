import type { Address, Hash } from 'viem';
import type { BasisClient } from '../BasisClient';
import { MainTokenAbi, SwapAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import type { MainRef } from '../core/mains';
import { optionKeys, optsOf } from '../core/opts';
import { optUint, toAddress, toBool, toUint } from '../core/units';
import { type CoreLoan, getPartialLoanSellAmounts, isAssetPaused, type PartialLoanSellAmounts, readCoreLoan } from '../core/loans';

/** Options of `getExpiredClaim`. */
export interface GetExpiredClaimOptions {
  /** First block to scan (default the last `EXPIRED_CLAIM_SCAN_BLOCKS` blocks). */
  fromBlock?: bigint | number | null;
}
const GET_EXPIRED_CLAIM_KEYS = optionKeys<GetExpiredClaimOptions>({ fromBlock: true });

/** How long you have to claim what is left of a liquidated position, in seconds. After that it can be taken. */
export const CLAIM_PERIOD_SECONDS = 365n * 86_400n;

/** `getExpiredClaim` scans this many blocks back from the latest one unless `fromBlock` says otherwise (about 2.8 hours at 10 blocks a second). */
export const EXPIRED_CLAIM_SCAN_BLOCKS = 100_000n;

/** What is left for the owner after a loan or leverage position was liquidated. */
export interface LiquidationClaimStatus {
  isLiquidated: boolean;
  /** Collateral still claimable, raw collateral units (0 once claimed, or once taken after the deadline). */
  claimable: bigint;
  /** Unix seconds of the liquidation; 0 when not liquidated. */
  liquidatedAt: bigint;
  /** Claim before this, unix seconds (`liquidatedAt + 365 days`); 0 when not liquidated. */
  claimDeadline: bigint;
  /** The deadline passed with something still unclaimed: it can be taken at any time now. */
  claimExpired: boolean;
}

/** A leftover that went unclaimed past its deadline and was taken. */
export interface ExpiredClaim {
  amount: bigint;
  txHash: Hash;
  blockNumber: bigint;
}

/** What `getExpiredClaim` found. */
export interface ExpiredClaimLookup {
  /**
   * 'taken': the leftover went unclaimed past its deadline and is gone (`claim`). 'notTaken': it was not, for sure: that
   * can't have happened on this loan, or the scan reached block 0. 'notInWindow': nothing in the blocks scanned, which does
   * NOT mean nothing happened: the owner claimed it, or it was taken before `fromBlock`. Widen `fromBlock` to look further back.
   */
  status: 'taken' | 'notTaken' | 'notInWindow';
  claim: ExpiredClaim | null;
  /** The blocks scanned; null when it can't have happened and no logs were read. */
  fromBlock: bigint | null;
  toBlock: bigint | null;
}

/** Why a main can't see liquidations right now. */
export type LiquidationBlock = 'no liquidator' | 'pair not active' | 'pair asset paused';

/**
 * Liquidation views. All reads.
 *
 * A loan or leverage position can be liquidated once its deadline has passed. Nothing on a main is liquidated while its
 * pair is paused, or while the issuer of its pair asset has paused that token (USDG and tokenized stocks can be paused).
 * While the pair is paused you can still repay and claim, but not extend. While the issuer has paused the pair asset you
 * can neither repay nor extend. A loan whose deadline passed meanwhile can still be repaid or extended once the pair
 * reopens. A `client.loans` loan is addressed with `user` = the loan hub (`client.addresses.loanHub`) and `loanId` = its
 * id on the main (`loans.getLoanRef(...).coreLoanId`; `loans.coreLoanOwner(main, coreId)` maps back to the wallet). A
 * vault position's loan maps back to the vault.
 *
 * After a liquidation, part of the collateral left over is kept as a liquidation fee and the rest is yours. You have a
 * year to claim it: a leftover still unclaimed 365 days after the liquidation can be taken, after which the claim answers
 * "Nothing to claim".
 * - **hub loan**: `loans.claimLiquidation(hubId)`;
 * - **leverage position**: `trading.claimLeverageLiquidation(main, loanId)`;
 * - **vault position**: settled inside the liquidation, back into your stake; nothing to call;
 * - **vesting loan**: settled by `vesting.repayLoanOnVesting`.
 */
export class LiquidationModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when liquidations are set up on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.liquidator);
  }

  /**
   * True when loan (or, with `isLeverage`, leverage position) `loanId` of `user` on `main` can be liquidated now: it is
   * open, past its deadline by chain time, and nothing blocks liquidations on the main (`getLiquidationBlock`).
   */
  async isLiquidatable(main: MainRef, user: Address, loanId: bigint, isLeverage: boolean): Promise<boolean> {
    const loan = await this.getLoan(main, user, loanId, isLeverage);
    if (!loan.active) return false;
    const now = (await this.publicClient.getBlock()).timestamp;
    if (loan.liquidationTime >= now) return false;
    return (await this.getLiquidationBlock(main)) === null;
  }

  /**
   * Why nothing on `main` can be liquidated right now, or null when it can: 'no liquidator' (liquidations are not set up
   * for this main), 'pair not active' (the pair is paused) or 'pair asset paused' (the asset's issuer paused it; a token
   * without `paused()`, or one answering anything but true, counts as live).
   */
  async getLiquidationBlock(main: MainRef): Promise<LiquidationBlock | null> {
    const info = await this.client.mains.get(main);
    const swap = this.require(this.client.addresses.swap, 'Swap');
    const [liquidator, active, paused] = await Promise.all([
      this.liquidatorOf(info.main),
      this.publicClient.readContract({ address: swap, abi: SwapAbi, functionName: 'isMain', args: [info.main] }),
      isAssetPaused(this.client, info.pairAsset),
    ]);
    if (isZeroAddress(liquidator)) return 'no liquidator';
    if (!active) return 'pair not active';
    return paused ? 'pair asset paused' : null;
  }

  /** Loan (or, with `isLeverage`, leverage position) `loanId` of `user` on `main` (a `client.loans` loan: see the class note). */
  async getLoan(main: MainRef, user: Address, loanId: bigint, isLeverage: boolean): Promise<CoreLoan> {
    return readCoreLoan(
      this.client, this.client.mains.addressOf(main), toAddress(user, 'user'), toUint(loanId, 'loanId'), toBool(isLeverage, 'isLeverage'),
    );
  }

  /**
   * The owner's liquidation leftover of loan or leverage position `loanId` of `user` on `main` (a `client.loans` loan:
   * see the class note): what is claimable, when it was liquidated, the claim deadline and whether it passed.
   */
  async getClaimStatus(main: MainRef, user: Address, loanId: bigint, isLeverage: boolean): Promise<LiquidationClaimStatus> {
    const [loan, blk] = await Promise.all([this.getLoan(main, user, loanId, isLeverage), this.publicClient.getBlock()]);
    const liquidatedAt = loan.isLiquidated ? loan.timeOfClosure : 0n;
    const claimDeadline = loan.isLiquidated ? loan.timeOfClosure + CLAIM_PERIOD_SECONDS : 0n;
    return {
      isLiquidated: loan.isLiquidated, claimable: loan.liquidationClaim, liquidatedAt, claimDeadline,
      claimExpired: loan.isLiquidated && loan.liquidationClaim > 0n && blk.timestamp > claimDeadline,
    };
  }

  /** True when the leftover of loan or leverage position `loanId` of `user` on `main` is past its claim deadline (see `getClaimStatus`). */
  async isClaimExpired(main: MainRef, user: Address, loanId: bigint, isLeverage: boolean): Promise<boolean> {
    return (await this.getClaimStatus(main, user, loanId, isLeverage)).claimExpired;
  }

  /**
   * Looks for a leftover of loan or leverage position `loanId` of `user` on `main` that went unclaimed past its deadline
   * and was taken.
   * Reads the loan first and answers 'notTaken' without a log scan when that can't have happened (not liquidated, still
   * claimable, or not yet 365 days since the liquidation). Otherwise it scans the last `EXPIRED_CLAIM_SCAN_BLOCKS` blocks,
   * or from `opts.fromBlock` to widen that (a whole-chain scan at 10 blocks a second is more than an RPC will serve).
   * Finding nothing there is 'notInWindow', not proof: only a scan from block 0 answers 'notTaken'. null (for `opts` or
   * `fromBlock`) is the same as leaving it out; `opts` must be an options object (rule `options`: `getExpiredClaim(main,
   * user, id, false, 5_000_000n)` is refused, pass `{ fromBlock: 5_000_000n }`).
   */
  async getExpiredClaim(
    main: MainRef, user: Address, loanId: bigint, isLeverage: boolean, opts: GetExpiredClaimOptions | null = {},
  ): Promise<ExpiredClaimLookup> {
    const o = optsOf(opts, GET_EXPIRED_CLAIM_KEYS);
    const id = toUint(loanId, 'loanId');
    isLeverage = toBool(isLeverage, 'isLeverage');
    const explicit = optUint(o.fromBlock, 'fromBlock');
    user = toAddress(user, 'user');
    const [loan, blk] = await Promise.all([this.getLoan(main, user, id, isLeverage), this.publicClient.getBlock()]);
    if (!loan.isLiquidated || loan.liquidationClaim > 0n || blk.timestamp <= loan.timeOfClosure + CLAIM_PERIOD_SECONDS) {
      return { status: 'notTaken', claim: null, fromBlock: null, toBlock: null };
    }
    const toBlock = blk.number;
    const fromBlock = explicit ?? (toBlock >= EXPIRED_CLAIM_SCAN_BLOCKS ? toBlock - EXPIRED_CLAIM_SCAN_BLOCKS + 1n : 0n);
    if (fromBlock > toBlock) throw new ValidationError('fromBlock', `fromBlock ${fromBlock} is after the latest block ${toBlock}.`);
    const logs = await this.publicClient.getContractEvents({
      address: this.client.mains.addressOf(main), abi: MainTokenAbi, eventName: 'ClaimSeized',
      args: { user, loanId: id }, fromBlock, toBlock,
    });
    const log = logs.find((l) => l.args.isLeverage === isLeverage);
    if (log) {
      const claim = { amount: log.args.amount ?? 0n, txHash: log.transactionHash, blockNumber: log.blockNumber };
      return { status: 'taken', claim, fromBlock, toBlock };
    }
    return { status: fromBlock === 0n ? 'notTaken' : 'notInWindow', claim: null, fromBlock, toBlock };
  }

  /**
   * What a partial sell of `percentage` (1-100, an integer number or a bigint, as PY takes any int; sells themselves
   * take steps of 10) of loan or leverage position `loanId` of `user` on `main` would use up and leave to sell. For a
   * `client.loans` loan see the class note.
   */
  async getPartialLoanSellAmounts(
    main: MainRef, loanId: bigint, user: Address, percentage: number | bigint, isLeverage: boolean,
  ): Promise<PartialLoanSellAmounts> {
    const pct = typeof percentage === 'bigint' ? percentage
      : typeof percentage === 'number' && Number.isInteger(percentage) ? BigInt(percentage) : null;
    if (pct === null || pct < 1n || pct > 100n) {
      throw new ValidationError('Invalid percentage', `percentage must be 1-100, got ${String(percentage)}.`);
    }
    return getPartialLoanSellAmounts(
      this.client, this.client.mains.addressOf(main), toUint(loanId, 'loanId'), toAddress(user, 'user'), Number(pct), toBool(isLeverage, 'isLeverage'),
    );
  }

  /** The main's liquidator; zero until it is set. */
  private async liquidatorOf(main: MainRef): Promise<Address> {
    return this.publicClient.readContract({ address: this.client.mains.addressOf(main), abi: MainTokenAbi, functionName: 'LIQUIDATOR' });
  }
}
