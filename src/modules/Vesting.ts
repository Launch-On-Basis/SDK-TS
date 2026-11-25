import type { Address, ContractFunctionReturnType } from 'viem';
import type { BasisClient } from '../BasisClient';
import { FactoryAbi, LoanHubAbi, MainTokenAbi, VestingAbi } from '../abis';
import { ADDRESS_KEYS, isZeroAddress, OPTIONAL_ADDRESS_KEYS } from '../config/addresses';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { BasisError, ValidationError } from '../core/errors';
import { addMissingEventWarning } from '../core/events';
import { isAssetPaused, isPairActive, pairAssetPaused, pairNotActive, refusePausedAsset } from '../core/loans';
import { type AmountOf, amountOf, optAmount, pairAmountOf } from '../core/amounts';
import type { MainRef } from '../core/mains';
import { multicall, type MulticallRead } from '../core/multicall';
import { optionKeys, optsOf } from '../core/opts';
import { pinnedClient } from '../core/pinned';
import type { HubLoanDetails } from './Loans';
import { type Amount, checkText, parseAmount, toAddress, toBool, toUint } from '../core/units';

/** Release step of a gradual vesting (`TimeUnit` enum). The duration itself is always whole days. */
export const VestingTimeUnit = { Second: 0, Minute: 1, Hour: 2, Day: 3 } as const;
export type VestingTimeUnitValue = (typeof VestingTimeUnit)[keyof typeof VestingTimeUnit];
/** A time unit as its enum value (0-3) or its name. */
export type VestingTimeUnitInput = VestingTimeUnitValue | 'second' | 'minute' | 'hour' | 'day';

/** A token amount: raw `bigint` in the vested token's units, or a human string/number scaled by its decimals. */
export type TokenAmountInput = bigint | string | number;

/** A vesting schedule (14 fields). Token amounts are raw, in the vested token's decimals (18 for BASIS tokens). */
export interface VestingDetails {
  id: bigint;
  creator: Address;
  beneficiary: Address;
  token: Address;
  /** The main (ecosystem) the vesting was created under. */
  ecosystem: Address;
  totalAmount: bigint;
  claimedAmount: bigint;
  /** Unix seconds. */
  startTime: bigint;
  /** Gradual only (0 for cliff). Whole days. */
  durationInDays: bigint;
  /** Cliff only (0 for gradual). Unix seconds. */
  unlockTime: bigint;
  isGradual: boolean;
  /** Loan id on `getLoanHubOf(id)`; 0 = no loan linked. */
  activeLoanId: bigint;
  memo: string;
  timeUnit: VestingTimeUnitValue;
  /**
   * The creator gave up its own rights on the schedule: `changeBeneficiary` (its `repayLoan` path included), extending,
   * and repaying or settling the schedule's loan (`repayLoanOnVesting`). A creator that is also the beneficiary keeps
   * what the beneficiary may do.
   */
  renounced: boolean;
}

/** How vesting records a main. */
export interface VestingEcosystem {
  maintoken: Address;
  factory: Address;
  /** The main's pair asset: what vesting loans pay out and are repaid in. */
  mainpair: Address;
  /** Creates on this main are accepted. */
  registered: boolean;
}

/** The loan linked to a vesting, on the hub it was taken on. */
export interface VestingLoan {
  hub: Address;
  loanId: bigint;
  details: HubLoanDetails;
  /** The pair asset the loan is repaid in. */
  repayToken: Address;
}

/** Which of a wallet's vestings `getVestingsOf` lists. */
export type VestingRole = 'beneficiary' | 'creator' | 'any';

/** Options of `getVestingsOf`; null in any field is the same as leaving it out. */
export interface GetVestingsOfOptions {
  /** 'beneficiary', 'creator' or 'any' (both lists, default). */
  role?: VestingRole | null;
  /** true: only schedules with tokens left (`remaining > 0`); false: only finished ones; omitted: all. */
  active?: boolean | null;
  /** Read the linked loan of each schedule (default true). */
  includeLoan?: boolean | null;
}
const GET_VESTINGS_OF_KEYS = optionKeys<GetVestingsOfOptions>({ role: true, active: true, includeLoan: true });

/** One row of `getVestingsOf`: the schedule plus its live amounts (raw, vested-token units). */
export interface WalletVesting extends VestingDetails {
  isBeneficiary: boolean;
  isCreator: boolean;
  /** Claimable now, as `getClaimableAmount` (0 while a loan is linked). */
  claimable: bigint;
  /** Vested so far, as `getEffectiveVestedAmount`. */
  vested: bigint;
  /** What the schedule holds, as `getEffectiveTotalAmount`: below `totalAmount` after a liquidation not yet settled. */
  effectiveTotal: bigint;
  /** `effectiveTotal - claimedAmount` (floored at 0). */
  remaining: bigint;
  /** Unix seconds: start + duration (gradual) or the unlock time (cliff). */
  endTime: bigint;
  /** The linked loan, or null when none is linked (or `includeLoan: false`). */
  loan: VestingLoan | null;
}

/**
 * Write results carry the figures of the transaction's events; null when the event is missing (see `warnings`).
 * Money figures are `Amount`s: tokens in the vested token, loan payouts in the vesting main's pair asset.
 */
export interface CreateVestingResult extends TxResult {
  vestingId: bigint | null;
}

export interface BatchCreateVestingResult extends TxResult {
  /** In beneficiary order. */
  vestingIds: bigint[] | null;
}

export interface VestingLoanResult extends TxResult {
  /** Loan id (on `hub`). */
  loanId: bigint | null;
  hub: Address | null;
  /** Collateral pledged, in the vested token (unit `token`, or `main` for a vested main). */
  tokenAmount: Amount | null;
  loanDurationDays: bigint | null;
  /** Paid to the beneficiary, in the vesting main's pair asset. */
  borrowed: Amount | null;
}

export interface RepayExtendReborrowResult extends VestingLoanResult {
  /** The loan repaid; `loanId` is the new one. */
  repaidLoanId: bigint | null;
  /** Days the schedule was extended by. */
  daysAdded: bigint | null;
}

export interface RepayVestingLoanResult extends TxResult {
  /** True when the loan had been liquidated and this call only put what was left back on the schedule; false for a repay. */
  liquidated: boolean | null;
  /** Liquidated only: tokens recovered into the schedule, in the vested token; 0 for a repay. */
  recovered: Amount | null;
  /** The loan id that was settled. */
  loanId: bigint | null;
}

export interface ClaimVestingResult extends TxResult {
  /** Tokens paid out, in the vested token. */
  claimed: Amount | null;
}

export interface RenounceVestingResult extends TxResult {
  /** True once the transaction's events confirm the renounce. */
  renounced: boolean | null;
}

export interface ChangeBeneficiaryOptions {
  /**
   * Settle a linked loan in the same transaction instead of being refused (default false). A live loan is repaid in
   * full from the creator's wallet (the pair asset is approved for the debt; the beneficiary keeps what it borrowed);
   * a liquidated one is settled and what the liquidation left goes back on the schedule. No effect without a loan.
   * null = not given.
   */
  repayLoan?: boolean | null;
}
const CHANGE_BENEFICIARY_KEYS = optionKeys<ChangeBeneficiaryOptions>({ repayLoan: true });

export interface ChangeBeneficiaryResult extends TxResult {
  /** The old and the new beneficiary. */
  previousBeneficiary: Address | null;
  beneficiary: Address | null;
  /**
   * With `repayLoan` and a linked loan, what happened to it, as `repayLoanOnVesting` reports it: `liquidated`,
   * `recovered` (in the vested token, 0 for a repay) and the settled `loanId`. All null when no loan was linked.
   */
  liquidated: boolean | null;
  recovered: Amount | null;
  loanId: bigint | null;
}

export interface TransferCreatorRoleResult extends TxResult {
  /** The old and the new creator. */
  previousCreator: Address | null;
  creator: Address | null;
}

export interface AddTokensToVestingResult extends TxResult {
  /** The schedule's total after the top-up, in the vested token. */
  newTotalAmount: Amount | null;
}

export interface ExtendVestingResult extends TxResult {
  /** Days added. */
  daysAdded: bigint | null;
}

/**
 * Preview of `takeLoanOnVesting(id)`, as it would be sized now: the unclaimed tokens pledged for the whole days left to
 * the vesting's end plus the loan buffer (`getLoanBuffer`). Raw units: tokens in the vested token, values in the main's
 * pair asset.
 */
export interface VestingLoanQuote {
  vestingId: bigint;
  /** The loan hub the loan opens on (`getLoanHub`). */
  hub: Address;
  /** The vesting's main (`ecosystem`). */
  main: Address;
  token: Address;
  /** The unclaimed tokens pledged: `totalAmount - claimedAmount`. */
  tokenAmount: bigint;
  loanDurationDays: bigint;
  /** Value of the pledged tokens; this is the debt (`fullAmount`). */
  collateralValue: bigint;
  /** The loan fee. */
  fee: bigint;
  /** Paid to the beneficiary: the collateral value minus the fee (0 when the fee takes it all). */
  borrowed: bigint;
  /** The collateral value meets the main's minimum loan size. */
  meetsMinimum: boolean;
  /**
   * The rule the loan would be refused with, in the order checked ("Active loan exists", "No unclaimed tokens",
   * "pair not active" (the main's pair is paused), "Ecosystem inactive", "Unauthorized caller", "incorrect loan
   * duration", "Minimum loan amount not met", "pair asset paused" (its issuer paused the pair asset), "No stable
   * received"), or null.
   */
  refusal: string | null;
}

/**
 * Preview of `repayExtendAndReborrow(id, additionalDays)`: the new loan on the extended schedule (the `VestingLoanQuote`
 * figures, sized as it would be now), against the debt of the linked loan it repays first.
 * Raw units as in `VestingLoanQuote`.
 */
