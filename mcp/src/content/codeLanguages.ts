// Canonical code block languages (keys of @blocknote/code-block's supported languages, as used by the
// web editor) by alias: ```js → javascript, ```sh → shellscript; unknown → 'text'.
// test/schema-mirror.test.ts checks every canonical key against @blocknote/code-block.
const LANGUAGES: Record<string, string[]> = {
  text: ['txt', 'plain', 'plaintext', 'texte'],
  c: ['h'],
  cpp: ['c++', 'hpp', 'cxx', 'cc'],
  css: [],
  glsl: [],
  graphql: ['gql'],
  haml: [],
  html: ['htm'],
  java: [],
  javascript: ['js', 'node', 'mjs', 'cjs'],
  json: [],
  jsonc: ['json5'],
  jsonl: [],
  jsx: ['javascriptreact'],
  julia: ['jl'],
  less: [],
  markdown: ['md'],
  mdx: [],
  php: [],
  postcss: [],
  pug: ['jade'],
  python: ['py'],
  r: [],
  regexp: ['regex'],
  sass: [],
  scss: [],
  shellscript: ['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'ps'],
  sql: [],
  svelte: [],
  typescript: ['ts'],
  vue: [],
  'vue-html': [],
  wasm: [],
  wgsl: [],
  xml: ['svg'],
  yaml: ['yml'],
  tsx: ['typescriptreact'],
  haskell: ['hs'],
  csharp: ['c#', 'cs'],
  latex: ['tex'],
  lua: [],
  mermaid: ['mmd'],
  ruby: ['rb'],
  rust: ['rs'],
  scala: [],
  swift: [],
  kotlin: ['kt', 'kts'],
  'objective-c': ['objc'],
};

export const CANONICAL_LANGUAGES = Object.keys(LANGUAGES);

/**
 * Languages the web editor adds to BlockNote's (shown as a score / typeset document by the code block
 * render, web/src/editor/codeLanguages.ts). Kept as they are through the MCP, but not canonical keys of
 * @blocknote/code-block (see test/schema-mirror.test.ts).
 */
const RENDERED_LANGUAGES: Record<string, string[]> = {
  abc: ['abcjs', 'abc-notation'],
  typst: ['typ'],
};

const BY_ALIAS = new Map<string, string>();
for (const [key, aliases] of Object.entries(LANGUAGES)) {
  BY_ALIAS.set(key, key);
  for (const a of aliases) BY_ALIAS.set(a, key);
}

for (const [key, aliases] of Object.entries(RENDERED_LANGUAGES)) {
  BY_ALIAS.set(key, key);
  for (const a of aliases) BY_ALIAS.set(a, key);
}

export function normalizeCodeLanguage(language: unknown): string {
  if (typeof language !== 'string') return 'text';
  return BY_ALIAS.get(language.trim().toLowerCase()) ?? 'text';
}
