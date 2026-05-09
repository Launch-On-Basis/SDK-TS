import { BasisClient } from '../BasisClient';
import AUpDownArtifact from '../abis/AUpDown.json';
import AggregatorV3Artifact from '../abis/AggregatorV3Interface.json';
import IERC20Artifact from '../abis/IERC20.json';
import { Address } from 'viem';

/**
 * Thrown by `settleCurrentRound` when the contract reverts because Chainlink
 * has not yet published a price update past `round.endTime`. This is a
 * transient condition — wait for the oracle to tick and retry, or use
 * `advanceRound(tf)` which polls the oracle automatically.
 *
 * The two on-chain reverts that map to this error:
 *  - `NoUpdateAfterEndTime` — `latestRoundData().updatedAt < round.endTime`
 *  - `NoValidPriceInWindow` — no Chainlink round in the lookback window had
 *    `updatedAt >= round.endTime`
 */
/**
 * Options for `betBull` / `betBear`. Backward-compatible: callers passing a
 * raw `bigint` as the third argument get the legacy `minShares` shorthand.
 */
export interface BetOptions {
  /** Slippage protection — throws if `quoteShares < minShares`. Default `0n` (no check). */
  minShares?: bigint;
  /**
   * If true (default), auto-settle/cancel a stale-pending round before
   * submitting the bet. Catches the common case where a bot tries to bet on
   * a round that ended but nobody settled — without auto-advance the contract
   * rejects with `BettingClosed`.
   *
   * Errors during the inner `advanceRound` call are silently swallowed —
   * the bet's own pre-checks / contract reverts surface anything that matters.
   */
  autoAdvance?: boolean;
  /**
   * Delay after a successful auto-advance before submitting the bet, in ms.
   * Lets RPC replication catch up so the next read reflects the new round.
   * Default `500`. Set to `0` for instant follow-up (own RPC, no LB).
   */
  autoAdvanceDelayMs?: number;
  /**
   * Cap on how long the inner `advanceRound` polls the Chainlink price feed
   * before giving up. Lower than `advanceRound`'s own default 6min because
   * we silently swallow the failure here — don't want to hang bots that
   * are doing nothing but `betBull` calls. Default `30000` (30s).
   */
  autoAdvanceMaxWaitMs?: number;
}

function normalizeBetOptions(opts: bigint | BetOptions): Required<BetOptions> {
  if (typeof opts === 'bigint') {
    return { minShares: opts, autoAdvance: true, autoAdvanceDelayMs: 500, autoAdvanceMaxWaitMs: 30_000 };
  }
  return {
    minShares: opts.minShares ?? 0n,
    autoAdvance: opts.autoAdvance ?? true,
    autoAdvanceDelayMs: opts.autoAdvanceDelayMs ?? 500,
    autoAdvanceMaxWaitMs: opts.autoAdvanceMaxWaitMs ?? 30_000,
  };
}

export class OracleNotReadyError extends Error {
  readonly tf: number;
  readonly endTime: bigint;
  readonly contractError: 'NoUpdateAfterEndTime' | 'NoValidPriceInWindow';
  constructor(message: string, tf: number, endTime: bigint, contractError: 'NoUpdateAfterEndTime' | 'NoValidPriceInWindow') {
    super(message);
    this.name = 'OracleNotReadyError';
    this.tf = tf;
    this.endTime = endTime;
    this.contractError = contractError;
  }
}

// ============================================================
// Enums / constants
// ============================================================

/** Timeframe enum: 0=5m, 1=15m, 2=1h, 3=4h, 4=24h. */
export const Timeframe = {
  FIVE_MIN: 0,
  FIFTEEN_MIN: 1,
  ONE_HOUR: 2,
  FOUR_HOUR: 3,
  ONE_DAY: 4,
} as const;
export type Timeframe = typeof Timeframe[keyof typeof Timeframe];