export interface VestingReborrowQuote extends VestingLoanQuote {
  additionalDays: bigint;
  /** The linked loan repaid first (its id on `getLoanHubOf(id)`; 0 when none is linked). */
  repaidLoanId: bigint;
  /** Its debt (`fullAmount`, raw pair asset): what the beneficiary pays in (0 unless the linked loan is live). */
  repayAmount: bigint;
  /** `borrowed - repayAmount`, raw pair asset: negative when the beneficiary pays in more than the new loan pays out. */
  net: bigint;
  /**
   * The rule `repayExtendAndReborrow` would refuse it with, in its order, or null: "No active loan", "Loan not active",
   * the extension rules, the loan rules on the extended schedule, then "insufficient balance".
   */
  refusal: string | null;
}

const DAY = 86_400n;
/** The longest memo a vesting stores, in UTF-8 bytes ("Memo too long"). */
const MAX_MEMO_BYTES = 256;
/** Ids per `getVestingDetailsBatch` call in `getVestingsOf`. */
const DETAILS_PAGE = 100;
/** Schedules per multicall in `getVestingsOf` (3 reads each, then the loan reads; a deployless multicall stays small). */
const READS_PAGE = 50;
/** Ids per multicall when `getVestingsOf` pages a wallet's id list. */
const IDS_PAGE = 500n;
/**
 * One batch create must fit one transaction: at most `BATCH_LIMIT` rows, and the SDK's gas estimate (`BATCH_GAS` plus,
 * per row, `ROW_GAS` and `MEMO_GAS_PER_BYTE` per memo byte; a little high on purpose) at most `TX_GAS_LIMIT`.
 */
const BATCH_LIMIT = 70;
const TX_GAS_LIMIT = 32_000_000;
const BATCH_GAS = 143_000;
const ROW_GAS = 420_000;
const MEMO_GAS_PER_BYTE = 1_000;
/** Time-unit names (a Map: only its own keys match, never `constructor` or `__proto__`). */
const TIME_UNITS: ReadonlyMap<string, number> = new Map([['second', 0], ['minute', 1], ['hour', 2], ['day', 3]]);
/**
 * Address-book keys that are not the protocol's own contracts (an outside token and an outside registry): every other
 * key names a BASIS contract, which can never claim a schedule or act as its creator.
 */
const OUTSIDE_KEYS: ReadonlySet<string> = new Set(['wrappedNative', 'erc8004Registry']);
/** The address-book keys of the protocol's own contracts (`OUTSIDE_KEYS` left out). */
const PROTOCOL_KEYS = [...ADDRESS_KEYS, ...OPTIONAL_ADDRESS_KEYS].filter((k) => !OUTSIDE_KEYS.has(k));

/**
 * Vesting: gradual and cliff vestings of BASIS tokens, loans against them, and the reads. Loans are made by the BASIS
 * protocol. Reads return token amounts raw in the vested token's decimals unless a parameter says otherwise; write
 * results return `Amount`s.
 *
 * Unclaimed vested factory tokens earn holder rewards for the current beneficiary, like tokens it holds (when the token
 * has holder rewards on). A vesting loan pauses that until it is repaid or settled. A vested main earns none.
 */
