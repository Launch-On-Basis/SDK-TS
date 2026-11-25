import { formatEther, type TransactionReceipt } from 'viem';
import { errorText, redactUrls } from './redact';
import type { SyncResult } from './sync';

/** Base class for errors the SDK raises itself (not contract reverts; those are `BasisContractError`). */
export class BasisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BasisError';
  }
}

/**
 * The contract this call needs has a zero address on the current chain, or its feature is not enabled yet
 * (`FEATURES`). No RPC call was made.
 */
export class NotDeployedError extends BasisError {
  public readonly contract: string;
  public readonly chainId: number;
  constructor(contract: string, chainId: number, message?: string) {
    super(`[basis-sdk] ${message ?? `${contract} is not deployed on chain ${chainId} (zero address). Pass its address via the "addresses" option or wait for the deployment.`}`);
    this.name = 'NotDeployedError';
    this.contract = contract;
    this.chainId = chainId;
  }
}

/** A client-side pre-check failed: the transaction would revert, so it was not sent. */
export class ValidationError extends BasisError {
  public readonly rule: string;
  constructor(rule: string, message: string) {
    super(`[basis-sdk] ${message}`);
    this.name = 'ValidationError';
    this.rule = rule;
  }
}

/**
 * What went wrong talking to the RPC node (`BasisRpcError.kind`): `network` (unreachable, connection reset, an answer
 * cut short or not JSON, an HTTP error other than 429 / 5xx), `timeout` (no answer in time, or the node's own timeout:
 * JSON-RPC -32002, "context deadline exceeded", "execution aborted (timeout = 5s)"), `rate_limited` (HTTP 429, JSON-RPC
 * -32005), `server_error` (HTTP 5xx, JSON-RPC internal error, a node that could not reach what is behind it, does not
 * know a block yet or is still building its transaction index), `insufficient_funds` (the signer cannot pay value + gas),
 * `rejected` (the node refused the signed transaction for another reason: underpriced, gas limit, ...), `nonce_used`
 * (a local key's nonce was already taken by another transaction: this write never ran and never will, so it can be
 * sent again).
 */
export type RpcErrorKind = 'network' | 'timeout' | 'rate_limited' | 'server_error' | 'insufficient_funds' | 'rejected' | 'nonce_used';

const RPC_ERROR_WHAT: Record<RpcErrorKind, string> = {
  network: 'the RPC node could not be reached',
  timeout: 'the RPC node did not answer in time',
  rate_limited: 'the RPC node rate-limited the request',
  server_error: 'the RPC node failed (server error)',
  insufficient_funds: 'the signer cannot pay the value plus gas (insufficient funds)',
  rejected: 'the RPC node refused the transaction',
  nonce_used: 'nonce already used by another transaction',
};

/**
 * viem's stock text for a JSON-RPC error code (also for an error a custom / EIP-1193 transport threw, "An unknown RPC
 * error occurred", and its wrap of a node answer it has no class for, "An error occurred while executing"): the node's
 * own words are in the error's `details`.
 */
const STOCK_RPC_TEXT = /^(RPC Request failed|Missing or invalid parameters|Invalid parameters were provided|An internal error was received|Requested resource not (available|found)|An unknown RPC error occurred|An error occurred while executing)/;

/**
 * What `cause` says, for a `BasisRpcError` message: its short message, or the node's own words when that is viem's
 * stock text for a JSON-RPC code ("Missing or invalid parameters..." for -32000), with every URL cut down to its scheme
 * and host (an RPC URL can carry an API key). An insufficient-funds answer with numbers (geth: "balance X, tx cost Y" /
 * "have X want Y") is given in ETH.
 */
function rpcDetail(kind: RpcErrorKind, cause: unknown): string {
  const c = cause as { shortMessage?: string; message?: string; details?: string } | undefined;
  const short = c?.shortMessage ?? c?.message ?? (cause === undefined ? '' : String(cause));
  const node = typeof c?.details === 'string' && c.details.trim() ? c.details.trim() : null;
  if (kind === 'insufficient_funds') {
    const text = `${node ?? ''} ${short}`;
    const m = text.match(/balance (\d+),\s*tx cost (\d+)/) ?? text.match(/have (\d+) want (\d+)/);
    if (m) {
      return `The wallet holds ${formatEther(BigInt(m[1]))} ETH and this transaction needs ${formatEther(BigInt(m[2]))} ETH up front `
        + '(gas limit x max fee, plus any value), though it spends less.';
    }
  }
  return redactUrls(node && STOCK_RPC_TEXT.test(short) ? node : short);
}

/**
 * An RPC / transport failure or a node refusal BEFORE the transaction was broadcast (simulation, gas estimate, nonce,
 * fees, or a definitive refusal of the signed transaction). Nothing was sent: retry once the cause is fixed. Not a
 * contract revert (those are `BasisContractError`). After a broadcast, failures are `TxNotConfirmedError` instead (the
 * tx may still confirm).
 */
