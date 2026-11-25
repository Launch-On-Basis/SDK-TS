import type { Abi, Address } from 'viem';
import type { BasisClient } from '../BasisClient';
import { retryPinned } from './pinned';
import { decodeRevert, type SdkAbiName } from './revert';

/** One read of a `multicall`: the call, and the SDK contract name used in errors. */
export interface MulticallRead {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  contract: SdkAbiName;
}

/**
 * Run `reads` in one eth_call: `Multicall3.aggregate3` at the chain's `multicall3` contract (the preset names the
 * canonical one), or deployless inside the call on a chain without one (a local node, a custom chain). Returns each result as
 * `readContract` would. A failed read throws `BasisContractError` naming its contract and function, the same as reading
 * it alone. `opts.blockNumber` pins every read to that block (a lagging node's "unknown block" is retried briefly).
 */
export async function multicall(
  client: BasisClient, reads: readonly MulticallRead[], opts: { blockNumber?: bigint } = {},
): Promise<unknown[]> {
  if (reads.length === 0) return [];
  const pc = client.publicClient;
  const call = () => pc.multicall({
    contracts: reads.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, args })),
    allowFailure: true,
    deployless: !pc.chain?.contracts?.multicall3,
    blockNumber: opts.blockNumber,
  });
  const res = opts.blockNumber === undefined ? await call() : await retryPinned(call);
  return res.map((r, i) => {
    if (r.status === 'failure') {
      throw decodeRevert(r.error, { contract: reads[i].contract, functionName: reads[i].functionName, abi: reads[i].abi });
    }
    return r.result;
  });
}

/** One result of `multicallSettled`: the decoded value, or the decoded revert of that read alone. */
export type SettledRead = { ok: true; result: unknown } | { ok: false; error: Error };

/**
 * `multicall` that does not throw on a failed read: each entry says whether its read worked (a revert, or no contract at
 * the address, is `ok: false` with the decoded error). An RPC failure of the whole call still throws.
 */
export async function multicallSettled(client: BasisClient, reads: readonly MulticallRead[]): Promise<SettledRead[]> {
  if (reads.length === 0) return [];
  const pc = client.publicClient;
  const res = await pc.multicall({
    contracts: reads.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, args })),
    allowFailure: true,
    deployless: !pc.chain?.contracts?.multicall3,
  });
  return res.map((r, i): SettledRead => (r.status === 'failure'
    ? { ok: false, error: decodeRevert(r.error, { contract: reads[i].contract, functionName: reads[i].functionName, abi: reads[i].abi }) }
    : { ok: true, result: r.result }));
}
