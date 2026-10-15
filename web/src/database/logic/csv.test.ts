/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from '@oriel/shared';
import {
  buildCsv,
  csvCell,
  csvToValue,
  inferColumnType,
  missingOptions,
  parseCsv,
  parseCsvBoolean,
  parseCsvDate,
  parseCsvNumber,
} from './csv';
import { makeContext, makeRow, prop, USERS } from './testFixtures';

const ctx = makeContext();

describe('CSV export', () => {
  const row = makeRow('a', 'Cadrage; jour 1', {
    prix: 1234.5,
    cat: 'o2',
    tags: ['t1', 't2'],
    due: { start: '2026-10-13', end: '2026-10-15' },
    fait: true,
    resp: ['u1'],
    liens: ['p1'],
    notes: 'Ligne 1\nLigne "2"',
  });
  test('cells are spreadsheet friendly', () => {
    assert.equal(csvCell(row, prop('prix'), ctx, ','), '1234.5');
    assert.equal(csvCell(row, prop('prix'), ctx, ';'), '1234,5');
    assert.equal(csvCell(row, prop('cat'), ctx), 'Rouge');
    assert.equal(csvCell(row, prop('tags'), ctx), 'Urgent, Client');
    assert.equal(csvCell(row, prop('due'), ctx), '2026-10-13 → 2026-10-15');
    assert.equal(csvCell(row, prop('fait'), ctx), 'Oui');
    assert.equal(csvCell(row, prop('resp'), ctx), 'Alice Martin');
    assert.equal(csvCell(row, prop('liens'), ctx), 'Projet Alpha');
    assert.equal(csvCell(row, prop('ref'), ctx), '');
  });
  test('BOM, separator and quoting', () => {
    const csv = buildCsv([row], [prop('title'), prop('prix'), prop('notes')], ctx, ';');
    assert.ok(csv.startsWith('﻿'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'Nom;Prix;Notes');
    assert.ok(lines[1]!.startsWith('"Cadrage; jour 1";1234,5;"Ligne 1'));
    // Round trip through the parser.
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.headers, ['Nom', 'Prix', 'Notes']);
    assert.deepEqual(parsed.rows[0], ['Cadrage; jour 1', '1234,5', 'Ligne 1\nLigne "2"']);
  });
});

