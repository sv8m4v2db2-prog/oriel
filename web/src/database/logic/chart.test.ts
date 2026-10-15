/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChartConfig } from '@oriel/shared';
import { aggregateRows, bucketRange, chartValueLabel, computeChart, numberCaption, dateBucket, formatChartValue, formatCompact, NO_VALUE_KEY, niceTicks, OTHER_KEY } from './chart';
import { makeContext, makeRow, prop, SCHEMA, spaces } from './testFixtures';

const ctx = makeContext();
const rows = [
  makeRow('a', 'A', { cat: 'o2', etat: 'done', prix: 10, tags: ['t1', 't2'], fait: true, resp: ['u1'], due: { start: '2026-01-15' } }),
  makeRow('b', 'B', { cat: 'o1', etat: 'todo', prix: 30, tags: ['t2'], due: { start: '2026-03-02' } }),
  makeRow('c', 'C', { cat: 'o2', etat: 'doing', prix: 5, resp: ['u2', 'u1'], due: { start: '2026-03-30' } }),
  makeRow('d', 'D', { prix: 7 }),
];
const cfg = (patch: Partial<ChartConfig>): ChartConfig => ({ xProperty: 'cat', aggregate: 'count', valueProperty: null, ...patch });
const summary = (c: ReturnType<typeof computeChart>) => c.categories.map((x) => [x.key, x.value]);

