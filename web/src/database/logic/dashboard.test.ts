/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DashboardWidget } from '@oriel/shared';
import { duplicateWidget, moveWidget, newWidget, retypeWidget, updateWidget, widgetRows, widgetTitle } from './dashboard';
import { formatCoordinates, locatedPlace, mapPoints, parseCoordinates, placeProperties, pointsBounds } from './map';
import { makeContext, makeRow, SCHEMA } from './testFixtures';

const ctx = makeContext();
const rows = [makeRow('a', 'A', { prix: 3, cat: 'o1' }), makeRow('b', 'B', { prix: 9, cat: 'o2' }), makeRow('c', 'C', { prix: 1, cat: 'o1' })];

describe('dashboard widgets', () => {
  test('new widgets get unique ids, spans and settings by type', () => {
    const list = newWidget('list', [], SCHEMA);
    assert.deepEqual(list, { id: 'w1', type: 'list', w: 2, h: 2, limit: 5 });
    const num = newWidget('chart_number', [list], SCHEMA);
    assert.equal(num.id, 'w2');
    assert.equal(num.w, 1);
    assert.equal(num.chart!.xProperty, null);
    assert.equal(newWidget('chart_bar', [list, num], SCHEMA).chart!.xProperty, 'etat');
    assert.equal(widgetTitle(list), 'Liste');
    assert.equal(widgetTitle({ ...num, title: '  Total ' }), 'Total');
  });
  test('rows: widget filter and sort on top of the view rows, list limit', () => {
    const w: DashboardWidget = {
      id: 'w1',
      type: 'list',
      w: 1,
      h: 1,
      limit: 1,
      sorts: [{ propertyId: 'prix', direction: 'desc' }],
      filter: { conjunction: 'and', rules: [{ id: 'r', propertyId: 'cat', operator: 'equals', value: 'o1' }] },
    };
    assert.deepEqual(widgetRows(rows, w, ctx).map((r) => r.id), ['a']);
    assert.deepEqual(widgetRows(rows, { ...w, type: 'chart_bar' }, ctx).map((r) => r.id), ['a', 'c']);
    assert.deepEqual(widgetRows(rows, { id: 'x', type: 'list', w: 1, h: 1 }, ctx).length, 3);
  });
  test('update, retype, move, duplicate', () => {
    const ws: DashboardWidget[] = [
      { id: 'w1', type: 'chart_bar', w: 2, h: 2, chart: { xProperty: 'cat', aggregate: 'count', valueProperty: null } },
      { id: 'w2', type: 'list', w: 1, h: 1, title: 'Liste' },
      { id: 'w3', type: 'chart_number', w: 1, h: 1 },
    ];
    assert.equal(updateWidget(ws, 'w2', { w: 3, id: 'zz' })[1]!.w, 3);
    assert.equal(updateWidget(ws, 'w2', { id: 'zz' })[1]!.id, 'w2');
    assert.equal(retypeWidget(ws[0]!, 'chart_line', SCHEMA).chart!.xProperty, 'cat');
    assert.equal(retypeWidget(ws[0]!, 'chart_number', SCHEMA).chart!.xProperty, null);
    const asList = retypeWidget(ws[0]!, 'list', SCHEMA);
    assert.equal(asList.chart, undefined);
    assert.equal(asList.limit, 5);
    assert.deepEqual(moveWidget(ws, 'w3', 'w1', 'before').map((w) => w.id), ['w3', 'w1', 'w2']);
    assert.deepEqual(moveWidget(ws, 'w1', 'w3', 'after').map((w) => w.id), ['w2', 'w3', 'w1']);
    const dup = duplicateWidget(ws, 'w2');
    assert.deepEqual(dup.map((w) => w.id), ['w1', 'w2', 'w4', 'w3']);
    assert.equal(dup[2]!.title, 'Liste (copie)');
  });
});

describe('map points', () => {
  const lieu = { id: 'lieu', name: 'Lieu', type: 'place' as const };
  const located = [
    makeRow('p', 'Paris', { lieu: { address: 'Paris', lat: 48.85, lng: 2.35 } }),
    makeRow('l', 'Lyon', { lieu: { address: 'Lyon', lat: 45.76, lng: 4.83 } }),
    makeRow('t', 'Texte seul', { lieu: { address: 'Quelque part' } }),
    makeRow('v', 'Vide'),
    makeRow('x', 'Hors limites', { lieu: { address: 'X', lat: 120, lng: 0 } }),
  ];
  test('rows with coordinates become markers, the others are listed', () => {
    const { points, unlocated } = mapPoints(located, lieu);
    assert.deepEqual(points.map((p) => p.row.id), ['p', 'l']);
    assert.deepEqual(unlocated.map((r) => r.id), ['t', 'v', 'x']);
    assert.equal(locatedPlace(located[2]!, lieu), null);
    assert.deepEqual(pointsBounds(points), [
      [45.76, 2.35],
      [48.85, 4.83],
    ]);
    assert.equal(pointsBounds([]), null);
    assert.deepEqual(placeProperties([...SCHEMA, lieu]).map((p) => p.id), ['lieu']);
  });
  test('coordinates typed by hand', () => {
    assert.deepEqual(parseCoordinates('48.8566, 2.3522'), { lat: 48.8566, lng: 2.3522 });
    assert.deepEqual(parseCoordinates(' 48,8566 ; 2,3522 '), { lat: 48.8566, lng: 2.3522 });
    assert.deepEqual(parseCoordinates('-33.9 151.2'), { lat: -33.9, lng: 151.2 });
    assert.equal(parseCoordinates('12 rue de Paris'), null);
    assert.equal(parseCoordinates('95, 10'), null);
    assert.equal(parseCoordinates('45, 190'), null);
    assert.equal(formatCoordinates(48.856614, 2.3522219).replace(/\s/g, ' '), '48,85661 ; 2,35222');
  });
});
