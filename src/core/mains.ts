import { type Address, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress } from 'viem';
import type { BasisClient } from '../BasisClient';
import { EcosystemTokenAbi, ERC20Abi, FactoryAbi, MainTokenAbi, SwapAbi } from '../abis';
import { isZeroAddress, MainEntry } from '../config/addresses';
import { BaseModule } from './BaseModule';
import { BasisError, NotDeployedError, ValidationError } from './errors';
import { Amount, toAddress, toAmount } from './units';

/** A main: its address or its address-book key ("stasis-usdg"). */
export type MainRef = Address | string;

/** One main as the chain reports it. */
export interface MainInfo {
  main: Address;
  /** `key` from the address book, or null for a main the book does not list. */
  key: string | null;
  /** ERC-20 name/symbol set at deploy ("Stasis"/"STASIS", "tNVDA+"/"tNVDA+"). */
  name: string;
  symbol: string;
  pairAsset: Address;
  pairSymbol: string;
  pairDecimals: number;
  /** `10 ** pairDecimals`: divide pair-asset prices by this, never by 1e18. */
  pairUnit: bigint;
  vault: Address;
  /** Trading on the pair is not paused. */
  active: boolean;
  /** Trading on the main has been opened (once open, it stays open). */
  tradingEnabled: boolean;
  /** Registered in the factory: tokens can be created on it. */
  registered: boolean;
  isDefault: boolean;
}

/** An amount in a main's pair asset (scaled by `pairUnit`). */
export function pairAmount(raw: bigint, info: MainInfo): Amount {
  return toAmount(raw, info.pairDecimals, 'pairAsset', info.pairAsset, info.pairSymbol);
}

/** An amount in main tokens (18 decimals). */
export function mainAmount(raw: bigint, info: MainInfo): Amount {
  return toAmount(raw, 18, 'main', info.main, info.symbol);
}

/**
 * The mains registry. Several mains exist, each with its own pair asset and vault. Tell a main with `mains.isMain`
 * (paused mains included), not with the token's own `isMain()`, which is false while the main is paused.
 * Results are cached per client; call `refresh()` after state changes.
 */
export class MainsModule extends BaseModule {
  private cache = new Map<string, Promise<MainInfo>>();
  private metaCache = new Map<string, Promise<{ decimals: number; symbol: string }>>();
  private listCache: Promise<MainInfo[]> | null = null;

  constructor(client: BasisClient) {
    super(client);
  }

  private get swap(): Address {
    return this.require(this.client.addresses.swap, 'Swap');
  }

  /** Address-book entry of the default main. */
  private defaultEntry(): MainEntry | undefined {
    const book = this.client.addresses;
    return book.mains.find((m) => m.key === book.defaultMain);
  }

