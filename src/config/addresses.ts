import { Address, getAddress, isAddress } from 'viem';
import { ValidationError } from '../core/errors';
import { didYouMean } from '../core/opts';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/**
 * One main token (STASIS, tNVDA+, ...) with its own pair asset.
 */
export interface MainEntry {
  /** Stable identifier, e.g. "stasis-usdg". */
  key: string;
  /** Display fallback only; read the real name/symbol from the main. */
  label: string;
  main: Address;
  pairAsset: Address;
  /** The vault for this main (`client.vault`). */
  vault: Address;
  pairSymbol?: string;
  pairDecimals?: number;
}

/**
 * Every address the SDK talks to on one chain. A zero address means "not deployed": the module using it throws
 * `NotDeployedError` without an RPC call.
 */
export interface AddressBook {
  swap: Address;
  factory: Address;
  taxes: Address;
  leverage: Address;
  /** Read-only quotes for a main (loans, leverage, main/pair conversions). */
  mainLens: Address;
  loanHub: Address;
  vesting: Address;
  liquidator: Address;
  hopExecutor: Address;
  /** Public prediction markets. */
  tranche: Address;
  /** Private prediction markets. */
  tranchePrivate: Address;
  resolver: Address;
  /** Optional: another public market host that `client.resolver` also serves. Absent / zero by default (none). */
  extraRankedHost?: Address;
  trancheReader: Address;
  redemptionReader: Address;
  /** Up/Down markets. */
  upDown: Address;
  /** The token resolver bonds are paid in. */
  bondToken: Address;
  wrappedNative: Address;
  /** The referral registry (`client.referrals`). */
  referrals: Address;
  /**
   * ERC-8004 Identity Registry: an outside contract at one address for the whole chain (both Robinhood books carry it).
   * Zero: agent calls throw `NotDeployedError`.
   */
  erc8004Registry: Address;
  mains: MainEntry[];
  /** `key` of the default main in `mains`. */
  defaultMain: string;
}

const Z = ZERO_ADDRESS;

/** All zeros: nothing deployed. */
export const EMPTY_ADDRESS_BOOK: AddressBook = {
  swap: Z, factory: Z, taxes: Z, leverage: Z, mainLens: Z, loanHub: Z, vesting: Z, liquidator: Z, hopExecutor: Z,
  tranche: Z, tranchePrivate: Z, resolver: Z, trancheReader: Z, redemptionReader: Z, upDown: Z,
  bondToken: Z, wrappedNative: Z, referrals: Z, erc8004Registry: Z,
  mains: [],
  defaultMain: 'stasis-usdg',
};

/**
 * Robinhood Chain (4663), the real-money site. Zero = not deployed yet: a module using it throws `NotDeployedError`
 * (Python mirror: basis/config/addresses.py).
 */
export const ROBINHOOD_ADDRESSES: AddressBook = {
  ...EMPTY_ADDRESS_BOOK,
  swap: ZERO_ADDRESS,
  factory: ZERO_ADDRESS,
  taxes: ZERO_ADDRESS,
  leverage: ZERO_ADDRESS,
  mainLens: ZERO_ADDRESS,
  loanHub: ZERO_ADDRESS,
  vesting: ZERO_ADDRESS,
  liquidator: ZERO_ADDRESS,
  hopExecutor: ZERO_ADDRESS,
  tranche: ZERO_ADDRESS,
  tranchePrivate: ZERO_ADDRESS,
  resolver: ZERO_ADDRESS,
  trancheReader: ZERO_ADDRESS,
  redemptionReader: ZERO_ADDRESS,
  upDown: ZERO_ADDRESS,
  bondToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  referrals: '0xd324299e3487b5efcd6C431FD45363E41D41F151',
  erc8004Registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  mains: [
    {
      key: 'stasis-usdg', label: 'STASIS',
      main: '0x0000000000000000000000000000000000000000',
      pairAsset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      vault: '0x0000000000000000000000000000000000000000',
      pairSymbol: 'USDG', pairDecimals: 6,
    },
  ],
  defaultMain: 'stasis-usdg',
};

/**
 * Robinhood Chain (4663), the paper site: the same contracts at other addresses, on play tokens (tUSDG / tNVDA /
 * tETH). Zero = not deployed yet.
 */
