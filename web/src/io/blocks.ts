// Content conversions (browser): Markdown ⇄ editor blocks ⇄ Yjs, with a headless BlockNote editor
// built on the app schema. Custom Oriel blocks are mapped to/from plain Markdown constructs.
import { BlockNoteEditor } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { blocksToYDoc, yDocToBlocks } from '@blocknote/core/yjs';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, EDITOR_BLOCK_TYPES, EDITOR_TYPES, isSyncedId } from '@oriel/shared';
import { schema, type OrielEditor } from '../editor/schema';
import { encodeMathBlocks, parseMarkdownWithMath } from '../editor/mathMarkdown';
import { encodeFootnoteBlocks } from '../editor/footnoteMarkdown';
import { flattenAdvancedBlocks } from '../editor/advancedMarkdown';
import { drawingSvg } from '../editor/drawingLogic';
import { segmentMarkdown, sameTitle } from './markdown';
import { leadingEmoji } from './text';

/** Loose view of BlockNote blocks (custom block types included). */
export interface Blk {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Blk[];
}
type Styles = Record<string, unknown>;
interface TextItem {
  type: 'text';
  text: string;
  styles: Styles;
}
interface LinkItem {
  type: 'link';
  href: string;
  content: TextItem[];
}
type InlineItem = TextItem | LinkItem | { type: string; props?: Record<string, unknown>; content?: unknown };

let editor: OrielEditor | null = null;
export function headlessEditor(): OrielEditor {
  editor ??= BlockNoteEditor.create({ schema }) as unknown as OrielEditor;
  return editor;
}

const DEFAULT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'quote',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'toggleListItem',
  'codeBlock',
  'table',
  'image',
  'video',
  'audio',
  'file',
  'divider',
]);
const FILE_BLOCKS = new Set(['image', 'video', 'audio', 'file']);

const text = (t: string, styles: Styles = {}): TextItem => ({ type: 'text', text: t, styles });
const isArray = Array.isArray;

function inlineText(content: unknown): string {
  if (!isArray(content)) return '';
  return (content as InlineItem[])
    .map((c) => {
      if (c.type === 'text') return (c as TextItem).text;
      if (c.type === 'link') return inlineText((c as LinkItem).content);
      const props = (c as { props?: Record<string, unknown> }).props ?? {};
      for (const k of ['title', 'name', 'label', 'text', 'date', 'value', 'email']) {
        if (typeof props[k] === 'string' && props[k]) return String(props[k]);
      }
      return '';
    })
    .join('');
}

// ===========================================================================
// Import: Markdown → blocks → Yjs
// ===========================================================================

export type ResolvedLink =
  | { kind: 'page'; id: string; title: string; isChild: boolean }
  | { kind: 'database'; id: string; title: string; isChild: boolean; inline: boolean }
  | { kind: 'file'; url: string; name: string; mime: string }
  | { kind: 'external'; url: string }
  | { kind: 'missing' };

export interface ImportContext {
  workspaceId: string;
  /** Resolves a link/image destination written in the current document (uploads attachments). */
  resolve(href: string): Promise<ResolvedLink>;
  /** Children already rendered as a sub-page card / inline database (one card per child). */
  placed: Set<string>;
}

const appHref = (workspaceId: string, pageId: string) => `/w/${workspaceId}/p/${pageId}`;

function fileBlockFor(r: { url: string; name: string; mime: string }, caption?: string): Blk {
  const type = r.mime.startsWith('image/') ? 'image' : r.mime.startsWith('video/') ? 'video' : r.mime.startsWith('audio/') ? 'audio' : 'file';
  const props: Record<string, unknown> = { url: r.url, name: r.name };
  if (caption && caption !== r.name && type !== 'file') props.caption = caption;
  return { type, props };
}

