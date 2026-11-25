import { Address, concat, encodeAbiParameters, Hex, hexToBigInt, keccak256, recoverTypedDataAddress, size, stringToHex } from 'viem';
import { ValidationError } from './errors';
import { optionKeys, optsOf } from './opts';
import { checkText, toAddress } from './units';

/** EIP-712 domain name/version of both market hosts; `verifyingContract` is the host, so each host needs its own signature. */
export const MARKET_APPROVAL_DOMAIN = { name: 'BASIS Markets', version: '1' } as const;

export const MARKET_APPROVAL_TYPES = {
  MarketApproval: [
    { name: 'creator', type: 'address' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** secp256k1 n/2: a signature with a higher `s` is refused. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Which host an approval is for: `public` (settled by the resolver) or `private` (settled by the creator's panel). */
export type MarketType = 'public' | 'private';

/** The exact strings BASIS signed. Submit them to `createMarket` unchanged. */
export interface MarketApprovalSigned {
  name: string;
  symbol: string;
  outcomes: string[];
  /** The market's close time, unix seconds (0 = open-ended): part of what is signed. */
  endTime?: number | bigint;
}

/** An approval ready for `createMarket`: signature, deadline (unix seconds) and the signed strings. */
export interface MarketApproval {
  signature: Hex;
  deadline: bigint;
  signed: MarketApprovalSigned;
}

/** `POST /api/v1/markets/approve` request body. */
export interface ApproveMarketParams {
  marketType: MarketType;
  name: string;
  symbol: string;
  description?: string;
  outcomes: string[];
  /** The market's close time, unix seconds (0 = open-ended): the signature covers it. */
  endTime?: number | bigint;
  /** Optional, not part of the review: lets the route check the seed rule before spending a screening. */
  main?: Address;
  /** Raw pair-asset seed (optional, with `main`): a whole number (bigint, or a safe-integer number). */
  seedAmount?: number | bigint;
  /** Private host only: invite-only market (selects the private-event seed floor), with `main`. */
  privateEvent?: boolean;
}

/** Approved: pass `signed.*`, `deadline` and `signature` to `createMarket` on `verifyingContract`, from the same wallet. */
export interface MarketApprovalGranted {
  approved: true;
  decision: 'approve';
  marketType: MarketType;
  signed: MarketApprovalSigned;
  signature: Hex;
  /** Unix seconds (a JSON number on the wire). */
  deadline: bigint;
  contentHash: Hex;
  verifyingContract: Address;
  /** Who signed the approval. */
  signer: Address;
  chainId?: number;
  /** The market host to call `createMarket` on (= `verifyingContract`). */
  host?: Address;
  escalated?: boolean;
  model?: string;
}

/** BASIS refused the market (HTTP 200). */
export interface MarketApprovalRejected {
  approved: false;
  decision: 'reject';
  category?: string;
  reason?: string;
  escalated?: boolean;
  model?: string;
  cached?: boolean;
}

/** `approveMarket`'s answer. A route error (400/401/413/429/500/503) throws BasisApiError with its `code` instead. */
export type MarketApprovalResponse = MarketApprovalGranted | MarketApprovalRejected;

/** What a value is in a refusal message (`typeof`; null is 'null'), as the API's outcomes check words it. */
const kindOf = (v: unknown): string => (v === null ? 'null' : typeof v);

/**
 * The approval's `contentHash` of a market, as the host computes it.
 * `name` and `symbol` must be strings and `outcomes` an array of strings (anything else is `ValidationError` 'name' /
 * 'symbol' / 'outcomes', never converted to text). They are hashed as UTF-8, so each must be well-formed text: a lone
 * surrogate is refused with the same rules (`checkText`; it would hash as U+FFFD, PY cannot encode it). `endTime` left
 * out or null: 0. Same rules and messages in PY.
 */
export function marketContentHash(name: string, symbol: string, outcomes: readonly string[], endTime: bigint | null = 0n): Hex {
  for (const [v, field] of [[name as unknown, 'name'], [symbol as unknown, 'symbol']] as const) {
    if (typeof v !== 'string') throw new ValidationError(field, `${field} must be a string, got ${kindOf(v)}.`);
  }
  const list: unknown = outcomes;
  if (!Array.isArray(list) || list.some((o) => typeof o !== 'string')) {
    const got = Array.isArray(list) ? 'an array with a non-string entry' : kindOf(list);
    throw new ValidationError('outcomes', `outcomes must be an array of answer strings, got ${got}.`);
  }
  checkText(name, 'name');
  checkText(symbol, 'symbol');
  for (const o of outcomes) checkText(o, 'outcomes');
  const h = (s: string) => keccak256(stringToHex(s));
  const optionsHash = keccak256(outcomes.length ? concat(outcomes.map(h)) : '0x');
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [h(name), h(symbol), optionsHash, endTime ?? 0n],
  ));
}

export interface VerifyMarketApprovalParams {
  /** The market host the approval is for (EIP-712 `verifyingContract`). */
  host: Address;
  chainId: number;
  /** The wallet that will send `createMarket` (`msg.sender`). */
  creator: Address;
  name: string;
  symbol: string;
  outcomes: readonly string[];
  /** The market's close time sent to `createMarket` (default 0, open-ended; null too). */
  endTime?: bigint | null;
  deadline: bigint;
  signature: Hex;
  /** The signer the host accepts (read it from the host). The recovered signer must equal it. */
  expectedSigner: Address;
  /** The gateway's `contentHash`, when it sent one: must match the local hash. */
  contentHash?: Hex;
}
const VERIFY_MARKET_APPROVAL_KEYS = optionKeys<VerifyMarketApprovalParams>({
  host: true, chainId: true, creator: true, name: true, symbol: true, outcomes: true, endTime: true, deadline: true,
  signature: true, expectedSigner: true, contentHash: true,
});

/**
 * Check a market approval locally, the way the host will: a well-formed EIP-712 signature by `expectedSigner`, for
 * this host, creator, market strings and deadline.
 * Returns the recovered signer; throws `ValidationError` on any mismatch (a string that is not well-formed text: rule
 * 'name' / 'symbol' / 'outcomes', as `marketContentHash`). Does not check expiry or single use.
 * `host`, `creator` and `expectedSigner` are strict addresses (`toAddress`: a wrong checksum is refused, rule = the field).
 * A `params` that is not an object, or with a key `VerifyMarketApprovalParams` does not have, is
 * `ValidationError('options')` (null: every field missing, so 'host').
 */
export async function verifyMarketApproval(params: VerifyMarketApprovalParams): Promise<Address> {
  const p = optsOf(params, VERIFY_MARKET_APPROVAL_KEYS);
  const host = toAddress(p.host, 'host');
  const creator = toAddress(p.creator, 'creator');
  const expectedSigner = toAddress(p.expectedSigner, 'expectedSigner');
  const contentHash = marketContentHash(p.name, p.symbol, p.outcomes, p.endTime ?? 0n);
  if (p.contentHash && p.contentHash.toLowerCase() !== contentHash.toLowerCase()) {
    throw new ValidationError(
      'Invalid approval',
      `The approval's contentHash ${p.contentHash} does not match the name/symbol/outcomes/endTime being sent (${contentHash}): submit the signed strings unchanged.`,
    );
  }
  if (!/^0x[0-9a-fA-F]*$/.test(p.signature) || size(p.signature) !== 65) {
    throw new ValidationError('Invalid approval', 'The approval signature must be 65 bytes (r, s, v).');
  }
  const s = hexToBigInt(`0x${p.signature.slice(66, 130)}`);
  const v = parseInt(p.signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new ValidationError('Invalid approval', `The approval signature has v = ${v}; the host accepts only 27 or 28.`);
  if (s > HALF_N) throw new ValidationError('Invalid approval', 'The approval signature has a high s value; the host refuses it.');

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { ...MARKET_APPROVAL_DOMAIN, chainId: p.chainId, verifyingContract: host },
      types: MARKET_APPROVAL_TYPES,
      primaryType: 'MarketApproval',
      message: { creator, contentHash, deadline: p.deadline },
      signature: p.signature,
    });
  } catch (e) {
    throw new ValidationError('Invalid approval', `The approval signature cannot be recovered: ${(e as Error)?.message ?? e}`);
  }
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new ValidationError(
      'Invalid approval',
      `The approval was signed by ${recovered}, not the host's approval signer ${expectedSigner}. ` +
      'It was issued for another wallet, host, chain or content, or by another key: request a new approval.',
    );
  }
  return recovered;
}
