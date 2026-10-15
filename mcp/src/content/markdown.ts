// Markdown ⇄ BlockNote blocks for the MCP tools. Default blocks go through BlockNote's own Markdown
// conversion; Oriel blocks and inline content are mapped to Markdown constructs that convert back:
//  - sub-page / page link card            → `[Titre](oriel://page/<id>)` alone on its line
//  - page / person / date mention          → inline `[Titre](oriel://page/<id>)`, `[@Nom](oriel://user/<id>)`,
//                                             `[📅 15 oct. 2026](oriel://date/2026-10-15)`
//  - inline database / linked view         → `[🗃 Titre](oriel://database/<id>)` (`?view=<linkId>`)
//  - callout                               → `> 💡 texte`
//  - toggles, toggle headings              → `<details><summary>…</summary> … </details>`
//  - columns                               → `<!-- oriel:columns -->`, `<!-- oriel:column -->`, `<!-- /oriel:columns -->`
//  - table of contents, embed, bookmark, PDF → `oriel://toc`, `oriel://embed?url=…`, … links alone on their line
//  - breadcrumb, synced block               → `[Fil d'Ariane](oriel://breadcrumb)`, `[🔁 Bloc synchronisé](oriel://synced/<id>)`
//  - equations                              → `$$…$$` (block) and `$…$` (inline), as the web import / export (mathMarkdown.ts)
//  - footnotes                              → `[^1]` and `[^1]: text` definitions at the end (footnoteMarkdown.ts)
//  - tabs                                   → `<!-- oriel:tabs -->`, `<!-- oriel:tab title="…" -->`, `<!-- /oriel:tabs -->`
//  - HTML block                             → fenced code block with the info string `oriel-html`
//  - button                                 → fenced code block `oriel-button` holding { "label", "icon", "actions" } (JSON)
//  - colors                                 → `<span data-text-color="red" data-background-color="yellow">…</span>` and
//                                             `<!-- oriel:color text=red background=yellow -->` at the end of a block (colors.ts)
// Lossy: comment anchors (a Markdown rewrite drops them), colors of tables and media blocks.
import { HTML_BLOCK_MAX_LENGTH, isSyncedId } from '@oriel/shared';
import { detectProvider } from '../../../web/src/editor/embeds';
import { MAX_TEX, encodeMathBlocks, inlineMathMarkdown, protectMarkdownMath, restoreMarkdownMath } from '../../../web/src/editor/mathMarkdown';
import { clampNote, encodeFootnoteBlocks, protectMarkdownFootnotes, restoreMarkdownFootnotes } from '../../../web/src/editor/footnoteMarkdown';
import { parseStrokes, serializeStrokes } from '../../../web/src/editor/drawingLogic';
import { imageLink, parseCrop, serializeCrop } from '../../../web/src/editor/imageLogic';
import { CODE_VIEWS } from '@oriel/shared';
import { parseButtonActions, serializeButtonActions, type ButtonAction } from '../../../web/src/editor/buttonActions';
import { CUSTOM_BLOCKS, schema } from './schema.js';
import { blockColors, blockComment, encodeColors, isColorName, protectColors, restoreColors, spanTag, splitColors, stripPlaceholders, stripPlaceholderText } from './colors.js';
import { serverEditor, type Blk } from './editor.js';
import { normalizeCodeLanguage } from './codeLanguages.js';
import { isOrielFileUrl, isSafeLinkHref, isSafeMediaUrl, parseRef, placeholderHref, protectSchemes, restoreSchemes, type OrielRef } from './links.js';

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
type Inline = TextItem | LinkItem | { type: string; props?: Record<string, unknown>; content?: unknown };

const isArray = Array.isArray;
const text = (t: string, styles: Styles = {}): TextItem => ({ type: 'text', text: t, styles });
const UNTITLED = 'Sans titre';
const LIST_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);
const FILE_BLOCKS = new Set(['image', 'video', 'audio', 'file']);
const COLUMNS_OPEN = /^\s*<!--\s*oriel:columns\s*-->\s*$/i;
const COLUMN = /^\s*<!--\s*oriel:column(?:\s+width=([0-9.]+))?\s*-->\s*$/i;
const COLUMNS_CLOSE = /^\s*<!--\s*\/oriel:columns\s*-->\s*$/i;
const TABS_OPEN = /^\s*<!--\s*oriel:tabs\s*-->\s*$/i;
const TAB = /^\s*<!--\s*oriel:tab(?:\s+title="([^"]*)")?\s*-->\s*$/i;
const TABS_CLOSE = /^\s*<!--\s*\/oriel:tabs\s*-->\s*$/i;
/** Info string of the fenced code blocks that stand for HTML blocks. */
export const HTML_FENCE_LANGUAGE = 'oriel-html';
/** Info string of the fenced code blocks that stand for buttons (JSON). */
export const BUTTON_FENCE_LANGUAGE = 'oriel-button';
/** Button label and icon bounds (same as the editor). */
const BUTTON_LABEL_MAX = 120;
const BUTTON_ICON_MAX = 16;
const BUTTON_DEFAULT_LABEL = String(CUSTOM_BLOCKS.button.props.label);
/** Longest tab title kept. */
const MAX_TAB_TITLE = 200;
const EMOJI_RE = /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/u;