async function importInline(content: unknown, ctx: ImportContext): Promise<unknown> {
  if (!isArray(content)) return content;
  const out: InlineItem[] = [];
  for (const item of content as InlineItem[]) {
    if (item.type !== 'link') {
      out.push(item);
      continue;
    }
    const link = item as LinkItem;
    const r = await ctx.resolve(link.href);
    const label = inlineText(link.content);
    if (r.kind === 'page' || r.kind === 'database') {
      if (!label || sameTitle(label, r.title) || /\.(md|csv)$/i.test(label)) out.push({ type: EDITOR_TYPES.pageMention, props: { pageId: r.id } });
      else out.push({ type: 'link', href: appHref(ctx.workspaceId, r.id), content: link.content });
    } else if (r.kind === 'file') out.push({ type: 'link', href: r.url, content: link.content });
    else if (r.kind === 'external') out.push({ ...link, href: r.url });
    else out.push(...(link.content.length ? link.content : [text(link.href)]));
  }
  return out;
}

async function importTable(content: unknown, ctx: ImportContext): Promise<unknown> {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !isArray(table.rows)) return content;
  for (const row of table.rows) {
    row.cells = await Promise.all(
      row.cells.map(async (cell) => {
        if (isArray(cell)) return importInline(cell, ctx);
        const c = cell as { content?: unknown };
        if (c && isArray(c.content)) return { ...c, content: await importInline(c.content, ctx) };
        return cell;
      }),
    );
  }
  return table;
}

/** Single link of a paragraph (whitespace around it allowed). */
function soleLink(content: unknown): LinkItem | null {
  if (!isArray(content)) return null;
  const items = (content as InlineItem[]).filter((c) => !(c.type === 'text' && !(c as TextItem).text.trim()));
  return items.length === 1 && items[0]!.type === 'link' ? (items[0] as LinkItem) : null;
}

async function importBlock(block: Blk, ctx: ImportContext): Promise<Blk[]> {
  const children = block.children?.length ? await importBlocks(block.children, ctx) : [];
  if (FILE_BLOCKS.has(block.type)) {
    const url = String(block.props?.url ?? '');
    if (!url) return [];
    const r = await ctx.resolve(url);
    const caption = typeof block.props?.caption === 'string' ? block.props.caption : '';
    const name = typeof block.props?.name === 'string' ? block.props.name : '';
    if (r.kind === 'file') {
      const b = fileBlockFor(r, caption || name);
      if (block.type === 'image' && r.mime.startsWith('image/')) b.type = 'image';
      return [{ ...b, children }];
    }
    if (r.kind === 'external') return [{ ...block, props: { ...block.props, url: r.url }, children }];
    return [{ type: 'paragraph', content: [text(`📎 ${name || caption || url} (fichier introuvable dans l’archive)`, { italic: true })], children }];
  }
  if (block.type === 'paragraph') {
    const link = soleLink(block.content);
    if (link) {
      const r = await ctx.resolve(link.href);
      if (r.kind === 'page') {
        const asCard = r.isChild && !ctx.placed.has(r.id);
        if (asCard) ctx.placed.add(r.id);
        return [{ type: asCard ? EDITOR_TYPES.subpage : EDITOR_TYPES.pageLink, props: { pageId: r.id } }, ...children];
      }
      if (r.kind === 'database') {
        // Child database: inline table, or a card like a sub-page when it is a full page.
        const first = r.isChild && !ctx.placed.has(r.id);
        if (first) ctx.placed.add(r.id);
        if (first && r.inline) return [{ type: EDITOR_TYPES.database, props: { databaseId: r.id } }, ...children];
        return [{ type: first ? EDITOR_TYPES.subpage : EDITOR_TYPES.pageLink, props: { pageId: r.id } }, ...children];
      }
      if (r.kind === 'file') return [{ ...fileBlockFor(r, inlineText(link.content)), children }];
    }
  }
  const out: Blk = { ...block, children };
  if (block.type === 'table') out.content = await importTable(block.content, ctx);
  else if (isArray(block.content)) out.content = await importInline(block.content, ctx);
  // "> 💡 Texte" (our own export of callouts) → callout.
  if (block.type === 'quote' && isArray(out.content)) {
    const items = out.content as InlineItem[];
    const first = items[0];
    const emoji = first?.type === 'text' ? leadingEmoji((first as TextItem).text) : null;
    if (emoji && first) {
      const rest = (first as TextItem).text.trimStart().slice(emoji.length).replace(/^\s+/, '');
      const content = rest ? [{ ...(first as TextItem), text: rest }, ...items.slice(1)] : items.slice(1);
      return [{ type: EDITOR_TYPES.callout, props: { emoji }, content, children }];
    }
  }
  return [out];
}

