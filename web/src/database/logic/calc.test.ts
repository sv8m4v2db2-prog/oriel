/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalculationType } from '@oriel/shared';
import { calculationsForKind, computeCalculation, groupShare } from './calc';
import { makeContext, makeRow, prop, spaces } from './testFixtures';
import type { ValueKind } from './values';

const ctx = makeContext();
const rows = [
  makeRow('a', 'A', { prix: 10, qte: 1, tags: ['t1', 't2'], fait: true, due: { start: '2026-10-01' } }),
  makeRow('b', 'B', { prix: 20.5, qte: 4, tags: ['t1'], due: { start: '2026-10-05', end: '2026-10-20' } }),
  makeRow('c', '', { prix: null, qte: 3, fait: true }),
  makeRow('d', 'D', { prix: 1, qte: 2 }),
];
const calc = (id: string, type: CalculationType, kind: ValueKind) =>
  spaces(computeCalculation(rows, prop(id), type, kind, ctx).display);

describe('calculations', () => {
  test('available calculations per kind', () => {
    assert.ok(calculationsForKind('number').includes('sum'));
    assert.ok(!calculationsForKind('text').includes('sum'));
    assert.ok(calculationsForKind('date').includes('earliest'));
    assert.deepEqual(calculationsForKind('checkbox'), ['none', 'count_all', 'checked', 'unchecked', 'percent_checked']);
  });
  test('counts', () => {
    assert.equal(calc('title', 'none', 'text'), '');
    assert.equal(calc('title', 'count_all', 'text'), '4');
    assert.equal(calc('title', 'count_empty', 'text'), '1');
    assert.equal(calc('title', 'count_not_empty', 'text'), '3');
    assert.equal(calc('title', 'percent_empty', 'text'), '25 %');
    assert.equal(calc('title', 'percent_not_empty', 'text'), '75 %');
    assert.equal(calc('tags', 'count_values', 'multi'), '3');
  });
  test('number aggregates use the property format', () => {
    assert.equal(calc('prix', 'sum', 'number'), '31,50 €');
    assert.equal(calc('prix', 'average', 'number'), '10,50 €');
    assert.equal(calc('prix', 'median', 'number'), '10,00 €');
    assert.equal(calc('prix', 'min', 'number'), '1,00 €');
    assert.equal(calc('prix', 'max', 'number'), '20,50 €');
    assert.equal(calc('prix', 'range', 'number'), '19,50 €');
    assert.equal(calc('qte', 'average', 'number'), '2,5');
    assert.equal(calc('qte', 'median', 'number'), '2,5');
  });
  test('formula numbers can be summed', () => {
    // total = prix * qte → 10, 82, empty, 2
    assert.equal(calc('total', 'sum', 'number'), '94');
  });
  test('dates', () => {
    assert.equal(calc('due', 'earliest', 'date'), '1 oct. 2026');
    assert.equal(calc('due', 'latest', 'date'), '5 oct. 2026');
    assert.equal(calc('due', 'range', 'date'), '19 jours');
  });
  test('checkbox', () => {
    assert.equal(calc('fait', 'checked', 'checkbox'), '2');
    assert.equal(calc('fait', 'unchecked', 'checkbox'), '2');
    assert.equal(calc('fait', 'percent_checked', 'checkbox'), '50 %');
  });
  test('empty input', () => {
    const r = computeCalculation([], prop('prix'), 'sum', 'number', ctx);
    assert.equal(r.value, null);
    assert.equal(computeCalculation([], prop('title'), 'percent_empty', 'text', ctx).display, '0 %');
  });
});

describe('group share (D24)', () => {
  test('count and percentage of the view', () => {
    assert.equal(spaces(groupShare(1, 4).display), '1 ligne · 25 %');
    assert.equal(spaces(groupShare(1234, 3000).display), '1 234 lignes · 41,1 %');
    assert.equal(groupShare(1, 3).percent, 33.3);
    assert.equal(groupShare(0, 0).percent, 0);
    assert.equal(spaces(groupShare(0, 0).display), '0 ligne · 0 %');
    assert.equal(spaces(groupShare(3, 10003).display), '3 lignes · < 0,1 %');
  });
});

describe('number precision (G1 / D25)', () => {
  test('footer calculations follow the decimals of the property', async () => {
    const { computeCalculation } = await import('./calc');
    const { makeContext, makeRow } = await import('./testFixtures');
    const p = { id: 'x', name: 'X', type: 'number' as const, numberFormat: 'number' as const, numberPrecision: 1 };
    const ctx = makeContext([{ id: 'title', name: 'Nom', type: 'title' }, p]);
    const rows = [makeRow('a', 'a', { x: 1 }), makeRow('b', 'b', { x: 2 }), makeRow('c', 'c', { x: 2 })];
    assert.equal(computeCalculation(rows, p, 'average', 'number', ctx).display, '1,7');
    assert.equal(computeCalculation(rows, p, 'sum', 'number', ctx).display, '5,0');
    const auto = { ...p, numberPrecision: undefined };
    assert.equal(computeCalculation(rows, auto, 'average', 'number', ctx).display, '1,67');
  });
});