export function leadingEmoji(s: string): string | null {
  const m = EMOJI_RE.exec(s.trimStart());
  return m ? m[0] : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;').replace(/\s+/g, ' ');
const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export function frenchDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Plain text of inline content (mentions rendered by `label`). */
function inlinePlain(content: unknown, label: (item: Inline) => string): string {
  if (typeof content === 'string') return content;
  if (!isArray(content)) return '';
  return (content as Inline[])
    .map((c) => (c.type === 'text' ? (c as TextItem).text : c.type === 'link' ? inlinePlain((c as LinkItem).content, label) : label(c)))
    .join('');
}

// ===========================================================================
// Export: blocks → Markdown
// ===========================================================================

export interface ExportContext {
  /** Title of a page / database / row (prefetched), or undefined. */
  title(pageId: string): string | undefined;
  /** Name of a user, or undefined. */
  userName(userId: string): string | undefined;
}

/** Page and user ids referenced by blocks (to prefetch titles and names before exporting). */
export function collectReferences(blocks: Blk[]): { pageIds: Set<string>; userIds: Set<string> } {
  const pageIds = new Set<string>();
  const userIds = new Set<string>();
  const inline = (content: unknown) => {
    if (!isArray(content)) {
      const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> } | undefined;
      if (table?.type === 'tableContent') for (const row of table.rows ?? []) for (const cell of row.cells) inline(isArray(cell) ? cell : (cell as { content?: unknown })?.content);
      return;
    }
    for (const c of content as Inline[]) {
      const props = (c as { props?: Record<string, unknown> }).props ?? {};
      if (c.type === 'pageMention' && typeof props.pageId === 'string') pageIds.add(props.pageId);
      if (c.type === 'userMention' && typeof props.userId === 'string') userIds.add(props.userId);
    }
  };
  const walk = (list: Blk[]) => {
    for (const b of list) {
      const p = b.props ?? {};
      if ((b.type === 'subpage' || b.type === 'pageLink') && typeof p.pageId === 'string') pageIds.add(p.pageId);
      if ((b.type === 'database' || b.type === 'linkedDatabase') && typeof p.databaseId === 'string') pageIds.add(p.databaseId);
      inline(b.content);
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  pageIds.delete('');
  userIds.delete('');
  return { pageIds, userIds };
}

const refLink = (ref: OrielRef, label: string): LinkItem => ({ type: 'link', href: placeholderHref(ref), content: [text(label)] });

function exportInline(content: unknown, ctx: ExportContext): Inline[] {
  if (!isArray(content)) return [];
  const out: Inline[] = [];
  for (const item of content as Inline[]) {
    const props = (item as { props?: Record<string, unknown> }).props ?? {};
    switch (item.type) {
      case 'text':
      case 'link':
      case 'inlineEquation':
      case 'footnote':
        out.push(item);
        break;
      case 'pageMention': {
        const id = String(props.pageId ?? '');
        if (id) out.push(refLink({ kind: 'page', id }, ctx.title(id) || UNTITLED));
        break;
      }
      case 'userMention': {
        const id = String(props.userId ?? '');
        if (id) out.push(refLink({ kind: 'user', id }, `@${ctx.userName(id) ?? 'membre'}`));
        break;
      }
      case 'dateMention': {
        const date = String(props.date ?? '');
        if (!date) break;
        const reminder = props.reminder === true || props.reminder === 'true';
        out.push(refLink({ kind: 'date', date, reminder, userId: reminder ? String(props.userId ?? '') || undefined : undefined }, `📅 ${frenchDate(date)}`));
        break;
      }
      default: {
        const t = inlinePlain([item], () => '');
        if (t) out.push(text(t));
      }
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

const para = (content: Inline[]): Blk => ({ type: 'paragraph', content });

/** One block mapped to default BlockNote blocks (children are handled by the caller). */
function convertBlock(b: Blk, ctx: ExportContext, warnings: Set<string>): Blk | null {
  const p = b.props ?? {};
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  switch (b.type) {
    case 'subpage':
    case 'pageLink': {
      const id = s('pageId');
      return id ? para([refLink({ kind: 'page', id }, ctx.title(id) || UNTITLED)]) : null;
    }
    case 'database': {
      const id = s('databaseId');
      return id ? para([refLink({ kind: 'database', id }, `🗃 ${ctx.title(id) || UNTITLED}`)]) : null;
    }
    case 'linkedDatabase': {
      const id = s('databaseId');
      return id ? para([refLink({ kind: 'database', id, linkId: s('linkId') || undefined }, `🗃 ${ctx.title(id) || UNTITLED} (vue liée)`)]) : null;
    }
    case 'callout':
      return {
        type: 'quote',
        props: blockColors({ backgroundColor: p.backgroundColor }) ? { backgroundColor: p.backgroundColor } : {},
        content: [text(`${s('emoji') || '💡'} `), ...exportInline(b.content, ctx)],
      };
    case 'toc':
      return para([refLink({ kind: 'toc' }, 'Table des matières')]);
    case 'breadcrumb':
      return para([refLink({ kind: 'breadcrumb' }, 'Fil d’Ariane')]);
    case 'syncedBlock': {
      const id = s('syncedId');
      return isSyncedId(id) ? para([refLink({ kind: 'synced', id }, '🔁 Bloc synchronisé')]) : null;
    }
    case 'equation':
      // Serialized as `$$…$$` by toMarkdown (encodeMathBlocks).
      return { type: 'equation', props: { tex: s('tex') }, children: [] };
    case 'drawing': {
      const strokes = parseStrokes(p.strokes);
      return strokes.length ? para([refLink({ kind: 'drawing', strokes: serializeStrokes(strokes) }, `✏ Dessin (${strokes.length} tracé${strokes.length > 1 ? 's' : ''})`)]) : null;
    }
    case 'html':
      return { type: 'codeBlock', props: { language: HTML_FENCE_LANGUAGE }, content: s('html') ? [text(s('html'))] : [], children: [] };
    case 'button': {
      const json = JSON.stringify({ label: s('label'), icon: s('icon'), actions: parseButtonActions(p.actions) }, null, 2);
      return { type: 'codeBlock', props: { language: BUTTON_FENCE_LANGUAGE }, content: [text(json)], children: [] };
    }
    case 'tabs':
    case 'tab':
      return null;
    case 'embed': {
      const url = s('url');
      if (!url) return null;
      const provider = s('provider') || 'generic';
      return para([refLink({ kind: 'embed', url, provider, height: Number(p.height) || 0 }, `▶ Intégration${provider !== 'generic' ? ` ${provider}` : ''} : ${url}`)]);
    }
    case 'bookmark': {
      const url = s('url');
      if (!url) return null;
      return para([
        refLink({ kind: 'bookmark', url, title: s('title'), description: s('description'), image: s('image'), favicon: s('favicon') }, `🔖 ${s('title') || url}`),
      ]);
    }
    case 'pdf': {
      const url = s('url');
      if (!url) return null;
      return para([refLink({ kind: 'pdf', url, name: s('name'), height: Number(p.height) || 640 }, `📄 ${s('name') || 'PDF'}`)]);
    }
    case 'table':
      return { ...b, content: exportTable(b.content, ctx), children: [] };
    case 'columnList':
    case 'column':
      return null;
  }
  if (FILE_BLOCKS.has(b.type) || b.type === 'divider') return { ...b, children: [] };
  if (b.type === 'codeBlock' || b.type === 'heading' || b.type === 'paragraph' || b.type === 'quote' || LIST_TYPES.has(b.type) || b.type === 'toggleListItem') {
    return { ...b, content: exportInline(b.content, ctx), children: [] };
  }
  if (isArray(b.content)) return para(exportInline(b.content, ctx));
  warnings.add(`bloc « ${b.type} » sans équivalent Markdown omis`);
  return null;
}

/** Children of list items stay nested (BlockNote handles them); Oriel-only constructs are flattened. */
function convertNested(blocks: Blk[], ctx: ExportContext, warnings: Set<string>): Blk[] {
  const out: Blk[] = [];
  for (const b of blocks) {
    if (b.type === 'columnList' || b.type === 'column' || b.type === 'tabs') {
      out.push(...convertNested(b.children ?? [], ctx, warnings));
      continue;
    }
    if (b.type === 'tab') {
      warnings.add('onglets dans une liste : chaque onglet devient un titre en gras suivi de son contenu');
      out.push(para([text(tabTitle(b), { bold: true })]), ...convertNested(b.children ?? [], ctx, warnings));
      continue;
    }
    const toggle = b.type === 'toggleListItem' || (b.type === 'heading' && b.props?.isToggleable);
    const converted = toggle ? { type: 'bulletListItem', content: exportInline(b.content, ctx) } : convertBlock(b, ctx, warnings);
    if (!converted) continue;
    if (LIST_TYPES.has(converted.type)) out.push({ ...converted, children: convertNested(b.children ?? [], ctx, warnings) });
    else out.push(converted, ...convertNested(b.children ?? [], ctx, warnings));
  }
  return out;
}

async function toMarkdown(blocks: Blk[]): Promise<string> {
  if (blocks.length === 0) return '';
  const colors = encodeColors(blocks as never[]);
  const notes = encodeFootnoteBlocks(colors.blocks);
  const math = encodeMathBlocks(notes.blocks);
  const md = await serverEditor().blocksToMarkdownLossy(math.blocks as never);
  return notes.decode(colors.decode(math.decode(restoreSchemes(md)))).trim();
}

const tabTitle = (b: Blk) => (typeof b.props?.title === 'string' && b.props.title.trim() ? b.props.title.trim() : 'Onglet');

/** Inline content of a toggle summary as HTML (text styles, colors, inline equations). */
function summaryHtml(content: Inline[]): string {
  return content
    .map((c): string => {
      if (c.type === 'link') return summaryHtml((c as LinkItem).content);
      if (c.type === 'inlineEquation') return escapeHtml(inlineMathMarkdown(String((c as { props?: Record<string, unknown> }).props?.tex ?? '')));
      if (c.type !== 'text') return '';
      const item = c as TextItem;
      const { colors, styles } = splitColors(item.styles);
      let html = escapeHtml(item.text.replace(/\s+/g, ' '));
      if (!html) return '';
      if (styles.code) html = `<code>${html}</code>`;
      if (styles.strike) html = `<s>${html}</s>`;
      if (styles.underline) html = `<u>${html}</u>`;
      if (styles.italic) html = `<em>${html}</em>`;
      if (styles.bold) html = `<strong>${html}</strong>`;
      return colors ? `${spanTag(colors)}${html}</span>` : html;
    })
    .join('');
}

async function exportList(blocks: Blk[], ctx: ExportContext, warnings: Set<string>): Promise<string> {
  const parts: string[] = [];
  let run: Blk[] = [];
  const flush = async () => {
    if (run.length) parts.push(await toMarkdown(run));
    run = [];
  };
  for (const b of blocks) {
    const toggle = b.type === 'toggleListItem' || (b.type === 'heading' && b.props?.isToggleable === true);
    if (toggle) {
      await flush();
      const colors = blockColors(b.props);
      const summary = summaryHtml(exportInline(b.content, ctx)).trim() + (colors ? ` ${blockComment(colors)}` : '');
      const level = b.type === 'heading' ? Math.min(4, Number(b.props?.level) || 1) : 0;
      const label = level ? `<h${level}>${summary}</h${level}>` : summary;
      const inner = await exportList(b.children ?? [], ctx, warnings);
      parts.push(`<details>\n<summary>${label}</summary>\n\n${inner}\n\n</details>`);
      continue;
    }
    if (b.type === 'columnList') {
      await flush();
      const cols = (b.children ?? []).filter((c) => c.type === 'column');
      const lines = ['<!-- oriel:columns -->'];
      for (const col of cols) {
        const width = Number(col.props?.width ?? 1);
        lines.push(Number.isFinite(width) && width !== 1 ? `<!-- oriel:column width=${Math.round(width * 1000) / 1000} -->` : '<!-- oriel:column -->');
        const inner = await exportList(col.children ?? [], ctx, warnings);
        if (inner) lines.push(inner);
      }
      lines.push('<!-- /oriel:columns -->');
      parts.push(lines.join('\n\n'));
      continue;
    }
    if (b.type === 'column') {
      await flush();
      parts.push(await exportList(b.children ?? [], ctx, warnings));
      continue;
    }
    if (b.type === 'tabs') {
      await flush();
      const lines = ['<!-- oriel:tabs -->'];
      for (const tab of b.children ?? []) {
        if (tab.type !== 'tab') {
          lines.push(await exportList([tab], ctx, warnings));
          continue;
        }
        lines.push(`<!-- oriel:tab title="${escapeAttr(tabTitle(tab))}" -->`);
        const inner = await exportList(tab.children ?? [], ctx, warnings);
        if (inner) lines.push(inner);
      }
      lines.push('<!-- /oriel:tabs -->');
      parts.push(lines.filter(Boolean).join('\n\n'));
      continue;
    }
    if (b.type === 'tab') {
      // A tab outside a tabs block (the editor shows it as a label).
      await flush();
      run.push(para([text(tabTitle(b), { bold: true })]));
      await flush();
      parts.push(await exportList(b.children ?? [], ctx, warnings));
      continue;
    }
    if (LIST_TYPES.has(b.type)) {
      const converted = convertBlock(b, ctx, warnings);
      if (converted) run.push({ ...converted, children: convertNested(b.children ?? [], ctx, warnings) });
      continue;
    }
    const converted = convertBlock(b, ctx, warnings);
    if (converted) run.push(converted);
    if (b.children?.length) {
      // Markdown cannot nest blocks under a paragraph, callout… : the children follow it.
      await flush();
      parts.push(await exportList(b.children, ctx, warnings));
    }
  }
  await flush();
  return parts.filter(Boolean).join('\n\n');
}

export interface ExportResult {
  markdown: string;
  /** French notes about content that has no Markdown form. */
  warnings: string[];
}

export async function blocksToMarkdown(blocks: Blk[], ctx: ExportContext): Promise<ExportResult> {
  const warnings = new Set<string>();
  // Placeholder characters typed in the page are not markup (QA-MCP-04).
  const clean = stripPlaceholderText(blocks);
  if (clean.stripped) warnings.add('caractères réservés (zone privée Unicode U+E000…U+E014) omis dans le Markdown : utilisez le format blocks pour une copie exacte');
  // BlockNote keeps an empty trailing paragraph.
  const list = [...clean.value];
  while (list.length && list[list.length - 1]!.type === 'paragraph' && !inlinePlain(list[list.length - 1]!.content, () => 'x').trim() && !list[list.length - 1]!.children?.length) list.pop();
  const markdown = (await exportList(list, ctx, warnings)).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, warnings: [...warnings] };
}

// ===========================================================================
// Import: Markdown → blocks
// ===========================================================================

export interface ResolvedPage {
  id: string;
  kind: 'page' | 'database';
  parentType: 'workspace' | 'page' | 'database';
  parentId: string;
}

export interface ImportContext {
  /** Page receiving the content: sub-page cards are only used for its own children. */
  pageId: string | null;
  /** A page/database of the workspace visible to the token's user, or null. */
  resolvePage(id: string): Promise<ResolvedPage | null>;
  /** The user is a member of the workspace. */
  isMember(userId: string): Promise<boolean>;
  /** Token owner (date reminders are set for them). */
  currentUserId: string;
  /** Origin of the Oriel server (never framed as a generic embed). */
  serverOrigin?: string;
  /**
   * The synced block may be shown on the page (same workspace as the page, owner page visible to the
   * token's user). Absent: synced blocks are refused.
   */
  resolveSynced?(syncedId: string): Promise<boolean>;
}

export interface ImportResult {
  blocks: Blk[];
  warnings: string[];
}

type Segment =
  | { type: 'markdown'; text: string }
  | { type: 'columns'; columns: Array<{ width: number; text: string }> }
  | { type: 'tabs'; tabs: Array<{ title: string; text: string }> };

const isOpen = (l: string) => COLUMNS_OPEN.test(l) || TABS_OPEN.test(l);
const isClose = (l: string) => COLUMNS_CLOSE.test(l) || TABS_CLOSE.test(l);

/** Splits top-level column / tab containers out of the Markdown (outside code fences). */
function segment(md: string): Segment[] {
  const out: Segment[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (buf.join('').trim()) out.push({ type: 'markdown', text: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || !isOpen(line)) {
      buf.push(line);
      continue;
    }
    flush();
    const tabs = TABS_OPEN.test(line);
    const items: Array<{ width: number; title: string; text: string[] }> = [];
    let depth = 0;
    let fence = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (!fence && isOpen(l)) depth++;
      if (!fence && isClose(l)) {
        if (depth === 0) break;
        depth--;
      }
      if (!fence && depth === 0) {
        const col = tabs ? null : COLUMN.exec(l);
        if (col) {
          const w = Number(col[1] ?? 1);
          items.push({ width: Number.isFinite(w) && w > 0 ? w : 1, title: '', text: [] });
          continue;
        }
        const tab = tabs ? TAB.exec(l) : null;
        if (tab) {
          items.push({ width: 1, title: unescapeAttr(tab[1] ?? '').trim().slice(0, MAX_TAB_TITLE) || 'Onglet', text: [] });
          continue;
        }
      }
      if (items.length === 0) {
        if (!l.trim()) continue;
        items.push({ width: 1, title: 'Onglet', text: [] });
      }
      items[items.length - 1]!.text.push(l);
    }
    if (tabs) out.push({ type: 'tabs', tabs: items.map((t) => ({ title: t.title, text: t.text.join('\n') })) });
    else out.push({ type: 'columns', columns: items.map((c) => ({ width: c.width, text: c.text.join('\n') })) });
    i = j;
  }
  flush();
  return out;
}

/** Placeholder references of parsed blocks (to resolve them before converting). */
function collectRefs(blocks: Blk[], out: OrielRef[]): void {
  const inline = (content: unknown) => {
    if (isArray(content)) {
      for (const c of content as Inline[]) {
        if (c.type === 'link') {
          const ref = parseRef((c as LinkItem).href);
          if (ref) out.push(ref);
        }
      }
    } else if ((content as { type?: string })?.type === 'tableContent') {
      for (const row of (content as { rows?: Array<{ cells: unknown[] }> }).rows ?? [])
        for (const cell of row.cells) inline(isArray(cell) ? cell : (cell as { content?: unknown })?.content);
    }
  };
  for (const b of blocks) {
    inline(b.content);
    if (b.children) collectRefs(b.children, out);
  }
}

interface Resolved {
  pages: Map<string, ResolvedPage | null>;
  users: Map<string, boolean>;
  /** Synced blocks usable on the page (same workspace, owner page visible). */
  synced: Map<string, boolean>;
}

class Importer {
  readonly warnings = new Set<string>();
  constructor(
    private readonly ctx: ImportContext,
    private readonly resolved: Resolved,
  ) {}

  private page(id: string): ResolvedPage | null {
    return this.resolved.pages.get(id) ?? null;
  }

  private inline(content: unknown): unknown {
    if (!isArray(content)) return content;
    const out: Inline[] = [];
    for (const item of content as Inline[]) {
      if (item.type === 'text') {
        // BlockNote turns hard breaks into "\n " (stray space).
        out.push({ ...(item as TextItem), text: (item as TextItem).text.replace(/\n /g, '\n') });
        continue;
      }
      if (item.type !== 'link') {
        out.push(item);
        continue;
      }
      const link = item as LinkItem;
      const label = inlinePlain(link.content, () => '');
      const ref = parseRef(link.href);
      if (!ref) {
        if (isSafeLinkHref(link.href)) out.push(link);
        else {
          this.warnings.add(`lien « ${link.href.slice(0, 60)} » refusé (seuls http, https, mailto, tel et les chemins d’Oriel sont acceptés)`);
          out.push(...link.content);
        }
        continue;
      }
      switch (ref.kind) {
        case 'page':
        case 'database':
          if (this.page(ref.id)) out.push({ type: 'pageMention', props: { pageId: ref.id } });
          else this.missing(ref.id, label, out);
          break;
        case 'user':
          if (this.resolved.users.get(ref.id)) out.push({ type: 'userMention', props: { userId: ref.id } });
          else {
            this.warnings.add(`personne ${ref.id} introuvable dans l'espace : mention remplacée par du texte`);
            out.push(text(label || ref.id));
          }
          break;
        case 'date':
          out.push({ type: 'dateMention', props: { date: ref.date, reminder: ref.reminder, userId: ref.reminder ? this.ctx.currentUserId : '' } });
          break;
        default:
          out.push(...(link.content.length ? link.content : [text(label)]));
      }
    }
    return out;
  }

  private missing(id: string, label: string, out: Inline[]): void {
    this.warnings.add(`page ${id} introuvable ou inaccessible : lien remplacé par du texte`);
    out.push(text(label || id));
  }

  private table(content: unknown): unknown {
    const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
    if (!table || table.type !== 'tableContent' || !isArray(table.rows)) return content;
    return {
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => {
          if (isArray(cell)) return this.inline(cell);
          const c = cell as { content?: unknown };
          return c && isArray(c.content) ? { ...c, content: this.inline(c.content) } : cell;
        }),
      })),
    };
  }

  /** The paragraph is a single link (whitespace around it allowed). */
  private soleLink(content: unknown): LinkItem | null {
    if (!isArray(content)) return null;
    const items = (content as Inline[]).filter((c) => !(c.type === 'text' && !(c as TextItem).text.trim()));
    return items.length === 1 && items[0]!.type === 'link' ? (items[0] as LinkItem) : null;
  }

  private blockFromRef(ref: OrielRef, label: string): Blk | null {
    switch (ref.kind) {
      case 'page': {
        const page = this.page(ref.id);
        if (!page) return null;
        const child = !!this.ctx.pageId && page.parentType === 'page' && page.parentId === this.ctx.pageId;
        return { type: child ? 'subpage' : 'pageLink', props: { pageId: ref.id } };
      }
      case 'database': {
        const page = this.page(ref.id);
        if (!page) return null;
        if (page.kind !== 'database') return { type: 'pageLink', props: { pageId: ref.id } };
        return ref.linkId ? { type: 'linkedDatabase', props: { databaseId: ref.id, linkId: ref.linkId } } : { type: 'database', props: { databaseId: ref.id } };
      }
      case 'toc':
        return { type: 'toc', props: {} };
      case 'breadcrumb':
        return { type: 'breadcrumb', props: {} };
      case 'synced':
        if (this.resolved.synced.get(ref.id)) return { type: 'syncedBlock', props: { syncedId: ref.id } };
        this.warnings.add(`bloc synchronisé ${ref.id} introuvable dans l'espace de la page : lien remplacé par du texte`);
        return { type: 'paragraph', content: [text(label || 'Bloc synchronisé')] };
      case 'embed': {
        if (!/^https?:\/\//i.test(ref.url) || this.sameOrigin(ref.url)) return this.refused(ref.url, label);
        const provider = ref.provider || detectProvider(ref.url)?.provider || 'generic';
        return { type: 'embed', props: { url: ref.url, provider, height: ref.height ?? 0 } };
      }
      case 'bookmark': {
        if (!/^https?:\/\//i.test(ref.url)) return this.refused(ref.url, label);
        const httpsOnly = (u?: string) => (u && /^https:\/\//i.test(u) ? u : '');
        return {
          type: 'bookmark',
          props: { url: ref.url, title: ref.title ?? '', description: ref.description ?? '', image: httpsOnly(ref.image), favicon: httpsOnly(ref.favicon) },
        };
      }
      case 'drawing': {
        const strokes = parseStrokes(ref.strokes);
        return strokes.length ? { type: 'drawing', props: { strokes: serializeStrokes(strokes) } } : null;
      }
      case 'pdf': {
        if (!isOrielFileUrl(ref.url)) return this.refused(ref.url, label);
        return { type: 'pdf', props: { url: ref.url, name: ref.name ?? '', height: ref.height ?? 640 } };
      }
      default:
        return null;
    }
  }

  private sameOrigin(url: string): boolean {
    if (!this.ctx.serverOrigin) return false;
    try {
      return new URL(url).origin === new URL(this.ctx.serverOrigin).origin;
    } catch {
      return false;
    }
  }

  private refused(url: string, label: string): Blk {
    this.warnings.add(`adresse « ${url.slice(0, 80)} » refusée pour ce bloc`);
    return { type: 'paragraph', content: [text(label || url)] };
  }

  block(b: Blk): Blk[] {
    const children = b.children?.length ? this.blocks(b.children) : [];
    const props = { ...(b.props ?? {}) };
    if (FILE_BLOCKS.has(b.type)) {
      const url = String(props.url ?? '');
      if (!url || !isSafeMediaUrl(url)) {
        if (url) this.warnings.add(`média « ${url.slice(0, 80)} » refusé (http, https ou fichier envoyé sur Oriel uniquement)`);
        const label = String(props.caption || props.name || url);
        return label ? [{ type: 'paragraph', content: [text(label)], children }] : children;
      }
      return [{ ...b, props, children }];
    }
    if (b.type === 'paragraph') {
      const link = this.soleLink(b.content);
      if (link) {
        const ref = parseRef(link.href);
        const label = inlinePlain(link.content, () => '');
        if (ref && ref.kind !== 'user' && ref.kind !== 'date') {
          const made = this.blockFromRef(ref, label);
          if (made) return [made, ...children];
          if (ref.kind === 'page' || ref.kind === 'database') {
            const out: Inline[] = [];
            this.missing(ref.id, label, out);
            return [{ type: 'paragraph', content: out }, ...children];
          }
        } else if (!ref && isOrielFileUrl(link.href)) {
          return [{ ...this.fileBlock(link.href, label), children }];
        }
      }
    }
    if (b.type === 'heading' && Number(props.level) > 4) props.level = 4;
    if (b.type === 'codeBlock' && props.language === HTML_FENCE_LANGUAGE) {
      const html = inlinePlain(b.content, () => '');
      if (html.length <= HTML_BLOCK_MAX_LENGTH) return [{ type: 'html', props: { html }, children: [] }, ...children];
      this.warnings.add(`bloc HTML de ${html.length} caractères refusé (maximum ${HTML_BLOCK_MAX_LENGTH}) : gardé comme bloc de code`);
      props.language = 'html';
    }
    if (b.type === 'codeBlock' && props.language === BUTTON_FENCE_LANGUAGE) {
      // Checked (workspace ids, URLs, bounds) by sanitizeButtons after the conversion.
      const source = inlinePlain(b.content, () => '');
      try {
        const spec = JSON.parse(source) as { label?: unknown; icon?: unknown; actions?: unknown };
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
          return [{ type: 'button', props: { label: spec.label ?? '', icon: spec.icon ?? '', actions: spec.actions ?? [] }, children: [] }, ...children];
        }
      } catch {
        /* below */
      }
      this.warnings.add('bouton illisible (JSON { "label", "icon", "actions" } attendu) : gardé comme bloc de code');
      props.language = 'json';
    }
    if (b.type === 'codeBlock') props.language = normalizeCodeLanguage(props.language);
    const out: Blk = { ...b, props, children };
    if (b.type === 'table') out.content = this.table(b.content);
    else if (isArray(b.content)) out.content = this.inline(b.content);
    // "> 💡 Texte" → callout.
    if (b.type === 'quote' && isArray(out.content)) {
      const items = out.content as Inline[];
      const first = items[0];
      const emoji = first?.type === 'text' ? leadingEmoji((first as TextItem).text) : null;
      if (emoji && first) {
        const rest = (first as TextItem).text.trimStart().slice(emoji.length).replace(/^\s+/, '');
        const content = rest ? [{ ...(first as TextItem), text: rest }, ...items.slice(1)] : items.slice(1);
        const background = blockColors({ backgroundColor: props.backgroundColor }) ? { backgroundColor: props.backgroundColor } : {};
        return [{ type: 'callout', props: { emoji, ...background }, content, children }];
      }
    }
    return [out];
  }

  private fileBlock(url: string, label: string): Blk {
    const name = decodeURIComponent(url.split('/').pop() ?? '') || label;
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const type = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext)
      ? 'image'
      : ['mp4', 'webm', 'mov', 'm4v'].includes(ext)
        ? 'video'
        : ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)
          ? 'audio'
          : 'file';
    return { type, props: { url, name: label || name } };
  }

  blocks(list: Blk[]): Blk[] {
    return list.flatMap((b) => this.block(b));
  }
}

