import { encodeFunctionData, formatEther, formatGwei, keccak256, maxUint256 } from 'viem';
import type { Abi, Address, ContractEventName, ContractFunctionArgs, ContractFunctionName, Hex, TransactionReceipt } from 'viem';
import type { BasisClient } from '../BasisClient';
import { ERC20Abi } from '../abis';
import { isZeroAddress } from '../config/addresses';
import { chainBlockTimeMs } from '../config/chains';
import {
  BasisError, BasisRpcError, NotDeployedError, TxNotConfirmedError, TxReplacedError, ValidationError, WalletRequiredError,
} from './errors';
import { addMissingEventWarning, decodeEvents, type EventArgs } from './events';
import { minWithSlippage, SlippageKind, toUint, validateSlippageBps } from './units';
import { errorText } from './redact';
import { BasisContractError, classifyError, isNonceUsed, isSentUnknown, rpcErrorKind, sendRejection } from './revert';
import {
  NonceAlreadyUsed, cappedGasLimit, gasLimitFor, httpErrorAnswer, httpStatusShape, nextNonce, waitForReceipt, type NonceFloor, type Replacement,
  type SentTx,
} from './replacement';
import { pinnedBlock, retryPinnedAt } from './pinned';

/** A transaction hash, as a broadcast must answer it. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * How long a confirmed write pins the signer's next writes, ms: they are simulated and estimated (and their allowance
 * read) at that write's block or later (`retryPinnedAt`), so a load-balanced node a few blocks behind cannot answer with
 * the state before it (an allowance an exact approval granted and the write then spent, a balance, ...). Past this,
 * nodes have long caught up and the next write reads at latest. PY: `WRITE_PIN_S`.
 */
const WRITE_PIN_MS = 30_000;

/**
 * Per client, per signer (lower case): the block of its last confirmed write (any write `send` saw mined: an approval,
 * the action after it, a replacement), until when it pins (Date.now ms). Read by every later write of the signer while
 * live (one block-number read per write), raised by each confirmed one; kept off the client object like the nonce floors.
 */
const WRITE_PINS = new WeakMap<object, Map<string, { block: bigint; until: number }>>();

/** Pin `owner`'s next writes to `block` (a write of it was mined there) for WRITE_PIN_MS; never lowers a live pin. */
function notePin(client: object, owner: Address, block: bigint): void {
  let m = WRITE_PINS.get(client);
  if (!m) WRITE_PINS.set(client, (m = new Map()));
  const key = owner.toLowerCase();
  const cur = m.get(key);
  const now = Date.now();
  m.set(key, { block: cur && now <= cur.until && cur.block > block ? cur.block : block, until: now + WRITE_PIN_MS });
}

/** The block of `from`'s last confirmed write, undefined when there is none or it is older than WRITE_PIN_MS. */
function pinOf(client: object, from: Address): bigint | undefined {
  const m = WRITE_PINS.get(client);
  const p = m?.get(from.toLowerCase());
  if (!p) return undefined;
  if (Date.now() <= p.until) return p.block;
  m!.delete(from.toLowerCase());
  return undefined;
}

/**
 * The fee fields of a local-key write: viem's `estimateFeesPerGas` (maxFeePerGas = baseFee x 1.2, rounded down, + the
 * node's `eth_maxPriorityFeePerGas`; on a chain without a base fee, gasPrice = `eth_gasPrice` x 1.2). Set explicitly so
 * viem never takes the node's own fill (`eth_fillTransaction`) instead: PY `estimate_fees_per_gas` sends the same caps.
 */
async function feesPerGas(pc: { estimateFeesPerGas(a?: { type?: 'legacy' }): Promise<unknown> }): Promise<Record<string, bigint>> {
  try {
    const f = (await pc.estimateFeesPerGas()) as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  } catch (e) {
    if ((e as Error)?.name !== 'Eip1559FeesNotSupportedError') throw e;
    return { gasPrice: ((await pc.estimateFeesPerGas({ type: 'legacy' })) as { gasPrice: bigint }).gasPrice };
  }
}

/**
 * Per client, per local-key sender (lower case): the nonce after the last transaction the client saw mined. Kept here,
 * off the client object, and dropped with the client.
 */
const NONCE_FLOORS = new WeakMap<object, Map<string, NonceFloor>>();