export class VestingModule extends BaseModule {
  private limits: Promise<{ min: bigint; max: bigint }> | null = null;

  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the vesting contract has an address on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.vesting);
  }

  private get vesting(): Address {
    return this.require(this.client.addresses.vesting, 'Vesting');
  }


  /**
   * Create a gradual vesting. Approves the token, pays the exact creation fee, returns the new id.
   * @param beneficiary a wallet: the zero address ('Invalid beneficiary address') and a BASIS contract or token
   *   ('BASIS contract': any protocol contract or token, including every main with its pair asset and vault, the vested
   *   token, its main and that main's pair asset and vault; none of them could ever claim) are refused before any
   *   approval
   * @param totalAmount raw bigint or a human amount in the token's decimals
   * @param startTime unix seconds (a past time starts now; at most 7 days ahead)
   * @param durationInDays whole days (1..990); the schedule must also end within 990 days of now
   * @param timeUnit release step (0-3 or 'second' | 'minute' | 'hour' | 'day')
   * @param memo at most 256 bytes of UTF-8 ("Memo too long")
   * @param ecosystem the token's main (address or key); default (omitted or null): the token's own main. The token must
   *   be that main itself or a factory token trading against it ("Not an Ecosystem token").
   * @param renounceOnCreation give up the creator's rights at once (default, also for null: false): `changeBeneficiary`, creator
   *   extensions, and repaying or settling the schedule's loan as creator
   */
  async createGradualVesting(
    beneficiary: Address,
    token: Address,
    totalAmount: TokenAmountInput,
    startTime: bigint | number,
    durationInDays: bigint | number,
    timeUnit: VestingTimeUnitInput,
    memo: string,
    ecosystem?: MainRef | null,
    renounceOnCreation: boolean | null = false,
  ): Promise<CreateVestingResult> {
    const vesting = this.vesting;
    void this.account;
    beneficiary = this.toBeneficiary(beneficiary, 'beneficiary');
    token = toAddress(token, 'token');
    this.checkMemo(memo, 'memo');
    const renounce = toBool(renounceOnCreation, 'renounceOnCreation', false);
    const main = await this.checkToken(token, ecosystem);
    const amount = await this.toTokenAmount(token, totalAmount, 'totalAmount');
    const start = toUint(startTime, 'startTime');
    const days = toUint(durationInDays, 'durationInDays');
    const unit = this.toTimeUnit(timeUnit);
    await this.checkGradualSchedule(start, days);
    this.refuseVestedOwn([beneficiary], ['beneficiary'], await this.vestedOwn(token, main));
    const value = await this.prepareCreate(token, amount);

    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'createGradualVesting',
      args: [beneficiary, token, amount, start, days, unit, memo, main, renounce], value, contract: 'Vesting',
    });
    return { ...tx, vestingId: this.createdIds(tx, ['vestingId'])?.[0] ?? null };
  }

  /**
   * Create a cliff vesting: everything unlocks at `unlockTime`. Approves the token, pays the exact fee, returns the new id.
   * @param beneficiary a wallet, as `createGradualVesting` ('BASIS contract' for a protocol contract or token)
   * @param totalAmount raw bigint or a human amount in the token's decimals
   * @param unlockTime unix seconds, 1 hour to 990 days from now
   * @param memo at most 256 bytes of UTF-8 ("Memo too long")
   * @param ecosystem the token's main (address or key); default (omitted or null): the token's own main (as
   *   `createGradualVesting`)
   */
  async createCliffVesting(
    beneficiary: Address,
    token: Address,
    totalAmount: TokenAmountInput,
    unlockTime: bigint | number,
    memo: string,
    ecosystem?: MainRef | null,
    renounceOnCreation: boolean | null = false,
  ): Promise<CreateVestingResult> {
    const vesting = this.vesting;
    void this.account;
    beneficiary = this.toBeneficiary(beneficiary, 'beneficiary');
    token = toAddress(token, 'token');
    this.checkMemo(memo, 'memo');
    const renounce = toBool(renounceOnCreation, 'renounceOnCreation', false);
    const main = await this.checkToken(token, ecosystem);
    const amount = await this.toTokenAmount(token, totalAmount, 'totalAmount');
    const unlock = toUint(unlockTime, 'unlockTime');
    await this.checkCliffUnlock(unlock);
    this.refuseVestedOwn([beneficiary], ['beneficiary'], await this.vestedOwn(token, main));
    const value = await this.prepareCreate(token, amount);
    await this.checkCliffUnlock(unlock);

    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'createCliffVesting',
      args: [beneficiary, token, amount, unlock, memo, main, renounce], value, contract: 'Vesting',
    });
    return { ...tx, vestingId: this.createdIds(tx, ['vestingId'])?.[0] ?? null };
  }

  /**
   * Create one gradual vesting per beneficiary in one transaction (one fee). Approves the sum. Returns the ids in order.
   * One batch must fit one transaction: at most 70 beneficiaries, fewer with long memos (rule `batchSize`, checked
   * before the approval); split a longer list into several batches.
   * @param beneficiaries an array (rule `beneficiaries` for anything else, checked before any read) of wallets, as
   *   `createGradualVesting` ('BASIS contract' names the entry, `beneficiaries[i]`)
   * @param totalAmounts an array, one per beneficiary (raw or human, token decimals; rule `totalAmounts`)
   * @param userMemos an array, one per beneficiary, each at most 256 bytes of UTF-8 (rule `userMemos`)
   */
  async batchCreateGradualVesting(
    beneficiaries: Address[],
    token: Address,
    totalAmounts: TokenAmountInput[],
    userMemos: string[],
    startTime: bigint | number,
    durationInDays: bigint | number,
    timeUnit: VestingTimeUnitInput,
    ecosystem?: MainRef | null,
    renounceOnCreation: boolean | null = false,
  ): Promise<BatchCreateVestingResult> {
    const vesting = this.vesting;
    void this.account;
    const batch = this.checkBatch(beneficiaries, totalAmounts, userMemos);
    token = toAddress(token, 'token');
    const renounce = toBool(renounceOnCreation, 'renounceOnCreation', false);
    const main = await this.checkToken(token, ecosystem);
    const amounts = await Promise.all(batch.totalAmounts.map((a, i) => this.toTokenAmount(token, a as TokenAmountInput, `totalAmounts[${i}]`)));
    const start = toUint(startTime, 'startTime');
    const days = toUint(durationInDays, 'durationInDays');
    const unit = this.toTimeUnit(timeUnit);
    await this.checkGradualSchedule(start, days);
    this.refuseVestedOwn(batch.beneficiaries, batch.fields, await this.vestedOwn(token, main));
    const value = await this.prepareCreate(token, amounts.reduce((s, a) => s + a, 0n));

    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'batchCreateGradualVesting',
      args: [batch.beneficiaries, token, amounts, batch.userMemos, start, days, unit, main, renounce], value, contract: 'Vesting',
    });
    return { ...tx, vestingIds: this.createdIds(tx, ['vestingIds']) };
  }

  /**
   * Create one cliff vesting per beneficiary in one transaction (one fee). Approves the sum. Returns the ids in order.
   * Note the order: `unlockTime` comes before `userMemos`. One batch must fit one transaction, as
   * `batchCreateGradualVesting` (rule `batchSize`); the three lists must be arrays, as there.
   */
  async batchCreateCliffVesting(
    beneficiaries: Address[],
    token: Address,
    totalAmounts: TokenAmountInput[],
    unlockTime: bigint | number,
    userMemos: string[],
    ecosystem?: MainRef | null,
    renounceOnCreation: boolean | null = false,
  ): Promise<BatchCreateVestingResult> {
    const vesting = this.vesting;
    void this.account;
    const batch = this.checkBatch(beneficiaries, totalAmounts, userMemos);
    token = toAddress(token, 'token');
    const renounce = toBool(renounceOnCreation, 'renounceOnCreation', false);
    const main = await this.checkToken(token, ecosystem);
    const amounts = await Promise.all(batch.totalAmounts.map((a, i) => this.toTokenAmount(token, a as TokenAmountInput, `totalAmounts[${i}]`)));
    const unlock = toUint(unlockTime, 'unlockTime');
    await this.checkCliffUnlock(unlock);
    this.refuseVestedOwn(batch.beneficiaries, batch.fields, await this.vestedOwn(token, main));
    const value = await this.prepareCreate(token, amounts.reduce((s, a) => s + a, 0n));
    await this.checkCliffUnlock(unlock);

    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'batchCreateCliffVesting',
      args: [batch.beneficiaries, token, amounts, unlock, batch.userMemos, main, renounce], value, contract: 'Vesting',
    });
    return { ...tx, vestingIds: this.createdIds(tx, ['vestingIds']) };
  }


  /**
   * Give up the creator's rights for good: `changeBeneficiary` (its `repayLoan` path included), creator extensions, and
   * repaying or settling the schedule's loan as creator (`repayLoanOnVesting`). A creator that is also the beneficiary
   * keeps what the beneficiary may do. Creator only. Returns `renounced`.
   */
  async renounceVesting(vestingId: bigint | number): Promise<RenounceVestingResult> {
    const id = toUint(vestingId, 'vestingId');
    const vesting = this.vesting;
    const v = await this.loadExisting(id);
    this.requireCaller(v.creator, 'Only creator can renounce', 'Only the creator can renounce a vesting.');
    if (v.renounced) throw new ValidationError('Already renounced', `Vesting ${id} is already renounced.`);
    const tx = await this.send({ address: vesting, abi: VestingAbi, functionName: 'renounceVesting', args: [id], contract: 'Vesting' });
    return { ...tx, renounced: this.expectEvent(tx, VestingAbi, 'VestingRenounced', vesting, 'Vesting', ['renounced']) ? true : null };
  }

  /**
   * Move the vesting to a new beneficiary. Creator only; not when renounced. A linked loan blocks it unless
   * `opts.repayLoan` is true: then the same transaction repays a live loan in full from the creator's wallet (approving
   * the pair asset for the debt, refused first while its issuer has paused it: 'pair asset paused'; the beneficiary
   * keeps what it borrowed) or settles a liquidated one (no payment; what
   * the liquidation left goes back on the schedule). The new beneficiary must be a wallet: the zero address and a BASIS
   * contract or token (as for a create: 'BASIS contract') are refused before any approval. The current beneficiary
   * again is refused when no loan is linked ('same beneficiary', nothing sent: the tx would change nothing); with
   * `repayLoan` and a linked loan it is allowed (the tx settles the loan). Returns `previousBeneficiary` and
   * `beneficiary`, plus `liquidated`, `recovered` and `loanId` when a loan was settled (null otherwise). `opts` is an
   * options object (or left out / null): `changeBeneficiary(id, wallet, true)` is refused (rule `options`), not read
   * as no options.
   */
  async changeBeneficiary(
    vestingId: bigint | number,
    newBeneficiary: Address,
    opts: ChangeBeneficiaryOptions | null = {},
  ): Promise<ChangeBeneficiaryResult> {
    const o = optsOf(opts, CHANGE_BENEFICIARY_KEYS);
    const id = toUint(vestingId, 'vestingId');
    newBeneficiary = toAddress(newBeneficiary, 'newBeneficiary');
    const repayLoan = toBool(o.repayLoan, 'repayLoan', false);
    const v = await this.loadExisting(id);
    this.requireCaller(v.creator, 'Only creator can change beneficiary', 'Only the creator can change the beneficiary.');
    if (v.renounced) throw new ValidationError('Vesting renounced', `Vesting ${id} is renounced: its beneficiary is fixed.`);
    if (isZeroAddress(newBeneficiary)) throw new ValidationError('Invalid beneficiary address', 'newBeneficiary must not be the zero address.');
    if (v.activeLoanId !== 0n && !repayLoan) {
      throw new ValidationError('Loan open: repay first',
        `Vesting ${id} has a loan linked (hub id ${v.activeLoanId}): pass repayLoan to settle it in the same transaction, or settle it first with repayLoanOnVesting.`);
    }
    if (v.activeLoanId === 0n && newBeneficiary.toLowerCase() === v.beneficiary.toLowerCase()) {
      throw new ValidationError('same beneficiary',
        `${newBeneficiary} is already the beneficiary of vesting ${id} and no loan is linked to settle: there is nothing to change. Nothing was sent.`);
    }
    this.refuseProtocolAddress(newBeneficiary, 'newBeneficiary', await this.vestedOwn(v.token, v.ecosystem), 'beneficiary');
    let fmt: AmountOf | null = null;
    if (v.activeLoanId !== 0n) {
      await this.prepareReconcile((await this.loanOf(v))!);
      fmt = await this.tokenFmt(v);
    }
    const vesting = this.vesting;
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'changeBeneficiary', args: [id, newBeneficiary, repayLoan], contract: 'Vesting',
    });
    const ev = this.expectEvent(tx, VestingAbi, 'BeneficiaryChanged', vesting, 'Vesting', ['previousBeneficiary', 'beneficiary']);
    const settled = fmt ? this.reconciled(tx, fmt) : { liquidated: null, recovered: null, loanId: null };
    return { ...tx, previousBeneficiary: ev?.oldBeneficiary ?? null, beneficiary: ev?.newBeneficiary ?? null, ...settled };
  }

  /**
   * Hand the creator role to another wallet. Creator only (allowed on a renounced vesting). The new creator must be a
   * wallet: the zero address ('Invalid creator address') and a BASIS contract or token ('BASIS contract', as for a
   * beneficiary) are refused before the tx. Returns `previousCreator` and `creator`.
   */
  async transferCreatorRole(vestingId: bigint | number, newCreator: Address): Promise<TransferCreatorRoleResult> {
    const id = toUint(vestingId, 'vestingId');
    newCreator = toAddress(newCreator, 'newCreator');
    const v = await this.loadExisting(id);
    this.requireCaller(v.creator, 'Only creator can transfer role', 'Only the creator can transfer the creator role.');
    if (isZeroAddress(newCreator)) throw new ValidationError('Invalid creator address', 'newCreator must not be the zero address.');
    this.refuseProtocolAddress(newCreator, 'newCreator', await this.vestedOwn(v.token, v.ecosystem), 'creator');
    const vesting = this.vesting;
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'transferCreatorRole', args: [id, newCreator], contract: 'Vesting',
    });
    const ev = this.expectEvent(tx, VestingAbi, 'CreatorRoleTransferred', vesting, 'Vesting', ['previousCreator', 'creator']);
    return { ...tx, previousCreator: ev?.oldCreator ?? null, creator: ev?.newCreator ?? null };
  }

  /**
   * Add tokens to a running vesting. Creator only; refused while a loan is linked, or when the vesting has ended by the
   * next block ("Vesting already ended", checked again after the approval). Approves the token. Returns `newTotalAmount`.
   * @param additionalAmount raw bigint or a human amount in the token's decimals
   */
  async addTokensToVesting(vestingId: bigint | number, additionalAmount: TokenAmountInput): Promise<AddTokensToVestingResult> {
    const id = toUint(vestingId, 'vestingId');
    const vesting = this.vesting;
    const v = await this.loadExisting(id);
    this.requireCaller(v.creator, 'Only creator can add tokens', 'Only the creator can add tokens.');
    this.requireNoLoan(v, 'Loan open: repay first');
    const amount = await this.toTokenAmount(v.token, additionalAmount, 'additionalAmount', 'Additional amount must be greater than zero');
    await this.checkStillRunning(v);
    await this.checkBalance(v.token, amount);
    await this.ensureAllowance(v.token, vesting, amount);
    await this.checkStillRunning(v);
    const fmt = await this.tokenFmt(v);
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'addTokensToVesting', args: [id, amount], contract: 'Vesting',
    });
    const ev = this.expectEvent(tx, VestingAbi, 'VestingUpdated', vesting, 'Vesting', ['newTotalAmount']);
    return { ...tx, newTotalAmount: optAmount(fmt, ev?.totalAmount) };
  }


  /**
   * Extend the vesting by whole days. Creator (not when renounced, unless it is also the beneficiary) or beneficiary;
   * refused while a loan is linked (use `repayExtendAndReborrow`), once the vesting has ended by the next block ("Vesting
   * already ended"), or past 990 days remaining (the whole days left counted from the latest block: the extension can
   * mine in a block with the same time, which leaves the most days). Returns `daysAdded`.
   */
  async extendVestingPeriod(vestingId: bigint | number, additionalDays: bigint | number): Promise<ExtendVestingResult> {
    const id = toUint(vestingId, 'vestingId');
    const days = toUint(additionalDays, 'additionalDays');
    const v = await this.loadExisting(id);
    const me = this.account.toLowerCase();
    const isCreator = v.creator.toLowerCase() === me;
    const isBeneficiary = v.beneficiary.toLowerCase() === me;
    if (!isCreator && !isBeneficiary) {
      throw new ValidationError('Only creator or beneficiary can extend', 'Only the creator or the beneficiary can extend a vesting.');
    }
    if (isCreator && !isBeneficiary && v.renounced) {
      throw new ValidationError('Vesting renounced', `Vesting ${id} is renounced: the creator can no longer extend it.`);
    }
    this.requireNoLoan(v, 'Loan open: repay first');
    await this.checkExtension(v, days);
    const vesting = this.vesting;
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'extendVestingPeriod', args: [id, days], contract: 'Vesting',
    });
    const ev = this.expectEvent(tx, VestingAbi, 'VestingExtended', vesting, 'Vesting', ['daysAdded']);
    return { ...tx, daysAdded: ev?.additionalDays ?? null };
  }


  /** Claim the vested, unclaimed tokens. Beneficiary only; not while a loan is linked. */
  async claimTokens(vestingId: bigint | number): Promise<ClaimVestingResult> {
    const id = toUint(vestingId, 'vestingId');
    const vesting = this.vesting;
    const v = await this.loadExisting(id);
    this.requireCaller(v.beneficiary, 'Only beneficiary can claim', 'Only the beneficiary can claim.');
    this.requireNoLoan(v);
    const claimable = await this.getClaimableAmount(id);
    if (claimable === 0n) throw new ValidationError('No tokens to claim', `Vesting ${id} has nothing to claim yet.`);
    const fmt = await this.tokenFmt(v);
    const tx = await this.send({ address: vesting, abi: VestingAbi, functionName: 'claimTokens', args: [id], contract: 'Vesting' });
    const ev = this.expectEvent(tx, VestingAbi, 'TokensClaimed', vesting, 'Vesting', ['claimed']);
    return { ...tx, claimed: optAmount(fmt, ev?.amount) };
  }

  /**
   * Borrow against the unclaimed tokens. The loan runs to the vesting's end (whole days) plus the loan buffer
   * (`getLoanBuffer`) days; the pair asset is paid to the beneficiary. Beneficiary only; one loan at a time ("Active
   * loan exists"). While the loan is linked the schedule cannot be claimed, topped up or extended, and its unclaimed
   * tokens earn no holder rewards. Runs the loan rules first (`quoteLoanOnVesting` previews the loan): "pair not
   * active" (the main's pair is paused), "Ecosystem inactive", "Unauthorized caller", "incorrect loan duration",
   * "Minimum loan amount not met", "pair asset paused" (its issuer paused the pair asset), "No stable received".
   */
  async takeLoanOnVesting(vestingId: bigint | number): Promise<VestingLoanResult> {
    const id = toUint(vestingId, 'vestingId');
    const v = await this.loadExisting(id);
    this.requireCaller(v.beneficiary, 'Only beneficiary can take loan', 'Only the beneficiary can borrow against a vesting.');
    if (v.activeLoanId !== 0n) throw new ValidationError('Active loan exists', `Vesting ${id} already has a loan. Repay it first.`);
    const plan = await this.loanPlan(v, 0n);
    if (plan.error) throw plan.error;
    const fmts = await this.loanFmts(v);
    const tx = await this.send({
      address: this.vesting, abi: VestingAbi, functionName: 'takeLoanOnVesting', args: [id], contract: 'Vesting',
    });
    return this.loanTaken(tx, fmts);
  }

  /**
   * Repay the vesting's loan in full, approving the pair asset for the debt; refused before the approval while the pair
   * asset's issuer has paused it ('pair asset paused': it cannot move). When the loan was liquidated, this instead
   * settles it: what the liquidation left goes back on the schedule (no payment). Settle within 365 days of the
   * liquidation: a leftover still unclaimed after that can be taken.
   * The beneficiary, or the creator while the vesting is not renounced. Returns `liquidated`, `recovered` and the settled `loanId`.
   */
  async repayLoanOnVesting(vestingId: bigint | number): Promise<RepayVestingLoanResult> {
    const id = toUint(vestingId, 'vestingId');
    const vesting = this.vesting;
    const v = await this.loadExisting(id);
    if (this.account.toLowerCase() !== v.creator.toLowerCase() || v.renounced) {
      this.requireCaller(v.beneficiary, 'Only beneficiary or creator', "Only the vesting's beneficiary, or its creator while it is not renounced, can repay its loan.");
    }
    const loan = await this.loanOf(v);
    if (!loan) throw new ValidationError('No active loan', `Vesting ${id} has no loan.`);
    await this.prepareReconcile(loan);
    const fmt = await this.tokenFmt(v);
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'repayLoanOnVesting', args: [id], contract: 'Vesting',
    });
    return { ...tx, ...this.reconciled(tx, fmt) };
  }

  /**
   * Refinance in one go: repay the open loan in full (approving the pair asset for the debt), extend the vesting by
   * `additionalDays`, and take a new loan sized to the new schedule (fees are paid again).
   * Beneficiary only. A liquidated loan must be settled with `repayLoanOnVesting` first. The new loan is checked
   * against the loan rules on the extended schedule (as `takeLoanOnVesting`). The extension rules are measured as
   * `extendVestingPeriod` measures them (the end from the next block, the days left from the latest block), and checked
   * again after the approval. Returns the new loan's figures plus `repaidLoanId` and `daysAdded`.
   */
  async repayExtendAndReborrow(vestingId: bigint | number, additionalDays: bigint | number): Promise<RepayExtendReborrowResult> {
    const id = toUint(vestingId, 'vestingId');
    const days = toUint(additionalDays, 'additionalDays');
    const vesting = this.vesting;
    const v = await this.loadExisting(id);
    this.requireCaller(v.beneficiary, 'Only beneficiary', 'Only the beneficiary can refinance a vesting loan.');
    const loan = await this.loanOf(v);
    if (!loan) throw new ValidationError('No active loan', `Vesting ${id} has no loan.`);
    if (!loan.details.active) {
      throw new ValidationError('Loan not active', `The loan on vesting ${id} was liquidated: settle it with repayLoanOnVesting.`);
    }
    await this.checkExtension(v, days);
    const plan = await this.loanPlan(v, days, true);
    if (plan.error) throw plan.error;
    await this.checkBalance(loan.repayToken, loan.details.fullAmount);
    await this.ensureAllowance(loan.repayToken, vesting, loan.details.fullAmount);
    await this.checkExtension(v, days);
    const fmts = await this.loanFmts(v);
    const tx = await this.send({
      address: vesting, abi: VestingAbi, functionName: 'repayExtendAndReborrow', args: [id, days], contract: 'Vesting',
    });
    const repaid = this.expectEvent(tx, VestingAbi, 'LoanRepaid', vesting, 'Vesting', ['repaidLoanId']);
    const ext = this.expectEvent(tx, VestingAbi, 'VestingExtended', vesting, 'Vesting', ['daysAdded']);
    return { ...this.loanTaken(tx, fmts), repaidLoanId: repaid?.loanId ?? null, daysAdded: ext?.additionalDays ?? null };
  }

  /**
   * Preview `takeLoanOnVesting(id)`: the tokens pledged (`totalAmount - claimedAmount`), the loan length (whole days
   * left to the end + the loan buffer), the collateral value (= the debt), the fee and the payout, and the rule the
   * loan would be refused with (`refusal`, null when it goes through; "Active loan exists" first while a loan is
   * linked). The length counts from the next block (latest +
   * 1 s), so the loan can run one day longer (the tx mines in a block with the latest block's time, about 10 blocks a
   * second share a second, and the end is a whole number of days from it) or one day shorter (it lands later, past a day
   * boundary). The refusals allow for both: the length rule ("incorrect loan duration") checks its minimum from the next
   * block and its maximum from the latest block, and "No stable received" uses the longer length's fee.
   */
  async quoteLoanOnVesting(vestingId: bigint | number): Promise<VestingLoanQuote> {
    const id = toUint(vestingId, 'vestingId');
    const v = await this.getVestingDetails(id);
    if (isZeroAddress(v.creator)) throw new ValidationError('Vesting does not exist', `Vesting ${id} does not exist.`);
    const { error, ...q } = await this.loanPlan(v, 0n);
    return { ...q, refusal: error?.rule ?? null };
  }

  /**
   * Preview `repayExtendAndReborrow(id, additionalDays)` for the beneficiary: the debt of the linked loan it repays
   * first (`repayAmount`), the new loan on the schedule extended by `additionalDays` (as `quoteLoanOnVesting` sizes it:
   * tokens pledged, length, collateral value, fee, `borrowed`), and `net` = `borrowed - repayAmount`.
   * `refusal` is the rule it would be refused with, in the order `repayExtendAndReborrow` checks them, or null: "No
   * active loan", "Loan not active" (liquidated: settle it with `repayLoanOnVesting`), the extension rules ("Additional
   * days must be greater than zero", "Vesting already ended", "Extension exceeds maximum duration"), the loan rules
   * on the extended schedule ("No unclaimed tokens", "pair not active", "Ecosystem inactive", "Unauthorized caller",
   * "incorrect loan duration", "Minimum loan amount not met", "pair asset paused", "No stable received"), then
   * "insufficient balance" (the beneficiary holds
   * less than `repayAmount`). The new loan is sized before the repay; its length counts as in `quoteLoanOnVesting`, the
   * extension rules as in `extendVestingPeriod`.
   * Rule `Vesting does not exist`.
   */
  async quoteRepayExtendAndReborrow(vestingId: bigint | number, additionalDays: bigint | number): Promise<VestingReborrowQuote> {
    const id = toUint(vestingId, 'vestingId');
    const days = toUint(additionalDays, 'additionalDays');
    const v = await this.getVestingDetails(id);
    if (isZeroAddress(v.creator)) throw new ValidationError('Vesting does not exist', `Vesting ${id} does not exist.`);
    const [loan, ext, { error, ...q }] = await Promise.all([this.loanOf(v), this.extensionRefusal(v, days), this.loanPlan(v, days, true)]);
    const repayAmount = loan?.details.active ? loan.details.fullAmount : 0n;
    let refusal: string | null = null;
    if (!loan) refusal = 'No active loan';
    else if (!loan.details.active) refusal = 'Loan not active';
    else if (ext) refusal = ext.rule;
    else if (error) refusal = error.rule;
    else if ((await this.balanceOf(loan.repayToken, v.beneficiary)) < repayAmount) refusal = 'insufficient balance';
    return { ...q, additionalDays: days, repaidLoanId: v.activeLoanId, repayAmount, net: q.borrowed - repayAmount, refusal };
  }


  /** The vesting's 14-field schedule (token amounts raw, vested-token decimals). */
  async getVestingDetails(vestingId: bigint | number): Promise<VestingDetails> {
    const id = toUint(vestingId, 'vestingId');
    const s = await this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getVestingDetails', args: [id],
    });
    return toDetails(id, s);
  }

  /**
   * Several schedules in one call. `vestingIds` must be an array (anything else, null included, is refused with rule
   * `vestingIds` before any read). Reverts "Invalid vesting ID" for an id at or above `getVestingCount()`.
   */
  async getVestingDetailsBatch(vestingIds: (bigint | number)[]): Promise<VestingDetails[]> {
    if (!Array.isArray(vestingIds as unknown)) throw new ValidationError('vestingIds', 'vestingIds must be an array of vesting ids.');
    const ids = Array.from(vestingIds, (x) => toUint(x, 'vestingIds'));
    const rows = await this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getVestingDetailsBatch', args: [ids],
    });
    return rows.map((s, i) => toDetails(ids[i], s));
  }

  /** Claimable now (raw, vested-token units). 0 while a loan is linked. */
  async getClaimableAmount(vestingId: bigint | number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getClaimableAmount', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** Vested so far, claimed included (raw, vested-token units), on the recorded `totalAmount`. */
  async getVestedAmount(vestingId: bigint | number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getVestedAmount', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** What the schedule really holds (raw): after a liquidation, before it is settled, claimed + what the liquidation left. */
  async getEffectiveTotalAmount(vestingId: bigint | number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'effectiveTotalAmount', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** `getVestedAmount` scaled to the effective total (raw). */
  async getEffectiveVestedAmount(vestingId: bigint | number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'effectiveVestedAmount', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** Loan id linked to the vesting (0 = none), on `getLoanHubOf(id)`. */
  async getActiveLoan(vestingId: bigint | number): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getActiveLoan', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** The loan hub the vesting's (latest) loan was taken on; zero if it never had one. */
  async getLoanHubOf(vestingId: bigint | number): Promise<Address> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'loanHubOf', args: [toUint(vestingId, 'vestingId')],
    });
  }

  /** The linked loan with its details (debt `fullAmount` in raw pair-asset units), or null when none is linked. */
  async getVestingLoan(vestingId: bigint | number): Promise<VestingLoan | null> {
    return this.loanOf(await this.getVestingDetails(vestingId));
  }

  /** Ids of the vestings of `token` in `[startIndex, endIndex)` (end ≤ `getTokenVestingCount`). */
  async getTokenVestingIds(token: Address, startIndex: bigint | number, endIndex: bigint | number): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getTokenVestingIds',
      args: [toAddress(token, 'token'), toUint(startIndex, 'startIndex'), toUint(endIndex, 'endIndex')],
    });
  }

  async getTokenVestingCount(token: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'tokenVestingCount', args: [toAddress(token, 'token')],
    });
  }

  /** Total vestings ever created (ids are 0..count-1). */
  async getVestingCount(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'vestingCount' });
  }

  /**
   * Every vesting id `creator` created, in one call (the whole list). A long list can exceed a node's gas cap for a
   * read: `getVestingsOf` pages it instead.
   */
  async getVestingsByCreator(creator: Address): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getVestingsByCreator', args: [toAddress(creator, 'creator')],
    });
  }

  /**
   * Every vesting id naming `beneficiary`, in one call (the whole list). Anyone can create a schedule for any wallet, so
   * this list can be made long enough to exceed a node's gas cap for a read: `getVestingsOf` pages it instead.
   */
  async getVestingsByBeneficiary(beneficiary: Address): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'getVestingsByBeneficiary', args: [toAddress(beneficiary, 'beneficiary')],
    });
  }

  /**
   * A wallet's vestings (default: the signer) with their live amounts and linked loans, newest start first. Lists
   * whatever the chain holds for the address (the zero address too). Pages the wallet's id lists per `role` (500 ids
   * per multicall, all at one block), so a list anyone lengthened with schedules naming the wallet still loads; the
   * details, amounts and (with `includeLoan`) linked loans are read in pages too. `opts` is an options object (or left
   * out / null): `getVestingsOf(wallet, 'creator')` is refused
   * (rule `options`); pass `{ role: 'creator' }`.
   */
  async getVestingsOf(wallet?: Address, opts: GetVestingsOfOptions | null = {}): Promise<WalletVesting[]> {
    const o = optsOf(opts, GET_VESTINGS_OF_KEYS);
    const role = o.role ?? 'any';
    if (role !== 'any' && role !== 'beneficiary' && role !== 'creator') {
      throw new ValidationError('Invalid role', `role must be beneficiary, creator or any; got ${String(role)}.`);
    }
    const active = o.active == null ? undefined : toBool(o.active, 'active');
    const includeLoan = toBool(o.includeLoan, 'includeLoan', true);
    const who = wallet == null ? this.account : toAddress(wallet, 'wallet');
    const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const [asBen, asCre] = await Promise.all([
      role === 'creator' ? [] : this.idsOf('beneficiary', who, blockNumber),
      role === 'beneficiary' ? [] : this.idsOf('creator', who, blockNumber),
    ]);
    const ids = [...new Set([...asBen, ...asCre])];
    if (!ids.length) return [];
    const me = who.toLowerCase();
    const vesting = this.vesting;
    const details: VestingDetails[] = [];
    for (let i = 0; i < ids.length; i += DETAILS_PAGE) details.push(...await this.getVestingDetailsBatch(ids.slice(i, i + DETAILS_PAGE)));
    const rows: WalletVesting[] = [];
    for (let i = 0; i < details.length; i += READS_PAGE) {
      const page = details.slice(i, i + READS_PAGE);
      const amounts = await multicall(this.client, page.flatMap((v) =>
        (['getClaimableAmount', 'effectiveVestedAmount', 'effectiveTotalAmount'] as const).map((functionName): MulticallRead => ({
          address: vesting, abi: VestingAbi, functionName, args: [v.id], contract: 'Vesting',
        }))));
      const loans = includeLoan ? await this.loansOf(page) : new Map<bigint, VestingLoan>();
      page.forEach((v, j) => {
        const [claimable, vested, effectiveTotal] = amounts.slice(j * 3, j * 3 + 3) as bigint[];
        rows.push({
          ...v,
          isBeneficiary: v.beneficiary.toLowerCase() === me,
          isCreator: v.creator.toLowerCase() === me,
          claimable,
          vested,
          effectiveTotal,
          remaining: effectiveTotal > v.claimedAmount ? effectiveTotal - v.claimedAmount : 0n,
          endTime: this.endTime(v),
          loan: loans.get(v.id) ?? null,
        });
      });
    }
    return rows
      .filter((r) => active === undefined || (r.remaining > 0n) === active)
      .sort((x, y) => (x.startTime !== y.startTime ? (y.startTime > x.startTime ? 1 : -1) : (y.id > x.id ? 1 : y.id < x.id ? -1 : 0)));
  }

  /** How vesting records a main (default: the default main): its pair asset, and whether creates on it are accepted. */
  async getEcosystem(main?: MainRef): Promise<VestingEcosystem> {
    const m = main ? await this.resolveMain(main) : this.client.mains.defaultAddress();
    const [maintoken, factory, mainpair] = await this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'ecosystems', args: [m],
    });
    return { maintoken, factory, mainpair, registered: !isZeroAddress(maintoken) && maintoken.toLowerCase() === m.toLowerCase() };
  }

  /** The exact `msg.value` a create needs from `sender` (default: the signer), native wei: 0 when fees are off or whitelisted. */
  async getCreationFee(sender?: Address): Promise<bigint> {
    const who = sender == null ? this.account : toAddress(sender, 'sender');
    const [enabled, amount, whitelisted] = await Promise.all([this.isFeeEnabled(), this.getFeeAmount(), this.isFeeWhitelisted(who)]);
    return enabled && !whitelisted ? amount : 0n;
  }

  /** Creation fee in native wei (charged only when `isFeeEnabled`). */
  async getFeeAmount(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'feeAmount' });
  }

  async isFeeEnabled(): Promise<boolean> {
    return this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'feeEnabled' });
  }

  /** True when `addr` (default: the signer) creates vestings without a fee. */
  async isFeeWhitelisted(addr?: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.vesting, abi: VestingAbi, functionName: 'feeWhitelist', args: [addr == null ? this.account : toAddress(addr, 'addr')],
    });
  }

  /** The loan hub NEW vesting loans open on. Existing loans stay on `getLoanHubOf(id)`. */
  async getLoanHub(): Promise<Address> {
    return this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'LOAN' });
  }

  /** Days added after the vesting's end when sizing a vesting loan. */
  async getLoanBuffer(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'loanBuffer' });
  }

  /** The shortest and longest vesting duration, seconds (cached). */
  async getDurationLimits(): Promise<{ min: bigint; max: bigint }> {
    if (!this.limits) {
      const vesting = this.vesting;
      this.limits = Promise.all([
        this.publicClient.readContract({ address: vesting, abi: VestingAbi, functionName: 'MIN_VESTING_DURATION' }),
        this.publicClient.readContract({ address: vesting, abi: VestingAbi, functionName: 'MAX_VESTING_DURATION' }),
      ]).then(([min, max]) => ({ min, max }));
      this.limits.catch(() => { this.limits = null; });
    }
    return this.limits;
  }


  private async now(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }

  private async resolveMain(ref: MainRef): Promise<Address> {
    try {
      return (await this.client.mains.get(ref)).main;
    } catch (e) {
      if (!(e instanceof BasisError)) throw e;
      throw new ValidationError('Invalid ecosystem', `${ref} is not a main: ${e.message.replace(/^\[basis-sdk\] /, '')}`);
    }
  }

  /**
   * The main to create under, in this order: `ecosystem` (undefined or null: the token's own main) registered for
   * vesting ("Invalid ecosystem"), then the token: that main itself, or a factory token that trades against it ("Not
   * an Ecosystem token", also for a token of another main). An RPC failure is
   * thrown as it is.
   */
  private async checkToken(token: Address, ecosystem?: MainRef | null): Promise<Address> {
    const own = async (): Promise<Address> => {
      try {
        return await this.client.mains.mainOf(token);
      } catch (e) {
        if (e instanceof ValidationError && e.rule === 'Not an Ecosystem token') {
          throw new ValidationError('Not an Ecosystem token', `${token} is not a BASIS token.`);
        }
        throw e;
      }
    };
    const main = ecosystem == null ? await own() : await this.resolveMain(ecosystem);
    const eco = await this.getEcosystem(main);
    if (!eco.registered) {
      throw new ValidationError('Invalid ecosystem', `Main ${main} is not registered with the vesting contract.`);
    }
    if (token.toLowerCase() === main.toLowerCase()) return main;
    if (ecosystem != null) {
      const its = await own();
      if (its.toLowerCase() !== main.toLowerCase()) {
        throw new ValidationError('Not an Ecosystem token', `${token} trades against ${its}, not ${main}: vest it under its own main.`);
      }
    }
    const known = await this.publicClient.readContract({
      address: eco.factory, abi: FactoryAbi, functionName: 'isEcosystemToken', args: [token],
    });
    if (!known) throw new ValidationError('Not an Ecosystem token', `${token} is not a token of ${main}'s factory.`);
    return main;
  }

  /**
   * A beneficiary the caller typed (`toAddress` under `field`), checksummed; the zero address is refused. A BASIS
   * contract or token is refused later, as the last check before the approval (`refuseVestedOwn`, which also knows the
   * token's main).
   */
  private toBeneficiary(beneficiary: unknown, field: string): Address {
    const b = toAddress(beneficiary, field);
    if (isZeroAddress(b)) throw new ValidationError('Invalid beneficiary address', `${field} must not be the zero address.`);
    return b;
  }

  /**
   * The protocol's own contracts and tokens in the address book, lower case: every BASIS contract key (all but the
   * outside `wrappedNative` and `erc8004Registry`), and each main with its pair asset and vault. These (and the vested
   * token with its main; `vestedOwn` adds that main's pair asset and vault when the book does not list it) are refused
   * as a beneficiary or creator: none of them could ever claim or act on a schedule.
   */
  private protocolAddresses(): Set<string> {
    const book = this.client.addresses;
    const out = new Set<string>();
    const add = (a: string | undefined) => {
      if (!isZeroAddress(a)) out.add((a as string).toLowerCase());
    };
    for (const k of PROTOCOL_KEYS) add(book[k]);
    for (const m of book.mains) {
      add(m.main);
      add(m.pairAsset);
      add(m.vault);
    }
    return out;
  }

  /**
   * The `extra` of `refuseProtocolAddress` for a schedule of `token` under `main`: the token and its main, plus that
   * main's pair asset and vault when the address book does not list the main (a listed main's are in
   * `protocolAddresses` already). One read for such a main (`mains.get`, cached); none for a listed one.
   */
  private async vestedOwn(token: Address, main: Address): Promise<string[]> {
    const m = main.toLowerCase();
    if (this.client.addresses.mains.some((e) => e.main.toLowerCase() === m)) return [token, main];
    const info = await this.client.mains.get(main);
    return [token, main, info.pairAsset, info.vault];
  }

  /**
   * `ValidationError('BASIS contract')` when `addr` (the `field` the caller gave) is one of `protocolAddresses` or of
   * `extra` (`vestedOwn`: the vested token, its main and that main's pair asset and vault): a beneficiary there could
   * never claim, a creator there could never act.
   */
  private refuseProtocolAddress(addr: Address, field: string, extra: readonly string[], role: 'beneficiary' | 'creator'): void {
    const a = addr.toLowerCase();
    if (!this.protocolAddresses().has(a) && !extra.some((x) => x.toLowerCase() === a)) return;
    throw new ValidationError('BASIS contract',
      `${field} ${addr} is a BASIS contract or token address, not a wallet: ${role === 'beneficiary' ? 'tokens vested there could never be claimed' : 'it could never act as the creator'}.`);
  }

  /**
   * Each of `list` (named `fields[i]`) as `refuseProtocolAddress`, with `extra` from `vestedOwn`: the last check of a
   * create before its approval (the address book and the create's own figures; `vestedOwn` reads only a main the book
   * does not list).
   */
  private refuseVestedOwn(list: readonly Address[], fields: readonly string[], extra: readonly string[]): void {
    list.forEach((b, i) => this.refuseProtocolAddress(b, fields[i], extra, 'beneficiary'));
  }

  /**
   * A memo is a string of at most `MAX_MEMO_BYTES` (256) UTF-8 bytes; `field` is the rule for a non-string and for a
   * string that is not well-formed text (`checkText`: a lone surrogate, which UTF-8 cannot hold: it would be sent as
   * U+FFFD).
   */
  private checkMemo(memo: unknown, field: string): void {
    if (typeof memo !== 'string') throw new ValidationError(field, `${field} must be a string.`);
    checkText(memo, field);
    const size = new TextEncoder().encode(memo).length;
    if (size > MAX_MEMO_BYTES) {
      throw new ValidationError('Memo too long', `${field} is ${size} bytes of UTF-8; a vesting memo holds at most ${MAX_MEMO_BYTES}.`);
    }
  }

  /**
   * First the three lists are arrays (rule: the list's name; a string, a Set or any other value is refused, never
   * read item by item), then, in order: "Arrays length mismatch", then "Empty beneficiaries array"; then each
   * beneficiary and memo; then `batchSize` (the batch must fit one transaction: at most `BATCH_LIMIT` rows and the gas
   * estimate at most `TX_GAS_LIMIT`). Returns dense copies of the lists, the beneficiaries checksummed, and their field
   * names (`beneficiaries[i]`).
   */
  private checkBatch(
    beneficiaries: unknown, totalAmounts: unknown, userMemos: unknown,
  ): { beneficiaries: Address[]; fields: string[]; totalAmounts: unknown[]; userMemos: string[] } {
    const bens = listOf(beneficiaries, 'beneficiaries');
    const amounts = listOf(totalAmounts, 'totalAmounts');
    const memos = listOf(userMemos, 'userMemos');
    if (bens.length !== amounts.length || bens.length !== memos.length) {
      throw new ValidationError('Arrays length mismatch', 'beneficiaries, totalAmounts and userMemos must have the same length.');
    }
    if (bens.length === 0) throw new ValidationError('Empty beneficiaries array', 'beneficiaries must not be empty.');
    const list = bens.map((b, i) => this.toBeneficiary(b, `beneficiaries[${i}]`));
    memos.forEach((m, i) => this.checkMemo(m, `userMemos[${i}]`));
    const checkedMemos = memos as string[];
    const n = list.length;
    if (n > BATCH_LIMIT) {
      throw new ValidationError('batchSize',
        `One transaction takes at most ${BATCH_LIMIT} vestings; got ${n}. Split the batch: send the other ${n - BATCH_LIMIT} in a second one.`);
    }
    const encoder = new TextEncoder();
    const gas = checkedMemos.reduce((sum, m) => sum + ROW_GAS + encoder.encode(m).length * MEMO_GAS_PER_BYTE, BATCH_GAS);
    if (gas > TX_GAS_LIMIT) {
      throw new ValidationError('batchSize',
        `${n} vestings with these memos need about ${gas} gas, above the ${TX_GAS_LIMIT} one transaction can use. Split the batch, or shorten the memos.`);
    }
    return { beneficiaries: list, fields: list.map((_, i) => `beneficiaries[${i}]`), totalAmounts: amounts, userMemos: checkedMemos };
  }

  /**
   * A gradual schedule, in order: `Start too far` (a start at most 7 days after the block it is mined in), the
   * duration, then `End too far` (the end at most 990 days out: a delayed start cannot use the longest duration).
   * Both are upper bounds, measured from the latest block: on a chain
   * with about 10 blocks a second the create can mine in a block with the same time, where they are tightest.
   */
  private async checkGradualSchedule(start: bigint, days: bigint): Promise<void> {
    const [maxDelay, latest, { min, max }] = await Promise.all([
      this.publicClient.readContract({ address: this.vesting, abi: VestingAbi, functionName: 'MAX_START_DELAY' }),
      this.now(),
      this.getDurationLimits(),
    ]);
    if (start > latest + maxDelay) {
      throw new ValidationError(
        'Start too far',
        `startTime ${start} is more than ${maxDelay / DAY} days after the latest block (${latest}); pass unix seconds, not milliseconds.`,
      );
    }
    const secs = days * DAY;
    if (secs < min) throw new ValidationError('Vesting duration must be at least 1 hour', `durationInDays must be at least ${(min + DAY - 1n) / DAY}.`);
    if (secs > max) throw new ValidationError('Duration too long', `durationInDays must be at most ${max / DAY}, got ${days}.`);
    const begin = start > latest ? start : latest;
    if (begin + secs > latest + max) {
      throw new ValidationError('End too far', `A start at ${begin} plus ${days} days ends more than ${max / DAY} days after the latest block (${latest}): start sooner or shorten it.`);
    }
  }

  /**
   * A top-up mines in a later block (timestamp >= latest + 1) and is taken only while the vesting has not ended at
   * that block's time ("Vesting already ended").
   */
  private async checkStillRunning(v: VestingDetails): Promise<void> {
    const now = (await this.now()) + 1n;
    const end = this.endTime(v);
    if (now >= end) {
      throw new ValidationError('Vesting already ended', `Vesting ${v.id} has already ended: its end ${end} is not after the next block's time ${now}.`);
    }
  }

  /**
   * A cliff's unlock, as it is checked in the block the create mines in. The lower bounds ("Unlock time must be in
   * the future", the minimum duration) are measured from the next block (latest + 1: a later block only tightens
   * them); the upper bound ("Duration too long", at most the maximum duration) from the latest block (on a
   * chain with about 10 blocks a second the create can mine in a block with the same time, where it is tightest).
   */
  private async checkCliffUnlock(unlock: bigint): Promise<void> {
    const [{ min, max }, latest] = await Promise.all([this.getDurationLimits(), this.now()]);
    const next = latest + 1n;
    if (unlock <= next) throw new ValidationError('Unlock time must be in the future', `unlockTime ${unlock} is not after the next block's time ${next}.`);
    if (unlock - next < min) throw new ValidationError('Vesting duration must be at least 1 hour', `unlockTime must be at least ${min}s after the next block (${next}).`);
    if (unlock - latest > max) throw new ValidationError('Duration too long', `unlockTime must be at most ${max / DAY} days after the latest block (${latest}).`);
  }

  /** Extension rules: days > 0, not ended (by the next block), remaining whole days + days ≤ the max (from the latest block). */
  private async checkExtension(v: VestingDetails, days: bigint): Promise<void> {
    const error = await this.extensionRefusal(v, days);
    if (error) throw error;
  }

  /**
   * The first extension rule `days` would break (`checkExtension`'s rules, in its order), or null. An extension is
   * taken only while the vesting has not ended: a lower bound on the time, measured from the next block (latest + 1;
   * a later block only tightens it). The maximum (990 days less the whole days left) is an upper bound: on a chain with
   * about 10 blocks a second the extension can mine in a block with the latest block's time, which leaves the most days
   * (so the smallest maximum): the days left are measured from the latest block.
   */
  private async extensionRefusal(v: VestingDetails, days: bigint): Promise<ValidationError | null> {
    if (days === 0n) return new ValidationError('Additional days must be greater than zero', 'additionalDays must be at least 1.');
    const [{ max }, latest] = await Promise.all([this.getDurationLimits(), this.now()]);
    const next = latest + 1n;
    const end = this.endTime(v);
    if (next >= end) {
      return new ValidationError('Vesting already ended', `Vesting ${v.id} has already ended: its end ${end} is not after the next block's time ${next}.`);
    }
    const maxExtension = max / DAY - (end - latest) / DAY;
    if (days > maxExtension) {
      return new ValidationError('Extension exceeds maximum duration', `Vesting ${v.id} can be extended by at most ${maxExtension} days.`);
    }
    return null;
  }

  /**
   * `who`'s vesting ids as beneficiary or creator, paged (`IDS_PAGE` per multicall), every read at `blockNumber` (a
   * schedule moved to another beneficiary meanwhile cannot shift the list between pages).
   */
  private async idsOf(role: 'beneficiary' | 'creator', who: Address, blockNumber: bigint): Promise<bigint[]> {
    const vesting = this.vesting;
    const pc = pinnedClient(this.publicClient);
    const count = role === 'beneficiary'
      ? await pc.readContract({ address: vesting, abi: VestingAbi, functionName: 'beneficiaryCount', args: [who], blockNumber })
      : await pc.readContract({ address: vesting, abi: VestingAbi, functionName: 'creatorCount', args: [who], blockNumber });
    const out: bigint[] = [];
    for (let start = 0n; start < count; start += IDS_PAGE) {
      const reads: MulticallRead[] = [];
      for (let i = start; i < count && i < start + IDS_PAGE; i++) {
        reads.push(role === 'beneficiary'
          ? { address: vesting, abi: VestingAbi, functionName: 'beneficiaryVestings', args: [who, i], contract: 'Vesting' }
          : { address: vesting, abi: VestingAbi, functionName: 'creatorVestings', args: [who, i], contract: 'Vesting' });
      }
      out.push(...((await multicall(this.client, reads, { blockNumber })) as bigint[]));
    }
    return out;
  }

  private endTime(v: VestingDetails): bigint {
    return v.isGradual ? v.startTime + v.durationInDays * DAY : v.unlockTime;
  }

  /** Balance check, approval and the exact fee for a create. */
  private async prepareCreate(token: Address, total: bigint): Promise<bigint> {
    const vesting = this.vesting;
    await this.checkBalance(token, total);
    const fee = await this.getCreationFee();
    if (fee > 0n) {
      const native = await this.publicClient.getBalance({ address: this.account });
      if (native < fee) throw new ValidationError('Insufficient fee', `The vesting fee is ${fee} wei; the wallet holds ${native}.`);
    }
    await this.ensureAllowance(token, vesting, total);
    return fee;
  }

  private async checkBalance(token: Address, amount: bigint): Promise<void> {
    const bal = await this.balanceOf(token);
    if (bal < amount) throw new ValidationError('insufficient balance', `Needs ${amount} of ${token} (raw); the wallet holds ${bal}.`);
  }

  private async toTokenAmount(token: Address, value: TokenAmountInput, field: string, zeroRule = 'Amount must be greater than zero'): Promise<bigint> {
    const decimals = typeof value === 'bigint' ? 18 : (await this.client.mains.tokenMeta(token)).decimals;
    let raw: bigint;
    try {
      raw = parseAmount(value, decimals);
    } catch {
      throw new ValidationError(field, `${field} is not a valid amount: ${String(value)}.`);
    }
    if (raw <= 0n) throw new ValidationError(zeroRule, `${field} must be greater than zero.`);
    return raw;
  }

  private toTimeUnit(u: VestingTimeUnitInput): number {
    if (typeof u === 'string') {
      const v = TIME_UNITS.get(u.toLowerCase());
      if (v === undefined) throw new ValidationError('Invalid time unit', `timeUnit must be second, minute, hour or day; got ${u}.`);
      return v;
    }
    if (!Number.isInteger(u) || u < 0 || u > 3) throw new ValidationError('Invalid time unit', `timeUnit must be 0-3, got ${u}.`);
    return u;
  }

  /** The schedule a write acts on (signer checked first, so a wallet-less client gets WalletRequiredError). */
  private async loadExisting(id: bigint): Promise<VestingDetails> {
    void this.account;
    const v = await this.getVestingDetails(id);
    if (isZeroAddress(v.creator)) throw new ValidationError('Vesting does not exist', `Vesting ${id} does not exist.`);
    return v;
  }

  private requireCaller(expected: Address, rule: string, message: string): void {
    if (expected.toLowerCase() !== this.account.toLowerCase()) throw new ValidationError(rule, message);
  }

  /**
   * Before settling `loan` from this wallet: a live one needs its pair asset movable ('pair asset paused' while its
   * issuer has paused it) and its debt (`fullAmount`, raw pair asset) held and approved.
   */
  private async prepareReconcile(loan: VestingLoan): Promise<void> {
    if (!loan.details.active) return;
    await refusePausedAsset(this.client, loan.repayToken, null, 'the loan cannot be repaid in it now');
    await this.checkBalance(loan.repayToken, loan.details.fullAmount);
    await this.ensureAllowance(loan.repayToken, this.vesting, loan.details.fullAmount);
  }

  /** What settling a vesting loan did (a liquidated loan, or a repay), from the transaction's events. */
  private reconciled(tx: TxResult, fmt: AmountOf): { liquidated: boolean | null; recovered: Amount | null; loanId: bigint | null } {
    const vesting = this.vesting;
    const liq = this.events(tx, VestingAbi, 'VestingLoanLiquidated', vesting)[0];
    if (liq) return { liquidated: true, recovered: fmt(liq.recovered), loanId: liq.loanId };
    const repaid = this.expectEvent(tx, VestingAbi, 'LoanRepaid', vesting, 'Vesting', ['liquidated', 'recovered', 'loanId']);
    return { liquidated: repaid ? false : null, recovered: repaid ? fmt(0n) : null, loanId: repaid?.loanId ?? null };
  }

  /** Refused while any loan is linked, liquidated or not (on chain some of these calls fail with no reason). */
  private requireNoLoan(v: VestingDetails, rule = 'Loan open: repay first'): void {
    if (v.activeLoanId !== 0n) {
      throw new ValidationError(rule, `Vesting ${v.id} has a loan linked (hub id ${v.activeLoanId}): repay it (or settle a liquidation) with repayLoanOnVesting first.`);
    }
  }

  private async loanOf(v: VestingDetails): Promise<VestingLoan | null> {
    if (v.activeLoanId === 0n) return null;
    const vesting = this.vesting;
    const [hub, eco] = await Promise.all([
      this.getLoanHubOf(v.id),
      this.publicClient.readContract({ address: vesting, abi: VestingAbi, functionName: 'ecosystems', args: [v.ecosystem] }),
    ]);
    if (isZeroAddress(hub)) throw new BasisError(`[basis-sdk] Vesting ${v.id} links loan ${v.activeLoanId} but has no loanHubOf.`);
    const details = await this.publicClient.readContract({
      address: hub, abi: LoanHubAbi, functionName: 'getUserLoanDetails', args: [vesting, v.activeLoanId],
    });
    return { hub, loanId: v.activeLoanId, details, repayToken: eco[2] };
  }

  /** The linked loans of `rows` by vesting id, in two multicalls (hubs and repay tokens, then the loan details). */
  private async loansOf(rows: VestingDetails[]): Promise<Map<bigint, VestingLoan>> {
    const linked = rows.filter((v) => v.activeLoanId !== 0n);
    const out = new Map<bigint, VestingLoan>();
    if (!linked.length) return out;
    const vesting = this.vesting;
    const refs = await multicall(this.client, linked.flatMap((v): MulticallRead[] => [
      { address: vesting, abi: VestingAbi, functionName: 'loanHubOf', args: [v.id], contract: 'Vesting' },
      { address: vesting, abi: VestingAbi, functionName: 'ecosystems', args: [v.ecosystem], contract: 'Vesting' },
    ]));
    const hubs = linked.map((v, i) => {
      const hub = refs[i * 2] as Address;
      if (isZeroAddress(hub)) throw new BasisError(`[basis-sdk] Vesting ${v.id} links loan ${v.activeLoanId} but has no loanHubOf.`);
      return hub;
    });
    const details = await multicall(this.client, linked.map((v, i): MulticallRead => ({
      address: hubs[i], abi: LoanHubAbi, functionName: 'getUserLoanDetails', args: [vesting, v.activeLoanId], contract: 'LoanHub',
    })));
    linked.forEach((v, i) => out.set(v.id, {
      hub: hubs[i], loanId: v.activeLoanId, details: details[i] as HubLoanDetails, repayToken: (refs[i * 2 + 1] as readonly Address[])[2],
    }));
    return out;
  }

  /**
   * The loan a vesting borrow would open for `v` with its end moved by `extraDays` (a reborrow after an extension), and
   * the first rule it would fail, in the order `VestingLoanQuote.refusal` lists them ("Active loan exists" is skipped
   * for a reborrow, which repays the open loan first; the issuer pause is read only when the rules before it pass). The
   * length (whole days left to the end + the loan buffer) is quoted from the next block (latest + 1); the length rule
   * checks its minimum from there (a later block only shortens the loan) and its maximum from the latest block (on a
   * chain with about 10 blocks a second the loan can open in a block with the same time: one day longer when the end
   * is a whole number of days away); "No stable received" is checked on that longest length too (a longer loan costs
   * more).
   */
  private async loanPlan(v: VestingDetails, extraDays: bigint, reborrow = false): Promise<Omit<VestingLoanQuote, 'refusal'> & { error: ValidationError | null }> {
    const pc = this.publicClient;
    const main = v.ecosystem;
    const tokenAmount = v.totalAmount > v.claimedAmount ? v.totalAmount - v.claimedAmount : 0n;
    const [hub, buffer, latest] = await Promise.all([this.getLoanHub(), this.getLoanBuffer(), this.now()]);
    const end = this.endTime(v) + extraDays * DAY;
    const lengthAt = (t: bigint) => (end > t ? (end - t) / DAY : 0n) + buffer;
    const loanDurationDays = lengthAt(latest + 1n);
    const longest = lengthAt(latest);
    const read = <F extends 'LOAN' | 'minDaysLoan' | 'maxDaysLoan' | 'minimumLoan' | 'staticFeePercentage'>(fn: F) =>
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: fn });
    const [live, eco, mainHub, minDays, maxDays, minimumLoan, staticFee, collateralValue] = await Promise.all([
      isPairActive(this.client, main),
      pc.readContract({ address: hub, abi: LoanHubAbi, functionName: 'ecosystems', args: [main] }),
      read('LOAN'), read('minDaysLoan'), read('maxDaysLoan'), read('minimumLoan'), read('staticFeePercentage'),
      tokenAmount === 0n ? 0n : pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getColleteralValue', args: [tokenAmount, v.token] }),
    ]);
    const inRange = loanDurationDays >= minDays && longest <= maxDays;
    const dynamicFor = (days: bigint) => pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getDynamicFee', args: [collateralValue, days] })
      .catch((e: unknown) => {
        if (inRange) throw e;
        return 0n;
      });
    const dynamic = await dynamicFor(loanDurationDays);
    const staticPart = (collateralValue * staticFee) / 10_000n;
    const fee = staticPart + dynamic;
    const feeLongest = longest === loanDurationDays ? fee : staticPart + await dynamicFor(longest);
    const q = {
      vestingId: v.id, hub, main, token: v.token, tokenAmount, loanDurationDays, collateralValue, fee,
      borrowed: collateralValue > fee ? collateralValue - fee : 0n, meetsMinimum: collateralValue >= minimumLoan,
    };
    let error: ValidationError | null = null;
    if (!reborrow && v.activeLoanId !== 0n) {
      error = new ValidationError('Active loan exists', `Vesting ${v.id} already has a loan (hub id ${v.activeLoanId}): repay it first, or refinance with repayExtendAndReborrow.`);
    } else if (tokenAmount === 0n) error = new ValidationError('No unclaimed tokens', `Vesting ${v.id} has nothing left to borrow against.`);
    else if (!live) error = pairNotActive(main);
    else if (!eco[2]) error = new ValidationError('Ecosystem inactive', `Main ${main} is not active on the loan hub ${hub}.`);
    else if (mainHub.toLowerCase() !== hub.toLowerCase()) {
      error = new ValidationError('Unauthorized caller', `Main ${main} takes new loans from hub ${mainHub}, not the vesting's hub ${hub}.`);
    } else if (!inRange) {
      const shown = loanDurationDays < minDays ? loanDurationDays : longest;
      error = new ValidationError('incorrect loan duration',
        `The vesting loan would run ${shown} days (days left to the end + loanBuffer ${buffer}), outside this main's ${minDays}-${maxDays}.`);
    } else if (collateralValue < minimumLoan) {
      error = new ValidationError('Minimum loan amount not met', `The unclaimed tokens are worth ${collateralValue}, below the minimum loan ${minimumLoan} (raw pair asset).`);
    } else if (await isAssetPaused(this.client, eco[0])) {
      error = pairAssetPaused(eco[0], null, 'no vesting loan can pay it out');
    } else if (feeLongest >= collateralValue) {
      error = new ValidationError('No stable received', `The loan fees ${feeLongest} would take the whole collateral value ${collateralValue} (raw pair asset).`);
    }
    return { ...q, error };
  }

  /** The vesting ids from a create's events (null and a warning when there is none). */
  private createdIds(tx: TxResult, fields: string[]): bigint[] | null {
    const ids = this.events(tx, VestingAbi, 'VestingCreated', this.vesting).map((e) => e.vestingId);
    if (ids.length) return ids;
    addMissingEventWarning(tx, 'Vesting', 'VestingCreated', fields);
    return null;
  }

  /** Formatter for the vested token of `v` (resolved before a write sends). */
  private async tokenFmt(v: VestingDetails): Promise<AmountOf> {
    return amountOf(this.client, v.token, await this.client.mains.get(v.ecosystem));
  }

  /** Formatters for a vesting loan's figures: the vested token and the main's pair asset (resolved before sending). */
  private async loanFmts(v: VestingDetails): Promise<{ token: AmountOf; pair: AmountOf }> {
    const info = await this.client.mains.get(v.ecosystem);
    return { token: await amountOf(this.client, v.token, info), pair: pairAmountOf(info) };
  }

  private loanTaken(tx: TxResult, fmts: { token: AmountOf; pair: AmountOf }): VestingLoanResult {
    const ev = this.expectEvent(tx, VestingAbi, 'LoanTaken', this.vesting, 'Vesting', ['loanId', 'hub', 'tokenAmount', 'loanDurationDays', 'borrowed']);
    return {
      ...tx,
      loanId: ev?.loanId ?? null,
      hub: ev?.hub ?? null,
      tokenAmount: optAmount(fmts.token, ev?.tokenAmount),
      loanDurationDays: ev?.loanDurationDays ?? null,
      borrowed: optAmount(fmts.pair, ev?.borrowed),
    };
  }
}

