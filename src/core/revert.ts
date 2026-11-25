import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, decodeErrorResult } from 'viem';
import type { Abi, Hex } from 'viem';
import * as Abis from '../abis';
import { BasisError, BasisRpcError, type RpcErrorKind } from './errors';
import { errorText, redactUrls } from './redact';
import {
  ERROR_MAP,
  EXTRA_ERRORS,
  GENERIC_REVERT,
  NO_REASON_HINTS,
  PANIC_MESSAGES,
  type SdkAbiName,
} from './errorMap';

export type { SdkAbiName } from './errorMap';

export type RevertKind = 'reason' | 'customError' | 'panic' | 'noReason' | 'unknown';

export interface RevertContext {
  contract?: SdkAbiName | null;
  functionName?: string | null;
  /** ABI to try first when decoding custom errors. */
  abi?: Abi;
}

const ERROR_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Solidity panic codes. */
export const PANIC_NAMES: Record<number, string> = {
  0x00: 'generic panic',
  0x01: 'assert failed',
  0x11: 'arithmetic overflow/underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum value',
  0x22: 'invalid storage byte array',
  0x31: 'pop on empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory',
  0x51: 'zero-initialized function pointer',
};

/** A contract call reverted. `hint` is the human explanation when one is known. */
export class BasisContractError extends BasisError {
  public readonly contract: SdkAbiName | null;
  public readonly functionName: string | null;
  public readonly kind: RevertKind;
  public readonly reason: string | null;
  /** Decoded custom-error / panic arguments. */
  public readonly errorArgs: readonly unknown[];
  public readonly hint: string | null;
  public readonly cause: unknown;

  constructor(f: {
    contract?: SdkAbiName | null;
    functionName?: string | null;
    kind: RevertKind;
    reason?: string | null;
    args?: readonly unknown[];
    hint?: string | null;
    cause?: unknown;
  }) {
    const contract = f.contract ?? null;
    const functionName = f.functionName ?? null;
    super(`${contract ?? 'contract'}.${functionName ?? 'call'} reverted: ${f.hint ?? f.reason ?? 'unknown error'}`);
    this.name = 'BasisContractError';
    this.contract = contract;
    this.functionName = functionName;
    this.kind = f.kind;
    this.reason = f.reason ?? null;
    this.errorArgs = f.args ?? [];
    this.hint = f.hint ?? null;
    this.cause = f.cause;
  }
}


type ErrorItem = { type: 'error'; name: string; inputs: readonly { name?: string; type: string; components?: any }[] };
let ALL_ERRORS: ErrorItem[] | null = null;
let OWNER: Map<string, SdkAbiName[]> | null = null;

function errorIndex(): { all: ErrorItem[]; owner: Map<string, SdkAbiName[]> } {
  if (!ALL_ERRORS || !OWNER) {
    const all: ErrorItem[] = [];
    const owner = new Map<string, SdkAbiName[]>();
    const seen = new Set<string>();
    const add = (e: ErrorItem, c?: SdkAbiName) => {
      const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
      if (!seen.has(sig)) {
        seen.add(sig);
        all.push(e);
      }
      if (c) owner.set(e.name, [...(owner.get(e.name) ?? []), c]);
    };
    for (const [key, abi] of Object.entries(Abis)) {
      const c = key.replace(/Abi$/, '') as SdkAbiName;
      for (const item of abi as readonly any[]) if (item.type === 'error') add(item, c);
    }
    for (const e of EXTRA_ERRORS) add(e as unknown as ErrorItem);
    ALL_ERRORS = all;
    OWNER = owner;
  }
  return { all: ALL_ERRORS, owner: OWNER };
}

function tryDecodeCustom(abi: readonly any[], data: Hex): { name: string; args: readonly unknown[] } | null {
  try {
    const errs = abi.filter((i) => i?.type === 'error');
    if (!errs.length) return null;
    const r = decodeErrorResult({ abi: errs as Abi, data });
    return { name: r.errorName, args: (r.args as readonly unknown[] | undefined) ?? [] };
  } catch {
    return null;
  }
}