async function parseMarkdown(md: string, warnings: Set<string>): Promise<Blk[]> {
  if (!md.trim()) return [];
  const notes = protectMarkdownFootnotes(md);
  const math = protectMarkdownMath(notes.md);
  const tooLong = [...math.display, ...math.inline].filter((tex) => tex.length > MAX_TEX).length;
  if (tooLong) warnings.add(`${tooLong} équation(s) de plus de ${MAX_TEX} caractères tronquée(s)`);
  const colors = protectColors(math.md);
  for (const w of colors.warnings) warnings.add(w);
  const parsed = (await serverEditor().tryParseMarkdownToBlocks(protectSchemes(colors.md))) as unknown as Blk[];
  return restoreMarkdownFootnotes(restoreMarkdownMath(restoreColors(parsed as never[], colors), math), notes) as unknown as Blk[];
}

async function parseSegments(md: string, warnings: Set<string>): Promise<Blk[]> {
  const out: Blk[] = [];
  for (const seg of segment(md)) {
    if (seg.type === 'markdown') {
      out.push(...(await parseMarkdown(seg.text, warnings)));
      continue;
    }
    if (seg.type === 'tabs') {
      const tabs: Blk[] = [];
      for (const tab of seg.tabs) tabs.push({ type: 'tab', props: { title: tab.title }, children: await parseSegments(tab.text, warnings) });
      if (tabs.length) out.push({ type: 'tabs', children: tabs });
      continue;
    }
    const columns: Blk[] = [];
    for (const col of seg.columns) {
      const children = await parseSegments(col.text, warnings);
      columns.push({ type: 'column', props: { width: col.width }, children: children.length ? children : [{ type: 'paragraph', content: [] }] });
    }
    // A column list needs at least two columns.
    if (columns.length >= 2) out.push({ type: 'columnList', children: columns });
    else out.push(...(columns[0]?.children ?? []));
  }
  return out;
}

