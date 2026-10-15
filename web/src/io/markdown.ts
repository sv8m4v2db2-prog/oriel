// Markdown helpers for import/export (DOM-free): title and property header extraction, links,
// relative paths, and splitting of HTML islands (callouts `<aside>`, toggles `<details>`).
import { dirname, joinPath, normalizePath } from './vfs';
import { leadingEmoji, looseKey } from './text';
import { safeLinkUrl } from '../lib/safeUrl';

/** First `# Heading` of the document (when it is the first non-empty line) → title. */
export function extractTitle(md: string): { title: string | null; body: string } {
  const lines = md.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return { title: null, body: '' };
  const m = /^#\s+(.+?)\s*#*\s*$/.exec(lines[first]!);
  if (!m) return { title: null, body: md };
  return { title: m[1]!.trim(), body: lines.slice(first + 1).join('\n') };
}

const PROP_LINE = /^([^:\n]{1,120}?)\s*:\s(.*)$/;

/**
 * Property lines right after the title of a database row page ("Statut: En cours"). Only keys
 * accepted by `isKey` are consumed; returns them and the remaining body.
 */
export function extractPropertyHeader(body: string, isKey: (key: string) => boolean): { props: Array<[string, string]>; body: string } {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  const props: Array<[string, string]> = [];
  while (i < lines.length) {
    const m = PROP_LINE.exec(lines[i]!.trim());
    if (!m || !isKey(m[1]!)) break;
    props.push([m[1]!.trim(), m[2]!.trim()]);
    i++;
  }
  if (props.length === 0) return { props, body };
  return { props, body: lines.slice(i).join('\n') };
}

export interface MdLink {
  text: string;
  href: string;
  /** The link is the only content of its line (sub-page / database / file card). */
  alone: boolean;
  index: number;
}

// Link text without unescaped brackets and <…> destinations without '<' (CommonMark): every scan stops
// at the next bracket, so a crafted line ("[[[[…", "[a](<[a](<…") costs linear time, not quadratic.
const LINK_RE = /(!?)\[((?:[^[\]\\]|\\.)*)\]\((<[^<>]*>|(?:[^()\s\\]|\\.|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;

/** Markdown links and images of a document (destination unescaped, `<…>` unwrapped). */
export function findLinks(md: string): Array<MdLink & { image: boolean }> {
  const out: Array<MdLink & { image: boolean }> = [];
  for (const line of md.split('\n')) {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const found: Array<MdLink & { image: boolean }> = [];
    while ((m = LINK_RE.exec(line))) {
      let href = m[3]!;
      if (href.startsWith('<')) href = href.slice(1, -1);
      href = href.replace(/\\(.)/g, '$1');
      found.push({ image: m[1] === '!', text: m[2]!.replace(/\\(.)/g, '$1'), href, alone: false, index: out.length + found.length });
    }
    if (found.length === 1) {
      const stripped = line.replace(LINK_RE, '').replace(/^[\s>*+-]*(\d+\.)?\s*/, '').trim();
      found[0]!.alone = stripped === '' && /^\s*!?\[/.test(line);
    }
    out.push(...found);
  }
  return out;
}

export type HrefTarget = { kind: 'external'; url: string } | { kind: 'anchor' } | { kind: 'path'; path: string };

/** Classifies a link destination and resolves relative paths against the document's folder. */
export function resolveHref(href: string, docPath: string): HrefTarget {
  const h = href.trim();
  if (!h) return { kind: 'anchor' };
  if (h.startsWith('#')) return { kind: 'anchor' };
  // Only web, mail and phone links are kept: `javascript:`, `data:`, `file:`… become plain text (QA-G8-04).
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return safeLinkUrl(h) ? { kind: 'external', url: h } : { kind: 'anchor' };
  if (h.startsWith('//')) return { kind: 'external', url: h };
  if (h.startsWith('/')) return { kind: 'external', url: h };
  const noFragment = h.replace(/[?#].*$/, '');
  let decoded = noFragment;
  try {
    decoded = decodeURIComponent(noFragment);
  } catch {
    try {
      decoded = decodeURI(noFragment);
    } catch {
      decoded = noFragment;
    }
  }
  return { kind: 'path', path: joinPath(dirname(docPath), decoded) };
}

/** Relative, URL-encoded link from the folder of `fromFile` to `toFile` (archive paths). */
export function relativeHref(fromFile: string, toFile: string): string {
  const from = dirname(normalizePath(fromFile)).split('/').filter(Boolean);
  const to = normalizePath(toFile).split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  return [...up, ...to.slice(i)].map((seg) => (seg === '..' ? seg : encodeURIComponent(seg))).join('/');
}

// ---------------------------------------------------------------------------
// HTML islands of exported Markdown
// ---------------------------------------------------------------------------

export type MdSegment =
  | { type: 'markdown'; text: string }
  | { type: 'callout'; emoji: string; text: string }
  | { type: 'toggle'; summary: string; text: string; /** Toggle heading level (summary wrapped in <h1>–<h3>). */ level?: number };

const stripTags = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|span|strong|em|b|i|u|s|code)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * Splits top-level `<aside>…</aside>` (callouts) and `<details><summary>…</summary>…</details>`
 * (toggles) out of the Markdown, so they can become Oriel callouts / toggle lists.
 */
export function segmentMarkdown(md: string): MdSegment[] {
  const out: MdSegment[] = [];
  const lines = md.split('\n');
  let buf: string[] = [];
  const flush = () => {
    if (buf.join('').trim()) out.push({ type: 'markdown', text: buf.join('\n') });
    buf = [];
  };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^\s*<aside\b[^>]*>/i.test(line)) {
      const block: string[] = [];
      let j = i;
      let rest = line.replace(/^\s*<aside\b[^>]*>/i, '');
      for (;;) {
        const close = /<\/aside>/i.exec(rest);
        if (close) {
          block.push(rest.slice(0, close.index));
          break;
        }
        block.push(rest);
        j++;
        if (j >= lines.length) break;
        rest = lines[j]!;
      }
      flush();
      let text = stripTags(block.join('\n')).trim();
      const emoji = leadingEmoji(text) ?? '💡';
      if (text.startsWith(emoji)) text = text.slice(emoji.length).trim();
      out.push({ type: 'callout', emoji, text });
      i = j;
      continue;
    }
    if (!inFence && /^\s*<details\b[^>]*>/i.test(line)) {
      const block: string[] = [];
      let depth = 0;
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        depth += (l.match(/<details\b/gi) ?? []).length;
        depth -= (l.match(/<\/details>/gi) ?? []).length;
        block.push(l);
        if (depth <= 0) break;
      }
      const raw = block.join('\n');
      const sm = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(raw);
      const summary = sm ? stripTags(sm[1]!.replace(/<\/?h[1-6][^>]*>/gi, '')).trim() : '';
      const heading = sm ? /<h([1-6])\b/i.exec(sm[1]!) : null;
      const inner = raw
        .replace(/^\s*<details\b[^>]*>/i, '')
        .replace(/<\/details>\s*$/i, '')
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '');
      flush();
      out.push(heading ? { type: 'toggle', summary, text: inner.trim(), level: Math.min(4, Number(heading[1])) } : { type: 'toggle', summary, text: inner.trim() });
      i = j;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Title-ish comparison between a link text and a page title. */
export function sameTitle(a: string, b: string): boolean {
  return looseKey(a) === looseKey(b);
}
