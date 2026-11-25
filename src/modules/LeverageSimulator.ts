import type { Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { LeverageAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { BaseModule } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { LeverageRaw, type Raw, type RawEndResult, type RawLoanResult } from '../core/leverageRaw';
import { mainAmount, pairAmount, type MainInfo, type MainRef } from '../core/mains';
import { Amount, toAddress, toUint } from '../core/units';

/** What a leverage open would do. Pair asset amounts are raw. */
export interface LeverageEndResult {
  /** Pair asset to repay. */
  totalRepay: bigint;
  /** Pair asset borrowed in total. */
  totalBorrowed: bigint;
  /** Tokens held as collateral (raw units of the bought token). */
  totalCollateral: bigint;
  /** Pair asset paid in fees: trade fees and loan fees. */
  totalFees: bigint;
  /** Pair asset that went into buying (the amount less fees and any leftover). */
  realLiquidity: bigint;
  /** Main tokens bought. */
  xeAdded: bigint;
  /** Pair asset spent on main tokens. */
  mainPairAdded: bigint;
  /** Factory tokens bought (factory path only; 0 for a main path). */
  tokenAdded: bigint;
  /** The trade fee part of `totalFees`, at the rate of the wallet quoted (`trader`). */
  totalDexTax: bigint;
}

/** What a loan would pay out. Pair asset amounts are raw. */
export interface LoanResult {
  /** Pair asset value of the collateral. */
  collateralValue: bigint;
  /** The loan fee for the chosen days, raw pair asset. */
  totalFee: bigint;
  /** What the loan pays out, raw pair asset. */
  borrowedAmount: bigint;
}

/** Quotes for leverage and loans (the same figures a real open gets), plus prices and values. All views. */
export class LeverageSimulatorModule extends BaseModule {
  private readonly raw: LeverageRaw;

  constructor(client: BasisClient) {
    super(client);
    this.raw = new LeverageRaw(client);
  }

  /** True when the leverage simulator is deployed on this chain. */
  get deployed(): boolean {
    return !isZeroAddress(this.client.addresses.leverage);
  }

  private get leverage(): Address {
    return this.require(this.client.addresses.leverage, 'Leverage');
  }


  /**
   * Leverage on a main, path `[pairAsset, main]`. `amount` raw pair asset. `leveragePct` (1-100): 100 quotes
   * `trading.leverageBuy`, 1-99 quotes `trading.mixedBuy` (lower keeps more of the position as debt-free collateral).
   * Priced at the rate of `trader` (default the signer; with neither, the list rate with no wallet discounts). This is
   * the exact quote the open gets when `trader` is the wallet opening. On an add to an open position, pass the days left
   * (`trading.quoteLeverage` does).
   */
  async simulateLeverageLocked(
    amount: bigint, path: readonly Address[], numberOfDays: bigint | number, leveragePct: number | bigint = 100, trader?: Address | null,
  ): Promise<LeverageEndResult> {
    if (path.length !== 2) throw new ValidationError('Path', `simulateLeverageLocked takes [pairAsset, main] (2 hops), got ${path.length}; use simulateLeverageFactoryLocked for a factory token.`);
    const pct = checkPct(leveragePct);
    const p = toPath(path);
    const who = trader == null ? undefined : toAddress(trader, 'trader');
    await this.checkLeveragePath(p);
    return toEndResult(await this.raw.simulateLeverage(amount, p, numberOfDays, pct, who));
  }

  /** `simulateLeverageLocked` for a factory token, path `[pairAsset, main, token]`. `amount` raw pair asset. */
  async simulateLeverageFactoryLocked(
    amount: bigint, path: readonly Address[], numberOfDays: bigint | number, leveragePct: number | bigint = 100, trader?: Address | null,
  ): Promise<LeverageEndResult> {
    if (path.length !== 3) throw new ValidationError('Path', `simulateLeverageFactoryLocked takes [pairAsset, main, token] (3 hops), got ${path.length}.`);
    const pct = checkPct(leveragePct);
    const p = toPath(path);
    const who = trader == null ? undefined : toAddress(trader, 'trader');
    await this.checkLeveragePath(p);
    return toEndResult(await this.raw.simulateLeverage(amount, p, numberOfDays, pct, who));
  }

  /** `simulateLeverageLocked` (path of 2) or `simulateLeverageFactoryLocked` (path of 3), picked by path length. `leveragePct` 100 = plain leverage. */
  async simulate(
    amount: bigint, path: readonly Address[], numberOfDays: bigint | number, leveragePct: number | bigint = 100, trader?: Address | null,
  ): Promise<LeverageEndResult> {
    return path.length === 3
      ? this.simulateLeverageFactoryLocked(amount, path, numberOfDays, leveragePct, trader)
      : this.simulateLeverageLocked(amount, path, numberOfDays, leveragePct, trader);
  }

  /** A loan on `boughtTokens` main tokens at `main`'s current price (`main` defaults to the default main). */
  async simulateLoanFor(main: MainRef | null | undefined, boughtTokens: Raw, numberOfDays: bigint | number): Promise<LoanResult> {
    const info = await this.mainInfo(main);
    const [r0, r1] = await this.raw.curveReserves(info.main, true);
    return toLoanResult(await this.raw.simulateLoan(info.main, boughtTokens, r0, r1, numberOfDays));
  }

  /** A loan on `boughtTokens` factory tokens, valued at the token's current floor. */
  async simulateLoanHybridFor(token: Address, boughtTokens: Raw, numberOfDays: bigint | number): Promise<LoanResult> {
    token = toAddress(token, 'token');
    return toLoanResult(await this.raw.simulateLoanHybrid(boughtTokens, await this.raw.simulationStateFor(token), numberOfDays));
  }


  /** The scale of prices in main per token (1e18). */
  async getPriceMultiplier(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.leverage, abi: LeverageAbi, functionName: 'PRICEMULTIPLIER' });
  }

  /** A factory token's current floor, in pair asset per token. The floor is measured in the pair asset, which can move itself. */
  async calculateFloorFor(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const [st, info] = await Promise.all([this.raw.simulationStateFor(token), this.client.mains.infoOfToken(token)]);
    const raw = await this.raw.calculateFloor({
      reversed: st.reversed, hybridMultiplier: st.multiplier, reserve0: st.reserve0, reserve1: st.reserve1,
      baseReserve0: st.basereserve0, baseReserve1: st.basereserve1, xereserve0: st.xereserve0, xereserve1: st.xereserve1,
    });
    return pairAmount(raw, info);
  }

  /** Current price: a main's in pair asset, a factory token's in main. */
  async getTokenPriceFor(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const isMain = await this.client.mains.isMain(token);
    const [[r0, r1], info] = await Promise.all([this.raw.curveReserves(token, isMain), this.client.mains.infoOfToken(token)]);
    const raw = await this.raw.getTokenPrice(r0, r1);
    return isMain ? pairAmount(raw, info) : mainAmount(raw, info);
  }

  /** Current price in pair asset, for a factory token or a main. */
  async getPairPriceFor(token: Address): Promise<Amount> {
    token = toAddress(token, 'token');
    const info = await this.client.mains.infoOfToken(token);
    if (info.main.toLowerCase() === token.toLowerCase()) {
      const [r0, r1] = await this.raw.curveReserves(token, true);
      return pairAmount(await this.raw.getTokenPrice(r0, r1), info);
    }
    const [[r0, r1], [x0, x1]] = await Promise.all([this.raw.curveReserves(token, false), this.raw.curveReserves(info.main, true)]);
    return pairAmount(await this.raw.getPairPrice(r0, r1, x0, x1), info);
  }

  /** Collateral value of `tokenAmount` (raw, 18 dec) now, in pair asset. A factory token is valued at its floor. */
  async getCollateralValueFor(token: Address, tokenAmount: Raw): Promise<Amount> {
    toUint(tokenAmount, 'tokenAmount');
    token = toAddress(token, 'token');
    const info = await this.client.mains.infoOfToken(token);
    if (info.main.toLowerCase() === token.toLowerCase()) {
      const [r0, r1] = await this.raw.curveReserves(token, true);
      return pairAmount(await this.raw.getCollateralValue(tokenAmount, r0, r1), info);
    }
    return pairAmount(await this.raw.getCollateralValueHybrid(tokenAmount, await this.raw.simulationStateFor(token)), info);
  }


  /**
   * Checks the path before simulating: `path[1]` must be a main, `path[0]` its pair asset and `path[2]` (if any) a
   * listed factory token on that main (a delisted token cannot be leveraged). Rule `Path`. An RPC failure of a read is
   * thrown as it came, never as a path refusal.
   */
  private async checkLeveragePath(path: readonly Address[]): Promise<void> {
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const [p0, main, token] = path;
    if (!(await this.client.mains.isMain(main))) throw new ValidationError('Path', `path[1] ${main} is not a main.`);
    const info = await this.client.mains.get(main);
    if (!eq(p0, info.pairAsset)) throw new ValidationError('Path', `path[0] must be ${info.pairSymbol} (${info.pairAsset}), the pair asset of ${main}; got ${p0}.`);
    if (token === undefined) return;
    if (await this.client.mains.isMain(token)) throw new ValidationError('Path', `path[2] ${token} is a main, not a factory token.`);
    if (!(await this.client.factory.isEcosystemToken(token))) {
      throw new ValidationError('Path', `path[2] ${token} is not a listed factory token: leverage is open on listed tokens only.`);
    }
    let quote: Address;
    try {
      quote = await this.client.mains.mainOf(token);
    } catch (e) {
      if (e instanceof ValidationError) throw new ValidationError('Path', `path[2] ${token} is not a factory token.`);
      throw e;
    }
    if (!eq(quote, main)) throw new ValidationError('Path', `path[2] ${token} trades against ${quote}, not ${main}.`);
  }

  private async mainInfo(main?: MainRef | null): Promise<MainInfo> {
    return main == null ? this.client.mains.default() : this.client.mains.get(main);
  }
}

