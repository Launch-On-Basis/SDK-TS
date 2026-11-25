import { HttpRequestError, RpcRequestError, WaitForTransactionReceiptTimeoutError } from 'viem';
import type { Address, Hex, PublicClient, Transaction, TransactionReceipt } from 'viem';
import { ValidationError, type TxReplacementReason } from './errors';
import { errorText } from './redact';
import { isIndexingInProgress, isTransientRpcError } from './revert';

/** Gas limit sent = estimate x 120% (the bare estimate can equal gasUsed exactly and then fail in the mined block). PY: GAS_MARGIN_PCT. */
export const GAS_MARGIN_PCT = 120n;
/** The most gas one transaction may use on Robinhood Chain: the node refuses a higher gas limit. PY: MAX_TX_GAS. */
export const MAX_TX_GAS = 32_000_000n;

/** The estimate x GAS_MARGIN_PCT (rounded down), never above MAX_TX_GAS. PY: capped_gas_limit. */
export function cappedGasLimit(estimate: bigint): bigint {
  const limit = (estimate * GAS_MARGIN_PCT) / 100n;
  return limit > MAX_TX_GAS ? MAX_TX_GAS : limit;
}

/**
 * The gas limit a write sends for its `estimate`: `cappedGasLimit`. An estimate above MAX_TX_GAS throws
 * `ValidationError('gas')` (too big for one transaction): nothing is sent. PY: gas_limit_for.
 */
export function gasLimitFor(estimate: bigint): bigint {
  if (estimate > MAX_TX_GAS) {
    throw new ValidationError('gas',
      `This call needs about ${estimate} gas, too big for one transaction (the chain allows at most ${MAX_TX_GAS}). `
      + 'Do less in one call: split a batch or use a smaller amount.');
  }
  return cappedGasLimit(estimate);
}

/** Poll interval of the receipt wait, ms. */
export const POLL_INTERVAL_MS = 500;
/**
 * When a broadcast with an unclear answer is sent again while the node does not know it and its nonce is free: ms after
 * the wait starts, one re-send each.
 */
export const REBROADCAST_AT_MS: readonly number[] = [1_000, 3_000, 7_000, 15_000];
/** HTTP statuses whose body is never read as the node's answer to a broadcast: a timeout (408), a rate limit (429). */
const NOT_AN_ANSWER_STATUS: readonly number[] = [408, 429];

/** A JSON-RPC error answer's code: 3 (execution reverted) or the JSON-RPC range -32768..-32000. */
const isAnswerCode = (code: unknown): code is number =>
  typeof code === 'number' && Number.isInteger(code) && (code === 3 || (code >= -32768 && code <= -32000));

/**
 * The node's JSON-RPC error answer carried in an HTTP 4xx answer to a broadcast, as viem raises the same answer sent
 * with HTTP 200 (an RpcRequestError with the error object as its cause), or null. Some nodes and gateways answer a
 * refusal ("insufficient funds", "nonce too low", ...) with HTTP 400 and the JSON-RPC answer in the body; viem keeps
 * that body's `error` object (as JSON, in the HttpRequestError's `details`), and the HTTP status alone would leave the
 * broadcast "sent, unknown" for the whole receipt wait. Only an object with a JSON-RPC answer code (3 or
 * -32768..-32000) and a `message` string counts; never 408 or 429 (a timeout, a rate limit) nor 5xx (a proxy may have
 * passed the transaction on). The answer is then judged like any other (a timeout or failure behind the node it names
 * stays "sent, unknown"). Its BasisRpcError carries the JSON-RPC code, no HTTP status. PY: http_error_answer.
 */
export function httpErrorAnswer(err: unknown): RpcRequestError | null {
  let e = err as { name?: unknown; status?: unknown; details?: unknown; body?: unknown; url?: unknown; cause?: unknown; error?: unknown } | null;
  for (let i = 0; e != null && typeof e === 'object' && i < 12; i++, e = (e.cause ?? e.error) as typeof e) {
    if (e.name !== 'HttpRequestError') continue;
    const s = e.status;
    if (typeof s !== 'number' || s < 400 || s > 499 || NOT_AN_ANSWER_STATUS.includes(s) || typeof e.details !== 'string') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.details);
    } catch {
      return null;
    }
    const a = parsed as { code?: unknown; message?: unknown; data?: unknown } | null;
    if (!a || typeof a !== 'object' || Array.isArray(a) || !isAnswerCode(a.code) || typeof a.message !== 'string') return null;
    const error = { code: a.code, message: a.message, ...(a.data !== undefined ? { data: a.data } : {}) };
    const body = (e.body && typeof e.body === 'object' ? e.body : {}) as Record<string, unknown>;
    return new RpcRequestError({ body, error, url: typeof e.url === 'string' ? e.url : '' });
  }
  return null;
}

