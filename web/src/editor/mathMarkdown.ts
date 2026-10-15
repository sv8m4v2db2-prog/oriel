// Equations in Markdown (pure, unit-tested): `$$…$$` ⇄ equation block, `$…$` ⇄ inline equation.
//
// The TeX source never goes through the Markdown parser or serializer, which would eat its backslash
// escapes (`\{`, `\\`) and escape its `_` / `*`: equations are swapped for private-use placeholders
// before parsing / serializing, and put back afterwards.
//  - import: protectMarkdownMath(md) → parse the Markdown → restoreMarkdownMath(blocks, protected)
//  - export: encodeMathBlocks(blocks) → serialize the blocks → decode(markdown)

import { mayHoldFootnote, protectMarkdownFootnotes, restoreMarkdownFootnotes } from './footnoteMarkdown';

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

/** Longest TeX source kept (same bound as the editor and the server text extraction). */
export const MAX_TEX = 4000;

/**
 * KaTeX options of every rendering (editor, preview, HTML export). The output is inserted as HTML, so:
 * `trust: false` refuses \href, \url, \includegraphics and \htmlClass / \htmlId / \htmlStyle /
 * \htmlData (rendered as errors in red, never as links or attributes); `maxSize` (em) and `maxExpand`
 * (macro expansions) bound the cost of a forged source, whose length is bounded by MAX_TEX.
 */
export const KATEX_OPTIONS = { throwOnError: true, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 500 } as const;

/**
 * Macro definitions (\def, \gdef, \edef, \xdef, \let, \futurelet, \global, \newcommand,
 * \renewcommand, \providecommand), refused before KaTeX runs (QA-EDT-04): `maxExpand` counts
 * expansions, not the tokens they produce, so `\gdef\b#1{#1…#1}\b{\b{x…x}}` (k copies, 2 + k
 * expansions) yields k² copies of its argument. About 200 characters froze every reader's tab for
 * 30 seconds, minutes at 300; published pages and the HTML export included. Control words are
 * letters and `@` (KaTeX's lexer), hence the lookahead (`\left`, `\leftarrow` are not `\let`).
 */
const MACRO_DEFINITION = /\\(?:[egx]?def|let|futurelet|global|(?:re)?newcommand|providecommand)(?![A-Za-z@])/;

/** Why a TeX source is not rendered (French, shown in place of the equation), or null. */
export function texRefusal(tex: string): string | null {
  return MACRO_DEFINITION.test(tex) ? 'les définitions de macros (\\def, \\newcommand…) ne sont pas prises en charge' : null;
}

const OPEN = '';
const CLOSE = '';
const placeholder = (kind: 'D' | 'I', n: number) => `${OPEN}${kind}${n}${CLOSE}`;
const PLACEHOLDER = /([DI])(\d+)/g;
const LONE_DISPLAY = /^\s*D(\d+)\s*$/;

/**
 * Inline `$tex$` in a text run (Pandoc rules: no space just inside the dollars, closing `$` not followed
 * by a digit, `\$` is a literal dollar): returns text and equation segments.
 */
export function splitInlineMath(text: string): Array<{ text: string } | { tex: string }> {
  const out: Array<{ text: string } | { tex: string }> = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && text[i + 1] === '$') {
      buf += '\\$';
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] !== '$' && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
      // Find the closing dollar.
      let j = i + 1;
      while (j < text.length && !(text[j] === '$' && text[j - 1] !== '\\')) j++;
      const tex = text.slice(i + 1, j);
      const closeOk = j < text.length && !/\s/.test(text[j - 1]!) && !/\d/.test(text[j + 1] ?? '') && tex.length > 0;
      if (closeOk) {
        if (buf) out.push({ text: buf });
        buf = '';
        out.push({ tex });
        i = j + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ text: buf });
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ProtectedMath {
  md: string;
  /** TeX of the placeholders, by kind and index. */
  display: string[];
  inline: string[];
}

