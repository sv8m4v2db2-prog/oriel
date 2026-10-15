// HTML element tree → editor blocks (Google Docs HTML export, Confluence, Evernote ENML).
// Nothing is ever kept as markup: only text, a fixed set of styles, links and files survive.
import { EDITOR_TYPES } from '@oriel/shared';
import type { Blk } from '../blocks';
import { findAll, htmlText, type HtmlElement } from './html';
import { IMPORT_LIMITS } from './limits';

export type Styles = Record<string, unknown>;
export interface TextRun {
  type: 'text';
  text: string;
  styles: Styles;
}
export interface LinkRun {
  type: 'link';
  href: string;
  content: TextRun[];
}
export type Inline = TextRun | LinkRun;

/** Image or file dropped out of the inline flow (becomes a block of its own). */
export interface FileMarker {
  type: '__file';
  block: Blk;
}
interface TodoMarker {
  type: '__todo';
  checked: boolean;
}
export type Item = Inline | FileMarker | TodoMarker;

export interface HtmlConvertOptions {
  /**
   * Maps a URL found in the document (`src` or `href`): returns the value to keep (an encoded
   * path of the virtual file system, or an external http(s)/mailto URL) or null to drop it.
   */
  resolveUrl?(raw: string, kind: 'img' | 'link'): string | null;
  /** Inline `data:` image → path of the virtual file created for it, or null. */
  dataImage?(mime: string, base64: string): string | null;
  /** Custom block handler (Confluence macros, Evernote media): return blocks, or null to fall back. */
  block?(el: HtmlElement, convert: (children: Array<HtmlElement | string>) => Blk[]): Blk[] | null;
  /** Custom inline handler; return items, or null to fall back. */
  inline?(el: HtmlElement, styles: Styles, items: (node: HtmlElement | string, styles: Styles) => Item[]): Item[] | null;
  warn?(message: string): void;
}

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
const FILE_EXT = /\.[a-z0-9]{1,6}$/i;

/** CSS class → inline styles, from the first-level `.class { … }` rules of <style> elements. */
export function cssClassStyles(root: HtmlElement): Map<string, Styles> {
  const out = new Map<string, Styles>();
  for (const style of findAll(root, (e) => e.name === 'style')) {
    const css = style.children.filter((c): c is string => typeof c === 'string').join('');
    for (const chunk of css.split('}')) {
      const open = chunk.indexOf('{');
      if (open < 0) continue;
      const selectors = chunk.slice(0, open).split(',');
      const styles = declStyles(chunk.slice(open + 1));
      if (Object.keys(styles).length === 0) continue;
      for (const sel of selectors) {
        const m = /^\s*\.([A-Za-z0-9_-]+)\s*$/.exec(sel);
        if (m) out.set(m[1]!, { ...(out.get(m[1]!) ?? {}), ...styles });
      }
    }
  }
  return out;
}

function declStyles(decl: string): Styles {
  const s: Styles = {};
  for (const part of decl.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim().toLowerCase();
    if (key === 'font-weight' && (val === 'bold' || val === 'bolder' || Number(val) >= 600)) s.bold = true;
    else if (key === 'font-weight' && (val === 'normal' || Number(val) <= 500)) s.bold = false;
    else if (key === 'font-style' && (val === 'italic' || val === 'oblique')) s.italic = true;
    else if (key === 'text-decoration' || key === 'text-decoration-line') {
      if (val.includes('underline')) s.underline = true;
      if (val.includes('line-through')) s.strike = true;
      if (val === 'none') (s.underline = false), (s.strike = false);
    } else if (key === 'font-family' && /(courier|consolas|monaco|menlo|monospace)/.test(val)) s.code = true;
  }
  for (const k of Object.keys(s)) if (s[k] === false) delete s[k];
  return s;
}

const mergeStyles = (a: Styles, b: Styles): Styles => (Object.keys(b).length ? { ...a, ...b } : a);

