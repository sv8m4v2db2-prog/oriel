/// <reference types="node" />
// Filters added by the G1 session (D23): « contains all », « me », durations relative to today,
// yesterday / tomorrow, quantifiers over « show original » rollups. Legacy rules keep working.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FilterGroup, FilterOperator, FilterQuantifier, FilterRule, Page, PropertyDef } from '@oriel/shared';
import { applyFilter, isRuleActive, ME_FILTER_VALUE, operatorLabel, rollupItemKind, ruleKind } from './filter';
import { asDuration, durationDayKey, durationRangeKeys, dayKey } from './dates';
import { createRowContext, type RelatedResolver, type RowContext } from './values';
import { makeContext, makeRow, prop, SCHEMA, USERS } from './testFixtures';

// NOW = jeudi 13 octobre 2026, 10:30 (testFixtures).
const rule = (propertyId: string, operator: FilterOperator, value?: unknown, quantifier?: FilterQuantifier): FilterRule => ({
  id: `${propertyId}-${operator}`,
  propertyId,
  operator,
  value,
  ...(quantifier ? { quantifier } : {}),
});
const and = (...rules: FilterRule[]): FilterGroup => ({ conjunction: 'and', rules });

const rows: Page[] = [
  makeRow('a', 'A', { tags: ['t1'], resp: ['u1'], liens: ['p1'], due: { start: '2026-10-13' } }),
  makeRow('b', 'B', { tags: ['t1', 't2'], resp: ['u2'], liens: ['p1', 'p2'], due: { start: '2026-10-01', end: '2026-10-05' } }),
  makeRow('c', 'C', { tags: [], resp: ['u1', 'u2'], due: { start: '2026-11-01' } }),
  makeRow('d', 'D', {}),
  makeRow('e', 'E', { due: { start: '2026-10-12' } }),
  makeRow('f', 'F', { due: { start: '2026-10-14' } }),
];
const ctx = makeContext();
const meCtx = createRowContext(SCHEMA, { users: USERS, now: () => new Date(2026, 9, 13, 10, 30), currentUserId: 'u1' });
const ids = (f: FilterGroup, c: RowContext = ctx) => applyFilter(rows, f, c).map((r) => r.id);

describe('multi-values: contains any / all / none', () => {
  test('contains_all requires every wanted option', () => {
    assert.deepEqual(ids(and(rule('tags', 'contains_all', ['t1', 't2']))), ['b']);
    assert.deepEqual(ids(and(rule('tags', 'contains_all', ['t1']))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('tags', 'contains_all', 't2'))), ['b']);
  });
  test('contains is « any of », not_contains is « none of »', () => {
    assert.deepEqual(ids(and(rule('tags', 'contains', ['t1', 't2']))), ['a', 'b']);
    assert.deepEqual(ids(and(rule('tags', 'not_contains', ['t2']))), ['a', 'c', 'd', 'e', 'f']);
    assert.deepEqual(ids(and(rule('tags', 'not_contains', ['t1', 't2']))), ['c', 'd', 'e', 'f']);
  });
  test('people and relations', () => {
    assert.deepEqual(ids(and(rule('resp', 'contains_all', ['u1', 'u2']))), ['c']);
    assert.deepEqual(ids(and(rule('resp', 'not_contains', 'u1'))), ['b', 'd', 'e', 'f']);
    assert.deepEqual(ids(and(rule('liens', 'contains_all', ['p1', 'p2']))), ['b']);
    assert.deepEqual(ids(and(rule('liens', 'not_contains', 'p2'))), ['a', 'c', 'd', 'e', 'f']);
  });
  test('an empty list of values leaves the rule inactive', () => {
    assert.equal(isRuleActive(rule('tags', 'contains_all', []), prop('tags'), 'multi'), false);
    assert.deepEqual(ids(and(rule('tags', 'contains_all', []))).length, rows.length);
  });
  test('contains_all is not offered for a select or files', () => {
    assert.equal(isRuleActive(rule('cat', 'contains_all', ['o1']), prop('cat'), 'select'), false);
    assert.equal(isRuleActive(rule('pj', 'contains_all', 'x'), prop('pj'), 'files'), false);
  });
});

