import { Address, formatUnits, getAddress, isAddress } from 'viem';
import { ValidationError } from './errors';

/**
 * What a number is denominated in.
 * - `pairAsset`: the main's pair asset (USDG, NVDA, ...), scaled by its decimals (= `MainInfo.pairUnit`).
 * - `main`: a main token (18 decimals).
 * - `token`: any other token (factory token, market token, pool token), scaled by its own decimals.
 */
export type AmountUnit = 'pairAsset' | 'main' | 'token';

/**
 * An amount or price with everything needed to read it. The SDK never returns a bare "USD" number:
 * pair assets are not always USD, and there is no on-chain USD price.
 */
export interface Amount {
  /** Raw integer value as the contract returns it. */
  raw: bigint;
  /** Human-readable decimal string (`formatUnits(raw, decimals)`). */
  formatted: string;
  decimals: number;
  unit: AmountUnit;
  /** Token the amount is denominated in. */
  asset: Address;
  symbol: string;
}

export function toAmount(raw: bigint, decimals: number, unit: AmountUnit, asset: Address, symbol: string): Amount {
  return { raw, formatted: formatUnits(raw, decimals), decimals, unit, asset, symbol };
}

export const MAX_UINT256 = (1n << 256n) - 1n;
const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,6}))?$/i;

/**
 * Parse a human amount ("12.5", "1e-6", 0.25) into raw units, or pass a raw bigint through. Digits beyond `decimals`
 * are truncated toward zero (never more than asked). Negative, non-numeric, boolean or above-uint256 values throw
 * `ValidationError(field)`.
 */
export function parseAmount(value: bigint | string | number, decimals: number, field = 'amount'): bigint {
  let raw: bigint;
  if (typeof value === 'bigint') {
    raw = value;
  } else {
    if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new ValidationError(field, `${field} must be a number or a decimal string, got ${String(value)}.`);
    }
    const m = DECIMAL_RE.exec(String(value).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ''));
    if (!m || (!m[2] && !m[3])) throw new ValidationError(field, `${field} is not a valid amount: ${String(value)}.`);
    const frac = m[3] ?? '';
    const digits = (m[2] + frac).replace(/^0+/, '');
    if (digits && m[1] === '-') throw new ValidationError(field, `${field} must not be negative, got ${String(value)}.`);
    const shift = Number(m[4] ?? 0) - frac.length + decimals;
    if (!digits) raw = 0n;
    else if (digits.length + shift > 78) throw new ValidationError(field, `${field} is too large: ${String(value)}.`);
    else raw = shift >= 0 ? BigInt(digits + '0'.repeat(shift)) : BigInt(digits.slice(0, Math.max(0, digits.length + shift)) || '0');
  }
  if (raw < 0n) throw new ValidationError(field, `${field} must not be negative, got ${String(value)}.`);
  if (raw > MAX_UINT256) throw new ValidationError(field, `${field} is too large: ${String(value)}.`);
  return raw;
}

export const BPS = 10_000n;

/** Default slippage tolerances in basis points: 1% trades/markets/redeem, 3% Up/Down. */
export const DEFAULT_SLIPPAGE_BPS = { trade: 100, updown: 300 } as const;
export type SlippageKind = keyof typeof DEFAULT_SLIPPAGE_BPS;

/**
 * A slippage tolerance in bps as a bigint: a whole number from 0 to 9999 (number or bigint; booleans, fractions and
 * anything else refused with `ValidationError('slippageBps')`). `field` names it in the message.
 */
export function validateSlippageBps(bps: unknown, field = 'slippageBps'): bigint {
  const whole = typeof bps === 'bigint' || (typeof bps === 'number' && Number.isInteger(bps));
  if (!whole || BigInt(bps as number | bigint) < 0n || BigInt(bps as number | bigint) >= BPS) {
    throw new ValidationError('slippageBps', `${field} must be a whole number of bps from 0 to 9999, got ${String(bps)}.`);
  }
  return BigInt(bps as number | bigint);
}

