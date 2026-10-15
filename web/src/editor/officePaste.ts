// Pasting from Word / Excel / PowerPoint / Outlook (E19): the clipboard HTML is cleaned to semantic
// HTML before BlockNote parses it. Pure string code (own tolerant tokenizer): testable without a DOM.
// Output only holds p, h1-h4, ul/ol/li, strong, em, u, s, a(http/https/mailto/tel), br, table parts.

interface El { tag: string; attrs: Record<string, string>; children: Node[] }
type Node = El | string;

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'col', 'input', 'wbr']);
const DROP = new Set(['ormarker', 'style', 'script', 'xml', 'head', 'title', 'meta', 'link', 'object', 'iframe', 'img', 'colgroup', 'col']);
// QA-G5-01: `ProgId.*Word` backtracked quadratically (1 MB of "ProgId" froze the tab for minutes, on
// every HTML paste): the gap is bounded.
const OFFICE_MARK = /<o:p>|mso-|class="?Mso|urn:schemas-microsoft-com|<!--\[if|<w:|xmlns:o=|ProgId[^\n]{0,200}?(?:Word|Excel)|content="Microsoft/i;
/** Elements nested deeper are flattened into their ancestor (the text is kept; no stack overflow). */
const MAX_DEPTH = 128;

export function isOfficeHtml(html: string): boolean {
  return OFFICE_MARK.test(html);
}

function decode(t: string): string {
  return t
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Math.min(+d, 0x10ffff) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff) || 32))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * QA-G5-01 — `src` with every `open … close` section replaced (shortest match, like a lazy
 * `open[\s\S]*?close`), in linear time: the lazy regular expressions rescanned the rest of the text
 * from every unterminated opening (quadratic). Once an opening has no end, no later one can have one.
 */
function replaceSections(src: string, open: RegExp, close: RegExp, by: (inner: string) => string = () => ''): string {
  const o = new RegExp(open.source, 'gi');
  const c = new RegExp(close.source, 'gi');
  let out = '';
  let at = 0;
  for (;;) {
    o.lastIndex = at;
    const m = o.exec(src);
    if (!m) break;
    c.lastIndex = m.index + m[0].length;
    const e = c.exec(src);
    if (!e) break;
    out += src.slice(at, m.index) + by(src.slice(m.index + m[0].length, e.index));
    at = e.index + e[0].length;
  }
  return at === 0 ? src : out + src.slice(at);
}

function parse(html: string): El {
  // Conditional comments: `<!--[if …]>…<![endif]-->` removed with content; `<![if !supportLists]>…<![endif]>`
  // (list bullets drawn by Word) removed with content as well; remaining comments removed.
  let src = replaceSections(html, /<!--\[if/, /<!\[endif\]-->/);
  src = replaceSections(src, /<!\[if\s+!supportLists\]>/, /<!\[endif\]>/, (inner) => `<ormarker>${inner}</ormarker>`);
  src = replaceSections(src, /<!\[if\s+!?[^\]<>]{0,200}\]>/, /<!\[endif\]>/);
  src = replaceSections(src, /<!--/, /-->/);
  src = replaceSections(src, /<!\[/, /\]>/);
  const root: El = { tag: 'root', attrs: {}, children: [] };
  const stack: El[] = [root];
  // No "<" inside an unquoted part of a tag: `<a<a<a…` without ">" was rescanned from every "<" (quadratic).
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  const top = () => stack[stack.length - 1]!;
  const closeTo = (names: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (names.includes(stack[i]!.tag)) {
        stack.length = i;
        return;
      }
      if (['table', 'ul', 'ol'].includes(stack[i]!.tag)) return;
    }
  };
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      top().children.push(decode(m[4]));
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[3] ?? ''))) attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    if (tag === 'p' || tag === 'li') closeTo([tag]);
    if (tag === 'td' || tag === 'th') closeTo(['td', 'th']);
    if (tag === 'tr') closeTo(['tr']);
    const el: El = { tag, attrs, children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !(m[0] ?? '').endsWith('/>') && stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

const text = (n: Node): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
const style = (e: El) => (e.attrs.style ?? '').toLowerCase().replace(/\s+/g, '');

/** Level and kind of a Word list paragraph, or null. */
function listInfo(e: El): { level: number; ordered: boolean } | null {
  const mso = /mso-list:[^;]{0,200}?level(\d+)/.exec(e.attrs.style ?? '');
  const isListClass = /MsoListParagraph/i.test(e.attrs.class ?? '');
  if (!mso && !isListClass) return null;
  const level = mso ? Math.max(1, Math.min(8, +mso[1]!)) : 1;
  const mk = e.children.find((c): c is El => typeof c !== 'string' && c.tag === 'ormarker');
  const marker = (mk ? text(mk) : text(e)).replace(/[\s\u00a0]+/g, ' ').trimStart().slice(0, 8);
  const ordered = /^(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]/.test(marker);
  return { level, ordered };
}

function stripListMarker(html: string, ordered: boolean): string {
  return html.replace(ordered ? /^(?:\s|&nbsp;|\u00a0)*(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)](?:\s|&nbsp;|\u00a0)+/ : /^(?:\s|&nbsp;|\u00a0)*[·•o§Ø\-–—▪■□](?:\s|&nbsp;|\u00a0)+/, '');
}