/** Normalizes runs: merges neighbours with the same styles, drops empty ones. */
export function mergeRuns(items: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const it of items) {
    if (it.type === 'text') {
      if (!it.text) continue;
      const last = out[out.length - 1];
      if (last && last.type === 'text' && JSON.stringify(last.styles) === JSON.stringify(it.styles)) last.text += it.text;
      else out.push({ ...it });
    } else if (it.content.length) out.push(it);
  }
  return out;
}

function trimRuns(items: Inline[]): Inline[] {
  const out = mergeRuns(items);
  const first = out[0];
  if (first && first.type === 'text') first.text = first.text.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.text = last.text.replace(/\s+$/, '');
  else if (last && last.type === 'link') {
    const l = last.content[last.content.length - 1];
    if (l) l.text = l.text.replace(/\s+$/, '');
  }
  return mergeRuns(out);
}

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figure',
  'figcaption', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const SKIP = new Set(['head', 'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'canvas', 'svg', 'form', 'select', 'button', 'link', 'meta', 'title']);

export class HtmlConverter {
  private readonly classStyles: Map<string, Styles>;
  private depth = 0;

  constructor(
    root: HtmlElement,
    private readonly opts: HtmlConvertOptions = {},
  ) {
    this.classStyles = cssClassStyles(root);
  }

  /** Blocks of a list of top-level nodes. */
  convert(children: Array<HtmlElement | string>): Blk[] {
    return this.blocks(children);
  }

  private warn(m: string) {
    this.opts.warn?.(m);
  }

  private elementStyles(el: HtmlElement, styles: Styles): Styles {
    let s = styles;
    const cls = el.attrs.class;
    if (cls) for (const c of cls.split(/\s+/)) s = mergeStyles(s, this.classStyles.get(c) ?? {});
    if (el.attrs.style) s = mergeStyles(s, declStyles(el.attrs.style));
    return s;
  }

  // --- inline -------------------------------------------------------------------------------

  private inlineNode(node: HtmlElement | string, styles: Styles): Item[] {
    if (typeof node === 'string') {
      const text = node.replace(/[\s ]+/g, (m) => (m.includes(' ') && !/\s/.test(m.replace(/ /g, '')) ? ' ' : ' '));
      return text ? [{ type: 'text', text, styles }] : [];
    }
    if (SKIP.has(node.name)) return [];
    const custom = this.opts.inline?.(node, styles, (n, s) => this.inlineNode(n, s));
    if (custom) return custom;
    const own = this.elementStyles(node, styles);
    const kids = (s: Styles): Item[] => node.children.flatMap((c) => this.inlineNode(c, s));
    switch (node.name) {
      case 'br':
        return [{ type: 'text', text: '\n', styles }];
      case 'b':
      case 'strong':
        return kids({ ...own, bold: true });
      case 'i':
      case 'em':
      case 'cite':
      case 'dfn':
        return kids({ ...own, italic: true });
      case 'u':
      case 'ins':
        return kids({ ...own, underline: true });
      case 's':
      case 'strike':
      case 'del':
        return kids({ ...own, strike: true });
      case 'code':
      case 'tt':
      case 'kbd':
      case 'samp':
        return kids({ ...own, code: true });
      case 'a': {
        const href = node.attrs.href ?? '';
        const target = href ? this.safeUrl(href, 'link') : null;
        const inner = kids(own);
        if (!target) return inner;
        const runs = inner.filter((i): i is TextRun => i.type === 'text');
        const others = inner.filter((i) => i.type !== 'text' && i.type !== 'link');
        const link: LinkRun = { type: 'link', href: target, content: runs.length ? runs : [{ type: 'text', text: href, styles: {} }] };
        return [link, ...others];
      }
      case 'img': {
        const block = this.imageBlock(node);
        return block ? [{ type: '__file', block }] : [];
      }
      case 'input': {
        if ((node.attrs.type ?? '').toLowerCase() === 'checkbox') return [{ type: '__todo', checked: 'checked' in node.attrs }];
        return [];
      }
      case 'sup':
      case 'sub':
        return kids(own);
      default:
        if (BLOCKS.has(node.name)) return kids(own);
        return kids(own);
    }
  }

  private safeUrl(raw: string, kind: 'img' | 'link'): string | null {
    const u = raw.trim();
    if (!u || u.startsWith('#')) return null;
    if (this.opts.resolveUrl) return this.opts.resolveUrl(u, kind);
    return SAFE_SCHEME.test(u) ? u : null;
  }

  private imageBlock(el: HtmlElement): Blk | null {
    const src = (el.attrs.src ?? '').trim();
    if (!src) return null;
    const alt = (el.attrs.alt ?? el.attrs.title ?? '').trim();
    let url: string | null = null;
    const data = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.length > 12_000_000 ? '' : src);
    if (data) url = this.opts.dataImage?.(data[1]!.toLowerCase(), data[2]!.replace(/\s+/g, '')) ?? null;
    else if (!/^data:/i.test(src)) url = this.safeUrl(src, 'img');
    if (!url) {
      this.warn(`Image non importée : ${src.slice(0, 80)}`);
      return null;
    }
    const props: Record<string, unknown> = { url, name: alt || fileNameOf(src) };
    if (alt) props.caption = alt;
    return { type: 'image', props };
  }

  // --- blocks -------------------------------------------------------------------------------

  /** Inline items → paragraph / checklist item / image blocks. */
  private flush(items: Item[], type: 'paragraph' | 'quote' = 'paragraph'): Blk[] {
    const out: Blk[] = [];
    let run: Inline[] = [];
    let todo: boolean | null = null;
    const emit = () => {
      const content = trimRuns(run);
      run = [];
      if (content.length === 0) {
        todo = null;
        return;
      }
      if (todo !== null) out.push({ type: 'checkListItem', props: { checked: todo }, content, children: [] });
      else out.push({ type, content, children: [] });
      todo = null;
    };
    for (const it of items) {
      if (it.type === '__file') {
        emit();
        out.push(it.block);
      } else if (it.type === '__todo') {
        emit();
        todo = it.checked;
      } else if (it.type === 'text' && it.text === '\n' && type === 'paragraph' && run.length === 0) {
        // leading line break: ignored
      } else run.push(it);
    }
    emit();
    return out;
  }

  private blocks(children: Array<HtmlElement | string>): Blk[] {
    if (++this.depth > IMPORT_LIMITS.maxDepth) {
      this.depth--;
      return [];
    }
    const out: Blk[] = [];
    let buffer: Item[] = [];
    const flushBuffer = () => {
      if (buffer.length) out.push(...this.flush(buffer));
      buffer = [];
    };
    let listPath: Blk[] = [];
    for (const node of children) {
      if (typeof node === 'string' || !isBlockElement(node)) {
        if (typeof node !== 'string' && SKIP.has(node.name)) continue;
        buffer.push(...this.inlineNode(node, {}));
        continue;
      }
      flushBuffer();
      if (SKIP.has(node.name) && node.name !== 'form') continue;
      const custom = this.opts.block?.(node, (c) => this.blocks(c));
      if (custom) {
        out.push(...custom);
        listPath = [];
        continue;
      }
      if (node.name === 'ul' || node.name === 'ol') {
        const level = listLevelOf(node);
        const items = this.listItems(node);
        for (const item of items) {
          const parent = level > 0 ? listPath[level - 1] : undefined;
          if (parent) (parent.children ??= []).push(item);
          else out.push(item);
          listPath.length = level;
          listPath[level] = item;
        }
        continue;
      }
      listPath = [];
      out.push(...this.block(node));
    }
    flushBuffer();
    this.depth--;
    return out;
  }

  private listItems(list: HtmlElement): Blk[] {
    const ordered = list.name === 'ol';
    const out: Blk[] = [];
    for (const li of list.children) {
      if (typeof li === 'string' || (li.name !== 'li' && !isBlockElement(li))) continue;
      if (li.name !== 'li') {
        out.push(...this.block(li));
        continue;
      }
      const inner = this.blocks(li.children);
      const checked = /(^|\s)(checked|complete|task-complete)(\s|$)/.test(li.attrs.class ?? '') ? true : null;
      const isTask = /(task|checkbox)/.test(list.attrs.class ?? '') || /(^|\s)(unchecked|incomplete|task-incomplete)(\s|$)/.test(li.attrs.class ?? '') || checked !== null;
      const first = inner[0];
      let item: Blk;
      const content = first && (first.type === 'paragraph' || first.type === 'checkListItem') ? first.content : [];
      const rest = first && (first.type === 'paragraph' || first.type === 'checkListItem') ? inner.slice(1) : inner;
      if (first?.type === 'checkListItem') item = { type: 'checkListItem', props: { checked: !!first.props?.checked }, content, children: rest };
      else if (isTask && li.attrs.class !== undefined) item = { type: 'checkListItem', props: { checked: checked === true }, content, children: rest };
      else item = { type: ordered ? 'numberedListItem' : 'bulletListItem', content, children: rest };
      out.push(item);
    }
    return out;
  }

  private block(el: HtmlElement): Blk[] {
    switch (el.name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Math.min(4, Number(el.name[1]));
        const content = trimRuns(this.inlineOnly(el, this.elementStyles(el, {})));
        return content.length ? [{ type: 'heading', props: { level }, content, children: [] }] : [];
      }
      case 'hr':
        return [{ type: 'divider' }];
      case 'pre': {
        const text = htmlText(el).replace(/\n+$/, '');
        if (!text.trim()) return [];
        return [{ type: 'codeBlock', props: { language: languageOf(el) }, content: [{ type: 'text', text: text.slice(0, IMPORT_LIMITS.maxCellChars), styles: {} }], children: [] }];
      }
      case 'blockquote': {
        const inner = this.blocks(el.children);
        const first = inner[0];
        if (first && first.type === 'paragraph') return [{ type: 'quote', content: first.content, children: inner.slice(1) }];
        return inner.length ? [{ type: 'quote', content: [], children: inner }] : [];
      }
      case 'table':
        return this.table(el);
      case 'details': {
        const summary = el.children.find((c): c is HtmlElement => typeof c !== 'string' && c.name === 'summary');
        const body = el.children.filter((c) => c !== summary);
        const content = summary ? trimRuns(this.inlineOnly(summary, {})) : [{ type: 'text' as const, text: 'Détails', styles: {} }];
        return [{ type: 'toggleListItem', content, children: this.blocks(body) }];
      }
      case 'li':
      case 'dd':
      case 'dt':
      case 'summary':
        return this.blocks(el.children);
      case 'p': {
        const items = el.children.flatMap((c) => this.inlineNode(c, this.elementStyles(el, {})));
        return this.flush(items);
      }
      default:
        // div, section, article, figure, center, body… containers.
        return this.blocks(el.children);
    }
  }

  private inlineOnly(el: HtmlElement, styles: Styles): Inline[] {
    const items = el.children.flatMap((c) => this.inlineNode(c, styles));
    return items.filter((i): i is Inline => i.type === 'text' || i.type === 'link');
  }

  private table(el: HtmlElement): Blk[] {
    const rows = findAll(el, (e) => e.name === 'tr' && nearestTable(el, e) === el);
    if (rows.length === 0) return [];
    const matrix: Inline[][][] = [];
    let width = 0;
    let headerRows = 0;
    rows.forEach((tr, ri) => {
      const cells: Inline[][] = [];
      let allTh = true;
      for (const c of tr.children) {
        if (typeof c === 'string' || (c.name !== 'td' && c.name !== 'th')) continue;
        if (c.name !== 'th') allTh = false;
        const inner = this.blocks(c.children);
        const runs: Inline[] = [];
        for (const b of inner) {
          if (runs.length) runs.push({ type: 'text', text: '\n', styles: {} });
          runs.push(...blockText(b));
        }
        cells.push(mergeRuns(runs));
        const span = Math.min(8, Math.max(1, Number(c.attrs.colspan) || 1));
        for (let k = 1; k < span; k++) cells.push([]);
      }
      if (cells.length === 0) return;
      if (ri === headerRows && allTh) headerRows++;
      width = Math.max(width, cells.length);
      matrix.push(cells);
    });
    if (matrix.length === 0 || width === 0) return [];
    const tableRows = matrix.slice(0, 500).map((cells) => {
      const padded = [...cells.slice(0, 50)];
      while (padded.length < Math.min(width, 50)) padded.push([]);
      return { cells: padded };
    });
    const content: Record<string, unknown> = { type: 'tableContent', rows: tableRows };
    if (headerRows > 0) content.headerRows = 1;
    return [{ type: 'table', content, children: [] }];
  }
}