async function importBlocks(blocks: Blk[], ctx: ImportContext): Promise<Blk[]> {
  const out: Blk[] = [];
  for (const b of blocks) out.push(...(await importBlock(b, ctx)));
  return out;
}

/** Pre-built blocks (file importers): links and file URLs resolved through the import context. */
export const resolveBlocks = (blocks: Blk[], ctx: ImportContext): Promise<Blk[]> => importBlocks(blocks, ctx);

function parseMd(md: string): Blk[] {
  if (!md.trim()) return [];
  // `$$…$$` / `$…$` → equations, their TeX kept out of the Markdown parser (mathMarkdown.ts).
  return parseMarkdownWithMath(md, (m) => headlessEditor().tryParseMarkdownToBlocks(m) as unknown as Blk[]);
}

/** Markdown (title and property lines already removed) → blocks, links resolved. */
export async function markdownToBlocks(md: string, ctx: ImportContext): Promise<Blk[]> {
  const out: Blk[] = [];
  for (const seg of segmentMarkdown(md)) {
    if (seg.type === 'markdown') out.push(...(await importBlocks(parseMd(seg.text), ctx)));
    else if (seg.type === 'callout') {
      const inner = await importBlocks(parseMd(seg.text), ctx);
      const first = inner[0];
      const content = first && isArray(first.content) && first.type === 'paragraph' ? first.content : [];
      const rest = first && first.type === 'paragraph' ? inner.slice(1) : inner;
      out.push({ type: EDITOR_TYPES.callout, props: { emoji: seg.emoji }, content, children: [...(first?.children ?? []), ...rest] });
    } else {
      const summary = parseMd(seg.summary)[0];
      const content = summary && isArray(summary.content) ? await importInline(summary.content, ctx) : [text(seg.summary)];
      const children = await importBlocks(parseMd(seg.text), ctx);
      if (seg.level) out.push({ type: 'heading', props: { level: seg.level, isToggleable: true }, content, children });
      else out.push({ type: 'toggleListItem', content, children });
    }
  }
  return out;
}

/** Code block languages accepted by the editor (keys of the schema's supported languages), by alias. */
let languageAliases: Map<string, string> | null = null;
function codeLanguage(raw: unknown): string {
  if (!languageAliases) {
    languageAliases = new Map([['text', 'text'], ['txt', 'text'], ['plain', 'text'], ['texte', 'text']]);
    const supported = (codeBlockOptions.supportedLanguages ?? {}) as Record<string, { aliases?: string[] }>;
    for (const [key, lang] of Object.entries(supported)) {
      languageAliases.set(key.toLowerCase(), key);
      for (const alias of lang.aliases ?? []) languageAliases.set(alias.toLowerCase(), key);
    }
  }
  return languageAliases.get(String(raw ?? '').trim().toLowerCase()) ?? 'text';
}

function sanitizeForSchema(blocks: Blk[]): Blk[] {
  return blocks.map((b) => {
    const out: Blk = { ...b, children: b.children ? sanitizeForSchema(b.children) : [] };
    delete out.id;
    if (b.type === 'codeBlock') out.props = { ...b.props, language: codeLanguage(b.props?.language) };
    return out;
  });
}

