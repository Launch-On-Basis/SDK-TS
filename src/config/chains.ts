import { Chain, defineChain } from 'viem';
import { ValidationError } from '../core/errors';
import { checkKeys, optionKeys } from '../core/opts';
import { AddressBook, EMPTY_ADDRESS_BOOK, mergeAddressBook, ROBINHOOD_ADDRESSES, ROBINHOOD_PAPER_ADDRESSES } from './addresses';

export type ChainKey = 'robinhood' | 'robinhoodPaper';

/** Everything the SDK needs to know about one network. */
export interface ChainConfig {
  key: string;
  /**
   * The viem chain: `id` is the chain id; `blockTime` (ms, optional) the block time the SDK goes by after a write
   * (`chainBlockTimeMs`: left out, BLOCK_TIME_MS by chain id, else DEFAULT_BLOCK_TIME_MS; 0 declares a local node, no
   * block time; none on a local node's chain id, LOCAL_CHAIN_IDS). PY: `chain_id` and `block_time_ms`.
   */
  chain: Chain;
  /**
   * The chain's public RPC by default. A public endpoint has no SLA (Robinhood Chain's rate-limits after a few dozen
   * calls, and its nodes are load-balanced): pass your own `rpcUrl` to the client in production.
   */
  rpcUrl: string;
  addresses: AddressBook;
  /**
   * The API this deployment syncs to (client option `apiDomain` wins). A preset always names its own: the paper site
   * never falls back to the real API.
   */
  apiDomain: string;
  /** The paper site: play tokens, same chain id as the real one (`client.paper` works here only). */
  paper?: boolean;
  /**
   * `block.number` inside a contract is the parent chain's block (Robinhood Chain: the Ethereum block, about 12 s), not
   * the chain's own. Hop route caps are per contract block, so on such a chain what a route has left
   * (`hopExecutor.capsLeft`) is what a swap sent now meets. Default false (a local node: every block starts with the
   * full caps).
   */
  contractBlockIsL1?: boolean;
}
/** The keys of a custom chain config (PY: the ChainConfig dataclass refuses another field on its own). */
const CHAIN_CONFIG_KEYS = optionKeys<ChainConfig>({
  key: true, chain: true, rpcUrl: true, addresses: true, apiDomain: true, paper: true, contractBlockIsL1: true,
});

/**
 * Robinhood Chain, 4663. viem 2.47.2 has no preset for it: same values as viem's later `robinhood` chain. About 10
 * blocks a second (`blockTime` in ms). `block.number` inside a contract is the Ethereum block on this chain (Arbitrum
 * Orbit), not the block a receipt shows.
 */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockTime: 100,
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com', apiUrl: 'https://robinhoodchain.blockscout.com/api' },
  },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

const ROBINHOOD_RPC = robinhood.rpcUrls.default.http[0];

export const CHAINS: Record<ChainKey, ChainConfig> = {
  robinhood: {
    key: 'robinhood', chain: robinhood, rpcUrl: ROBINHOOD_RPC, addresses: ROBINHOOD_ADDRESSES, apiDomain: 'https://launchonbasis.com',
    contractBlockIsL1: true,
  },
  robinhoodPaper: {
    key: 'robinhoodPaper', chain: robinhood, rpcUrl: ROBINHOOD_RPC, addresses: ROBINHOOD_PAPER_ADDRESSES,
    apiDomain: 'https://paper.launchonbasis.com', paper: true, contractBlockIsL1: true,
  },
};

export const DEFAULT_CHAIN: ChainKey = 'robinhoodPaper';

/**
 * Chain ids of a local node: Hardhat / anvil 31337, Ganache / `geth --dev` 1337. One node, no lag:
 * no block time, whatever a config says. After a write, a pin above such a node's head is from before a rollback (a
 * reverted snapshot) and is dropped (`pinnedBlock`), and `nextNonce` does not look again. Every other chain is taken
 * for load-balanced nodes that can answer a block or two behind, unless its config's block time is 0 (a local node on
 * another chain id). PY: LOCAL_CHAIN_IDS.
 */
export const LOCAL_CHAIN_IDS: readonly number[] = [31337, 1337];

/** Block time by chain id, ms (Robinhood Chain: about 10 blocks a second). PY: BLOCK_TIME_MS. */
export const BLOCK_TIME_MS: Readonly<Record<number, number>> = { 4663: 100 };

/** Block time of a chain that is not local and that neither its config nor BLOCK_TIME_MS names, ms. PY: DEFAULT_BLOCK_TIME_MS. */
export const DEFAULT_BLOCK_TIME_MS = 1_000;

/**
 * The block time the SDK goes by on chain `chainId`, ms: 0 on a local node (LOCAL_CHAIN_IDS) or without a chain id;
 * else `own` (a config's value, when a number from 0: 0 declares a local node on another chain id, no block time),
 * else BLOCK_TIME_MS, else DEFAULT_BLOCK_TIME_MS. The one rule of the pinned reads after a write (`pinnedBlock`) and of
 * `nextNonce`, so both SDKs decide the same for the same config. PY: block_time_ms.
 */
