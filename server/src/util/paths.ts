import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Defined (to `true`) by esbuild when building dist/server.cjs. */
declare const __ORIEL_BUNDLE__: boolean | undefined;

export const isBundle = (): boolean => typeof __ORIEL_BUNDLE__ !== 'undefined' && __ORIEL_BUNDLE__ === true;

/** Directory of the current source file, found without `import.meta` (works in ESM and CJS). */
function sourceDir(): string | null {
  if (typeof __dirname === 'string') return __dirname;
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(1)) {
    const m = /\((.+?):\d+:\d+\)\s*$/.exec(line) ?? /at (.+?):\d+:\d+\s*$/.exec(line);
    if (!m || !m[1]) continue;
    let file = m[1].trim();
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (path.isAbsolute(file)) return path.dirname(file);
  }
  return null;
}

/**
 * Directory of the server "bundle": `server/dist` for the esbuild bundle (`server/dist/server.cjs`),
 * `server/src` when running the TypeScript sources with tsx. Both sit two levels below the repo root.
 */
export function bundleDir(): string {
  if (isBundle() && typeof __dirname === 'string') return __dirname;
  const here = sourceDir(); // server/src/util
  return here ? path.resolve(here, '..') : process.cwd();
}

/** Resolution order for the SPA files (see ARCHITECTURE §3.1). Returns the first directory with an index.html. */
export function resolveWebDist(explicit: string | undefined): string | null {
  if (explicit) return path.resolve(explicit);
  const dir = bundleDir();
  const candidates = [
    path.resolve(dir, '..', '..', 'web', 'dist'), // repo layout: server/dist/server.cjs
    path.resolve(dir, 'web'),
    path.resolve(dir, '..', 'web'), // packaged layout: <resources>/server/server.cjs + <resources>/web
    path.resolve(process.cwd(), 'web', 'dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}