function plainBlocks(blocks: Blk[]): Blk[] {
  const out: Blk[] = [];
  const walk = (list: Blk[]) => {
    for (const b of list) {
      const t = b.type === 'table' ? '' : inlineText(b.content);
      if (t) out.push({ type: 'paragraph', content: [text(t)] });
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** Blocks → standalone Yjs update (bytes) of the `blocknote` fragment. */
export function blocksToUpdate(blocks: Blk[]): { update: Uint8Array; degraded: boolean } {
  const ed = headlessEditor();
  const encode = (list: Blk[]) => {
    const doc = blocksToYDoc(ed, list as never, COLLAB_FRAGMENT);
    try {
      return Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
  };
  try {
    return { update: encode(sanitizeForSchema(blocks)), degraded: false };
  } catch (e) {
    console.warn('[Oriel] import: blocs non convertibles, repli en texte brut', e);
    return { update: encode(plainBlocks(blocks)), degraded: true };
  }
}

// ===========================================================================
// Export: Yjs → blocks → Markdown
// ===========================================================================

export interface ExportContext {
  /** Relative link to the exported file of a page/row/database, with its title; null if not exported. */
  pageLink(pageId: string): { href: string; title: string } | null;
  /** Absolute link into the app (pages outside the export). */
  appLink(pageId: string): string;
  /** Rewrites an uploaded file URL to its path in the archive (registers the download). */
  fileHref(url: string): string;
  /** « A / B / Page » path of the exported page (breadcrumb blocks). */
  breadcrumb?(): string;
  /**
   * Blocks of a synced block shown by the page (fetched beforehand through the page, see
   * syncedIdsInUpdate), or null when unavailable (another workspace, owner page not visible).
   */
  syncedBlocks?(syncedId: string): Blk[] | null;
}

export { syncedIdsInUpdate } from '../editor/syncedLogic';

/** Yjs state of a synced block → its blocks (export). */
export function updateToBlocks(update: Uint8Array): Blk[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return yDocToBlocks(headlessEditor(), doc, COLLAB_FRAGMENT) as unknown as Blk[];
  } finally {
    doc.destroy();
  }
}

const APP_LINK = /^(?:https?:\/\/[^/]+)?\/w\/[^/]+\/p\/([^/?#]+)/;

function linkTo(pageId: string, ctx: ExportContext, label?: string): LinkItem {
  const target = ctx.pageLink(pageId);
  const title = label || target?.title || 'Sans titre';
  return { type: 'link', href: target?.href ?? ctx.appLink(pageId), content: [text(title)] };
}

function exportInline(content: unknown, ctx: ExportContext): InlineItem[] {
  if (!isArray(content)) return [];
  const out: InlineItem[] = [];
  for (const item of content as InlineItem[]) {
    if (item.type === 'text') out.push(item);
    else if (item.type === 'link') {
      const link = item as LinkItem;
      const app = APP_LINK.exec(link.href);
      if (app) out.push({ ...link, href: ctx.pageLink(app[1]!)?.href ?? link.href });
      else if (link.href.startsWith('/api/files/')) out.push({ ...link, href: ctx.fileHref(link.href) });
      else out.push(link);
    } else if (item.type === EDITOR_BLOCK_TYPES.inlineEquation || item.type === EDITOR_BLOCK_TYPES.footnote) {
      out.push(item); // `$…$` / `[^n]` (updateToMarkdown)
    } else if (item.type === EDITOR_TYPES.pageMention) {
      const pageId = String((item as { props?: { pageId?: unknown } }).props?.pageId ?? '');
      if (pageId) out.push(linkTo(pageId, ctx));
    } else {
      const t = inlineText([item]);
      if (t) out.push(text(t));
    }
  }
  return out;
}

function exportTable(content: unknown, ctx: ExportContext): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (isArray(cell)) return exportInline(cell, ctx);
        const c = cell as { content?: unknown };
        return c && isArray(c.content) ? { ...c, content: exportInline(c.content, ctx) } : cell;
      }),
    })),
  };
}

const TOGGLE_MARK = '__oriel_toggle';

