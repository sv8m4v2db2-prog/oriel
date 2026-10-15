/// <reference types="node" />
// I1 — manual order per view (pipeline, optimistic move) and default template per view.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRows } from './pipeline';
import { sortByManualOrder } from './sort';
import { afterIdForDrop, effectiveTemplateId, moveInViewOrder } from './viewOrder';
import { makeContext, makeRow, SCHEMA } from './testFixtures';
import { normalizeConfig } from './viewConfig';

const ctx = makeContext();
const rows = [
  makeRow('a', 'A', { prix: 3 }, { position: 'a0' }),
  makeRow('b', 'B', { prix: 1 }, { position: 'a1' }),
  makeRow('c', 'C', { prix: 2 }, { position: 'a2' }),
  makeRow('d', 'D', { prix: 4 }, { position: 'a3' }),
];
const ids = (list: { id: string }[]) => list.map((r) => r.id).join('');

describe('I1: manual order of a view', () => {
  test('without a view order, the page positions apply', () => {
    assert.equal(ids(sortByManualOrder(rows)), 'abcd');
    assert.equal(ids(sortByManualOrder(rows, {})), 'abcd');
  });

  test("the view's own order replaces the page position, rows absent from it keep theirs", () => {
    // d between a and b; c first.
    assert.equal(ids(sortByManualOrder(rows, { d: 'a0V', c: 'Zz' })), 'cadb');
  });

  test('an active sort takes precedence over the manual order (which breaks ties)', () => {
    const config = { filter: null, sorts: [{ propertyId: 'prix', direction: 'asc' as const }] };
    assert.equal(ids(deriveRows(rows, config, ctx, { rowOrder: { d: 'Zz' } })), 'bcad');
    const ties = { filter: null, sorts: [{ propertyId: 'notes', direction: 'asc' as const }] };
    assert.equal(ids(deriveRows(rows, ties, ctx, { rowOrder: { d: 'Zz', b: 'a5' } })), 'dacb', 'empty sort keys: manual order kept');
    assert.equal(ids(deriveRows(rows, { filter: null, sorts: [] }, ctx, { rowOrder: { d: 'Zz' } })), 'dabc');
  });

  test('moving a row writes only the moved row (and renumbers equal keys)', () => {
    const moved = moveInViewOrder(rows, undefined, 'a', 'c');
    assert.deepEqual(Object.keys(moved), ['a']);
    assert.equal(ids(sortByManualOrder(rows, moved)), 'bcad');
    const first = moveInViewOrder(rows, moved, 'd', null);
    assert.equal(ids(sortByManualOrder(rows, first)), 'dbca');
    const same = rows.map((r) => ({ ...r, position: 'a0' }));
    const renumbered = moveInViewOrder(same, undefined, 'd', 'a');
    assert.equal(ids(sortByManualOrder(same, renumbered)), 'adbc');
    assert.equal(Object.keys(renumbered).length, 4);
  });
});

describe('I1: drop in a list or gallery section', () => {
  test('after the previous row of the section, else after the row preceding the section', () => {
    const all = ['a', 'b', 'c', 'd', 'e'];
    assert.equal(afterIdForDrop(all, all, 'a', 'c', 'after'), 'c');
    assert.equal(afterIdForDrop(all, all, 'e', 'b', 'before'), 'a');
    assert.equal(afterIdForDrop(all, all, 'c', 'a', 'before'), null, 'first of the view');
    // Section [c, d] of a grouped view: dropping d before c puts it after b (preceding the section).
    assert.equal(afterIdForDrop(['c', 'd'], all, 'd', 'c', 'before'), 'b');
    assert.equal(afterIdForDrop(all, all, 'a', 'a', 'after'), undefined);
    assert.equal(afterIdForDrop(['c'], all, 'x', 'z', 'after'), undefined);
  });
});

describe('I1: default template of a view', () => {
  const templates = [{ id: 't1' }, { id: 't2' }];
  test('view default, blank, database default, stale ids', () => {
    assert.equal(effectiveTemplateId(undefined, 't1', templates), 't1');
    assert.equal(effectiveTemplateId(null, 't1', templates), 't1');
    assert.equal(effectiveTemplateId('t2', 't1', templates), 't2');
    assert.equal(effectiveTemplateId('blank', 't1', templates), null);
    assert.equal(effectiveTemplateId('gone', 't1', templates), 't1', 'deleted view template');
    assert.equal(effectiveTemplateId(undefined, 'gone', templates), null, 'deleted database template');
    assert.equal(effectiveTemplateId(undefined, null, templates), null);
  });

  test('the view config keeps its default template', () => {
    assert.equal(normalizeConfig({ defaultTemplateId: 't2' }, 'table', SCHEMA).defaultTemplateId, 't2');
    assert.equal(normalizeConfig({ defaultTemplateId: 'blank' }, 'board', SCHEMA).defaultTemplateId, 'blank');
    assert.equal(normalizeConfig({ defaultTemplateId: null }, 'table', SCHEMA).defaultTemplateId, undefined);
  });
});
