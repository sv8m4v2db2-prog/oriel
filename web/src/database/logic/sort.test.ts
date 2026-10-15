/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SortRule } from '@oriel/shared';
import { applySorts, sortByManualOrder } from './sort';
import { makeContext, makeRow } from './testFixtures';

const ctx = makeContext();
const rows = [
  makeRow('a', 'banane', { prix: 10, cat: 'o3', etat: 'done', fait: true, due: { start: '2026-10-02' }, resp: ['u2'] }),
  makeRow('b', 'Abricot', { prix: null, cat: 'o1', etat: 'todo', due: { start: '2026-09-01' }, resp: ['u1'] }),
  makeRow('c', 'cerise', { prix: 2, etat: 'doing', fait: false }),
  makeRow('d', '', { prix: 10, cat: 'o2' }),
  makeRow('e', 'item 10', { prix: -1 }),
  makeRow('f', 'item 9', {}),
];
const order = (sorts: SortRule[]) => applySorts(rows, sorts, ctx).map((r) => r.id);

describe('sorting', () => {
  test('text ascending, French collation, numeric aware, empty last', () => {
    assert.deepEqual(order([{ propertyId: 'title', direction: 'asc' }]), ['b', 'a', 'c', 'f', 'e', 'd']);
  });
  test('text descending keeps empty last', () => {
    assert.deepEqual(order([{ propertyId: 'title', direction: 'desc' }]), ['e', 'f', 'c', 'a', 'b', 'd']);
  });
  test('numbers with empty last in both directions, stable ties', () => {
    assert.deepEqual(order([{ propertyId: 'prix', direction: 'asc' }]), ['e', 'c', 'a', 'd', 'b', 'f']);
    assert.deepEqual(order([{ propertyId: 'prix', direction: 'desc' }]), ['a', 'd', 'c', 'e', 'b', 'f']);
  });
  test('select follows option order', () => {
    assert.deepEqual(order([{ propertyId: 'cat', direction: 'asc' }]), ['b', 'd', 'a', 'c', 'e', 'f']);
  });
  test('status follows group order (todo → in progress → done)', () => {
    assert.deepEqual(order([{ propertyId: 'etat', direction: 'asc' }]), ['b', 'c', 'a', 'd', 'e', 'f']);
  });
  test('dates', () => {
    assert.deepEqual(order([{ propertyId: 'due', direction: 'desc' }]), ['a', 'b', 'c', 'd', 'e', 'f']);
  });
  test('checkbox: unchecked first ascending', () => {
    assert.deepEqual(order([{ propertyId: 'fait', direction: 'desc' }]).slice(0, 1), ['a']);
  });
  test('persons by name', () => {
    assert.deepEqual(order([{ propertyId: 'resp', direction: 'asc' }]).slice(0, 2), ['b', 'a']);
  });
  test('multiple keys', () => {
    assert.deepEqual(
      order([
        { propertyId: 'prix', direction: 'desc' },
        { propertyId: 'title', direction: 'asc' },
      ]),
      ['a', 'd', 'c', 'e', 'b', 'f'],
    );
  });
  test('unknown properties are ignored and input is not mutated', () => {
    const copy = [...rows];
    assert.deepEqual(order([{ propertyId: 'nope', direction: 'asc' }]), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(rows, copy);
  });
  test('manual order uses fractional positions', () => {
    const shuffled = [
      { ...rows[0]!, position: 'a2' },
      { ...rows[1]!, position: 'a0' },
      { ...rows[2]!, position: 'a1' },
    ];
    assert.deepEqual(sortByManualOrder(shuffled).map((r) => r.id), ['b', 'c', 'a']);
  });
});
