#!/usr/bin/env node
// Builds the Electron shell into desktop/dist:
//   src/main.ts           → dist/main.cjs           (main process, Node/CommonJS)
//   src/preload.ts        → dist/preload.cjs        (app windows, sandboxed preload)
//   src/setup-preload.ts  → dist/setup-preload.cjs  (setup window, sandboxed preload)
//   src/tabs-preload.ts, src/quick-preload.ts → dist/*.cjs (tab bar and quick search pages)
//   src/pages/*.ts        → dist/*.js               (scripts of the local setup/status pages)
//   src/*.html, src/assets/**, build/icon.svg → copied as-is
//
// Flags:
//   --check-resources  fail unless ../server/dist/server.cjs and ../web/dist/index.html exist
//                      (used before packaging: the .app embeds them for the local mode)
//   --minify           minify the bundles
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const args = new Set(process.argv.slice(2));
const minify = args.has('--minify');

if (args.has('--check-resources')) {
  const required = [
    ['../server/dist/server.cjs', 'npm run build -w server'],
    ['../web/dist/index.html', 'npm run build -w web'],
  ];
  const missing = required.filter(([file]) => !existsSync(path.resolve(root, file)));
  if (missing.length > 0) {
    for (const [file, cmd] of missing) {
      console.error(`✗ ${path.resolve(root, file)} est introuvable — lancez d'abord « ${cmd} ».`);
    }
    console.error("  (ou simplement « npm run desktop:dist » depuis la racine du dépôt)");
    process.exit(1);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  minify,
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'none',
  charset: 'utf8',
};

await Promise.all([
  // Main process.
  build({
    ...common,
    entryPoints: [path.join(src, 'main.ts')],
    outfile: path.join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  // Sandboxed preloads: a single CommonJS file each, only `electron` may be required at runtime.
  ...['preload', 'setup-preload', 'tabs-preload', 'quick-preload'].map((name) =>
    build({
      ...common,
      entryPoints: [path.join(src, `${name}.ts`)],
      outfile: path.join(dist, `${name}.cjs`),
      platform: 'browser',
      format: 'cjs',
      target: 'chrome140',
      external: ['electron'],
    }),
  ),
  // Scripts of the local pages (plain browser code, no Node, no Electron).
  ...['setup', 'offline', 'tabs', 'quick'].map((name) =>
    build({
      ...common,
      entryPoints: [path.join(src, 'pages', `${name}.ts`)],
      outfile: path.join(dist, `${name}.js`),
      platform: 'browser',
      format: 'iife',
      target: 'chrome140',
    }),
  ),
]);

// Static files.
for (const file of readdirSync(src)) {
  if (file.endsWith('.html')) cpSync(path.join(src, file), path.join(dist, file));
}
cpSync(path.join(src, 'assets'), path.join(dist, 'assets'), { recursive: true });
cpSync(path.join(root, 'build', 'icon.svg'), path.join(dist, 'assets', 'logo.svg'));

console.log(`✓ desktop/dist prêt${minify ? ' (minifié)' : ''}`);
