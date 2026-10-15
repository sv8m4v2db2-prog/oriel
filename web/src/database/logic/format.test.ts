/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayText,
  formatDate,
  formatDateValue,
  formatFileSize,
  formatFormulaResult,
  formatNumber,
  formatPropertyNumber,
  formatUniqueId,
  progressMax,
  progressRatio,
  normalizeText,
  parseNumberInput,
  toHref,
} from './format';
import { makeContext, makeRow, prop, spaces } from './testFixtures';

describe('formatNumber (fr-FR)', () => {
  test('plain number keeps decimals with a comma, no grouping', () => {
    assert.equal(formatNumber(1234.5, 'number'), '1234,5');
    assert.equal(formatNumber(-3, 'number'), '-3');
  });
  test('number with separators', () => {
    assert.equal(spaces(formatNumber(1234567.25, 'number_with_commas')), '1 234 567,25');
  });
  test('percent shows the stored value as a percentage', () => {
    assert.equal(spaces(formatNumber(42, 'percent')), '42 %');
    assert.equal(spaces(formatNumber(12.5, 'percent')), '12,5 %');
  });
  test('currencies', () => {
    assert.equal(spaces(formatNumber(1234.5, 'euro')), '1 234,50 €');
    assert.equal(spaces(formatNumber(1234.5, 'dollar')), '1 234,50 $');
  });
  test('non finite → empty', () => {
    assert.equal(formatNumber(Number.NaN), '');
  });
});

describe('parseNumberInput', () => {
  test('accepts French input', () => {
    assert.equal(parseNumberInput('1 234,5'), 1234.5);
    assert.equal(parseNumberInput('12 %'), 12);
    assert.equal(parseNumberInput(' 3.5 € '), 3.5);
    assert.equal(parseNumberInput('-7'), -7);
  });
  test('empty and invalid', () => {
    assert.equal(parseNumberInput(''), null);
    assert.equal(parseNumberInput('   '), null);
    assert.equal(parseNumberInput('abc'), undefined);
  });
});

describe('dates and misc', () => {
  test('formatDate uses the French locale', () => {
    assert.equal(formatDate(new Date(2026, 9, 13)), '13 oct. 2026');
    assert.equal(formatDate(new Date(2026, 9, 13, 8, 5), true), '13 oct. 2026 08:05');
  });
  test('formatDateValue renders ranges', () => {
    assert.equal(formatDateValue({ start: '2026-01-01', end: '2026-01-03' }), '1 janv. 2026 → 3 janv. 2026');
    assert.equal(formatDateValue(null), '');
  });
  test('formatUniqueId', () => {
    assert.equal(formatUniqueId(12, 'TASK'), 'TASK-12');
    assert.equal(formatUniqueId(3), '3');
    assert.equal(formatUniqueId(null, 'X'), '');
  });
  test('formatFileSize', () => {
    assert.equal(formatFileSize(512), '512 o');
    assert.equal(formatFileSize(2048), '2 Ko');
    assert.equal(formatFileSize(3.5 * 1024 * 1024), '3,5 Mo');
  });
  test('formatFormulaResult', () => {
    assert.equal(formatFormulaResult({ type: 'number', value: 2.5 }), '2,5');
    assert.equal(formatFormulaResult({ type: 'boolean', value: true }), 'Vrai');
    assert.equal(formatFormulaResult({ type: 'empty', value: null, error: 'x' }), '');
    assert.equal(formatFormulaResult({ type: 'date', value: new Date(2026, 0, 5) }), '5 janv. 2026');
  });
  test('normalizeText strips accents and case', () => {
    assert.equal(normalizeText('Été Évènement'), 'ete evenement');
  });
  test('toHref', () => {
    assert.equal(toHref('url', 'exemple.fr'), 'https://exemple.fr');
    assert.equal(toHref('url', 'http://a.b'), 'http://a.b');
    assert.equal(toHref('url', 'javascript:alert(1)'), '#');
    assert.equal(toHref('email', 'a@b.fr'), 'mailto:a@b.fr');
    assert.equal(toHref('phone', '+33 6 12 34 56 78'), 'tel:+33612345678');
  });
});