/**
 * A JSON-RPC error body that came with a non-2xx HTTP status, in the one shape the rest of the pipeline reads: an
 * HttpRequestError with the status and the error object as JSON in its `details`. Newer viem releases raise that case
 * as an RpcRequestError carrying a `status` (older ones as an HttpRequestError), and read as a plain JSON-RPC answer
 * it would turn the body of a 429 / 5xx (a gateway's, maybe after it passed the transaction on) into a refusal.
 * Anything else is returned as it is. `httpErrorAnswer` then reads a 4xx body as the node's answer, as before.
 */
export function httpStatusShape(err: unknown): unknown {
  let e = err as { name?: unknown; status?: unknown; body?: unknown; url?: unknown; cause?: unknown; error?: unknown } | null;
  for (let i = 0; e != null && typeof e === 'object' && i < 12; i++, e = (e.cause ?? e.error) as typeof e) {
    if (e.name === 'HttpRequestError') return err;
    if (e.name !== 'RpcRequestError' || typeof e.status !== 'number' || e.status < 400) continue;
    const a = e.cause as { code?: unknown; message?: unknown; data?: unknown } | null;
    const error = a && typeof a === 'object'
      ? { code: a.code, message: a.message, ...(a.data !== undefined ? { data: a.data } : {}) }
      : {};
    let details: string;
    try {
      details = JSON.stringify(error);
    } catch {
      details = '{}';
    }
    const body = (e.body && typeof e.body === 'object' ? e.body : undefined) as Record<string, unknown> | undefined;
    return new HttpRequestError({ body, details, status: e.status, url: typeof e.url === 'string' ? e.url : '' });
  }
  return err;
}

/** The fields of the sent transaction the classification compares (`nonce` undefined: not known yet). */
export interface SentTx {
  nonce?: number;
  to?: Address | null;
  value?: bigint;
  data?: Hex;
}

/** A transaction mined with the sent one's nonce instead of it. */
export interface Replacement {
  reason: TxReplacementReason;
  hash: Hex;
  transaction: Transaction;
}

/**
 * Thrown by `waitForReceipt` for a local key whose nonce went to another transaction: the write never ran and never
 * will. `hash` / `transaction` / `receipt`: that transaction when it was found (null when it was mined before the send,
 * or not located).
 */
export class NonceAlreadyUsed extends Error {
  constructor(
    public readonly nonce: number,
    public readonly hash: Hex | null,
    public readonly transaction: Transaction | null,
    public readonly receipt: TransactionReceipt | null,
  ) {
    super(`nonce ${nonce} is taken by ${hash ?? 'an earlier transaction'}: this write did not run and never will, so it can be sent again`);
    this.name = 'NonceAlreadyUsed';
  }
}

/** The nonce after the last transaction a client saw mined for a local key, and that transaction's hash. */
export interface NonceFloor {
  nonce: number;
  hash: Hex;
}

const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const notFound = (e: unknown) => /NotFound/.test((e as Error)?.name ?? '');
/** Not found, or not found YET: the node is still building its transaction index (`isIndexingInProgress`). */
const notYet = (e: unknown) => notFound(e) || isIndexingInProgress(e);

/**
 * viem's rule: same `to`, `value` and calldata = 'repriced'; a zero-value transfer to self = 'cancelled'; else
 * 'replaced'.
 */
export function classifyReplacement(original: SentTx, replacement: { from: string; to?: string | null; value?: bigint; input?: string }): TxReplacementReason {
  if (lc(replacement.to) === lc(original.to) && (replacement.value ?? 0n) === (original.value ?? 0n) && lc(replacement.input || '0x') === lc(original.data || '0x')) {
    return 'repriced';
  }
  if (lc(replacement.from) === lc(replacement.to) && (replacement.value ?? 0n) === 0n) return 'cancelled';
  return 'replaced';
}

