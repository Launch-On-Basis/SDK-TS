import type { BasisRpcError } from './errors';
import { rpcError, type RevertContext } from './revert';

const UNKNOWN_BLOCK_RE = /unknown block|(?:header|block)\b.{0,60}\b(?:not found|could not be found)|beyond (?:the )?(?:current )?head/i;

/** Wait before each retry, ms. */
export const PINNED_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400];
/** How long `atLeastBlock` waits for the RPC's latest block to reach the pinned one, ms. PY: PIN_WAIT_S. */
export const PIN_WAIT_MS = 3_000;
/** How often `atLeastBlock` reads the block number again while it waits, ms. PY: PIN_POLL_S. */
export const PIN_POLL_MS = 200;

/** True when a node answered that it does not know the block a read named (it may only be behind). */
export function isUnknownBlockError(err: unknown): boolean {
  let e = err as { name?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 10; depth++) {
    if (e.name === 'BlockNotFoundError') return true;
    if ([e.details, e.shortMessage, e.message].some((m) => typeof m === 'string' && UNKNOWN_BLOCK_RE.test(m))) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Runs `read`, retrying it after PINNED_RETRY_DELAYS_MS while it fails with `isUnknownBlockError`. */
export async function retryPinned<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (attempt >= PINNED_RETRY_DELAYS_MS.length || !isUnknownBlockError(e)) throw e;
      await new Promise((r) => setTimeout(r, PINNED_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * `BasisRpcError` `server_error` for a node that still does not know `block` (`cause`: its answer): "the RPC node is
 * behind block N". Nothing was sent; the same call works again in a moment. PY: behind_block_error.
 */
export function behindBlockError(cause: unknown, block: bigint, ctx: RevertContext = {}): BasisRpcError {
  return rpcError(cause, 'server_error', ctx, `The RPC node is behind block ${block}: it does not know that block yet. Try again in a moment.`);
}

/**
 * `read` pinned to `block`, through `retryPinned`: a node still behind that block after the retries is
 * `behindBlockError` (never a revert); any other failure is thrown as it came. PY: retry_pinned_at.
 */
export async function retryPinnedAt<T>(read: () => Promise<T>, block: bigint, ctx: RevertContext = {}): Promise<T> {
  try {
    return await retryPinned(read);
  } catch (e) {
    if (isUnknownBlockError(e)) throw behindBlockError(e, block, ctx);
    throw e;
  }
}

/**
 * `block`, or the RPC's latest block (`latest()`) when that is later: a pinned read never names older state than it must
 * (a node keeps only recent state). While the latest is still below `block` (a node behind the one that answered with
 * it), the block number is read again every `pollMs`, up to `waitMs`, so the pinned read after it does not start on a
 * node that does not know the block yet. Never throws (a failed read gives `block`). PY: at_least_block.
 */
export async function atLeastBlock(latest: () => Promise<bigint>, block: bigint, waitMs = PIN_WAIT_MS, pollMs = PIN_POLL_MS): Promise<bigint> {
  const until = Date.now() + waitMs;
  for (;;) {
    let n: bigint;
    try {
      n = await latest();
    } catch {
      return block;
    }
    if (n >= block) return n;
    if (Date.now() >= until) return block;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * The block a signer's read goes at while `pin` (the block of its last confirmed write) is live, or null for "at
 * latest". On a chain with a block time (`blockTimeMs` > 0, from `chainBlockTimeMs`: every chain but a local node's;
 * load-balanced nodes, some a few blocks behind): `atLeastBlock` (the RPC's latest once it reached `pin`, else `pin`
 * after a short wait). On a chain without one (a local node, chain id 31337 or 1337: one node, no lag): the RPC's
 * latest when it reached `pin`, else null at once: a pin above the node's head is
 * from before a rollback (a reverted snapshot), and no block above the head can be read. Never throws (a failed read
 * gives `pin`). PY: pinned_block.
 */
export async function pinnedBlock(latest: () => Promise<bigint>, pin: bigint, blockTimeMs: number): Promise<bigint | null> {
  if (blockTimeMs > 0) return atLeastBlock(latest, pin);
  let n: bigint;
  try {
    n = await latest();
  } catch {
    return pin;
  }
  return n >= pin ? n : null;
}

/** A `readContract` for pinned reads: the client's own, through `retryPinned`. */
export function pinnedClient<C extends { readContract: (args: any) => Promise<any> }>(pc: C): { readContract: C['readContract'] } {
  return { readContract: ((args: unknown) => retryPinned(() => pc.readContract(args))) as C['readContract'] };
}
