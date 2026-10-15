import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyDrop,
  closePane,
  dragHandle,
  dropTargetAt,
  equalWidths,
  insertPane,
  keepOnly,
  normalizeWidths,
  openBeside,
  pageIdFromHref,
  paneCapacity,
  parseSplit,
  replacePane,
  splitHref,
  splitSearch,
  swapPanes,
  swapTarget,
} from './splitLogic';

const A = 'aaaaaaaa-1111';
const B = 'bbbbbbbb-2222';
const C = 'cccccccc-3333';
const D = 'dddddddd-4444';

describe('URL', () => {
  it('a page without split is a single pane', () => {
    assert.deepEqual(parseSplit(A, ''), { panes: [A], active: 0 });
    assert.deepEqual(parseSplit(A, `?split=${B}`), { panes: [A], active: 0 });
  });
  it('parses panes and the active rank; the route wins', () => {
    assert.deepEqual(parseSplit(B, `?split=${A},${B},${C}&active=1`), { panes: [A, B, C], active: 1 });
    assert.deepEqual(parseSplit(D, `?split=${A},${B}&active=1`), { panes: [A, D], active: 1 });
  });
  it('drops invalid ids, truncates and clamps', () => {
    assert.deepEqual(parseSplit(A, `?split=${A},<script>,${B}`), { panes: [A, B], active: 0 });
    assert.equal(parseSplit(A, `?split=${A},${B},${C},${D}`).panes.length, 3);
    assert.equal(parseSplit(A, `?split=${A},${B}&active=9`).active, 1);
    assert.equal(parseSplit(A, `?split=${A},${B}&active=-3`).active, 0);
    assert.equal(parseSplit(A, `?split=${A},${B}&active=abc`).active, 0);
  });
  it('round-trips through href', () => {
    const state = { panes: [A, B, C], active: 2 };
    const href = splitHref('ws1', state);
    assert.equal(href, `/w/ws1/p/${C}?split=${A},${B},${C}&active=2`);
    const url = new URL(href, 'http://x');
    const routeId = url.pathname.split('/').pop()!;
    assert.deepEqual(parseSplit(routeId, url.search), state);
  });
  it('a single pane has no query', () => {
    assert.equal(splitSearch({ panes: [A], active: 0 }), '');
    assert.equal(splitHref('w', { panes: [A], active: 0 }), `/w/w/p/${A}`);
    assert.equal(splitSearch({ panes: [A, B], active: 0 }), `?split=${A},${B}`);
  });
  it('reads internal links', () => {
    assert.deepEqual(pageIdFromHref(`/w/ws/p/${A}`), { workspaceId: 'ws', pageId: A });
    assert.deepEqual(pageIdFromHref(`http://localhost:5/w/ws/p/${A}`, 'http://localhost:5'), { workspaceId: 'ws', pageId: A });
    assert.equal(pageIdFromHref(`http://evil.test/w/ws/p/${A}`, 'http://localhost:5'), null);
    assert.equal(pageIdFromHref('/w/ws/trash'), null);
    assert.equal(pageIdFromHref(`/w/ws/p/${A}/extra`), null);
  });
});