function floorsOf(client: object): Map<string, NonceFloor> {
  let m = NONCE_FLOORS.get(client);
  if (!m) NONCE_FLOORS.set(client, (m = new Map()));
  return m;
}

/** Raise the floor of `from` to `nonce + 1` (the transaction `hash` used `nonce`); never lowers it. */
function noteMined(client: object, from: Address, nonce: number | undefined, hash: Hex | null | undefined): void {
  if (nonce === undefined || !hash) return;
  const m = floorsOf(client);
  const key = from.toLowerCase();
  const cur = m.get(key);
  if (!cur || cur.nonce <= nonce) m.set(key, { nonce: nonce + 1, hash });
}

/** Result of every SDK write: the confirmed transaction. */
export interface TxResult<T = unknown> {
  /** The mined transaction (after a wallet speed-up, the replacement that was mined: see `replacedHash`). */
  hash: Hex;
  /**
   * Set only when an injected wallet sped the transaction up (same call, higher fee: viem's 'repriced'): the hash the
   * SDK sent first, which will never be mined. `hash`, `receipt` and the events are the mined replacement's. Never set
   * with a local key (privateKey): it has no wallet that could speed a transaction up.
   */
  replacedHash?: Hex;
  receipt: TransactionReceipt;
  /** The function's return value as simulated just before sending (when it has one). */
  result?: T;
  /**
   * Things the caller should know about this confirmed write, e.g. an expected event missing from the logs (the
   * figure it carries is then null). Empty when all went as expected. The tx is confirmed either way: never resend it.
   */
  warnings: string[];
}

type WriteFn<A extends Abi> = ContractFunctionName<A, 'nonpayable' | 'payable'>;

export interface WriteRequest<A extends Abi, F extends WriteFn<A>> {
  address: Address;
  abi: A;
  functionName: F;
  args: ContractFunctionArgs<A, 'nonpayable' | 'payable', F>;
  value?: bigint;
  /** SDK ABI name (e.g. "Swap"), used to explain reverts. */
  contract: string;
}

/**
 * Shared plumbing for every contract module: deployed-address guard, the write pipeline
 * (simulate → send → receipt → sync) and ERC-20 approvals.
 */
export abstract class BaseModule {
  protected readonly client: BasisClient;

  constructor(client: BasisClient) {
    this.client = client;
  }

  protected get publicClient() {
    return this.client.publicClient;
  }

  /** Throws `NotDeployedError` (no RPC call) when `address` is zero. */
  protected require(address: Address | undefined, contract: string): Address {
    if (isZeroAddress(address)) throw new NotDeployedError(contract, this.client.chainId);
    return address as Address;
  }

  /** The signer's address. Throws when the client has no wallet. */
  protected get account(): Address {
    const acc = this.client.walletClient?.account;
    if (!acc) throw new WalletRequiredError();
    return acc.address;
  }

