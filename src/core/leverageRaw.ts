import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { FactoryTokenAbi, LeverageAbi, MainTokenAbi, TaxesAbi } from '../abis';
import { ZERO_ADDRESS } from '../config/addresses';
import { BaseModule } from './BaseModule';
import { ValidationError } from './errors';
import { toBool, toUint } from './units';


/** A raw uint argument: `bigint`, or a whole JS number (taken as raw). Checked by `toUint`, errors name the argument. */
export type Raw = bigint | number;

/** The raw result of a leverage simulation (amounts raw). */
export interface RawEndResult {
  newXeReserve0: bigint;
  newXeReserve1: bigint;
  newReserve0: bigint;
  newReserve1: bigint;
  totalRepay: bigint;
  totalBorrowed: bigint;
  totalCollateral: bigint;
  totalFees: bigint;
  realLiquidity: bigint;
  xeAdded: bigint;
  mainPairAdded: bigint;
  tokenAdded: bigint;
  totalDexTax: bigint;
}

/** The raw result of a loan simulation (amounts raw). */
export interface RawLoanResult {
  collateralValue: bigint;
  totalFee: bigint;
  borrowedAmount: bigint;
  reserve0: bigint;
  reserve1: bigint;
  xereserve0: bigint;
  xereserve1: bigint;
  lpFee: bigint;
}

/** A factory token's state as a simulation takes it (`simulationStateFor` reads it as it is now). */
export interface SimulationState {
  amount: bigint;
  xereserve0: bigint;
  xereserve1: bigint;
  reserve0: bigint;
  reserve1: bigint;
  multiplier: bigint;
  reversed: boolean;
  basereserve0: bigint;
  basereserve1: bigint;
  minAmount: bigint;
  main: Address;
  taxRate: bigint;
}

/** The raw result of a simulated buy. */
export interface DexResult {
  dexTax: bigint;
  reserve0: bigint;
  reserve1: bigint;
  reserve0Added: bigint;
  reserve1Added: bigint;
  boughtTokens: bigint;
}

/** Inputs of `calculateFloor`. */
export interface FloorInputs {
  reversed: boolean;
  hybridMultiplier: bigint | number;
  reserve0: bigint;
  reserve1: bigint;
  baseReserve0: bigint;
  baseReserve1: bigint;
  xereserve0: bigint;
  xereserve1: bigint;
}

/** A token's or main's reserves as `readCurve` returns them. */
export interface CurveState {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: bigint;
}

export class LeverageRaw extends BaseModule {
  constructor(client: BasisClient) {
    super(client);
  }

  private get leverage(): Address {
    return this.require(this.client.addresses.leverage, 'Leverage');
  }

  /** Whose rate a quote is priced at: `trader`, else the signer, else the zero address (the list rate). */
  traderOf(trader?: Address): Address {
    return trader ?? this.client.account ?? ZERO_ADDRESS;
  }

