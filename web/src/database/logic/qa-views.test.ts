/// <reference types="node" />
// QA (security review) of the new database views on the client: forged view configs and forged
// values (map coordinates, chart dates and numbers, dashboard widgets, form settings) must neither
// break the rendering (public visitors included) nor make it loop; configs never pollute prototypes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from '@oriel/shared';
import { bucketRange, computeChart, niceTicks } from './chart';
import { widgetRows } from './dashboard';
import { computeGroups } from './group';
import { locatedPlace, mapPoints } from './map';
import { normalizeConfig, normalizeFormConfig, normalizeWidgets } from './viewConfig';
import { makeContext, makeRow, prop, SCHEMA } from './testFixtures';

const ctx = makeContext();
const PLACE: PropertyDef = { id: 'lieu', name: 'Lieu', type: 'place' };

describe('qa: database views (client)', () => {
  test('map: forged coordinates (NaN, Infinity, strings, objects, out of range) are never placed', () => {
    const forged: unknown[] = [
      { address: 'a', lat: Number.NaN, lng: 2 },
      { address: 'b', lat: 1, lng: Number.POSITIVE_INFINITY },
      { address: 'c', lat: '48', lng: '2' },
      { address: 'd', lat: { valueOf: () => 1 }, lng: 2 },
      { address: 'e', lat: 91, lng: 2 },
      { address: 'f', lat: 1, lng: -181 },
      { address: 42, lat: 1, lng: 2 },
      'Paris',
      [1, 2],
      null,
    ];
    const rows = forged.map((v, i) => makeRow(`r${i}`, `R${i}`, { lieu: v as never }));
    const { points, unlocated } = mapPoints(rows, PLACE);
    for (const p of points) {
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lng), `non-finite point ${JSON.stringify(p.row.properties)}`);
      assert.equal(typeof p.address, 'string', 'address is text');
    }
    assert.equal(points.length + unlocated.length, rows.length);
    assert.equal(locatedPlace(makeRow('ok', 'Ok', { lieu: { address: 'Paris', lat: 48.85, lng: 2.35 } }), PLACE)?.lat, 48.85);
  });

  test('charts: absurd date spans, huge numbers and unknown properties do not throw or loop', () => {
    const rows = [
      makeRow('a', 'A', { due: { start: '0001-01-01' }, prix: 1e308 }),
      makeRow('b', 'B', { due: { start: '9999-12-31' }, prix: 1e308 }),
      makeRow('c', 'C', { due: { start: 'pas une date' }, prix: -1e308 }),
    ];
    const t0 = Date.now();
    assert.equal(bucketRange(new Date('0001-01-01').getTime(), new Date('9999-12-31').getTime(), 'day'), null);
    for (const xBucket of ['day', 'week', 'month', 'year'] as const) {
      const c = computeChart(rows, { xProperty: 'due', xBucket, aggregate: 'sum', valueProperty: 'prix', seriesProperty: 'due', seriesBucket: 'day' }, SCHEMA, ctx);
      assert.ok(c.categories.length <= 500, `${xBucket}: ${c.categories.length} categories`);
    }
    computeChart(rows, { xProperty: 'inconnue', aggregate: 'average', valueProperty: 'inconnue', seriesProperty: '__proto__' }, SCHEMA, ctx);
    const ticks = niceTicks(-Number.MAX_VALUE, Number.MAX_VALUE);
    assert.ok(ticks.ticks.length < 50);
    assert.ok(niceTicks(0, 1e-300).ticks.length < 50);
    assert.ok(Date.now() - t0 < 2000, 'bounded work');
  });

  test('dashboard: forged widgets are capped, clamped and validated; list limit bounded', () => {
    const raw = Array.from({ length: 1000 }, (_, i) => ({
      id: i === 0 ? '__proto__' : `w${i}`,
      type: i % 2 ? 'list' : 'chart_bar',
      w: 1e9,
      h: -5,
      limit: 1e9,
      filter: { conjunction: 'and', rules: [{ id: 'r', propertyId: 'inconnue', operator: 'contains', value: { deep: [] } }] },
      chart: { xProperty: 'inconnue', aggregate: 'pow' },
    }));
    const widgets = normalizeWidgets(raw, SCHEMA);
    assert.equal(widgets.length, 24);
    // A widget id `__proto__` is a plain string (ids are only used in arrays, Maps and React keys).
    assert.ok(widgets.every((w) => typeof w.id === 'string' && w.w <= 4 && w.h >= 1 && (w.limit ?? 0) <= 50));
    assert.equal(Object.getPrototypeOf(widgets[0]), Object.prototype);
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(`r${i}`, `R${i}`));
    const list = widgets.find((w) => w.type === 'list')!;
    assert.ok(widgetRows(rows, { ...list, limit: 1e9 }, ctx).length <= 50);
  });

  test('view configs parsed from JSON never pollute prototypes', () => {
    const forged = JSON.parse(
      '{"__proto__":{"pollue":1},"propertyWidths":{"__proto__":{"pollue":2}},"form":{"__proto__":{"isPublic":true},"questions":[{"id":"q","propertyId":"title","__proto__":{"required":true}}]},"constructor":{"prototype":{"pollue":3}}}',
    );
    const config = normalizeConfig(forged, 'form', SCHEMA);
    assert.equal(({} as Record<string, unknown>).pollue, undefined);
    assert.equal(config.form!.isPublic, false, 'inherited isPublic ignored');
    assert.equal(normalizeFormConfig({ questions: [{ id: 'q', propertyId: 'title', showIf: { questionId: 'q', value: 'x' } }] }).questions[0]!.showIf, undefined);
  });

  test('grouping by relation: titles only through the context (masked ids stay untitled); text grouping is linear', () => {
    const rows = [makeRow('a', 'A', { liens: ['p1', 'invisible'] }), makeRow('b', 'B', { liens: ['invisible'] })];
    const groups = computeGroups(rows, prop('liens'), ctx);
    assert.deepEqual(
      groups.filter((g) => g.rows.length > 0).map((g) => g.label).sort(),
      ['Page sans titre', 'Projet Alpha'],
    );
    const many = Array.from({ length: 20_000 }, (_, i) => makeRow(`r${i}`, `R${i}`, { notes: `valeur ${i % 5000}` }));
    const t0 = Date.now();
    assert.equal(computeGroups(many, prop('notes'), ctx).length, 5000);
    assert.ok(Date.now() - t0 < 3000);
  });
});