/** Message for a reason / custom error name: (contract, fn) → (contract, '*') → global → any contract. */
export function lookupHint(contract: string | null | undefined, functionName: string | null | undefined, reason: string): string | null {
  if (contract) {
    const c = ERROR_MAP[contract];
    const m = (functionName && c?.[functionName]?.[reason]) || c?.['*']?.[reason];
    if (m) return m;
  }
  const g = ERROR_MAP['*']?.['*']?.[reason];
  if (g) return g;
  for (const fns of Object.values(ERROR_MAP)) for (const reasons of Object.values(fns)) if (reasons[reason]) return reasons[reason];
  return null;
}

/** Rules behind a bare revert of (contract, fn), joined as "one of: …", or the generic message. */
export function noReasonHint(contract: string | null | undefined, functionName: string | null | undefined): string {
  const list = (contract && functionName && NO_REASON_HINTS[contract]?.[functionName]) || [];
  if (!list.length) return GENERIC_REVERT;
  return list.length === 1 ? list[0] : `one of: ${list.join(' | ')}`;
}

function panicHint(code: number): string {
  const key = `0x${code.toString(16).padStart(2, '0')}`;
  return PANIC_MESSAGES[key] ?? PANIC_NAMES[code] ?? `panic ${key}`;
}


interface Decoded {
  kind: RevertKind;
  reason: string | null;
  args: readonly unknown[];
  contract?: SdkAbiName;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** Decode raw revert data (Error(string), Panic(uint256) or a custom error). */
export function decodeRevertData(data: Hex, ctx: RevertContext | null = {}): Decoded {
  if (!data || data === '0x') return { kind: 'noReason', reason: null, args: [] };
  const sel = data.slice(0, 10).toLowerCase();
  try {
    if (sel === ERROR_SELECTOR) {
      const [msg] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`);
      return msg ? { kind: 'reason', reason: msg, args: [] } : { kind: 'noReason', reason: null, args: [] };
    }
    if (sel === PANIC_SELECTOR) {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}`);
      return { kind: 'panic', reason: `Panic(0x${code.toString(16).padStart(2, '0')})`, args: [code] };
    }
  } catch {
    return { kind: 'unknown', reason: sel, args: [] };
  }
  const { all, owner } = errorIndex();
  const ownAbi = ctx?.contract ? ((Abis as Record<string, readonly any[]>)[`${ctx.contract}Abi`] ?? []) : [];
  const hit = (ctx?.abi && tryDecodeCustom(ctx.abi, data)) || tryDecodeCustom(ownAbi, data) || tryDecodeCustom(all, data);
  if (!hit) return { kind: 'unknown', reason: sel, args: [] };
  const owners = owner.get(hit.name);
  return { kind: 'customError', reason: hit.name, args: hit.args, contract: owners?.length === 1 ? owners[0] : undefined };
}