/** The receipt of `hash`, or null when the node has none (yet: `notYet`); a transient failure is thrown. */
async function receiptOf(pc: PublicClient, hash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await pc.getTransactionReceipt({ hash });
  } catch (e) {
    if (notYet(e)) return null;
    throw e;
  }
}

/**
 * True when the node knows `hash` (pending or mined), false when it does not, null when it cannot say yet (it is still
 * building its transaction index: `isIndexingInProgress`); a transient failure is thrown.
 */
async function knows(pc: PublicClient, hash: Hex): Promise<boolean | null> {
  try {
    await pc.getTransaction({ hash });
    return true;
  } catch (e) {
    if (notFound(e)) return false;
    if (isIndexingInProgress(e)) return null;
    throw e;
  }
}

/**
 * The nonce to sign a local key's next transaction with: the RPC's pending count, or `floor.nonce` when the RPC counts
 * less while `floor.hash` (the client's last transaction, at `floor.nonce - 1`) is mined: a node a block or two behind.
 * When neither shows up, it looks again after `blockTimeMs` (twice; not at all without a block time, as on a local
 * node: the write pipeline passes `chainBlockTimeMs`, the pinned reads' rule, PY's too), then takes the RPC's count: on
 * a chain rolled back (a local node's snapshot) the floor is gone, and a nonce that
 * is used after all is refused at the broadcast, never sent twice. A transient failure is thrown; so is a node that
 * still answers "transaction indexing is in progress" for `floor.hash` after those looks (it cannot say whether that
 * transaction is mined: the write is `BasisRpcError` `server_error`, nothing sent).
 */
export async function nextNonce(pc: PublicClient, from: Address, floor: NonceFloor | undefined, blockTimeMs = 0): Promise<number> {
  let pending = await pc.getTransactionCount({ address: from, blockTag: 'pending' });
  if (!floor || pending >= floor.nonce) return pending;
  for (let i = 0; ; i++) {
    let indexing: unknown;
    try {
      if (await pc.getTransactionReceipt({ hash: floor.hash })) return floor.nonce;
    } catch (e) {
      if (isIndexingInProgress(e)) indexing = e;
      else if (!notFound(e)) throw e;
    }
    if (i >= 2 || !(blockTimeMs > 0)) {
      if (indexing !== undefined) throw indexing;
      return pending;
    }
    await sleep(blockTimeMs);
    pending = await pc.getTransactionCount({ address: from, blockTag: 'pending' });
    if (pending >= floor.nonce) return pending;
  }
}

/**
 * The first block in (`lo`, `hi`] where `from`'s transaction count passed `nonce`: `getTransactionCount` at the middle
 * block, about log2(hi - lo) reads. A read the node refuses for good (state it no longer keeps: a non-archive node keeps
 * seconds of it here) moves the search up, to the recent blocks it can answer for; a transient failure is thrown. The
 * answer can be off when the count at `hi` has not passed yet (a node a block behind): the caller finds no transaction
 * in that block and polls again.
 */