describe('chart data', () => {
  test('count by select: options in order (empty options kept), « Sans valeur » last', () => {
    const c = computeChart(rows, cfg({}), SCHEMA, ctx);
    assert.deepEqual(summary(c), [
      ['o1', 1],
      ['o2', 2],
      ['o3', 0],
      [NO_VALUE_KEY, 1],
    ]);
    assert.equal(c.categories[1]!.color, 'red');
    assert.equal(c.categories[1]!.label, 'Rouge');
    assert.equal(c.total, 4);
    assert.equal(c.stacked, true);
  });
  test('hideEmpty drops « Sans valeur »', () => {
    const c = computeChart(rows, cfg({ hideEmpty: true }), SCHEMA, ctx);
    assert.equal(c.categories.some((x) => x.key === NO_VALUE_KEY), false);
  });
  test('sum / average / min / max of a number property', () => {
    assert.deepEqual(summary(computeChart(rows, cfg({ aggregate: 'sum', valueProperty: 'prix' }), SCHEMA, ctx)), [
      ['o1', 30],
      ['o2', 15],
      ['o3', 0],
      [NO_VALUE_KEY, 7],
    ]);
    const avg = computeChart(rows, cfg({ aggregate: 'average', valueProperty: 'prix' }), SCHEMA, ctx);
    assert.equal(avg.categories[1]!.value, 7.5);
    assert.equal(avg.total, 13);
    assert.equal(avg.stacked, false);
    assert.equal(avg.numberFormat, 'euro');
    assert.equal(computeChart(rows, cfg({ aggregate: 'min', valueProperty: 'prix' }), SCHEMA, ctx).total, 5);
    assert.equal(computeChart(rows, cfg({ aggregate: 'max', valueProperty: 'prix' }), SCHEMA, ctx).total, 30);
    // A non-number value property falls back to counting rows.
    const bad = computeChart(rows, cfg({ aggregate: 'sum', valueProperty: 'notes' }), SCHEMA, ctx);
    assert.equal(bad.total, 4);
    assert.equal(bad.valueProperty, null);
    assert.equal(aggregateRows([], 'average', prop('prix'), ctx), 0);
  });
  test('status follows the status groups, multi-select counts a row in each option', () => {
    assert.deepEqual(
      computeChart(rows, cfg({ xProperty: 'etat' }), SCHEMA, ctx).categories.map((x) => x.key),
      ['todo', 'doing', 'done', NO_VALUE_KEY],
    );
    assert.deepEqual(summary(computeChart(rows, cfg({ xProperty: 'tags' }), SCHEMA, ctx)), [
      ['t1', 1],
      ['t2', 2],
      [NO_VALUE_KEY, 2],
    ]);
  });
  test('people (by name), checkbox', () => {
    const people = computeChart(rows, cfg({ xProperty: 'resp', hideEmpty: true }), SCHEMA, ctx);
    assert.deepEqual(
      people.categories.map((x) => [x.label, x.value]),
      [
        ['Alice Martin', 2],
        ['Bruno Petit', 1],
      ],
    );
    assert.deepEqual(summary(computeChart(rows, cfg({ xProperty: 'fait' }), SCHEMA, ctx)), [
      ['true', 1],
      ['false', 3],
    ]);
  });
  test('dates grouped by month, with the empty months in between', () => {
    const c = computeChart(rows, cfg({ xProperty: 'due', xBucket: 'month', hideEmpty: true }), SCHEMA, ctx);
    assert.equal(c.dateAxis, true);
    assert.deepEqual(summary(c), [
      ['2026-01', 1],
      ['2026-02', 0],
      ['2026-03', 2],
    ]);
    assert.equal(c.categories[0]!.label, 'janv. 2026');
    const years = computeChart(rows, cfg({ xProperty: 'due', xBucket: 'year' }), SCHEMA, ctx);
    assert.deepEqual(summary(years), [
      ['2026', 3],
      [NO_VALUE_KEY, 1],
    ]);
  });
  test('sorting by value and by label', () => {
    const byValue = computeChart(rows, cfg({ sort: 'value_desc', hideEmpty: true }), SCHEMA, ctx);
    assert.deepEqual(byValue.categories.map((x) => x.key), ['o2', 'o1', 'o3']);
    const byLabel = computeChart(rows, cfg({ sort: 'label_asc', hideEmpty: true }), SCHEMA, ctx);
    assert.deepEqual(byLabel.categories.map((x) => x.label), ['Bleu', 'Rouge', 'Vert']);
    const datesDesc = computeChart(rows, cfg({ xProperty: 'due', xBucket: 'month', sort: 'label_desc', hideEmpty: true }), SCHEMA, ctx);
    assert.deepEqual(datesDesc.categories.map((x) => x.key), ['2026-03', '2026-02', '2026-01']);
    const withNone = computeChart(rows, cfg({ sort: 'value_asc' }), SCHEMA, ctx);
    assert.deepEqual(withNone.categories.map((x) => x.key), ['o3', 'o1', NO_VALUE_KEY, 'o2']);
  });
  test('series: stacked counts, grouped averages', () => {
    const c = computeChart(rows, cfg({ seriesProperty: 'etat', hideEmpty: true }), SCHEMA, ctx);
    assert.deepEqual(
      c.series.map((s) => [s.key, s.color]),
      [
        ['todo', 'default'],
        ['doing', 'blue'],
        ['done', 'green'],
      ],
    );
    const rouge = c.categories.find((x) => x.key === 'o2')!;
    assert.deepEqual(rouge.series, { todo: 0, doing: 1, done: 1 });
    assert.equal(rouge.value, 2);
    const avg = computeChart(rows, cfg({ seriesProperty: 'etat', aggregate: 'average', valueProperty: 'prix', hideEmpty: true }), SCHEMA, ctx);
    const r2 = avg.categories.find((x) => x.key === 'o2')!;
    assert.deepEqual(r2.series, { todo: 0, doing: 5, done: 10 });
    assert.equal(r2.value, 7.5);
    // Rows without a series value form their own series.
    const none = computeChart(rows, cfg({ xProperty: 'fait', seriesProperty: 'cat' }), SCHEMA, ctx);
    assert.deepEqual(none.series.map((s) => s.key), ['o1', 'o2', NO_VALUE_KEY]);
  });
  test('series row counts (gaps of a line of averages)', () => {
    const c = computeChart(rows, cfg({ aggregate: 'average', valueProperty: 'prix', seriesProperty: 'etat' }), SCHEMA, ctx);
    for (const cat of c.categories) {
      const total = Object.values(cat.seriesCounts).reduce((a, n) => a + n, 0);
      assert.equal(total, cat.count);
      for (const s of c.series) if (cat.seriesCounts[s.key] === 0) assert.equal(cat.series[s.key], 0);
    }
  });
  test('too many categories or series are folded into « Autres »', () => {
    const many = Array.from({ length: 12 }, (_, i) => makeRow(`r${i}`, `Ligne ${String(i).padStart(2, '0')}`, { prix: i }));
    const c = computeChart(many, cfg({ xProperty: 'title', aggregate: 'sum', valueProperty: 'prix' }), SCHEMA, ctx, { maxCategories: 5 });
    assert.equal(c.categories.length, 5);
    assert.equal(c.categories[4]!.key, OTHER_KEY);
    assert.equal(c.categories[4]!.value, 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11);
    const s = computeChart(many, cfg({ xProperty: 'fait', seriesProperty: 'title' }), SCHEMA, ctx, { maxSeries: 3 });
    assert.deepEqual(s.series.map((x) => x.key).slice(-1), [OTHER_KEY]);
    assert.equal(s.categories.find((x) => x.key === 'false')!.series[OTHER_KEY], 10);
  });
  test('no X axis: only the total (number chart)', () => {
    const c = computeChart(rows, cfg({ xProperty: null, aggregate: 'sum', valueProperty: 'prix' }), SCHEMA, ctx);
    assert.equal(c.categories.length, 0);
    assert.equal(c.total, 52);
    assert.equal(spaces(formatChartValue(c.total, c)), '52,00 €');
  });
  test('each category lists its rows; value label', () => {
    const c = computeChart(rows, cfg({ aggregate: 'sum', valueProperty: 'prix' }), SCHEMA, ctx);
    const all = c.categories.flatMap((x) => x.rowIds);
    assert.equal(new Set(all).size, rows.length);
    for (const cat of c.categories) assert.equal(cat.rowIds.length, cat.count);
    assert.equal(chartValueLabel(c, 'sum'), 'Somme · Prix');
    assert.equal(chartValueLabel(computeChart(rows, cfg({}), SCHEMA, ctx), 'count'), 'Nombre de lignes');
    assert.equal(numberCaption(c, 'sum'), `Somme · Prix · ${rows.length} lignes`);
    assert.equal(numberCaption({ valueProperty: null, rowCount: 1 }, 'count'), 'ligne');
  });
});