function inline(nodes: Node[]): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += esc(n.replace(/[\r\n]+\s*/g, ' '));
      continue;
    }
    if (DROP.has(n.tag) || n.tag.includes(':')) {
      // <o:p>…</o:p>: keep nothing but its text when it is not only spacing.
      if (n.tag.startsWith('o:')) out += inline(n.children);
      continue;
    }
    const inner = inline(n.children);
    const st = `;${style(n)}`;
    let html = inner;
    if (n.tag === 'br') {
      out += '<br>';
      continue;
    }
    if (n.tag === 'a') {
      const href = n.attrs.href ?? '';
      html = /^(https?:|mailto:|tel:)/i.test(href.trim()) ? `<a href="${esc(href.trim()).replace(/"/g, '&quot;')}">${inner}</a>` : inner;
    }
    if (n.tag === 'b' || n.tag === 'strong' || /;font-weight:(bold|[6-9]00)/.test(st)) html = `<strong>${html}</strong>`;
    if (n.tag === 'i' || n.tag === 'em' || /;font-style:italic/.test(st)) html = `<em>${html}</em>`;
    if (n.tag === 'u' || /;text-decoration:[^;]*underline/.test(st)) html = `<u>${html}</u>`;
    if (n.tag === 's' || n.tag === 'strike' || n.tag === 'del' || /;text-decoration:[^;]*line-through/.test(st)) html = `<s>${html}</s>`;
    out += html;
  }
  return out;
}

const emptyText = (html: string) => html.replace(/<br>|&nbsp;|\u00a0|\s/g, '') === '';

function headingLevel(e: El): number | null {
  const h = /^h([1-6])$/.exec(e.tag);
  if (h) return Math.min(4, +h[1]!);
  const c = /^(?:Mso)?(?:Heading|Titre)\s*([1-9])$/i.exec((e.attrs.class ?? '').trim()) ?? /^Mso(Heading|Title)([1-9])?$/i.exec((e.attrs.class ?? '').trim());
  if (c) return Math.min(4, +(c[2] ?? c[1]!) || 1);
  if (/^MsoTitle$/i.test(e.attrs.class ?? '')) return 1;
  return null;
}

function table(e: El): string {
  const rows: string[] = [];
  const walk = (n: El) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (c.tag === 'tr') {
        const cells = c.children
          .filter((x): x is El => typeof x !== 'string' && (x.tag === 'td' || x.tag === 'th'))
          .map((cell) => {
            const parts = cell.children
              .map((x) => (typeof x === 'string' ? esc(x.replace(/\s+/g, ' ')) : inline([x])))
              .map((x) => x.trim())
              .filter((x) => !emptyText(x));
            const span = (k: string) => (/^[2-9]$|^\d{2}$/.test(cell.attrs[k] ?? '') ? ` ${k}="${cell.attrs[k]}"` : '');
            return `<${cell.tag}${span('colspan')}${span('rowspan')}>${parts.join('<br>')}</${cell.tag}>`;
          });
        if (cells.length) rows.push(`<tr>${cells.join('')}</tr>`);
      } else walk(c);
    }
  };
  walk(e);
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : '';
}