/** Markdown (with `oriel://` references) → blocks valid for the Oriel schema. */
export async function markdownToBlocks(md: string, ctx: ImportContext): Promise<ImportResult> {
  const parseWarnings = new Set<string>();
  const clean = stripPlaceholders(md);
  if (clean !== md) parseWarnings.add('caractères réservés (zone privée Unicode U+E000…U+E014) retirés du texte');
  const parsed = await parseSegments(clean, parseWarnings);
  const refs: OrielRef[] = [];
  collectRefs(parsed, refs);
  const resolved: Resolved = { pages: new Map(), users: new Map(), synced: new Map() };
  const idsOf = (kinds: string[]) => [...new Set(refs.filter((r) => kinds.includes(r.kind)).map((r) => (r as { id: string }).id))];
  await Promise.all([
    ...idsOf(['page', 'database']).map(async (id) => resolved.pages.set(id, await ctx.resolvePage(id))),
    ...idsOf(['user']).map(async (id) => resolved.users.set(id, await ctx.isMember(id))),
    ...idsOf(['synced']).map(async (id) => resolved.synced.set(id, await syncedUsable(ctx, id))),
  ]);
  const importer = new Importer(ctx, resolved);
  const blocks = await sanitizeButtons(importer.blocks(parsed), ctx, importer.warnings);
  return { blocks, warnings: [...parseWarnings, ...importer.warnings] };
}

