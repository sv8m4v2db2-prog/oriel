/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from '@oriel/shared';
import {
  createRowContext,
  getFormulaResult,
  isEmptyValue,
  orderedOptions,
  propertyKind,
  toFormulaValue,
} from './values';
import { makeContext, makeRow, NOW, prop, SCHEMA, USERS } from './testFixtures';

describe('row values', () => {
  const ctx = makeContext();
  const row = makeRow('r', 'Titre', {
    prix: 4,
    qte: 3,
    cat: 'o1',
    tags: ['t2'],
    resp: ['u1'],
    due: { start: '2026-10-20' },
    fait: true,
    liens: ['p2'],
  });

  test('formula over other properties', () => {
    assert.deepEqual(getFormulaResult(row, prop('total'), ctx), { type: 'number', value: 12 });
  });

  test('formula values passed through prop()', () => {
    assert.equal(toFormulaValue(row, prop('title'), ctx), 'Titre');
    assert.equal(toFormulaValue(row, prop('cat'), ctx), 'Bleu');
    // I2 : les propriétés multivaluées sont des listes qui gardent leur ancien texte (legacy).
    assert.deepEqual(toFormulaValue(row, prop('tags'), ctx), { kind: 'list', items: ['Client'], legacy: 'Client' });
    assert.deepEqual(toFormulaValue(row, prop('resp'), ctx), {
      kind: 'list',
      items: [{ kind: 'person', id: 'u1', name: 'Alice Martin', email: 'alice@example.test' }],
      legacy: 'Alice Martin',
    });
    assert.deepEqual(toFormulaValue(row, prop('liens'), ctx), {
      kind: 'list',
      items: [{ kind: 'page', id: 'p2', title: 'Projet Béta' }],
      legacy: 'Projet Béta',
    });
    assert.equal(toFormulaValue(row, prop('fait'), ctx), true);
    const d = toFormulaValue(row, prop('due'), ctx);
    assert.ok(d instanceof Date && d.getDate() === 20);
    assert.equal(toFormulaValue(row, prop('notes'), ctx), '');
    assert.equal(toFormulaValue(row, prop('prix'), ctx), 4);
  });

  test('formulas referencing formulas, missing props and cycles', () => {
    const schema: PropertyDef[] = [
      ...SCHEMA,
      { id: 'f2', name: 'Double', type: 'formula', formula: 'prop("Total") * 2' },
      { id: 'f3', name: 'Cassé', type: 'formula', formula: 'prop("Inconnue") + 1' },
      { id: 'c1', name: 'A', type: 'formula', formula: 'prop("B")' },
      { id: 'c2', name: 'B', type: 'formula', formula: 'prop("A")' },
      { id: 'f4', name: 'Retard', type: 'formula', formula: 'dateBetween(prop("Échéance"), now(), "days")' },
      { id: 'f5', name: 'Syntaxe', type: 'formula', formula: '1 +' },
    ];
    const c = createRowContext(schema, { users: USERS, now: () => NOW });
    const p = (id: string) => schema.find((x) => x.id === id)!;
    assert.deepEqual(getFormulaResult(row, p('f2'), c), { type: 'number', value: 24 });
    const broken = getFormulaResult(row, p('f3'), c);
    assert.equal(broken.type, 'empty');
    assert.ok(broken.error);
    assert.equal(getFormulaResult(row, p('c1'), c).type, 'empty');
    assert.deepEqual(getFormulaResult(row, p('f4'), c), { type: 'number', value: 6 });
    const syntax = getFormulaResult(row, p('f5'), c);
    assert.equal(syntax.type, 'empty');
    assert.ok(syntax.error);
  });

  test('formula results are cached per row object', () => {
    const c = makeContext();
    const a = getFormulaResult(row, prop('total'), c);
    assert.equal(getFormulaResult(row, prop('total'), c), a);
  });

  test('kinds', () => {
    assert.equal(propertyKind(prop('title')), 'text');
    assert.equal(propertyKind(prop('ref')), 'number');
    assert.equal(propertyKind(prop('etat')), 'select');
    assert.equal(propertyKind(prop('auteur')), 'person');
    assert.equal(propertyKind(prop('cree')), 'date');
    assert.equal(propertyKind(prop('total'), [row], ctx), 'number');
    assert.equal(propertyKind(prop('total')), 'text');
  });

  test('emptiness', () => {
    const empty = makeRow('e', '  ', { tags: ['ghost'], cat: 'ghost', fait: false, pj: [] });
    assert.equal(isEmptyValue(empty, prop('title'), ctx), true);
    assert.equal(isEmptyValue(empty, prop('tags'), ctx), true);
    assert.equal(isEmptyValue(empty, prop('cat'), ctx), true);
    assert.equal(isEmptyValue(empty, prop('pj'), ctx), true);
    assert.equal(isEmptyValue(empty, prop('cree'), ctx), false);
    assert.equal(isEmptyValue(row, prop('due'), ctx), false);
    assert.equal(isEmptyValue(empty, prop('total'), ctx), true);
  });

  test('status options are ordered by group', () => {
    assert.deepEqual(orderedOptions(prop('etat')).map((o) => o.id), ['todo', 'doing', 'done']);
    assert.deepEqual(orderedOptions(prop('cat')).map((o) => o.id), ['o1', 'o2', 'o3']);
  });
});