  /**
   * Every on-chain write goes through here:
   * 1. simulate, then estimate the gas (a revert at either step is decoded into `BasisContractError`; an RPC / transport
   *    failure or insufficient funds is `BasisRpcError`; nothing is sent). Within 30 s of a confirmed write of the same
   *    signer (an approval, the action after it, any write this client saw mined), both run at that write's block, or
   *    the RPC's latest when later (one block-number read; on a chain with a block time the RPC's latest is waited for a
   *    moment while it is below that block, and a node that does not know the block yet is retried there; one still
   *    behind after that is `BasisRpcError` `server_error`, "the RPC node is behind block N"), never at an older one: a
   *    lagging node would still see the state before that write (an allowance it spent, a balance). On a chain without
   *    a block time (a local node) a pin above the node's head (a reverted snapshot) is not used. The gas limit sent is
   *    the estimate x 120%, at most 32,000,000 (the chain's limit for one transaction); an estimate above that is
   *    `ValidationError('gas')` (too big for one transaction).
   * 2. sign and send: with a local account (privateKey) the transaction is signed first and its hash known BEFORE the
   *    broadcast, so a broadcast whose answer is lost or unclear (timeout, network error, an answer cut short or not
   *    JSON, HTTP 4xx / 5xx / 429, "already known", no hash in the answer, a JSON-RPC answer naming the node's own
   *    timeout or a failure behind it with no revert: -32002, "context deadline exceeded", "i/o timeout", "EOF", a
   *    connection refused / reset / closed, a failed forward, an upstream error; anything but the node's own refusal)
   *    is taken as sent and waited for, never a plain error, and while the node does not know it and its nonce is free
   *    the same signed bytes are sent again a few times (same hash: never a second write); only a refusal in the node's words
   *    (a JSON-RPC error answer, also one a custom / EIP-1193 transport throws as an Error with a JSON-RPC answer `code`:
   *    3 or -32768..-32000; an Error with another code, such as -1 or 4900 / 4901 disconnected, is the transport's; also
   *    a JSON-RPC error answer in the body of an HTTP 4xx other than 408 / 429: `httpErrorAnswer`) throws
   *    `BasisRpcError` (`rejected` / `insufficient_funds`; nothing was sent) or, for a
   *    node that executes on send, the decoded `BasisContractError`. "Nonce too low" means another transaction took the
   *    nonce: once the chain shows that transaction (another hash mined with the nonce, or the nonce used before this
   *    write was signed), `BasisRpcError` `nonce_used` (nothing ran; sending the write again is fine); until then it is
   *    waited for like any sent write (a node that does not know this hash proves nothing), up to the receipt timeout. The
   *    nonce is the RPC's pending count, but never below the one after the client's last mined transaction while that
   *    transaction is on chain (a node a block or two behind would hand out a used nonce).
   *    With an injected walletClient (EIP-1193 / JSON-RPC account) the wallet signs and
   *    broadcasts, and the hash is unknown until it answers: an error from the wallet is passed through as it came
   *    (if the wallet broadcast before failing, the SDK cannot know the hash; check the wallet before retrying).
   *    Both paths sign for the SDK's chain; an injected wallet on another network throws viem's ChainMismatchError
   *    before signing.
   * 3. wait for the receipt (`client.receiptTimeoutMs`; RPC blips are polled through), 4. await the backend sync
   *    (non-fatal).
   * A receipt wait that fails after sending throws `TxNotConfirmedError` (carries `txHash`) with the hash's sync queued
   * (with the sender, nonce and block, for the flush's chain check).
   * A status-0 receipt throws `BasisError` (nothing happened on chain apart from the gas).
   * A transaction replaced in the wallet before it was mined (same sender and nonce): a speed-up of the same call
   * ('repriced') returns the mined replacement (`hash`, `receipt`, events; the sent hash in `replacedHash`, a warning
   * added) and syncs it; a cancel or a different call ('cancelled' / 'replaced') throws `TxReplacedError` without
   * syncing the dead hash (a successful 'replaced' replacement is synced, a cancel is not). The replacement is found by
   * the sender's nonce in the blocks since the send, so this also works when the RPC never saw the original. A local
   * key has no wallet that could speed it up: the same call mined under another hash with its nonce is another write,
   * and throws `BasisRpcError` `nonce_used`, as does a nonce used before the send.
   */
  /**
   * After a passed simulation and a bare revert of the gas estimate: `BasisRpcError` `insufficient_funds` when the signer
   * cannot hold what the send needs up front (gas limit x max fee + value), else null. The node estimates with the
   * account's fees and stops at what its balance can pay, so a wallet low on ETH looks like a revert there. The gas is
   * estimated again without fees (no such cap) to get the numbers. Never throws.
   */
  private async gasShortfall(call: object, from: Address, value: bigint, ctx: { contract: any; functionName: string }, cause: unknown): Promise<BasisRpcError | null> {
    try {
      const [gas, fees, balance] = await Promise.all([
        this.publicClient.estimateContractGas({ ...(call as any), account: from }),
        this.publicClient.estimateFeesPerGas(),
        this.publicClient.getBalance({ address: from }),
      ]);
      const perGas = (fees as { maxFeePerGas?: bigint }).maxFeePerGas ?? (fees as { gasPrice?: bigint }).gasPrice ?? 0n;
      const gasLimit = cappedGasLimit(gas);
      const need = gasLimit * perGas + value;
      if (perGas === 0n || balance >= need) return null;
      const detail = `The wallet holds ${formatEther(balance)} ETH and this call needs about ${formatEther(need)} ETH up front `
        + `(gas limit ${gasLimit} at up to ${formatGwei(perGas)} gwei${value ? ', plus the value' : ''}), though it spends less. `
        + 'The simulation passed: send the wallet more ETH, then try again.';
      return new BasisRpcError({ kind: 'insufficient_funds', contract: ctx.contract ?? null, functionName: ctx.functionName, cause, detail });
    } catch {
      return null;
    }
  }