/**
 * A batch create's list (`beneficiaries`, `totalAmounts`, `userMemos`): an array, copied dense (a hole reads as
 * undefined, which the entry checks refuse). Anything else is refused with the list's name as the rule, before any
 * read: a string or a Set is never read item by item.
 */
function listOf(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) {
    const got = v === null ? 'null' : v === undefined ? 'nothing' : typeof v === 'string' ? 'a string'
      : typeof v === 'function' ? 'a function' : typeof v === 'object' ? (v instanceof Set ? 'a Set' : 'an object') : `${typeof v} ${String(v)}`;
    throw new ValidationError(field, `${field} must be a list, one entry per vesting; got ${got}.`);
  }
  return Array.from(v as unknown[]);
}

type RawVesting = ContractFunctionReturnType<typeof VestingAbi, 'view', 'getVestingDetails'>;

function toDetails(id: bigint, s: RawVesting): VestingDetails {
  return {
    id,
    creator: s.creator,
    beneficiary: s.beneficiary,
    token: s.token,
    ecosystem: s.ecosystem,
    totalAmount: s.totalAmount,
    claimedAmount: s.claimedAmount,
    startTime: s.startTime,
    durationInDays: s.durationInDays,
    unlockTime: s.unlockTime,
    isGradual: s.isGradual,
    activeLoanId: s.activeLoanId,
    memo: s.memo,
    timeUnit: s.timeUnit as VestingTimeUnitValue,
    renounced: s.renounced,
  };
}