export async function nonceBlock(
  pc: { getTransactionCount(a: { address: Address; blockNumber: bigint }): Promise<number> },
  from: Address, nonce: number, lo: bigint, hi: bigint,
): Promise<bigint> {
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    let count: number;
    try {
      count = await pc.getTransactionCount({ address: from, blockNumber: mid });
    } catch (e) {
      if (isTransientRpcError(e)) throw e;
      lo = mid;
      continue;
    }
    if (count > nonce) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Waits for `hash` (sent by `from`; `original` the sent transaction; `startBlock` the latest block before sending).
 * Resolves `{ receipt }` when it is mined, or `{ receipt, replacement }` (the replacement's receipt) when another
 * transaction with its nonce was mined instead. A transient RPC failure (`isTransientRpcError`) is retried at the next
 * poll, and a lookup answered "transaction indexing is in progress" is not found yet; throws viem's
 * `WaitForTransactionReceiptTimeoutError` after `timeoutMs` and lets other RPC errors through.
 * A nonce learned from the RPC (injected wallet) is written to `args.original.nonce`, so it is known after a timeout.
 *
 * With `local` (the SDK signed with a local key): another transaction mined with the nonce, the same call included, or
 * one mined at or before `startBlock`, throws `NonceAlreadyUsed` (`nonceUsedOnSend`, the broadcast answered "nonce too
 * low": any other transaction does). Only a transaction found on chain says so: while neither this hash nor another
 * transaction with the nonce is found (a node that says it does not know this hash proves nothing: something between
 * the SDK and the node may have sent these bytes on), the wait goes on until `timeoutMs`. `rebroadcast` (given after a
 * broadcast with an unclear answer) re-sends the same signed bytes at `rebroadcastAtMs` while the node does not know
 * the hash and the nonce is still free (its own refusals and blips never end the wait).
 */
export async function waitForReceipt(
  pc: PublicClient,
  args: {
    hash: Hex; from: Address; original: SentTx; startBlock: bigint; timeoutMs: number; pollMs?: number;
    local?: boolean; nonceUsedOnSend?: boolean;
    rebroadcast?: () => Promise<unknown>; rebroadcastAtMs?: readonly number[];
  },
): Promise<{ receipt: TransactionReceipt; replacement?: Replacement }> {
  const { hash, from, startBlock, timeoutMs } = args;
  const pollMs = args.pollMs ?? POLL_INTERVAL_MS;
  const original: SentTx = { ...args.original };
  const ours = lc(hash);
  const me = lc(from);
  const started = Date.now();
  const deadline = started + timeoutMs;
  const firstBlock = startBlock < 0n ? 0n : startBlock;
  const resendAt = args.rebroadcastAtMs ?? REBROADCAST_AT_MS;
  let resent = 0;
  let staleChecked = !args.local;
  let lastError: unknown;
  for (;;) {
    try {
      const r = await receiptOf(pc, hash);
      if (r) return { receipt: r };
      if (original.nonce === undefined) {
        try {
          const tx = await pc.getTransaction({ hash });
          original.nonce = tx.nonce;
          args.original.nonce = tx.nonce;
          original.to ??= tx.to;
          original.value ??= tx.value;
          original.data ??= tx.input;
        } catch (e) {
          if (!notYet(e)) throw e;
        }
      }
      const nonce = original.nonce;
      if (nonce !== undefined) {
        const count = await pc.getTransactionCount({ address: from, blockTag: 'latest' });
        if (count > nonce) {
          const again = await receiptOf(pc, hash);
          if (again) return { receipt: again };
          if (!staleChecked) {
            let before: number | null = null;
            try {
              before = await pc.getTransactionCount({ address: from, blockNumber: firstBlock });
            } catch (e) {
              if (isTransientRpcError(e)) throw e;
            }
            if (before !== null) {
              staleChecked = true;
              if (before > nonce) throw new NonceAlreadyUsed(nonce, null, null, null);
            }
          }
          const latest = await pc.getBlockNumber({ cacheTime: 0 });
          const at = await nonceBlock(pc, from, nonce, firstBlock - 1n, latest);
          let block;
          try {
            block = await pc.getBlock({ blockNumber: at, includeTransactions: true });
          } catch (e) {
            if (!notFound(e)) throw e;
          }
          const found = (block?.transactions as Transaction[] | undefined)?.find((t) => lc(t.from) === me && t.nonce === nonce);
          if (found) {
            const ownFound = lc(found.hash) === ours;
            const rr = await receiptOf(pc, found.hash);
            if (rr && ownFound) return { receipt: rr };
            if (rr) {
              const reason = classifyReplacement(original, found);
              if (args.local && (reason === 'repriced' || args.nonceUsedOnSend)) throw new NonceAlreadyUsed(nonce, found.hash, found, rr);
              return { receipt: rr, replacement: { reason, hash: found.hash, transaction: found } };
            }
          }
        } else if (args.rebroadcast && resent < resendAt.length && Date.now() - started >= resendAt[resent]) {
          resent++;
          if ((await knows(pc, hash)) !== true) {
            try {
              await args.rebroadcast();
            } catch {
            }
          }
        }
      }
      lastError = undefined;
    } catch (e) {
      if (e instanceof NonceAlreadyUsed || !isTransientRpcError(e)) throw e;
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const err = new WaitForTransactionReceiptTimeoutError({ hash });
      if (lastError !== undefined) {
        (err as { details?: string }).details = `last RPC error: ${errorText(lastError)}`;
        (err as { cause?: unknown }).cause = lastError;
      }
      throw err;
    }
    await sleep(pollMs);
  }
}