/**
 * Buttons as the editor reads them (parseButtonActions: known actions, bounds, http(s) / mailto / tel
 * addresses only), plus the workspace rules of the MCP: databases and pages of the page's workspace
 * only, and the recorded blocks of « insert » actions checked like any written block.
 */
async function sanitizeButtons(blocks: Blk[], ctx: ImportContext, warnings: Set<string>, depth = 0): Promise<Blk[]> {
  const out: Blk[] = [];
  for (const b of blocks) {
    const children = b.children?.length ? await sanitizeButtons(b.children, ctx, warnings, depth) : b.children;
    if (b.type !== 'button') {
      out.push(children === b.children ? b : { ...b, children });
      continue;
    }
    const p = b.props ?? {};
    const raw = typeof p.actions === 'string' ? p.actions : JSON.stringify(p.actions ?? []);
    const parsed = parseButtonActions(raw);
    const given = (() => {
      try {
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) ? list.length : 0;
      } catch {
        return 0;
      }
    })();
    if (parsed.length < given) warnings.add(`bouton : ${given - parsed.length} action(s) invalide(s) retirée(s) (adresses http, https, mailto ou tel uniquement)`);
    const actions: ButtonAction[] = [];
    for (const a of parsed) {
      if (a.type === 'addRow' || a.type === 'editRows') {
        if ((await ctx.resolvePage(a.databaseId))?.kind === 'database') actions.push(a);
        else warnings.add(`bouton : base ${a.databaseId} introuvable dans l'espace, action retirée`);
      } else if (a.type === 'open') {
        if (a.pageId) {
          if (await ctx.resolvePage(a.pageId)) actions.push(a);
          else warnings.add(`bouton : page ${a.pageId} introuvable dans l'espace, action retirée`);
        } else if (a.url && isSafeLinkHref(a.url)) actions.push(a);
        else warnings.add('bouton : adresse refusée, action retirée');
      } else if (a.type === 'insert') {
        if (depth >= 2) {
          warnings.add('bouton : blocs enregistrés trop imbriqués, action retirée');
          continue;
        }
        const checked = await sanitizeBlocks(a.blocks as Blk[], ctx, depth + 1);
        for (const w of checked.warnings) warnings.add(`bouton : ${w}`);
        actions.push({ ...a, blocks: stripBlockIds(checked.blocks) });
      } else actions.push(a);
    }
    const label = typeof p.label === 'string' ? p.label.trim().slice(0, BUTTON_LABEL_MAX) : '';
    const icon = typeof p.icon === 'string' ? p.icon.slice(0, BUTTON_ICON_MAX) : '';
    out.push({ ...b, props: { label: label || BUTTON_DEFAULT_LABEL, icon, actions: serializeButtonActions(actions) }, ...(children ? { children } : {}) });
  }
  return out;
}

