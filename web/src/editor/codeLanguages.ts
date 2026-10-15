// Code block languages: the keys accepted by the editor's code block, and the mapping of every alias
// (```js, ```sh, ```py, ```yml…) to its canonical key. BlockNote's code block throws ("Language js is
// not supported") when a block holds anything else, so every path that creates code blocks from
// external text (paste, Markdown import, old documents) goes through `normalizeCodeLanguage`.
// Standalone module (no app imports) so that lib/ can use it without import cycles.
import { codeBlockOptions } from '@blocknote/code-block';

export const CODE_LANGUAGES: Record<string, { name: string; aliases?: string[] }> = {
  ...codeBlockOptions.supportedLanguages,
  text: { name: 'Texte brut', aliases: ['text', 'txt', 'plain', 'plaintext', 'texte'] },
  // Rendered as a score by codeRender.ts (abcjs); no syntax highlighting grammar.
  abc: { name: 'ABC (partition)', aliases: ['abc', 'abcjs', 'abc-notation'] },
  // Typeset document rendered by codeRender.ts (typst.ts in a worker); no syntax highlighting grammar.
  typst: { name: 'Typst', aliases: ['typst', 'typ'] },
};

const EXTRA_ALIASES: Record<string, string> = {
  console: 'shellscript',
  terminal: 'shellscript',
  ps: 'shellscript',
  node: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascriptreact: 'jsx',
  json5: 'jsonc',
  htm: 'html',
  svg: 'xml',
  h: 'c',
  hpp: 'cpp',
  cxx: 'cpp',
};

const LANGUAGE_BY_ALIAS = new Map<string, string>();
for (const [key, def] of Object.entries(CODE_LANGUAGES)) {
  LANGUAGE_BY_ALIAS.set(key.toLowerCase(), key);
  for (const alias of def.aliases ?? []) LANGUAGE_BY_ALIAS.set(alias.toLowerCase(), key);
}
for (const [alias, key] of Object.entries(EXTRA_ALIASES)) if (key in CODE_LANGUAGES) LANGUAGE_BY_ALIAS.set(alias, key);

/** Canonical code block language for any alias (```js → javascript, ```sh → shellscript); unknown → 'text'. */
export function normalizeCodeLanguage(language: unknown): string {
  if (typeof language !== 'string') return 'text';
  const l = language.trim().toLowerCase();
  if (!l) return 'text';
  return LANGUAGE_BY_ALIAS.get(l) ?? 'text';
}

/** Recursively normalizes code block languages of parsed blocks (Markdown import, paste). */
export function normalizeCodeBlocks<T extends { type?: string; props?: Record<string, unknown>; children?: unknown[] }>(blocks: T[]): T[] {
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? normalizeCodeBlocks(b.children as T[]) : b.children;
    if (b.type !== 'codeBlock') return { ...b, children };
    return { ...b, children, props: { ...(b.props ?? {}), language: normalizeCodeLanguage(b.props?.language) } };
  });
}

/**
 * Rewrites the info string of every opening code fence of a Markdown text to a canonical language key
 * (```js → ```javascript, unknown → ```text). Fences nested inside a fenced block are left alone.
 */
export function normalizeMarkdownFences(markdown: string): string {
  let open: { char: string; length: number } | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) return line;
      const [, indent, fence, rest] = m as unknown as [string, string, string, string];
      if (open) {
        // Closing fence: same character, at least as long, nothing but spaces after it.
        if (fence[0] === open.char && fence.length >= open.length && rest.trim() === '') open = null;
        return line;
      }
      if (fence[0] === '`' && rest.includes('`')) return line; // not a fence (inline code)
      open = { char: fence[0]!, length: fence.length };
      const info = rest.trim();
      if (!info) return line;
      const [lang, ...attrs] = info.split(/\s+/);
      const canonical = normalizeCodeLanguage(lang);
      return `${indent}${fence}${canonical}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
    })
    .join('\n');
}
