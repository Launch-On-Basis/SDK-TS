import { ValidationError } from './errors';

/** Every key of an object type, each member's keys for a union (`keyof` alone keeps only the keys they share). */
type AllKeys<T> = T extends unknown ? keyof T : never;

/**
 * The keys of an options type `T` written once as a literal `{ key: true, ... }` checked against the type: tsc fails
 * when the literal misses a key of `T` or names one `T` does not have, so a key list never drifts from its type.
 */
export type KeyMap<T> = { readonly [K in AllKeys<T> & string]: true };

/**
 * The allowed keys of one options type, made by `optionKeys<T>({ ... })` next to the type. It belongs to that type:
 * `optsOf` / `checkKeys` take only the list made for the type of the object they check.
 */
export interface OptionKeys<T> {
  /** The keys, in the literal's order (null: any key, see `ANY_KEYS`). */
  readonly keys: readonly string[] | null;
  /**
   * Type only, never set: ties the list to exactly one options type, its key set included (a type with one more
   * optional key is another type here, though TS would let one stand for the other).
   */
  readonly __options?: (t: T, k: AllKeys<T>) => [T, AllKeys<T>];
}

/** The key list of options type `T`, e.g. `optionKeys<HubRepayOptions>({ amount: true })`. */
export function optionKeys<T extends object>(map: KeyMap<T>): OptionKeys<T> {
  return Object.freeze({ keys: Object.freeze(Object.keys(map)) });
}

/** For an object whose keys are data (outcome names, addresses), not option names: every key passes. */
export const ANY_KEYS: OptionKeys<any> = Object.freeze({ keys: null });

/** ASCII lower case without `_` and `-`: `fraction_bps`, `FractionBps` and `fractionBps` meet. Same in PY. */
function normKey(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[_-]/g, '');
}

/** Optimal string alignment distance (insert, delete, replace, or swap two neighbours: one edit each). Same in PY. */
function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
    }
  }
  return d[a.length][b.length];
}

/**
 * The known key a mistyped one most likely meant: the same key in another case or with `_` / `-` (`fraction_bps` ->
 * `fractionBps`), else the nearest by edits when at most 2 edits and at most a third of the longer key away
 * (`amout` -> `amount`), the first in list order on a tie; null when none is that close. Same rule in PY.
 */
export function closestKey(key: string, known: readonly string[]): string | null {
  const k = normKey(key);
  for (const c of known) if (normKey(c) === k) return c;
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of known) {
    const d = editDistance(k, normKey(c));
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  if (best === null) return null;
  return bestD <= 2 && bestD * 3 <= Math.max(k.length, normKey(best).length) ? best : null;
}

/**
 * The hint the older unknown-key refusals (client options, `slippageBps`, `sync`, `addresses`) end with: ` Did you
 * mean 'chain'?` for one unknown key with a close known one, ` Did you mean 'chain' for 'chian', 'rpcUrl' for
 * 'rpcurl'?` for several, '' when none is close. Same in PY (`did_you_mean`).
 */
export function didYouMean(unknown: readonly string[], known: readonly string[]): string {
  const pairs = unknown.map((k) => [k, closestKey(k, known)] as const).filter((p): p is readonly [string, string] => p[1] !== null);
  if (!pairs.length) return '';
  if (unknown.length === 1) return ` Did you mean '${pairs[0][1]}'?`;
  return ` Did you mean ${pairs.map(([k, n]) => `'${n}' for '${k}'`).join(', ')}?`;
}

/**
 * The words of an unknown-key refusal, the same in PY: `options has an unknown key 'amout' (did you mean 'amount'?).
 * Known keys: amount.`
 */
export function unknownKeysMessage(field: string, unknown: readonly string[], known: readonly string[]): string {
  const named = unknown.map((k) => {
    const near = closestKey(k, known);
    return near === null ? `'${k}'` : `'${k}' (did you mean '${near}'?)`;
  });
  const what = unknown.length === 1 ? 'an unknown key' : 'unknown keys';
  return `${field} has ${what} ${named.join(', ')}. ${known.length ? `Known keys: ${known.join(', ')}.` : 'It takes no keys.'}`;
}

/**
 * Throws ValidationError(field) when the object `v` has a key outside `keys`; a key set to undefined or null counts
 * (a misspelt key is refused whatever its value). `label` names the object in the message (default `field`, e.g.
 * `markets[2]` for an entry of a list). `ANY_KEYS` lets every key pass.
 */
export function checkKeys<T extends object>(v: T, keys: OptionKeys<NoInfer<T>>, field: string, label: string = field): void {
  const known = keys.keys;
  if (known === null) return;
  const unknown = Object.keys(v).filter((k) => !known.includes(k));
  if (unknown.length) throw new ValidationError(field, unknownKeysMessage(label, unknown, known));
}

/** A plain `{ ... }`: an object whose prototype is Object.prototype or none (not an array, a Map, a class instance). */
export function isPlainOptions(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A method's options argument: undefined or null mean "none given" ({}); a plain object passes when every key it has
 * is in `keys` (the list `optionKeys` made from the method's options type); anything else throws
 * `ValidationError(field)` before any read: a value that is not a plain object (a number, a bigint, a string, a
 * boolean, an array, a class instance), and a key the type does not have, named with the key it most likely meant.
 * Plain JS and untyped callers otherwise lose a value silently: `repayLoan(id, 50_000000n)` and
 * `repayLoan(id, { amout: 50_000000n })` would both read `amount` as left out and repay the whole debt. A key set to
 * undefined is checked too. PY: keyword arguments refuse an unknown name on their own; its dict arguments go through
 * `check_keys` (basis/core/opts.py), same words. Internal (not exported from the package root).
 */
export function optsOf<T extends object>(v: T | null | undefined, keys: OptionKeys<NoInfer<T>>, field = 'options'): T {
  if (v === undefined || v === null) return {} as T;
  if (!isPlainOptions(v)) {
    const shown = typeof v === 'bigint' ? `${v}n` : typeof v === 'string' ? `'${v}'` : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object that is not a plain { ... }' : String(v);
    throw new ValidationError(field, `${field} must be an options object like { amount: ... } (or left out), got ${shown}.`);
  }
  checkKeys<T>(v, keys, field);
  return v;
}