describe('operations', () => {
  it('opens beside the active pane', () => {
    assert.deepEqual(openBeside({ panes: [A], active: 0 }, B), { panes: [A, B], active: 1 });
    assert.deepEqual(openBeside({ panes: [A, C], active: 0 }, B), { panes: [A, B, C], active: 1 });
  });
  it('replaces a neighbor when full or when there is no room', () => {
    assert.deepEqual(openBeside({ panes: [A, B, C], active: 0 }, D), { panes: [A, D, C], active: 1 });
    assert.deepEqual(openBeside({ panes: [A, B, C], active: 2 }, D), { panes: [A, D, C], active: 1 });
    assert.deepEqual(openBeside({ panes: [A, B], active: 1 }, D, 2), { panes: [D, B], active: 0 });
    assert.deepEqual(openBeside({ panes: [A], active: 0 }, B, 1), { panes: [B], active: 0 });
  });
  it('allows the same page twice', () => {
    assert.deepEqual(openBeside({ panes: [A], active: 0 }, A), { panes: [A, A], active: 1 });
  });
  it('closes panes keeping the active page', () => {
    assert.deepEqual(closePane({ panes: [A, B, C], active: 2 }, 0), { panes: [B, C], active: 1 });
    assert.deepEqual(closePane({ panes: [A, B, C], active: 0 }, 0), { panes: [B, C], active: 0 });
    assert.deepEqual(closePane({ panes: [A, B, C], active: 2 }, 2), { panes: [A, B], active: 1 });
    assert.deepEqual(closePane({ panes: [A, B], active: 0 }, 1), { panes: [A], active: 0 });
    assert.deepEqual(closePane({ panes: [A], active: 0 }, 0), { panes: [A], active: 0 });
  });
  it('swaps with the neighbor and the active pane follows', () => {
    assert.equal(swapTarget({ panes: [A, B, C], active: 0 }, 0), 1);
    assert.equal(swapTarget({ panes: [A, B, C], active: 0 }, 2), 1);
    assert.equal(swapTarget({ panes: [A], active: 0 }, 0), -1);
    assert.deepEqual(swapPanes({ panes: [A, B, C], active: 0 }, 0, 1), { panes: [B, A, C], active: 1 });
    assert.deepEqual(swapPanes({ panes: [A, B, C], active: 2 }, 0, 1), { panes: [B, A, C], active: 2 });
    assert.deepEqual(swapPanes({ panes: [A, B], active: 0 }, 0, 5), { panes: [A, B], active: 0 });
  });
  it('keeps one pane alone', () => {
    assert.deepEqual(keepOnly({ panes: [A, B, C], active: 0 }, 1), { panes: [B], active: 0 });
  });
  it('replaces and inserts', () => {
    assert.deepEqual(replacePane({ panes: [A, B], active: 0 }, 1, C), { panes: [A, C], active: 1 });
    assert.deepEqual(insertPane({ panes: [A, B], active: 0 }, 0, C), { panes: [C, A, B], active: 0 });
    assert.deepEqual(insertPane({ panes: [A, B, C], active: 0 }, 0, D), { panes: [D, B, C], active: 0 });
    assert.deepEqual(insertPane({ panes: [A, B, C], active: 0 }, 3, D), { panes: [A, B, D], active: 2 });
  });
  it('capacity by width', () => {
    assert.equal(paneCapacity(500), 1);
    assert.equal(paneCapacity(600), 2);
    assert.equal(paneCapacity(900), 3);
    assert.equal(paneCapacity(4000), 3);
    assert.equal(paneCapacity(0), 1);
  });
});

describe('widths', () => {
  it('normalizes stored values', () => {
    assert.deepEqual(normalizeWidths(2, [3, 1]), [0.75, 0.25]);
    assert.deepEqual(normalizeWidths(2, [1, 0.01]), equalWidths(2));
    assert.deepEqual(normalizeWidths(3, [1, 1]), equalWidths(3));
    assert.deepEqual(normalizeWidths(2, 'x'), equalWidths(2));
    assert.deepEqual(normalizeWidths(2, [Infinity, 1]), equalWidths(2));
    assert.deepEqual(normalizeWidths(1, [1]), [1]);
  });
  it('drags a handle between two panes only', () => {
    const next = dragHandle([0.4, 0.3, 0.3], 0, 0.1, 0.15);
    assert.deepEqual(next.map((v) => Math.round(v * 100) / 100), [0.5, 0.2, 0.3]);
    const clamped = dragHandle([0.4, 0.3, 0.3], 0, 0.9, 0.15);
    assert.equal(Math.round(clamped[1]! * 100) / 100, 0.15);
    assert.ok(Math.abs(clamped.reduce((s, v) => s + v, 0) - 1) < 1e-9);
    assert.equal(clamped[2], 0.3);
    assert.deepEqual(dragHandle([0.5, 0.5], 1, 0.1, 0.1), [0.5, 0.5]);
  });
});

describe('drop zones', () => {
  const rects = [
    { left: 0, right: 400, top: 0, bottom: 600 },
    { left: 400, right: 800, top: 0, bottom: 600 },
  ];
  it('finds the pane and the mode', () => {
    assert.deepEqual(dropTargetAt(20, 100, rects), { pane: 0, mode: 'before' });
    assert.deepEqual(dropTargetAt(200, 100, rects), { pane: 0, mode: 'replace' });
    assert.deepEqual(dropTargetAt(790, 100, rects), { pane: 1, mode: 'after' });
    assert.equal(dropTargetAt(900, 100, rects), null);
    assert.equal(dropTargetAt(100, 700, rects), null);
  });
  it('applies a drop', () => {
    const s = { panes: [A, B], active: 0 };
    assert.deepEqual(applyDrop(s, { pane: 1, mode: 'after' }, C), { panes: [A, B, C], active: 2 });
    assert.deepEqual(applyDrop(s, { pane: 0, mode: 'before' }, C), { panes: [C, A, B], active: 0 });
    assert.deepEqual(applyDrop(s, { pane: 1, mode: 'replace' }, C), { panes: [A, C], active: 1 });
  });
});