/** Side enum: 0=None, 1=Bull, 2=Bear. Bets always pass 1 or 2. */
export const Side = { NONE: 0, BULL: 1, BEAR: 2 } as const;
export type Side = typeof Side[keyof typeof Side];

/** Outcome enum: 0=Pending, 1=BullWins, 2=BearWins, 3=Canceled. */
export const Outcome = { PENDING: 0, BULL_WINS: 1, BEAR_WINS: 2, CANCELED: 3 } as const;
export type Outcome = typeof Outcome[keyof typeof Outcome];

export type UpDownAsset = 'btc' | 'eth' | 'bnb' | 'cake' | 'doge';

/** All asset keys the SDK knows about. Hardcoded — adding a new asset is a
 *  deliberate SDK release, even if the contract appears in `contracts.json`. */
const KNOWN_UPDOWN_ASSETS: readonly UpDownAsset[] = ['btc', 'eth', 'bnb', 'cake', 'doge'];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ============================================================
// Struct types
// ============================================================

/** On-chain Round struct returned by getRound(tf, roundId). */
export interface UpDownRound {
  startTime: bigint;          // unix seconds
  endTime: bigint;            // unix seconds
  settledAt: bigint;          // unix seconds (0 if unsettled)
  startPrice: bigint;         // Chainlink 8-dec
  endPrice: bigint;           // Chainlink 8-dec (0 if unsettled)
  endPriceRoundId: bigint;    // Chainlink round id at settle
  virtBull: bigint;           // virtual reserve, USDB 18-dec
  virtBear: bigint;           // virtual reserve, USDB 18-dec
  bullPool: bigint;           // total bull stake, USDB 18-dec
  bearPool: bigint;           // total bear stake, USDB 18-dec
  sharesBull: bigint;         // total shares, 18-dec
  sharesBear: bigint;         // total shares, 18-dec
  seedBonus: bigint;          // carryover seed, USDB 18-dec
  outcome: number;            // Outcome enum
}

/** On-chain UserBet struct returned by getUserBet(tf, roundId, user). */
export interface UpDownUserBet {
  side: number;               // Side enum
  amount: bigint;             // total stake on this round, USDB 18-dec
  shares: bigint;             // total shares on this round, 18-dec
  claimed: boolean;
}

// ============================================================
// Per-asset module — one instance per deployed asset (see KNOWN_UPDOWN_ASSETS)
// ============================================================

export class UpDownAssetModule {
  private client: BasisClient;
  public readonly address: Address;
  public readonly asset: UpDownAsset;

  constructor(client: BasisClient, address: Address, asset: UpDownAsset) {
    this.client = client;
    this.address = address;
    this.asset = asset;
  }

  // --- Internals ---

  private async _syncTx(txHash: string) {
    await this.client.api.syncTransaction(txHash);
  }

