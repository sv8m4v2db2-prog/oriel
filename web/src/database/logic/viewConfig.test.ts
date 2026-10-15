/// <reference types="node" />
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRows } from './pipeline';
import {
  columnWidth,
  exportProperties,
  insertId,
  normalizeConfig,
  orderedProperties,
  reorderIds,
  visibleProperties,
} from './viewConfig';
import { conversionMayLoseData, conversionPatch, newOption, newPropertyDef, randomColor, uniquePropertyName } from './properties';
import { makeContext, makeRow, prop, SCHEMA } from './testFixtures';

describe('view config', () => {
  test('normalizeConfig fills defaults and keeps valid values', () => {
    const c = normalizeConfig({ wrap: true, cardSize: 'huge' as never, sorts: [{ propertyId: 'prix', direction: 'asc' }] }, 'board', SCHEMA);
    assert.equal(c.wrap, true);
    assert.equal(c.cardSize, 'medium');
    assert.equal(c.groupBy, 'cat');
    assert.deepEqual(c.sorts, [{ propertyId: 'prix', direction: 'asc' }]);
    assert.equal(normalizeConfig(undefined, 'calendar', SCHEMA).dateProperty, 'due');
    assert.equal(normalizeConfig({ groupBy: null }, 'board', SCHEMA).groupBy, null);
  });
  test('ordered and visible properties', () => {
    const props = SCHEMA.slice(0, 4);
    const ordered = orderedProperties({ propertyOrder: ['prix', 'ghost', 'title'] }, props).map((p) => p.id);
    assert.deepEqual(ordered, ['prix', 'title', 'notes', 'qte']);
    const visible = visibleProperties({ propertyOrder: ['prix', 'title'], hiddenProperties: ['prix', 'title', 'qte'] }, props);
    assert.deepEqual(visible.map((p) => p.id), ['title', 'notes']);
  });
  test('view export keeps the properties structuring calendar / timeline / board / map', () => {
    // Regression: a calendar or timeline hides every card property by default, so "Exporter la vue"
    // used to export only the titles.
    const cal = normalizeConfig(undefined, 'calendar', SCHEMA);
    assert.deepEqual(exportProperties('calendar', cal, SCHEMA).map((p) => p.id), ['title', 'due']);
    const tl = normalizeConfig({ dateProperty: 'cree', dateEndProperty: 'due', groupBy: 'etat' }, 'timeline', SCHEMA);
    assert.deepEqual(exportProperties('timeline', tl, SCHEMA).map((p) => p.id), ['title', 'etat', 'due', 'cree']);
    // Visible card properties are kept, in the view's order; the end date only matters to a timeline.
    const cal2 = normalizeConfig({ dateEndProperty: 'cree', hiddenProperties: ['notes'] }, 'calendar', SCHEMA);
    assert.deepEqual(exportProperties('calendar', cal2, SCHEMA).length, SCHEMA.length - 1);
    const board = normalizeConfig(undefined, 'board', SCHEMA);
    assert.deepEqual(exportProperties('board', board, SCHEMA).map((p) => p.id), ['title', 'cat']);
    const map = normalizeConfig({ placeProperty: 'notes' }, 'map', SCHEMA);
    assert.deepEqual(exportProperties('map', map, SCHEMA).map((p) => p.id), ['title', 'notes']);
    // A table exports exactly its visible columns.
    const table = normalizeConfig({ hiddenProperties: ['notes'] }, 'table', SCHEMA);
    assert.deepEqual(exportProperties('table', table, SCHEMA), visibleProperties(table, SCHEMA));
  });
  test('reorder / insert ids', () => {
    assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
    assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c', 'after'), ['b', 'c', 'a', 'd']);
    assert.deepEqual(reorderIds(['a', 'b'], 'a', 'zz'), ['a', 'b']);
    assert.deepEqual(insertId(['a', 'b'], 'n', 'a', 'after'), ['a', 'n', 'b']);
    assert.deepEqual(insertId(['a', 'b'], 'n', 'a', 'before'), ['n', 'a', 'b']);
    assert.deepEqual(insertId(['a', 'b'], 'n', null, 'before'), ['a', 'b', 'n']);
  });
  test('column widths are clamped', () => {
    assert.equal(columnWidth({ propertyWidths: {} }, prop('title')), 280);
    assert.equal(columnWidth({ propertyWidths: { notes: 10 } }, prop('notes')), 72);
    assert.equal(columnWidth({ propertyWidths: { notes: 333 } }, prop('notes')), 333);
  });
});

