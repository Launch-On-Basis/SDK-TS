import { METADATA_MAX_LENGTH } from '../api/content';
import { ValidationError } from '../core/errors';
import type { TokenMetadataFields } from './Factory';

/**
 * Trims ASCII whitespace only, as `parseAmount`
 * does: `trim()` also strips U+FEFF and other Unicode spaces, which PY's `strip(" \t\n\r\f\v")` keeps.
 */
export function trimAscii(s: string): string {
  return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
}

const MAX_LINK = 191;
const MAX_RAW_LINK = 2048;
const TG_PATH = /^(?:[A-Za-z0-9_]{4,32}|\+[A-Za-z0-9_-]{6,64}|joinchat\/[A-Za-z0-9_-]{6,64})$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const LINK_ERROR = {
  website: 'The website must be an https:// link.',
  telegram: 'Telegram must be a t.me link, like https://t.me/your_channel.',
  twitterx: 'X must be a profile link, like https://x.com/your_handle.',
} as const;

/** The link as the site stores it, or null when the site refuses it. `raw` is already trimmed as the site trims it. */
function siteLink(field: 'website' | 'telegram' | 'twitterx', raw: string): string | null {
  if (field === 'website') {
    const s = (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).trim();
    if (!s || s.length > MAX_RAW_LINK) return null;
    try {
      const url = new URL(s);
      return url.protocol === 'https:' && url.hostname.includes('.') ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (field === 'telegram') {
    const at = /^@([A-Za-z0-9_]{4,32})$/.exec(raw);
    let path = at ? at[1] : null;
    if (!path) {
      const m = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([^?#]+?)\/?(?:[?#].*)?$/i.exec(raw);
      path = m ? m[1] : /^[A-Za-z0-9_]{4,32}$/.test(raw) ? raw : null;
    }
    return path && TG_PATH.test(path) ? `https://t.me/${path}` : null;
  }
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([^/?#]+)\/?(?:[?#].*)?$/i.exec(raw);
  const handle = m ? m[1] : raw.replace(/^@/, '');
  return X_HANDLE.test(handle) ? `https://x.com/${handle}` : null;
}

/**
 * The rules of POST /api/metadata, checked before the create
 * tx (see `TokenMetadataFields`). Validates only: the caller's value is sent as given. An empty link means no link.
 */
export function checkMetadataFields(f: TokenMetadataFields): void {
  const d = f.description;
  if (d !== undefined && d !== null) {
    if (typeof d !== 'string') throw new ValidationError('metadataTooLong', 'description must be a string.');
    if (d.length > METADATA_MAX_LENGTH.description) {
      throw new ValidationError('metadataTooLong', `description is ${d.length} characters; the API takes at most ${METADATA_MAX_LENGTH.description}.`);
    }
  }
  for (const key of ['website', 'telegram', 'twitterx'] as const) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new ValidationError('metadataTooLong', `${key} must be a string.`);
    const raw = v.trim();
    if (raw === '') continue;
    if (raw.length > MAX_RAW_LINK) throw new ValidationError('metadataTooLong', `${key} is ${raw.length} characters; the API takes at most ${MAX_RAW_LINK}.`);
    const link = siteLink(key, raw);
    if (link === null) throw new ValidationError('metadataLink', `${LINK_ERROR[key]} Got ${JSON.stringify(v)}.`);
    if (link.length > MAX_LINK) {
      throw new ValidationError('metadataTooLong', `${key} is ${link.length} characters as the API stores it (${link}); it takes at most ${MAX_LINK}.`);
    }
  }
}
