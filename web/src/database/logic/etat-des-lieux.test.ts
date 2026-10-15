/// <reference types="node" />
// Non-regression of calculation anomalies found in an internal review: formula kind, rollups across
// databases, unique values, now(), board moves.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, PropertyDef } from '@oriel/shared';
import { applyFilter } from './filter';
import { computeGroups, moveGroupValue, NO_VALUE_KEY } from './group';
import { createRowContext, getFormulaResult, getRollupResult, propertyKind, type RelatedResolver, type RowContext } from './values';
import { makeContext, makeRow, prop, SCHEMA, USERS } from './testFixtures';

/** Contexts of several databases sharing one resolver (rows looked up by id). */
function universe(schemas: Record<string, PropertyDef[]>, rows: Page[], now?: () => Date) {
  const all = new Map(rows.map((r) => [r.id, r]));
  const contexts = new Map<string, RowContext>();
  const resolver: RelatedResolver = {
    row: (id) => all.get(id),
    context: (db) => {
      if (!contexts.has(db) && schemas[db]) contexts.set(db, createRowContext(schemas[db]!, { users: USERS, related: resolver, now }));
      return contexts.get(db);
    },
  };
  return resolver;
}

describe('formula kind is inferred from every row', () => {
  const schema: PropertyDef[] = [...SCHEMA, { id: 'fp', name: 'Prix calculé', type: 'formula', formula: 'prop("Prix")' }];
  const rows = Array.from({ length: 51 }, (_, i) => makeRow(`r${i}`, `L${i}`, i === 50 ? { prix: 12 } : {}));

  test('50 empty results then a number: the formula is a number', () => {
    const ctx = makeContext(schema);
    assert.equal(propertyKind(schema.at(-1)!, rows, ctx), 'number');
  });

  test('a numeric filter keeps only the matching row', () => {
    const ctx = makeContext(schema);
    const kept = applyFilter(rows, { conjunction: 'and', rules: [{ id: 'g', propertyId: 'fp', operator: 'gt', value: 10 }] }, ctx);
    assert.deepEqual(kept.map((r) => r.id), ['r50']);
  });

  test('empty strings do not decide the kind', () => {
    const s: PropertyDef[] = [...SCHEMA, { id: 'fq', name: 'Q', type: 'formula', formula: 'if(prop("Quantité") > 0, prop("Quantité"), "")' }];
    const rs = [makeRow('a', 'A', {}), makeRow('b', 'B', { qte: 3 })];
    assert.equal(propertyKind(s.at(-1)!, rs, makeContext(s)), 'number');
  });
});

describe('rollups of rollups across databases', () => {
  test('two rollups with the same id in two databases are not a cycle', () => {
    const schemas: Record<string, PropertyDef[]> = {
      clients: [
        { id: 'title', name: 'Nom', type: 'title' },
        { id: 'rel', name: 'Projets', type: 'relation', relation: { databaseId: 'projets' } },
        { id: 'r', name: 'Heures', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'r', function: 'sum' } },
      ],
      projets: [
        { id: 'title', name: 'Nom', type: 'title' },
        { id: 'rel', name: 'Tâches', type: 'relation', relation: { databaseId: 'taches' } },
        { id: 'r', name: 'Heures', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'h', function: 'sum' } },
      ],
      taches: [
        { id: 'title', name: 'Nom', type: 'title' },
        { id: 'h', name: 'Heures', type: 'number' },
      ],
    };
    const client = makeRow('c1', 'Client', { rel: ['p1'] }, { parentId: 'clients' });
    const rows = [
      client,
      makeRow('p1', 'Projet', { rel: ['t1', 't2'] }, { parentId: 'projets' }),
      makeRow('t1', 'T1', { h: 120 }, { parentId: 'taches' }),
      makeRow('t2', 'T2', { h: 80 }, { parentId: 'taches' }),
    ];
    const resolver = universe(schemas, rows);
    const ctx = resolver.context('clients')!;
    const r = getRollupResult(client, schemas.clients![2]!, ctx);
    assert.equal(r.error, undefined);
    assert.equal(r.value, 200);
  });

  test('a real cycle across databases is still reported', () => {
    const schemas: Record<string, PropertyDef[]> = {
      a: [
        { id: 'rel', name: 'B', type: 'relation', relation: { databaseId: 'b' } },
        { id: 'x', name: 'X', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'y', function: 'sum' } },
      ],
      b: [
        { id: 'rel', name: 'A', type: 'relation', relation: { databaseId: 'a' } },
        { id: 'y', name: 'Y', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'x', function: 'sum' } },
      ],
    };
    const ra = makeRow('ra', 'A', { rel: ['rb'] }, { parentId: 'a' });
    const resolver = universe(schemas, [ra, makeRow('rb', 'B', { rel: ['ra'] }, { parentId: 'b' })]);
    const r = getRollupResult(ra, schemas.a![1]!, resolver.context('a')!);
    assert.equal(r.value, 0, 'the circular target counts as empty');
  });
});