  /** Simulates opening a leverage position: a path of 2 for a main, a path of 3 for a factory token. */
  async simulateLeverage(amount: bigint, path: readonly Address[], numberOfDays: bigint | number, leveragePct: bigint, trader?: Address): Promise<RawEndResult> {
    const args = [toUint(amount, 'amount'), path, toUint(numberOfDays, 'numberOfDays'), leveragePct, this.traderOf(trader)] as const;
    const r = await this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi,
      functionName: path.length === 3 ? 'simulateLeverageFactoryLocked' : 'simulateLeverageLocked', args,
    });
    return toEndResult(r);
  }

  async simulateDex(amount: Raw, taxRate: Raw, reserve0: Raw, reserve1: Raw): Promise<DexResult> {
    const r = await this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'simulateDex',
      args: [toUint(amount, 'amount'), toUint(taxRate, 'taxRate'), toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1')],
    });
    return { ...r };
  }

  async simulateDexFactory(amount: Raw, reserve0: Raw, reserve1: Raw, multiplier: bigint | number, reversed: boolean): Promise<DexResult> {
    const r = await this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'simulateDexFactory',
      args: [toUint(amount, 'amount'), toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1'), toUint(multiplier, 'multiplier'), toBool(reversed, 'reversed')],
    });
    return { ...r };
  }

  async simulateLoan(main: Address, boughtTokens: Raw, reserve0: Raw, reserve1: Raw, numberOfDays: bigint | number): Promise<RawLoanResult> {
    const r = await this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'simulateLoan',
      args: [main, toUint(boughtTokens, 'boughtTokens'), toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1'), toUint(numberOfDays, 'numberOfDays')],
    });
    return toLoanResult(r);
  }

  async simulateLoanHybrid(boughtTokens: Raw, state: SimulationState, numberOfDays: bigint | number): Promise<RawLoanResult> {
    const r = await this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'simulateLoanHybrid',
      args: [toUint(boughtTokens, 'boughtTokens'), stateArg(state), toUint(numberOfDays, 'numberOfDays')],
    });
    return toLoanResult(r);
  }

  async calculateTokensForBuy(mainPairAmount: Raw, reserve0: Raw, reserve1: Raw): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'calculateTokensForBuy',
      args: [toUint(mainPairAmount, 'mainPairAmount'), toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1')],
    });
  }

  async calculateFloor(p: FloorInputs): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'calculateFloor',
      args: [
        toBool(p.reversed, 'reversed'), toUint(p.hybridMultiplier, 'hybridMultiplier'), toUint(p.reserve0, 'reserve0'),
        toUint(p.reserve1, 'reserve1'), toUint(p.baseReserve0, 'baseReserve0'), toUint(p.baseReserve1, 'baseReserve1'),
        toUint(p.xereserve0, 'xereserve0'), toUint(p.xereserve1, 'xereserve1'),
      ],
    });
  }

  async getTokenPrice(reserve0: Raw, reserve1: Raw): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'getTokenPrice', args: [toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1')],
    });
  }

  async getPairPrice(reserve0: Raw, reserve1: Raw, xereserve0: Raw, xereserve1: Raw): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'getPairPrice',
      args: [toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1'), toUint(xereserve0, 'xereserve0'), toUint(xereserve1, 'xereserve1')],
    });
  }

  async getCollateralValue(tokenAmount: Raw, reserve0: Raw, reserve1: Raw): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'getColleteralValue',
      args: [toUint(tokenAmount, 'tokenAmount'), toUint(reserve0, 'reserve0'), toUint(reserve1, 'reserve1')],
    });
  }

  async getCollateralValueHybrid(tokenAmount: Raw, state: SimulationState): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.leverage, abi: LeverageAbi, functionName: 'getColleteralValueHybrid', args: [toUint(tokenAmount, 'tokenAmount'), stateArg(state)],
    });
  }

  /** The `SimulationState` of a factory token as it is now. `amount` defaults to 0. */
  async simulationStateFor(token: Address, amount = 0n, trader?: Address): Promise<SimulationState> {
    const main = await this.factoryMainOf(token);
    const t = { address: token, abi: FactoryTokenAbi } as const;
    const pc = this.publicClient;
    const [[reserve0, reserve1], [xereserve0, xereserve1], multiplier, reversed, basereserve0, basereserve1, mainBase1, taxRate] = await Promise.all([
      this.curveReserves(token, false),
      this.curveReserves(main, true),
      pc.readContract({ ...t, functionName: 'hybridMultiplier' }),
      pc.readContract({ ...t, functionName: 'reversed' }),
      pc.readContract({ ...t, functionName: 'baseReserve0' }),
      pc.readContract({ ...t, functionName: 'baseReserve1' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'baseReserve1' }),
      pc.readContract({ address: this.client.addresses.taxes, abi: TaxesAbi, functionName: 'getTaxRate', args: [token, this.traderOf(trader)] }),
    ]);
    const m = mainBase1 / 10_000n;
    return {
      amount: toUint(amount, 'amount'), xereserve0, xereserve1, reserve0, reserve1,
      multiplier: BigInt(multiplier), reversed, basereserve0, basereserve1, minAmount: m === 0n ? 1n : m, main, taxRate,
    };
  }

  /** The reserves of a factory token or a main. */
  async readCurve(tokenOrMain: Address): Promise<CurveState> {
    const [reserve0, reserve1, blockTimestampLast] = (await this.client.mains.isMain(tokenOrMain))
      ? await this.publicClient.readContract({ address: tokenOrMain, abi: MainTokenAbi, functionName: 'getCurveReserves' })
      : await this.publicClient.readContract({ address: tokenOrMain, abi: FactoryTokenAbi, functionName: 'getCurveReserves' });
    return { reserve0, reserve1, blockTimestampLast };
  }

  /** The reserves of `token` when the caller already knows whether it is a main. */
  async curveReserves(token: Address, isMain: boolean): Promise<[bigint, bigint]> {
    const [r0, r1] = isMain
      ? await this.publicClient.readContract({ address: token, abi: MainTokenAbi, functionName: 'getCurveReserves' })
      : await this.publicClient.readContract({ address: token, abi: FactoryTokenAbi, functionName: 'getCurveReserves' });
    return [r0, r1];
  }

  /** The main of a factory token; a `ValidationError` for a main. */
  private async factoryMainOf(token: Address): Promise<Address> {
    const main = await this.client.mains.mainOf(token);
    if (main.toLowerCase() === token.toLowerCase()) {
      throw new ValidationError('FactoryToken', `${token} is a main, not a factory token; use the main variants (getCollateralValueFor / simulateLoanFor).`);
    }
    return main;
  }
}

/** A `SimulationState` with every uint checked by `toUint` and `reversed` a bool. */
function stateArg(st: SimulationState): SimulationState {
  if (st === null || typeof st !== 'object') throw new ValidationError('state', `state must be a SimulationState, got ${String(st)}.`);
  return {
    amount: toUint(st.amount, 'amount'), xereserve0: toUint(st.xereserve0, 'xereserve0'), xereserve1: toUint(st.xereserve1, 'xereserve1'),
    reserve0: toUint(st.reserve0, 'reserve0'), reserve1: toUint(st.reserve1, 'reserve1'), multiplier: toUint(st.multiplier, 'multiplier'),
    reversed: toBool(st.reversed, 'reversed'), basereserve0: toUint(st.basereserve0, 'basereserve0'),
    basereserve1: toUint(st.basereserve1, 'basereserve1'), minAmount: toUint(st.minAmount, 'minAmount'), main: st.main,
    taxRate: toUint(st.taxRate, 'taxRate'),
  };
}

function toEndResult(r: {
  newXeReserve0: bigint; newXeReserve1: bigint; newReserve0: bigint; newReserve1: bigint; totalRepay: bigint;
  totalBorrowed: bigint; totalColleteral: bigint; totalFees: bigint; realLiquidity: bigint; xeAdded: bigint;
  mainPairAdded: bigint; tokenAdded: bigint; totalDexTax: bigint;
}): RawEndResult {
  const { totalColleteral, ...rest } = r;
  return { ...rest, totalCollateral: totalColleteral };
}

function toLoanResult(r: {
  colleteralValue: bigint; totalFee: bigint; borrowedAmount: bigint; reserve0: bigint; reserve1: bigint;
  xereserve0: bigint; xereserve1: bigint; lpFee: bigint;
}): RawLoanResult {
  const { colleteralValue, ...rest } = r;
  return { ...rest, collateralValue: colleteralValue };
}