/** A minimum from a quote: `quote * (1 - bps)`, rounded down. `bps`: 0-9999 (`validateSlippageBps`). */
export function minWithSlippage(quote: bigint, bps: number | bigint): bigint {
  const b = validateSlippageBps(bps);
  return (quote * (BPS - b)) / BPS;
}

/** A maximum from a quote: `quote * (1 + bps)`, rounded up. `bps`: 0-9999 (`validateSlippageBps`). */
export function maxWithSlippage(quote: bigint, bps: number | bigint): bigint {
  const b = validateSlippageBps(bps);
  return (quote * (BPS + b) + BPS - 1n) / BPS;
}

/**
 * A non-negative whole-number argument as bigint (at most uint256), or a `ValidationError` naming the field. A JS
 * number must be a safe integer (at most 2^53 - 1): above that it has already lost precision, so pass a bigint.
 */
export function toUint(v: number | bigint, field: string): bigint {
  if ((typeof v !== 'number' && typeof v !== 'bigint') || (typeof v === 'number' && !Number.isInteger(v))) {
    throw new ValidationError(field, `${field} must be a whole number, got ${String(v)}.`);
  }
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new ValidationError(field, `${field} is above 2^53 as a JS number and has lost precision (${String(v)}): pass a bigint.`);
  }
  const b = BigInt(v);
  if (b < 0n) throw new ValidationError(field, `${field} must not be negative, got ${b}.`);
  if (b > MAX_UINT256) throw new ValidationError(field, `${field} is too large: ${b} (above uint256).`);
  return b;
}

/**
 * An optional whole-number argument (`toUint` under `field`), undefined when omitted: undefined and null both mean "not
 * given" (as PY None).
 */
export function optUint(v: number | bigint | null | undefined, field: string): bigint | undefined {
  return v == null ? undefined : toUint(v, field);
}

/**
 * A strict address argument, checksummed: 0x plus 40 hex characters. All lower or all upper case passes; a mixed-case
 * address must carry a correct EIP-55 checksum (a typo there is refused, never re-checksummed into a valid-looking
 * address nobody controls). Anything else throws `ValidationError(field)`. Use it on every address a caller types,
 * before any read or approval.
 */
export function toAddress(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ValidationError(field, `${field} must be a 0x address (40 hex characters), got ${typeof v === 'string' ? `'${v}'` : String(v)}.`);
  }
  const body = v.slice(2);
  const oneCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!oneCase && !isAddress(v, { strict: true })) {
    throw new ValidationError(
      field,
      `${field} has a wrong checksum (a mistyped character?): ${v}. Copy the address again, or pass it all in lower case.`,
    );
  }
  return getAddress(v.toLowerCase());
}

/**
 * Text that goes on chain or into a signed hash must be well-formed: a lone (unpaired) UTF-16 surrogate would be sent as
 * U+FFFD, so the chain would store something other than what was typed. Throws `ValidationError(field)` with
 * "<field> is not valid UTF-8 text." (PY mirror: `check_text`, same rule and message). Non-strings are left to the
 * caller's own type check.
 */
export function checkText(v: unknown, field: string): void {
  if (typeof v !== 'string') return;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) throw new ValidationError(field, `${field} is not valid UTF-8 text.`);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = v.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ValidationError(field, `${field} is not valid UTF-8 text.`);
      i++;
    }
  }
}

/**
 * A strict boolean argument: only `true` / `false` pass (no truthiness: `'false'`, `1`, `0` are refused with
 * `ValidationError(field)`). When `fallback` is given, `undefined` and `null` return it (an optional parameter not
 * given, as PY None); without it, both are refused too.
 */
export function toBool(v: unknown, field: string, fallback?: boolean): boolean {
  if (v == null && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw new ValidationError(field, `${field} must be true or false, got ${typeof v === 'string' ? `'${v}'` : String(v)}.`);
  return v;
}
