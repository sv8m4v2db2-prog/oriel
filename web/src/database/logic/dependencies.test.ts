/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from '@oriel/shared';
import { cascadeShift, conflictingRows, dependencyCandidates, dependencyEdges, dependentsOf, rowDaySpan } from './dependencies';
import { createRowContext } from './values';
import { makeRow } from './testFixtures';

const PROPS: PropertyDef[] = [
  { id: 'title', name: 'Nom', type: 'title' },
  { id: 'd', name: 'Dates', type: 'date' },
  { id: 'fin', name: 'Fin', type: 'date' },
  { id: 'bp', name: 'Bloqué par', type: 'relation', relation: { databaseId: 'db', syncedPropertyId: 'b' } },
  { id: 'b', name: 'Bloque', type: 'relation', relation: { databaseId: 'db', syncedPropertyId: 'bp' } },
  { id: 'autre', name: 'Projet', type: 'relation', relation: { databaseId: 'other' } },
];
const ctx = createRowContext(PROPS);
const p = (id: string) => PROPS.find((x) => x.id === id)!;

const rows = [
  makeRow('cadrage', 'Cadrage', { d: { start: '2026-10-12', end: '2026-10-15' } }),
  makeRow('dessin', 'Dessin', { d: { start: '2026-10-16', end: '2026-10-21' }, bp: ['cadrage'] }),
  makeRow('bilan', 'Bilan', { d: { start: '2026-10-20', end: '2026-10-23' }, bp: ['dessin'] }),
  makeRow('recette', 'Recette', { d: { start: '2026-10-25' }, fin: { start: '2026-10-27' }, bp: ['dessin', 'ghost'] }),
  makeRow('livraison', 'Livraison', { bp: ['bilan', 'recette'] }),
  // A cycle must not loop.
  makeRow('x', 'X', { bp: ['y'] }),
  makeRow('y', 'Y', { bp: ['x'] }),
];

describe('timeline dependencies', () => {
  test('candidates are self relations', () => {
    assert.deepEqual(
      dependencyCandidates(PROPS, 'db').map((x) => x.id),
      ['bp', 'b'],
    );
  });
  test('edges go from blocker to blocked (unknown rows ignored)', () => {
    const edges = dependencyEdges(rows, p('bp'));
    assert.deepEqual(edges.slice(0, 3), [
      { from: 'cadrage', to: 'dessin' },
      { from: 'dessin', to: 'bilan' },
      { from: 'dessin', to: 'recette' },
    ]);
    assert.ok(!edges.some((e) => e.from === 'ghost'));
  });
  test('conflicts: blocked row starting before its blocker ends', () => {
    const edges = dependencyEdges(rows, p('bp'));
    const spans = new Map(rows.map((r) => [r.id, rowDaySpan(r, p('d'), null, ctx)] as const));
    const conflicts = conflictingRows(edges, (id) => spans.get(id) ?? null);
    assert.deepEqual([...conflicts], ['bilan']);
  });
  test('end property overrides the range end', () => {
    const span = rowDaySpan(rows[3]!, p('d'), p('fin'), ctx)!;
    assert.equal(span.end.getDate(), 27);
  });
  test('transitive dependents, cycles ignored', () => {
    assert.deepEqual(dependentsOf(rows, p('bp'), 'cadrage'), ['dessin', 'bilan', 'recette', 'livraison']);
    assert.deepEqual(dependentsOf(rows, p('bp'), 'x'), ['y']);
  });
  test('cascade shift keeps the gaps (dates shifted by the same delta)', () => {
    const patches = cascadeShift(rows, p('bp'), 'cadrage', 3, p('d'), p('fin'));
    assert.deepEqual(
      patches.map((x) => x.rowId),
      ['dessin', 'bilan', 'recette'],
      'rows without dates are skipped',
    );
    assert.deepEqual(patches[0]!.properties, { d: { start: '2026-10-19', end: '2026-10-24', includeTime: undefined } });
    assert.deepEqual(patches[2]!.properties, {
      d: { start: '2026-10-28', end: undefined, includeTime: undefined },
      fin: { start: '2026-10-30', end: undefined, includeTime: undefined },
    });
    assert.deepEqual(cascadeShift(rows, p('bp'), 'cadrage', 0, p('d'), null), []);
  });
});