describe('unique values use typed raw values', () => {
  const schemas: Record<string, PropertyDef[]> = {
    projets: [
      { id: 'title', name: 'Nom', type: 'title' },
      { id: 'rel', name: 'Dépenses', type: 'relation', relation: { databaseId: 'dep' } },
      { id: 'u', name: 'Montants distincts', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'm', function: 'count_unique' } },
      { id: 'ud', name: 'Dates distinctes', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'd', function: 'count_unique' } },
      { id: 'uf', name: 'Formules distinctes', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'f', function: 'count_unique' } },
    ],
    dep: [
      { id: 'title', name: 'Nom', type: 'title' },
      { id: 'm', name: 'Montant', type: 'number', numberFormat: 'euro' },
      { id: 'd', name: 'Quand', type: 'date' },
      { id: 'f', name: 'Double', type: 'formula', formula: 'prop("Montant") * 2' },
    ],
  };
  const projet = makeRow('p', 'P', { rel: ['e1', 'e2', 'e3'] }, { parentId: 'projets' });
  const rows = [
    projet,
    makeRow('e1', 'E1', { m: 1.231, d: { start: '2026-10-15T09:00' } }, { parentId: 'dep' }),
    makeRow('e2', 'E2', { m: 1.232, d: { start: '2026-10-15T09:00:30' } }, { parentId: 'dep' }),
    makeRow('e3', 'E3', { m: 1.231, d: { start: '2026-10-15T09:00' } }, { parentId: 'dep' }),
  ];
  const resolver = universe(schemas, rows);
  const ctx = resolver.context('projets')!;
  const unique = (id: string) => getRollupResult(projet, schemas.projets!.find((p) => p.id === id)!, ctx).value;

  test('1,231 € and 1,232 € are two values', () => assert.equal(unique('u'), 2));
  test('dates and formula results too', () => {
    assert.equal(unique('ud'), 2);
    assert.equal(unique('uf'), 2);
  });
});

describe('now() follows the clock', () => {
  const schema: PropertyDef[] = [
    ...SCHEMA,
    { id: 'jours', name: 'Jours restants', type: 'formula', formula: 'dateBetween(prop("Échéance"), now(), "days")' },
    { id: 'suite', name: 'Suite', type: 'formula', formula: 'prop("Jours restants") + 1' },
    { id: 'fixe', name: 'Fixe', type: 'formula', formula: 'prop("Quantité") * 2' },
  ];
  const p = (id: string) => schema.find((x) => x.id === id)!;
  const row = makeRow('r', 'R', { due: { start: '2026-10-20' }, qte: 2 });

  test('advancing the clock refreshes now() in the same context', () => {
    let clock = new Date(2026, 9, 13, 10, 30);
    const ctx = createRowContext(schema, { users: USERS, now: () => clock });
    assert.equal(getFormulaResult(row, p('jours'), ctx).value, 6);
    assert.equal(getFormulaResult(row, p('suite'), ctx).value, 7);
    const fixed = getFormulaResult(row, p('fixe'), ctx);
    clock = new Date(2026, 9, 15, 10, 30);
    assert.equal(getFormulaResult(row, p('jours'), ctx).value, 4);
    assert.equal(getFormulaResult(row, p('suite'), ctx).value, 5, 'formulas reading a time-dependent one follow');
    assert.equal(getFormulaResult(row, p('fixe'), ctx), fixed, 'time-independent results stay cached');
  });

  test('results stay cached within the same minute', () => {
    let clock = new Date(2026, 9, 13, 10, 30, 5);
    const ctx = createRowContext(schema, { users: USERS, now: () => clock });
    const first = getFormulaResult(row, p('jours'), ctx);
    clock = new Date(2026, 9, 13, 10, 30, 40);
    assert.equal(getFormulaResult(row, p('jours'), ctx), first);
  });

  test('rollups over a time-dependent formula follow too', () => {
    let clock = new Date(2026, 9, 13, 10, 30);
    const schemas: Record<string, PropertyDef[]> = {
      a: [
        { id: 'rel', name: 'Tâches', type: 'relation', relation: { databaseId: 'b' } },
        { id: 's', name: 'Somme', type: 'rollup', rollup: { relationPropertyId: 'rel', targetPropertyId: 'j', function: 'sum' } },
      ],
      b: [
        { id: 'due', name: 'Échéance', type: 'date' },
        { id: 'j', name: 'Jours', type: 'formula', formula: 'dateBetween(prop("Échéance"), now(), "days")' },
      ],
    };
    const ra = makeRow('ra', 'A', { rel: ['rb'] }, { parentId: 'a' });
    const resolver = universe(schemas, [ra, makeRow('rb', 'B', { due: { start: '2026-10-20' } }, { parentId: 'b' })], () => clock);
    const ctx = resolver.context('a')!;
    assert.equal(getRollupResult(ra, schemas.a![1]!, ctx).value, 6);
    clock = new Date(2026, 9, 16, 10, 30);
    assert.equal(getRollupResult(ra, schemas.a![1]!, ctx).value, 3);
  });
});

