/// <reference types="node" />
// Run: node --test --import tsx web/src/editor/blockSelectionLogic.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoScrollDelta,
  collectUnits,
  contiguousGroups,
  hitTest,
  indexBlocks,
  intersects,
  navigationOrder,
  rangeBetween,
  rectFromPoints,
  removeDescendants,
  sortByOrder,
  stepRange,
  unitHitRect,
  type BlockLike,
  type Rect,
} from './blockSelectionLogic';

const b = (id: string, children: BlockLike[] = [], type = 'paragraph'): BlockLike => ({ id, type, children });
const doc: BlockLike[] = [
  b('a'),
  b('b', [b('b1'), b('b2')]),
  b('cols', [b('c1', [b('x1'), b('x2')], 'column'), b('c2', [b('y1')], 'column')], 'columnList'),
  b('d'),
];

describe('block selection logic', () => {
  test('units: top-level blocks, column children instead of column lists', () => {
    const units = collectUnits(doc);
    assert.deepEqual(
      units.map((u) => u.id),
      ['a', 'b', 'x1', 'x2', 'y1', 'd'],
    );
    assert.deepEqual(units[2]!.column, { listId: 'cols', index: 0, count: 2 });
    assert.deepEqual(units[4]!.column, { listId: 'cols', index: 1, count: 2 });
  });

  test('index: parents, siblings, document order', () => {
    const { byId, order } = indexBlocks(doc);
    assert.deepEqual(order, ['a', 'b', 'b1', 'b2', 'cols', 'c1', 'x1', 'x2', 'c2', 'y1', 'd']);
    assert.equal(byId.get('b2')!.parentId, 'b');
    assert.equal(byId.get('b2')!.parentType, 'block');
    assert.equal(byId.get('x2')!.parentType, 'column');
    assert.equal(byId.get('d')!.parentType, 'doc');
    assert.deepEqual(byId.get('b1')!.siblings, ['b1', 'b2']);
  });

  test('rectangles: normalisation and intersection (edges touch)', () => {
    assert.deepEqual(rectFromPoints({ x: 10, y: 50 }, { x: 0, y: 20 }), { left: 0, top: 20, right: 10, bottom: 50 });
    const r: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
    assert.ok(intersects(r, { left: 10, top: 10, right: 20, bottom: 20 }));
    assert.ok(!intersects(r, { left: 11, top: 0, right: 20, bottom: 10 }));
    assert.ok(!intersects(r, { left: 0, top: 10.5, right: 10, bottom: 20 }));
  });

  test('hit areas: top-level rows span the margins, outer columns extend outwards', () => {
    const rect: Rect = { left: 100, top: 0, right: 200, bottom: 20 };
    assert.equal(unitHitRect(rect, { id: 'a' }).left, -Infinity);
    assert.equal(unitHitRect(rect, { id: 'a' }).right, Infinity);
    const first = unitHitRect(rect, { id: 'x', column: { listId: 'l', index: 0, count: 3 } });
    assert.equal(first.left, -Infinity);
    assert.equal(first.right, 200);
    const middle = unitHitRect(rect, { id: 'y', column: { listId: 'l', index: 1, count: 3 } });
    assert.deepEqual([middle.left, middle.right], [100, 200]);
    const last = unitHitRect(rect, { id: 'z', column: { listId: 'l', index: 2, count: 3 } });
    assert.deepEqual([last.left, last.right], [100, Infinity]);
  });

  test('hit test: a drag in the left margin selects the rows and the first column only', () => {
    const units = collectUnits(doc);
    const layout: Record<string, Rect> = {
      a: { left: 100, top: 0, right: 700, bottom: 20 },
      b: { left: 100, top: 20, right: 700, bottom: 80 },
      x1: { left: 100, top: 80, right: 390, bottom: 100 },
      x2: { left: 100, top: 100, right: 390, bottom: 120 },
      y1: { left: 410, top: 80, right: 700, bottom: 100 },
      d: { left: 100, top: 120, right: 700, bottom: 140 },
    };
    const measured = units.map((unit) => ({ unit, rect: layout[unit.id]! }));
    // Left margin, from inside "b" down to inside "x2".
    assert.deepEqual(hitTest(rectFromPoints({ x: 20, y: 30 }, { x: 40, y: 110 }), measured), ['b', 'x1', 'x2']);
    // Right margin over the columns: the last column only.
    assert.deepEqual(hitTest(rectFromPoints({ x: 760, y: 85 }, { x: 740, y: 95 }), measured), ['y1']);
    // Across both columns.
    assert.deepEqual(hitTest(rectFromPoints({ x: 300, y: 85 }, { x: 500, y: 90 }), measured), ['x1', 'y1']);
    // Empty boxes (collapsed blocks) are never hit.
    assert.deepEqual(hitTest(rectFromPoints({ x: 0, y: 0 }, { x: 10, y: 200 }), [{ unit: { id: 'z' }, rect: { left: 0, top: 50, right: 10, bottom: 50 } }]), []);
  });

  test('ranges, ordering and descendants', () => {
    const { byId, order } = indexBlocks(doc);
    assert.deepEqual(rangeBetween(['a', 'b', 'c', 'd'], 'c', 'a'), ['a', 'b', 'c']);
    assert.deepEqual(rangeBetween(['a', 'b'], 'a', 'zz'), []);
    assert.deepEqual(sortByOrder(['d', 'a', 'a', 'unknown'], order), ['a', 'd']);
    assert.deepEqual(removeDescendants(['b', 'b2', 'x1'], byId), ['b', 'x1']);
  });

  test('contiguous groups: consecutive siblings of one parent', () => {
    const { byId, order } = indexBlocks(doc);
    assert.deepEqual(contiguousGroups(['d', 'a', 'b'], byId, order), [['a', 'b'], ['d']]);
    assert.deepEqual(contiguousGroups(['x1', 'x2', 'y1'], byId, order), [['x1', 'x2'], ['y1']]);
    assert.deepEqual(contiguousGroups(['a', 'b1'], byId, order), [['a'], ['b1']]);
  });

  test('keyboard ranges: units for top-level anchors, siblings for nested ones', () => {
    const { byId } = indexBlocks(doc);
    const units = collectUnits(doc);
    assert.deepEqual(navigationOrder('x1', units, byId), ['a', 'b', 'x1', 'x2', 'y1', 'd']);
    assert.deepEqual(navigationOrder('b2', units, byId), ['b1', 'b2']);
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(stepRange(order, 'b', 'b', 1), { head: 'c', ids: ['b', 'c'] });
    assert.deepEqual(stepRange(order, 'b', 'c', -1), { head: 'b', ids: ['b'] });
    assert.deepEqual(stepRange(order, 'b', 'b', -1), { head: 'a', ids: ['a', 'b'] });
    assert.deepEqual(stepRange(order, 'd', 'd', 1), { head: 'd', ids: ['d'] });
  });

  test('auto-scroll near the edges only, faster closer to the border', () => {
    assert.equal(autoScrollDelta(500, 0, 1000), 0);
    assert.ok(autoScrollDelta(5, 0, 1000) < autoScrollDelta(40, 0, 1000));
    assert.ok(autoScrollDelta(40, 0, 1000) < 0);
    assert.ok(autoScrollDelta(995, 0, 1000) > autoScrollDelta(960, 0, 1000));
    assert.ok(autoScrollDelta(960, 0, 1000) > 0);
    assert.equal(autoScrollDelta(-50, 0, 1000), -22);
  });
});
