/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FilterGroup, FilterOperator, FilterRule } from '@oriel/shared';
import { applyFilter, applySearch, isRuleActive, operatorLabel, operatorsForKind } from './filter';
import { makeContext, makeRow, prop, SCHEMA } from './testFixtures';

const SCHEMA_WITH_PLACE = [...SCHEMA, { id: 'lieu', name: 'Lieu', type: 'place' as const }];

const ctx = makeContext();
const rows = [
  makeRow('a', 'Été à Paris', { notes: 'Rapport final', prix: 10, cat: 'o1', tags: ['t1'], due: { start: '2026-10-13' }, fait: true, resp: ['u1'], liens: ['p1'], pj: [{ name: 'Plan.pdf', url: '/f/1' }] }),
  makeRow('b', 'Hiver', { notes: 'brouillon', prix: 25, cat: 'o2', tags: ['t1', 't2'], due: { start: '2026-10-01', end: '2026-10-05' }, resp: ['u2'] }),
  makeRow('c', 'Printemps', { prix: null, tags: [], due: { start: '2026-11-01' }, fait: false }),
  makeRow('d', '', {}),
];

const rule = (propertyId: string, operator: FilterOperator, value?: unknown): FilterRule => ({
  id: `${propertyId}-${operator}`,
  propertyId,
  operator,
  value,
});
const ids = (filter: FilterGroup) => applyFilter(rows, filter, ctx).map((r) => r.id);
const and = (...rules: FilterRule[]): FilterGroup => ({ conjunction: 'and', rules });
const or = (...rules: FilterRule[]): FilterGroup => ({ conjunction: 'or', rules });

describe('operators per kind (SPEC §5.4)', () => {
  test('mapping', () => {
    assert.deepEqual(operatorsForKind('text'), ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty']);
    assert.deepEqual(operatorsForKind('number'), ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty']);
    assert.deepEqual(operatorsForKind('select'), ['equals', 'not_equals', 'is_empty', 'is_not_empty']);
    for (const k of ['multi', 'person', 'relation'] as const) {
      assert.deepEqual(operatorsForKind(k), ['contains', 'contains_all', 'not_contains', 'is_empty', 'is_not_empty']);
    }
    assert.deepEqual(operatorsForKind('files'), ['contains', 'not_contains', 'is_empty', 'is_not_empty']);
    assert.deepEqual(operatorsForKind('date'), [
      'equals',
      'before',
      'after',
      'on_or_before',
      'on_or_after',
      'within',
      'within_last',
      'within_next',
      'exactly_ago',
      'exactly_ahead',
      'is_empty',
      'is_not_empty',
    ]);
    assert.deepEqual(operatorsForKind('checkbox'), ['checked', 'unchecked']);
  });
  test('labels', () => {
    assert.equal(operatorLabel('gte', 'number'), '≥');
    assert.equal(operatorLabel('equals', 'text'), 'est');
    assert.equal(operatorLabel('on_or_before', 'date'), 'est au plus tard');
  });
});

describe('text filters', () => {
  test('contains is case and accent insensitive', () => {
    assert.deepEqual(ids(and(rule('title', 'contains', 'ete'))), ['a']);
    assert.deepEqual(ids(and(rule('title', 'starts_with', 'hi'))), ['b']);
    assert.deepEqual(ids(and(rule('title', 'ends_with', 'TEMPS'))), ['c']);
    assert.deepEqual(ids(and(rule('notes', 'equals', 'BROUILLON'))), ['b']);
    assert.deepEqual(ids(and(rule('notes', 'not_contains', 'rapport'))), ['b', 'c', 'd']);
  });
  test('empty checks', () => {
    assert.deepEqual(ids(and(rule('title', 'is_empty'))), ['d']);
    assert.deepEqual(ids(and(rule('notes', 'is_not_empty'))), ['a', 'b']);
  });
  test('rules without value are ignored', () => {
    assert.deepEqual(ids(and(rule('title', 'contains', ''))), ['a', 'b', 'c', 'd']);
    assert.equal(isRuleActive(rule('title', 'contains', '  '), prop('title'), 'text'), false);
    assert.equal(isRuleActive(rule('title', 'is_empty'), prop('title'), 'text'), true);
    assert.equal(isRuleActive(rule('title', 'gt', 'x'), prop('title'), 'text'), false);
  });
});

describe('number filters', () => {
  test('comparisons', () => {
    assert.deepEqual(ids(and(rule('prix', 'gt', 10))), ['b']);
    assert.deepEqual(ids(and(rule('prix', 'gte', '10'))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('prix', 'lt', '12,5'))), ['a']);
    assert.deepEqual(ids(and(rule('prix', 'equals', 25))), ['b']);
    assert.deepEqual(ids(and(rule('prix', 'not_equals', 25))), ['a', 'c', 'd']);
    assert.deepEqual(ids(and(rule('prix', 'is_empty'))), ['c', 'd']);
  });
  test('formula results are filterable as numbers', () => {
    assert.deepEqual(ids(and(rule('total', 'is_empty'))), ['a', 'b', 'c', 'd']);
  });
});

describe('select, list and checkbox filters', () => {
  test('select', () => {
    assert.deepEqual(ids(and(rule('cat', 'equals', 'o1'))), ['a']);
    assert.deepEqual(ids(and(rule('cat', 'equals', ['o1', 'o2']))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('cat', 'not_equals', 'o1'))), ['b', 'c', 'd']);
    assert.deepEqual(ids(and(rule('cat', 'is_empty'))), ['c', 'd']);
  });
  test('multi-select / person / relation / files', () => {
    assert.deepEqual(ids(and(rule('tags', 'contains', 't2'))), ['b']);
    assert.deepEqual(ids(and(rule('tags', 'not_contains', 't1'))), ['c', 'd']);
    assert.deepEqual(ids(and(rule('tags', 'is_empty'))), ['c', 'd']);
    assert.deepEqual(ids(and(rule('resp', 'contains', 'u2'))), ['b']);
    assert.deepEqual(ids(and(rule('auteur', 'contains', 'u1'))), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(and(rule('liens', 'is_not_empty'))), ['a']);
    assert.deepEqual(ids(and(rule('pj', 'contains', 'plan'))), ['a']);
  });
  test('checkbox', () => {
    assert.deepEqual(ids(and(rule('fait', 'checked'))), ['a']);
    assert.deepEqual(ids(and(rule('fait', 'unchecked'))), ['b', 'c', 'd']);
  });
});

