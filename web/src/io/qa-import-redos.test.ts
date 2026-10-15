/// <reference types="node" />
// QA-WEB-06 — imported Markdown / CSV files are arbitrary text: a few regular expressions of the
// importers backtracked quadratically on crafted lines (100 000 "[" ≈ 11 s, an "e-mail" cell made of
// dots ≈ 6 s; a 1 MB line froze the tab for minutes). Each case must stay linear.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinks } from './markdown';
import { inferColumn } from './csv';
import { inferColumnType } from '../database/logic/csv';

const N = 100_000;
function fast(label: string, fn: () => unknown) {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  assert.ok(ms < 500, `${label}: ${Math.round(ms)} ms`);
}

describe('QA-WEB-06: import parsers stay linear on crafted input', () => {
  test('Markdown links', () => {
    fast('[[[[…', () => findLinks('['.repeat(N)));
    fast('[a](<…', () => findLinks('[a](<'.repeat(N / 5)));
    fast('![x](…', () => findLinks('![x]('.repeat(N / 5)));
  });

  test('links are still found', () => {
    assert.deepEqual(
      findLinks('Voir [la page](Page%20abc.md) et ![logo](<images/logo 1.png> "Logo") ou [a [b](https://b.example)').map((l) => [l.text, l.href, l.image]),
      [
        ['la page', 'Page%20abc.md', false],
        ['logo', 'images/logo 1.png', true],
        ['b', 'https://b.example', false],
      ],
    );
  });

  test('CSV column inference (e-mail detection)', () => {
    const cell = `a@${'.'.repeat(N)}@`;
    fast('database CSV import', () => inferColumnType([cell]));
    fast('workspace import', () => inferColumn(0, 'Contact', [cell]));
    assert.equal(inferColumnType(['ana@example.com', 'bob.durand@mail.example.fr']), 'email');
    assert.equal(inferColumn(0, 'Contact', ['ana@example.com', 'bob.durand@mail.example.fr']).type, 'email');
  });
});