export const ROBINHOOD_PAPER_ADDRESSES: AddressBook = {
  ...EMPTY_ADDRESS_BOOK,
  swap: '0x16Ce58e72238863d3393d58AbF0dfa705687075C',
  factory: '0xaDb496644CC9F8a35070d3CEb55304806d9225Ac',
  taxes: '0x3FFA5a096EEc9Acef021407b603Fdfd5aaa1Aa18',
  leverage: '0x347db256245cCa305619956B710802251F2f5Df9',
  mainLens: '0x01A3590F517FB0c823770d198243e5E385991b2C',
  loanHub: '0xA8BDA97206a6ed705df9ad83cF4bfa26DEa2b112',
  vesting: '0xBF2271C5CB6c019f73D381a4861fE05f9a6d7934',
  liquidator: '0xBCC685A09787D3243D3319031B665EE4B50466eF',
  hopExecutor: '0x3cAA7A748866725b5990330ACb1A3F8B282E55aA',
  tranche: '0xC076115de69F820E1Ea321e76ef6127d4ACe5517',
  tranchePrivate: '0x7233C395ecC1bf4337cfEfCA4c3a910cfEd7500c',
  resolver: '0x585A5E0dA4251b734319894dC56e8fa0Fa5cA93B',
  trancheReader: '0x3eA49942B43Ab1491894dD5B48e5092f5FACbC7E',
  redemptionReader: '0x859ff587d4D083dFb295361668cAca1033a3ABB1',
  upDown: '0x053CBf59DaA076Ba783b1f5De5147d52dC00521B',
  bondToken: '0x477b7223Ce57f920A5e8F215112362bDA0d2B1f9',
  wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  referrals: '0x05261333646541007088249108C85d4055915FAd',
  erc8004Registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  mains: [
    {
      key: 'stasis-usdg', label: 'STASIS',
      main: '0x541610A1868C6801d785c33BF9987a73c0992C7D',
      pairAsset: '0x477b7223Ce57f920A5e8F215112362bDA0d2B1f9',
      vault: '0x628a02aF3C1Ed7bd45Cf71b3014aB7b83d9206cd',
      pairSymbol: 'tUSDG', pairDecimals: 6,
    },
    {
      key: 'tnvdaplus-tnvda', label: 'tNVDA+',
      main: '0xd234BD98222D3c213356b978E7A7334FE69B5333',
      pairAsset: '0xc6614201D7789FCB5b7B782D58De19ea8B900821',
      vault: '0x628a02aF3C1Ed7bd45Cf71b3014aB7b83d9206cd',
      pairSymbol: 'tNVDA', pairDecimals: 18,
    },
    {
      key: 'tethplus-teth', label: 'tETH+',
      main: '0x4a33306B5777d97efa9b41Aa907E9171cDD52c97',
      pairAsset: '0x7d2F1D4e3Af725CAE4D1b795352f3aB6323B1dED',
      vault: '0x628a02aF3C1Ed7bd45Cf71b3014aB7b83d9206cd',
      pairSymbol: 'tETH', pairDecimals: 18,
    },
  ],
  defaultMain: 'stasis-usdg',
};

/** A valid address: `0x` + 40 hex digits (all lower, all upper, or a correct EIP-55 checksum). */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_RE = /^0x0{40}$/;

/**
 * "Not deployed": absent (undefined / null / '') or the zero address (`0x` + 40 zeros). The one zero check of the SDK
 * (PY `is_zero_address` is the same): a short form such as `0x0` is not an address, so it is not zero either (the
 * address book refuses it in `mergeAddressBook`).
 */
export const isZeroAddress = (a: string | undefined | null): boolean =>
  !a || (typeof a === 'string' && ZERO_RE.test(a));

/** Keys of single-contract addresses (every `AddressBook` key except `mains` / `defaultMain`), optional ones included. */
export const ADDRESS_KEYS = [
  'swap', 'factory', 'taxes', 'leverage', 'mainLens', 'loanHub', 'vesting', 'liquidator', 'hopExecutor', 'tranche',
  'tranchePrivate', 'resolver', 'trancheReader', 'redemptionReader', 'upDown', 'bondToken', 'wrappedNative',
  'referrals', 'erc8004Registry',
] as const;
/** Optional keys: absent / zero by default, passed with the `addresses` option only (PY `OPTIONAL_ADDRESS_KEYS`). */
export const OPTIONAL_ADDRESS_KEYS = ['extraRankedHost'] as const;
const MAIN_ENTRY_KEYS = new Set(['key', 'label', 'main', 'pairAsset', 'vault', 'pairSymbol', 'pairDecimals']);