describe('displayText', () => {
  const ctx = makeContext();
  const row = makeRow('r1', 'Tâche', {
    prix: 12.5,
    qte: 2,
    cat: 'o2',
    etat: 'doing',
    tags: ['t1', 't2', 'zzz'],
    due: { start: '2026-10-20' },
    fait: true,
    resp: ['u1', 'u2'],
    liens: ['p1'],
    pj: [{ name: 'devis.pdf', url: '/api/files/1/devis.pdf' }],
    ref: 7,
  });
  test('per type', () => {
    assert.equal(displayText(row, prop('title'), ctx), 'Tâche');
    assert.equal(spaces(displayText(row, prop('prix'), ctx)), '12,50 €');
    assert.equal(displayText(row, prop('cat'), ctx), 'Rouge');
    assert.equal(displayText(row, prop('etat'), ctx), 'En cours');
    assert.equal(displayText(row, prop('tags'), ctx), 'Urgent, Client');
    assert.equal(displayText(row, prop('due'), ctx), '20 oct. 2026');
    assert.equal(displayText(row, prop('fait'), ctx), 'Oui');
    assert.equal(displayText(row, prop('resp'), ctx), 'Alice Martin, Bruno Petit');
    assert.equal(displayText(row, prop('liens'), ctx), 'Projet Alpha');
    assert.equal(displayText(row, prop('pj'), ctx), 'devis.pdf');
    assert.equal(displayText(row, prop('total'), ctx), '25');
    assert.equal(displayText(row, prop('ref'), ctx), 'TASK-7');
    assert.equal(displayText(row, prop('auteur'), ctx), 'Alice Martin');
    assert.equal(displayText(row, prop('cree'), ctx), '1 janv. 2026 00:00');
  });
});

describe('number display settings (G1 / D25)', () => {
  test('precision fixes the decimals, from 0 to 10', () => {
    assert.equal(formatNumber(3.14159, 'number', 2), '3,14');
    assert.equal(formatNumber(3, 'number', 2), '3,00');
    assert.equal(formatNumber(2.5, 'number', 0), '3');
    assert.equal(formatNumber(1 / 3, 'number', 10), '0,3333333333');
    assert.equal(formatNumber(1 / 3, 'number', 99), '0,3333333333', 'clamped to 10');
    assert.equal(formatNumber(1.5, 'number', -4), '2', 'clamped to 0');
    assert.equal(spaces(formatNumber(1234.5678, 'number_with_commas', 1)), '1 234,6');
    assert.equal(spaces(formatNumber(12.3456, 'percent', 1)), '12,3 %');
    assert.equal(spaces(formatNumber(1234.5, 'euro', 0)), '1 235 €');
    assert.equal(spaces(formatNumber(1234.5, 'euro', 3)), '1 234,500 €');
  });
  test('more currencies, fr-FR', () => {
    assert.equal(spaces(formatNumber(1234.5, 'gbp')), '1 234,50 £GB');
    assert.equal(spaces(formatNumber(1234.5, 'chf')), '1 234,50 CHF');
    assert.match(spaces(formatNumber(1234.5, 'cad')), /^1 234,50 \$CA$/);
    assert.equal(spaces(formatNumber(1234, 'jpy')), '1 234 JPY');
    assert.match(spaces(formatNumber(10, 'sek')), /^10,00 SEK$/);
  });
  test('formatPropertyNumber uses the property settings', () => {
    assert.equal(formatPropertyNumber({ numberFormat: 'number', numberPrecision: 1 }, 2), '2,0');
    assert.equal(formatPropertyNumber({}, 2.25), '2,25');
    assert.equal(displayText(makeRow('r', 't', { x: 1.239 }), { id: 'x', name: 'X', type: 'number', numberPrecision: 2 }, makeContext()), '1,24');
  });
  test('progress ratio is clamped and defaults to a maximum of 100', () => {
    assert.equal(progressMax({}), 100);
    assert.equal(progressMax({ numberMax: 250 }), 250);
    assert.equal(progressMax({ numberMax: -3 }), 100);
    assert.equal(progressRatio(50, 200), 0.25);
    assert.equal(progressRatio(500, 200), 1);
    assert.equal(progressRatio(-5, 200), 0);
    assert.equal(progressRatio(5, 0), 0);
  });
  test('typed input accepts the new symbols', () => {
    assert.equal(parseNumberInput('12,5 £'), 12.5);
    assert.equal(parseNumberInput('1 200 CHF'), 1200);
    assert.equal(parseNumberInput('abc'), undefined);
  });
});
