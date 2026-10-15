/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, makeRow, prop, USERS } from '../logic/testFixtures';
import { isComputedType } from '../logic/values';
import { copyMatrix, planClear, planFillDown, planPaste, relationRowsFor, skippedMessage, type GridColumn } from './plan';
import { cellCount, moveRange, rangeBounds, rowSelection, tabRange, type GridRange } from './range';
import { parseTsv, toTsv } from './tsv';

const ctx = makeContext();
const col = (id: string): GridColumn => ({ prop: prop(id), writable: !isComputedType(prop(id).type) });
const cx = { users: USERS, relationRows: new Map([['liens', [{ id: 'p1', title: 'Projet Alpha' }]]]) };

describe('ranges', () => {
  test('bounds whatever the drag direction', () => {
    const r: GridRange = { anchor: { row: 5, col: 3 }, focus: { row: 2, col: 1 } };
    assert.deepEqual(rangeBounds(r), { top: 2, bottom: 5, left: 1, right: 3 });
    assert.equal(cellCount(rangeBounds(r)), 12);
  });
  test('arrows move or extend, clamped to the grid', () => {
    const r: GridRange = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
    assert.deepEqual(moveRange(r, 'up', false, 10, 4), r);
    const ext = moveRange(moveRange(r, 'down', true, 10, 4), 'right', true, 10, 4);
    assert.deepEqual(ext, { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 1 } });
    assert.deepEqual(moveRange(ext, 'down', false, 10, 4), { anchor: { row: 2, col: 1 }, focus: { row: 2, col: 1 } });
  });
  test('tab wraps to the next row', () => {
    const r: GridRange = { anchor: { row: 0, col: 3 }, focus: { row: 0, col: 3 } };
    assert.deepEqual(tabRange(r, false, 10, 4).focus, { row: 1, col: 0 });
    assert.deepEqual(tabRange({ anchor: { row: 1, col: 0 }, focus: { row: 1, col: 0 } }, true, 10, 4).focus, { row: 0, col: 3 });
  });
  test('row selection for rendering', () => {
    const b = { top: 1, bottom: 3, left: 0, right: 2 };
    assert.equal(rowSelection(b, { row: 1, col: 2 }, 0), null);
    assert.deepEqual(rowSelection(b, { row: 1, col: 2 }, 1), { left: 0, right: 2, top: true, bottom: false, active: 2 });
    assert.equal(rowSelection(b, { row: 1, col: 2 }, 3)!.bottom, true);
  });
});

describe('TSV', () => {
  test('round trip with tabs, line breaks and quotes', () => {
    const m = [['a', 'b\tc'], ['ligne\nsuite', 'il dit "oui"']];
    assert.deepEqual(parseTsv(toTsv(m)), m);
  });
  test('spreadsheet clipboard: CRLF, trailing newline, ragged rows', () => {
    assert.deepEqual(parseTsv('1\t2\r\n3\r\n'), [['1', '2'], ['3', '']]);
    assert.deepEqual(parseTsv(''), []);
    assert.deepEqual(parseTsv('x\t'), [['x', '']]);
  });
  test('a quote inside an unquoted cell stays literal', () => {
    assert.deepEqual(parseTsv('5" pouces\tok'), [['5" pouces', 'ok']]);
    assert.deepEqual(parseTsv('"pas fermé\tb'), [['"pas fermé', 'b']]);
  });
});

describe('copy', () => {
  test('readable values, decimal comma', () => {
    const rows = [makeRow('a', 'Alpha', { prix: 10.5, cat: 'o2', fait: true, resp: ['u1'] })];
    const props = ['title', 'prix', 'cat', 'fait', 'resp'].map(prop);
    assert.deepEqual(copyMatrix(rows, props, { top: 0, bottom: 0, left: 0, right: 4 }, ctx), [['Alpha', '10,5', 'Rouge', 'Oui', 'Alice Martin']]);
  });
});