/** Recorded blocks of a button carry no ids (fresh ones at each insertion). */
function stripBlockIds(list: Blk[]): Blk[] {
  return list.map(({ id: _id, ...b }) => (b.children ? { ...b, children: stripBlockIds(b.children) } : b));
}

/** A synced block may be shown on the page: strict id, same workspace, owner page visible. */
async function syncedUsable(ctx: ImportContext, id: string): Promise<boolean> {
  if (!isSyncedId(id) || !ctx.resolveSynced) return false;
  try {
    return await ctx.resolveSynced(id);
  } catch {
    return false;
  }
}

/** Block types of the mirrored schema handled by this module (custom ones), for documentation and tests. */
export const HANDLED_CUSTOM_BLOCKS = Object.keys(CUSTOM_BLOCKS);

// ===========================================================================
// Validation of BlockNote JSON blocks (lossless write path)
// ===========================================================================

const COLOR_KEYS = new Set(['textColor', 'backgroundColor']);

/**
 * Props of a JSON block reduced to the mirrored schema (QA-MCP-05): unknown props dropped, values of
 * another type than the default (objects, NaN…) or outside the allowed values reset to the default,
 * colors limited to the editor's color names. The web reads these props as plain strings / numbers.
 */
function normalizeProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const spec = (schema.blockSchema as Record<string, { propSchema?: Record<string, { default?: unknown; values?: readonly unknown[]; optional?: boolean }> }>)[type]
    ?.propSchema;
  if (!spec) return props;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const def = spec[key];
    if (!def) continue;
    if (value === undefined) continue;
    const fallback = def.default;
    let v: unknown = value;
    if (fallback !== undefined && typeof v !== typeof fallback) v = fallback;
    else if (typeof v === 'number' && !Number.isFinite(v)) v = fallback;
    else if (fallback === undefined && v !== null && typeof v === 'object') v = undefined;
    if (def.values && !def.values.includes(v)) v = fallback;
    if (COLOR_KEYS.has(key) && v !== 'default' && !isColorName(v)) v = 'default';
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Text styles of a JSON text run: color names only, booleans for the other known styles. */
function normalizeStyles(styles: unknown): Record<string, unknown> {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(styles as Record<string, unknown>)) {
    if (COLOR_KEYS.has(key)) {
      if (isColorName(value)) out[key] = value;
    } else if (value === true) out[key] = true;
  }
  return out;
}

