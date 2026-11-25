import { ApiCore } from './core';

/** One stored BASIS log of the transaction. */
export interface SyncEvent {
  /** Event name, or `unknown`. */
  type: string;
  contractAddress: string;
  logIndex: number;
  /** False when this call found the row already stored. */
  inserted: boolean;
}

/** 200 answer of `POST /api/v1/sync`. */
export interface SyncTransactionResponse {
  success: boolean;
  /** `ignored`: the transaction has no BASIS event; `partial`: some typed rows failed (see `projectError`). */
  status: 'synced' | 'already_synced' | 'partial' | 'ignored';
  chainId: number;
  txHash: string;
  blockNumber: number | null;
  confirmed: boolean;
  events: SyncEvent[];
  /** Raw rows written by this call. */
  inserted: number;
  /** Typed rows written per table by this call (empty for `already_synced` and `ignored`). */
  typed: Record<string, number>;
  /** Always null (kept for shape). */
  loan: null;
  /** Kept for shape (`events` is always 0). */
  updown: { success: boolean; events: number };
  error?: string | null;
  /** Why a transaction is `partial`. */
  projectError?: string | null;
}

export class SyncApi extends ApiCore {
  /**
   * POST /api/v1/sync `{txHash, source: "sdk"}`: store every BASIS event of a transaction (trades, loans, vault,
   * vesting, markets and the order book, resolution, Up/Down, token and market creation). One attempt: a non-2xx
   * throws BasisApiError (422 `code`: pending | reverted | sync_failed; 503 `chain_mismatch`; 429 `rate_limited`).
   * No auth; 60 a minute per IP. Idempotent.
   */
  async syncTransaction(txHash: string): Promise<SyncTransactionResponse> {
    return this.request('POST', '/api/v1/sync', { body: { txHash, source: 'sdk' } });
  }
}
