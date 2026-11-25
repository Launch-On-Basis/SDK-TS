
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET[i]] = i;
VALUES['-'] = 62;
VALUES['_'] = 63;

/** Standard base64 (with `=` padding) of `bytes`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
}

/**
 * The bytes of base64 text, decoded as leniently as Node's `Buffer.from(s, 'base64')`: the standard and the base64url
 * alphabets, padding optional, decoding stops at the first `=`, any other character (whitespace included) is skipped.
 */
export function base64ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    if (ch === '=') break;
    const v = VALUES[ch];
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Base64 of the UTF-8 bytes of `text` (as `Buffer.from(text, 'utf8').toString('base64')`). */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** UTF-8 text of base64 `b64` (as `Buffer.from(b64, 'base64').toString('utf8')`; invalid UTF-8 becomes U+FFFD). */
export function base64ToUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}
