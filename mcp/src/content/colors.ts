// Text and background colors in the Markdown exchanged with Claude (lossless round trip):
//  - inline: `<span data-text-color="red" data-background-color="yellow">texte **gras**</span>`
//    (either attribute may be omitted; Markdown keeps working inside the span);
//  - block (paragraph, heading, list item, quote/callout, toggle…): an HTML comment at the end of the
//    block's text, `Texte <!-- oriel:color text=red background=yellow -->`.
// Values are the color names of the editor (COLORS without 'default'); anything else is ignored.
//
// BlockNote's Markdown conversion drops colors, so (like equations in web/src/editor/mathMarkdown.ts)
// the tags are swapped for private-use placeholders around parsing / serializing:
//  - import: protectColors(md) → parse → restoreColors(blocks, protected)
//  - export: encodeColors(blocks) → serialize → decode(markdown)
// Code (fences and inline code spans) is left untouched.
import { COLORS } from '@oriel/shared';

const SPAN_OPEN = '';
const SPAN_MID = '';
const SPAN_CLOSE = '';
const BLOCK_OPEN = '';
const BLOCK_CLOSE = '';
/** Span opening (index of its colors) or closing, block marker (index of its colors). */
const MARKERS = /(\d+)||(\d+)/g;

/**
 * Private-use characters of the placeholders (colors here, equations in web/src/editor/mathMarkdown.ts).
 * Removed from user text before any conversion (QA-MCP-04): a text carrying them would otherwise be
 * read back as a color tag, a block color or an equation.
 */
const PLACEHOLDER_CHARS = /[\uE000\uE001\uE010-\uE014]/g;

export function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_CHARS, '');
}

/** Same, for every text run (and string prop) of a block tree; returns whether something was removed. */
export function stripPlaceholderText<T>(value: T): { value: T; stripped: boolean } {
  let stripped = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const out = stripPlaceholders(v);
      if (out !== v) stripped = true;
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, stripped };
}

export interface ColorPair {
  text?: string;
  background?: string;
}

const NAMES = new Set<string>(COLORS.filter((c) => c !== 'default'));
export const isColorName = (v: unknown): v is string => typeof v === 'string' && NAMES.has(v);

interface Item {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  content?: unknown;
  [key: string]: unknown;
}

interface BlockJson {
  type?: string;
  content?: unknown;
  children?: unknown[];
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ProtectedColors {
  md: string;
  /** Colors of span openings, by placeholder index. */
  spans: ColorPair[];
  /** Colors of block markers, by placeholder index. */
  blocks: ColorPair[];
  /** French notes (unknown color names). */
  warnings: Set<string>;
}

const SPAN_TAG = /^<span(\s[^<>]*)?>/i;
const SPAN_END = /^<\/span\s*>/i;
const BLOCK_TAG = /^<!--\s*oriel:color\b([^>]*?)-->/i;
const ATTR = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) out.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? '').trim());
  return out;
}

function pick(value: string | undefined, warnings: Set<string>): string | undefined {
  if (value === undefined || value === '' || value === 'default') return undefined;
  if (isColorName(value)) return value;
  warnings.add(`couleur « ${String(value).slice(0, 30)} » inconnue, ignorée (valeurs : ${[...NAMES].join(', ')})`);
  return undefined;
}

/** Color tags of a Markdown document swapped for placeholders (code left untouched). */
export function protectColors(md: string): ProtectedColors {
  const p: ProtectedColors = { md, spans: [], blocks: [], warnings: new Set() };
  if (!/<span|oriel:color/i.test(md)) return p;
  // Kinds of the open <span> tags: ours become placeholders, others stay as they are.
  const stack: boolean[] = [];
  let fence: string | null = null;
  const lines = md.split('\n').map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      return line;
    }
    if (f) {
      fence = f[1]!;
      return line;
    }
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (ch === '\\') {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') {
        // Inline code span: a run of n backticks up to the next run of exactly n backticks.
        let n = 0;
        while (line[i + n] === '`') n++;
        const run = '`'.repeat(n);
        let j = line.indexOf(run, i + n);
        while (j !== -1 && line[j + n] === '`') j = line.indexOf(run, j + n + 1);
        const end = j === -1 ? i + n : j + n;
        out += line.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '<') {
        const rest = line.slice(i);
        const block = BLOCK_TAG.exec(rest);
        if (block) {
          const a = attributes(block[1]!);
          p.blocks.push({ text: pick(a.get('text'), p.warnings), background: pick(a.get('background') ?? a.get('bg'), p.warnings) });
          out += `${BLOCK_OPEN}${p.blocks.length - 1}${BLOCK_CLOSE}`;
          i += block[0].length;
          continue;
        }
        const open = SPAN_TAG.exec(rest);
        if (open) {
          const a = attributes(open[1] ?? '');
          const ours = a.size > 0 && [...a.keys()].every((k) => k === 'data-text-color' || k === 'data-background-color');
          stack.push(ours);
          if (ours) {
            p.spans.push({ text: pick(a.get('data-text-color'), p.warnings), background: pick(a.get('data-background-color'), p.warnings) });
            out += `${SPAN_OPEN}${p.spans.length - 1}${SPAN_MID}`;
          } else out += open[0];
          i += open[0].length;
          continue;
        }
        const close = SPAN_END.exec(rest);
        if (close) {
          out += stack.pop() ? SPAN_CLOSE : close[0];
          i += close[0].length;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  });
  return { ...p, md: lines.join('\n') };
}

