// Bundles the server into a single CommonJS file: dist/server.cjs.
//  - `node dist/server.cjs` starts the server;
//  - `require('dist/server.cjs').startServer` is exported without auto-starting (Electron).
// Every npm dependency is bundled; Node built-ins (`node:*`, including node:sqlite) stay external.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const outfile = join(here, 'dist', 'server.cjs');

rmSync(join(here, 'dist'), { recursive: true, force: true });

const result = await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['node:*'],
  // Prefer the CommonJS/Node builds of dependencies.
  mainFields: ['main', 'module'],
  conditions: ['node', 'require', 'default'],
  define: {
    __ORIEL_BUNDLE__: 'true',
    __ORIEL_VERSION__: JSON.stringify(pkg.version),
  },
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`dist/server.cjs (${(bytes / 1024 / 1024).toFixed(2)} Mo)`);
