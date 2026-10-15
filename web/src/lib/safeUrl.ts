// Addresses coming from shared content (block props, pasted HTML, imports) before they are opened.
// React neutralizes `javascript:` in the href attributes it renders, but not in window.open(): links
// opened by code go through these helpers.

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function parse(raw: unknown, base: string | undefined, allowed: Set<string>): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    // The URL parser drops the tabs / newlines / control characters used to disguise a scheme.
    const u = base === undefined ? new URL(raw.trim()) : new URL(raw.trim(), base);
    return allowed.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Normalized http(s) address, or null (javascript:, data:, vbscript:, file:, blob:, invalid…).
 * With `base`, relative addresses resolve against it (uploaded files: `/api/files/…`).
 */
export function safeWebUrl(raw: unknown, base?: string): string | null {
  return parse(raw, base, WEB_PROTOCOLS);
}

/** Like safeWebUrl, also accepting mailto: and tel: (links written in the editor). */
export function safeLinkUrl(raw: unknown, base?: string): string | null {
  return parse(raw, base, LINK_PROTOCOLS);
}
