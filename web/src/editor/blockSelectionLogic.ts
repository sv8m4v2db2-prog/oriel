// Pure logic of the block selection (rubber-band / marquee, keyboard ranges): no DOM, no editor.
// Used by blockSelection.tsx; unit-tested in blockSelectionLogic.test.ts.

/** Minimal shape of a BlockNote block (the document tree). */
export interface BlockLike {
  id: string;
  type: string;
  children: BlockLike[];
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A block the marquee can select: a top-level block, or a block directly inside a column (column lists
 * themselves are never selected — their columns' blocks are, individually).
 */
export interface SelectionUnit {
  id: string;
  /** Column holding the block, when the block sits in a column list. */
  column?: { listId: string; index: number; count: number };
}

export interface BlockLocation {
  id: string;
  /** Parent block / column id, null for top-level blocks. */
  parentId: string | null;
  parentType: 'doc' | 'block' | 'column';
  index: number;
  /** Ids of the siblings, parent's children order (including this block). */
  siblings: string[];
  depth: number;
}

const COLUMN_LIST = 'columnList';
const COLUMN = 'column';

/** Selectable units in document order. */
export function collectUnits(doc: readonly BlockLike[]): SelectionUnit[] {
  const units: SelectionUnit[] = [];
  for (const block of doc) {
    if (block.type === COLUMN_LIST) {
      const columns = block.children.filter((c) => c.type === COLUMN);
      columns.forEach((col, index) => {
        for (const child of col.children) units.push({ id: child.id, column: { listId: block.id, index, count: columns.length } });
      });
    } else {
      units.push({ id: block.id });
    }
  }
  return units;
}

/** Location of every block of the tree (columns and column lists included), and the document order. */
export function indexBlocks(doc: readonly BlockLike[]): { byId: Map<string, BlockLocation>; order: string[] } {
  const byId = new Map<string, BlockLocation>();
  const order: string[] = [];
  const walk = (list: readonly BlockLike[], parent: BlockLike | null, depth: number) => {
    const siblings = list.map((b) => b.id);
    list.forEach((b, index) => {
      byId.set(b.id, {
        id: b.id,
        parentId: parent?.id ?? null,
        parentType: parent === null ? 'doc' : parent.type === COLUMN ? 'column' : 'block',
        index,
        siblings,
        depth,
      });
      order.push(b.id);
      walk(b.children, b, depth + 1);
    });
  };
  walk(doc, null, 0);
  return { byId, order };
}

export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/** True when the two rectangles overlap (touching edges count). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/**
 * Area of a unit that the marquee must touch: the block's own box, widened to the page margins for
 * top-level blocks (a drag in the left margin selects the rows it crosses) and for the outer columns.
 */
export function unitHitRect(rect: Rect, unit: SelectionUnit): Rect {
  if (!unit.column) return { ...rect, left: -Infinity, right: Infinity };
  const { index, count } = unit.column;
  return {
    ...rect,
    left: index === 0 ? -Infinity : rect.left,
    right: index === count - 1 ? Infinity : rect.right,
  };
}

/** Units touched by the marquee, in the given (document) order. */
export function hitTest(marquee: Rect, units: ReadonlyArray<{ unit: SelectionUnit; rect: Rect }>): string[] {
  return units.filter(({ unit, rect }) => rect.bottom > rect.top && intersects(marquee, unitHitRect(rect, unit))).map(({ unit }) => unit.id);
}

/** Ids from `a` to `b` inclusive (either direction) in `order`; [] when one is missing. */
export function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i === -1 || j === -1) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** `ids` sorted by document order (unknown ids dropped, duplicates removed). */
export function sortByOrder(ids: Iterable<string>, order: readonly string[]): string[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** Drops the blocks whose ancestor is also selected (deleting / copying the ancestor covers them). */
export function removeDescendants(ids: readonly string[], byId: ReadonlyMap<string, BlockLocation>): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = byId.get(id)?.parentId ?? null;
    while (parent) {
      if (set.has(parent)) return false;
      parent = byId.get(parent)?.parentId ?? null;
    }
    return true;
  });
}

/** Runs of consecutive siblings (same parent, adjacent indices), in document order. */
export function contiguousGroups(ids: readonly string[], byId: ReadonlyMap<string, BlockLocation>, order: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let last: BlockLocation | null = null;
  for (const id of sortByOrder(ids, order)) {
    const loc = byId.get(id);
    if (!loc) continue;
    if (last && last.parentId === loc.parentId && loc.index === last.index + 1) current.push(id);
    else {
      if (current.length) groups.push(current);
      current = [id];
    }
    last = loc;
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Order used for keyboard ranges (Shift+↑/↓, Shift+click): the marquee units when the anchor is one of
 * them, otherwise the anchor's siblings.
 */
export function navigationOrder(anchor: string, units: readonly SelectionUnit[], byId: ReadonlyMap<string, BlockLocation>): string[] {
  const unitIds = units.map((u) => u.id);
  if (unitIds.includes(anchor)) return unitIds;
  return byId.get(anchor)?.siblings ?? [anchor];
}

/** Moves the head of a range one step (Shift+↑/↓); returns the new head and the selected range. */
export function stepRange(order: readonly string[], anchor: string, head: string, dir: -1 | 1): { head: string; ids: string[] } {
  const i = order.indexOf(head);
  if (i === -1) return { head, ids: rangeBetween(order, anchor, head) };
  const next = order[Math.min(order.length - 1, Math.max(0, i + dir))]!;
  return { head: next, ids: rangeBetween(order, anchor, next) };
}

/**
 * Auto-scroll speed (px per frame) while dragging near the top / bottom edge of the scroll container:
 * negative = up, 0 = none. Grows linearly from 0 at `edge` px from the border to `max` at the border.
 */
export function autoScrollDelta(y: number, top: number, bottom: number, edge = 48, max = 22): number {
  if (bottom - top < edge * 3) edge = Math.max(8, (bottom - top) / 4);
  if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
  if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
  return 0;
}