describe('moving a card between groups of a multi-valued property', () => {
  const ctx = makeContext();
  const group = (rows: Page[], id: string, key: string) => computeGroups(rows, prop(id), ctx).find((g) => g.key === key)!;

  test('multi-select: the source tag is replaced, the others are kept', () => {
    const row = makeRow('r', 'R', { tags: ['t1', 'x', 't2'] });
    const schema: PropertyDef = { ...prop('tags'), options: [...prop('tags').options!, { id: 't3', name: 'Interne', color: 'gray' }] };
    const c = makeContext(SCHEMA.map((p) => (p.id === 'tags' ? schema : p)));
    const to = computeGroups([row], schema, c).find((g) => g.key === 't3')!;
    assert.deepEqual(moveGroupValue(row, schema, 't1', to), ['x', 't2', 't3']);
  });

  test('target already present: only the source is removed', () => {
    const row = makeRow('r', 'R', { tags: ['t1', 't2'] });
    assert.deepEqual(moveGroupValue(row, prop('tags'), 't1', group([row], 'tags', 't2')), ['t2']);
  });

  test('from « Sans valeur », the target is added', () => {
    const row = makeRow('r', 'R', { resp: [] });
    const other = makeRow('o', 'O', { resp: ['u2'] });
    assert.deepEqual(moveGroupValue(row, prop('resp'), NO_VALUE_KEY, group([row, other], 'resp', 'u2')), ['u2']);
  });

  test('people and relations keep the other values', () => {
    const row = makeRow('r', 'R', { resp: ['u1', 'u2'], liens: ['p1', 'p3'] });
    const other = makeRow('o', 'O', { liens: ['p2'] });
    assert.deepEqual(moveGroupValue(row, prop('resp'), 'u1', group([row], 'resp', 'u2')), ['u2']);
    const rows = [row, other];
    assert.deepEqual(moveGroupValue(row, prop('liens'), 'p1', group(rows, 'liens', 'p2')), ['p3', 'p2']);
  });

  test('dropping into « Sans valeur » empties the list', () => {
    const row = makeRow('r', 'R', { tags: ['t1', 't2'] });
    assert.deepEqual(moveGroupValue(row, prop('tags'), 't1', group([row], 'tags', NO_VALUE_KEY)), []);
  });

  test('single-valued properties take the group value', () => {
    const row = makeRow('r', 'R', { cat: 'o1' });
    assert.equal(moveGroupValue(row, prop('cat'), 'o1', group([row], 'cat', 'o2')), 'o2');
  });

  test('a single-page relation is replaced', () => {
    const single: PropertyDef = { ...prop('liens'), relation: { databaseId: 'db2', singlePage: true } };
    const row = makeRow('r', 'R', { liens: ['p1'] });
    const to = computeGroups([row, makeRow('o', 'O', { liens: ['p2'] })], single, ctx).find((g) => g.key === 'p2')!;
    assert.deepEqual(moveGroupValue(row, single, 'p1', to), ['p2']);
  });
});

