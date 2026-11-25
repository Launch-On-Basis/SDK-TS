
/** A URL up to the first space or quote (its user info, path, query and fragment are dropped). */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"<>`]*/gi;
/** Punctuation that closes the sentence or bracket around a URL: kept. */
const TAIL_RE = /[)\]},.;:!?]+$/;
/** A path printed on its own after "url:" (as urllib3 does: "Max retries exceeded with url: /v2/KEY"). */
const PATH_RE = /(\burl: )\/[^\s'"<>`()]*/gi;

/**
 * `text` with every URL cut down to its scheme and host (`https://rpc.example.com/v2/KEY` reads
 * `https://rpc.example.com`) and a bare path after `url:` replaced by `[path removed]`. PY: `redact_urls`.
 */
export function redactUrls(text: unknown): string {
  return String(text)
    .replace(URL_RE, (u) => {
      const end = TAIL_RE.exec(u)?.[0] ?? '';
      const url = u.slice(0, u.length - end.length);
      const i = url.indexOf('://');
      const authority = url.slice(i + 3).split(/[/?#]/, 1)[0];
      return `${url.slice(0, i)}://${authority.slice(authority.lastIndexOf('@') + 1)}${end}`;
    })
    .replace(PATH_RE, '$1[path removed]');
}

/**
 * What `e` says, for an error, log or queue text: viem's short message and its details (never the "URL:" line of its
 * full message), else the error's message; every URL cut down to its scheme and host.
 */
export function errorText(e: unknown): string {
  const c = e as { shortMessage?: unknown; details?: unknown; message?: unknown } | null | undefined;
  let s: string;
  if (typeof c?.shortMessage === 'string' && c.shortMessage) {
    const d = typeof c.details === 'string' ? c.details.trim() : '';
    s = d && !c.shortMessage.includes(d) ? `${c.shortMessage} (${d})` : c.shortMessage;
  } else {
    s = typeof c?.message === 'string' ? c.message : String(e);
  }
  return redactUrls(s);
}