/** Block marker colors found in inline content (the last one wins), markers and spans applied. */
function restoreInline(content: Item[], p: ProtectedColors, stack: ColorPair[], found: { block?: ColorPair }): Item[] {
  const out: Item[] = [];
  const current = () => {
    let text: string | undefined;
    let background: string | undefined;
    for (const c of stack) {
      if (c.text) text = c.text;
      if (c.background) background = c.background;
    }
    return { text, background };
  };
  const push = (item: Item, piece: string) => {
    if (!piece) return;
    const { text, background } = current();
    const styles = { ...(item.styles ?? {}) };
    if (text) styles.textColor = text;
    if (background) styles.backgroundColor = background;
    out.push({ ...item, text: piece, styles });
  };
  for (const item of content) {
    if (item.type === 'link' && Array.isArray(item.content)) {
      out.push({ ...item, content: restoreInline(item.content as Item[], p, stack, found) });
      continue;
    }
    if (item.type !== 'text' || typeof item.text !== 'string') {
      out.push(item);
      continue;
    }
    if (item.styles?.code && !/[-]/.test(item.text)) {
      push(item, item.text);
      continue;
    }
    let last = 0;
    for (const m of item.text.matchAll(MARKERS)) {
      push(item, item.text.slice(last, m.index));
      last = m.index! + m[0].length;
      if (m[1] !== undefined) stack.push(p.spans[Number(m[1])] ?? {});
      else if (m[2] !== undefined) found.block = p.blocks[Number(m[2])] ?? {};
      else stack.pop();
    }
    push(item, item.text.slice(last));
  }
  return out;
}

/** Trailing whitespace left before a block marker (`Texte <!-- … -->`). */
function trimEnd(content: Item[]): Item[] {
  const out = [...content];
  while (out.length) {
    const last = out[out.length - 1]!;
    if (last.type !== 'text' || typeof last.text !== 'string') break;
    const t = last.text.replace(/[ \t]+$/, '');
    if (t) {
      out[out.length - 1] = { ...last, text: t };
      break;
    }
    out.pop();
  }
  return out;
}

function restoreTable(content: unknown, p: ProtectedColors): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (Array.isArray(cell)) return restoreInline(cell as Item[], p, [], {});
        const c = cell as { content?: unknown };
        return c && Array.isArray(c.content) ? { ...c, content: restoreInline(c.content as Item[], p, [], {}) } : cell;
      }),
    })),
  };
}

