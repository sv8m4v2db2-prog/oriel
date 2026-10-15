// N11: the high contrast tokens reach WCAG AA on the main elements, in light and dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastRatio } from './contrast';

const css = readFileSync(new URL('./contrast.css', import.meta.url), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!;
  return out;
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['--text', '--bg'],
  ['--text', '--bg-sidebar'],
  ['--text', '--bg-subtle'],
  ['--text-secondary', '--bg'],
  ['--text-secondary', '--bg-sidebar'],
  ['--text-tertiary', '--bg'],
  ['--text-tertiary', '--bg-sidebar'],
  ['--accent', '--bg'],
  ['--accent', '--bg-elevated'],
  ['--danger', '--bg'],
  ['--success', '--bg'],
  ['--warning', '--bg'],
  ['--text-on-accent', '--accent'],
];
const UI_PAIRS: Array<[string, string]> = [
  ['--border', '--bg'],
  ['--border', '--bg-sidebar'],
  ['--focus-ring', '--bg'],
];

for (const [name, selector] of [
  ['clair', ":root[data-contrast='high']"],
  ['sombre', ":root[data-theme='dark'][data-contrast='high']"],
] as const) {
  test(`contraste élevé ${name} : texte ≥ 4,5:1, interface ≥ 3:1`, () => {
    const t = tokens(selector);
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = contrastRatio(t[fg]!, t[bg]!);
      assert(r >= 4.5, `${fg} sur ${bg} : ${r.toFixed(2)}`);
    }
    for (const [fg, bg] of UI_PAIRS) {
      const r = contrastRatio(t[fg]!, t[bg]!);
      assert(r >= 3, `${fg} sur ${bg} : ${r.toFixed(2)}`);
    }
  });
}

test('contrastRatio : noir sur blanc = 21', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
});
