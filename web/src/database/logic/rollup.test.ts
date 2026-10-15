/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, PropertyDef, RollupFunction } from '@oriel/shared';
import { applyFilter } from './filter';
import { computeGroups } from './group';
import { applySorts } from './sort';
import { computeCalculation } from './calc';
import { rollupFunctionsForKind, rollupKind } from './rollup';
import { createRowContext, getRollupResult, getFormulaResult, getText, propertyKind, type RelatedResolver, type RowContext } from './values';
import { makeRow, spaces, USERS } from './testFixtures';

// Related database "Tâches" (db2).
const TASKS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'h', name: 'Heures', type: 'number', numberFormat: 'number' },
  { id: 'cout', name: 'Coût', type: 'number', numberFormat: 'euro' },
  { id: 'fait', name: 'Fait', type: 'checkbox' },
  { id: 'due', name: 'Échéance', type: 'date' },
  {
    id: 'etat',
    name: 'État',
    type: 'select',
    options: [
      { id: 'a', name: 'A', color: 'red' },
      { id: 'b', name: 'B', color: 'blue' },
    ],
  },
  { id: 'proj', name: 'Projet', type: 'relation', relation: { databaseId: 'db1' } },
  { id: 'nb', name: 'Nb projets', type: 'rollup', rollup: { relationPropertyId: 'proj', targetPropertyId: 'title', function: 'count_all' } },
];
const tasks: Page[] = [
  makeRow('t1', 'Cadrage', { h: 8, cout: 100, fait: true, due: { start: '2026-10-01' }, etat: 'a', proj: ['p1'] }, { parentId: 'db2' }),
  makeRow('t2', 'Dessin', { h: 12.5, cout: 50.5, due: { start: '2026-10-05', end: '2026-10-20' }, etat: 'a', proj: ['p1'] }, { parentId: 'db2' }),
  makeRow('t3', '', { h: null, fait: true, etat: 'b', proj: ['p2'] }, { parentId: 'db2' }),
];

const rollup = (id: string, fn: RollupFunction, target: string): PropertyDef => ({
  id,
  name: id,
  type: 'rollup',
  rollup: { relationPropertyId: 'taches', targetPropertyId: target, function: fn },
});

// Database "Projets" (db1).
const PROJECTS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'taches', name: 'Tâches', type: 'relation', relation: { databaseId: 'db2', syncedPropertyId: 'proj' } },
  rollup('total', 'sum', 'cout'),
  rollup('heures', 'sum', 'h'),
  rollup('avg', 'average', 'h'),
  rollup('med', 'median', 'h'),
  rollup('min', 'min', 'h'),
  rollup('max', 'max', 'h'),
  rollup('range', 'range', 'h'),
  rollup('count', 'count_all', 'title'),
  rollup('values', 'count_values', 'etat'),
  rollup('unique', 'count_unique', 'etat'),
  rollup('empty', 'count_empty', 'title'),
  rollup('notempty', 'count_not_empty', 'title'),
  rollup('pempty', 'percent_empty', 'h'),
  rollup('pnotempty', 'percent_not_empty', 'h'),
  rollup('first', 'earliest', 'due'),
  rollup('last', 'latest', 'due'),
  rollup('span', 'date_range', 'due'),
  rollup('checked', 'checked', 'fait'),
  rollup('unchecked', 'unchecked', 'fait'),
  rollup('pchecked', 'percent_checked', 'fait'),
  rollup('orig', 'show_original', 'title'),
  rollup('nested', 'sum', 'nb'),
  { id: 'f', name: 'Marge', type: 'formula', formula: 'prop("total") * 2' },
  { id: 'loop', name: 'loop', type: 'rollup', rollup: { relationPropertyId: 'taches', targetPropertyId: 'back', function: 'sum' } },
];
const projects: Page[] = [
  makeRow('p1', 'Alpha', { taches: ['t1', 't2'] }, { parentId: 'db1' }),
  makeRow('p2', 'Béta', { taches: ['t3'] }, { parentId: 'db1' }),
  makeRow('p3', 'Gamma', {}, { parentId: 'db1' }),
];

function makeResolver(): { ctx: RowContext; resolver: RelatedResolver } {
  const all = new Map<string, Page>([...tasks, ...projects].map((r) => [r.id, r]));
  const contexts = new Map<string, RowContext>();
  const schemas = new Map<string, PropertyDef[]>([
    ['db1', PROJECTS],
    // A rollup in Tâches pointing back to a rollup of Projets (circular).
    ['db2', [...TASKS, { id: 'back', name: 'back', type: 'rollup', rollup: { relationPropertyId: 'proj', targetPropertyId: 'loop', function: 'sum' } }]],
  ]);
  const resolver: RelatedResolver = {
    row: (id) => all.get(id),
    context: (db) => {
      if (!contexts.has(db) && schemas.has(db)) {
        contexts.set(db, createRowContext(schemas.get(db)!, { users: USERS, related: resolver, relationTitle: (id) => all.get(id)?.title }));
      }
      return contexts.get(db);
    },
  };
  return { ctx: createRowContext(PROJECTS, { users: USERS, related: resolver, relationTitle: (id) => all.get(id)?.title }), resolver };
}

