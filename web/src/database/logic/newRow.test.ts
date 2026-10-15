/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FilterGroup, FilterOperator, FilterRule } from '@oriel/shared';
import { applyFilter } from './filter';
import { valuesForNewRow } from './newRow';
import { makeContext, makeRow } from './testFixtures';

const ctx = makeContext();
const rule = (propertyId: string, operator: FilterOperator, value?: unknown): FilterRule => ({
  id: `${propertyId}-${operator}`,
  propertyId,
  operator,
  value,
});

/** Builds the would-be row and checks it passes the filter. */
function visible(filter: FilterGroup): boolean {
  const v = valuesForNewRow(filter, ctx);
  const row = makeRow('new', v.title ?? '', v.properties);
  return applyFilter([row], filter, ctx).length === 1;
}

describe('values for a new row in a filtered view', () => {
  test('no filter → nothing', () => {
    assert.deepEqual(valuesForNewRow(null, ctx), { properties: {} });
  });
  test('AND: every satisfiable rule is applied', () => {
    const filter: FilterGroup = {
      conjunction: 'and',
      rules: [
        rule('cat', 'equals', 'o2'),
        rule('tags', 'contains', 't1'),
        rule('fait', 'checked'),
        rule('prix', 'gt', 100),
        rule('due', 'within', 'next_week'),
        rule('title', 'starts_with', 'Bug'),
        rule('resp', 'contains', 'u2'),
      ],
    };
    const v = valuesForNewRow(filter, ctx);
    assert.equal(v.title, 'Bug');
    assert.equal(v.properties.cat, 'o2');
    assert.deepEqual(v.properties.tags, ['t1']);
    assert.equal(v.properties.fait, true);
    assert.equal(v.properties.prix, 101);
    assert.deepEqual(v.properties.due, { start: '2026-10-13' });
    assert.deepEqual(v.properties.resp, ['u2']);
    assert.ok(visible(filter));
  });
  test('date operators produce matching days', () => {
    for (const op of ['equals', 'before', 'after', 'on_or_before', 'on_or_after'] as const) {
      assert.ok(visible({ conjunction: 'and', rules: [rule('due', op, '2026-12-01')] }), op);
    }
    assert.ok(visible({ conjunction: 'and', rules: [rule('due', 'within', 'past_month')] }));
    assert.ok(visible({ conjunction: 'and', rules: [rule('due', 'is_not_empty')] }));
  });
  test('number operators', () => {
    for (const op of ['equals', 'gt', 'lt', 'gte', 'lte'] as const) {
      assert.ok(visible({ conjunction: 'and', rules: [rule('qte', op, '5')] }), op);
    }
  });
  test('select is_not_empty / not_equals pick an option', () => {
    assert.ok(visible({ conjunction: 'and', rules: [rule('cat', 'is_not_empty')] }));
    const v = valuesForNewRow({ conjunction: 'and', rules: [rule('cat', 'not_equals', 'o1')] }, ctx);
    assert.equal(v.properties.cat, 'o2');
  });
  test('OR: the first satisfiable rule wins', () => {
    const filter: FilterGroup = {
      conjunction: 'or',
      rules: [rule('total', 'gt', 3), rule('notes', 'not_contains', 'x'), rule('etat', 'equals', 'doing'), rule('fait', 'checked')],
    };
    assert.deepEqual(valuesForNewRow(filter, ctx), { properties: { etat: 'doing' } });
    assert.ok(visible(filter));
  });
  test('computed properties are never written', () => {
    const v = valuesForNewRow({ conjunction: 'and', rules: [rule('ref', 'equals', 3), rule('cree', 'equals', 'today')] }, ctx);
    assert.deepEqual(v.properties, {});
  });
});

describe('new rows with the filters of G1', () => {
  test('« contains all » and « me » fill the people and options', async () => {
    const { valuesForNewRow } = await import('./newRow');
    const { createRowContext } = await import('./values');
    const { SCHEMA, USERS, NOW } = await import('./testFixtures');
    const ctx = createRowContext(SCHEMA, { users: USERS, now: () => NOW, currentUserId: 'u1' });
    const rule = (propertyId: string, operator: string, value: unknown) => ({ id: propertyId, propertyId, operator, value });
    const v = valuesForNewRow(
      { conjunction: 'and', rules: [rule('tags', 'contains_all', ['t1', 't2']), rule('resp', 'contains', '@me')] } as never,
      ctx,
    );
    assert.deepEqual(v.properties.tags, ['t1', 't2']);
    assert.deepEqual(v.properties.resp, ['u1']);
  });
  test('durations give a date that keeps the row visible', async () => {
    const { valuesForNewRow } = await import('./newRow');
    const { createRowContext } = await import('./values');
    const { SCHEMA, NOW } = await import('./testFixtures');
    const ctx = createRowContext(SCHEMA, { now: () => NOW });
    const rule = (operator: string, value: unknown) => ({ id: 'd', propertyId: 'due', operator, value });
    const f = (op: string, value: unknown) =>
      valuesForNewRow({ conjunction: 'and', rules: [rule(op, value)] } as never, ctx).properties.due;
    assert.deepEqual(f('within_last', { amount: 7, unit: 'day' }), { start: '2026-10-13' });
    assert.deepEqual(f('exactly_ago', { amount: 3, unit: 'day' }), { start: '2026-10-10' });
    assert.deepEqual(f('exactly_ahead', { amount: 1, unit: 'week' }), { start: '2026-10-20' });
  });
});
