import { type Address, formatUnits, getAddress, isAddressEqual, parseUnits, zeroAddress } from 'viem';
import { ERC20Abi, FactoryTokenAbi, MarketResolverAbi, SwapAbi, TaxesAbi, TrancheMarketAbi, TrancheMarketPrivateAbi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import type { HostKind, HostRef } from './MarketReader';
import { BaseModule, type TxResult } from '../core/BaseModule';
import { ValidationError } from '../core/errors';
import { BasisContractError, rpcErrorKind } from '../core/revert';
import { addMissingEventWarning } from '../core/events';
import { isAssetPaused, pairAssetPaused } from '../core/loans';
import { type AmountOf, amountOf } from '../core/amounts';
import { optionKeys, optsOf } from '../core/opts';
import { type Amount, maxWithSlippage, optUint, parseAmount, toAddress, toAmount, toBool, toUint } from '../core/units';
import { trimAscii } from './metadataFields';

/**
 * Book prices are whole pair-asset units per share, scaled by 1e18: 1e18 = one USDG per share on a USDG main. They are
 * not the odds (`marketReader.getAllOutcomes` reports those).
 */
const PRICE_ONE = 10n ** 18n;
/** Lowest limit price the host takes: 0.001 of the pair asset per share (0 means market-priced). */
const PRICE_MIN = PRICE_ONE / 1000n;
/** Highest limit price the host takes: 1,000,000 of the pair asset per share. */
const PRICE_MAX = PRICE_ONE * 1_000_000n;
/** Order reads per batch in `getMarketOrders`. */
const READ_BATCH = 50;
/** A sweep spends its rest on the pool only above this (raw pair asset: fill dust). */
const AMM_DUST = 255n;

/** A market host: `'public'` (`addresses.tranche`), `'private'` (`addresses.tranchePrivate`) or a host address. */

/**
 * A null option (or null options) is left out, as None in PY: the default applies. Every method below takes `opts` null;
 * an `opts` that is not an options object (a positional `'public'`, a bigint) is `ValidationError('options')`, before any read.
 */
export interface HostOptions {
  /** The market's host. Omit (or null) to detect it. */
  host?: HostRef | null;
}
const HOST_KEYS = optionKeys<HostOptions>({ host: true });

/** A resolved host: its address, kind and ABI. */
interface Host {
  address: Address;
  kind: HostKind;
  contract: 'TrancheMarket' | 'TrancheMarketPrivate';
}

/** An order on a market's book. */
export interface MarketOrder {
  orderId: bigint;
  market: Address;
  host: Address;
  hostKind: HostKind;
  seller: Address;
  outcomeId: number;
  /** Shares still for sale (raw, 18 decimals). */
  amount: bigint;
  /** Shares listed originally (raw, 18 decimals). */
  totalAmount: bigint;
  /** Shares already filled (`totalAmount - amount`; a cancelled order keeps its unfilled remainder in `amount`). */
  filled: bigint;
  /**
   * Limit price: whole pair-asset units per share, scaled by 1e18 (1e18 = one pair asset per share). 0 = fills at the
   * live share price of the moment (`getSharePrice`).
   */
  pricePerShare: bigint;
  /** `pricePerShare` as a decimal string of the pair asset per share ("2.5"); "market" for a market-priced order. */
  price: string;
  isMarketPrice: boolean;
  /** Not cancelled and not fully filled. Orders on a resolved market stay "active" but can no longer be filled. */
  active: boolean;
}

/** `getBuyOrderCost`: what filling `fill` shares costs `buyer`, in the market's pair asset. */
export interface BuyOrderCost {
  /** The fill's base price (before fees). */
  baseCost: Amount;
  buyerTax: Amount;
  /** What the buyer pays (base + buyer tax): `buyOrder`'s `maxCost` is derived from this. */
  totalCostToBuyer: Amount;
  /** What the seller receives after their tax. */
  netToSeller: Amount;
}

/** `getBuyOrderAmountsOut`: how many shares `budget` fills on one order, as `buyer`. */
export interface BuyOrderAmountsOut {
  /**
   * Shares filled (raw, 18 decimals); 0 for a filled or cancelled order, for the buyer's own order, for an order priced
   * above the live share price, and when the fill would be worth less than 1 raw unit.
   */
  fill: bigint;
  baseCost: Amount;
  buyerTax: Amount;
  totalCostToBuyer: Amount;
}

export interface BuyOrderOptions extends HostOptions {
  /**
   * Explicit ceiling on what the buyer pays (raw pair asset, buyer tax included), never 0 (a fraction, a string or 0:
   * `ValidationError('maxCost')`, checked before any read). Omit to derive it from `getBuyOrderCost`.
   */
  maxCost?: bigint;
  /** Slippage over the quoted cost, bps (default `client.slippageBps.trade`). */
  slippageBps?: number;
}
const BUY_ORDER_KEYS = optionKeys<BuyOrderOptions>({ host: true, maxCost: true, slippageBps: true });

export interface BuyOrdersOptions extends HostOptions {
  /** Explicit minimum shares gained on `outcome` (raw, 18 decimals). Omit to derive it from the order quotes. Never 0. */
  minShares?: bigint;
  /** Slippage under the quoted shares, bps (default `client.slippageBps.trade`). */
  slippageBps?: number;
  /**
   * Spend what the orders leave on the AMM (`inputToken` = the market's pair asset). The AMM bet rules (`checkBuy`)
   * apply when that rest is above fill dust (255 raw), as on chain. Default false: orders only, the unspent budget
   * stays with the buyer. A real boolean (anything else: `ValidationError('amm')`).
   */
  amm?: boolean;
}
const BUY_ORDERS_KEYS = optionKeys<BuyOrdersOptions>({ host: true, minShares: true, slippageBps: true, amm: true });

export interface GetMarketOrdersOptions extends HostOptions {
  /** Only orders that are still active (default false). */
  activeOnly?: boolean;
  /** Only orders on this outcome. */
  outcome?: number;
}
const GET_MARKET_ORDERS_KEYS = optionKeys<GetMarketOrdersOptions>({ host: true, activeOnly: true, outcome: true });

export interface ListOrderResult extends TxResult {
  /** Id of the new order (from its `OrderCreated` event; null when the event is missing). */
  orderId: bigint | null;
  /** Shares listed (raw, 18 decimals). */
  amount: bigint;
  /** The limit price sent: pair asset per share, scaled by 1e18 (0 = market price). */
  pricePerShare: bigint;
}

export interface CancelOrderResult extends TxResult {
  orderId: bigint;
  /** True when `OrderCancelled` is in the logs (null when the event is missing). */
  cancelled: boolean | null;
}

/** One fill, from `OrderFilled`. Shares raw (18 decimals); money as `Amount` in the market's pair asset. */
export interface OrderFill {
  orderId: bigint;
  seller: Address;
  outcomeId: number;
  /** Shares bought. */
  amount: bigint;
  /** The fill's base price, before fees. */
  cost: Amount;
  /** What the buyer paid, buyer tax included. */
  buyerPaid: Amount;
  /** What the seller received after their tax. */
  sellerNet: Amount;
}

/**
 * The AMM leg of a sweep, from `BetFunded` (+ `SharesTraded` when it bet). A rest that converts below the minimum bet
 * mints no shares: its market tokens go back to the buyer (`shares` 0, `fee` 0, `returnedTokens` = `tokens`).
 */
export interface AmmLeg {
  /** Shares minted (raw, 18 decimals); 0 when the rest was too small to bet. */
  shares: bigint;
  /** Market tokens the rest converted to, before the bet fee (`BetFunded.tokens`; unit `token`, the market token). */
  tokens: Amount;
  /** Bet fee in market tokens (0 when no bet was made). */
  fee: Amount;
  /** Pair asset spent on the leg (`BetFunded.paid`). */
  paid: Amount;
  /** Market tokens sent back to the buyer because they were below the minimum bet (0 when the leg bet). */
  returnedTokens: Amount;
}

export interface BuyOrderResult extends TxResult {
  /** The minted fill (`OrderFilled`; null when the event is missing). */
  fill: OrderFill | null;
  /** The maxCost sent (the market's pair asset). */
  maxCost: Amount;
}

/** An order a sweep left out, and why. */
export interface SkippedOrder {
  orderId: bigint;
  seller: Address;
  /** 'sellerBlocked': the seller can't receive the pair asset right now (the token refuses transfers to that wallet). */
  rule: 'sellerBlocked';
}

export interface BuyOrdersResult extends TxResult {
  /**
   * Orders left out of the sweep because their seller can't be paid in the pair asset right now (the first try's
   * simulation failed on them; the sweep was quoted and sent again without them, and `warnings` says so). Empty
   * otherwise.
   */
  skipped: SkippedOrder[];
  /** The minimum shares sent. */
  minShares: bigint;
  /** Shares the quotes expected (raw, 18 decimals): the orders, plus the AMM leg with `amm` (`estimateSharesOut`). */
  quotedShares: bigint;
  /** Pair asset the quotes expected to spend, the AMM leg included; the unspent budget stays with the buyer. */
  quotedCost: Amount;
  /** Pair asset the orders leave for the AMM leg; 0 orders-only or when only fill dust (<= 255 raw) is left. */
  ammAmount: Amount;
  /** Shares quoted for the AMM leg; 0 when it converts below the minimum bet (the market tokens then go back to the buyer). */
  ammShares: bigint;
  /** The fills made, in order (`OrderFilled`). */
  fills: OrderFill[];
  /** The AMM leg actually run (`BetFunded`, + `SharesTraded` when it bet), else null. */
  amm: AmmLeg | null;
  /** Shares gained on `outcome`: the fills plus the AMM leg (null when the logs show neither). */
  sharesBought: bigint | null;
  /** Pair asset spent: the fills' `buyerPaid` plus the AMM leg's `paid` (null when the logs show neither). */
  spent: Amount | null;
}

type MarketData = {
  marketToken: Address;
  creator: Address;
  ecosystem: Address;
  usdc: Address;
  marketName: string;
  creationTime: bigint;
  endTime: bigint;
  finalOutcome: number;
  resolved: boolean;
  generalPot: bigint;
  totalVirtualReserve: bigint;
  isPrivate: boolean;
};

/**
 * The P2P order book of both prediction-market hosts. Sellers list shares at a price in the market's pair asset
 * (locked, not escrowed); buyers fill at or below the live share price (`getSharePrice`) and pay in that pair asset.
 * Every write syncs to `/api/v1/sync`, which decodes the order events.
 */
export class OrderBookModule extends BaseModule {
  private readonly hostCache = new Map<string, Promise<Host>>();


  /**
   * List `amount` shares of `outcome` for sale: raw bigint (18 decimals) or a human number/string ("2.5" shares).
   * @param pricePerShare the pair asset per share: a number/string like 1.25, or a bigint scaled by 1e18. 0 = the live
   *   share price at fill time; else 0.001 to 1,000,000. A price above the live share price lists, but fills only once
   *   the live price reaches it.
   */
  async listOrder(market: Address, outcome: number, amount: bigint | number | string, pricePerShare: number | string | bigint, opts: HostOptions | null = {}): Promise<ListOrderResult> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    const price = parseBookPrice(pricePerShare);
    const shares = parseAmount(amount, 18, 'amount');
    if (shares === 0n) throw new ValidationError('empty order', 'List at least some shares (amount must be above 0).');
    const md = await this.marketData(host, market);
    if (md.resolved) throw new ValidationError('market resolved', 'This market is resolved. Listings are closed.');
    await this.checkOutcome(host, market, outcome);
    const me = this.account;
    const [held, locked] = await Promise.all([
      this.read(host, 'getUserShares', [market, me, outcome]),
      this.read(host, 'sharesLockedInOrders', [market, me, outcome]),
    ]);
    if (held < locked + shares) {
      throw new ValidationError('unlockedShares', `Not enough free shares: you hold ${held}, ${locked} are already listed, ${shares} requested.`);
    }

    const tx = await this.write(host, 'listOrder', [market, outcome, shares, price]);
    const created = this.events(tx, TrancheMarketAbi, 'OrderCreated', host.address).find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.seller, me));
    if (!created) addMissingEventWarning(tx, host.contract, 'OrderCreated', ['orderId']);
    return { ...tx, orderId: created ? created.orderId : null, amount: shares, pricePerShare: price };
  }

  /** Cancel one of the signer's active orders (also allowed while paused or after resolution). */
  async cancelOrder(market: Address, orderId: bigint | number, opts: HostOptions | null = {}): Promise<CancelOrderResult> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    const id = toUint(orderId, 'orderId');
    const order = await this.readOrder(host, market, id);
    if (!isAddressEqual(order.seller, this.account)) throw new ValidationError('orderSeller', `Order ${id} is not yours.`);
    if (!order.active) throw new ValidationError('orderActive', `Order ${id} is already filled or cancelled.`);
    const tx = await this.write(host, 'cancelOrder', [market, id]);
    const ev = this.events(tx, TrancheMarketAbi, 'OrderCancelled', host.address).find((e) => isAddressEqual(e.marketToken, market) && e.orderId === id);
    if (!ev) addMissingEventWarning(tx, host.contract, 'OrderCancelled', ['cancelled']);
    return { ...tx, orderId: id, cancelled: ev ? true : null };
  }

  /**
   * Fill `fill` shares of one order: raw bigint (18 decimals) or a human number/string. Pays in the market's pair
   * asset (approved to the host). `maxCost` defaults to the quoted `totalCostToBuyer` plus slippage. `fill` in the
   * result is what the tx bought (`OrderFilled`). On the public host no order fills while INVALID is proposed or
   * backed by a vote (rule `'Invalid proposed'`). A fill that carries a fee (buyer or seller tax) is refused before
   * the approval while the host cannot take fees (`'convert closed'`) or the market's main is on a paused pair
   * (`'pair not active'`). Every fill is refused before the approval while the issuer
   * of the pair asset has paused it (`'pair asset paused'`: the fill is paid in it). When the fill's simulation fails
   * because the seller can't receive the pair asset right now (the token refuses transfers to that wallet), the rule is
   * `'sellerBlocked'`.
   */
  async buyOrder(market: Address, orderId: bigint | number, fill: bigint | number | string, opts: BuyOrderOptions | null = {}): Promise<BuyOrderResult> {
    const o = optsOf(opts, BUY_ORDER_KEYS);
    market = toAddress(market, 'market');
    const maxCostIn = optUint(o.maxCost ?? undefined, 'maxCost');
    if (maxCostIn === 0n) throw new ValidationError('maxCost', 'A zero maxCost is never sent; omit it to derive it from a quote.');
    const host = await this.resolveHost(market, o.host);
    const id = toUint(orderId, 'orderId');
    const amount = parseAmount(fill, 18, 'fill');
    const me = this.account;
    const [md, paused, order] = await Promise.all([
      this.marketData(host, market),
      this.read(host, 'paused', []),
      this.readOrder(host, market, id),
    ]);
    if (paused) throw new ValidationError('host paused', 'Trading is paused on this market host right now.');
    if (md.resolved) throw new ValidationError('market resolved', 'This market is resolved. Trading is closed.');
    await this.checkInvalidLive(host, market);
    const block = this.fillBlock(order, me, await this.currentPrice(host, market, order.outcomeId, md));
    if (block) throw block;
    if (amount === 0n || amount > order.amount) {
      throw new ValidationError('fillAmount', `Fill must be above 0 and at most the ${order.amount} shares left on order ${id}.`);
    }
    await this.checkPairUnit(md);

    const quote = await this.quoteFill(host, market, id, amount, me);
    if (quote.baseUsdc === 0n) throw new ValidationError('dust fill', 'That fill is worth less than 1 raw unit of the pair asset. Buy more.');
    const maxCost = maxCostIn ?? maxWithSlippage(quote.totalCostToBuyer, o.slippageBps ?? this.client.slippageBps.trade);
    if (quote.totalCostToBuyer > maxCost) {
      throw new ValidationError('max cost', `The fill costs ${quote.totalCostToBuyer} (raw pair asset), above maxCost ${maxCost}.`);
    }
    const balance = await this.balanceOf(md.usdc, me);
    if (balance < quote.totalCostToBuyer) {
      throw new ValidationError('insufficient balance', `Not enough pair asset: the fill costs ${quote.totalCostToBuyer}, you hold ${balance} (raw).`);
    }
    if (quote.totalCostToBuyer > quote.netToSeller) await this.checkFeePath(host, market, md);
    await this.refusePausedPair(md);

    await this.ensureAllowance(md.usdc, host.address, maxCost);
    const pairOf = await this.pairOf(md);
    let tx: TxResult;
    try {
      tx = await this.write(host, 'buyOrder', [market, id, amount, maxCost]);
    } catch (e) {
      if (!(e instanceof BasisContractError)) throw e;
      if ((await this.unpayable(md.usdc, me, host.address, [order])).length) throw sellerBlocked([order], pairOf(0n).symbol);
      throw e;
    }
    const fills = this.fillsOf(tx, host, market, me, pairOf);
    if (!fills.length) addMissingEventWarning(tx, host.contract, 'OrderFilled', ['fill']);
    return { ...tx, fill: fills[0] ?? null, maxCost: pairOf(maxCost) };
  }

  /**
   * Sweep several orders on `outcome` with a pair-asset `budget`: raw bigint or a human number/string in the pair
   * asset's decimals. Orders only by default: the unspent budget stays with the buyer. With `opts.amm` the rest buys
   * the AMM (`inputToken` = the pair asset; the AMM bet rules of `checkBuy` apply when the rest is above fill dust, 255
   * raw: below it no AMM leg runs) and the whole budget is approved. `minShares` defaults to the quoted shares
   * (order quotes, + `estimateSharesOut` with `amm`) minus slippage. As on chain, an order the host cannot fill is
   * skipped: another outcome, your own, priced above the live share price, already filled or cancelled. Without `amm`,
   * when that leaves nothing to fill, the first skipped order's rule is thrown (`orderOutcome`, `ownOrder`,
   * `orderPrice`). On the public host a sweep that would fill an order is refused while INVALID is proposed or backed
   * by a vote (`'Invalid proposed'`). A sweep whose fills carry a fee (buyer or seller tax) is refused before the
   * approval while the host cannot take fees (`'convert closed'`) or the market's main is on a paused pair (`'pair not
   * active'`), with or without `amm`; every sweep is refused before the approval while the issuer of the pair asset has
   * paused it (`'pair asset paused'`: the budget is paid in it). When the sweep's simulation fails, the sellers of the
   * orders it would fill are
   * checked: orders whose seller can't receive the pair asset right now (the token refuses transfers to that wallet)
   * are left out, the sweep is quoted and sent once more without them, and they come back in `skipped` with a warning
   * (rule `'sellerBlocked'` when that leaves nothing to fill). The result carries the fills and the AMM leg the tx made.
   * `orderIds`: an array of whole numbers, at least one, none twice (`ValidationError('orderIds')` otherwise, before any
   * read).
   */
  async buyOrders(market: Address, outcome: number, orderIds: readonly (bigint | number)[], budget: bigint | number | string, opts: BuyOrdersOptions | null = {}): Promise<BuyOrdersResult> {
    const options = optsOf(opts, BUY_ORDERS_KEYS);
    const amm = toBool(options.amm ?? undefined, 'amm', false);
    market = toAddress(market, 'market');
    const idsIn: unknown = orderIds;
    if (idsIn == null || (Array.isArray(idsIn) && idsIn.length === 0)) throw new ValidationError('orderIds', 'Pass at least one order id.');
    if (!Array.isArray(idsIn)) throw new ValidationError('orderIds', 'orderIds must be an array of order ids.');
    const ids = idsIn.map((o) => toUint(o, 'orderIds'));
    if (new Set(ids.map(String)).size !== ids.length) throw new ValidationError('orderIds', 'Order ids must not repeat.');
    const host = await this.resolveHost(market, options.host);
    const me = this.account;
    const [md, paused] = await Promise.all([this.marketData(host, market), this.read(host, 'paused', [])]);
    const total = parseAmount(budget, (await this.client.mains.tokenMeta(md.usdc)).decimals, 'budget');
    if (total === 0n) throw new ValidationError('budget', 'The budget must be above 0.');
    if (paused) throw new ValidationError('host paused', 'Trading is paused on this market host right now.');
    if (md.resolved) throw new ValidationError('market resolved', 'This market is resolved. Trading is closed.');
    await this.checkOutcome(host, market, outcome);
    await this.checkPairUnit(md);

    const orders = await Promise.all(ids.map((id) => this.readOrder(host, market, id)));
    if (!amm && !orders.some((o) => o.active)) {
      throw new ValidationError('orderActive', 'None of these orders is still available (all filled or cancelled).');
    }
    let plan = await this.planSweep(host, market, outcome, md, orders, total, amm, me, options);
    await this.refusePausedPair(md);

    await this.ensureAllowance(md.usdc, host.address, total);
    const [pairOf, tokensOf] = await Promise.all([this.pairOf(md), amountOf(this.client, market)]);
    const sweep = (p: SweepPlan) => this.write(host, 'buyOrdersAndContract', [market, outcome, p.ids, amm ? md.usdc : zeroAddress, total, p.minShares]);
    let skipped: SkippedOrder[] = [];
    let tx: TxResult;
    try {
      tx = await sweep(plan);
    } catch (e) {
      if (!(e instanceof BasisContractError)) throw e;
      const blocked = await this.unpayable(md.usdc, me, host.address, plan.fillable);
      if (!blocked.length) throw e;
      const symbol = pairOf(0n).symbol;
      const rest = orders.filter((o) => !blocked.some((b) => b.orderId === o.orderId));
      if (!amm && !rest.some((o) => o.active)) throw sellerBlocked(blocked, symbol);
      try {
        plan = await this.planSweep(host, market, outcome, md, rest, total, amm, me, options);
      } catch (e2) {
        if (e2 instanceof ValidationError) throw sellerBlocked(blocked, symbol, e2.message.replace('[basis-sdk] ', ''));
        throw e2;
      }
      skipped = blocked.map((o) => ({ orderId: o.orderId, seller: o.seller, rule: 'sellerBlocked' as const }));
      tx = await sweep(plan);
      tx.warnings.push(
        `${host.contract}.buyOrdersAndContract left out order${blocked.length > 1 ? 's' : ''} ${blocked.map((o) => o.orderId).join(', ')}: ` +
        `the seller can't receive ${symbol} right now (the token refuses transfers to that wallet). See \`skipped\`.`,
      );
    }
    const { minShares, quotedShares, quotedCost, ammAmount, ammShares } = plan;
    const fills = this.fillsOf(tx, host, market, me, pairOf);
    const traded = this.events(tx, TrancheMarketAbi, 'SharesTraded', host.address)
      .find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.buyer, me) && e.outcomeId === outcome);
    const funded = this.events(tx, TrancheMarketAbi, 'BetFunded', host.address)
      .find((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.buyer, me));
    const ammLeg: AmmLeg | null = traded
      ? { shares: traded.shares, tokens: tokensOf(funded?.tokens ?? 0n), fee: tokensOf(traded.fee), paid: pairOf(funded?.paid ?? 0n), returnedTokens: tokensOf(0n) }
      : funded ? { shares: 0n, tokens: tokensOf(funded.tokens), fee: tokensOf(0n), paid: pairOf(funded.paid), returnedTokens: tokensOf(funded.tokens) } : null;
    const seen = fills.length > 0 || ammLeg !== null;
    if (!seen) addMissingEventWarning(tx, host.contract, 'OrderFilled/SharesTraded', ['sharesBought', 'spent']);
    const sharesBought = seen ? fills.filter((f) => f.outcomeId === outcome).reduce((t, f) => t + f.amount, ammLeg?.shares ?? 0n) : null;
    const spent = seen ? pairOf(fills.reduce((t, f) => t + f.buyerPaid.raw, ammLeg?.paid.raw ?? 0n)) : null;
    return {
      ...tx, skipped, minShares, quotedShares, quotedCost: pairOf(quotedCost), ammAmount: pairOf(ammAmount), ammShares, fills, amm: ammLeg, sharesBought, spent,
    };
  }

  /**
   * The quotes of a sweep of `orders` (in the order sent) with `total`: the orders the host would fill (`fillable`),
   * the shares and cost they quote, the AMM leg with `amm`, the minimum shares and the balance check. Throws the
   * refusals `buyOrders` documents.
   */
  private async planSweep(
    host: Host, market: Address, outcome: number, md: MarketData, orders: readonly MarketOrder[], total: bigint, amm: boolean,
    me: Address, opts: BuyOrdersOptions,
  ): Promise<SweepPlan> {
    const ids = orders.map((o) => o.orderId);
    const price = await this.currentPrice(host, market, outcome, md);
    let remaining = total;
    let quotedShares = 0n;
    let skipped: ValidationError | null = null;
    const fillable: MarketOrder[] = [];
    /** The fills quoted, as the host makes them: shares and buyer tax per order. */
    const fills: { orderId: bigint; fill: bigint; buyerTax: bigint }[] = [];
    for (const o of orders) {
      if (!o.active) continue;
      const block = o.outcomeId !== outcome
        ? new ValidationError('orderOutcome', `Order ${o.orderId} is on outcome ${o.outcomeId}, not ${outcome}.`)
        : this.fillBlock(o, me, price);
      if (block) {
        skipped ??= block;
        continue;
      }
      const q = await this.quoteBudget(host, market, o.orderId, remaining, me);
      if (q.fill > 0n) {
        quotedShares += q.fill;
        remaining -= q.totalCostToBuyer;
        fillable.push(o);
        fills.push({ orderId: o.orderId, fill: q.fill, buyerTax: q.buyerTax });
      }
      if (remaining === 0n) break;
    }
    if (quotedShares > 0n) await this.checkInvalidLive(host, market);
    if (await this.fillsCarryFee(host, market, fills, me)) await this.checkFeePath(host, market, md);
    if (!amm && quotedShares === 0n && skipped) throw skipped;
    let ammAmount = 0n;
    let ammShares = 0n;
    if (amm && remaining > AMM_DUST) {
      const markets = host.kind === 'private' ? this.client.privateMarkets : this.client.predictionMarkets;
      if (!isAddressEqual(markets.address, host.address)) {
        throw new ValidationError('host', `An AMM sweep needs the address-book ${host.kind} host (${markets.address}), not ${host.address}.`);
      }
      const chk = await markets.checkBuy(market, outcome, { buyer: me, input: md.usdc });
      if (!chk.canBet) throw new ValidationError(chk.reason!, chk.message!);
      ammAmount = remaining;
      const reader = this.client.marketReader;
      try {
        await reader.quoteBet({ market, outcome, input: md.usdc, amount: remaining, host: host.address, bettor: me });
        const est = await reader.estimateSharesOut(host.address, market, outcome, total, ids, me);
        ammShares = est - quotedShares;
        quotedShares = est;
      } catch (e) {
        if (!(e instanceof ValidationError && e.rule === 'minBet')) throw e;
      }
    }
    const quotedCost = total - remaining + ammAmount;
    const minShares = await this.resolveMin(opts.minShares ?? undefined, opts.slippageBps ?? undefined, async () => quotedShares, 'trade', 'minShares');
    const balance = await this.balanceOf(md.usdc, me);
    if (balance < quotedCost) {
      throw new ValidationError('insufficient balance', `Not enough pair asset: the sweep costs ${quotedCost}, you hold ${balance} (raw).`);
    }
    return { ids, fillable, quotedShares, quotedCost, ammAmount, ammShares, minShares };
  }

  /**
   * The orders of `orders` whose seller can't receive `asset` right now: a 1-unit `transfer` of it from `buyer` to the
   * seller is refused (simulated), while one to `control` (the host) goes through. Only run after a fill failed.
   * A transfer the RPC could not answer counts as payable.
   */
  private async unpayable(asset: Address, buyer: Address, control: Address, orders: readonly MarketOrder[]): Promise<MarketOrder[]> {
    if (!orders.length) return [];
    const canReceive = async (to: Address): Promise<boolean | null> => {
      try {
        const { result } = await this.publicClient.simulateContract({ address: asset, abi: ERC20Abi, functionName: 'transfer', args: [to, 1n], account: buyer });
        return result !== false;
      } catch (e) {
        return rpcErrorKind(e) ? null : false;
      }
    };
    if ((await canReceive(control)) !== true) return [];
    const sellers = [...new Set(orders.map((o) => o.seller.toLowerCase()))];
    const answers = await Promise.all(sellers.map((s) => canReceive(getAddress(s))));
    const blocked = new Set(sellers.filter((_, i) => answers[i] === false));
    return orders.filter((o) => blocked.has(o.seller.toLowerCase()));
  }


  /** One order. An id that was never listed reads as an empty, inactive order. */
  async getOrder(market: Address, orderId: bigint | number, opts: HostOptions | null = {}): Promise<MarketOrder> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    return this.readOrder(host, market, toUint(orderId, 'orderId'));
  }

  /** Every order listed on a market (ids 0 .. nextOrderId-1), optionally only active ones / one outcome. */
  async getMarketOrders(market: Address, opts: GetMarketOrdersOptions | null = {}): Promise<MarketOrder[]> {
    const o = optsOf(opts, GET_MARKET_ORDERS_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    const next = await this.read(host, 'nextOrderId', [market]);
    const out: MarketOrder[] = [];
    for (let start = 0n; start < next; start += BigInt(READ_BATCH)) {
      const end = start + BigInt(READ_BATCH) < next ? start + BigInt(READ_BATCH) : next;
      const batch: Promise<MarketOrder>[] = [];
      for (let id = start; id < end; id++) batch.push(this.readOrder(host, market, id));
      out.push(...(await Promise.all(batch)));
    }
    return out.filter((r) => (!o.activeOnly || r.active) && (o.outcome == null || r.outcomeId === o.outcome));
  }

  /**
   * Shares (raw, 18 decimals) of `outcome` that `user` (default: the signer) has locked in active listings. A listing
   * needs held - locked >= amount.
   */
  async getLockedShares(market: Address, outcome: number, user?: Address, opts: HostOptions | null = {}): Promise<bigint> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const host = await this.resolveHost(market, o.host);
    this.checkOutcomeId(outcome);
    return this.read(host, 'sharesLockedInOrders', [market, who, outcome]);
  }

  /** Shares (raw, 18 decimals) of `outcome` that `user` (default: the signer) can still list: held minus locked. */
  async getFreeShares(market: Address, outcome: number, user?: Address, opts: HostOptions | null = {}): Promise<bigint> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const who = user == null ? this.account : toAddress(user, 'user');
    const host = await this.resolveHost(market, o.host);
    this.checkOutcomeId(outcome);
    const [held, locked] = await Promise.all([
      this.read(host, 'getUserShares', [market, who, outcome]),
      this.read(host, 'sharesLockedInOrders', [market, who, outcome]),
    ]);
    return held > locked ? held - locked : 0n;
  }

  /** The id the next listing on `market` gets (= the number of orders ever listed). */
  async getNextOrderId(market: Address, opts: HostOptions | null = {}): Promise<bigint> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    return this.read(host, 'nextOrderId', [market]);
  }

  /**
   * Cost of filling `fill` shares (raw bigint, 18 decimals, or a human number/string) of an order, in the market's
   * pair asset, priced at `buyer`'s tax rate (default: the signer).
   */
  async getBuyOrderCost(market: Address, orderId: bigint | number, fill: bigint | number | string, buyer?: Address, opts: HostOptions | null = {}): Promise<BuyOrderCost> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const who = buyer == null ? this.client.account : toAddress(buyer, 'buyer');
    const host = await this.resolveHost(market, o.host);
    const q = await this.quoteFill(host, market, toUint(orderId, 'orderId'), parseAmount(fill, 18, 'fill'), who);
    const amt = await this.pairAmounter(host, market);
    return { baseCost: amt(q.baseUsdc), buyerTax: amt(q.buyerTax), totalCostToBuyer: amt(q.totalCostToBuyer), netToSeller: amt(q.netToSeller) };
  }

  /**
   * Shares a pair-asset `budget` (raw bigint, or a human number/string in the pair asset's decimals) fills on one
   * order, at `buyer`'s tax rate (default: the signer). `fill` is 0 when the order can't fill (see
   * `BuyOrderAmountsOut.fill`).
   */
  async getBuyOrderAmountsOut(market: Address, orderId: bigint | number, budget: bigint | number | string, buyer?: Address, opts: HostOptions | null = {}): Promise<BuyOrderAmountsOut> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const who = buyer == null ? this.client.account : toAddress(buyer, 'buyer');
    const host = await this.resolveHost(market, o.host);
    const amt = await this.pairAmounter(host, market);
    const raw = typeof budget === 'bigint' ? toUint(budget, 'budget') : parseAmount(budget, amt(0n).decimals, 'budget');
    const q = await this.quoteBudget(host, market, toUint(orderId, 'orderId'), raw, who);
    return { fill: q.fill, baseCost: amt(q.baseUsdc), buyerTax: amt(q.buyerTax), totalCostToBuyer: amt(q.totalCostToBuyer) };
  }

  /**
   * The live share price of `outcome`, in the book's unit: whole pair-asset units per share, scaled by 1e18. An order
   * fills only at or below it, and a market-priced order fills at it. It moves with bets and with the market token's
   * price.
   */
  async getSharePrice(market: Address, outcome: number, opts: HostOptions | null = {}): Promise<bigint> {
    const o = optsOf(opts, HOST_KEYS);
    market = toAddress(market, 'market');
    const host = await this.resolveHost(market, o.host);
    const md = await this.marketData(host, market);
    await this.checkOutcome(host, market, outcome);
    return this.currentPrice(host, market, outcome, md);
  }


  /** The host of `market`: explicit, or detected when left out or null (public first, then private; cached per market). */
  private async resolveHost(market: Address, ref?: HostRef | null): Promise<Host> {
    const a = this.client.addresses;
    if (ref === 'public') return makeHost(this.require(a.tranche, 'TrancheMarket'), 'public');
    if (ref === 'private') return makeHost(this.require(a.tranchePrivate, 'TrancheMarketPrivate'), 'private');
    if (ref != null) {
      const h = toAddress(ref, 'host');
      const isPrivate = !isZeroAddress(a.tranchePrivate) && isAddressEqual(h, a.tranchePrivate);
      return makeHost(this.require(h, 'TrancheMarket'), isPrivate ? 'private' : 'public');
    }
    const key = market.toLowerCase();
    let p = this.hostCache.get(key);
    if (!p) {
      p = this.detectHost(market);
      this.hostCache.set(key, p);
      p.catch(() => this.hostCache.delete(key));
    }
    return p;
  }

  private async detectHost(market: Address): Promise<Host> {
    const a = this.client.addresses;
    const candidates: Host[] = [];
    if (!isZeroAddress(a.tranche)) candidates.push(makeHost(a.tranche, 'public'));
    if (!isZeroAddress(a.tranchePrivate)) candidates.push(makeHost(a.tranchePrivate, 'private'));
    if (!candidates.length) this.require(a.tranche, 'TrancheMarket');
    for (const h of candidates) {
      const md = await this.read(h, 'getMarketData', [market]);
      if (!isZeroAddress(md.marketToken)) return h;
    }
    throw new ValidationError('unknown market', `${market} is not a market on either host.`);
  }


  /** A view on the host, typed by the public ABI (both hosts expose the same order-book functions). */
  private read<F extends OrderReadFn>(host: Host, functionName: F, args: ReadArgs<F>, account?: Address): Promise<ReadResult<F>> {
    const abi = host.kind === 'private' ? TrancheMarketPrivateAbi : TrancheMarketAbi;
    return this.publicClient.readContract({ address: host.address, abi, functionName, args, account } as never) as Promise<ReadResult<F>>;
  }

  /** `send` on the host with its own ABI (its `/api/v1/sync` is awaited there). */
  private write<F extends OrderWriteFn>(host: Host, functionName: F, args: WriteArgs<F>): Promise<TxResult> {
    return host.kind === 'private'
      ? this.send({ address: host.address, abi: TrancheMarketPrivateAbi, functionName, args, contract: host.contract })
      : this.send({ address: host.address, abi: TrancheMarketAbi, functionName, args, contract: host.contract });
  }

  private async marketData(host: Host, market: Address): Promise<MarketData> {
    const md = await this.read(host, 'getMarketData', [market]);
    if (isZeroAddress(md.marketToken)) throw new ValidationError('unknown market', `${market} is not a market on host ${host.address}.`);
    return md;
  }

  private async readOrder(host: Host, market: Address, orderId: bigint): Promise<MarketOrder> {
    const [seller, outcomeId, amount, totalAmount, pricePerShare, active] = await this.read(host, 'marketOrders', [market, orderId]);
    const isMarketPrice = pricePerShare === 0n;
    return {
      orderId, market, host: host.address, hostKind: host.kind, seller, outcomeId, amount, totalAmount,
      filled: totalAmount - amount, pricePerShare, price: isMarketPrice ? 'market' : formatUnits(pricePerShare, 18), isMarketPrice, active,
    };
  }

  private checkOutcomeId(outcome: number): void {
    if (typeof outcome !== 'number' || !Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new ValidationError('outcome', `Outcome must be 0-255, got ${outcome}.`);
  }

  private async checkOutcome(host: Host, market: Address, outcome: number): Promise<void> {
    this.checkOutcomeId(outcome);
    const n = await this.read(host, 'getNumOutcomes', [market]);
    if (BigInt(outcome) >= n) throw new ValidationError('outcome', `Outcome ${outcome} is out of range (the market has ${n}).`);
  }

  /** The live share price of an outcome, as a fill uses it (same rounding): pair asset per share, 1e18 scale. */
  private async currentPrice(host: Host, market: Address, outcome: number, md: MarketData): Promise<bigint> {
    const [o, pairPrice, info] = await Promise.all([
      this.read(host, 'getOutcome', [market, outcome]),
      this.publicClient.readContract({ address: market, abi: FactoryTokenAbi, functionName: 'getPairPrice' }),
      this.client.mains.get(md.ecosystem),
    ]);
    if (md.totalVirtualReserve === 0n || info.pairUnit === 0n) return 0n;
    return (((o.virtualReserve * PRICE_ONE) / md.totalVirtualReserve) * pairPrice) / info.pairUnit;
  }

  /**
   * "Invalid proposed": the public host fills no order while INVALID is the live proposal or has a panel vote in the
   * current round. The private host has no such stop.
   */
  private async checkInvalidLive(host: Host, market: Address): Promise<void> {
    if (host.kind === 'private') return;
    const resolver = await this.read(host, 'marketResolver', [market]);
    if (isZeroAddress(resolver)) return;
    const live = await this.publicClient.readContract({ address: resolver, abi: MarketResolverAbi, functionName: 'invalidLive', args: [market] });
    if (live) {
      throw new ValidationError('Invalid proposed', "Listed shares can't be bought while the market might be voided (INVALID is proposed or backed by a vote).");
    }
  }

  /**
   * Does any of a sweep's quoted fills carry a fee (a buyer or seller tax above 0)? The buyer tax comes with the budget
   * quote; the seller's is read (`getBuyOrderCost` of that fill) only when no fill has a buyer tax.
   */
  private async fillsCarryFee(host: Host, market: Address, fills: readonly { orderId: bigint; fill: bigint; buyerTax: bigint }[], buyer: Address): Promise<boolean> {
    if (fills.some((f) => f.buyerTax > 0n)) return true;
    for (const f of fills) {
      const q = await this.quoteFill(host, market, f.orderId, f.fill, buyer);
      if (q.totalCostToBuyer > q.netToSeller) return true;
    }
    return false;
  }

  /**
   * The checks of a fill that carries a fee: 'convert closed' while the host cannot take fees, 'pair not active' while
   * the market's main is on a paused pair. Either would revert the fill after its approval.
   */
  private async checkFeePath(host: Host, market: Address, md: MarketData): Promise<void> {
    const taxes = this.client.addresses.taxes;
    if (!isZeroAddress(taxes)) {
      const registered = (await this.publicClient.readContract({ address: taxes, abi: TaxesAbi, functionName: 'isPrediction', args: [host.address] }))
        || (await this.publicClient.readContract({ address: taxes, abi: TaxesAbi, functionName: 'isFeeSource', args: [host.address] }));
      if (!registered) {
        throw new ValidationError('convert closed', `The ${host.kind} host ${host.address} cannot pass on an order fill's fee right now: no fills that carry a fee.`);
      }
    }
    const swap = (await this.read(host, 'ecosystems', [md.ecosystem]))[1];
    const active = !isZeroAddress(swap) && (await this.publicClient.readContract({ address: swap, abi: SwapAbi, functionName: 'isMain', args: [md.ecosystem] }));
    if (!active) {
      throw new ValidationError(
        'pair not active',
        `Market ${market} settles through main ${md.ecosystem}, which is on a paused pair: no order fills that carry a fee until the pair is active again.`,
      );
    }
  }

  /** The first reasonless `fill` rule an order breaks (active, not the buyer's own, priced at or below the live share price), or null. */
  private fillBlock(order: MarketOrder, buyer: Address, currentPrice: bigint): ValidationError | null {
    if (!order.active) return new ValidationError('orderActive', `Order ${order.orderId} is no longer available.`);
    if (isAddressEqual(order.seller, buyer)) return new ValidationError('ownOrder', `Order ${order.orderId} is your own; you can't buy it.`);
    if (!order.isMarketPrice && order.pricePerShare > currentPrice) {
      return new ValidationError(
        'orderPrice',
        `Order ${order.orderId} asks ${order.price} per share, above the live share price of ${formatUnits(currentPrice, 18)} (pair asset per share): it can't fill now.`,
      );
    }
    return null;
  }

  /** "pair unit": the book settles only when the pair asset's decimals match the market's main. */
  private async checkPairUnit(md: MarketData): Promise<void> {
    const [info, meta] = await Promise.all([this.client.mains.get(md.ecosystem), this.client.mains.tokenMeta(md.usdc)]);
    if (10n ** BigInt(meta.decimals) !== info.pairUnit) {
      throw new ValidationError('pair unit', "The order book can't settle in this market's currency (pair asset decimals do not match the main's PAIR_UNIT).");
    }
  }

  /** The `OrderFilled` logs of `buyer` on `market` from the host, in order. */
  private fillsOf(tx: TxResult, host: Host, market: Address, buyer: Address, pairOf: AmountOf): OrderFill[] {
    return this.events(tx, TrancheMarketAbi, 'OrderFilled', host.address)
      .filter((e) => isAddressEqual(e.marketToken, market) && isAddressEqual(e.buyer, buyer))
      .map((e) => ({
        orderId: e.orderId, seller: e.seller, outcomeId: e.outcomeId, amount: e.amount,
        cost: pairOf(e.usdcSpent), buyerPaid: pairOf(e.buyerPaid), sellerNet: pairOf(e.sellerNet),
      }));
  }

  /** Formatter for a write result's amounts in the market's pair asset (its main's), resolved before sending. */
  /**
   * 'pair asset paused' when the issuer of the market's pair asset has paused it: a fill pays in it. The main is looked
   * up for the symbol only after a paused answer.
   */
  private async refusePausedPair(md: MarketData): Promise<void> {
    if (await isAssetPaused(this.client, md.usdc)) {
      throw pairAssetPaused(md.usdc, (await this.client.mains.get(md.ecosystem)).pairSymbol, 'no order can be paid for in it');
    }
  }

  private async pairOf(md: MarketData): Promise<AmountOf> {
    return amountOf(this.client, md.usdc, await this.client.mains.get(md.ecosystem));
  }

  private async quoteFill(host: Host, market: Address, orderId: bigint, fill: bigint, buyer?: Address) {
    const [baseUsdc, buyerTax, totalCostToBuyer, netToSeller] = await this.read(host, 'getBuyOrderCost', [market, orderId, fill], buyer);
    return { baseUsdc, buyerTax, totalCostToBuyer, netToSeller };
  }

  private async quoteBudget(host: Host, market: Address, orderId: bigint, budget: bigint, buyer?: Address) {
    const [fill, baseUsdc, buyerTax, totalCostToBuyer] = await this.read(host, 'getBuyOrderAmountsOut', [market, orderId, budget], buyer);
    return { fill, baseUsdc, buyerTax, totalCostToBuyer };
  }

  /** Formatter for raw amounts in the market's pair asset. */
  private async pairAmounter(host: Host, market: Address): Promise<(raw: bigint) => Amount> {
    const md = await this.marketData(host, market);
    const meta = await this.client.mains.tokenMeta(md.usdc);
    return (raw) => toAmount(raw, meta.decimals, 'pairAsset', md.usdc, meta.symbol);
  }
}