describe('paste', () => {
  const cols = ['title', 'prix', 'cat', 'tags', 'due', 'fait', 'total', 'resp', 'liens'].map(col);
  test('converts each value to the property type', () => {
    const m = parseTsv('Bêta\t1 234,5 €\tvert\tUrgent, Client\t13/10/2026\toui\t999\tbruno@example.test\tProjet Alpha');
    const plan = planPaste(m, { row: 0, col: 0 }, 3, cols, cx);
    assert.deepEqual(plan.writes.get(0), {
      title: 'Bêta',
      properties: { prix: 1234.5, cat: 'o3', tags: ['t1', 't2'], due: { start: '2026-10-13' }, fait: true, resp: ['u2'], liens: ['p1'] },
    });
    assert.equal(plan.readOnly, 1); // formula
    assert.equal(plan.invalid, 0);
    assert.equal(plan.cells, 8);
  });
  test('empty cells clear, unknown values are skipped, unknown options are created', () => {
    const m = [['', 'abc', 'Violet']];
    const plan = planPaste(m, { row: 1, col: 0 }, 3, cols, cx);
    assert.deepEqual(plan.writes.get(1), { title: '', properties: { cat: plan.newOptions.get('cat')![0]!.id } });
    assert.equal(plan.invalid, 1);
    assert.equal(plan.newOptions.get('cat')![0]!.name, 'Violet');
    const noCreate = planPaste(m, { row: 1, col: 0 }, 3, cols, cx, { createOptions: false });
    assert.equal(noCreate.invalid, 2);
  });
  test('clear a value with an empty cell', () => {
    const plan = planPaste([['']], { row: 0, col: 1 }, 1, cols, cx);
    assert.deepEqual(plan.writes.get(0), { properties: { prix: null } });
  });
  test('rows and columns beyond the grid are reported', () => {
    const m = parseTsv('1\t2\n3\t4\n5\t6');
    const plan = planPaste(m, { row: 1, col: 1 }, 2, cols.slice(0, 2), cx);
    assert.equal(plan.droppedCols, 1);
    assert.equal(plan.extraRows, 2);
    assert.ok(plan.writes.has(3)); // planned, created after confirmation
  });
  test('a single value fills the selected range', () => {
    const plan = planPaste([['7']], { row: 0, col: 1 }, 5, cols, cx, { range: { top: 1, bottom: 3, left: 1, right: 1 } });
    assert.deepEqual([...plan.writes.keys()], [1, 2, 3]);
    assert.deepEqual(plan.writes.get(2), { properties: { prix: 7 } });
  });
  test('summary of skipped cells', () => {
    assert.equal(skippedMessage({ readOnly: 0, invalid: 0, droppedCols: 0 }), null);
    assert.equal(skippedMessage({ readOnly: 2, invalid: 1, droppedCols: 0 }), 'Ignoré : 2 cellules calculées ou en lecture seule, 1 valeur non reconnue.');
  });
});

describe('fill down and clear', () => {
  const rows = [makeRow('a', 'A', { prix: 3, cat: 'o1' }), makeRow('b', 'B', { prix: 4 }), makeRow('c', 'C')];
  const cols = ['title', 'prix', 'cat', 'total'].map(col);
  test('copies the first row of the range into the next ones', () => {
    const plan = planFillDown(rows, cols, { top: 0, bottom: 2, left: 1, right: 3 });
    assert.deepEqual(plan.writes.get(1), { properties: { prix: 3, cat: 'o1' } });
    assert.deepEqual(plan.writes.get(2), { properties: { prix: 3, cat: 'o1' } });
    assert.equal(plan.readOnly, 2);
    assert.equal(planFillDown(rows, cols, { top: 0, bottom: 0, left: 0, right: 3 }).cells, 0);
  });
  test('clear empties writable cells only', () => {
    const plan = planClear(3, cols, { top: 1, bottom: 2, left: 0, right: 3 });
    assert.deepEqual(plan.writes.get(1), { title: '', properties: { prix: null, cat: null } });
    assert.equal(plan.readOnly, 2);
  });
});

test('relation rows by property', () => {
  const m = relationRowsFor([prop('liens'), prop('cat')], (db) => (db === 'db2' ? [{ id: 'p1', title: 'X' }] : undefined));
  assert.deepEqual([...m.keys()], ['liens']);
});
