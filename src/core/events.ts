import { type Abi, type Address, type ContractEventName, type Hex, type Log, parseEventLogs, type ParseEventLogsReturnType } from 'viem';

/** The decoded `args` of event `N` of `A` (named by the ABI, e.g. `{ tokenAddress, ... }`). */
export type EventArgs<A extends Abi, N extends ContractEventName<A>> = ParseEventLogsReturnType<A, N, true>[number]['args'];

/**
 * The decoded args of every `eventName` log in `receipt` emitted by `address` (one address or several), in log order.
 * Logs of other contracts, other events and logs that do not decode are ignored. An empty list when there is none; an
 * event without arguments gives `{}` per log.
 */
export function decodeEvents<const A extends Abi, N extends ContractEventName<A>>(
  receipt: { logs: readonly Log[] },
  abi: A,
  eventName: N,
  address: Address | readonly Address[],
): EventArgs<A, N>[] {
  const want = new Set((Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()));
  const logs = receipt.logs.filter((l) => want.has(l.address.toLowerCase()));
  const parsed = parseEventLogs({ abi, eventName, logs: logs as Log[], strict: true } as any) as unknown as { args: EventArgs<A, N> }[];
  return parsed.map((l) => (l.args ?? {}) as EventArgs<A, N>);
}

/** The text of a missing-event warning (same wording in both SDKs). `fields`: the result fields left null. */
export function missingEventWarning(contract: string, eventName: string, hash: Hex | string, fields: readonly string[] = []): string {
  const left = fields.length ? `: ${fields.join(', ')} ${fields.length === 1 ? 'is' : 'are'} null` : '';
  return `${contract} ${eventName} event not found in the logs of ${hash}${left}. The transaction is confirmed: do not resend it.`;
}

/**
 * Appends a missing-event warning to `tx.warnings` (and logs it). Use after a confirmed write when an expected event
 * is absent; set the result fields it would have filled to null. Never throws.
 */
export function addMissingEventWarning(
  tx: { hash: Hex | string; warnings: string[] }, contract: string, eventName: string, fields: readonly string[] = [],
): string {
  const msg = missingEventWarning(contract, eventName, tx.hash, fields);
  tx.warnings.push(msg);
  console.warn(`[basis-sdk] ${msg}`);
  return msg;
}