  /**
   * The block `from`'s reads go at now, or undefined (at latest) when no write of it was confirmed in the last
   * WRITE_PIN_MS: that write's block, or the RPC's latest when later (a pinned read never names older state than it
   * must: a node keeps only recent state). One block-number read; `pinnedBlock` decides when the RPC is below the pin
   * (a chain with a block time, `chainBlockTimeMs`: every chain but a local node's, waits a moment for it, up to
   * `PIN_WAIT_MS`; a local node's pin above its head is dropped). Never throws (a failed read gives the pin).
   */
  private async pinFor(from: Address): Promise<bigint | undefined> {
    const pin = pinOf(this.client, from);
    if (pin === undefined) return undefined;
    const blockTime = chainBlockTimeMs(this.client.chainConfig);
    return (await pinnedBlock(() => this.publicClient.getBlockNumber({ cacheTime: 0 }), pin, blockTime)) ?? undefined;
  }

  protected async send<const A extends Abi, F extends WriteFn<A>>(req: WriteRequest<A, F>): Promise<TxResult> {
    const wallet = this.client.walletClient;
    if (!wallet?.account) throw new WalletRequiredError();
    const { contract, ...unpinned } = req;
    const fn = req.functionName as string;
    const ctx = { contract: contract as any, functionName: fn, abi: req.abi };
    const from = wallet.account.address;
    const pin = await this.pinFor(from);
    const call = pin === undefined ? unpinned : { ...unpinned, blockNumber: pin };
    const read = <T>(f: () => Promise<T>): Promise<T> => (pin === undefined ? f() : retryPinnedAt(f, pin, ctx));

    let request: any;
    let result: unknown;
    let gas: bigint;
    try {
      const sim = await read(() => this.publicClient.simulateContract({ ...(call as any), account: wallet.account }));
      const { blockNumber: _pinned, ...rest } = sim.request as any;
      request = rest;
      result = sim.result;
    } catch (e) {
      throw classifyError(e, ctx);
    }
    try {
      gas = await read(() => this.publicClient.estimateContractGas({ ...(call as any), account: wallet.account }));
    } catch (e) {
      const err = classifyError(e, ctx);
      if (err instanceof BasisContractError && err.kind === 'noReason') {
        throw (await this.gasShortfall(call, from, req.value ?? 0n, ctx, e)) ?? err;
      }
      throw err;
    }
    const gasLimit = gasLimitFor(gas);
    const data = encodeFunctionData({ abi: req.abi as Abi, functionName: fn, args: req.args as readonly unknown[] });
    const original: SentTx = { to: req.address, value: req.value ?? 0n, data };

    const chain = this.client.chainConfig.chain;
    let startBlock: bigint;
    let sent: Hex;
    let sendError: unknown;
    const local = wallet.account.type === 'local';
    let nonceUsedOnSend = false;
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (wallet.account.type === 'local') {
      const account = wallet.account;
      let serialized: Hex;
      try {
        startBlock = await this.publicClient.getBlockNumber({ cacheTime: 0 });
        const nonce = await nextNonce(this.publicClient, from, floorsOf(this.client).get(from.toLowerCase()), chainBlockTimeMs(this.client.chainConfig));
        const fees = await feesPerGas(this.publicClient as unknown as Parameters<typeof feesPerGas>[0]);
        const prepared = await wallet.prepareTransactionRequest({
          account, chain, chainId: chain.id, to: req.address, data, value: req.value, gas: gasLimit, nonce, ...fees,
        } as any);
        original.nonce = prepared.nonce;
        serialized = await account.signTransaction(prepared as any, { serializer: chain.serializers?.transaction } as any);
      } catch (e) {
        throw rpcErrorKind(e) ? classifyError(e, ctx) : e;
      }
      sent = keccak256(serialized);
      const broadcast = () => wallet.sendRawTransaction({ serializedTransaction: serialized });
      try {
        const got: unknown = await broadcast();
        if (typeof got !== 'string' || !TX_HASH_RE.test(got)) {
          throw new Error(`the node's answer carries no transaction hash (${typeof got === 'string' ? 'not a 32-byte hash' : got === null ? 'null' : typeof got})`);
        }
        if (got.toLowerCase() !== sent.toLowerCase()) console.warn(`[basis-sdk] the node answered hash ${got} for the broadcast of ${sent}`);
      } catch (thrown) {
        const shaped = httpStatusShape(thrown);
        const e: unknown = httpErrorAnswer(shaped) ?? shaped;
        if (isNonceUsed(e)) {
          nonceUsedOnSend = true;
          sendError = e;
        } else if (!isSentUnknown(e)) {
          throw sendRejection(e, ctx);
        } else {
          sendError = e;
          rebroadcast = broadcast;
          console.warn(`[basis-sdk] the broadcast of ${sent} got no clear answer (${errorText(e)}); waiting for that hash`);
        }
      }
    } else {
      try {
        startBlock = await this.publicClient.getBlockNumber({ cacheTime: 0 });
      } catch (e) {
        throw classifyError(e, ctx);
      }
      sent = await this.client._writeContract({ ...request, gas: gasLimit });
    }

    let receipt: TransactionReceipt;
    let replacement: Replacement | undefined;
    try {
      ({ receipt, replacement } = await waitForReceipt(this.publicClient, {
        hash: sent, from, original, startBlock, timeoutMs: this.client.receiptTimeoutMs, local, nonceUsedOnSend, rebroadcast,
      }));
    } catch (e) {
      if (e instanceof NonceAlreadyUsed) {
        noteMined(this.client, from, e.nonce, e.receipt ? e.hash : null);
        const takenAt: unknown = e.receipt?.blockNumber;
        if (typeof takenAt === 'bigint') notePin(this.client, from, takenAt);
        throw new BasisRpcError({
          kind: 'nonce_used', contract, functionName: fn, cause: sendError === undefined ? e : Object.assign(e, { cause: sendError }),
        });
      }
      const err = new TxNotConfirmedError(sent, contract, fn, e);
      const lost = sendError !== undefined ? ` (the broadcast's answer was lost: ${errorText(sendError)})` : '';
      await this.client.queueSync(sent, `receipt not read after sending${lost}: ${errorText(e)}`, {
        from, to: req.address, nonce: original.nonce, block: Number(startBlock),
      });
      throw err;
    }
    if (local) noteMined(this.client, from, original.nonce, receipt.transactionHash);
    const minedAt: unknown = receipt.blockNumber;
    if (typeof minedAt === 'bigint') notePin(this.client, from, minedAt);
    const warnings: string[] = [];
    let hash: Hex = sent;
    let replacedHash: Hex | undefined;
    if (replacement && replacement.transaction.hash.toLowerCase() !== sent.toLowerCase()) {
      const mined = replacement.transaction.hash;
      if (replacement.reason !== 'repriced') {
        const replacementSync = replacement.reason === 'replaced' && receipt.status === 'success'
          ? await this.client.syncTx(mined, { from, to: replacement.transaction.to ?? undefined }) : null;
        throw new TxReplacedError({
          originalHash: sent, replacementHash: mined, reason: replacement.reason, contract, functionName: fn,
          replacementReceipt: receipt, replacementSync,
        });
      }
      hash = mined;
      replacedHash = sent;
      warnings.push(
        `${contract}.${fn} was sped up in the wallet: ${sent} was replaced by ${mined} (same call, higher fee); ` +
        '`hash` is the mined one.',
      );
    }
    if (receipt.status !== 'success') {
      throw new BasisError(`[basis-sdk] ${contract}.${fn} reverted on chain (tx ${hash}).`);
    }
    await this.client.syncTx(hash, { from, to: req.address });
    return replacedHash ? { hash, replacedHash, receipt, result, warnings } : { hash, receipt, result, warnings };
  }