describe('date filters', () => {
  test('absolute comparisons use the start day; equals matches ranges', () => {
    assert.deepEqual(ids(and(rule('due', 'equals', '2026-10-03'))), ['b']);
    assert.deepEqual(ids(and(rule('due', 'before', '2026-10-13'))), ['b']);
    assert.deepEqual(ids(and(rule('due', 'on_or_before', '2026-10-13'))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('due', 'after', '2026-10-13'))), ['c']);
    assert.deepEqual(ids(and(rule('due', 'on_or_after', 'today'))), ['a', 'c']);
    assert.deepEqual(ids(and(rule('due', 'is_empty'))), ['d']);
  });
  test('relative ranges', () => {
    assert.deepEqual(ids(and(rule('due', 'within', 'today'))), ['a']);
    assert.deepEqual(ids(and(rule('due', 'within', 'past_week'))), ['a']);
    assert.deepEqual(ids(and(rule('due', 'within', 'past_month'))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('due', 'within', 'next_month'))), ['a', 'c']);
    assert.deepEqual(ids(and(rule('due', 'within', 'next_week'))), ['a']);
    assert.deepEqual(ids(and(rule('due', 'within', 'bogus'))), ['a', 'b', 'c', 'd']);
  });
  test('created time is a date', () => {
    assert.deepEqual(ids(and(rule('cree', 'before', '2026-01-02'))), ['a', 'b', 'c', 'd']);
  });
});

describe('conjunctions & search', () => {
  test('and / or', () => {
    assert.deepEqual(ids(and(rule('tags', 'contains', 't1'), rule('prix', 'gt', 20))), ['b']);
    assert.deepEqual(ids(or(rule('fait', 'checked'), rule('prix', 'gt', 20))), ['a', 'b']);
    assert.deepEqual(ids(or()), ['a', 'b', 'c', 'd']);
  });
  test('rules on deleted properties are ignored', () => {
    assert.deepEqual(ids(and(rule('ghost', 'is_empty'))), ['a', 'b', 'c', 'd']);
  });
  test('null filter keeps everything', () => {
    assert.equal(applyFilter(rows, null, ctx).length, 4);
  });
  test('search on title', () => {
    assert.deepEqual(applySearch(rows, 'paris').map((r) => r.id), ['a']);
    assert.deepEqual(applySearch(rows, '  ').map((r) => r.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(applySearch(rows, 'ÉTÉ').map((r) => r.id), ['a']);
  });
});

describe('nested filter groups', () => {
  test('rules AND (group OR)', () => {
    const f: FilterGroup = {
      conjunction: 'and',
      rules: [rule('prix', 'is_not_empty')],
      groups: [or(rule('cat', 'equals', 'o1'), rule('tags', 'contains', 't2'))],
    };
    assert.deepEqual(ids(f), ['a', 'b']);
    const f2: FilterGroup = { ...f, groups: [and(rule('cat', 'equals', 'o1'), rule('tags', 'contains', 't2'))] };
    assert.deepEqual(ids(f2), []);
  });
  test('rules OR group, groups only, empty groups ignored', () => {
    const f: FilterGroup = { conjunction: 'or', rules: [rule('fait', 'checked')], groups: [and(rule('prix', 'gt', 20), rule('cat', 'equals', 'o2'))] };
    assert.deepEqual(ids(f), ['a', 'b']);
    assert.deepEqual(ids({ conjunction: 'and', rules: [], groups: [or(rule('title', 'contains', 'hiver'))] }), ['b']);
    assert.deepEqual(ids({ conjunction: 'and', rules: [rule('fait', 'checked')], groups: [or()] }), ['a']);
  });
});

describe('place properties', () => {
  const lieu = { id: 'lieu', name: 'Lieu', type: 'place' as const };
  const pctx = makeContext([...SCHEMA_WITH_PLACE]);
  const placeRows = [
    makeRow('p', 'Paris', { lieu: { address: '1 rue de Rivoli, Paris', lat: 48.86, lng: 2.35 } }),
    makeRow('l', 'Lyon', { lieu: { address: 'Place Bellecour, Lyon' } }),
    makeRow('v', 'Vide'),
  ];
  test('text filters, emptiness, search on the address', () => {
    const f = (r: FilterRule): string[] => applyFilter(placeRows, { conjunction: 'and', rules: [r] }, pctx).map((x) => x.id);
    assert.deepEqual(f({ id: 'r', propertyId: lieu.id, operator: 'contains', value: 'lyon' }), ['l']);
    assert.deepEqual(f({ id: 'r', propertyId: lieu.id, operator: 'is_empty' }), ['v']);
    assert.deepEqual(f({ id: 'r', propertyId: lieu.id, operator: 'is_not_empty' }), ['p', 'l']);
    assert.deepEqual(operatorsForKind('text').includes('contains'), true);
  });
});