/** `$$tex$$` and `$tex$` of one line of text, outside inline code spans. */
function protectLine(line: string, p: ProtectedMath): string {
  let out = '';
  let i = 0;
  let text = '';
  const flushText = () => {
    if (!text) return;
    // `$$tex$$` inside a line (a nested list item, a sentence) first, then `$tex$`.
    const parts = text.split(/(\$\$(?:[^$\\]|\\[\s\S])+?\$\$)/);
    for (const part of parts) {
      const d = /^\$\$([\s\S]+)\$\$$/.exec(part);
      if (d && d[1]!.trim()) {
        p.display.push(d[1]!.trim());
        out += placeholder('D', p.display.length - 1);
        continue;
      }
      for (const seg of splitInlineMath(part)) {
        if ('tex' in seg) {
          p.inline.push(seg.tex);
          out += placeholder('I', p.inline.length - 1);
        } else out += seg.text;
      }
    }
    text = '';
  };
  while (i < line.length) {
    if (line[i] === '`') {
      // Inline code span: a run of n backticks up to the next run of exactly n backticks.
      let n = 0;
      while (line[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = line.indexOf(fence, i + n);
      while (j !== -1 && line[j + n] === '`') j = line.indexOf(fence, j + n + 1);
      if (j === -1) {
        text += fence;
        i += n;
        continue;
      }
      flushText();
      out += line.slice(i, j + n);
      i = j + n;
      continue;
    }
    text += line[i];
    i++;
  }
  flushText();
  return out;
}

/** Equations of a Markdown document swapped for placeholders (fenced code left untouched). */
export function protectMarkdownMath(md: string): ProtectedMath {
  const p: ProtectedMath = { md: '', display: [], inline: [] };
  if (!md.includes('$')) return { ...p, md };
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
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
    // Display equation over several lines: `$$` opening a line, up to the line ending with `$$`.
    const open = /^( {0,3})\$\$(.*)$/.exec(line);
    if (open && !open[2]!.includes('$$')) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trimEnd().endsWith('$$')) j++;
      if (j < lines.length) {
        const body = [open[2]!, ...lines.slice(i + 1, j), lines[j]!.trimEnd().slice(0, -2)].join('\n').trim();
        if (body) {
          p.display.push(body);
          if (out.length && out[out.length - 1]!.trim()) out.push('');
          out.push(open[1]! + placeholder('D', p.display.length - 1));
          out.push('');
          i = j;
          continue;
        }
      }
    }
    out.push(protectLine(line, p));
  }
  return { ...p, md: out.join('\n') };
}

const clampTex = (tex: string) => tex.slice(0, MAX_TEX);

/** Text item with placeholders → text / inline equations (code spans get their source back). */
function restoreInline(content: InlineItem[], p: ProtectedMath): InlineItem[] {
  const out: InlineItem[] = [];
  for (const item of content) {
    if (item.type === 'link' && Array.isArray(item.content)) {
      // Equations cannot live inside a link: their source is put back as text.
      out.push({ ...item, content: (item.content as InlineItem[]).map((c) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: sourceText(c.text, p) } : c)) });
      continue;
    }
    if (item.type !== 'text' || typeof item.text !== 'string' || !item.text.includes(OPEN)) {
      out.push(item);
      continue;
    }
    if (item.styles?.code) {
      out.push({ ...item, text: sourceText(item.text, p) });
      continue;
    }
    let last = 0;
    for (const m of item.text.matchAll(PLACEHOLDER)) {
      const tex = (m[1] === 'D' ? p.display : p.inline)[Number(m[2])];
      if (tex === undefined) continue;
      if (m.index! > last) out.push({ ...item, text: item.text.slice(last, m.index) });
      out.push({ type: 'inlineEquation', props: { tex: clampTex(tex) } });
      last = m.index! + m[0].length;
    }
    if (last < item.text.length) out.push({ ...item, text: item.text.slice(last) });
  }
  return out;
}

/** Placeholders of a plain string → their Markdown source. */
function sourceText(text: string, p: ProtectedMath): string {
  return text.replace(PLACEHOLDER, (all, kind: string, n: string) => {
    const tex = (kind === 'D' ? p.display : p.inline)[Number(n)];
    return tex === undefined ? all : kind === 'D' ? `$$${tex}$$` : `$${tex}$`;
  });
}

function restoreTable(content: unknown, p: ProtectedMath): unknown {
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

/** Parsed blocks of a protected document: placeholders → equation blocks / inline equations. */
export function restoreMarkdownMath<T extends BlockJson>(blocks: T[], p: ProtectedMath): T[] {
  if (p.display.length === 0 && p.inline.length === 0) return blocks;
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? restoreMarkdownMath(b.children as T[], p) : b.children;
    if (b.type === 'codeBlock' && Array.isArray(b.content)) {
      return { ...b, content: (b.content as InlineItem[]).map((c) => (typeof c.text === 'string' ? { ...c, text: sourceText(c.text, p) } : c)), children };
    }
    if (b.type === 'paragraph' && Array.isArray(b.content)) {
      const items = b.content as InlineItem[];
      const lone = items.length === 1 && items[0]!.type === 'text' && !items[0]!.styles?.code ? LONE_DISPLAY.exec(items[0]!.text ?? '') : null;
      const tex = lone ? p.display[Number(lone[1])] : undefined;
      if (tex !== undefined) {
        const { content: _content, ...rest } = b;
        return { ...rest, type: 'equation', props: { tex: clampTex(tex) }, children } as unknown as T;
      }
    }
    if (b.type === 'table') return { ...b, content: restoreTable(b.content, p), children };
    if (Array.isArray(b.content)) return { ...b, content: restoreInline(b.content as InlineItem[], p), children };
    return { ...b, children };
  });
}