  /**
   * The decoded args of every `eventName` log of `tx` emitted by `address` (one or several), in log order
   * (`decodeEvents`). Empty when there is none.
   */
  protected events<const A extends Abi, N extends ContractEventName<A>>(
    tx: { receipt: TransactionReceipt }, abi: A, eventName: N, address: Address | readonly Address[],
  ): EventArgs<A, N>[] {
    return decodeEvents(tx.receipt, abi, eventName, address);
  }

  /**
   * The first `eventName` log of `tx` emitted by `address`, decoded; or null with a warning added to `tx.warnings`
   * naming `fields` (the result fields left null). Never throws: the tx is confirmed.
   */
  protected expectEvent<const A extends Abi, N extends ContractEventName<A>>(
    tx: TxResult, abi: A, eventName: N, address: Address | readonly Address[], contract: string, fields: readonly string[] = [],
  ): EventArgs<A, N> | null {
    const found = decodeEvents(tx.receipt, abi, eventName, address);
    if (found.length) return found[0];
    addMissingEventWarning(tx, contract, eventName as string, fields);
    return null;
  }

  /**
   * The minimum to send: an explicit one (a whole number of raw units, `toUint` under `field`; never 0), else the quote
   * minus the slippage (`slippageBps`, else the client default for `kind`). Null means "not given" for both, as
   * undefined (PY None). An RPC / transport failure of the quote is `BasisRpcError` (nothing was sent); a quote that
   * reverts throws as it came.
   */
  protected async resolveMin(
    explicit: bigint | number | null | undefined,
    slippageBps: number | bigint | null | undefined,
    quote: () => Promise<bigint>,
    kind: SlippageKind = 'trade',
    field = 'minOut',
  ): Promise<bigint> {
    if (slippageBps != null) validateSlippageBps(slippageBps);
    if (explicit != null) {
      const min = toUint(explicit, field);
      if (min === 0n) throw new ValidationError(field, `A zero ${field} is never sent; omit it to derive it from a quote.`);
      return min;
    }
    const q = await this.preSendRead(quote);
    const min = minWithSlippage(q, slippageBps ?? this.client.slippageBps[kind]);
    if (min === 0n) throw new ValidationError(field, `The quote (${q}) rounds to a zero ${field}: the amount is too small.`);
    return min;
  }