/** Table that owns the row (rows of nested tables belong to the nested table). */
function nearestTable(root: HtmlElement, tr: HtmlElement): HtmlElement | null {
  const walk = (e: HtmlElement, owner: HtmlElement): HtmlElement | null => {
    for (const c of e.children) {
      if (typeof c === 'string') continue;
      if (c === tr) return owner;
      const r = walk(c, c.name === 'table' ? c : owner);
      if (r) return r;
    }
    return null;
  };
  return walk(root, root);
}

function blockText(b: Blk): Inline[] {
  const out: Inline[] = [];
  const own = Array.isArray(b.content) ? (b.content as Inline[]) : [];
  const prefix = b.type === 'bulletListItem' ? '• ' : b.type === 'checkListItem' ? (b.props?.checked ? '☑ ' : '☐ ') : '';
  if (prefix) out.push({ type: 'text', text: prefix, styles: {} });
  out.push(...own);
  for (const c of b.children ?? []) {
    out.push({ type: 'text', text: '\n', styles: {} });
    out.push(...blockText(c));
  }
  if (b.type === 'image' || b.type === 'file') {
    out.push({ type: 'text', text: `[${String(b.props?.name ?? 'image')}]`, styles: {} });
  }
  return out;
}

function isBlockElement(el: HtmlElement): boolean {
  return BLOCKS.has(el.name);
}