  private async _approveUsdbIfNeeded(amount: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Wallet account is required for approval.');
    }
    const account = this.client.walletClient.account;
    const allowance = await this.client.publicClient.readContract({
      address: this.client.usdbAddress,
      abi: IERC20Artifact.abi,
      functionName: 'allowance',
      args: [account.address, this.address],
    }) as bigint;
    if (allowance < amount) {
      const { request } = await this.client.publicClient.simulateContract({
        account,
        address: this.client.usdbAddress,
        abi: IERC20Artifact.abi,
        functionName: 'approve',
        args: [this.address, amount],
      });
      const hash = await this.client.writeContract(request);
      await this.client.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  // --- Reads ---

  /** Current/active round id for a timeframe. 0 means no rounds opened yet. */
  async currentRoundId(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'currentRoundId', args: [tf],
    }) as Promise<bigint>;
  }

  /** Full Round struct for a specific round. */
  async getRound(tf: number, roundId: bigint): Promise<UpDownRound> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'getRound', args: [tf, roundId],
    }) as Promise<UpDownRound>;
  }

  /**
   * Convenience: fetches both currentRoundId and the full Round in two reads.
   * Returns null if no rounds have opened yet for the timeframe.
   */
  async getCurrentRound(tf: number): Promise<{ roundId: bigint; round: UpDownRound } | null> {
    const roundId = await this.currentRoundId(tf);
    if (roundId === 0n) return null;
    const round = await this.getRound(tf, roundId);
    return { roundId, round };
  }

  /** A user's bet on a specific round. amount=0 means no bet placed. */
  async getUserBet(tf: number, roundId: bigint, user: Address): Promise<UpDownUserBet> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'getUserBet', args: [tf, roundId, user],
    }) as Promise<UpDownUserBet>;
  }

  /**
   * Preview the shares a hypothetical bet would mint right now on the current
   * round. Includes slippage. Returns 0 if no active round, amount=0, or side=None.
   */
  async quoteShares(tf: number, side: Side, amount: bigint): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'quoteShares', args: [tf, side, amount],
    }) as Promise<bigint>;
  }

  /** Projected payout if the current round were settled with current pool sizes. */
  async quoteCurrentPayout(tf: number, user: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'quoteCurrentPayout', args: [tf, user],
    }) as Promise<bigint>;
  }

  /**
   * The exact USDB amount the user can claim right now from a settled round.
   * Returns 0 in every "nothing to claim" case (lost, already claimed, pending,
   * no bet). Use this to gate the Claim button: show iff `> 0`.
   */
  async quoteClaimPayout(tf: number, roundId: bigint, user: Address): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'quoteClaimPayout', args: [tf, roundId, user],
    }) as Promise<bigint>;
  }

  /** Implied bull-side probability scaled by USD_UNIT (1e18). Divide by 1e18 for fraction. */
  async currentBullProbability(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'currentBullProbability', args: [tf],
    }) as Promise<bigint>;
  }

  /** Current slippage threshold in BPS. Decays from 9500 (95%) at start to 5500 (55%) at end. */
  async currentSlippageThreshold(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'currentSlippageThreshold', args: [tf],
    }) as Promise<bigint>;
  }

  /** Round duration for a timeframe, in seconds. */
  async tfDuration(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'tfDuration', args: [tf],
    }) as Promise<bigint>;
  }

  /** Minimum bet size, USDB 18-dec. */
  async minBet(): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'minBet',
    }) as Promise<bigint>;
  }

  /** Carryover queued from panicCancel, waiting for the next round to seed. */
  async pendingCarryover(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'pendingCarryover', args: [tf],
    }) as Promise<bigint>;
  }

  /** Current virtual base reserve for a timeframe, USDB 18-dec. */
  async protocolVirtBase(tf: number): Promise<bigint> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'protocolVirtBase', args: [tf],
    }) as Promise<bigint>;
  }

  /** Chainlink AggregatorV3 address used by this contract. */
  async priceFeed(): Promise<Address> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'priceFeed',
    }) as Promise<Address>;
  }

  /** USDB token address — should match client.usdbAddress for live deployments. */
  async usdb(): Promise<Address> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'usdb',
    }) as Promise<Address>;
  }

  /** Configured swap contract address. */
  async swap(): Promise<Address> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'swap',
    }) as Promise<Address>;
  }

  /** Configured wash-trade detection token. */
  async washToken(): Promise<Address> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'washToken',
    }) as Promise<Address>;
  }

  /** True if the contract is paused — bet/settle/claim writes will revert. */
  async paused(): Promise<boolean> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'paused',
    }) as Promise<boolean>;
  }

  /** Admin address — only this address can call admin write functions. */
  async CEO(): Promise<Address> {
    return this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'CEO',
    }) as Promise<Address>;
  }

  // --- Writes (user) ---

  /**
   * Place a bullish bet on the current round of `tf`. Auto-approves USDB.
   *
   * **Default behavior auto-advances stale-pending rounds.** If the current
   * round is past `endTime` but nobody has settled it yet, the contract
   * would reject the bet with `BettingClosed`. By default, the SDK detects
   * this and calls `advanceRound` first, then bets on the freshly-opened
   * next round. Set `autoAdvance: false` to opt out.
   *
   * Pre-checks: `amount >= minBet`, `usdb.balanceOf(user) >= amount`, and
   * `quoteShares > 0` (catches `ZeroShares` from slippage crush).
   *
   * @param tf - Timeframe enum (0=5m, 1=15m, 2=1h, 3=4h, 4=24h)
   * @param amount - Stake in USDB 18-dec wei
   * @param opts - Either a bigint (legacy `minShares` shorthand) or a
   *   `BetOptions` object. Both forms are supported for backward compatibility.
   *
   * @example
   * // Simplest call — auto-advances any stale round, no slippage protection
   * await client.updown.btc.betBull(0, parseUnits('1', 18));
   *
   * @example
   * // Legacy minShares positional — still works
   * await client.updown.btc.betBull(0, parseUnits('1', 18), parseUnits('1.95', 18));
   *
   * @example
   * // Full opts — opt out of auto-advance, with slippage and longer RPC settle
   * await client.updown.btc.betBull(0, parseUnits('1', 18), {
   *   minShares: parseUnits('1.95', 18),
   *   autoAdvance: false,
   * });
   */
  async betBull(tf: number, amount: bigint, opts: bigint | BetOptions = 0n) {
    return this._bet(tf, Side.BULL, amount, normalizeBetOptions(opts), 'betBull');
  }

  /**
   * Place a bearish bet on the current round of `tf`. Auto-approves USDB.
   * See `betBull` for the full options (auto-advance, slippage protection, etc.).
   */
  async betBear(tf: number, amount: bigint, opts: bigint | BetOptions = 0n) {
    return this._bet(tf, Side.BEAR, amount, normalizeBetOptions(opts), 'betBear');
  }

  private async _bet(tf: number, side: Side, amount: bigint, opts: Required<BetOptions>, fnName: 'betBull' | 'betBear') {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    const user = this.client.walletClient.account.address;

    // Auto-advance: if the current round is stale-pending (past endTime but not
    // settled), try to settle/cancel it before betting. The inner advanceRound
    // does its own _syncTx — that sync MUST run if the tx hits chain.
    //
    // We only swallow EXPECTED race conditions (someone else advanced first,
    // round transitioned mid-flight, oracle stalled). Real failures — sync
    // errors, wallet config, RPC outages — propagate so the caller sees them
    // and the always-sync invariant isn't silently violated.
    if (opts.autoAdvance) {
      try {
        const cur = await this.getCurrentRound(tf);
        if (cur && cur.round.outcome === 0 /* Pending */) {
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (now > cur.round.endTime) {
            await this.advanceRound(tf, { maxWaitMs: opts.autoAdvanceMaxWaitMs });
            if (opts.autoAdvanceDelayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.autoAdvanceDelayMs));
            }
          }
        }
      } catch (e: any) {
        const errName = e?.cause?.data?.errorName ?? '';
        const msg = e?.message ?? '';
        const isExpectedRace =
          // Settle attempt revert from a stale oracle (typed via settleCurrentRound)
          e instanceof OracleNotReadyError ||
          // Inner advanceRound's _waitForOracle gave up after autoAdvanceMaxWaitMs
          /Chainlink price feed .* has not updated/.test(msg) ||
          // Contract reverts that mean someone else advanced first / state changed mid-flight
          errName === 'RoundAlreadySettled' ||
          errName === 'TooEarlyToSettle' ||
          errName === 'NoActiveRound' ||
          // Pre-check ValueErrors raised before any tx hit chain
          /already settled|still in progress|Settle window|No active round/.test(msg);
        if (!isExpectedRace) throw e;
        // else: swallow — bet's own pre-checks surface anything that matters.
      }
    }

    // Pre-check minBet — clearer than the on-chain InvalidAmount revert.
    const min = await this.minBet();
    if (amount < min) {
      throw new Error(`Bet amount (${amount}) is below minBet (${min} wei = ${Number(min) / 1e18} USDB).`);
    }

    // Pre-check USDB balance — avoids burning gas on a guaranteed revert.
    const balance = await this.client.publicClient.readContract({
      address: this.client.usdbAddress, abi: IERC20Artifact.abi,
      functionName: 'balanceOf', args: [user],
    }) as bigint;
    if (balance < amount) {
      throw new Error(`Insufficient USDB. Have: ${balance} wei (${Number(balance) / 1e18}), want: ${amount} wei (${Number(amount) / 1e18}).`);
    }

    // Pre-check projected shares. The contract reverts `ZeroShares` if slippage
    // crushes shares to 0 (happens late in heavily-skewed rounds when betting
    // the dominant side). Folding the optional minShares slippage check into
    // the same read so we only do one quoteShares call.
    const projected = await this.quoteShares(tf, side, amount);
    if (projected === 0n) {
      throw new Error(
        'Bet would mint 0 shares due to pool skew + slippage. Consider betting the underdog side or waiting for the round to balance.'
      );
    }
    if (opts.minShares > 0n && projected < opts.minShares) {
      throw new Error(`Slippage: quoteShares would mint ${projected} shares, below minShares (${opts.minShares}).`);
    }

    await this._approveUsdbIfNeeded(amount);

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: fnName, args: [tf, amount],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * Claim winnings or refund for a settled round. Pre-checks via
   * `quoteClaimPayout` and throws "Nothing to claim" client-side if 0.
   */
  async claim(tf: number, roundId: bigint) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    const user = this.client.walletClient.account.address;

    const claimable = await this.quoteClaimPayout(tf, roundId, user);
    if (claimable === 0n) {
      throw new Error(`Nothing to claim on tf=${tf} roundId=${roundId} for ${user}. (Already claimed, lost, or round not settled.)`);
    }

    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'claim', args: [tf, roundId],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * **Fire-and-forget settle** for the current round of `tf`. Public — anyone
   * can call once the round has ended and a valid Chainlink price is available.
   *
   * This is the low-level primitive: ONE attempt, no polling, no waiting. If
   * the Chainlink oracle hasn't ticked past `round.endTime` yet, this throws
   * an `OracleNotReadyError` (a typed, catchable error — no need to parse
   * revert strings) so the caller can retry on their own schedule. For an
   * automatic poll-and-settle flow, use `advanceRound(tf)` instead.
   *
   * Pre-checks (avoid burning gas on a guaranteed revert):
   *  - Throws if no active round (`startPrediction` never called).
   *  - Throws if the round is already settled.
   *  - Throws if `now <= endTime` (still active) — `TooEarlyToSettle`.
   *  - Throws if `now > endTime + FINALIZE_WINDOW` and points the caller to
   *    `cancelCurrentRoundAndStartNext` instead — `TooLateForValidPrice`.
   *
   * @param tf - Timeframe enum (0=5m, 1=15m, 2=1h, 3=4h, 4=24h)
   * @returns `{ hash, receipt }`
   * @throws {OracleNotReadyError} if Chainlink hasn't updated past `round.endTime` yet
   * @throws {Error} for all other revert reasons (round not active, already settled, etc.)
   *
   * @example
   * // Manual retry loop
   * while (true) {
   *   try {
   *     await client.updown.eth.settleCurrentRound(0);
   *     break;
   *   } catch (e) {
   *     if (e instanceof OracleNotReadyError) {
   *       await new Promise(r => setTimeout(r, 15_000));
   *       continue;
   *     }
   *     throw e;
   *   }
   * }
   */
  async settleCurrentRound(tf: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    await this._preCheckRoundTiming(tf, 'settle');
    try {
      const { request } = await this.client.publicClient.simulateContract({
        account: this.client.walletClient.account,
        address: this.address, abi: AUpDownArtifact.abi,
        functionName: 'settleCurrentRound', args: [tf],
      });
      const hash = await this.client.writeContract(request);
      const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
      await this._syncTx(hash);
      return { hash, receipt };
    } catch (e: any) {
      const errName = e?.cause?.data?.errorName ?? e?.data?.errorName;
      if (errName === 'NoUpdateAfterEndTime' || errName === 'NoValidPriceInWindow') {
        // Pre-check above already verified active+pending+within-window, so currentRoundId is non-zero.
        const roundId = await this.currentRoundId(tf);
        const round = await this.getRound(tf, roundId);
        throw new OracleNotReadyError(
          `Chainlink oracle has not updated past round ${roundId} endTime yet (${errName}). ` +
          `Wait ~30s and retry settleCurrentRound, or use advanceRound(tf) which polls the oracle automatically.`,
          tf, round.endTime, errName,
        );
      }
      throw e;
    }
  }

  /**
   * Cancel the current round of `tf` and open the next one. Public — anyone
   * can call once `endTime + FINALIZE_WINDOW` has passed (settle timed out).
   *
   * Pre-checks:
   *  - Throws if no active round.
   *  - Throws if the round is already settled.
   *  - Throws if `now <= endTime + FINALIZE_WINDOW` — settle is still
   *    possible; points caller to `settleCurrentRound` instead.
   */
  async cancelCurrentRoundAndStartNext(tf: number) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    await this._preCheckRoundTiming(tf, 'cancel');
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: 'cancelCurrentRoundAndStartNext', args: [tf],
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }

  /**
   * **Settle-or-cancel the current round, with built-in oracle wait.**
   *
   * High-level helper that auto-routes to settle vs cancel based on round
   * timing AND polls the Chainlink price feed before submitting a settle tx.
   * Use this when you want a "just make it work" call — no manual retry loops,
   * no error-string parsing, no oracle-lag handling.
   *
   * Routing logic:
   *  - Round still in progress (`now <= endTime`) → throws "still in progress".
   *  - In the settle window (`endTime < now <= endTime + 20min`) → polls the
   *    price feed every `pollIntervalMs` until `updatedAt > endTime`, then
   *    calls `settleCurrentRound` once. Returns `mode: 'settle'`.
   *  - Past the settle window → calls `cancelCurrentRoundAndStartNext`.
   *    Returns `mode: 'cancel'`.
   *
   * **NOTE: this can take several minutes.** On less-active Chainlink feeds
   * (ETH/CAKE/DOGE on BSC) the oracle can lag 30s-2min past `round.endTime`.
   * Default `maxWaitMs` is 6min, leaving 14min of the contract's 20min settle
   * window as headroom. If the oracle stays stuck for `maxWaitMs`, throws
   * — at that point a fallback to cancel is the only option (will happen
   * automatically once you re-call `advanceRound` after the 20min mark).
   *
   * @param tf - Timeframe enum (0=5m, 1=15m, 2=1h, 3=4h, 4=24h)
   * @param opts.pollIntervalMs - Default `8000`. How often to re-read the
   *   price feed when waiting. Matches the dApp's UI poll cadence.
   * @param opts.maxWaitMs - Default `360000` (6 min). Max time to wait for
   *   the oracle before giving up and throwing.
   *
   * @returns `{ hash, receipt, mode }` where `mode` is `'settle'` if the round
   *   was settled with an oracle price, or `'cancel'` if the settle window
   *   expired and the round was canceled (refunding all bets via subsequent claim).
   *
   * @throws If no active round, the round is already settled, the round is
   *   still in progress, or the oracle stays stuck longer than `maxWaitMs`.
   *
   * @example
   * // Standard bot loop — handles oracle lag automatically. May take several minutes.
   * await client.updown.eth.advanceRound(0);
   *
   * @example
   * // Tight keeper that wants instant fail/retry
   * try {
   *   await client.updown.eth.settleCurrentRound(0); // fire-and-forget
   * } catch (e) {
   *   if (e instanceof OracleNotReadyError) {
   *     // wait, retry on your own schedule
   *   }
   * }
   */
  async advanceRound(
    tf: number,
    opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<{ hash: `0x${string}`; receipt: any; mode: 'settle' | 'cancel' }> {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    const cur = await this.getCurrentRound(tf);
    if (!cur) {
      throw new Error(`No active round for tf=${tf} — startPrediction has not been called.`);
    }
    const { roundId, round } = cur;
    if (round.outcome !== 0 /* Pending */) {
      throw new Error(`Round ${roundId} is already settled (outcome=${round.outcome}). Nothing to advance.`);
    }
    const FINALIZE_WINDOW = 1200n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now <= round.endTime) {
      const secs = Number(round.endTime - now);
      throw new Error(`Round ${roundId} is still in progress — ${secs}s remaining (ends at unix ${round.endTime}).`);
    }
    const deadline = round.endTime + FINALIZE_WINDOW;
    if (now > deadline) {
      const r = await this.cancelCurrentRoundAndStartNext(tf);
      return { ...r, mode: 'cancel' };
    }

    // Settle path — wait for oracle, then settle.
    const { pollIntervalMs = 8000, maxWaitMs = 360_000 } = opts;
    await this._waitForOracle(round.endTime, pollIntervalMs, maxWaitMs);
    const r = await this.settleCurrentRound(tf);
    return { ...r, mode: 'settle' };
  }

  /**
   * Polls the Chainlink price feed every `pollIntervalMs` until
   * `latestRoundData.updatedAt > endTime`. Throws if `maxWaitMs` elapses
   * without the oracle ticking. Used by `advanceRound` to bridge the
   * settle path's oracle dependency.
   */
  private async _waitForOracle(endTime: bigint, pollIntervalMs: number, maxWaitMs: number): Promise<void> {
    const priceFeed = await this.client.publicClient.readContract({
      address: this.address, abi: AUpDownArtifact.abi, functionName: 'priceFeed',
    }) as Address;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const data = await this.client.publicClient.readContract({
        address: priceFeed, abi: AggregatorV3Artifact.abi, functionName: 'latestRoundData',
      }) as readonly [bigint, bigint, bigint, bigint, bigint];
      const updatedAt = data[3];
      if (updatedAt > endTime) return;
      await sleep(pollIntervalMs);
    }
    throw new Error(
      `[advanceRound] Chainlink price feed (${priceFeed}) has not updated past ` +
      `round.endTime (${endTime}) after ${Math.round(maxWaitMs / 1000)}s of polling. ` +
      `The oracle may be stalled. If we're past round.endTime + 20min, retry — advanceRound will fall back to cancel.`,
    );
  }

  /**
   * Internal: validate timing for settle / cancel. `mode='settle'` requires
   * the round to be in the [endTime, endTime+FINALIZE_WINDOW] window;
   * `mode='cancel'` requires it to be past that window.
   */
  private async _preCheckRoundTiming(tf: number, mode: 'settle' | 'cancel'): Promise<void> {
    const cur = await this.getCurrentRound(tf);
    if (!cur) {
      throw new Error(`No active round for tf=${tf} — startPrediction has not been called.`);
    }
    const { roundId, round } = cur;
    if (round.outcome !== 0 /* Pending */) {
      throw new Error(`Round ${roundId} is already settled (outcome=${round.outcome}). Wait for the next round.`);
    }
    const FINALIZE_WINDOW = 1200n; // 20 minutes, matches contract constant
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = round.endTime + FINALIZE_WINDOW;
    if (mode === 'settle') {
      if (now <= round.endTime) {
        const secs = Number(round.endTime - now);
        throw new Error(`Round ${roundId} has not ended yet — ${secs}s remaining (ends at unix ${round.endTime}).`);
      }
      if (now > deadline) {
        throw new Error(`Settle window expired (deadline was unix ${deadline}). Call cancelCurrentRoundAndStartNext instead to refund and start the next round.`);
      }
    } else {
      if (now <= deadline) {
        const secs = Number(deadline - now);
        throw new Error(`Settle window not yet expired — ${secs}s remaining. Call settleCurrentRound instead until the window closes.`);
      }
    }
  }

  // --- Writes (admin / CEO-only) ---

  /** ADMIN. Open round 1 on every timeframe. Idempotent across timeframes. */
  async startPrediction() {
    return this._adminWrite('startPrediction', []);
  }

  /** ADMIN. Toggle the pause flag. */
  async setPaused(paused: boolean) {
    return this._adminWrite('setPaused', [paused]);
  }

  /**
   * ADMIN. Emergency cancel + pause: cancels every Pending round, captures
   * `seedBonus` into `pendingCarryover[tf]`, then sets paused = true.
   */
  async panicCancel() {
    return this._adminWrite('panicCancel', []);
  }

  /** ADMIN. Counterpart to panicCancel — unpause and open the next round on each timeframe. */
  async resumePrediction() {
    return this._adminWrite('resumePrediction', []);
  }

  /** ADMIN. Update the minimum bet size, USDB 18-dec. */
  async setMinBet(amount: bigint) {
    return this._adminWrite('setMinBet', [amount]);
  }

  /** ADMIN. Update the Chainlink price feed address. */
  async setPriceFeed(newFeed: Address) {
    return this._adminWrite('setPriceFeed', [newFeed]);
  }

  /** ADMIN. Update the USDB token address. */
  async setUsdb(newUsdb: Address) {
    return this._adminWrite('setUsdb', [newUsdb]);
  }

  /** ADMIN. Update the swap contract address. */
  async setSwap(newSwap: Address) {
    return this._adminWrite('setSwap', [newSwap]);
  }

  /** ADMIN. Update the wash-trade detection token. */
  async setWashToken(newToken: Address) {
    return this._adminWrite('setWashToken', [newToken]);
  }

  /** ADMIN. Transfer the CEO role. */
  async setCEO(newCEO: Address) {
    return this._adminWrite('setCEO', [newCEO]);
  }

  /**
   * ADMIN — DANGER. Pull USDB from the contract to CEO. For genuinely-stuck
   * funds only. The SDK does not gate this — caller must be CEO or the on-chain
   * tx will revert with `NotCEO`.
   */
  async emergencyWithdraw(amount: bigint) {
    return this._adminWrite('emergencyWithdraw', [amount]);
  }

  private async _adminWrite(fnName: string, args: any[]) {
    if (!this.client.walletClient || !this.client.walletClient.account) {
      throw new Error('Stateful initialization (walletClient) is required for write methods.');
    }
    const { request } = await this.client.publicClient.simulateContract({
      account: this.client.walletClient.account,
      address: this.address, abi: AUpDownArtifact.abi,
      functionName: fnName, args,
    });
    const hash = await this.client.writeContract(request);
    const receipt = await this.client.publicClient.waitForTransactionReceipt({ hash });
    await this._syncTx(hash);
    return { hash, receipt };
  }
}

// ============================================================
// Namespace holder — exposed as `client.updown`
// ============================================================

export class UpDownModule {
  public btc?: UpDownAssetModule;
  public eth?: UpDownAssetModule;
  public bnb?: UpDownAssetModule;
  public cake?: UpDownAssetModule;
  public doge?: UpDownAssetModule;

  constructor(client: BasisClient, addresses: Partial<Record<UpDownAsset, Address>>) {
    for (const asset of KNOWN_UPDOWN_ASSETS) {
      const addr = addresses[asset];
      if (addr && addr.toLowerCase() !== ZERO_ADDRESS) {
        this[asset] = new UpDownAssetModule(client, addr, asset);
      }
    }
  }

  /** All deployed per-asset modules, in declaration order. */
  get all(): UpDownAssetModule[] {
    return KNOWN_UPDOWN_ASSETS
      .map((a) => this[a])
      .filter((m): m is UpDownAssetModule => m !== undefined);
  }

  /** Convenience lookup: `client.updown.byAsset('btc')` returns the module or undefined. */
  byAsset(asset: UpDownAsset): UpDownAssetModule | undefined {
    return this[asset];
  }
}