export class BasisRpcError extends BasisError {
  public readonly kind: RpcErrorKind;
  /** HTTP status of the RPC answer when there was one (429, 503, ...), else null. */
  public readonly httpStatus: number | null;
  /** JSON-RPC error code when the node answered with one (e.g. -32005, -32000), else null. */
  public readonly rpcCode: number | null;
  /** SDK ABI name of the contract called (e.g. "Swap"), or null. */
  public readonly contract: string | null;
  public readonly functionName: string | null;
  /** The underlying viem / transport error. */
  public readonly cause: unknown;
  constructor(f: {
    kind: RpcErrorKind; contract?: string | null; functionName?: string | null; httpStatus?: number | null;
    rpcCode?: number | null; cause?: unknown;
    /** The text after "nothing was sent." (default: what `cause` says, the node's own words when viem's are stock text). */
    detail?: string;
  }) {
    const detail = f.detail ?? rpcDetail(f.kind, f.cause);
    const where = f.contract || f.functionName ? `${f.contract ?? 'contract'}.${f.functionName ?? 'call'}: ` : '';
    super(`[basis-sdk] ${where}${RPC_ERROR_WHAT[f.kind]}; nothing was sent.${detail ? ` ${detail}` : ''}`);
    this.name = 'BasisRpcError';
    this.kind = f.kind;
    this.httpStatus = f.httpStatus ?? null;
    this.rpcCode = f.rpcCode ?? null;
    this.contract = f.contract ?? null;
    this.functionName = f.functionName ?? null;
    this.cause = f.cause;
  }
}

/** A write needs a signer (privateKey or walletClient). */
export class WalletRequiredError extends BasisError {
  constructor() {
    super('[basis-sdk] Wallet required for write operations. Create the client with a privateKey or walletClient.');
    this.name = 'WalletRequiredError';
  }
}

/**
 * The transaction was sent (it has a hash) but its receipt could not be read: the wait timed out (`receiptTimeoutMs`)
 * or the RPC failed. It may still confirm, so DO NOT resend the write: check `txHash` first. Its backend sync is
 * already queued (`client.pendingSyncs`); `client.flushPendingSyncs()` delivers it once the tx is mined. `note` (also
 * at the end of the message) says how to finish what the method would have done after the tx (e.g. agent.register:
 * call registerAndSync(config, txHash) once it is mined), or null.
 */
export class TxNotConfirmedError extends BasisError {
  public readonly txHash: `0x${string}`;
  /** SDK ABI name of the contract called (e.g. "Swap"). */
  public readonly contract: string;
  public readonly functionName: string;
  /** The error of the receipt wait. */
  public readonly cause: unknown;
  /** The follow-up the caller must do once the tx is mined (the steps after the tx did not run), or null. */
  public readonly note: string | null;
  constructor(txHash: `0x${string}`, contract: string, functionName: string, cause?: unknown, note?: string | null) {
    const why = errorText(cause);
    super(
      `[basis-sdk] ${contract}.${functionName} was sent (tx ${txHash}) but its receipt could not be read: ${why} ` +
      'Do not resend it: check the hash first. Its sync is queued (client.flushPendingSyncs()).' +
      (note ? ` ${note}` : ''),
    );
    this.name = 'TxNotConfirmedError';
    this.txHash = txHash;
    this.contract = contract;
    this.functionName = functionName;
    this.cause = cause;
    this.note = note ?? null;
  }

  /** The same error with `note` (the follow-up a module method adds for the steps after its tx). */
  withNote(note: string): TxNotConfirmedError {
    return new TxNotConfirmedError(this.txHash, this.contract, this.functionName, this.cause, note);
  }
}

/** How a sent transaction was replaced in the wallet before it was mined (viem's `ReplacementReason`). */
export type TxReplacementReason = 'repriced' | 'cancelled' | 'replaced';

/**
 * The transaction was sent but another transaction with the same nonce was mined instead, so the intended call never
 * executed: `reason` 'cancelled' (a zero-value transfer to self, e.g. the wallet's "cancel") or 'replaced' (a different
 * call, value or recipient). Nothing of the intended write happened apart from the replacement's own effects; the
 * original hash will never be mined (its sync is not posted). A 'replaced' replacement that succeeded is synced
 * (`replacementSync`: the backend records it if it was a BASIS action and ignores it otherwise); a cancel is not.
 * A speed-up (same call, higher fee: 'repriced') is not an error: the write returns the mined hash with `replacedHash`.
 */
export class TxReplacedError extends BasisError {
  /** The hash the SDK broadcast (never mined). */
  public readonly originalHash: `0x${string}`;
  /** The transaction mined in its place (same sender and nonce). */
  public readonly replacementHash: `0x${string}`;
  public readonly reason: TxReplacementReason;
  /** SDK ABI name of the contract called (e.g. "Swap"). */
  public readonly contract: string;
  public readonly functionName: string;
  /** The replacement's receipt. */
  public readonly replacementReceipt: TransactionReceipt | null;
  /** The replacement's backend sync (`client.syncTx` result) when it was posted, else null. */
  public readonly replacementSync: SyncResult | null;
  constructor(args: {
    originalHash: `0x${string}`; replacementHash: `0x${string}`; reason: TxReplacementReason; contract: string;
    functionName: string; replacementReceipt?: TransactionReceipt | null; replacementSync?: SyncResult | null;
  }) {
    const what = args.reason === 'cancelled'
      ? 'it was cancelled in the wallet (a zero-value transfer to self took its nonce)'
      : 'another transaction with the same nonce (a different call) was mined in its place';
    super(
      `[basis-sdk] ${args.contract}.${args.functionName} did not execute: ${what}. Sent ${args.originalHash}, ` +
      `mined ${args.replacementHash} instead. The original will never be mined; check the replacement before sending again.`,
    );
    this.name = 'TxReplacedError';
    this.originalHash = args.originalHash;
    this.replacementHash = args.replacementHash;
    this.reason = args.reason;
    this.contract = args.contract;
    this.functionName = args.functionName;
    this.replacementReceipt = args.replacementReceipt ?? null;
    this.replacementSync = args.replacementSync ?? null;
  }
}
