// Bundles the MCP server into dist/oriel-mcp.mjs (ESM, Node ≥ 22).
// Bundled: the MCP SDK, zod, @oriel/shared, the web client's database logic (filters, formulas,
// rollups) and embed detection. Kept as runtime dependencies (resolved from node_modules next to the
// checkout): the BlockNote stack (+ jsdom, React, ProseMirror, Tiptap) and yjs, which must stay a
// single instance shared with BlockNote.
import { build } from 'esbuild';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const outfile = join(here, 'dist', 'oriel-mcp.mjs');

rmSync(join(here, 'dist'), { recursive: true, force: true });

const result = await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['node:*', '@blocknote/*', 'jsdom', 'react', 'react-dom', 'react/*', 'react-dom/*', 'yjs', 'y-prosemirror', 'prosemirror-*', '@tiptap/*'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      `// Oriel MCP server ${pkg.version} — AGPL-3.0-or-later`,
      "import { createRequire as __bqCreateRequire } from 'node:module';",
      'const require = __bqCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
});
chmodSync(outfile, 0o755);

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`dist/oriel-mcp.mjs (${(bytes / 1024 / 1024).toFixed(2)} Mo)`);
