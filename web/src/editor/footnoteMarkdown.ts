// Footnotes in Markdown (pure, unit-tested): `[^1]` references with `[^1]: text` definitions ⇄ `footnote`
// inline content (props.note). Same technique as mathMarkdown.ts: the references are swapped for private-use
// placeholders around the Markdown parser / serializer, which would otherwise escape or drop them.
//  - export: encodeFootnoteBlocks(blocks) → serialize the blocks → decode(markdown)
//  - import: protectMarkdownFootnotes(md) → parse the Markdown → restoreMarkdownFootnotes(blocks, protected)
import { EDITOR_BLOCK_TYPES, FOOTNOTE_MAX_LENGTH } from '@oriel/shared';

interface InlineItem {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  props?: Record<string, unknown>;
  content?: unknown;
  [key: string]: unknown;
}

interface BlockJson {
  type?: string;
  content?: unknown;
  children?: unknown[];
  props?: Record<string, unknown>;
}

const OPEN = '';
const CLOSE = '';
const PLACEHOLDER = /F(\d+)/g;
const placeholder = (n: number) => `${OPEN}F${n}${CLOSE}`;

/** A footnote text as stored: one line, bounded. */
export function clampNote(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s*\n\s*/g, ' ').slice(0, FOOTNOTE_MAX_LENGTH) : '';
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function encodeInline(content: unknown, notes: string[]): unknown {
  if (!Array.isArray(content)) return content;
  return (content as InlineItem[]).map((c) => {
    if (c.type === EDITOR_BLOCK_TYPES.footnote) {
      notes.push(clampNote(c.props?.note));
      return { type: 'text', text: placeholder(notes.length - 1), styles: {} };
    }
    // Links may hold content too (never footnotes in practice).
    if (c.type === 'link' && Array.isArray(c.content)) return { ...c, content: encodeInline(c.content, notes) };
    return c;
  });
}

function encodeTable(content: unknown, notes: string[]): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (Array.isArray(cell)) return encodeInline(cell, notes);
        const c = cell as { content?: unknown };
        return c && Array.isArray(c.content) ? { ...c, content: encodeInline(c.content, notes) } : cell;
      }),
    })),
  };
}

/**
 * Footnotes of blocks swapped for placeholder text before Markdown serialization (in document order);
 * `decode` turns the serialized placeholders into `[^n]` and appends the definitions.
 */
export function encodeFootnoteBlocks<T extends BlockJson>(blocks: T[]): { blocks: T[]; decode: (md: string) => string } {
  const notes: string[] = [];
  const walk = (list: T[]): T[] =>
    list.map((b) => {
      const content = b.type === 'table' ? encodeTable(b.content, notes) : encodeInline(b.content, notes);
      const children = Array.isArray(b.children) ? walk(b.children as T[]) : b.children;
      return content === b.content && children === b.children ? b : ({ ...b, content, children } as T);
    });
  const out = walk(blocks);
  const decode = (md: string) => {
    if (notes.length === 0) return md;
    // Numbers are document-wide; only the notes referenced by this chunk get their definition (a
    // document may be serialized in several runs, e.g. around toggles).
    const used = new Set<number>();
    const body = md.replace(PLACEHOLDER, (all, n: string) => {
      if (notes[Number(n)] === undefined) return all;
      used.add(Number(n));
      return `[^${Number(n) + 1}]`;
    });
    if (used.size === 0) return body;
    const defs = [...used].sort((a, b) => a - b).map((i) => `[^${i + 1}]: ${notes[i]}`).join('\n');
    return `${body.replace(/\s+$/, '')}\n\n${defs}\n`;
  };
  return { blocks: out, decode };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ProtectedFootnotes {
  md: string;
  /** By placeholder index: the reference as written (`[^label]`) and the note text. */
  refs: Array<{ source: string; note: string }>;
}

const DEFINITION = /^ {0,3}\[\^([^\]\s]{1,60})\]:[ \t]*(.*)$/;
const REFERENCE = /\[\^([^\]\s]{1,60})\](?!:)/g;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Note text of a Markdown definition: links flattened, one line, bounded. */
function definitionText(raw: string): string {
  return clampNote(
    raw
      .replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_, label: string, url: string) => (label && url ? `${label} (${url})` : label || url))
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** Applies `fn` to the parts of a line outside inline code spans. */
function outsideCode(line: string, fn: (text: string) => string): string {
  let out = '';
  let i = 0;
  let text = '';
  while (i < line.length) {
    if (line[i] === '`') {
      let n = 0;
      while (line[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = line.indexOf(fence, i + n);
      while (j !== -1 && line[j + n] === '`') j = line.indexOf(fence, j + n + 1);
      if (j !== -1) {
        out += fn(text) + line.slice(i, j + n);
        text = '';
        i = j + n;
        continue;
      }
      text += fence;
      i += n;
      continue;
    }
    text += line[i];
    i++;
  }
  return out + fn(text);
}

/** Footnote references and definitions of a Markdown document swapped for placeholders (code left alone). */
export function protectMarkdownFootnotes(md: string): ProtectedFootnotes {
  if (!md.includes('[^')) return { md, refs: [] };
  const lines = md.split('\n');
  // Pass 1: definitions (outside fences), with their indented continuation lines.
  const defs = new Map<string, { note: string; start: number; end: number }>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const d = DEFINITION.exec(line);
    if (!d || defs.has(d[1]!)) continue;
    let end = i;
    let text = d[2]!;
    while (end + 1 < lines.length && /^( {4}|\t)\S/.test(lines[end + 1]!)) {
      end++;
      text += ` ${lines[end]!.trim()}`;
    }
    defs.set(d[1]!, { note: definitionText(text), start: i, end });
    i = end;
  }
  if (defs.size === 0) return { md, refs: [] };
  // Pass 2: references to a defined label become placeholders; a definition that is referenced is removed.
  const refs: ProtectedFootnotes['refs'] = [];
  const referenced = new Set<string>();
  const dropped = new Set<number>();
  const defLines = new Map<number, string>();
  for (const [label, d] of defs) for (let k = d.start; k <= d.end; k++) defLines.set(k, label);
  const out: string[] = [];
  fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      continue;
    }
    if (defLines.has(i)) {
      out.push(line); // decided below, once every reference is known
      continue;
    }
    out.push(
      outsideCode(line, (text) =>
        text.replace(REFERENCE, (all, label: string) => {
          const d = defs.get(label);
          if (!d) return all;
          referenced.add(label);
          refs.push({ source: all, note: d.note });
          return placeholder(refs.length - 1);
        }),
      ),
    );
  }
  for (const [i, label] of defLines) if (referenced.has(label)) dropped.add(i);
  return { md: out.filter((_, i) => !dropped.has(i)).join('\n'), refs };
}