/** Heading level from the shared document (any value): 1–4, like the editor schema (QA-WEB-08). */
export function headingLevel(raw: unknown): 1 | 2 | 3 | 4 {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*[1-4]\s*$/.test(raw) ? Number(raw) : NaN;
  return n === 2 || n === 3 || n === 4 ? n : 1;
}

function exportBlock(b: Blk, ctx: ExportContext, dropped: Set<string>, top: boolean): Blk[] {
  const children = b.children?.length ? exportBlocks(b.children, ctx, dropped, false) : [];
  const props = b.props ?? {};
  switch (b.type) {
    case EDITOR_TYPES.subpage:
    case EDITOR_TYPES.pageLink: {
      const pageId = String(props.pageId ?? '');
      return pageId ? [{ type: 'paragraph', content: [linkTo(pageId, ctx)] }, ...children] : children;
    }
    case EDITOR_TYPES.database: {
      const id = String(props.databaseId ?? '');
      return id ? [{ type: 'paragraph', content: [linkTo(id, ctx)] }, ...children] : children;
    }
    case EDITOR_TYPES.callout: {
      const emoji = String(props.emoji || '💡');
      return [{ type: 'quote', content: [text(`${emoji} `), ...exportInline(b.content, ctx)], children }];
    }
    case EDITOR_TYPES.toc:
      return children;
    case EDITOR_BLOCK_TYPES.equation:
      return [{ type: b.type, props: { tex: typeof props.tex === 'string' ? props.tex : '' } }, ...children]; // `$$…$$` (updateToMarkdown)
    case EDITOR_BLOCK_TYPES.tabs:
    case EDITOR_BLOCK_TYPES.tab:
    case EDITOR_BLOCK_TYPES.breadcrumb:
    case EDITOR_BLOCK_TYPES.button:
      // Each tab → a heading and its content; breadcrumb → its path; button → left out.
      return exportBlocks(flattenAdvancedBlocks([b], { breadcrumb: () => ctx.breadcrumb?.() ?? '', dropped }), ctx, dropped, top);
    case EDITOR_BLOCK_TYPES.syncedBlock: {
      // The content of the block, inline (it is not a page of the export). Synced blocks do not nest.
      const id = String(props.syncedId ?? '');
      const blocks = isSyncedId(id) ? (ctx.syncedBlocks?.(id) ?? null) : null;
      if (!blocks) {
        dropped.add('bloc synchronisé inaccessible');
        return children;
      }
      const inner = blocks.filter((x) => x.type !== EDITOR_BLOCK_TYPES.syncedBlock);
      return [...exportBlocks(inner, ctx, dropped, top), ...children];
    }
    case EDITOR_BLOCK_TYPES.drawing: {
      // Sketch: an SVG image (data address, bounded: drawingLogic.ts) on a white background.
      const svg = drawingSvg(props.strokes, '#ffffff');
      return [{ type: 'image', props: { url: `data:image/svg+xml;base64,${btoa(svg)}`, name: 'Dessin' }, children }];
    }
    case EDITOR_BLOCK_TYPES.html:
      // The source as a code sample (never live HTML in the Markdown).
      return [{ type: 'codeBlock', props: { language: 'html' }, content: [text(typeof props.html === 'string' ? props.html : '')] }, ...children];
    case 'columnList':
    case 'column':
      return children;
    case 'toggleListItem':
      // Top-level toggles become <details> sections; nested ones a bulleted list.
      if (top) return [{ type: TOGGLE_MARK, content: exportInline(b.content, ctx), children }];
      return [{ type: 'bulletListItem', props: {}, content: exportInline(b.content, ctx), children }];
    case 'heading': {
      const level = headingLevel(props.level);
      if (top && props.isToggleable) return [{ type: TOGGLE_MARK, props: { level }, content: exportInline(b.content, ctx), children }];
      return [{ ...b, props: { ...props, level, isToggleable: false }, content: exportInline(b.content, ctx), children: [] }, ...children];
    }
  }
  if (FILE_BLOCKS.has(b.type)) {
    const url = String(props.url ?? '');
    return [{ ...b, props: { ...props, url: url ? ctx.fileHref(url) : url }, children }];
  }
  if (b.type === 'table') return [{ ...b, content: exportTable(b.content, ctx), children }];
  if (DEFAULT_BLOCKS.has(b.type)) return [{ ...b, content: isArray(b.content) ? exportInline(b.content, ctx) : b.content, children }];
  // Unknown block from another module: keep its text when it has some.
  if (isArray(b.content)) return [{ type: 'paragraph', content: exportInline(b.content, ctx), children }];
  dropped.add(b.type);
  return children;
}

