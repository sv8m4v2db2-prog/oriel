// `oriel://` references used in the Markdown exchanged with Claude: pages, databases, people, dates
// and Oriel blocks that have no Markdown equivalent (table of contents, embeds, bookmarks, PDF).
//
//   oriel://page/<id>                       page / sub-page / row (block when alone on its line, mention otherwise)
//   oriel://database/<id>[?view=<linkId>]   inline database (or linked view of a database)
//   oriel://user/<id>                       person mention
//   oriel://date/YYYY-MM-DD[?reminder=1]    date mention (with a reminder)
//   oriel://toc                             table of contents
//   oriel://breadcrumb                      breadcrumb (ancestors of the page)
//   oriel://synced/<id>                     synced block (content shared with other pages of the workspace)
//   oriel://embed?url=…[&provider=…&height=…]
//   oriel://bookmark?url=…[&title=…&description=…&image=…&favicon=…]
//   oriel://pdf?url=…[&name=…&height=…]
//
// BlockNote's Markdown parser drops links with unknown schemes, so `oriel://` is swapped for a
// placeholder https origin around parsing and serialization.

import { isSyncedId } from '@oriel/shared';

export const SCHEME = 'oriel://';
export const PLACEHOLDER_ORIGIN = 'https://oriel.mcp.invalid';

export type OrielRef =
  | { kind: 'page'; id: string }
  | { kind: 'database'; id: string; linkId?: string }
  | { kind: 'user'; id: string }
  | { kind: 'date'; date: string; reminder: boolean; userId?: string }
  | { kind: 'toc' }
  | { kind: 'breadcrumb' }
  | { kind: 'synced'; id: string }
  | { kind: 'embed'; url: string; provider?: string; height?: number }
  | { kind: 'bookmark'; url: string; title?: string; description?: string; image?: string; favicon?: string }
  | { kind: 'pdf'; url: string; name?: string; height?: number }
  | { kind: 'drawing'; strokes: string };

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** `oriel://…` form of a reference. */
export function formatRef(ref: OrielRef, origin = SCHEME): string {
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  switch (ref.kind) {
    case 'page':
      return `${base}page/${ref.id}`;
    case 'database':
      return `${base}database/${ref.id}${query({ view: ref.linkId })}`;
    case 'user':
      return `${base}user/${ref.id}`;
    case 'date':
      return `${base}date/${ref.date}${query({ reminder: ref.reminder, user: ref.reminder ? ref.userId : undefined })}`;
    case 'toc':
      return `${base}toc`;
    case 'breadcrumb':
      return `${base}breadcrumb`;
    case 'synced':
      return `${base}synced/${ref.id}`;
    case 'embed':
      return `${base}embed${query({ url: ref.url, provider: ref.provider && ref.provider !== 'generic' ? ref.provider : undefined, height: ref.height || undefined })}`;
    case 'bookmark':
      return `${base}bookmark${query({ url: ref.url, title: ref.title, description: ref.description, image: ref.image, favicon: ref.favicon })}`;
    case 'drawing':
      return `${base}drawing${query({ strokes: ref.strokes })}`;
    case 'pdf':
      return `${base}pdf${query({ url: ref.url, name: ref.name, height: ref.height && ref.height !== 640 ? ref.height : undefined })}`;
  }
}

/** Placeholder https form (what BlockNote sees). */
export const placeholderHref = (ref: OrielRef) => formatRef(ref, PLACEHOLDER_ORIGIN);

