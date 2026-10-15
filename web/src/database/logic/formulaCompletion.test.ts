// I2 — autocomplétion de l'éditeur de formules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formulaCompletions } from './formulaCompletion';

const labels = (src: string, caret = src.length) => formulaCompletions(src, caret)?.items.map((i) => i.label) ?? [];

test('propose les fonctions qui commencent par le mot en cours', () => {
  assert.deepEqual(labels('ma'), ['max', 'map']);
  assert.equal(formulaCompletions('1 + fil', 7)?.start, 4);
  assert.equal(formulaCompletions('fil', 3)?.items[0]?.insert, 'filter(');
});

test('après un point : fonctions sans let ; ailleurs : current et index en plus', () => {
  assert.deepEqual(labels('prop("Tâches").le'), ['length']);
  assert.deepEqual(labels('le'), ['length', 'let', 'lets']);
  assert.deepEqual(labels('[1].map(cur'), ['current']);
});

test('rien dans une chaîne, après un chiffre ou sur un nom complet', () => {
  assert.deepEqual(labels('prop("ma'), []);
  assert.deepEqual(labels('"a\\"ma'), []);
  assert.deepEqual(labels('12e'), []);
  assert.deepEqual(labels('map'), []);
  assert.deepEqual(labels('1 + '), []);
});