describe('CSV import', () => {
  test('parsing detects the separator and pads short rows', () => {
    const p = parseCsv('﻿Nom;Prix;Note\nA;1,5\nB;2;ok\n\n');
    assert.deepEqual(p.headers, ['Nom', 'Prix', 'Note']);
    assert.deepEqual(p.rows, [
      ['A', '1,5', ''],
      ['B', '2', 'ok'],
    ]);
    assert.deepEqual(parseCsv('a,b\n1,2').rows, [['1', '2']]);
    assert.deepEqual(parseCsv(',x\n1,2').headers, ['Colonne 1', 'x']);
  });
  test('value parsers', () => {
    assert.equal(parseCsvNumber('1 234,5'), 1234.5);
    assert.equal(parseCsvNumber('1,234.5'), 1234.5);
    assert.equal(parseCsvNumber('1,5'), 1.5);
    assert.equal(parseCsvNumber('12 %'), 12);
    assert.equal(parseCsvNumber('3,50 €'), 3.5);
    assert.equal(parseCsvNumber('-2'), -2);
    assert.equal(parseCsvNumber('1.234.567'), 1234567);
    assert.equal(parseCsvNumber('abc'), null);
    assert.equal(parseCsvNumber(''), null);
    assert.equal(parseCsvBoolean('Oui'), true);
    assert.equal(parseCsvBoolean('faux'), false);
    assert.equal(parseCsvBoolean('peut-être'), null);
    assert.deepEqual(parseCsvDate('2026-10-13'), { start: '2026-10-13' });
    assert.deepEqual(parseCsvDate('13/10/2026'), { start: '2026-10-13' });
    assert.deepEqual(parseCsvDate('13 oct. 2026'), { start: '2026-10-13' });
    assert.deepEqual(parseCsvDate('October 13, 2026'), { start: '2026-10-13' });
    assert.deepEqual(parseCsvDate('2026-10-13 → 2026-10-15'), { start: '2026-10-13', end: '2026-10-15' });
    const withTime = parseCsvDate('2026-10-13 14:30');
    assert.equal(withTime?.includeTime, true);
    assert.equal(new Date(withTime!.start).getHours(), 14);
    assert.equal(parseCsvDate('31/02/2026'), null);
    assert.equal(parseCsvDate('demain'), null);
  });
  test('type inference', () => {
    assert.equal(inferColumnType(['12', '3,5', '', '1 000']), 'number');
    assert.equal(inferColumnType(['0', '1', '1']), 'number');
    assert.equal(inferColumnType(['Oui', 'Non', 'oui']), 'checkbox');
    assert.equal(inferColumnType(['2026-10-13', '14/10/2026']), 'date');
    assert.equal(inferColumnType(['a@b.fr', 'c@d.com']), 'email');
    assert.equal(inferColumnType(['https://a.fr', 'http://b.com/x']), 'url');
    assert.equal(inferColumnType(['+33 6 12 34 56 78', '06 12 34 56 78']), 'phone');
    assert.equal(inferColumnType(['En cours', 'Terminé', 'En cours', 'En cours', 'Terminé']), 'select');
    assert.equal(inferColumnType(['Vidéo, Son', 'Son', 'Image']), 'multi_select');
    assert.equal(
      inferColumnType(['Une longue description qui ne se répète pas', 'Une autre description différente ici', 'Encore une ligne unique', 'Et une quatrième']),
      'text',
    );
    assert.equal(inferColumnType(['', '  ']), 'text');
  });
  test('conversion to stored values', () => {
    const cx = { users: USERS, relationRows: new Map([['liens', [{ id: 'p1', title: 'Projet Alpha' }]]]) };
    assert.equal(csvToValue(prop('prix'), '12,5 €', cx), 12.5);
    assert.equal(csvToValue(prop('prix'), 'n/a', cx), undefined);
    assert.equal(csvToValue(prop('cat'), 'rouge', cx), 'o2');
    assert.deepEqual(csvToValue(prop('tags'), 'Urgent; client', cx), ['t1', 't2']);
    assert.deepEqual(csvToValue(prop('resp'), 'alice martin, bruno@example.test', cx), ['u1', 'u2']);
    assert.deepEqual(csvToValue(prop('liens'), 'projet alpha, Inconnu', cx), ['p1']);
    assert.equal(csvToValue(prop('fait'), 'x', cx), true);
    assert.deepEqual(csvToValue(prop('due'), '13/10/2026', cx), { start: '2026-10-13' });
    assert.equal(csvToValue(prop('total'), '3', cx), undefined, 'computed properties are ignored');
    assert.equal(csvToValue(prop('notes'), '  ', cx), undefined);
    assert.deepEqual(csvToValue(prop('pj'), 'https://ex.fr/a/plan.pdf', cx), [{ name: 'plan.pdf', url: 'https://ex.fr/a/plan.pdf' }]);
    const lieu: PropertyDef = { id: 'lieu', name: 'Lieu', type: 'place' };
    assert.deepEqual(csvToValue(lieu, ' 1 rue de Rivoli, Paris ', cx), { address: '1 rue de Rivoli, Paris' });
    assert.deepEqual(csvToValue(lieu, '48.86, 2.35', cx), { address: '48.86, 2.35', lat: 48.86, lng: 2.35 });
    assert.equal(csvToValue(lieu, '', cx), undefined);
    assert.equal(csvCell(makeRow('z', 'Z', { lieu: { address: 'Lyon', lat: 45.7, lng: 4.8 } }), lieu, ctx), 'Lyon');
  });
  test('missing select options are created once', () => {
    const tags: PropertyDef = prop('tags');
    const added = missingOptions(tags, ['Urgent, Nouveau', 'nouveau; Autre', '']);
    assert.deepEqual(
      added.map((o) => o.name),
      ['Nouveau', 'Autre'],
    );
    const status: PropertyDef = { id: 's', name: 'S', type: 'status', options: [] };
    assert.equal(missingOptions(status, ['À faire'])[0]!.group, 'todo');
  });
});

test('number format of an imported column', async () => {
  const { inferNumberFormat } = await import('./csv');
  assert.equal(inferNumberFormat(['12 500,50 €', '3000']), 'euro');
  assert.equal(inferNumberFormat(['$12.00']), 'dollar');
  assert.equal(inferNumberFormat(['12 %', '50%']), 'percent');
  assert.equal(inferNumberFormat(['1 234', '12']), 'number_with_commas');
  assert.equal(inferNumberFormat(['1,234.50']), 'number_with_commas');
  assert.equal(inferNumberFormat(['12', '3,5']), 'number');
});