/**
 * Markdown → blocks with equations (and, since H5, footnotes `[^n]`), `parse` being the Markdown parser
 * (BlockNote's). The name is historical: every special syntax of the editor goes through here.
 */
export function parseMarkdownWithMath<T extends BlockJson>(md: string, parse: (md: string) => T[]): T[] {
  const notes = protectMarkdownFootnotes(md);
  const p = protectMarkdownMath(notes.md);
  return restoreMarkdownFootnotes(restoreMarkdownMath(parse(p.md), p), notes);
}

/** The text may hold an equation or a footnote (cheap test before parsing pasted text). */
export const mayHoldMath = (text: string) => /\$[^\s$]|\$\$/.test(text) || mayHoldFootnote(text);

/**
 * Plain text of a paste that may hold equations: only text (no HTML, no BlockNote copy, no file),
 * else null.
 */
export function pastedMarkdownMath(event: { clipboardData: { types: readonly string[]; getData(type: string): string } | null }): string | null {
  const data = event.clipboardData;
  if (!data) return null;
  const types = [...data.types];
  if (types.some((t) => t !== 'text/plain' && t !== 'text/markdown')) return null;
  const text = data.getData('text/markdown') || data.getData('text/plain');
  return text && mayHoldMath(text) ? text : null;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Markdown of an equation block / inline equation. */
export const displayMathMarkdown = (tex: string) => `$$${tex.trim().replace(/\$\$/g, '$ $')}$$`;
export const inlineMathMarkdown = (tex: string) => `$${tex.trim().replace(/\s+/g, ' ').replace(/(^|[^\\])\$/g, '$1\\$')}$`;

function encodeInline(content: unknown, texs: string[]): unknown {
  if (!Array.isArray(content)) return content;
  return (content as InlineItem[]).map((c) => {
    if (c.type !== 'inlineEquation') return c;
    const tex = typeof c.props?.tex === 'string' ? c.props.tex : '';
    texs.push(tex);
    return { type: 'text', text: placeholder('I', texs.length - 1), styles: {} };
  });
}

function encodeTable(content: unknown, texs: string[]): unknown {
  const table = content as { type?: string; rows?: Array<{ cells: unknown[] }> };
  if (!table || table.type !== 'tableContent' || !Array.isArray(table.rows)) return content;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => {
        if (Array.isArray(cell)) return encodeInline(cell, texs);
        const c = cell as { content?: unknown };
        return c && Array.isArray(c.content) ? { ...c, content: encodeInline(c.content, texs) } : cell;
      }),
    })),
  };
}

/**
 * Equations of blocks swapped for placeholder text before Markdown serialization; `decode` turns the
 * serialized placeholders into `$$…$$` / `$…$`.
 */
export function encodeMathBlocks<T extends BlockJson>(blocks: T[]): { blocks: T[]; decode: (md: string) => string } {
  const display: string[] = [];
  const inline: string[] = [];
  const walk = (list: T[]): T[] =>
    list.map((b) => {
      const children = Array.isArray(b.children) ? walk(b.children as T[]) : b.children;
      if (b.type === 'equation') {
        display.push(typeof b.props?.tex === 'string' ? b.props.tex : '');
        return { type: 'paragraph', props: {}, content: [{ type: 'text', text: placeholder('D', display.length - 1), styles: {} }], children } as unknown as T;
      }
      if (b.type === 'table') return { ...b, content: encodeTable(b.content, inline), children };
      if (Array.isArray(b.content)) return { ...b, content: encodeInline(b.content, inline), children };
      return { ...b, children };
    });
  const out = walk(blocks);
  const decode = (md: string) => {
    if (display.length === 0 && inline.length === 0) return md;
    return md
      .split('\n')
      .map((line) => {
        const lone = /^(\s*)D(\d+)\s*$/.exec(line);
        if (lone) {
          const tex = (display[Number(lone[2])] ?? '').trim();
          if (!tex) return '';
          // Top level: the source keeps its lines; nested (list item…): one line.
          if (!lone[1] && tex.includes('\n')) return `$$\n${tex}\n$$`;
          return lone[1] + displayMathMarkdown(tex.replace(/\s*\n\s*/g, ' '));
        }
        return line.replace(PLACEHOLDER, (all, kind: string, n: string) => {
          const tex = (kind === 'D' ? display : inline)[Number(n)];
          if (tex === undefined) return all;
          if (!tex.trim()) return '';
          return kind === 'D' ? displayMathMarkdown(tex.replace(/\s*\n\s*/g, ' ')) : inlineMathMarkdown(tex);
        });
      })
      .join('\n');
  };
  return { blocks: out, decode };
}