/** A caller's path, every token through `toAddress` (rule `path`), checksummed. */
function toPath(path: readonly Address[]): Address[] {
  return path.map((t) => toAddress(t, 'path'));
}

/**
 * `leveragePct` must be a whole number 1-100 (rule "Range"): a bigint, or a number that is an integer.
 * Anything else (a string, a fraction, NaN, null, a boolean) is refused with the same rule, as in the PY SDK.
 */
function checkPct(v: unknown): bigint {
  const pct = typeof v === 'bigint' ? v : typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : null;
  if (pct === null || pct < 1n || pct > 100n) {
    throw new ValidationError('Range', `leveragePct must be a whole number 1-100, got ${String(v)}.`);
  }
  return pct;
}

function toEndResult(r: RawEndResult): LeverageEndResult {
  return {
    totalRepay: r.totalRepay,
    totalBorrowed: r.totalBorrowed,
    totalCollateral: r.totalCollateral,
    totalFees: r.totalFees,
    realLiquidity: r.realLiquidity,
    xeAdded: r.xeAdded,
    mainPairAdded: r.mainPairAdded,
    tokenAdded: r.tokenAdded,
    totalDexTax: r.totalDexTax,
  };
}

function toLoanResult(r: RawLoanResult): LoanResult {
  return { collateralValue: r.collateralValue, totalFee: r.totalFee, borrowedAmount: r.borrowedAmount };
}
