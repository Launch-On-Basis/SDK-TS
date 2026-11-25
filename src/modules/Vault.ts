import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { LoanHubAbi, MainTokenAbi, SwapAbi, VaultAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { coreExtendRefusal, isAssetPaused, isPairActive, pairAssetPaused, pairNotActive, refusePausedAsset } from '../core/loans';
import { type MainInfo, type MainRef, mainAmount, pairAmount } from '../core/mains';
import { addMissingEventWarning } from '../core/events';
import { multicall, type MulticallRead } from '../core/multicall';
import { optionKeys, optsOf } from '../core/opts';
import { type Amount, optUint, toAddress, toBool, toUint } from '../core/units';

/** Reads per position in `getPosition` / `getPositions`. */
const POSITION_READS = 5;

/**
 * Which main to use (address or address-book key; default: the default main), and optionally on which vault. null
 * (for the options or any field) is the same as leaving it out.
 */
export interface VaultOptions {
  main?: MainRef | null;
  /**
   * The vault holding the position, when it is not the main's current one. A main can move to a new vault;
   * positions and open loans stay on the old one, which keeps every exit open (unstake, claim, compound, repay,
   * extendLoan) and every read. Default: the main's current vault. Entries (stake, borrow, addToLoan) only run on the
   * current vault: an override that differs is refused ("Main not on this vault").
   */
  vault?: Address | null;
}
const VAULT_KEYS = optionKeys<VaultOptions>({ main: true, vault: true });

export interface UnstakeOptions extends VaultOptions {
  /** Sell the unstaked main and receive the pair asset (a normal sale, at the signer's own fee rate). Default false. */
  toPairAsset?: boolean | null;
  /** `toPairAsset` only: explicit minimum pair asset out (raw pair-asset units). Omit to derive it from a fee-inclusive quote. Never 0. */
  minOut?: bigint | null;
  /** Slippage for the derived minimum, bps (default `client.slippageBps.trade`). */
  slippageBps?: number | null;
}
const UNSTAKE_KEYS = optionKeys<UnstakeOptions>({ main: true, vault: true, toPairAsset: true, minOut: true, slippageBps: true });

/** `VaultOptions` plus whose position a quote reads (default the signer). */
export interface VaultUserOptions extends VaultOptions {
  user?: Address | null;
}
const VAULT_USER_KEYS = optionKeys<VaultUserOptions>({ main: true, vault: true, user: true });

/** `VaultOptions` plus the loan hub to read (default: the one new vault loans open on, `getLoanHub`). */
export interface VaultLoanOwnerOptions extends VaultOptions {
  hub?: Address | null;
}
const VAULT_LOAN_OWNER_KEYS = optionKeys<VaultLoanOwnerOptions>({ main: true, vault: true, hub: true });

/** Options of `getPositions`. */
export interface GetVaultPositionsOptions {
  /** Vaults a main moved away from, read too (an array; null = none). */
  vaults?: Address[] | null;
}
const GET_VAULT_POSITIONS_KEYS = optionKeys<GetVaultPositionsOptions>({ vaults: true });

/**
 * A wallet's vault position. Main amounts are `Amount`s in main units (18 decimals).
 * An open loan is identified by `hub` and `hubId`; `hub` can differ from `getLoanHub()`.
 */
export interface VaultPosition {
  main: Address;
  vault: Address;
  user: Address;
  /** Staked main, 1:1 (includes the pledged part, which keeps earning). */
  staked: Amount;
  /** Part of the stake pledged to the loan. */
  pledged: Amount;
  /** Loan id on `hub` (0 when no loan). */
  hubId: bigint;
  /** A loan is open. */
  hasActiveLoan: boolean;
  /** Raw reward checkpoint (bookkeeping only: use `earned` for rewards). */
  checkpoint: bigint;
  /** Unclaimed rewards as of the position's last update; `earned` is the live total. */
  pending: Amount;
  /** The loan hub the open loan is on (zero address without a loan). */
  hub: Address;
  /** All unclaimed rewards. */
  earned: Amount;
  /** Stake plus unclaimed rewards. */
  collateralOf: Amount;
  /** Part of the stake that can be unstaked now. */
  freeToUnstake: Amount;
  /** Collateral not pledged: what can still be borrowed against. */
  availableStasis: Amount;
}

/** The position's loan. Collateral in main units, debt in the pair asset. */
export interface VaultLoan {
  main: Address;
  vault: Address;
  hub: Address;
  hubId: bigint;
  /** The main of this loan. */
  ecosystem: Address;
  coreLoanId: bigint;
  collateralToken: Address;
  token: Address;
  collateralAmount: Amount;
  liquidatedAmount: Amount;
  /** Debt to repay (`repay` pulls exactly this). */
  fullAmount: Amount;
  borrowedAmount: Amount;
  /** Unix seconds from which the loan can be liquidated. */
  liquidationTime: bigint;
  liquidationClaim: Amount;
  isLiquidated: boolean;
  active: boolean;
  creationTime: bigint;
}

/** One main's totals on the vault. Main amounts as `Amount`; `accRewardPerStake` raw (bookkeeping only). */
export interface VaultTotals {
  main: Address;
  vault: Address;
  totalStaked: Amount;
  totalPledged: Amount;
  rewardsHeld: Amount;
  /** Main on the vault not pledged to a loan (new borrows cannot pledge more than this). */
  totalStasisAvailable: Amount;
  accRewardPerStake: bigint;
}

/** Preview of `extendLoan` for the position's loan. Pair-asset amounts. */
export interface VaultExtensionQuote {
  /**
   * `extendLoan` with these arguments would go through (false on a paused pair: "pair not active", and while the pair
   * asset's issuer has paused it: "pair asset paused").
   */
  possible: boolean;
  /** The fee: paid from the wallet (pay-in: the vault pulls it, balance and approval needed), added to the debt, or taken from a refinance. */
  fee: Amount;
  /** Pair asset a refinance pays out. */
  extraOut: Amount;
}

/** Preview of `borrow`, as it would run now. Pair-asset amounts. */
export interface VaultBorrowQuote {
  main: Address;
  vault: Address;
  /** The loan hub the loan would open on (`getLoanHub`). */
  hub: Address;
  /** Value of the pledged main; this is the debt (`fullAmount`) to repay. */
  collateralValue: Amount;
  /** The loan fee for `days`. */
  fee: Amount;
  /** Paid to the wallet: the collateral value minus the fee (0 when the fee takes it all). */
  borrowed: Amount;
  /** The collateral value meets the main's minimum loan size. */
  meetsMinimum: boolean;
  /** `borrow` with these arguments would go through now (no `refusal`). */
  possible: boolean;
  /**
   * The rule `borrow` would refuse it with, in the order checked, or null: "Main not on this vault", "Position
   * active. Use addToLoan", "Hook not registered", "Zero amount", "Insufficient collateral value", "Contract low on
   * liquidity", "pair not active" (the main's pair is paused), "Ecosystem inactive", "Unauthorized caller", "incorrect
   * loan duration", "Minimum loan amount not met", "pair asset paused" (its issuer paused the pair asset: no loan can
   * pay it out), "No stable received".
   */
  refusal: string | null;
}

/** Preview of `addToLoan`, as it would run in the next block. Pair-asset amounts. */
export interface VaultAddToLoanQuote {
  main: Address;
  vault: Address;
  /** The loan hub the position's loan is on (zero without a loan). */
  hub: Address;
  /** The loan's id on `hub` (0 without a loan). */
  hubId: bigint;
  /** Value of all the pledged main after the add. */
  newCollateralValue: Amount;
  /** Added to the debt: the new collateral value minus the current debt (0 when the add gives no borrowing power). */
  addedValue: Amount;
  /** The fee on `addedValue` for the whole days left. */
  fee: Amount;
  /** Paid to the wallet: `addedValue` minus the fee (0 when the fee takes it all). */
  borrowed: Amount;
  /** Whole days left on the loan (the fee is charged for these; the end date stays). */
  daysLeft: bigint;
  /** `addToLoan` with this amount would go through now (no `refusal`). */
  possible: boolean;
  /**
   * The rule `addToLoan` would refuse it with, in the order checked, or null: "Main not on this vault", "No active
   * loan", "Zero amount", "Insufficient collateral value", "Contract low on liquidity", "pair not active" (the main's
   * pair is paused), "Loan not active", "Duration too short", "No borrowing power", "Fees exceed value", "pair asset
   * paused" (its issuer paused the pair asset: no top-up can pay it out).
   */
  refusal: string | null;
}

/** What a vault write did, read from the transaction's events (null when the expected event is missing: see `warnings`). */
export interface VaultStakeResult extends TxResult {
  /** Main staked. */
  staked: Amount | null;
}

export interface VaultUnstakeResult extends TxResult {
  /** Main taken out of the stake. */
  unstaked: Amount | null;
  /** Pair asset paid for it with `toPairAsset` (0 for a plain unstake). */
  pairReceived: Amount | null;
}

export interface VaultClaimResult extends TxResult {
  /** Rewards paid out in the main. */
  claimed: Amount | null;
}

export interface VaultCompoundResult extends TxResult {
  /** Rewards added to the stake. */
  compounded: Amount | null;
}

export interface VaultBorrowResult extends TxResult {
  /** The loan's id on `hub`. */
  hubId: bigint | null;
  hub: Address | null;
  /** Main pledged. */
  pledged: Amount | null;
  /** Pair asset paid to the wallet. */
  received: Amount | null;
}

export interface VaultAddToLoanResult extends TxResult {
  /** Main pledged on top. */
  pledged: Amount | null;
  /** Pair asset paid to the wallet. */
  received: Amount | null;
}

export interface VaultRepayResult extends TxResult {
  /** The closed loan's id. */
  hubId: bigint | null;
  /** Main released back to the position. */
  returned: Amount | null;
}

export interface VaultExtendResult extends TxResult {
  /** Unix seconds of the new liquidation time. */
  newLiquidationTime: bigint | null;
  /** The debt after the extension (pair asset). */
  newFullAmount: Amount | null;
  /** Pair asset a refinance paid to the wallet (0 otherwise). */
  extraOut: Amount | null;
}

/** The staker and main behind a vault loan on a hub. */
export interface VaultLoanOwner {
  user: Address;
  main: Address;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const DAY = 86_400n;

type RawPosition = {
  staked: bigint; pledged: bigint; hubId: bigint; checkpoint: bigint; pending: bigint; hub: Address; hasActiveLoan: boolean;
};

/**
 * The staking vault: stake a main, earn rewards in it, and borrow the pair asset against the position. One position per
 * (main, user). Stakes are 1:1 in the main: no shares, no receipt token. Layer 1: stake / unstake / claim / compound.
 * Layer 2: borrow the pair asset against the position (the pledge happens in `borrow`), add to it, repay, extend. Loans
 * are made by the BASIS protocol. If a loan is liquidated, the loss comes off the stake, then off unclaimed rewards;
 * there is nothing to settle by hand. Buy-and-stake is `client.trading.buyAndStake`.
 *
 * While the issuer of a main's pair asset has paused it (USDG and tokenized stocks can be paused), the asset cannot move:
 * every write that pays it in or out (borrow, addToLoan, repay, extendLoan, unstake with `toPairAsset`) is refused
 * before any approval or tx ("pair asset paused"); stake, a plain unstake, claim and compound move only the main.
 *
 * Every method takes `{ main }` (default: the default main) and, for exits and reads, `{ vault }` to reach a position
 * left on a vault the main moved away from. The options are an object, left out or null: anything else
 * (`stake(amount, 'tnvda')`, `unstake(amount, true)`) is refused before any read (rule `options`), never read as no
 * options. Inputs are raw bigints: main amounts in main units (18 decimals).
 * Reads return `Amount`s.
 */
export class VaultModule extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  /** True when the vault can be used on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.swap);
  }

  /** The address of the vault serving `main` (default: the default main). */
  async vaultOf(main?: MainRef): Promise<Address> {
    return (await this.ctx({ main })).vault;
  }


  /** Stake `amount` (raw main, at least `getMinStake()`, else "Below min stake"). Approves the main to the vault. Returns `staked`. */
  async stake(amount: bigint, opts: VaultOptions | null = {}): Promise<VaultStakeResult> {
    const o = optsOf(opts, VAULT_KEYS);
    const amt = toUint(amount, 'amount');
    const { info, vault } = await this.ctx(o, true);
    const min = await this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'minStake' });
    if (amt < min) throw new ValidationError('Below min stake', `Stake must be at least ${min} raw ${info.symbol}, got ${amt}.`);
    await this.checkBalance(info.main, amt, info.symbol);
    await this.ensureAllowance(info.main, vault, amt);
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'stake', args: [info.main, amt], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'Staked', vault, 'Vault', ['staked']);
    return { ...tx, staked: ev ? mainAmount(ev.amount, info) : null };
  }

  /**
   * Unstake `amount` (raw main) of the stake. With `toPairAsset` the main is sold at the signer's own fee rate and the
   * pair asset paid out; the minimum is derived from `trading.quote([main, pairAsset], amount, signer)` unless `minOut`
   * is given. Rewards are taken out with `claim`. Refused with "Insufficient stake" above the stake and "Collateral in
   * use" above `freeToUnstake` (the part not backing a loan). On a vault the main moved away from (`vault` override),
   * only a plain unstake works ("Only STAKING"). `toPairAsset` is also refused while the main's pair is paused
   * ("unknown pair", read live) and while the pair asset's issuer has paused it ("pair asset paused").
   * Returns `unstaked` and `pairReceived`.
   */
  async unstake(amount: bigint, opts: UnstakeOptions | null = {}): Promise<VaultUnstakeResult> {
    const o = optsOf(opts, UNSTAKE_KEYS);
    const amt = toUint(amount, 'amount');
    if (amt === 0n) throw new ValidationError('Zero amount', 'Amount must be greater than 0.');
    const toPairAsset = toBool(o.toPairAsset, 'toPairAsset', false);
    if (!toPairAsset && o.minOut != null) {
      throw new ValidationError('minOut', 'minOut only applies with toPairAsset (a plain unstake returns the main 1:1).');
    }
    const explicitMin = optUint(o.minOut, 'minOut');
    const { info, vault, listed } = await this.ctx(o);
    const me = this.account;
    const [pos, free] = await Promise.all([
      this.rawPosition(vault, info.main, me),
      this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'freeToUnstake', args: [info.main, me] }),
    ]);
    if (amt > pos.staked) throw new ValidationError('Insufficient stake', `Staked ${pos.staked}, cannot unstake ${amt}.`);
    if (amt > free) throw new ValidationError('Collateral in use', `Only ${free} of the stake is free to unstake (the rest backs the loan).`);
    if (toPairAsset && !listed) {
      throw new ValidationError(
        'Only STAKING',
        `SWAP lists ${info.vault} as the vault of ${info.symbol}, so vault ${vault} can no longer sell it; unstake without toPairAsset.`,
      );
    }
    let min = 0n;
    if (toPairAsset) {
      const swap = this.require(this.client.addresses.swap, 'Swap');
      const [, , active] = await this.publicClient.readContract({ address: swap, abi: SwapAbi, functionName: 'pairs', args: [info.main] });
      if (!active) {
        throw new ValidationError(
          'unknown pair',
          `${info.symbol} (${info.main}) is paused on SWAP, so the vault cannot sell it for ${info.pairSymbol}; unstake without toPairAsset to get the main back 1:1.`,
        );
      }
      await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol,
        `the vault cannot pay it out for the unstaked ${info.symbol}; unstake without toPairAsset to get the main back 1:1`);
      min = await this.resolveMin(explicitMin, o.slippageBps, () => this.client.trading.quote([info.main, info.pairAsset], amt, me));
    }
    const tx = await this.send({
      address: vault, abi: VaultAbi, functionName: 'unstake', args: [info.main, amt, toPairAsset, min], contract: 'Vault',
    });
    const ev = this.expectEvent(tx, VaultAbi, 'Unstaked', vault, 'Vault', ['unstaked', 'pairReceived']);
    return { ...tx, unstaked: ev ? mainAmount(ev.amount, info) : null, pairReceived: ev ? pairAmount(ev.mainPairReceived, info) : null };
  }

  /** Pay out unclaimed rewards in the main. With a loan open, only the part not needed as collateral. Returns `claimed`. */
  async claim(opts: VaultOptions | null = {}): Promise<VaultClaimResult> {
    const { info, vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    const me = this.account;
    const [pos, earned] = await Promise.all([
      this.rawPosition(vault, info.main, me),
      this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'earned', args: [info.main, me] }),
    ]);
    const total = pos.staked + earned;
    const free = total > pos.pledged ? total - pos.pledged : 0n;
    if ((earned < free ? earned : free) === 0n) {
      throw new ValidationError('Nothing to claim', earned === 0n ? 'No unclaimed rewards.' : 'All unclaimed rewards back the loan.');
    }
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'claim', args: [info.main], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'RewardsClaimed', vault, 'Vault', ['claimed']);
    return { ...tx, claimed: ev ? mainAmount(ev.amount, info) : null };
  }

  /** Add the unclaimed rewards to the stake (nothing leaves the vault). Returns `compounded`. */
  async compound(opts: VaultOptions | null = {}): Promise<VaultCompoundResult> {
    const { info, vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    const earned = await this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'earned', args: [info.main, this.account] });
    if (earned === 0n) throw new ValidationError('Nothing to compound', 'No unclaimed rewards.');
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'compound', args: [info.main], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'RewardsCompounded', vault, 'Vault', ['compounded']);
    return { ...tx, compounded: ev ? mainAmount(ev.amount, info) : null };
  }


  /**
   * Borrow the pair asset against `amount` (raw main) of the position for `days` (within the main's loan-day range).
   * Pledges in the same call (no lock step). One loan per position: use `addToLoan` when one is open. Refused, in this
   * order, with: "Main not on this vault", "Position active. Use addToLoan", "Hook not registered" (borrowing is not
   * set up on this vault), "Zero amount", "Insufficient collateral value" (above the unpledged stake), "Contract low on
   * liquidity" (the vault has too little free main to pledge), "pair not active" (the main's pair is paused),
   * "Ecosystem inactive", "Unauthorized caller" (vault loans are not open on this main right now), "incorrect loan
   * duration", "Minimum loan amount not met", "pair asset paused" (its issuer paused the pair asset), "No stable
   * received" (the fee takes the whole value). `quoteBorrow` previews it. Returns `hubId`, `hub`, `pledged` and
   * `received`.
   */
  async borrow(amount: bigint, days: bigint | number, opts: VaultOptions | null = {}): Promise<VaultBorrowResult> {
    const o = optsOf(opts, VAULT_KEYS);
    const amt = toUint(amount, 'amount');
    const d = toUint(days, 'days');
    const { info, vault } = await this.ctx(o, true);
    const { error } = await this.borrowPlan(info, vault, null, this.account, amt, d);
    if (error) throw error;
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'borrow', args: [info.main, amt, d], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'LoanTaken', vault, 'Vault', ['hubId', 'hub', 'pledged', 'received']);
    return {
      ...tx, hubId: ev?.hubId ?? null, hub: ev?.hub ?? null,
      pledged: ev ? mainAmount(ev.stasisPledged, info) : null, received: ev ? pairAmount(ev.mainPairReceived, info) : null,
    };
  }

  /**
   * Pledge `amount` (raw main) more to the open loan and receive more pair asset (the added collateral value minus the
   * fee for the days left; the end date stays). Refused, in this order, with: "Main not on this vault", "No active
   * loan", "Zero amount", "Insufficient collateral value", "Contract low on liquidity", "pair not active" (the main's
   * pair is paused), "Loan not active", "Duration too short" (too few days left: extend first), "No borrowing power",
   * "Fees exceed value", "pair asset paused" (its issuer paused the pair asset).
   * `quoteAddToLoan` previews it. Returns `pledged` and `received`.
   */
  async addToLoan(amount: bigint, opts: VaultOptions | null = {}): Promise<VaultAddToLoanResult> {
    const o = optsOf(opts, VAULT_KEYS);
    const amt = toUint(amount, 'amount');
    const { info, vault } = await this.ctx(o, true);
    const { error } = await this.addPlan(info, vault, null, this.account, amt);
    if (error) throw error;
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'addToLoan', args: [info.main, amt], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'LoanAdded', vault, 'Vault', ['pledged', 'received']);
    return { ...tx, pledged: ev ? mainAmount(ev.additionalStasis, info) : null, received: ev ? pairAmount(ev.mainPairReceived, info) : null };
  }

  /**
   * Repay the loan in full (there is no partial repay: it always closes the loan). Approves the debt (`fullAmount`, raw
   * pair asset) to the vault. The pledge is released. Refused before the approval: "No active loan", "Core loan
   * inactive" (the loan is no longer active, e.g. liquidated), "pair asset paused" (its issuer paused the pair asset:
   * the debt cannot be paid in until it is unpaused), "balance". Returns `hubId` and `returned` (main released back to
   * the position).
   */
  async repay(opts: VaultOptions | null = {}): Promise<VaultRepayResult> {
    const { info, vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    const pos = await this.rawPosition(vault, info.main, this.account);
    if (!pos.hasActiveLoan) throw new ValidationError('No active loan', 'This position has no loan.');
    const loan = await this.hubLoan(vault, pos);
    if (!loan.active) throw new ValidationError('Core loan inactive', `Hub loan ${pos.hubId} is not active.`);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'the loan cannot be repaid in it now');
    await this.checkBalance(info.pairAsset, loan.fullAmount, info.pairSymbol);
    await this.ensureAllowance(info.pairAsset, vault, loan.fullAmount);
    const tx = await this.send({ address: vault, abi: VaultAbi, functionName: 'repay', args: [info.main], contract: 'Vault' });
    const ev = this.expectEvent(tx, VaultAbi, 'LoanRepaid', vault, 'Vault', ['hubId', 'returned']);
    return { ...tx, hubId: ev?.hubId ?? null, returned: ev ? mainAmount(ev.stasisReturned, info) : null };
  }

  /**
   * Extend the loan by `days` (the main's range, or 0 for a refinance). The days count from the due date, or from the
   * time of the transaction when the loan is past due (not yet liquidated): the new due date is the later of the two
   * plus `days`. `payInPairAsset` pays the fee from the wallet (approved to the vault); otherwise it is added to the
   * debt, or a refinance pays the surplus out. Refused, in this order, with: "No active loan"; then "pair not active"
   * (the main's pair is paused) and "pair asset paused" (its issuer paused the pair asset), before any approval; for a
   * pay-in, "not possible" (any failure, 0 days and days out of range included); "Pay in stable or refinance, not
   * both"; then, for add-to-debt and refinance, the loan rules ("Must be refinance if not extending time", "incorrect
   * loan duration", "Loan not active", "Not enough collateral to cover fees", "No equity", "Minimum surplus not met",
   * "Time remaining too short", "Fees exceed surplus value"). Returns `newLiquidationTime`, `newFullAmount` and the
   * refinance payout `extraOut`.
   */
  async extendLoan(days: bigint | number, payInPairAsset: boolean, refinance: boolean, opts: VaultOptions | null = {}): Promise<VaultExtendResult> {
    const o = optsOf(opts, VAULT_KEYS);
    const d = toUint(days, 'days');
    payInPairAsset = toBool(payInPairAsset, 'payInPairAsset');
    refinance = toBool(refinance, 'refinance');
    const { info, vault } = await this.ctx(o);
    const pos = await this.rawPosition(vault, info.main, this.account);
    if (!pos.hasActiveLoan) throw new ValidationError('No active loan', 'This position has no loan.');
    const loan = await this.hubLoan(vault, pos);
    const [q, live] = await Promise.all([
      this.extensionEligibility(pos, loan.ecosystem, loan.coreLoanId, d, payInPairAsset, refinance),
      isPairActive(this.client, loan.ecosystem),
    ]);
    if (!live) throw pairNotActive(loan.ecosystem, info.symbol);
    await refusePausedAsset(this.client, info.pairAsset, info.pairSymbol, 'no extension can take its fee');
    if (payInPairAsset && !q.possible) {
      const [minD, maxD] = await this.dayRange(loan.ecosystem);
      const why = !loan.active ? `hub loan ${pos.hubId} is not active`
        : d === 0n ? '0 days is only allowed for a refinance without a pay-in' : `days must be ${minD}-${maxD} on this main, got ${d}`;
      throw new ValidationError('not possible', `The loan cannot be extended with a pay-in: ${why}.`);
    }
    if (payInPairAsset && refinance) {
      throw new ValidationError('Pay in stable or refinance, not both', 'Choose either payInPairAsset or refinance, not both.');
    }
    if (!payInPairAsset) {
      const refusal = await coreExtendRefusal(this.client, loan.ecosystem, loan, d, false, refinance, q);
      if (refusal) throw refusal;
    } else {
      await this.checkBalance(info.pairAsset, q.fee, info.pairSymbol);
      await this.ensureAllowance(info.pairAsset, vault, q.fee);
    }
    const tx = await this.send({
      address: vault, abi: VaultAbi, functionName: 'extendLoan', args: [info.main, d, payInPairAsset, refinance], contract: 'Vault',
    });
    const core = this.events(tx, MainTokenAbi, 'LoanExtended', loan.ecosystem).find((e) => eq(e.user, pos.hub) && e.loanId === loan.coreLoanId);
    if (!core) addMissingEventWarning(tx, 'MainToken', 'LoanExtended', ['newLiquidationTime', 'newFullAmount']);
    const extraOut = refinance ? this.events(tx, VaultAbi, 'RefinanceSurplus', vault)[0]?.mainPairReceived ?? 0n : 0n;
    return {
      ...tx, newLiquidationTime: core?.newLiquidationTime ?? null,
      newFullAmount: core ? pairAmount(core.newFullAmount, info) : null, extraOut: pairAmount(extraOut, info),
    };
  }


  /**
   * The live position of `user` (default the signer) on the main, with `earned`, `collateralOf`, `freeToUnstake`
   * and `availableStasis` (all read on chain: the API serves only the stored stake).
   */
  async getPosition(user?: Address, opts: VaultOptions | null = {}): Promise<VaultPosition> {
    const o = optsOf(opts, VAULT_KEYS);
    const who = user == null ? this.account : toAddress(user, 'user');
    const { info, vault } = await this.ctx(o);
    return this.toPosition(info, vault, who, await multicall(this.client, this.positionReads(info, vault, who)));
  }

  /**
   * The live positions of `user` (default the signer) on every listed main, on its current vault and on each of
   * `opts.vaults` (vaults a main moved away from; an array, null = none: anything else is refused, rule `vaults`,
   * before any read), skipping empty ones (no stake, no unclaimed rewards, no open loan). One multicall for all of
   * them.
   */
  async getPositions(user?: Address, opts: GetVaultPositionsOptions | null = {}): Promise<VaultPosition[]> {
    const o = optsOf(opts, GET_VAULT_POSITIONS_KEYS);
    const who = user == null ? this.account : toAddress(user, 'user');
    if (o.vaults != null && !Array.isArray(o.vaults as unknown)) throw new ValidationError('vaults', 'vaults must be an array of vault addresses.');
    const extra = Array.from(o.vaults ?? [], (v) => this.checkVault(v));
    const seen = new Set<string>();
    const pairs: { info: MainInfo; vault: Address }[] = [];
    for (const m of await this.client.mains.list()) {
      for (const v of [m.vault, ...extra]) {
        const id = `${m.main}:${v}`.toLowerCase();
        if (isZeroAddress(v) || seen.has(id)) continue;
        seen.add(id);
        pairs.push({ info: m, vault: v });
      }
    }
    const res = await multicall(this.client, pairs.flatMap(({ info, vault }) => this.positionReads(info, vault, who)));
    const n = POSITION_READS;
    return pairs
      .map(({ info, vault }, i) => this.toPosition(info, vault, who, res.slice(i * n, (i + 1) * n)))
      .filter((p) => p.staked.raw > 0n || p.earned.raw > 0n || p.hasActiveLoan);
  }

  /** The loan behind `user`'s position (default the signer), or null without an open loan. */
  async getVaultLoan(user?: Address, opts: VaultOptions | null = {}): Promise<VaultLoan | null> {
    const o = optsOf(opts, VAULT_KEYS);
    const who = user == null ? this.account : toAddress(user, 'user');
    const { info, vault } = await this.ctx(o);
    const pos = await this.rawPosition(vault, info.main, who);
    if (!pos.hasActiveLoan) return null;
    const d = await this.hubLoan(vault, pos);
    const m = (raw: bigint) => mainAmount(raw, info);
    const p = (raw: bigint) => pairAmount(raw, info);
    return {
      main: info.main, vault, hub: pos.hub, hubId: d.hubId, ecosystem: d.ecosystem, coreLoanId: d.coreLoanId,
      collateralToken: d.collateralToken, token: d.token,
      collateralAmount: m(d.collateralAmount), liquidatedAmount: m(d.liquidatedAmount),
      fullAmount: p(d.fullAmount), borrowedAmount: p(d.borrowedAmount),
      liquidationTime: d.liquidationTime, liquidationClaim: m(d.liquidationClaim),
      isLiquidated: d.isLiquidated, active: d.active, creationTime: d.creationTime,
    };
  }

  /**
   * Preview `extendLoan` for `user`'s (default the signer) loan. Both flags at once are never possible (`possible`
   * false, `fee` and `extraOut` 0). On a paused pair (`extendLoan` refuses "pair not active") and while the pair
   * asset's issuer has paused it ("pair asset paused") `possible` is false; the figures stay.
   */
  async getExtensionQuote(
    days: bigint | number, payInPairAsset: boolean, refinance: boolean, opts: VaultUserOptions | null = {},
  ): Promise<VaultExtensionQuote> {
    const o = optsOf(opts, VAULT_USER_KEYS);
    const d = toUint(days, 'days');
    payInPairAsset = toBool(payInPairAsset, 'payInPairAsset');
    refinance = toBool(refinance, 'refinance');
    const who = o.user == null ? this.account : toAddress(o.user, 'user');
    const { info, vault } = await this.ctx(o);
    const pos = await this.rawPosition(vault, info.main, who);
    if (!pos.hasActiveLoan) throw new ValidationError('No active loan', 'This position has no loan.');
    const loan = await this.hubLoan(vault, pos);
    const zero = pairAmount(0n, info);
    if (payInPairAsset && refinance) return { possible: false, fee: zero, extraOut: zero };
    const [q, live] = await Promise.all([
      this.extensionEligibility(pos, loan.ecosystem, loan.coreLoanId, d, payInPairAsset, refinance),
      isPairActive(this.client, loan.ecosystem),
    ]);
    const possible = q.possible && live && !(await isAssetPaused(this.client, info.pairAsset));
    return { possible, fee: pairAmount(q.fee, info), extraOut: pairAmount(q.extraOut, info) };
  }

  /**
   * Preview `borrow(amount, days, opts)` for `user` (default the signer): the value of the pledge (= the debt), the
   * fees and what the wallet receives, in the pair asset, plus `possible` / `refusal` from the same checks `borrow` runs,
   * in the same order. With `possible`, `borrowed` is what `borrow` pays in the same state. An `opts.vault` that is
   * not the main's current vault gives `refusal` "Main not on this vault".
   */
  async quoteBorrow(amount: bigint, days: bigint | number, opts: VaultUserOptions | null = {}): Promise<VaultBorrowQuote> {
    const o = optsOf(opts, VAULT_USER_KEYS);
    const amt = toUint(amount, 'amount');
    const d = toUint(days, 'days');
    const who = o.user == null ? this.account : toAddress(o.user, 'user');
    const { info, vault, listed } = await this.ctx(o);
    const p = await this.borrowPlan(info, vault, listed ? null : this.notOnVault(info, vault), who, amt, d);
    const pa = (raw: bigint) => pairAmount(raw, info);
    return {
      main: info.main, vault, hub: p.hub, collateralValue: pa(p.value), fee: pa(p.fee),
      borrowed: pa(p.value > p.fee ? p.value - p.fee : 0n), meetsMinimum: p.value >= p.minimumLoan,
      possible: p.error === null, refusal: p.error?.rule ?? null,
    };
  }

  /**
   * Preview `addToLoan(amount, opts)` for `user` (default the signer), as it would run in the next block (latest + 1 s):
   * the value of the whole pledge after the add, the value added to the debt, the fee (on the added value, for the whole
   * days left) and what the wallet receives, in the pair asset, plus `possible` / `refusal` from the same checks
   * `addToLoan` runs ("Fees exceed value" also allows for a block with the latest block's time, which can leave one more
   * whole day). Without a loan: zero figures and `refusal` "No active loan".
   */
  async quoteAddToLoan(amount: bigint, opts: VaultUserOptions | null = {}): Promise<VaultAddToLoanQuote> {
    const o = optsOf(opts, VAULT_USER_KEYS);
    const amt = toUint(amount, 'amount');
    const who = o.user == null ? this.account : toAddress(o.user, 'user');
    const { info, vault, listed } = await this.ctx(o);
    const p = await this.addPlan(info, vault, listed ? null : this.notOnVault(info, vault), who, amt);
    const pa = (raw: bigint) => pairAmount(raw, info);
    return {
      main: info.main, vault, hub: p.hub, hubId: p.hubId, newCollateralValue: pa(p.newCollateralValue),
      addedValue: pa(p.addedValue), fee: pa(p.fee), borrowed: pa(p.addedValue > p.fee ? p.addedValue - p.fee : 0n),
      daysLeft: p.daysLeft, possible: p.error === null, refusal: p.error?.rule ?? null,
    };
  }

  /** Collateral not yet pledged: what `user` (default the signer) can still borrow against, main units. */
  async getAvailableStasis(user?: Address, opts: VaultOptions | null = {}): Promise<Amount> {
    const o = optsOf(opts, VAULT_KEYS);
    const who = user == null ? this.account : toAddress(user, 'user');
    const { info, vault } = await this.ctx(o);
    const raw = await this.publicClient.readContract({
      address: vault, abi: VaultAbi, functionName: 'getAvailableStasis', args: [info.main, who],
    });
    return mainAmount(raw, info);
  }

  /** The main's totals on the vault: staked, pledged, rewards held, main free to pledge, and a raw reward index. */
  async getVaultTotals(opts: VaultOptions | null = {}): Promise<VaultTotals> {
    const { info, vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    const pc = this.publicClient;
    const [[totalStaked, totalPledged, rewardsHeld, accRewardPerStake], totalStasisAvailable] = await Promise.all([
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'pools', args: [info.main] }),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'totalStasisAvailable', args: [info.main] }),
    ]);
    const m = (raw: bigint) => mainAmount(raw, info);
    return {
      main: info.main, vault,
      totalStaked: m(totalStaked), totalPledged: m(totalPledged), rewardsHeld: m(rewardsHeld),
      totalStasisAvailable: m(totalStasisAvailable), accRewardPerStake,
    };
  }

  /**
   * The staker and main behind vault loan `hubId` on `hub` (default: `getLoanHub()`); null when the vault has no open
   * loan with that id there (also after a repay or a liquidation).
   */
  async getLoanOwner(hubId: bigint | number, opts: VaultLoanOwnerOptions | null = {}): Promise<VaultLoanOwner | null> {
    const o = optsOf(opts, VAULT_LOAN_OWNER_KEYS);
    const id = toUint(hubId, 'hubId');
    const given = o.hub == null ? null : toAddress(o.hub, 'hub');
    const { vault } = await this.ctx(o);
    const hub = given ?? await this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'loanHub' });
    const [user, main] = await this.publicClient.readContract({
      address: vault, abi: VaultAbi, functionName: 'loanOwner', args: [hub, id],
    });
    return isZeroAddress(user) ? null : { user, main };
  }

  /** Minimum stake, main units. */
  async getMinStake(opts: VaultOptions | null = {}): Promise<Amount> {
    const { info, vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    const raw = await this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'minStake' });
    return mainAmount(raw, info);
  }

  /** The loan hub new vault loans open on; an open loan stays on its position's `hub`. */
  async getLoanHub(opts: VaultOptions | null = {}): Promise<Address> {
    const { vault } = await this.ctx(optsOf(opts, VAULT_KEYS));
    return this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'loanHub' });
  }


  /**
   * The main and the vault to act on: `opts.vault` when given, else the main's current vault. `listed`: that vault is
   * the main's current one. `entry` (stake / borrow / addToLoan): a main without a vault, or an override that is not
   * its current vault, is refused. The override is checked before any read. `o`: the caller's options, already through
   * `optsOf`.
   */
  private async ctx(o: VaultOptions, entry = false): Promise<{ info: MainInfo; vault: Address; listed: boolean }> {
    const override = o.vault == null ? null : this.checkVault(o.vault);
    const info = o.main == null ? await this.client.mains.default() : await this.client.mains.get(o.main);
    const listed = override == null || (!isZeroAddress(info.vault) && override.toLowerCase() === info.vault.toLowerCase());
    if (entry && (isZeroAddress(info.vault) || !listed)) throw this.notOnVault(info, override);
    return { info, vault: override ?? this.require(info.vault, 'Vault'), listed };
  }

  /** "Main not on this vault": an entry on a main with no vault, or on another vault than its current one. */
  private notOnVault(info: MainInfo, vault: Address | null): ValidationError {
    return new ValidationError(
      'Main not on this vault',
      isZeroAddress(info.vault)
        ? `SWAP lists no staking vault for ${info.symbol} (${info.main}).`
        : `SWAP lists ${info.vault} as the vault of ${info.symbol}, not ${vault}: stake, borrow and addToLoan only run there.`,
    );
  }

  /**
   * What `borrow(amt, days)` by `who` would do now, and the first rule it would fail (null when it goes through), in
   * the order `borrow` lists them; `entry` is the "Main not on this vault" refusal, or null. The issuer pause is read
   * only when the rules before it pass. Raw pair asset.
   */
  private async borrowPlan(info: MainInfo, vault: Address, entry: ValidationError | null, who: Address, amt: bigint, days: bigint) {
    const pc = this.publicClient;
    const main = info.main;
    const [live, pos, available, idle, hub, minimumLoan, staticFee, mainHub, [minD, maxD], value] = await Promise.all([
      isPairActive(this.client, main),
      this.rawPosition(vault, main, who),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'getAvailableStasis', args: [main, who] }),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'totalStasisAvailable', args: [main] }),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'loanHub' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'minimumLoan' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'staticFeePercentage' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'LOAN' }),
      this.dayRange(main),
      amt === 0n ? 0n : pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getColleteralValue', args: [amt, main] }),
    ]);
    const [hooked, eco] = await Promise.all([
      pc.readContract({ address: hub, abi: LoanHubAbi, functionName: 'liquidationHook', args: [vault] }),
      pc.readContract({ address: hub, abi: LoanHubAbi, functionName: 'ecosystems', args: [main] }),
    ]);
    const inRange = days >= minD && days <= maxD;
    const dynamic = await pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'getDynamicFee', args: [value, days] })
      .catch((e: unknown) => {
        if (inRange) throw e;
        return 0n;
      });
    const fee = (value * staticFee) / 10_000n + dynamic;
    const plan = (error: ValidationError | null) => ({ hub, value, fee, minimumLoan, error });
    if (entry) return plan(entry);
    if (pos.hasActiveLoan) return plan(new ValidationError('Position active. Use addToLoan', 'This position already has a loan; use addToLoan.'));
    if (!hooked) return plan(new ValidationError('Hook not registered', `The loan hub ${hub} is not set up for vault ${vault}: borrowing is not available there.`));
    if (amt === 0n) return plan(new ValidationError('Zero amount', 'Amount must be greater than 0.'));
    if (amt > available) return plan(new ValidationError('Insufficient collateral value', `Only ${available} raw ${info.symbol} is available to borrow against, got ${amt}.`));
    if (amt > idle) return plan(new ValidationError('Contract low on liquidity', `The vault has only ${idle} raw ${info.symbol} free to pledge.`));
    if (!live) return plan(pairNotActive(main, info.symbol));
    if (!eco[2]) return plan(new ValidationError('Ecosystem inactive', `Main ${main} is not active on the loan hub ${hub}.`));
    if (!eq(mainHub, hub)) {
      return plan(new ValidationError('Unauthorized caller', `Main ${main} takes new loans from hub ${mainHub}, not the vault's hub ${hub}.`));
    }
    if (!inRange) return plan(new ValidationError('incorrect loan duration', `Days must be ${minD}-${maxD} on this main, got ${days}.`));
    if (value < minimumLoan) {
      return plan(new ValidationError('Minimum loan amount not met', `Collateral value ${value} is below the minimum loan ${minimumLoan} (raw ${info.pairSymbol}).`));
    }
    if (await isAssetPaused(this.client, info.pairAsset)) return plan(pairAssetPaused(info.pairAsset, info.pairSymbol, 'no loan can pay it out'));
    if (fee >= value) {
      return plan(new ValidationError('No stable received', `The loan fees would take the whole collateral value ${value} (raw ${info.pairSymbol}); borrow for fewer days.`));
    }
    return plan(null);
  }

  /**
   * What `addToLoan(amt)` by `who` would do in the next block (latest + 1 s), and the first rule it would fail (null
   * when it goes through), in the order `addToLoan` lists them; `entry` is the "Main not on this vault" refusal, or
   * null. The issuer pause is read only when the rules before it pass. Raw pair asset; all 0 without a loan. The days
   * left (and the fee quoted on them) count from the next block, as "Duration too short" does (a later block only
   * leaves fewer days). "Fees exceed value" is checked on the days left at the latest block: on a chain with about 10
   * blocks a second the add can mine in a block with the same time, one more whole day (a higher fee) when the loan
   * ends a whole number of days after it.
   */
  private async addPlan(info: MainInfo, vault: Address, entry: ValidationError | null, who: Address, amt: bigint) {
    const pc = this.publicClient;
    const [live, pos, available, idle] = await Promise.all([
      isPairActive(this.client, info.main),
      this.rawPosition(vault, info.main, who),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'getAvailableStasis', args: [info.main, who] }),
      pc.readContract({ address: vault, abi: VaultAbi, functionName: 'totalStasisAvailable', args: [info.main] }),
    ]);
    let f = { active: false, timeOk: false, minDays: 0n, daysLeft: 0n, newCollateralValue: 0n, fullAmount: 0n, addedValue: 0n, fee: 0n, feeMost: 0n };
    if (pos.hasActiveLoan) {
      const loan = await this.hubLoan(vault, pos);
      const eco = loan.ecosystem;
      const [minDays, block, newCollateralValue, staticFee] = await Promise.all([
        pc.readContract({ address: eco, abi: MainTokenAbi, functionName: 'minDaysLoan' }),
        pc.getBlock(),
        pc.readContract({ address: eco, abi: MainTokenAbi, functionName: 'getColleteralValue', args: [loan.collateralAmount + amt, loan.token] }),
        pc.readContract({ address: eco, abi: MainTokenAbi, functionName: 'staticFeePercentage' }),
      ]);
      const latest = block.timestamp;
      const next = latest + 1n;
      const daysAt = (t: bigint) => (loan.liquidationTime > t ? (loan.liquidationTime - t) / DAY : 0n);
      const daysLeft = daysAt(next);
      const mostDays = daysAt(latest);
      const addedValue = newCollateralValue > loan.fullAmount ? newCollateralValue - loan.fullAmount : 0n;
      const dynamicFor = async (days: bigint) => (addedValue === 0n ? 0n
        : pc.readContract({ address: eco, abi: MainTokenAbi, functionName: 'getDynamicFee', args: [addedValue, days] }));
      const staticPart = (addedValue * staticFee) / 10_000n;
      const fee = staticPart + await dynamicFor(daysLeft);
      f = {
        active: loan.active, timeOk: next + minDays * DAY < loan.liquidationTime, minDays, daysLeft, newCollateralValue,
        fullAmount: loan.fullAmount, addedValue, fee,
        feeMost: mostDays === daysLeft ? fee : staticPart + await dynamicFor(mostDays),
      };
    }
    const plan = (error: ValidationError | null) => ({
      hub: pos.hub, hubId: pos.hubId, newCollateralValue: f.newCollateralValue, addedValue: f.addedValue, fee: f.fee,
      daysLeft: f.daysLeft, error,
    });
    if (entry) return plan(entry);
    if (!pos.hasActiveLoan) return plan(new ValidationError('No active loan', 'This position has no loan; use borrow.'));
    if (amt === 0n) return plan(new ValidationError('Zero amount', 'Amount must be greater than 0.'));
    if (amt > available) return plan(new ValidationError('Insufficient collateral value', `Only ${available} raw ${info.symbol} is available, got ${amt}.`));
    if (amt > idle) return plan(new ValidationError('Contract low on liquidity', `The vault has only ${idle} raw ${info.symbol} free to pledge.`));
    if (!live) return plan(pairNotActive(info.main, info.symbol));
    if (!f.active) return plan(new ValidationError('Loan not active', `Hub loan ${pos.hubId} is not active.`));
    if (!f.timeOk) return plan(new ValidationError('Duration too short', `Less than ${f.minDays} days left on the loan; extend it first.`));
    if (f.newCollateralValue <= f.fullAmount) {
      return plan(new ValidationError('No borrowing power', `The collateral after the add is worth ${f.newCollateralValue}, not above the debt ${f.fullAmount} (raw ${info.pairSymbol}).`));
    }
    if (f.feeMost >= f.addedValue) {
      return plan(new ValidationError('Fees exceed value', `The fees on the added value ${f.addedValue} (raw ${info.pairSymbol}) would take all of it.`));
    }
    if (await isAssetPaused(this.client, info.pairAsset)) return plan(pairAssetPaused(info.pairAsset, info.pairSymbol, 'no top-up can pay it out'));
    return plan(null);
  }

  /** A vault the caller typed (`toAddress`, rule `vault`), checksummed; the zero address is refused. */
  private checkVault(vault: unknown): Address {
    const v = toAddress(vault, 'vault');
    if (isZeroAddress(v)) throw new ValidationError('vault', `vault must be a non-zero address, got ${v}.`);
    return v;
  }

  private dayRange(main: Address): Promise<[bigint, bigint]> {
    return Promise.all([
      this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'minDaysLoan' }),
      this.publicClient.readContract({ address: main, abi: MainTokenAbi, functionName: 'maxDaysLoan' }),
    ]);
  }

  /** The `POSITION_READS` reads behind one position, in `toPosition`'s order (for one multicall). */
  private positionReads(info: MainInfo, vault: Address, who: Address): MulticallRead[] {
    const args = [info.main, who] as const;
    return (['positions', 'earned', 'collateralOf', 'freeToUnstake', 'getAvailableStasis'] as const).map((functionName) => ({
      address: vault, abi: VaultAbi, functionName, args, contract: 'Vault',
    }));
  }

  private toPosition(info: MainInfo, vault: Address, who: Address, res: readonly unknown[]): VaultPosition {
    const r = res[0] as readonly [bigint, bigint, bigint, bigint, bigint, Address];
    const p = { staked: r[0], pledged: r[1], hubId: r[2], checkpoint: r[3], pending: r[4], hub: r[5], hasActiveLoan: !isZeroAddress(r[5]) };
    const [earned, collateral, free, available] = res.slice(1) as bigint[];
    const m = (raw: bigint) => mainAmount(raw, info);
    return {
      main: info.main, vault, user: who,
      staked: m(p.staked), pledged: m(p.pledged), hubId: p.hubId, hasActiveLoan: p.hasActiveLoan,
      checkpoint: p.checkpoint, pending: m(p.pending), hub: p.hub,
      earned: m(earned), collateralOf: m(collateral), freeToUnstake: m(free), availableStasis: m(available),
    };
  }

  /** The raw position; a loan is open when `hub` is not the zero address. */
  private async rawPosition(vault: Address, main: Address, user: Address): Promise<RawPosition> {
    const r = await this.publicClient.readContract({ address: vault, abi: VaultAbi, functionName: 'positions', args: [main, user] });
    return { staked: r[0], pledged: r[1], hubId: r[2], checkpoint: r[3], pending: r[4], hub: r[5], hasActiveLoan: !isZeroAddress(r[5]) };
  }

  /** The position's loan details. */
  private async hubLoan(vault: Address, pos: RawPosition) {
    return this.publicClient.readContract({
      address: pos.hub, abi: LoanHubAbi, functionName: 'getUserLoanDetails', args: [vault, pos.hubId],
    });
  }

  /** The extension preview for the position's loan. */
  private async extensionEligibility(pos: RawPosition, main: Address, coreLoanId: bigint, days: bigint, pay: boolean, refinance: boolean) {
    const [possible, fee, extraOut] = await this.publicClient.readContract({
      address: main, abi: MainTokenAbi, functionName: 'extensionEligibility',
      args: [pos.hub, coreLoanId, days, false, pay, refinance],
    });
    return { possible, fee, extraOut };
  }

  private async checkBalance(token: Address, amount: bigint, symbol: string): Promise<void> {
    const bal = await this.balanceOf(token);
    if (bal < amount) throw new ValidationError('balance', `Balance of ${symbol} is ${bal}, below the ${amount} needed.`);
  }
}