describe('people: « me »', () => {
  test('resolves to the signed-in user', () => {
    assert.deepEqual(ids(and(rule('resp', 'contains', ME_FILTER_VALUE)), meCtx), ['a', 'c']);
    assert.deepEqual(ids(and(rule('resp', 'not_contains', ME_FILTER_VALUE)), meCtx), ['b', 'd', 'e', 'f']);
    assert.deepEqual(ids(and(rule('resp', 'contains', [ME_FILTER_VALUE, 'u2'])), meCtx), ['a', 'b', 'c']);
    assert.deepEqual(ids(and(rule('resp', 'contains_all', [ME_FILTER_VALUE, 'u2'])), meCtx), ['c']);
  });
  test('without a signed-in user nobody is « me »', () => {
    assert.deepEqual(ids(and(rule('resp', 'contains', ME_FILTER_VALUE))), []);
    assert.deepEqual(ids(and(rule('resp', 'not_contains', ME_FILTER_VALUE))), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(ids(and(rule('resp', 'contains_all', ME_FILTER_VALUE))), []);
  });
  test('works on « created by »', () => {
    assert.deepEqual(ids(and(rule('auteur', 'contains', ME_FILTER_VALUE)), meCtx).length, rows.length);
  });
});

describe('dates: durations relative to today', () => {
  test('asDuration validates', () => {
    assert.deepEqual(asDuration({ amount: 3, unit: 'week' }), { amount: 3, unit: 'week' });
    assert.deepEqual(asDuration({ amount: '7', unit: 'day' }), { amount: 7, unit: 'day' });
    assert.deepEqual(asDuration({ amount: '2,5', unit: 'month' }), { amount: 3, unit: 'month' });
    assert.equal(asDuration({ amount: -1, unit: 'day' }), null);
    assert.equal(asDuration({ amount: 20000, unit: 'day' }), null);
    assert.equal(asDuration({ amount: 1, unit: 'year' }), null);
    assert.equal(asDuration({ amount: Number.NaN, unit: 'day' }), null);
    assert.equal(asDuration('7 jours'), null);
    assert.equal(asDuration(null), null);
    assert.equal(asDuration([1, 'day']), null);
  });
  test('interval helpers', () => {
    const now = new Date(2026, 9, 13, 23, 59);
    assert.deepEqual(durationRangeKeys({ amount: 7, unit: 'day' }, 'last', now), [20261006, 20261013]);
    assert.deepEqual(durationRangeKeys({ amount: 2, unit: 'week' }, 'next', now), [20261013, 20261027]);
    assert.deepEqual(durationRangeKeys({ amount: 1, unit: 'month' }, 'last', now), [20260913, 20261013]);
    assert.equal(durationDayKey({ amount: 12, unit: 'day' }, 'ago', now), 20261001);
    assert.equal(durationDayKey({ amount: 1, unit: 'month' }, 'ahead', new Date(2026, 0, 31)), 20260228);
    assert.equal(dayKey(new Date(2026, 9, 13)), 20261013);
  });
  test('within_last / within_next', () => {
    assert.deepEqual(ids(and(rule('due', 'within_last', { amount: 7, unit: 'day' }))), ['a', 'e']);
    assert.deepEqual(ids(and(rule('due', 'within_last', { amount: 2, unit: 'week' }))), ['a', 'b', 'e']);
    assert.deepEqual(ids(and(rule('due', 'within_last', { amount: 1, unit: 'month' }))), ['a', 'b', 'e']);
    assert.deepEqual(ids(and(rule('due', 'within_last', { amount: 0, unit: 'day' }))), ['a']);
    assert.deepEqual(ids(and(rule('due', 'within_next', { amount: 7, unit: 'day' }))), ['a', 'f']);
    assert.deepEqual(ids(and(rule('due', 'within_next', { amount: 1, unit: 'month' }))), ['a', 'c', 'f']);
    assert.deepEqual(ids(and(rule('due', 'within_next', { amount: 1, unit: 'week' }))), ['a', 'f']);
  });
  test('exactly_ago / exactly_ahead match the covered day', () => {
    assert.deepEqual(ids(and(rule('due', 'exactly_ago', { amount: 12, unit: 'day' }))), ['b']);
    assert.deepEqual(ids(and(rule('due', 'exactly_ago', { amount: 8, unit: 'day' }))), ['b']);
    assert.deepEqual(ids(and(rule('due', 'exactly_ago', { amount: 7, unit: 'day' }))), []);
    assert.deepEqual(ids(and(rule('due', 'exactly_ago', { amount: 1, unit: 'day' }))), ['e']);
    assert.deepEqual(ids(and(rule('due', 'exactly_ahead', { amount: 1, unit: 'day' }))), ['f']);
    assert.deepEqual(ids(and(rule('due', 'exactly_ahead', { amount: 19, unit: 'day' }))), ['c']);
    assert.deepEqual(ids(and(rule('due', 'exactly_ago', { amount: 0, unit: 'day' }))), ['a']);
  });
  test('an invalid duration leaves the rule inactive', () => {
    assert.equal(isRuleActive(rule('due', 'within_last', { amount: -3, unit: 'day' }), prop('due'), 'date'), false);
    assert.equal(isRuleActive(rule('due', 'within_last', undefined), prop('due'), 'date'), false);
    assert.equal(isRuleActive(rule('due', 'within_last', '7'), prop('due'), 'date'), false);
    assert.equal(ids(and(rule('due', 'within_last', { amount: 'x', unit: 'day' }))).length, rows.length);
  });
  test('rows without a date never match', () => {
    assert.ok(!ids(and(rule('due', 'within_last', { amount: 9999, unit: 'day' }))).includes('d'));
    assert.ok(!ids(and(rule('due', 'exactly_ahead', { amount: 1, unit: 'day' }))).includes('d'));
  });
  test('works on created_time', () => {
    // Created on 2026-01-01: 285 days before NOW.
    assert.deepEqual(ids(and(rule('cree', 'exactly_ago', { amount: 285, unit: 'day' }))).length, rows.length);
    assert.deepEqual(ids(and(rule('cree', 'within_last', { amount: 3, unit: 'month' }))), []);
    assert.deepEqual(ids(and(rule('cree', 'within_last', { amount: 10, unit: 'month' }))).length, rows.length);
  });
  test('labels', () => {
    assert.equal(operatorLabel('within_last', 'date'), 'est dans les derniers');
    assert.equal(operatorLabel('contains_all', 'multi'), 'contient tous');
    assert.equal(operatorLabel('exactly_ago', 'date'), 'il y a exactement');
  });
});

describe('dates: yesterday and tomorrow as relative bounds', () => {
  test('within yesterday / tomorrow', () => {
    assert.deepEqual(ids(and(rule('due', 'within', 'yesterday'))), ['e']);
    assert.deepEqual(ids(and(rule('due', 'within', 'tomorrow'))), ['f']);
    assert.deepEqual(ids(and(rule('due', 'within', 'today'))), ['a']);
  });
  test('absolute operators accept yesterday / tomorrow (already supported) and legacy values', () => {
    assert.deepEqual(ids(and(rule('due', 'equals', 'yesterday'))), ['e']);
    assert.deepEqual(ids(and(rule('due', 'after', 'tomorrow'))), ['c']);
    assert.deepEqual(ids(and(rule('due', 'within', 'past_week'))), ['a', 'e']);
  });
});

// ---------------------------------------------------------------------------
// Rollup « show original » with a quantifier
// ---------------------------------------------------------------------------

const TASKS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'h', name: 'Heures', type: 'number' },
  { id: 'etat', name: 'État', type: 'select', options: [{ id: 'a', name: 'A', color: 'red' }, { id: 'b', name: 'B', color: 'blue' }] },
  { id: 'who', name: 'Qui', type: 'person' },
  { id: 'due', name: 'Date', type: 'date' },
];
const PROJECTS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'taches', name: 'Tâches', type: 'relation', relation: { databaseId: 'db2' } },
  { id: 'etats', name: 'États', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'etat', function: 'show_original' } },
  { id: 'heures', name: 'Heures', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'h', function: 'show_original' } },
  { id: 'qui', name: 'Qui', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'who', function: 'show_original' } },
  { id: 'dates', name: 'Dates', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'due', function: 'show_original' } },
  { id: 'somme', name: 'Somme', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'h', function: 'sum' } },
];
const tasks: Page[] = [
  makeRow('t1', 'Cadrage', { h: 8, etat: 'a', who: ['u1'], due: { start: '2026-10-12' } }, { parentId: 'db2' }),
  makeRow('t2', 'Dessin', { h: 12.5, etat: 'a', who: ['u2'], due: { start: '2026-10-20' } }, { parentId: 'db2' }),
  makeRow('t3', 'Recette', { h: null, etat: 'b', who: ['u1', 'u2'] }, { parentId: 'db2' }),
];
const projects: Page[] = [
  makeRow('p1', 'Alpha', { taches: ['t1', 't2'] }, { parentId: 'db1' }),
  makeRow('p2', 'Béta', { taches: ['t3'] }, { parentId: 'db1' }),
  makeRow('p3', 'Gamma', {}, { parentId: 'db1' }),
];

