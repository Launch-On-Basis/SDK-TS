import { ADDRESS_KEYS, type AddressBook, isZeroAddress } from '../config/addresses';
import type { ChainConfig } from '../config/chains';

const eq = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Keys whose non-zero book value is kept when contracts.json serves zero (chain-wide contracts the dapp may not list). */
export const KEEP_IF_ZERO_KEYS: readonly string[] = ['erc8004Registry', 'wrappedNative'];

/**
 * The problem with the deployment a `/contracts.json` names, for `chain`, or null. Real and paper share chain 4663, so
 * the file's `network` (`robinhood` on the real site, `robinhood-paper` on the paper site: a `-paper` key is a paper
 * deployment) or an older file's `paper` flag is what tells them apart; each is compared with the preset's `paper`. A
 * file with neither (or other types) is no problem. `prelaunch` needs nothing: its BASIS contracts are zero, which the
 * address comparison reads as not deployed.
 */
export function contractsFlagMismatch(remote: Record<string, unknown>, chain: ChainConfig): string | null {
  const mine = chain.paper === true;
  const what = mine ? 'the paper deployment' : 'not the paper deployment';
  if (typeof remote.paper === 'boolean' && remote.paper !== mine) {
    return `paper: SDK chain ${chain.key} is ${what}, contracts.json says paper ${remote.paper}`;
  }
  if (typeof remote.network === 'string' && remote.network && /-paper$/i.test(remote.network) !== mine) {
    return `network: SDK chain ${chain.key} is ${what}, contracts.json serves network ${remote.network}`;
  }
  return null;
}

/**
 * Address book from a dapp `/contracts.json` (camelCase keys incl. `mainLens`, `referrals`, `mains[]`), over `base`.
 * Accepts the aliases `marketTrading` / `privateMarket` / `reader` for `tranche` / `tranchePrivate` / `trancheReader`; a
 * main listed without a `vault` takes its own `staking` value, else the file's `staking`. A zero `erc8004Registry` /
 * `wrappedNative` keeps the base value (`KEEP_IF_ZERO_KEYS`). The `paper` / `prelaunch` flags are not address-book keys:
 * check them with `contractsFlagMismatch` (`client.checkContracts` does).
 */
export function addressBookFromContractsJson(remote: Record<string, any>, base: AddressBook): AddressBook {
  const out: AddressBook = { ...base, mains: [...base.mains] };
  const alias: Record<string, string> = { tranche: 'marketTrading', tranchePrivate: 'privateMarket', trancheReader: 'reader' };
  for (const key of ADDRESS_KEYS) {
    const v = remote[key] ?? (alias[key] ? remote[alias[key]] : undefined);
    if (typeof v !== 'string') continue;
    if (KEEP_IF_ZERO_KEYS.includes(key) && isZeroAddress(v) && !isZeroAddress((base as any)[key])) continue;
    (out as any)[key] = v;
  }
  if (Array.isArray(remote.mains)) {
    out.mains = remote.mains.map((m: any) => ({
      key: m.key, label: m.label ?? m.key, main: m.main, pairAsset: m.pairAsset, vault: m.vault ?? m.staking ?? remote.staking,
      ...(m.pairSymbol !== undefined ? { pairSymbol: m.pairSymbol } : {}),
      ...(m.pairDecimals !== undefined ? { pairDecimals: Number(m.pairDecimals) } : {}),
    }));
    const def = out.mains.find((m) => eq(m.main, remote.mainToken)) ?? out.mains.find((m) => m.key === base.defaultMain) ?? out.mains[0];
    if (def) out.defaultMain = def.key;
  }
  return out;
}