const normalizeRun = (c: Inline): Inline =>
  c.type === 'text' ? ({ ...(c as TextItem), text: String((c as TextItem).text ?? ''), styles: normalizeStyles((c as TextItem).styles) } as Inline) : c;

/**
 * Applies the same rules as the Markdown import to blocks given as JSON: references to pages,
 * databases and people must exist in the workspace, URLs must be safe (http(s) / mailto / tel /
 * Oriel paths for links; http(s) or uploaded files for media; https images for bookmarks;
 * uploaded files only for PDF blocks; never the Oriel origin in an embed). Equations and HTML
 * blocks are bounded in size; synced blocks must belong to the page's workspace.
 */
export async function sanitizeBlocks(blocks: Blk[], ctx: ImportContext, depth = 0): Promise<ImportResult> {
  const pageIds = new Set<string>();
  const userIds = new Set<string>();
  const syncedIds = new Set<string>();
  const scan = (list: Blk[]) => {
    for (const b of list) {
      const p = b.props ?? {};
      for (const k of ['pageId', 'databaseId']) if (typeof p[k] === 'string' && p[k]) pageIds.add(p[k] as string);
      if (b.type === 'syncedBlock' && typeof p.syncedId === 'string') syncedIds.add(p.syncedId);
      const inline = (content: unknown) => {
        if (!isArray(content)) {
          const t = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
          if (t?.type === 'tableContent') for (const row of t.rows ?? []) for (const cell of row.cells) inline(isArray(cell) ? cell : (cell as { content?: unknown })?.content);
          return;
        }
        for (const c of content as Inline[]) {
          const props = (c as { props?: Record<string, unknown> }).props ?? {};
          if (c.type === 'pageMention' && typeof props.pageId === 'string') pageIds.add(props.pageId);
          if (c.type === 'userMention' && typeof props.userId === 'string') userIds.add(props.userId);
        }
      };
      inline(b.content);
      if (b.children) scan(b.children);
    }
  };
  scan(blocks);
  const pages = new Map<string, ResolvedPage | null>();
  const users = new Map<string, boolean>();
  const synced = new Map<string, boolean>();
  await Promise.all([
    ...[...pageIds].map(async (id) => pages.set(id, await ctx.resolvePage(id))),
    ...[...userIds].map(async (id) => users.set(id, await ctx.isMember(id))),
    ...[...syncedIds].map(async (id) => synced.set(id, await syncedUsable(ctx, id))),
  ]);
  const warnings = new Set<string>();
  const clampTex = (tex: unknown): string => {
    const t = typeof tex === 'string' ? tex : '';
    if (t.length <= MAX_TEX) return t;
    warnings.add(`équation de plus de ${MAX_TEX} caractères tronquée`);
    return t.slice(0, MAX_TEX);
  };
  const sameOrigin = (url: string) => {
    try {
      return !!ctx.serverOrigin && new URL(url).origin === new URL(ctx.serverOrigin).origin;
    } catch {
      return false;
    }
  };
  const asText = (label: string, why: string): Blk => {
    warnings.add(why);
    return { type: 'paragraph', content: label ? [text(label)] : [] };
  };
  const inline = (content: unknown): unknown => {
    if (!isArray(content)) {
      const t = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
      if (t?.type !== 'tableContent' || !isArray(t.rows)) return content;
      return {
        ...t,
        rows: t.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => (isArray(cell) ? inline(cell) : { ...(cell as object), content: inline((cell as { content?: unknown })?.content) })),
        })),
      };
    }
    const out: Inline[] = [];
    for (const c of content as Inline[]) {
      const props = (c as { props?: Record<string, unknown> }).props ?? {};
      if (c.type === 'link') {
        const link = c as LinkItem;
        const label = isArray(link.content) ? (link.content as Inline[]).map(normalizeRun) : [];
        if (typeof link.href === 'string' && isSafeLinkHref(link.href)) out.push({ ...link, content: label } as Inline);
        else {
          warnings.add(`lien « ${String(link.href).slice(0, 60)} » refusé`);
          out.push(...label);
        }
      } else if (c.type === 'pageMention') {
        if (pages.get(String(props.pageId))) out.push(c);
        else warnings.add(`page ${String(props.pageId)} introuvable : mention retirée`);
      } else if (c.type === 'userMention') {
        if (users.get(String(props.userId))) out.push(c);
        else warnings.add(`personne ${String(props.userId)} introuvable dans l'espace : mention retirée`);
      } else if (c.type === 'dateMention') {
        const reminder = props.reminder === true;
        out.push({ ...c, props: { ...props, reminder, userId: reminder ? ctx.currentUserId : '' } });
      } else if (c.type === 'inlineEquation') {
        out.push({ ...c, props: { tex: clampTex(props.tex) } });
      } else if (c.type === 'footnote') {
        out.push({ ...c, props: { note: clampNote(props.note) } });
      } else out.push(normalizeRun(c));
    }
    return out;
  };
  const walk = (list: Blk[]): Blk[] =>
    list.map((b): Blk => {
      const p = normalizeProps(b.type, { ...(b.props ?? {}) });
      const children = b.children ? walk(b.children) : b.children;
      const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
      switch (b.type) {
        case 'subpage':
        case 'pageLink':
          if (!pages.get(s('pageId'))) return asText('', `page ${s('pageId')} introuvable : carte retirée`);
          break;
        case 'database':
        case 'linkedDatabase':
          if (pages.get(s('databaseId'))?.kind !== 'database') return asText('', `base ${s('databaseId')} introuvable : bloc retiré`);
          break;
        case 'embed':
          if (!/^https?:\/\//i.test(s('url')) || sameOrigin(s('url'))) return asText('', `intégration « ${s('url').slice(0, 60)} » refusée`);
          break;
        case 'bookmark':
          if (!/^https?:\/\//i.test(s('url'))) return asText(s('title'), `signet « ${s('url').slice(0, 60)} » refusé`);
          for (const k of ['image', 'favicon']) if (s(k) && !/^https:\/\//i.test(s(k))) p[k] = '';
          break;
        case 'pdf':
          if (!isOrielFileUrl(s('url'))) return asText(s('name'), `PDF « ${s('url').slice(0, 60)} » refusé (fichiers envoyés sur Oriel uniquement)`);
          break;
        case 'equation':
          p.tex = clampTex(p.tex);
          break;
        case 'drawing':
          p.strokes = serializeStrokes(parseStrokes(p.strokes));
          break;
        case 'image':
          p.crop = serializeCrop(parseCrop(p.crop));
          p.link = imageLink(p.link) ?? '';
          break;
        case 'codeBlock':
          if (typeof p.view !== 'string' || !(CODE_VIEWS as readonly string[]).includes(p.view)) p.view = 'both';
          break;
        case 'html':
          if (s('html').length > HTML_BLOCK_MAX_LENGTH) {
            warnings.add(`bloc HTML de ${s('html').length} caractères refusé (maximum ${HTML_BLOCK_MAX_LENGTH}) : gardé comme bloc de code`);
            return { type: 'codeBlock', props: { language: 'html' }, content: [text(s('html'))], ...(children ? { children } : {}) };
          }
          break;
        case 'syncedBlock':
          if (!synced.get(s('syncedId'))) return asText('', `bloc synchronisé ${s('syncedId').slice(0, 60)} introuvable dans l'espace de la page : bloc retiré`);
          break;
        case 'tab':
          if (s('title').length > MAX_TAB_TITLE) p.title = s('title').slice(0, MAX_TAB_TITLE);
          break;
      }
      if (FILE_BLOCKS.has(b.type) && s('url') && !isSafeMediaUrl(s('url'))) return asText(s('name') || s('caption'), `média « ${s('url').slice(0, 60)} » refusé`);
      return { ...b, props: p, ...(b.content !== undefined ? { content: inline(b.content) } : {}), ...(children ? { children } : {}) };
    });
  const checked = await sanitizeButtons(walk(blocks), ctx, warnings, depth);
  return { blocks: checked, warnings: [...warnings] };
}