function rollupContext(currentUserId?: string): RowContext {
  const all = new Map<string, Page>([...tasks, ...projects].map((r) => [r.id, r]));
  const contexts = new Map<string, RowContext>();
  const schemas = new Map<string, PropertyDef[]>([['db1', PROJECTS], ['db2', TASKS]]);
  const resolver: RelatedResolver = {
    row: (id) => all.get(id),
    context: (db) => {
      if (!contexts.has(db) && schemas.has(db)) {
        contexts.set(db, createRowContext(schemas.get(db)!, { users: USERS, related: resolver, now: () => new Date(2026, 9, 13) }));
      }
      return contexts.get(db);
    },
  };
  return createRowContext(PROJECTS, { users: USERS, related: resolver, relationTitle: (id) => all.get(id)?.title, now: () => new Date(2026, 9, 13, 10, 30), currentUserId });
}
const rctx = rollupContext('u1');
const pids = (r: FilterRule, c: RowContext = rctx) => applyFilter(projects, and(r), c).map((x) => x.id);

describe('rollup « show original »: any / every / none', () => {
  test('kind of the listed values', () => {
    const etats = PROJECTS.find((p) => p.id === 'etats')!;
    assert.equal(rollupItemKind(etats, rctx), 'select');
    assert.equal(rollupItemKind(PROJECTS.find((p) => p.id === 'heures')!, rctx), 'number');
    assert.equal(rollupItemKind(PROJECTS.find((p) => p.id === 'somme')!, rctx), null);
    assert.equal(ruleKind(rule('etats', 'equals', 'a', 'any'), etats, 'text', rctx), 'select');
    assert.equal(ruleKind(rule('etats', 'equals', 'a'), etats, 'text', rctx), 'text');
    assert.equal(ruleKind(rule('etats', 'is_empty', undefined, 'any'), etats, 'text', rctx), 'text');
  });
  test('select values', () => {
    assert.deepEqual(pids(rule('etats', 'equals', 'a', 'any')), ['p1']);
    assert.deepEqual(pids(rule('etats', 'equals', 'a', 'every')), ['p1']);
    assert.deepEqual(pids(rule('etats', 'equals', 'a', 'none')), ['p2', 'p3']);
    assert.deepEqual(pids(rule('etats', 'equals', ['a', 'b'], 'every')), ['p1', 'p2']);
    assert.deepEqual(pids(rule('etats', 'not_equals', 'a', 'every')), ['p2']);
  });
  test('number values', () => {
    assert.deepEqual(pids(rule('heures', 'gt', 10, 'any')), ['p1']);
    assert.deepEqual(pids(rule('heures', 'gt', 5, 'every')), ['p1']);
    assert.deepEqual(pids(rule('heures', 'gt', 10, 'every')), []);
    assert.deepEqual(pids(rule('heures', 'gt', 10, 'none')), ['p2', 'p3']);
  });
  test('people values resolve « me »', () => {
    assert.deepEqual(pids(rule('qui', 'contains', ME_FILTER_VALUE, 'any')), ['p1', 'p2']);
    assert.deepEqual(pids(rule('qui', 'contains', ME_FILTER_VALUE, 'every')), ['p2']);
    assert.deepEqual(pids(rule('qui', 'contains', ME_FILTER_VALUE, 'none')), ['p3']);
    assert.deepEqual(pids(rule('qui', 'contains', 'u2', 'every')), ['p2']);
  });
  test('date values', () => {
    assert.deepEqual(pids(rule('dates', 'before', '2026-10-15', 'any')), ['p1']);
    assert.deepEqual(pids(rule('dates', 'before', '2026-10-15', 'every')), []);
    assert.deepEqual(pids(rule('dates', 'within_last', { amount: 3, unit: 'day' }, 'any')), ['p1']);
  });
  test('emptiness tests keep applying to the rollup as a whole', () => {
    assert.deepEqual(pids(rule('etats', 'is_empty', undefined, 'any')), ['p3']);
    assert.deepEqual(pids(rule('etats', 'is_not_empty', undefined, 'every')), ['p1', 'p2']);
  });
  test('a rollup that is not « show original » ignores the quantifier', () => {
    assert.deepEqual(pids(rule('somme', 'gt', 10, 'any')), ['p1']);
  });
  test('values not loaded yet: the rule is inactive', () => {
    const lonely = createRowContext(PROJECTS, { users: USERS });
    assert.equal(applyFilter(projects, and(rule('etats', 'equals', 'a', 'any')), lonely).length, 3);
  });
  test('legacy rules (no quantifier) keep their text semantics', () => {
    assert.deepEqual(pids(rule('etats', 'contains', 'b')), ['p2']);
    assert.deepEqual(pids(rule('heures', 'contains', '12')), ['p1']);
    assert.deepEqual(pids(rule('etats', 'is_empty')), ['p3']);
  });
});