describe('derived rows', () => {
  const ctx = makeContext();
  const rows = [
    makeRow('a', 'Alpha', { prix: 3 }, { position: 'a2' }),
    makeRow('b', 'Beta', { prix: 1 }, { position: 'a0' }),
    makeRow('c', 'Gamma', { prix: 2 }, { position: 'a1' }),
  ];
  test('manual order without sorts', () => {
    assert.deepEqual(deriveRows(rows, { filter: null, sorts: [] }, ctx).map((r) => r.id), ['b', 'c', 'a']);
  });
  test('filter + search + sort; kept ids stay visible', () => {
    const config = {
      filter: { conjunction: 'and' as const, rules: [{ id: 'r', propertyId: 'prix', operator: 'gte' as const, value: 2 }] },
      sorts: [{ propertyId: 'prix', direction: 'desc' as const }],
    };
    assert.deepEqual(deriveRows(rows, config, ctx).map((r) => r.id), ['a', 'c']);
    assert.deepEqual(deriveRows(rows, config, ctx, { search: 'gam' }).map((r) => r.id), ['c']);
    assert.deepEqual(deriveRows(rows, config, ctx, { search: 'gam', keepIds: new Set(['b']) }).map((r) => r.id), ['c', 'b']);
  });
});

describe('property helpers', () => {
  test('unique names', () => {
    assert.equal(uniquePropertyName('Date', SCHEMA), 'Date');
    assert.equal(uniquePropertyName('Prix', SCHEMA), 'Prix 2');
  });
  test('new property defaults', () => {
    assert.deepEqual(newPropertyDef('status', SCHEMA).options?.map((o) => o.group), ['todo', 'in_progress', 'done']);
    assert.deepEqual(newPropertyDef('select', SCHEMA).options, []);
    assert.equal(newPropertyDef('number', SCHEMA).numberFormat, 'number');
    assert.equal(newPropertyDef('relation', SCHEMA, { relationDatabaseId: 'x' }).relation?.databaseId, 'x');
    assert.equal(newPropertyDef('text', SCHEMA, { name: 'Notes' }).name, 'Notes 2');
  });
  test('random colors avoid used ones and never pick default', () => {
    for (let i = 0; i < 20; i++) assert.notEqual(randomColor(), 'default');
    assert.equal(randomColor(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']), 'red');
    const o = newOption('  Nouveau ', []);
    assert.equal(o.name, 'Nouveau');
    assert.ok(o.id.length >= 4);
  });
  test('conversions', () => {
    assert.equal(conversionMayLoseData('select', 'multi_select'), false);
    assert.equal(conversionMayLoseData('multi_select', 'select'), true);
    assert.equal(conversionPatch(prop('fait'), 'status').options?.length, 3);
    assert.equal(conversionPatch(prop('cat'), 'status').options, undefined);
  });
});

describe('view config: settings of the newer layouts', () => {
  test('extra settings survive normalization (feed, chart, dashboard, map, form)', () => {
    const chart = { xProperty: 'cat', xBucket: 'month', aggregate: 'sum', valueProperty: 'prix', seriesProperty: 'etat', sort: 'value_desc', showLegend: true, showLabels: false, hideEmpty: true } as const;
    const feed = normalizeConfig({ feedPreviewLines: 5 }, 'feed', SCHEMA);
    assert.equal(feed.feedPreviewLines, 5);
    assert.deepEqual(normalizeConfig({ chart }, 'chart_bar', SCHEMA).chart, chart);
    const widgets = [{ id: 'w1', type: 'list' as const, title: 'Top', limit: 3, sorts: [{ propertyId: 'prix', direction: 'desc' as const }], w: 2, h: 1 }];
    assert.deepEqual(normalizeConfig({ widgets }, 'dashboard', SCHEMA).widgets, widgets);
    assert.equal(normalizeConfig({ placeProperty: 'lieu' }, 'map', SCHEMA).placeProperty, 'lieu');
    const form = {
      title: 'Inscription',
      description: 'Merci',
      questions: [
        { id: 'q1', propertyId: 'title', required: true },
        { id: 'q2', propertyId: 'cat', label: 'Couleur ?', showIf: { questionId: 'q1', value: 'x' } },
      ],
      acceptResponses: false,
      isPublic: true,
      submitLabel: 'Envoyer',
      confirmation: 'Bien reçu',
    };
    assert.deepEqual(normalizeConfig({ form }, 'form', SCHEMA).form, form);
  });
  test('extra settings are kept when the layout changes (table ⇄ chart)', () => {
    const chart = { xProperty: 'etat', aggregate: 'count', valueProperty: null, seriesProperty: null, sort: 'default', showLegend: false, showLabels: true, hideEmpty: false } as const;
    const asTable = normalizeConfig({ chart, feedPreviewLines: 0, form: { questions: [], acceptResponses: true } }, 'table', SCHEMA);
    assert.deepEqual(asTable.chart, chart);
    assert.equal(asTable.feedPreviewLines, 0);
    assert.deepEqual(asTable.form, { questions: [], acceptResponses: true, isPublic: false });
    assert.equal(normalizeConfig({}, 'table', SCHEMA).chart, undefined);
  });
  test('defaults of the view type fill missing settings', () => {
    assert.equal(normalizeConfig({}, 'feed', SCHEMA).feedPreviewLines, 3);
    const c = normalizeConfig({}, 'chart_donut', SCHEMA).chart!;
    assert.equal(c.xProperty, 'etat');
    assert.equal(c.aggregate, 'count');
    assert.equal(c.showLegend, true);
    assert.equal(normalizeConfig({}, 'chart_number', SCHEMA).chart!.xProperty, null);
    assert.equal(normalizeConfig({}, 'dashboard', SCHEMA).widgets!.length, 3);
    assert.equal(normalizeConfig({}, 'map', SCHEMA).placeProperty, null);
    const form = normalizeConfig({}, 'form', SCHEMA).form!;
    assert.equal(form.acceptResponses, true);
    assert.equal(form.isPublic, false);
    assert.equal(form.questions[0]!.propertyId, 'title');
    assert.equal(form.questions[0]!.required, true);
  });
  test('invalid values are repaired, not propagated', () => {
    const c = normalizeConfig(
      {
        feedPreviewLines: 99,
        chart: { xProperty: 7, aggregate: 'median', valueProperty: 'prix', xBucket: 'decade', sort: 'random' } as never,
        widgets: [
          { id: 'ok', type: 'chart_line', w: 9, h: 0 },
          { id: 'ok', type: 'list', w: 1, h: 1 },
          { id: 'bad id!', type: 'list', w: 1, h: 1 },
          { id: 'x', type: 'pie', w: 1, h: 1 },
          'nope',
        ] as never,
        form: { questions: [{ id: 'q1', propertyId: 'notes', showIf: { questionId: 'q1', value: 'a' } }, { id: 'q2' }], acceptResponses: 'yes', isPublic: 1 } as never,
      },
      'chart_bar',
      SCHEMA,
    );
    assert.equal(c.feedPreviewLines, 20);
    assert.equal(c.chart!.xProperty, 'etat');
    assert.equal(c.chart!.aggregate, 'count');
    assert.equal(c.chart!.valueProperty, 'prix');
    assert.equal(c.chart!.xBucket, undefined);
    assert.equal(c.chart!.sort, 'default');
    assert.equal(c.widgets!.length, 1);
    assert.equal(c.widgets![0]!.w, 4);
    assert.equal(c.widgets![0]!.h, 1);
    assert.equal(c.widgets![0]!.chart!.aggregate, 'count');
    assert.deepEqual(c.form, { questions: [{ id: 'q1', propertyId: 'notes' }], acceptResponses: true, isPublic: false });
  });
});