/** Parse a revert out of a plain message ("reverted with reason string '…'", "execution reverted: …"). */
function decodeMessage(msg: string): Decoded | null {
  let m = msg.match(/reverted with reason string '([^']*)'/);
  if (m) return m[1] ? { kind: 'reason', reason: m[1], args: [] } : { kind: 'noReason', reason: null, args: [] };
  m = msg.match(/reverted with custom error '([A-Za-z_][A-Za-z0-9_]*)\(/);
  if (m) return { kind: 'customError', reason: m[1], args: [] };
  m = msg.match(/reverted with panic code (0x[0-9a-fA-F]+)/);
  if (m) return { kind: 'panic', reason: `Panic(0x${parseInt(m[1], 16).toString(16).padStart(2, '0')})`, args: [BigInt(m[1])] };
  m = msg.match(/reverted with the following reason:\s*\n?\s*([^\n]+)/);
  if (m && m[1].trim() !== 'execution reverted') return { kind: 'reason', reason: m[1].trim(), args: [] };
  m = msg.match(/execution reverted:\s*([^\n]+)/);
  if (m) {
    const r = m[1].trim().replace(/^["']|["']$/g, '');
    if (HEX_RE.test(r) && r.length >= 10) return null;
    return r ? { kind: 'reason', reason: r, args: [] } : { kind: 'noReason', reason: null, args: [] };
  }
  if (/execution reverted|reverted\.|\brevert(ed)?\b/i.test(msg)) return { kind: 'noReason', reason: null, args: [] };
  return null;
}

/** First hex revert payload found on the error chain (`data`, `data.data`, `raw`, `cause`, `error`). */
function findHexData(err: unknown, depth = 0): Hex | null {
  if (err == null || depth > 8) return null;
  if (typeof err === 'string') return HEX_RE.test(err) && (err.length >= 10 || err === '0x') ? (err as Hex) : null;
  if (typeof err !== 'object') return null;
  const o = err as Record<string, unknown>;
  for (const k of ['raw', 'data', 'error', 'cause']) {
    const v = o[k];
    if (v == null) continue;
    if (k === 'data' && typeof v === 'object' && !('data' in (v as object)) && 'errorName' in (v as object)) continue;
    const h = findHexData(v, depth + 1);
    if (h && h !== '0x') return h;
  }
  return null;
}

function messages(err: unknown): string[] {
  const out: string[] = [];
  let cur: any = err;
  for (let i = 0; cur != null && i < 10; i++) {
    if (typeof cur === 'string') {
      out.push(cur);
      break;
    }
    for (const k of ['reason', 'details', 'shortMessage', 'message']) if (typeof cur[k] === 'string' && cur[k]) out.push(cur[k]);
    cur = cur.cause ?? cur.error;
  }
  return out;
}

function fromViemReverted(e: ContractFunctionRevertedError, ctx: RevertContext | null): Decoded | null {
  if (e.raw && e.raw !== '0x') return decodeRevertData(e.raw, ctx);
  const d = e.data;
  if (d?.errorName === 'Error') {
    const r = d.args?.[0] as string | undefined;
    return r ? { kind: 'reason', reason: r, args: [] } : { kind: 'noReason', reason: null, args: [] };
  }
  if (d?.errorName === 'Panic') {
    const code = d.args?.[0] as bigint;
    return { kind: 'panic', reason: `Panic(0x${code.toString(16).padStart(2, '0')})`, args: [code] };
  }
  if (d?.errorName) return { kind: 'customError', reason: d.errorName, args: (d.args as readonly unknown[]) ?? [] };
  if (e.reason) {
    const r = e.reason.replace(/^execution reverted:?\s*/, '');
    return r ? { kind: 'reason', reason: r, args: [] } : { kind: 'noReason', reason: null, args: [] };
  }
  return null;
}

/** Decode any revert-ish error into BasisContractError. Never throws. */
export function decodeRevert(error: unknown, ctx: RevertContext | null = {}): BasisContractError {
  if (error instanceof BasisContractError) return error;
  let contract = ctx?.contract ?? null;
  let functionName = ctx?.functionName ?? null;
  try {
    let dec: Decoded | null = null;
    if (error instanceof BaseError) {
      const fnErr = error.walk((e: any) => typeof e?.functionName === 'string') as any;
      if (!functionName && fnErr?.functionName) functionName = fnErr.functionName;
      const rev = error.walk((e) => e instanceof ContractFunctionRevertedError);
      if (rev) dec = fromViemReverted(rev as ContractFunctionRevertedError, ctx);
    }
    if (!dec) {
      const hex = findHexData(error);
      if (hex) dec = decodeRevertData(hex, ctx);
    }
    if (!dec) for (const m of messages(error)) if ((dec = decodeMessage(m))) break;
    if (!dec) {
      const msg = redactUrls(messages(error)[0] ?? String(error));
      return new BasisContractError({ contract, functionName, kind: 'unknown', reason: msg, cause: error });
    }
    if (!contract && dec.contract) contract = dec.contract;
    let hint: string | null = null;
    if (dec.kind === 'noReason') hint = noReasonHint(contract, functionName);
    else if (dec.kind === 'panic') hint = panicHint(Number(dec.args[0] ?? 0));
    else if (dec.reason) hint = lookupHint(contract, functionName, dec.reason);
    return new BasisContractError({ contract, functionName, kind: dec.kind, reason: dec.reason, args: dec.args, hint, cause: error });
  } catch {
    let msg = 'unknown error';
    try {
      msg = errorText(error);
    } catch {}
    return new BasisContractError({ contract, functionName, kind: 'unknown', reason: msg, cause: error });
  }
}


const INSUFFICIENT_FUNDS_RE = /insufficient funds|exceeds transaction sender account balance|sender doesn't have enough funds|insufficient balance for transfer/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b/i;
/**
 * "Timed out" in the words of viem's HttpRequestError without a status (`noAnswerKind`). PY has no twin: it tells a
 * timeout from a broken connection by the exception's class (`_transport_kind`).
 */
const TIMEOUT_RE = /\bETIMEDOUT\b|timed? ?out|took too long to respond/i;
/**
 * A connection that failed or broke off, in the words of fetch / undici, requests / urllib3, or a node about the backend
 * behind it. One list, word for word the same as PY `_NETWORK_RE`.
 */
const NETWORK_RE = /fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network ?error|other side closed|socket (has been )?closed|connection (refused|reset|aborted|closed)|remote end closed|max retries exceeded|failed to establish a new connection/i;
/**
 * A request that ran out of time, named in an answer: the client's, or the node's own (geth "request timed out", Go's
 * "context deadline exceeded" / "i/o timeout", geth / Nitro "execution aborted (timeout = 5s)" for a call cut off at
 * its time limit). The same as PY `_TIMEOUT_TEXT_RE`.
 */
const TIMEOUT_TEXT_RE = /\bETIMEDOUT\b|took too long to respond|read timed out|request timed out|context deadline exceeded|i\/o timeout|execution aborted \(timeout/i;
/**
 * A node that could not reach what is behind it: a connection cut short ("EOF"), a transaction it failed to forward
 * ("no forwarding targets"), a proxy's upstream. The same as PY `_NODE_FAILURE_RE`.
 */
const NODE_FAILURE_RE = /\bEOF\b|forwarding|upstream/i;
/**
 * A node still building its transaction index (geth and the nodes built on it: "transaction indexing is in
 * progress"): it cannot say yet whether a hash is mined. The same as PY `_INDEXING_RE`.
 */
const INDEXING_RE = /transaction indexing is in progress/i;
/** The JSON-RPC code geth answers its own timeout with ("request timed out"). */
const RPC_TIMEOUT_CODE = -32002;
/** Node answers to a broadcast that mean "this exact transaction is (or was) already known": it was sent before. */
const SENT_BEFORE_RE = /already known|known transaction|already imported|alreadyknown|transaction already exists|already in (the )?mempool|tx already in/i;
/** Node answers to a broadcast that mean "this nonce is already used": by another transaction, unless this one got in. */
const NONCE_USED_RE = /nonce too low|nonce_too_low|nonce is too low|oldnonce|nonce has already been used|nonce expired/i;

/** Every error on the chain (`cause`, `error`), outermost first. */
function chainOf(err: unknown): any[] {
  const out: any[] = [];
  let cur: any = err;
  for (let i = 0; cur != null && typeof cur === 'object' && i < 12; i++) {
    out.push(cur);
    cur = cur.cause ?? cur.error;
  }
  return out;
}

/** True when the error carries a decodable revert (viem ContractFunctionRevertedError or revert data). */
function hasStrongRevert(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
  if (chainOf(err).some((e) => e?.name === 'ContractFunctionRevertedError')) return true;
  const hex = findHexData(err);
  return !!hex && hex !== '0x';
}

/** True for viem's own errors (BaseError, also from another copy of viem): wrappers, never the node's answer itself. */
function isViemError(e: any): boolean {
  return e instanceof BaseError || (typeof e?.walk === 'function' && typeof e?.shortMessage === 'string');
}

/**
 * True for a code a node's JSON-RPC error answer carries: 3 (execution reverted) or the JSON-RPC range -32768..-32000
 * (-32000 invalid input, -32002 the node's own timeout, -32603 internal error, ...). Not -1 (an "unknown error" a
 * client or provider made up, e.g. around an HTTP 502) nor the EIP-1193 provider codes (4001, 4100, 4200, 4900
 * disconnected, 4901 chain disconnected, ...): those come from the transport, not the node.
 */
function isAnswerCode(code: number): boolean {
  return code === 3 || (Number.isInteger(code) && code >= -32768 && code <= -32000);
}

/**
 * True for one error answer of the node: an object with a numeric `code` and a `message` string. That is the JSON-RPC
 * error object itself (viem's RpcRequestError carries it as its cause) or an Error a provider made of it (an EIP-1193
 * provider's error, Hardhat's ProviderError, a JsonRpcError; viem wraps those with the provider's error as cause). An
 * Error counts only with a JSON-RPC answer code (`isAnswerCode`: 3 or -32768..-32000): one with another code (-1,
 * 4900 / 4901 disconnected, ...) is a failure of the transport, so a broadcast that got it may still have been sent.
 * Never viem's own errors (their code is viem's: -1 for "unknown") nor a DOMException (AbortError and TimeoutError
 * carry numeric codes too).
 */
function isRpcAnswer(e: any): boolean {
  if (e == null || typeof e !== 'object' || typeof e.code !== 'number' || typeof e.message !== 'string') return false;
  if (!(e instanceof Error)) return true;
  if (isViemError(e) || e.name === 'AbortError' || e.name === 'TimeoutError') return false;
  const Dom = (globalThis as any).DOMException;
  if (typeof Dom === 'function' && e instanceof Dom) return false;
  return isAnswerCode((e as unknown as { code: number }).code);
}

/** True when the chain holds a JSON-RPC error answer (`isRpcAnswer`), not only errors the client made. */
function hasRpcErrorAnswer(chain: readonly any[]): boolean {
  return chain.some(isRpcAnswer);
}

/**
 * The node's own words on the error chain: what its answers say (the error object, a provider's error), the details
 * viem carries over from them, and the reason viem read out of an answer it took for a revert. Never viem's own lines
 * ("The contract function ... reverted with the following reason:", its call arguments): viem takes every -32603 and
 * code-3 answer for a revert, whatever the node said.
 */
function nodeTexts(err: unknown): string[] {
  const out: string[] = [];
  let cur: any = err;
  for (let i = 0; cur != null && i < 12; i++) {
    if (typeof cur === 'string') {
      out.push(cur);
      break;
    }
    if (typeof cur !== 'object') break;
    if (isViemError(cur)) {
      if (cur.name === 'ContractFunctionRevertedError' && typeof cur.reason === 'string' && cur.reason) out.push(cur.reason);
      if (typeof cur.details === 'string' && cur.details) out.push(cur.details);
    } else {
      for (const k of ['reason', 'details', 'shortMessage', 'message']) if (typeof cur[k] === 'string' && cur[k]) out.push(cur[k]);
    }
    cur = cur.cause ?? cur.error;
  }
  return out;
}

/** True when the error carries a revert: revert data, or the node's own words for one (`nodeTexts`, `decodeMessage`). */
function carriesRevert(err: unknown): boolean {
  const hex = findHexData(err);
  if (hex && hex !== '0x') return true;
  return nodeTexts(err).some((t) => decodeMessage(t) !== null);
}

/**
 * `network` / `timeout` / `server_error` when the answer names a failure on the way, not a refusal: a connection that
 * failed or broke off (`NETWORK_RE`), a timeout (JSON-RPC -32002, `TIMEOUT_TEXT_RE`: the node's own included), a node
 * that could not reach what is behind it (`NODE_FAILURE_RE`) or cannot answer yet while it builds its transaction index
 * (`INDEXING_RE`), read in the node's own words (`nodeTexts`: never viem's lines around them, which carry the RPC URL,
 * the request body and the call's arguments). Null when it names none, says insufficient funds, or carries a revert
 * (`carriesRevert`): then the answer is the node's refusal. PY: `_node_failure_kind` (web3's text carries none of
 * viem's lines).
 */
function nodeFailureKind(err: unknown, chain: readonly any[] = chainOf(err), msgs: readonly string[] = messages(err)): RpcErrorKind | null {
  const words = nodeTexts(err);
  const kind: RpcErrorKind | null = words.some((m) => NETWORK_RE.test(m)) ? 'network'
    : chain.some((e) => e?.code === RPC_TIMEOUT_CODE) || words.some((m) => TIMEOUT_TEXT_RE.test(m)) ? 'timeout'
      : words.some((m) => NODE_FAILURE_RE.test(m) || INDEXING_RE.test(m)) ? 'server_error' : null;
  if (kind === null || msgs.some((m) => INSUFFICIENT_FUNDS_RE.test(m)) || carriesRevert(err)) return null;
  return kind;
}

/**
 * True when a lookup by hash (receipt, transaction) was answered "transaction indexing is in progress" (`INDEXING_RE`):
 * the node is still building its transaction index and cannot say yet whether the hash is mined. Not found YET, never
 * "not on chain": the receipt wait polls on, and nothing is concluded from it. PY: `is_indexing_in_progress` (also
 * web3's TransactionIndexingInProgress).
 */
export function isIndexingInProgress(err: unknown): boolean {
  return messages(err).some((m) => INDEXING_RE.test(m));
}

/**
 * `timeout` / `network` when no answer came whole: a timeout, a connection that failed or closed, or an
 * `HttpRequestError` without an HTTP status (viem's wrap of a fetch failure, a body that broke off or is not JSON). Then
 * the text that rides along is not the node's answer (never "insufficient funds" or a revert read out of a body cut
 * short). Null otherwise: an HTTP status, a JSON-RPC answer, anything else. PY: `_no_answer_kind`.
 */
function noAnswerKind(chain: readonly any[], msgs: readonly string[]): 'timeout' | 'network' | null {
  if (hasRpcErrorAnswer(chain)) return null;
  for (const e of chain) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
    if (e?.name === 'HttpRequestError' && typeof e?.status !== 'number') {
      return msgs.some((m) => TIMEOUT_RE.test(m)) ? 'timeout' : 'network';
    }
    if (e?.name === 'SocketClosedError' || e?.name === 'WebSocketRequestError') return 'network';
  }
  return null;
}

/**
 * The RPC / transport failure behind `err` (`RpcErrorKind`), or null when it is something else (a revert, a bug, an
 * unknown node answer). First an answer that never came whole: `timeout`, or `network` (a connection failure, a body
 * that broke off or is not JSON), whatever text it carries. Then `insufficient_funds` from the node's message;
 * `rate_limited` for HTTP 429 / JSON-RPC -32005; `network` for another HTTP status below 500, `server_error` for HTTP
 * 5xx; then a failure on the way named in the answer (`nodeFailureKind`: a connection that failed, the node's own
 * timeout or JSON-RPC -32002, a node that could not reach its backend or forward the transaction, or that is still
 * building its transaction index), unless the answer carries a revert; last `server_error` for JSON-RPC -32603
 * (internal error).
 */
export function rpcErrorKind(err: unknown): RpcErrorKind | null {
  const chain = chainOf(err);
  const msgs = messages(err);
  const lost = noAnswerKind(chain, msgs);
  if (lost) return lost;
  if (chain.some((e) => e?.name === 'InsufficientFundsError') || msgs.some((m) => INSUFFICIENT_FUNDS_RE.test(m))) {
    return 'insufficient_funds';
  }
  for (const e of chain) {
    if (e?.name === 'HttpRequestError' || (typeof e?.status === 'number' && typeof e?.url === 'string')) {
      const s = e.status as number;
      if (s === 429) return 'rate_limited';
      if (s >= 500) return 'server_error';
      return 'network';
    }
    if (e?.name === 'LimitExceededRpcError' || e?.code === -32005) return 'rate_limited';
  }
  if (msgs.some((m) => RATE_LIMIT_RE.test(m))) return 'rate_limited';
  const failed = nodeFailureKind(err, chain, msgs);
  if (failed) return failed;
  for (const e of chain) if (e?.name === 'InternalRpcError' || e?.code === -32603) return 'server_error';
  return null;
}

/** The first HTTP status and JSON-RPC code (below 0) on the error chain: the node's answer's code before viem's own. */
function statusAndCode(err: unknown): { httpStatus: number | null; rpcCode: number | null } {
  let httpStatus: number | null = null;
  let answerCode: number | null = null;
  let anyCode: number | null = null;
  for (const e of chainOf(err)) {
    if (httpStatus === null && typeof e?.status === 'number') httpStatus = e.status;
    if (typeof e?.code === 'number' && e.code < 0) {
      if (answerCode === null && isRpcAnswer(e)) answerCode = e.code;
      if (anyCode === null) anyCode = e.code;
    }
  }
  return { httpStatus, rpcCode: answerCode ?? anyCode };
}

/**
 * True for an RPC failure worth retrying in a moment (`network`, `timeout`, `rate_limited`, `server_error`): the
 * receipt wait keeps polling through these.
 */
export function isTransientRpcError(err: unknown): boolean {
  const k = rpcErrorKind(err);
  return k === 'network' || k === 'timeout' || k === 'rate_limited' || k === 'server_error';
}

/**
 * True when a failed broadcast (`eth_sendRawTransaction`) may still have reached the node: a transport failure or
 * timeout (an answer cut short or not JSON included), an HTTP error status, a JSON-RPC answer naming a failure on the way
 * and no revert (the node's own timeout or -32002, "context deadline exceeded", "EOF", a connection refused / reset /
 * closed behind it, a failed forward, an upstream error: `nodeFailureKind`), an answer meaning this exact transaction is
 * already known (a lost first answer, then a retry), or anything that is not the node's own refusal
 * (`isNodeRefusal`: an answer that is not JSON-RPC, a failure inside the transport). The write then waits for the hash
 * it computed before sending. "Nonce too low" is not one of them (`isNonceUsed`, checked first).
 */
export function isSentUnknown(err: unknown): boolean {
  if (isTransientRpcError(err)) return true;
  if (messages(err).some((m) => SENT_BEFORE_RE.test(m))) return true;
  return !isNodeRefusal(err);
}

/**
 * True when the node refused a broadcast in its own words: a JSON-RPC error answer (an error object with a numeric
 * `code` and a `message`, also as an Error a custom / EIP-1193 transport threw: `isRpcAnswer`) or a revert (revert
 * data, a node's revert message). Only that says nothing was sent.
 */
function isNodeRefusal(err: unknown): boolean {
  if (noAnswerKind(chainOf(err), messages(err))) return false;
  if (hasRpcErrorAnswer(chainOf(err))) return true;
  return hasStrongRevert(err) || messages(err).some((m) => decodeMessage(m) !== null);
}

/**
 * True when a broadcast was answered "nonce too low" (or a node's other words for it): the signed nonce is already
 * used. The SDK sends a signed transaction once, so that is another transaction's, unless something between the SDK and
 * the node sent these bytes on and lost the answer: the write checks the chain for its own hash before it reports
 * `BasisRpcError` `nonce_used`.
 */
export function isNonceUsed(err: unknown): boolean {
  return !isTransientRpcError(err) && messages(err).some((m) => NONCE_USED_RE.test(m));
}

/**
 * `BasisRpcError` of `kind` for `err` (its HTTP status and JSON-RPC code; `detail`: the text after "nothing was sent.",
 * default what `err` says). Internal: the SDK's own errors (`classifyError`, pinned reads).
 */
export function rpcError(err: unknown, kind: RpcErrorKind, ctx: RevertContext | null, detail?: string): BasisRpcError {
  return new BasisRpcError({
    kind, contract: ctx?.contract ?? null, functionName: ctx?.functionName ?? null, ...statusAndCode(err), cause: err,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * A failure before sending (simulation, gas estimate) as an SDK error: a revert stays `BasisContractError`
 * (`decodeRevert`); an RPC / transport failure or insufficient funds becomes `BasisRpcError` (nothing was sent); an SDK
 * error is returned as is. An answer that never came whole (a timeout, a body cut short or not JSON) is always a
 * transport failure, never a revert read out of what arrived; so is a JSON-RPC answer that names a failure on the way
 * and carries no revert (`nodeFailureKind`: the node's own timeout, "EOF", an upstream error, ...), also when viem took
 * it for a revert (it does that with every -32603 / code-3 answer). Never throws.
 */
export function classifyError(err: unknown, ctx: RevertContext | null = {}): BasisContractError | BasisRpcError | BasisError {
  if (err instanceof BasisError) return err;
  try {
    const lost = noAnswerKind(chainOf(err), messages(err));
    if (lost) return rpcError(err, lost, ctx);
    if (hasStrongRevert(err)) {
      const failed = nodeFailureKind(err);
      return failed ? rpcError(err, failed, ctx, redactUrls(nodeTexts(err)[0] ?? '')) : decodeRevert(err, ctx);
    }
    const kind = rpcErrorKind(err);
    if (kind === 'insufficient_funds') return rpcError(err, kind, ctx);
    if (kind && !messages(err).some((m) => decodeMessage(m) !== null)) return rpcError(err, kind, ctx);
  } catch {  }
  return decodeRevert(err, ctx);
}

/**
 * A broadcast the node refused for good (not `isSentUnknown`: a JSON-RPC error answer or a revert): a revert (a node
 * that executes on send, e.g. Hardhat) is decoded into `BasisContractError`; anything else is `BasisRpcError`
 * (`insufficient_funds`, `nonce_used` for a "nonce too low", else `rejected`).
 */
export function sendRejection(err: unknown, ctx: RevertContext | null = {}): BasisContractError | BasisRpcError {
  if (hasStrongRevert(err) || messages(err).some((m) => decodeMessage(m) !== null)) return decodeRevert(err, ctx);
  const kind = rpcErrorKind(err) === 'insufficient_funds' ? 'insufficient_funds' : isNonceUsed(err) ? 'nonce_used' : 'rejected';
  return rpcError(err, kind, ctx);
}

/** True if the error's revert reason or custom error name equals `name`. */
export function isRevertNamed(err: unknown, name: string): boolean {
  try {
    return decodeRevert(err).reason === name;
  } catch {
    return false;
  }
}

/**
 * A quote step that failed, as 0 when the chain refused the quote (a revert, or an SDK refusal of it such as 'Zero
 * sold': it cannot be priced right now). An RPC failure is no answer: rethrown
 * as `BasisRpcError` (`classifyError`; `contract` / `functionName` name the step in it), also when the step had decoded
 * it as a revert (its cause is classified again), so a node that did not answer never reads as "Bet more", "Use fewer
 * slices" or 'quote'. Used by the Up/Down quotes and both `minBetInput` probes (Up/Down and markets). Internal: not
 * exported from the package root. PY: `zero_unless_rpc` (basis/core/revert.py).
 */
export function zeroUnlessRpc(e: unknown, contract?: RevertContext['contract'], functionName?: string): bigint {
  const err = e instanceof BasisContractError && e.cause !== undefined
    ? classifyError(e.cause, { contract: e.contract, functionName: e.functionName })
    : classifyError(e, { contract, functionName });
  if (err instanceof BasisRpcError) throw err;
  return 0n;
}