/** Parsed blocks of a protected document: placeholders → text styles and block props. */
export function restoreColors<T extends BlockJson>(blocks: T[], p: ProtectedColors): T[] {
  if (p.spans.length === 0 && p.blocks.length === 0) return blocks;
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? restoreColors(b.children as T[], p) : b.children;
    if (b.type === 'table') return { ...b, content: restoreTable(b.content, p), children };
    if (!Array.isArray(b.content) || b.type === 'codeBlock') return { ...b, children };
    const found: { block?: ColorPair } = {};
    let content = restoreInline(b.content as Item[], p, [], found);
    if (!found.block) return { ...b, content, children };
    content = trimEnd(content);
    const props = { ...(b.props ?? {}) };
    if (found.block.text) props.textColor = found.block.text;
    if (found.block.background) props.backgroundColor = found.block.background;
    return { ...b, props, content, children };
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const colorOf = (v: unknown) => (isColorName(v) ? v : undefined);

/** `<span …>` opening tag of a color pair. */
export function spanTag(c: ColorPair): string {
  return `<span${c.text ? ` data-text-color="${c.text}"` : ''}${c.background ? ` data-background-color="${c.background}"` : ''}>`;
}

/** `<!-- oriel:color … -->` comment of a block color pair. */
export function blockComment(c: ColorPair): string {
  return `<!-- oriel:color${c.text ? ` text=${c.text}` : ''}${c.background ? ` background=${c.background}` : ''} -->`;
}

/** Colors of a block (non-default text / background props), or null. */
export function blockColors(props: Record<string, unknown> | undefined): ColorPair | null {
  const text = colorOf(props?.textColor);
  const background = colorOf(props?.backgroundColor);
  return text || background ? { text, background } : null;
}

/** Colors of a text item, and its styles without them. */
export function splitColors(styles: Record<string, unknown> | undefined): { colors: ColorPair | null; styles: Record<string, unknown> } {
  const { textColor, backgroundColor, ...rest } = styles ?? {};
  const text = colorOf(textColor);
  const background = colorOf(backgroundColor);
  return { colors: text || background ? { text, background } : null, styles: rest };
}

const sameColors = (a: ColorPair | null, b: ColorPair | null) => (a?.text ?? '') === (b?.text ?? '') && (a?.background ?? '') === (b?.background ?? '');

function encodeInline(content: unknown, spans: ColorPair[]): unknown {
  if (!Array.isArray(content)) return content;
  const out: Item[] = [];
  let open: ColorPair | null = null;
  const close = () => {
    if (open) out.push({ type: 'text', text: SPAN_CLOSE, styles: {} });
    open = null;
  };
  for (const item of content as Item[]) {
    if (item.type === 'link') {
      // A link whose text has one color is wrapped whole (a span inside the label would split it).
      const inner = Array.isArray(item.content) ? (item.content as Item[]) : [];
      const each = inner.map((c) => splitColors(c.styles));
      const uniform = each.length > 0 && each.every((c) => sameColors(c.colors, each[0]!.colors));
      if (!uniform) {
        close();
        out.push({ ...item, content: encodeInline(item.content, spans) });
        continue;
      }
      const colors = each[0]!.colors;
      if (!sameColors(colors, open)) {
        close();
        if (colors) {
          spans.push(colors);
          out.push({ type: 'text', text: `${SPAN_OPEN}${spans.length - 1}${SPAN_MID}`, styles: {} });
          open = colors;
        }
      }
      out.push({ ...item, content: inner.map((c, i) => ({ ...c, styles: each[i]!.styles })) });
      continue;
    }
    if (item.type !== 'text') {
      close();
      out.push(item);
      continue;
    }
    const { colors, styles } = splitColors(item.styles);
    if (!sameColors(colors, open)) {
      close();
      if (colors) {
        spans.push(colors);
        out.push({ type: 'text', text: `${SPAN_OPEN}${spans.length - 1}${SPAN_MID}`, styles: {} });
        open = colors;
      }
    }
    out.push({ ...item, styles });
  }
  close();
  return out;
}

function encodeTable(content: unknown, spans: ColorPair[]): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (Array.isArray(cell)) return encodeInline(cell, spans);
        const c = cell as { content?: unknown };
        return c && Array.isArray(c.content) ? { ...c, content: encodeInline(c.content, spans) } : cell;
      }),
    })),
  };
}

/**
 * Colors of blocks swapped for placeholder text before Markdown serialization; `decode` turns the
 * serialized placeholders into `<span …>` tags and `<!-- oriel:color … -->` comments. Block colors
 * are kept for blocks with inline text (not code blocks, tables, media…).
 */
export function encodeColors<T extends BlockJson>(blocks: T[]): { blocks: T[]; decode: (md: string) => string } {
  const spans: ColorPair[] = [];
  const marks: ColorPair[] = [];
  const walk = (list: T[]): T[] =>
    list.map((b) => {
      const children = Array.isArray(b.children) ? walk(b.children as T[]) : b.children;
      if (b.type === 'table') return { ...b, content: encodeTable(b.content, spans), children };
      if (!Array.isArray(b.content) || b.type === 'codeBlock') return { ...b, children };
      let content = encodeInline(b.content, spans) as Item[];
      const colors = blockColors(b.props);
      if (colors) {
        marks.push(colors);
        content = [...content, { type: 'text', text: `${BLOCK_OPEN}${marks.length - 1}${BLOCK_CLOSE}`, styles: {} }];
      }
      return { ...b, content, children };
    });
  const out = walk(blocks);
  const decode = (md: string) => {
    if (spans.length === 0 && marks.length === 0) return md;
    return md.replace(MARKERS, (all, span: string | undefined, block: string | undefined, offset: number, whole: string) => {
      if (span !== undefined) return spanTag(spans[Number(span)] ?? {});
      if (block !== undefined) {
        const c = marks[Number(block)];
        if (!c) return '';
        const lineStart = offset === 0 || whole[offset - 1] === '\n' || /^[ \t]$/.test(whole[offset - 1] ?? '');
        return `${lineStart ? '' : ' '}${blockComment(c)}`;
      }
      return all === SPAN_CLOSE ? '</span>' : all;
    });
  };
  return { blocks: out, decode };
}