const { ctx } = makeResolver();
const p = (id: string) => PROJECTS.find((x) => x.id === id)!;
const text = (row: Page, id: string) => spaces(getRollupResult(row, p(id), ctx).text ?? '');
const value = (row: Page, id: string) => getRollupResult(row, p(id), ctx).value;
const [alpha, beta, gamma] = projects as [Page, Page, Page];

describe('rollups', () => {
  test('numbers keep the target format', () => {
    assert.equal(value(alpha, 'total'), 150.5);
    assert.equal(text(alpha, 'total'), '150,50 €');
    assert.equal(value(alpha, 'heures'), 20.5);
    assert.equal(value(alpha, 'avg'), 10.25);
    assert.equal(value(alpha, 'med'), 10.25);
    assert.equal(value(alpha, 'min'), 8);
    assert.equal(value(alpha, 'max'), 12.5);
    assert.equal(value(alpha, 'range'), 4.5);
    assert.equal(value(gamma, 'heures'), 0, 'sum of nothing is 0');
    assert.equal(value(gamma, 'avg'), null);
    assert.equal(value(beta, 'avg'), null, 'empty numbers are ignored');
  });
  test('counts and percentages', () => {
    assert.equal(value(alpha, 'count'), 2);
    assert.equal(value(gamma, 'count'), 0);
    assert.equal(value(alpha, 'values'), 2);
    assert.equal(value(alpha, 'unique'), 1);
    assert.equal(value(beta, 'empty'), 1);
    assert.equal(value(beta, 'notempty'), 0);
    assert.equal(value(beta, 'pempty'), 100);
    assert.equal(text(beta, 'pempty'), '100 %');
    assert.equal(value(alpha, 'pnotempty'), 100);
    assert.equal(value(alpha, 'checked'), 1);
    assert.equal(value(alpha, 'unchecked'), 1);
    assert.equal(value(alpha, 'pchecked'), 50);
  });
  test('dates', () => {
    const first = value(alpha, 'first') as Date;
    assert.equal(first.getDate(), 1);
    const last = value(alpha, 'last') as Date;
    assert.equal(last.getDate(), 20, 'latest uses the end of ranges');
    const span = getRollupResult(alpha, p('span'), ctx);
    assert.equal(span.range?.start.getDate(), 1);
    assert.equal(span.range?.end?.getDate(), 20);
    assert.match(spaces(span.text ?? ''), /1 oct\. 2026 → 20 oct\. 2026 \(19 j\)/);
  });
  test('show original and nested rollups', () => {
    const orig = getRollupResult(alpha, p('orig'), ctx);
    assert.equal(orig.text, 'Cadrage, Dessin');
    assert.deepEqual(
      orig.items?.map((i) => i.row.id),
      ['t1', 't2'],
    );
    assert.equal(value(alpha, 'nested'), 2, 'each task has one project');
    // Circular definitions evaluate to empty instead of looping.
    assert.equal(value(alpha, 'loop'), 0);
  });
  test('formulas read rollups', () => {
    assert.equal(getFormulaResult(alpha, p('f'), ctx).value, 301);
  });
  test('kinds, sorting, filtering, grouping, calculations', () => {
    assert.equal(rollupKind(p('total')), 'number');
    assert.equal(rollupKind(p('first')), 'date');
    assert.equal(rollupKind(p('orig')), 'text');
    assert.equal(propertyKind(p('span')), 'date');
    assert.ok(rollupFunctionsForKind('number').includes('sum'));
    assert.ok(!rollupFunctionsForKind('text').includes('sum'));
    assert.ok(rollupFunctionsForKind('date').includes('date_range'));
    assert.deepEqual(
      applySorts(projects, [{ propertyId: 'heures', direction: 'desc' }], ctx).map((r) => r.id),
      ['p1', 'p2', 'p3'],
    );
    assert.deepEqual(
      applyFilter(projects, { conjunction: 'and', rules: [{ id: 'r', propertyId: 'count', operator: 'gt', value: 0 }] }, ctx).map((r) => r.id),
      ['p1', 'p2'],
    );
    assert.deepEqual(
      applyFilter(projects, { conjunction: 'and', rules: [{ id: 'r', propertyId: 'orig', operator: 'contains', value: 'dess' }] }, ctx).map((r) => r.id),
      ['p1'],
    );
    const groups = computeGroups(projects, p('count'), ctx);
    assert.deepEqual(
      groups.map((g) => [g.label, g.rows.length]),
      [
        ['0', 1],
        ['1', 1],
        ['2', 1],
      ],
    );
    assert.equal(spaces(computeCalculation(projects, p('total'), 'sum', 'number', ctx).display), '150,5');
    assert.equal(getText(alpha, p('orig'), ctx), 'Cadrage, Dessin');
  });
  test('missing configuration and unloaded data', () => {
    const bare = createRowContext(PROJECTS, {});
    assert.equal(getRollupResult(alpha, p('total'), bare).value, null);
    const broken: PropertyDef = { id: 'x', name: 'x', type: 'rollup', rollup: { relationPropertyId: 'nope', targetPropertyId: 'h', function: 'sum' } };
    assert.equal(getRollupResult(alpha, broken, ctx).error, 'Relation introuvable');
  });
});