  /** Every main (paused ones included; mains are never removed from the list). */
  async list(): Promise<MainInfo[]> {
    if (isZeroAddress(this.client.addresses.swap)) return [];
    if (!this.listCache) {
      this.listCache = (async () => {
        const count = await this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairCount' });
        const addrs = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairList', args: [BigInt(i)] })),
        );
        return Promise.all(addrs.map((a) => this.get(a)));
      })();
      this.listCache.catch(() => { this.listCache = null; });
    }
    return this.listCache;
  }

  /** The default main (from the address book; it cannot be read on chain). */
  async default(): Promise<MainInfo> {
    return this.get(this.defaultAddress());
  }

  /** Address of the default main, without RPC calls. `NotDeployedError` while the book's entry is still zero. */
  defaultAddress(): Address {
    const entry = this.defaultEntry();
    if (!entry) {
      throw new BasisError(`[basis-sdk] No default main configured for chain ${this.client.chainId} (addresses.defaultMain = "${this.client.addresses.defaultMain}").`);
    }
    if (isZeroAddress(entry.main)) throw new NotDeployedError(`Main ${entry.key}`, this.client.chainId);
    return getAddress(entry.main);
  }

  /** A main by address or address-book key. Verifies the book entry against the chain. */
  async get(mainOrKey: MainRef): Promise<MainInfo> {
    const main = this.addressOf(mainOrKey);
    const id = main.toLowerCase();
    let p = this.cache.get(id);
    if (!p) {
      p = this.load(main);
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id));
    }
    return p;
  }

  /** True when `token` (through `toAddress`) is a main, paused or not. */
  async isMain(token: Address): Promise<boolean> {
    const t = toAddress(token, 'token');
    const [pairAsset] = await this.publicClient.readContract({ address: this.swap, abi: SwapAbi, functionName: 'pairs', args: [t] });
    return !isZeroAddress(pairAsset);
  }

  /**
   * The main a token trades against: the token itself for a main, else the main it was created on (checksummed). An
   * address that is not a BASIS token (an outside token, a wallet) is refused with
   * `ValidationError('Not an Ecosystem token')`; RPC failures are thrown as they are. `token` through `toAddress`.
   */
  async mainOf(token: Address): Promise<Address> {
    token = toAddress(token, 'token');
    if (await this.isMain(token)) return token;
    try {
      return getAddress(await this.publicClient.readContract({ address: token, abi: EcosystemTokenAbi, functionName: 'quoteToken' }));
    } catch (e) {
      if (isNotAToken(e)) throw new ValidationError('Not an Ecosystem token', `${token} is not a BASIS token (no quoteToken()).`);
      throw e;
    }
  }

  /** MainInfo of the main a token trades against (the token's own when it is a main); 'Not an Ecosystem token' as `mainOf`. */
  async infoOfToken(token: Address): Promise<MainInfo> {
    return this.get(await this.mainOf(token));
  }

  /** ERC-20 decimals and symbol of any token (cached; both are immutable). `token` through `toAddress`. */
  async tokenMeta(token: Address): Promise<{ decimals: number; symbol: string }> {
    token = toAddress(token, 'token');
    const id = token.toLowerCase();
    let p = this.metaCache.get(id);
    if (!p) {
      p = Promise.all([
        this.publicClient.readContract({ address: token, abi: ERC20Abi, functionName: 'decimals' }),
        this.publicClient.readContract({ address: token, abi: ERC20Abi, functionName: 'symbol' }),
      ]).then(([decimals, symbol]) => ({ decimals: Number(decimals), symbol }));
      this.metaCache.set(id, p);
      p.catch(() => this.metaCache.delete(id));
    }
    return p;
  }

  async pairAssetOf(main: Address): Promise<Address> {
    return (await this.get(main)).pairAsset;
  }

  async vaultOf(main: Address): Promise<Address> {
    return (await this.get(main)).vault;
  }

  /** Clear cached main data (e.g. after a pair is paused or trading enabled). */
  refresh(): void {
    this.cache.clear();
    this.listCache = null;
  }

  /**
   * Address of a main given by address or address-book key, without RPC calls (an address goes through `toAddress`,
   * rule `main`: checksummed, unverified, so every result and cache entry carries one casing; a mixed-case address with
   * a wrong checksum is refused).
   */
  addressOf(mainOrKey: MainRef): Address {
    if (typeof mainOrKey === 'string' && /^0x[0-9a-fA-F]{40}$/.test(mainOrKey)) return toAddress(mainOrKey, 'main');
    const entry = this.client.addresses.mains.find((m) => m.key === mainOrKey);
    if (!entry) throw new BasisError(`[basis-sdk] Unknown main "${String(mainOrKey)}". Known keys: ${this.client.addresses.mains.map((m) => m.key).join(', ') || '(none)'}`);
    if (isZeroAddress(entry.main)) throw new NotDeployedError(`Main ${entry.key}`, this.client.chainId);
    return getAddress(entry.main);
  }

  private async load(main: Address): Promise<MainInfo> {
    const pc = this.publicClient;
    const swap = this.swap;
    const [pairAsset, vault, active] = await pc.readContract({ address: swap, abi: SwapAbi, functionName: 'pairs', args: [main] });
    if (isZeroAddress(pairAsset)) throw new BasisError(`[basis-sdk] ${main} is not a main on SWAP ${swap}.`);

    const entry = this.client.addresses.mains.find((m) => m.main.toLowerCase() === main.toLowerCase());
    if (entry) {
      if (entry.pairAsset.toLowerCase() !== pairAsset.toLowerCase() || entry.vault.toLowerCase() !== vault.toLowerCase()) {
        throw new BasisError(
          `[basis-sdk] Address book entry "${entry.key}" disagrees with SWAP.pairs(${main}): ` +
          `book pairAsset ${entry.pairAsset} / vault ${entry.vault}, chain ${pairAsset} / ${vault}.`,
        );
      }
    }

    const factory = this.client.addresses.factory;
    const [name, symbol, pairUnit, tradingEnabled, pairSymbol, pairDecimals, registeredPair] = await Promise.all([
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'name' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'symbol' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'PAIR_UNIT' }),
      pc.readContract({ address: main, abi: MainTokenAbi, functionName: 'tradingEnabled' }),
      pc.readContract({ address: pairAsset, abi: ERC20Abi, functionName: 'symbol' }),
      pc.readContract({ address: pairAsset, abi: ERC20Abi, functionName: 'decimals' }),
      isZeroAddress(factory)
        ? Promise.resolve(null)
        : pc.readContract({ address: factory, abi: FactoryAbi, functionName: 'getPair', args: [main, pairAsset] }),
    ]);
    if (pairUnit !== 10n ** BigInt(pairDecimals)) {
      throw new BasisError(`[basis-sdk] ${main}: PAIR_UNIT ${pairUnit} does not match the pair asset's ${pairDecimals} decimals.`);
    }
    const def = this.defaultEntry();
    return {
      main,
      key: entry?.key ?? null,
      name,
      symbol,
      pairAsset,
      pairSymbol,
      pairDecimals: Number(pairDecimals),
      pairUnit,
      vault,
      active,
      tradingEnabled,
      registered: registeredPair !== null && registeredPair.toLowerCase() === main.toLowerCase(),
      isDefault: !!def && def.main.toLowerCase() === main.toLowerCase(),
    };
  }
}

/** A main lookup that failed because the address is not a BASIS token (a revert, or no data), not the RPC. */
function isNotAToken(e: unknown): boolean {
  const walk = (e as { walk?: (fn: (x: unknown) => boolean) => unknown })?.walk;
  if (typeof walk !== 'function') return false;
  return !!walk.call(e, (x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
}