function listLevelOf(el: HtmlElement): number {
  const m = /(?:^|\s)lst-[A-Za-z0-9_]+-(\d{1,2})(?:\s|$)/.exec(el.attrs.class ?? '');
  return m ? Math.min(8, Number(m[1])) : 0;
}

function languageOf(pre: HtmlElement): string {
  const params = pre.attrs['data-syntaxhighlighter-params'] ?? '';
  const brush = /brush:\s*([a-z0-9+#-]+)/i.exec(params);
  if (brush) return brush[1]!;
  const cls = pre.attrs.class ?? '';
  const lang = /(?:language|lang)-([a-z0-9+#-]+)/i.exec(cls);
  if (lang) return lang[1]!;
  for (const c of pre.children) {
    if (typeof c !== 'string' && c.name === 'code') {
      const m = /(?:language|lang)-([a-z0-9+#-]+)/i.exec(c.attrs.class ?? '');
      if (m) return m[1]!;
    }
  }
  return 'text';
}

function fileNameOf(url: string): string {
  const clean = url.replace(/[?#].*$/, '');
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  try {
    const d = decodeURIComponent(last);
    return FILE_EXT.test(d) ? d : 'image';
  } catch {
    return 'image';
  }
}

/** Callout block from an emoji and the blocks it holds. */
export function calloutBlock(emoji: string, inner: Blk[]): Blk {
  const first = inner[0];
  if (first && (first.type === 'paragraph' || first.type === 'quote') && Array.isArray(first.content)) {
    return { type: EDITOR_TYPES.callout, props: { emoji }, content: first.content, children: inner.slice(1) };
  }
  return { type: EDITOR_TYPES.callout, props: { emoji }, content: [], children: inner };
}