describe('saved filters from before this version', () => {
  test('a JSON filter without new fields behaves exactly as before', () => {
    const saved = JSON.parse(
      JSON.stringify({
        conjunction: 'and',
        rules: [
          { id: '1', propertyId: 'tags', operator: 'contains', value: ['t1'] },
          { id: '2', propertyId: 'due', operator: 'within', value: 'past_month' },
        ],
      }),
    ) as FilterGroup;
    assert.deepEqual(ids(saved), ['a', 'b']);
  });
});

describe('last_visited (navigation module)', () => {
  const visited = makeContext([...SCHEMA, { id: 'visite', name: 'Dernière consultation', type: 'last_visited' }]);
  const vrows: Page[] = [
    makeRow('v1', 'Vu aujourd’hui', {}, { lastVisitedAt: new Date(2026, 9, 13, 9, 0).getTime() }),
    makeRow('v2', 'Vu il y a 10 jours', {}, { lastVisitedAt: new Date(2026, 9, 3, 18, 0).getTime() }),
    makeRow('v3', 'Jamais vu', {}, { lastVisitedAt: null }),
    makeRow('v4', 'Sans info', {}),
  ];
  const vids = (r: FilterRule) => applyFilter(vrows, and(r), visited).map((x) => x.id);
  test('is a date: relative ranges, durations and emptiness', () => {
    assert.deepEqual(vids(rule('visite', 'within', 'today')), ['v1']);
    assert.deepEqual(vids(rule('visite', 'within_last', { amount: 2, unit: 'week' })), ['v1', 'v2']);
    assert.deepEqual(vids(rule('visite', 'within_last', { amount: 3, unit: 'day' })), ['v1']);
    assert.deepEqual(vids(rule('visite', 'exactly_ago', { amount: 10, unit: 'day' })), ['v2']);
    assert.deepEqual(vids(rule('visite', 'before', 'yesterday')), ['v2']);
    assert.deepEqual(vids(rule('visite', 'is_empty')), ['v3', 'v4']);
    assert.deepEqual(vids(rule('visite', 'is_not_empty')), ['v1', 'v2']);
  });
});
