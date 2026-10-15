/// <reference types="node" />
// Two feature modules styling the same top-level class silently break each other: the floating
// page outline (reading.css) reused `.or-toc`, the class of the table-of-contents block
// (editor.css), and pulled every TOC block out of its column, absolutely positioned over the page.
// Top-level rules only: overrides nested in @media / @supports (print, mobile) are legitimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** Classes that are the whole selector of a top-level rule (`.a { … }` or `.a, .b { … }`). */
function topLevelClasses(css: string): Set<string> {
  const out = new Set<string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let selector = '';
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) {
        for (const part of selector.split(',')) {
          const m = /^\s*(\.[A-Za-z][\w-]*)\s*$/.exec(part);
          if (m) out.add(m[1]!);
        }
      }
      depth++;
      selector = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      selector = '';
    } else if (ch === ';' && depth === 0) {
      selector = ''; // @import / @charset
    } else if (depth === 0) {
      selector += ch;
    }
  }
  return out;
}

test('no top-level class is defined by two different stylesheets', () => {
  const owners = new Map<string, string[]>();
  for (const file of cssFiles(SRC)) {
    for (const cls of topLevelClasses(readFileSync(file, 'utf8'))) {
      owners.set(cls, [...(owners.get(cls) ?? []), relative(SRC, file)]);
    }
  }
  const shared = [...owners].filter(([, files]) => files.length > 1).map(([cls, files]) => `${cls}: ${files.join(', ')}`);
  assert.deepEqual(shared, []);
});