  /** Latest block timestamp + `seconds` (chain time, so a local node's time travel does not break deadlines). */
  protected async blockDeadline(seconds = 1200): Promise<bigint> {
    return (await this.preSendRead(() => this.publicClient.getBlock())).timestamp + BigInt(seconds);
  }

  /**
   * Runs a read made before a write is sent (a quote, the deadline's block): an RPC / transport failure becomes
   * `BasisRpcError` (nothing was sent, so you can retry), anything else is rethrown as it came.
   */
  protected async preSendRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (e) {
      throw rpcErrorKind(e) ? classifyError(e) : e;
    }
  }

  /**
   * Approve `spender` for `amount` of `token` when the allowance is short; nothing is sent when it already covers it.
   * Trades approve the traded token once, unlimited (`maxUint256`), so later trades of it need no approval; every other
   * action approves the exact amount it needs. Within 30 s of a confirmed write of the signer the allowance is read at
   * that write's block or later (as `send` reads): a node behind it would still show an exact approval the last write
   * spent, and the approval would be skipped. After a confirmed approval, the signer's next write (the action) is
   * simulated and estimated at the approval's block or later (`send`).
   */
  protected async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<TxResult | null> {
    if (amount === 0n) return null;
    const owner = this.account;
    const pin = await this.pinFor(owner);
    const args = { address: token, abi: ERC20Abi, functionName: 'allowance', args: [owner, spender] } as const;
    const allowance = await this.preSendRead(() => (pin === undefined
      ? this.publicClient.readContract(args)
      : retryPinnedAt(() => this.publicClient.readContract({ ...args, blockNumber: pin }), pin, { contract: 'ERC20', functionName: 'allowance' })));
    if (allowance >= amount) return null;
    const swap = this.client.addresses?.swap;
    const unlimited = !isZeroAddress(swap) && spender.toLowerCase() === (swap as string).toLowerCase();
    const tx = await this.send({ address: token, abi: ERC20Abi, functionName: 'approve', args: [spender, unlimited ? maxUint256 : amount], contract: 'ERC20' });
    const block = (tx as Partial<TxResult> | null)?.receipt?.blockNumber;
    if (typeof block === 'bigint') notePin(this.client, owner, block);
    return tx;
  }

  /** ERC-20 balance of `owner` (defaults to the signer). */
  protected async balanceOf(token: Address, owner?: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token, abi: ERC20Abi, functionName: 'balanceOf', args: [owner ?? this.account],
    });
  }
}