export function blockTimeMs(chainId: unknown, own?: unknown): number {
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0 || LOCAL_CHAIN_IDS.includes(chainId)) return 0;
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  return BLOCK_TIME_MS[chainId] ?? DEFAULT_BLOCK_TIME_MS;
}

/**
 * `blockTimeMs` of a chain config: its viem chain's `id` and `blockTime` (PY: the config's `chain_id` and
 * `block_time_ms`). PY: chain_block_time_ms.
 */
export function chainBlockTimeMs(cfg: ChainConfig | null | undefined): number {
  const chain = cfg?.chain as { id?: unknown; blockTime?: unknown } | undefined;
  return blockTimeMs(chain?.id, chain?.blockTime);
}

/** A plain `{ ... }` (its prototype Object.prototype, or none), as `optsOf` and `mergeAddressBook` take. PY: a dict. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** What a value is, for a refusal message. */
function shown(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'none';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return isPlainObject(v) ? 'an object' : 'an object that is not a plain { ... }';
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * Resolve a chain option: undefined or null is the default preset (`robinhoodPaper`), a string one of the preset keys (an
 * own key of `CHAINS`: '' and names like 'constructor' are refused), an object a custom config for a chain with no
 * preset: its `chain` a viem chain whose `id` is the chain id (a whole number above 0) and whose `blockTime`, when
 * given, is ms from 0 (`chainBlockTimeMs`; 0: a local node, no block time; left out: by the chain id), and its `addresses` a plain
 * address book object (not a Map or a class instance) that passes `chainAddressBook` (known keys, valid addresses);
 * a plain config object with a key ChainConfig does not have is refused too. Anything else throws ValidationError('chain'). The config itself is returned as it is. Same rule as PY
 * `resolve_chain` (None there is the default; a ChainConfig's `chain_id` and `addresses` (a dict) are checked the same
 * way).
 */
export function resolveChain(chain: ChainKey | ChainConfig | null | undefined): ChainConfig {
  if (chain === undefined || chain === null) return CHAINS[DEFAULT_CHAIN];
  const known = Object.keys(CHAINS).join(', ');
  if (typeof chain === 'string') {
    if (!Object.prototype.hasOwnProperty.call(CHAINS, chain)) {
      throw new ValidationError('chain', `Unknown chain "${chain}". Known: ${known}`);
    }
    return CHAINS[chain as ChainKey];
  }
  const c: unknown = chain;
  if (typeof c !== 'object' || Array.isArray(c)) {
    const got = Array.isArray(c) ? 'a list' : typeof c;
    throw new ValidationError('chain', `chain must be a preset name (${known}) or a chain config, got ${got}.`);
  }
  if (isPlainObject(c)) checkKeys<ChainConfig>(c as unknown as ChainConfig, CHAIN_CONFIG_KEYS, 'chain', 'the chain config');
  const cfg = c as { chain?: unknown; addresses?: unknown };
  const viemChain = cfg.chain;
  const isObject = viemChain !== null && typeof viemChain === 'object' && !Array.isArray(viemChain);
  const id = isObject ? (viemChain as { id?: unknown }).id : undefined;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ValidationError('chain',
      `a custom chain config needs chain: a viem chain whose id is the chain id (a whole number), got ${isObject ? `id ${shown(id)}` : shown(viemChain)}.`);
  }
  const blockTime = (viemChain as { blockTime?: unknown }).blockTime;
  if (blockTime != null && !(typeof blockTime === 'number' && Number.isFinite(blockTime) && blockTime >= 0)) {
    throw new ValidationError('chain',
      `a custom chain config's chain.blockTime must be the block time in ms (a number above 0; 0 for a local node), or left out, got ${shown(blockTime)}.`);
  }
  const book = cfg.addresses;
  if (!isPlainObject(book)) {
    throw new ValidationError('chain',
      `a custom chain config needs addresses: an address book object (e.g. { ...EMPTY_ADDRESS_BOOK, swap: '0x...' }), got ${shown(book)}.`);
  }
  chainAddressBook(chain);
  return chain;
}

/**
 * The address book a chain config gives the client: a preset's as it is; a custom config's checked and built over
 * `EMPTY_ADDRESS_BOOK` with `mergeAddressBook` (the `addresses` option's rule: known keys only, addresses `0x` + 40 hex
 * with a correct checksum when in mixed case, `mains` entries complete), so a key it leaves out (or sets to null) is
 * zero, not deployed, and a module using it throws NotDeployedError. A bad book throws ValidationError('chain'). The
 * client's `addresses` option then goes over it. Internal. PY: `chain_address_book`.
 */
export function chainAddressBook(cfg: ChainConfig): AddressBook {
  if ((Object.values(CHAINS) as ChainConfig[]).includes(cfg)) return cfg.addresses;
  try {
    return mergeAddressBook(EMPTY_ADDRESS_BOOK, cfg.addresses);
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new ValidationError('chain', `a custom chain config has a bad address book: ${e.message.replace(/^\[basis-sdk\] /, '')}`);
    }
    throw e;
  }
}