/** Text item holding placeholders → text and footnote items (code spans get their source back). */
function restoreInline(content: InlineItem[], p: ProtectedFootnotes): InlineItem[] {
  const source = (text: string) => text.replace(PLACEHOLDER, (all, n: string) => p.refs[Number(n)]?.source ?? all);
  const out: InlineItem[] = [];
  for (const item of content) {
    if (item.type === 'link' && Array.isArray(item.content)) {
      out.push({ ...item, content: (item.content as InlineItem[]).map((c) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: source(c.text) } : c)) });
      continue;
    }
    if (item.type !== 'text' || typeof item.text !== 'string' || !item.text.includes(OPEN)) {
      out.push(item);
      continue;
    }
    if (item.styles?.code) {
      out.push({ ...item, text: source(item.text) });
      continue;
    }
    let last = 0;
    for (const m of item.text.matchAll(PLACEHOLDER)) {
      const ref = p.refs[Number(m[1])];
      if (!ref) continue;
      if (m.index! > last) out.push({ ...item, text: item.text.slice(last, m.index) });
      out.push({ type: EDITOR_BLOCK_TYPES.footnote, props: { note: ref.note } });
      last = m.index! + m[0].length;
    }
    if (last < item.text.length) out.push({ ...item, text: item.text.slice(last) });
  }
  return out;
}

function restoreTable(content: unknown, p: ProtectedFootnotes): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (Array.isArray(cell)) return restoreInline(cell as InlineItem[], p);
        const c = cell as { content?: unknown };
        return c && Array.isArray(c.content) ? { ...c, content: restoreInline(c.content as InlineItem[], p) } : cell;
      }),
    })),
  };
}

/** Parsed blocks of a protected document: placeholders → footnotes. */
export function restoreMarkdownFootnotes<T extends BlockJson>(blocks: T[], p: ProtectedFootnotes): T[] {
  if (p.refs.length === 0) return blocks;
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? restoreMarkdownFootnotes(b.children as T[], p) : b.children;
    if (b.type === 'codeBlock' && Array.isArray(b.content)) {
      return {
        ...b,
        content: (b.content as InlineItem[]).map((c) => (typeof c.text === 'string' ? { ...c, text: c.text.replace(PLACEHOLDER, (all, n: string) => p.refs[Number(n)]?.source ?? all) } : c)),
        children,
      };
    }
    if (b.type === 'table') return { ...b, content: restoreTable(b.content, p), children };
    if (Array.isArray(b.content)) return { ...b, content: restoreInline(b.content as InlineItem[], p), children };
    return { ...b, children };
  });
}

/** The text may hold a footnote reference (cheap test before parsing pasted text). */
export const mayHoldFootnote = (text: string) => /\[\^[^\]\s]{1,60}\]/.test(text);