/** Parses `oriel://…` or its placeholder form; null for any other URL or a malformed reference. */
export function parseRef(href: string): OrielRef | null {
  let rest: string;
  if (href.startsWith(SCHEME)) rest = href.slice(SCHEME.length);
  else if (href.startsWith(`${PLACEHOLDER_ORIGIN}/`)) rest = href.slice(PLACEHOLDER_ORIGIN.length + 1);
  else return null;
  let url: URL;
  try {
    url = new URL(`${PLACEHOLDER_ORIGIN}/${rest}`);
  } catch {
    return null;
  }
  const [kind, rawId = ''] = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* keep raw */
  }
  const p = url.searchParams;
  const num = (k: string) => {
    const v = p.get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) => p.get(k) ?? undefined;
  switch (kind) {
    case 'page':
      return ID_RE.test(id) ? { kind: 'page', id } : null;
    case 'database': {
      const view = str('view') ?? str('link');
      return ID_RE.test(id) ? { kind: 'database', id, ...(view && ID_RE.test(view) ? { linkId: view } : {}) } : null;
    }
    case 'user':
      return ID_RE.test(id) ? { kind: 'user', id } : null;
    case 'date': {
      if (!DATE_RE.test(id)) return null;
      const reminder = ['1', 'true', 'oui'].includes((p.get('reminder') ?? p.get('rappel') ?? '').toLowerCase());
      const userId = str('user');
      return { kind: 'date', date: id, reminder, ...(userId && ID_RE.test(userId) ? { userId } : {}) };
    }
    case 'toc':
      return { kind: 'toc' };
    case 'breadcrumb':
      return { kind: 'breadcrumb' };
    case 'synced':
      return isSyncedId(id) ? { kind: 'synced', id } : null;
    case 'embed': {
      const target = str('url');
      return target ? { kind: 'embed', url: target, provider: str('provider'), height: num('height') } : null;
    }
    case 'bookmark': {
      const target = str('url');
      return target
        ? { kind: 'bookmark', url: target, title: str('title'), description: str('description'), image: str('image'), favicon: str('favicon') }
        : null;
    }
    case 'pdf': {
      const target = str('url');
      return target ? { kind: 'pdf', url: target, name: str('name'), height: num('height') } : null;
    }
    case 'drawing': {
      const strokes = str('strokes');
      return strokes ? { kind: 'drawing', strokes } : null;
    }
    default:
      return null;
  }
}

/**
 * Extracts a page/database id from what Claude may pass: a bare id, a `oriel://page/<id>` link or a
 * web URL of the page (`…/w/<workspace>/p/<page>`).
 */
export function pageIdFrom(input: string): string {
  const s = input.trim();
  const ref = parseRef(s);
  if (ref && (ref.kind === 'page' || ref.kind === 'database')) return ref.id;
  const app = /\/w\/[^/]+\/p\/([A-Za-z0-9_-]+)/.exec(s);
  if (app) return app[1]!;
  const share = /\/share\/([A-Za-z0-9_-]+)/.exec(s);
  if (share) return share[1]!;
  return s;
}

/**
 * Same-origin path or http(s)/mailto/tel link: anything else (javascript:, data:…) is refused. A path is
 * refused when a browser would read it as another host (QA-MCP-03): `/\\evil`, `/\t/evil` (tabs and
 * newlines are dropped by URL parsing) are protocol-relative.
 */
export function isSafeLinkHref(href: string): boolean {
  const h = href.trim();
  if (h.startsWith('#')) return !/[\u0000-\u001f\u007f]/.test(h);
  if (h.startsWith('/')) return !/[\\\u0000-\u001f\u007f]/.test(h) && !/^\/[\s/]/.test(h);
  return /^(https?:\/\/|mailto:|tel:)/i.test(h);
}

/**
 * Media / embed source: http(s), or an uploaded Oriel file (`/api/files/<id>/<name>`, no dot
 * segment or backslash that would lead the reader's browser to another API route — QA-MCP-03).
 */
export function isSafeMediaUrl(url: string): boolean {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return true;
  return isOrielFileUrl(u);
}

/** `/api/files/<id>/<name>` path of an uploaded file. */
export function isOrielFileUrl(url: string): boolean {
  const m = /^\/api\/files\/([A-Za-z0-9_-]+)\/([^/?#\\]+)$/.exec(url);
  if (!m) return false;
  let name: string;
  try {
    name = decodeURIComponent(m[2]!);
  } catch {
    return false;
  }
  return name !== '.' && name !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(name);
}

/** Replaces `](oriel://` destinations (outside code fences) with the placeholder origin. */
export function protectSchemes(md: string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/\]\(\s*<?oriel:\/\//g, (m) => m.replace(SCHEME, `${PLACEHOLDER_ORIGIN}/`))
        .replace(/<oriel:\/\//g, `<${PLACEHOLDER_ORIGIN}/`);
    })
    .join('\n');
}

/** Inverse of protectSchemes for serialized Markdown. */
export const restoreSchemes = (md: string): string => md.split(`${PLACEHOLDER_ORIGIN}/`).join(SCHEME);