type PublicAbi = typeof TrancheMarketAbi;
type OrderReadFn = 'getMarketData' | 'getNumOutcomes' | 'getOutcome' | 'getUserShares' | 'sharesLockedInOrders'
  | 'marketOrders' | 'nextOrderId' | 'paused' | 'getBuyOrderCost' | 'getBuyOrderAmountsOut' | 'marketResolver' | 'ecosystems';
type OrderWriteFn = 'listOrder' | 'cancelOrder' | 'buyOrder' | 'buyOrdersAndContract';
type ReadArgs<F extends OrderReadFn> = import('viem').ContractFunctionArgs<PublicAbi, 'view' | 'pure', F>;
type ReadResult<F extends OrderReadFn> = import('viem').ContractFunctionReturnType<PublicAbi, 'view' | 'pure', F>;
type WriteArgs<F extends OrderWriteFn> = import('viem').ContractFunctionArgs<PublicAbi, 'nonpayable' | 'payable', F>;

function makeHost(address: Address, kind: HostKind): Host {
  return { address, kind, contract: kind === 'private' ? 'TrancheMarketPrivate' : 'TrancheMarket' };
}

/** A quoted sweep: the ids sent, the orders the host would fill, the quotes and the minimum (raw). */
interface SweepPlan {
  ids: bigint[];
  fillable: MarketOrder[];
  quotedShares: bigint;
  quotedCost: bigint;
  ammAmount: bigint;
  ammShares: bigint;
  minShares: bigint;
}

