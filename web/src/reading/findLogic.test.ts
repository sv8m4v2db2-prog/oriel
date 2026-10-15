import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, foldText, replaceMatches, runIndexAt } from './findLogic';

test('foldText keeps the length and ignores case and accents', () => {
  assert.equal(foldText('Éléphant ÇA'), 'elephant ca');
  for (const s of ['İstanbul', 'ﬁn', 'Œuvre', 'áb', '😀é']) assert.equal(foldText(s).length, s.length, s);
});

test('findMatches: accent-insensitive, non overlapping, indices of the original text', () => {
  assert.deepEqual(findMatches('Été été ETE', 'ete'), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(findMatches('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(findMatches('abc', ''), []);
  assert.equal(findMatches('x'.repeat(100), 'x', 10).length, 10);
});

test('replaceMatches', () => {
  const text = 'un deux un trois';
  assert.equal(replaceMatches(text, findMatches(text, 'un'), 'UN'), 'UN deux UN trois');
  assert.equal(replaceMatches(text, findMatches(text, 'deux'), ''), 'un  un trois');
});

test('runIndexAt', () => {
  const runs = [
    { start: 0, end: 5 },
    { start: 5, end: 9 },
    { start: 10, end: 12 },
  ];
  assert.equal(runIndexAt(runs, 0), 0);
  assert.equal(runIndexAt(runs, 4), 0);
  assert.equal(runIndexAt(runs, 5), 1);
  assert.equal(runIndexAt(runs, 9), -1);
  assert.equal(runIndexAt(runs, 11), 2);
});
