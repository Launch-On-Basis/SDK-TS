import { type Address, getAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import { isZeroAddress } from '../config/addresses';
import { type MainInfo, mainAmount, pairAmount } from './mains';
import { type Amount, toAmount } from './units';

/** Turns a raw amount of one token into an `Amount` (no RPC: everything it needs is resolved up front). */
export type AmountOf = (raw: bigint) => Amount;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `fmt(raw)`, or null for a figure whose event is missing. */
export function optAmount(fmt: AmountOf, raw: bigint | null | undefined): Amount | null {
  return raw === null || raw === undefined ? null : fmt(raw);
}

/** Formatter in the pair asset of `info` (scaled by its `pairUnit`). */
export function pairAmountOf(info: MainInfo): AmountOf {
  return (raw) => pairAmount(raw, info);
}

/** Formatter in the main token of `info` (18 decimals). */
export function mainAmountOf(info: MainInfo): AmountOf {
  return (raw) => mainAmount(raw, info);
}

/**
 * Formatter for raw amounts of `token`. Write results resolve it BEFORE sending (it may read the chain; the reads are
 * cached), so building the result of a confirmed tx never needs an RPC call and never throws. A main is unit `main`
 * (that main alone is loaded: `mains.get`); the pair asset of `info`, or of a main the address book lists, is unit
 * `pairAsset`; anything else is unit `token`. Only the main in use is looked up, never every main, so one
 * stale address-book entry cannot block a write on another main: a pair asset that is not `info`'s is told by the book
 * (its label only), and its decimals and symbol come from the token itself, as for any token.
 */
export async function amountOf(client: BasisClient, token: Address, info?: MainInfo): Promise<AmountOf> {
  if (info) {
    if (eq(token, info.main)) return mainAmountOf(info);
    if (eq(token, info.pairAsset)) return pairAmountOf(info);
  }
  const swapLive = !isZeroAddress(client.addresses.swap);
  if (swapLive && (await client.mains.isMain(token))) return mainAmountOf(await client.mains.get(token));
  const meta = await client.mains.tokenMeta(token);
  const asset = getAddress(token);
  const pair = swapLive && client.addresses.mains.some((m) => !isZeroAddress(m.pairAsset) && eq(m.pairAsset, asset));
  return (raw) => toAmount(raw, meta.decimals, pair ? 'pairAsset' : 'token', asset, meta.symbol);
}