describe('chart helpers', () => {
  test('date buckets (local time, weeks start on Monday)', () => {
    const d = new Date(2026, 9, 15, 18, 0); // Thursday 15 Oct 2026
    assert.equal(dateBucket(d, 'day').key, '2026-10-15');
    assert.equal(dateBucket(d, 'week').key, 'S2026-10-12');
    assert.equal(dateBucket(d, 'week').label, 'Sem. du 12 oct. 2026');
    assert.equal(dateBucket(d, 'month').key, '2026-10');
    assert.equal(dateBucket(d, 'year').label, '2026');
    const range = bucketRange(new Date(2026, 0, 31).getTime(), new Date(2026, 2, 1).getTime(), 'month')!;
    assert.deepEqual(range.map((b) => b.key), ['2026-01', '2026-02', '2026-03']);
    assert.equal(bucketRange(new Date(2000, 0, 1).getTime(), new Date(2026, 0, 1).getTime(), 'day', 50), null);
  });
  test('compact values: short labels, no useless decimals', () => {
    assert.equal(spaces(formatCompact(5348, { numberFormat: 'euro' })), '5,3 k €');
    assert.equal(spaces(formatCompact(24200, { numberFormat: 'euro' })), '24,2 k €');
    assert.equal(spaces(formatCompact(0, { numberFormat: 'euro' })), '0 €');
    assert.equal(spaces(formatCompact(12.345, { numberFormat: 'number' })), '12,35');
    assert.equal(spaces(formatCompact(40, { numberFormat: 'percent' })), '40 %');
    assert.equal(spaces(formatCompact(-1500, { numberFormat: 'number' })), '-1,5 k');
  });
  test('nice ticks', () => {
    assert.deepEqual(niceTicks(0, 7, 5).ticks, [0, 2, 4, 6, 8]);
    assert.deepEqual(niceTicks(0, 100, 4).ticks, [0, 25, 50, 75, 100]);
    assert.deepEqual(niceTicks(-3, 3, 3).ticks, [-4, -2, 0, 2, 4]);
    assert.deepEqual(niceTicks(0, 0).ticks, [0, 1]);
  });
});

describe('chart number formats (G1 / D25)', () => {
  test('precision and other currencies', async () => {
    const { formatChartValue, formatCompact } = await import('./chart');
    assert.equal(formatChartValue(1234.5678, { numberFormat: 'number', numberPrecision: 1 }).replace(/[\u00a0\u202f]/g, ' '), '1 234,6');
    assert.equal(formatChartValue(1.234, { numberFormat: 'number' }).replace(/[\u00a0\u202f]/g, ' '), '1,23');
    assert.match(formatCompact(1500, { numberFormat: 'gbp' }), /1,5.*£/);
    assert.match(formatCompact(12, { numberFormat: 'chf' }), /12 CHF/);
  });
});