function bookAddress(v: unknown, where: string): Address {
  if (typeof v !== 'string' || !ADDRESS_RE.test(v)) {
    throw new ValidationError('addresses', `addresses.${where} must be an address (0x + 40 hex digits), got ${typeof v === 'string' ? JSON.stringify(v) : String(v)}.`);
  }
  const body = v.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && !isAddress(v, { strict: true })) {
    throw new ValidationError('addresses', `addresses.${where} has a bad EIP-55 checksum (${v}): check it, or pass it all lower-case.`);
  }
  return getAddress(v.toLowerCase());
}

function bookMain(m: unknown, i: number): MainEntry {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    throw new ValidationError('addresses', `addresses.mains[${i}] must be an object, got ${String(m)}.`);
  }
  const e = m as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (!MAIN_ENTRY_KEYS.has(k)) throw new ValidationError('addresses', `addresses.mains[${i}] has an unknown key "${k}".${didYouMean([k], [...MAIN_ENTRY_KEYS])}`);
  }
  if (typeof e.key !== 'string' || !e.key) throw new ValidationError('addresses', `addresses.mains[${i}].key must be a non-empty string.`);
  if (e.label != null && typeof e.label !== 'string') throw new ValidationError('addresses', `addresses.mains[${i}].label must be a string.`);
  if (e.pairSymbol != null && typeof e.pairSymbol !== 'string') {
    throw new ValidationError('addresses', `addresses.mains[${i}].pairSymbol must be a string.`);
  }
  if (e.pairDecimals != null && (typeof e.pairDecimals !== 'number' || !Number.isInteger(e.pairDecimals) || e.pairDecimals < 0 || e.pairDecimals > 255)) {
    throw new ValidationError('addresses', `addresses.mains[${i}].pairDecimals must be a whole number 0-255, got ${String(e.pairDecimals)}.`);
  }
  const out: MainEntry = {
    key: e.key, label: (e.label as string | undefined) ?? e.key,
    main: bookAddress(e.main, `mains[${i}].main`),
    pairAsset: bookAddress(e.pairAsset, `mains[${i}].pairAsset`),
    vault: bookAddress(e.vault, `mains[${i}].vault`),
  };
  if (e.pairSymbol != null) out.pairSymbol = e.pairSymbol as string;
  if (e.pairDecimals != null) out.pairDecimals = e.pairDecimals as number;
  return out;
}

/**
 * Shallow-merge overrides over a preset; `mains` is replaced as a whole when given. Every override is checked first
 * (`ValidationError('addresses')`): a plain `{ ... }` (a Map or a class instance is refused: read as an object it would
 * be empty, and the override lost without a word; PY: a dict), a known key only, addresses `0x` + 40 hex digits
 * (checksummed on the way in; the zero address = not deployed), `mains` entries with a key and their three addresses,
 * `defaultMain` a non-empty string. Overrides left out or null, and keys set to `undefined` or null, are skipped (null =
 * left out, as PY None).
 */
export function mergeAddressBook(base: AddressBook, overrides: Partial<AddressBook> | null = {}): AddressBook {
  if (overrides === null) overrides = {};
  const proto = typeof overrides === 'object' ? Object.getPrototypeOf(overrides) : undefined;
  if (typeof overrides !== 'object' || Array.isArray(overrides) || (proto !== Object.prototype && proto !== null)) {
    const got = typeof overrides === 'object' && !Array.isArray(overrides) ? 'an object that is not a plain { ... }' : String(overrides);
    throw new ValidationError('addresses', `addresses must be an object of address-book overrides, got ${got}.`);
  }
  const single = new Set<string>([...ADDRESS_KEYS, ...OPTIONAL_ADDRESS_KEYS]);
  const out: AddressBook = { ...base, mains: [...base.mains] };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) continue;
    if (k === 'mains') {
      if (!Array.isArray(v)) throw new ValidationError('addresses', `addresses.mains must be an array, got ${String(v)}.`);
      out.mains = v.map((m, i) => bookMain(m, i));
    } else if (k === 'defaultMain') {
      if (typeof v !== 'string' || !v) throw new ValidationError('addresses', `addresses.defaultMain must be a non-empty string, got ${String(v)}.`);
      out.defaultMain = v;
    } else if (single.has(k)) {
      (out as unknown as Record<string, Address>)[k] = bookAddress(v, k);
    } else {
      const known = [...single, 'mains', 'defaultMain'];
      throw new ValidationError('addresses', `addresses has an unknown key "${k}" (known: ${known.join(', ')}).${didYouMean([k], known)}`);
    }
  }
  return out;
}