function blocks(nodes: Node[], out: string[]): void {
  let list: { level: number; ordered: boolean; html: string }[] = [];
  const flushList = () => {
    if (!list.length) return;
    let html = '';
    const open: Array<{ ordered: boolean; level: number }> = [];
    for (const item of list) {
      while (open.length && open[open.length - 1]!.level > item.level) html += `</li></${open.pop()!.ordered ? 'ol' : 'ul'}>`;
      const same = open.length > 0 && open[open.length - 1]!.level === item.level;
      if (same && open[open.length - 1]!.ordered !== item.ordered) {
        html += `</li></${open.pop()!.ordered ? 'ol' : 'ul'}>`;
        open.push({ ordered: item.ordered, level: item.level });
        html += `<${item.ordered ? 'ol' : 'ul'}>`;
      } else if (same) html += '</li>';
      else {
        open.push({ ordered: item.ordered, level: item.level });
        html += `<${item.ordered ? 'ol' : 'ul'}>`;
      }
      html += `<li>${item.html}`;
    }
    while (open.length) html += `</li></${open.pop()!.ordered ? 'ol' : 'ul'}>`;
    out.push(html);
    list = [];
  };
  let loose = '';
  const flushLoose = () => {
    if (!emptyText(loose)) out.push(`<p>${loose.trim()}</p>`);
    loose = '';
  };
  for (const n of nodes) {
    if (typeof n === 'string') {
      loose += esc(n.replace(/\s+/g, ' '));
      continue;
    }
    if (DROP.has(n.tag) || (n.tag.includes(':') && !n.tag.startsWith('o:'))) continue;
    const info = n.tag === 'p' ? listInfo(n) : null;
    if (info) {
      flushLoose();
      list.push({ ...info, html: stripListMarker(inline(n.children), info.ordered).trim() });
      continue;
    }
    if (n.tag === 'li' && !list.length) {
      flushLoose();
      out.push(`<ul><li>${inline(n.children).trim()}</li></ul>`);
      continue;
    }
    flushList();
    const level = headingLevel(n);
    if (level) {
      flushLoose();
      const html = inline(n.children).trim();
      if (!emptyText(html)) out.push(`<h${level}>${html}</h${level}>`);
    } else if (n.tag === 'p' || n.tag === 'blockquote' || n.tag === 'pre') {
      flushLoose();
      const html = inline(n.children).trim();
      if (!emptyText(html)) out.push(n.tag === 'blockquote' ? `<blockquote><p>${html}</p></blockquote>` : `<p>${html}</p>`);
    } else if (n.tag === 'table') {
      flushLoose();
      const t = table(n);
      if (t) out.push(t);
    } else if (n.tag === 'ul' || n.tag === 'ol') {
      flushLoose();
      const items = n.children.filter((x): x is El => typeof x !== 'string' && x.tag === 'li');
      const nested: string[] = [];
      for (const li of items) nested.push(`<li>${inline(li.children).trim()}</li>`);
      if (nested.length) out.push(`<${n.tag}>${nested.join('')}</${n.tag}>`);
    } else if (['div', 'body', 'html', 'section', 'article', 'span', 'font', 'b', 'strong', 'i', 'em', 'u', 'a', 'o:p'].includes(n.tag) || n.tag.startsWith('o:')) {
      // Containers: their block children are hoisted; pure inline wrappers stay inline.
      const hasBlock = n.children.some((c) => typeof c !== 'string' && /^(p|div|h[1-6]|ul|ol|table|blockquote)$/.test(c.tag));
      if (hasBlock) {
        flushLoose();
        blocks(n.children, out);
      } else loose += inline([n]);
    } else if (n.tag === 'br') {
      loose += '<br>';
    } else {
      loose += inline([n]);
    }
  }
  flushList();
  flushLoose();
}

/** Clean semantic HTML for a clipboard HTML coming from Office; the text content is never lost silently. */
export function cleanOfficeHtml(html: string): string {
  let fragment = html;
  const start = /<!--StartFragment-->/i.exec(html);
  if (start) {
    // Not a lazy regular expression: it rescanned the text from every StartFragment (quadratic).
    const end = /<!--EndFragment-->/gi;
    end.lastIndex = start.index + start[0].length;
    const e = end.exec(html);
    if (e) fragment = html.slice(start.index + start[0].length, e.index);
  }
  const root = parse(fragment);
  const out: string[] = [];
  blocks(root.children, out);
  return out.join('\n');
}

/** Top-level blocks of cleaned HTML grouped by at most `size` (large pastes are inserted by slices). */
export function chunkHtmlBlocks(html: string, size = 150): string[] {
  const parts = html.split(/\n(?=<(?:p|h[1-4]|ul|ol|table|blockquote)[ >])/);
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += size) chunks.push(parts.slice(i, i + size).join('\n'));
  return chunks.filter((c) => c.trim() !== '');
}

export const OFFICE_PASTE_MAX_BLOCKS = 10_000;
export const OFFICE_PASTE_CHUNK = 150;
