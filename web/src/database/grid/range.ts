// Rectangular cell ranges of the table view (SPEC §5.10). Pure functions: no React, no DOM.
// Positions are indices into the displayed rows and the visible columns.

export interface CellPos {
  row: number;
  col: number;
}

/** A range: the anchor (where the selection started) and the focus (the active cell). */
export interface GridRange {
  anchor: CellPos;
  focus: CellPos;
}

export interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export const LARGE_VIEW_ROWS = 5000;

export function rangeBounds(r: GridRange): Bounds {
  return {
    top: Math.min(r.anchor.row, r.focus.row),
    bottom: Math.max(r.anchor.row, r.focus.row),
    left: Math.min(r.anchor.col, r.focus.col),
    right: Math.max(r.anchor.col, r.focus.col),
  };
}

export const rangeSize = (b: Bounds) => ({ rows: b.bottom - b.top + 1, cols: b.right - b.left + 1 });

export const cellCount = (b: Bounds) => (b.bottom - b.top + 1) * (b.right - b.left + 1);

export function inBounds(b: Bounds, row: number, col: number): boolean {
  return row >= b.top && row <= b.bottom && col >= b.left && col <= b.right;
}

export function clampPos(p: CellPos, rowCount: number, colCount: number): CellPos {
  return {
    row: Math.max(0, Math.min(rowCount - 1, p.row)),
    col: Math.max(0, Math.min(colCount - 1, p.col)),
  };
}

export function step(p: CellPos, dir: Direction, rowCount: number, colCount: number): CellPos {
  const d = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[dir];
  return clampPos({ row: p.row + d[0]!, col: p.col + d[1]! }, rowCount, colCount);
}

/** Arrow key: moves the active cell (collapsing the range), or extends the range with Shift. */
export function moveRange(r: GridRange, dir: Direction, extend: boolean, rowCount: number, colCount: number): GridRange {
  const focus = step(r.focus, dir, rowCount, colCount);
  return extend ? { anchor: r.anchor, focus } : { anchor: focus, focus };
}

/** Tab / Shift+Tab: next cell to the right (wrapping to the next row) or to the left. */
export function tabRange(r: GridRange, back: boolean, rowCount: number, colCount: number): GridRange {
  let { row, col } = r.focus;
  col += back ? -1 : 1;
  if (col >= colCount) {
    col = 0;
    row = Math.min(rowCount - 1, row + 1);
  } else if (col < 0) {
    col = colCount - 1;
    row = Math.max(0, row - 1);
  }
  const focus = clampPos({ row, col }, rowCount, colCount);
  return { anchor: focus, focus };
}

/** Rows (and their cell spans) of a range: what each rendered row needs to draw it. */
export interface RowSelection {
  left: number;
  right: number;
  top: boolean;
  bottom: boolean;
  /** Column of the active cell when it is in this row, else -1. */
  active: number;
}

export function rowSelection(b: Bounds | null, focus: CellPos | null, row: number): RowSelection | null {
  if (!b || row < b.top || row > b.bottom) return null;
  return { left: b.left, right: b.right, top: row === b.top, bottom: row === b.bottom, active: focus && focus.row === row ? focus.col : -1 };
}