/** The 'sellerBlocked' refusal for `orders` (their sellers can't receive `symbol`), plus `more` when given. */
function sellerBlocked(orders: readonly MarketOrder[], symbol: string, more?: string): ValidationError {
  const ids = orders.map((o) => o.orderId).join(', ');
  return new ValidationError(
    'sellerBlocked',
    `Order${orders.length > 1 ? 's' : ''} ${ids} can't fill: the seller can't receive ${symbol} right now (the token refuses transfers to that wallet). Pick other orders.${more ? ` Without ${orders.length > 1 ? 'them' : 'it'}: ${more}` : ''}`,
  );
}

/** Book price (pair asset per share) → 1e18-scaled bigint, validated: 0 (market price) or 0.001 to 1,000,000. */
function parseBookPrice(v: number | string | bigint): bigint {
  let raw: bigint;
  if (typeof v === 'bigint') raw = v;
  else {
    const s = trimAscii(String(v));
    if (!/^\d*\.?\d+$/.test(s)) throw new ValidationError('pricePerShare', `pricePerShare must be a decimal like 0.42 (or a 1e18-scaled bigint), got ${v}.`);
    try {
      raw = parseUnits(s, 18);
    } catch {
      throw new ValidationError('pricePerShare', `pricePerShare must be a decimal like 0.42, got ${v}.`);
    }
  }
  if (raw !== 0n && (raw < PRICE_MIN || raw > PRICE_MAX)) {
    throw new ValidationError(
      'pricePerShare',
      `Limit price must be 0 (market price) or between 0.001 and 1,000,000 of the pair asset per share, got ${formatUnits(raw, 18)}.`,
    );
  }
  return raw;
}