function exportBlocks(blocks: Blk[], ctx: ExportContext, dropped: Set<string>, top: boolean): Blk[] {
  return blocks.flatMap((b) => exportBlock(b, ctx, dropped, top));
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text of every XmlText of a fragment (fallback when the document cannot be parsed). */
function fragmentText(doc: Y.Doc): string {
  const lines: string[] = [];
  const walk = (node: unknown) => {
    if (node instanceof Y.XmlText) lines.push(node.toString().replace(/<[^>]+>/g, ''));
    else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) node.toArray().forEach(walk);
  };
  walk(doc.getXmlFragment(COLLAB_FRAGMENT));
  return lines.filter((l) => l.trim()).join('\n\n');
}

/** Yjs state of a page → Markdown body. `dropped` collects block types that had no Markdown form. */
export function updateToMarkdown(update: Uint8Array, ctx: ExportContext, dropped: Set<string>): { markdown: string; degraded: boolean } {
  const ed = headlessEditor();
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    let blocks: Blk[];
    try {
      blocks = yDocToBlocks(ed, doc, COLLAB_FRAGMENT) as unknown as Blk[];
    } catch (e) {
      console.warn('[Oriel] export: document illisible, repli en texte brut', e);
      return { markdown: fragmentText(doc), degraded: true };
    }
    // Equations become placeholders, swapped for `$$…$$` / `$…$` in the final Markdown; footnotes
    // become `[^n]` with their definitions after the run that references them (H5).
    const notes = encodeFootnoteBlocks(exportBlocks(blocks, ctx, dropped, true));
    const math = encodeMathBlocks(notes.blocks);
    const normalized = math.blocks;
    const toMd = (list: Blk[]) => (list.length ? notes.decode(math.decode(ed.blocksToMarkdownLossy(list as never).trim())) : '');
    try {
      const parts: string[] = [];
      let run: Blk[] = [];
      for (const b of normalized) {
        if (b.type !== TOGGLE_MARK) {
          run.push(b);
          continue;
        }
        parts.push(toMd(run));
        run = [];
        const summary = escapeHtml(toMd([{ type: 'paragraph', content: b.content }]).replace(/\n+/g, ' '));
        const level = b.props?.level === undefined ? 0 : headingLevel(b.props.level);
        const label = level ? `<h${level}>${summary}</h${level}>` : summary;
        parts.push(`<details>\n<summary>${label}</summary>\n\n${toMd(b.children ?? [])}\n\n</details>`);
      }
      parts.push(toMd(run));
      return { markdown: parts.filter(Boolean).join('\n\n'), degraded: false };
    } catch (e) {
      console.warn('[Oriel] export: conversion Markdown partielle', e);
      const parts = normalized.map((b) => {
        try {
          return toMd(b.type === TOGGLE_MARK ? [{ type: b.props?.level ? 'heading' : 'bulletListItem', props: b.props?.level ? { level: b.props.level } : {}, content: b.content, children: b.props?.level ? [] : b.children }] : [b]);
        } catch {
          return inlineText(b.content);
        }
      });
      return { markdown: parts.filter(Boolean).join('\n\n'), degraded: true };
    }
  } finally {
    doc.destroy();
  }
}
