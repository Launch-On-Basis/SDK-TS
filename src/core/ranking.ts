import { encodeAbiParameters, keccak256, numberToHex, type Hex } from 'viem';
import { ValidationError } from './errors';

export const OUTCOME_EARLY = 253;
export const OUTCOME_INVALID = 254;
export const OUTCOME_UNRESOLVED = 255;

const smallKey = (n: number): Hex => numberToHex(n, { size: 32 });

/** bytes32(253): EARLY (the event has not happened yet; resets the proposal, resolves nothing). */
export const KEY_EARLY: Hex = smallKey(OUTCOME_EARLY);
/** bytes32(254): INVALID (cost-basis refunds). Also the key of an empty ranking. */
export const KEY_INVALID: Hex = smallKey(OUTCOME_INVALID);
/** bytes32(255): UNRESOLVED (e.g. `disputedKey` before anyone disputes). */
export const KEY_UNRESOLVED: Hex = smallKey(OUTCOME_UNRESOLVED);

const MAX_UINT256 = (1n << 256n) - 1n;

function checkPick(p: number, i: number): void {
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 255) {
    throw new ValidationError('rankingEntry', `Ranking entry ${i} (${p}) is not an outcome id (an integer 0-255).`);
  }
}

function checkMask(tieMask: bigint): void {
  if (typeof tieMask !== 'bigint' || tieMask < 0n || tieMask > MAX_UINT256) {
    throw new ValidationError('tieMask', 'tieMask must be a uint256 bigint.');
  }
}

/**
 * A tie mask from untyped input, checked before anything is sent: a bigint 0..2^256-1 (`tieMask`; numbers, strings and
 * booleans are refused, nothing is coerced). Returns it.
 */
export function validateTieMask(tieMask: unknown): bigint {
  checkMask(tieMask as bigint);
  return tieMask as bigint;
}

/**
 * A ranking from untyped input (JSON, an agent), checked before anything is sent: an array whose every pick is an
 * integer 0-255 (`rankingEntry`; numeric strings and bigints are refused, nothing is coerced). Returns the picks.
 */
export function normalizeRanking(ranking: readonly unknown[]): number[] {
  if (!Array.isArray(ranking)) throw new ValidationError('ranking', 'ranking must be an array of outcome ids.');
  return ranking.map((p, i) => {
    checkPick(p as number, i);
    return p as number;
  });
}

/**
 * The key the resolver stores for (`ranking`, `tieMask`); `[]` → KEY_INVALID. `tieMask` must be a uint256 bigint (even
 * for `[]`), checked first; then `ranking` (`normalizeRanking`: an array, else 'ranking', of integers 0-255, else
 * 'rankingEntry'), as in PY.
 */
export function rankingKey(ranking: readonly number[], tieMask: bigint = 0n): Hex {
  checkMask(tieMask);
  const picks = normalizeRanking(ranking);
  if (picks.length === 0) return KEY_INVALID;
  const base = keccak256(new Uint8Array(picks));
  if (tieMask === 0n) return base;
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [base, tieMask]));
}

/**
 * Client-side check of a ranking, by the host's rules, for a market with `numOutcomes` outcomes and
 * `numTranches` = `getTrancheBP(market).length` slices. Throws `ValidationError` whose `rule` names the
 * broken rule: `tranches`, `rankingLength` (K..n entries), `rankingEntry`, `outcomeRange` (< n),
 * `duplicate`, `tieMaskBit0`, `tieMaskLength` (no bits at or past the length), `tieOrder` (tied entries
 * ascending), `tieBoundary` (the tie group covering slot K-1 ends the list).
 * An empty ranking is INVALID and always legal (the mask is ignored for it). A `ranking` that is not an array
 * is `ranking` (`normalizeRanking`).
 */
export function validateRanking(ranking: readonly number[], tieMask: bigint, numOutcomes: number, numTranches: number): void {
  if (!Array.isArray(ranking as unknown)) throw new ValidationError('ranking', 'ranking must be an array of outcome ids.');
  if (ranking.length === 0) return;
  checkMask(tieMask);
  const n = numOutcomes;
  const k = numTranches;
  const len = ranking.length;
  if (k <= 0) throw new ValidationError('tranches', 'The market has no tranches.');
  if (len < k || len > n) {
    throw new ValidationError('rankingLength', `A ranking lists ${k} to ${n} outcomes (every outcome in the top ${k} slots, ties included); got ${len}.`);
  }
  if ((tieMask & 1n) !== 0n) throw new ValidationError('tieMaskBit0', 'tieMask bit 0 must be unset (bit i ties entry i with entry i-1).');
  if (tieMask >> BigInt(len) !== 0n) throw new ValidationError('tieMaskLength', `tieMask has bits at or past the ranking length (${len}).`);
  const tied = (i: number) => (tieMask & (1n << BigInt(i))) !== 0n;
  const seen = new Set<number>();
  for (let i = 0; i < len; i++) {
    const p = ranking[i];
    checkPick(p, i);
    if (p >= n) throw new ValidationError('outcomeRange', `Outcome ${p} is out of range (the market has ${n} outcomes).`);
    if (i > 0 && tied(i) && p < ranking[i - 1]) {
      throw new ValidationError('tieOrder', `Tied entries must be in ascending outcome id order (entry ${i}: ${p} after ${ranking[i - 1]}).`);
    }
    if (seen.has(p)) throw new ValidationError('duplicate', `Outcome ${p} is listed twice.`);
    seen.add(p);
  }
  let slot = 0;
  let g0 = 0;
  while (g0 < len) {
    let g1 = g0 + 1;
    while (g1 < len && tied(g1)) g1++;
    if (slot >= k || (slot + (g1 - g0) >= k && g1 !== len)) {
      throw new ValidationError('tieBoundary', `Only outcomes in the top ${k} slots are listed: the group covering slot ${k - 1} must end the ranking.`);
    }
    if (slot + (g1 - g0) >= k) return;
    slot += g1 - g0;
    g0 = g1;
  }
  throw new ValidationError('rankingLength', 'The ranking does not reach the last tranche slot.');
}

export type RankingKeyKind = 'outcome' | 'early' | 'invalid' | 'unresolved' | 'ranking';

/**
 * Classify a key. Values below 256 are small-integer keys: 253 EARLY, 254 INVALID, 255 UNRESOLVED, else a plain
 * uint8 `outcome` (legacy uint8 host only; ranked markets never produce one). Anything else is a ranking hash:
 * resolve it with `getRanking(market, key)` on chain. Note bytes32(0) decodes as outcome 0; on the resolver it
 * usually means "unset" (no proposal / no vote), which the resolver module reports as null.
 */
export function decodeRankingKey(key: Hex): { kind: RankingKeyKind; outcome?: number } {
  const v = BigInt(key);
  if (v >= 256n) return { kind: 'ranking' };
  const n = Number(v);
  if (n === OUTCOME_EARLY) return { kind: 'early' };
  if (n === OUTCOME_INVALID) return { kind: 'invalid' };
  if (n === OUTCOME_UNRESOLVED) return { kind: 'unresolved' };
  return { kind: 'outcome', outcome: n };
}

/** Winner-take-all result: `[winner]`, mask 0. */
export function winner(outcome: number): { ranking: number[]; tieMask: bigint } {
  checkPick(outcome, 0);
  return { ranking: [outcome], tieMask: 0n };
}
