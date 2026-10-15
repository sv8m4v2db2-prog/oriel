// Cell range selection of the table view (SPEC §5.10): mouse, keyboard, clipboard and the batched
// writes of paste / fill down / clear. The range is kept by ids (rows move when a sort applies).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Page, PropertyDef, RowsResponse } from '@oriel/shared';
import { qk } from '../../lib/queryKeys';
import { confirmDialog, toast } from '../../lib/ui';
import { copyToClipboard } from '../../lib/util';
import type { DbContextValue } from '../context';
import { useLatest } from '../ui/hooks';
import { isEditableProp } from '../ui/PropertyCell';
import type { EditMove } from '../ui/editors/TextEditor';
import type { ViewState } from '../view/types';
import { copyMatrix, planClear, planFillDown, planPaste, relationRowsFor, skippedMessage, type GridColumn, type WritePlan } from './plan';
import { cellCount, moveRange, rangeBounds, tabRange, type Bounds, type CellPos, type Direction, type GridRange } from './range';
import { parseTsv, toTsv } from './tsv';

interface CellId {
  rowId: string;
  propId: string;
}

interface Editing {
  rowId: string;
  propId: string;
}

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const isTextTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

/** Interactive elements inside a cell keep their own pointer behaviour. */
const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], .ordb-grip, .ordb-row-check, .ordb-open-btn';

function cellAt(x: number, y: number): CellId | null {
  const el = document.elementFromPoint(x, y);
  const td = el instanceof Element ? el.closest<HTMLElement>('.ordb-td[data-pid]') : null;
  const tr = td?.closest<HTMLElement>('[data-rid]');
  return td && tr ? { rowId: tr.dataset.rid!, propId: td.dataset.pid! } : null;
}

export interface CellRangeOptions {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: Page[];
  columns: PropertyDef[];
  db: DbContextValue;
  vs: ViewState;
  editing: Editing | null;
  setEditing: (e: Editing | null) => void;
}

export function useCellRange({ rootRef, rows, columns, db, vs, editing, setEditing }: CellRangeOptions) {
  const qc = useQueryClient();
  const [sel, setSel] = useState<{ anchor: CellId; focus: CellId } | null>(null);
  const suppressClick = useRef(false);
  const escaped = useRef<CellId | null>(null);
  const scrollOnChange = useRef(false);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const colIndex = useMemo(() => new Map(columns.map((p, i) => [p.id, i])), [columns]);
  const gridCols = useMemo<GridColumn[]>(() => columns.map((p) => ({ prop: p, writable: db.canEdit && isEditableProp(p) })), [columns, db.canEdit]);

  const toPos = useCallback(
    (c: CellId): CellPos | null => {
      const row = rowIndex.get(c.rowId);
      const col = colIndex.get(c.propId);
      return row === undefined || col === undefined ? null : { row, col };
    },
    [rowIndex, colIndex],
  );
  const toId = useCallback((p: CellPos): CellId => ({ rowId: rows[p.row]!.id, propId: columns[p.col]!.id }), [rows, columns]);

  const range: GridRange | null = useMemo(() => {
    if (!sel) return null;
    const anchor = toPos(sel.anchor);
    const focus = toPos(sel.focus);
    return anchor && focus ? { anchor, focus } : null;
  }, [sel, toPos]);
  const bounds: Bounds | null = range ? rangeBounds(range) : null;

  const latest = useLatest({ range, bounds, rows, columns, gridCols, editing, db, vs, toId, toPos, sel });

  const focusRoot = useCallback(() => {
    // After a popover editor closed (it gives focus back to its target), not before.
    setTimeout(() => rootRef.current?.focus({ preventScroll: true }), 30);
  }, [rootRef]);

  const select = useCallback((anchor: CellId, focus: CellId = anchor) => setSel({ anchor, focus }), []);
  const clear = useCallback(() => setSel(null), []);

  // Clicking outside the table drops the range.
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setSel(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [sel, rootRef]);

  // Keyboard moves keep the active cell visible.
  useEffect(() => {
    if (!scrollOnChange.current || !sel) return;
    scrollOnChange.current = false;
    const tr = rootRef.current?.querySelector(`[data-rid="${CSS.escape(sel.focus.rowId)}"]`);
    const td = tr?.querySelector(`[data-pid="${CSS.escape(sel.focus.propId)}"]`);
    (td ?? tr)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sel, rootRef]);

  // --- writes ------------------------------------------------------------------------------

  const apply = useCallback(async (plan: WritePlan, createExtra = false): Promise<void> => {
    const { db: d, rows: rs, vs: v } = latest.current;
    const ids = rs.map((r) => r.id);
    if (createExtra && plan.extraRows > 0) {
      for (let i = 0; i < plan.extraRows; i++) {
        const id = v.createRow({});
        if (!id) break;
        ids.push(id);
      }
    }
    for (const [propId, added] of plan.newOptions) {
      const prop = d.properties.find((p) => p.id === propId);
      if (prop) await d.m.updateProperty(propId, { options: [...(prop.options ?? []), ...added] });
    }
    const updates = [...plan.writes]
      .filter(([i]) => i < ids.length)
      .map(([i, patch]) => ({ id: ids[i]!, ...patch }));
    const ok = await d.m.updateRowsEach(updates);
    const skipped = skippedMessage(plan);
    if (ok && skipped) toast(skipped);
  }, [latest]);

  const copy = useCallback(async (cut = false, e?: ReactClipboardEvent) => {
    const { bounds: b, rows: rs, columns: cols, db: d, gridCols: gc } = latest.current;
    if (!b) return;
    const text = toTsv(copyMatrix(rs, cols, b, d.ctx));
    if (e) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    } else if (!(await copyToClipboard(text))) return;
    const n = cellCount(b);
    if (cut && d.canEdit) void apply(planClear(rs.length, gc, b));
    else toast.success(n > 1 ? `${n} cellules copiées` : 'Cellule copiée');
  }, [latest, apply]);

  const paste = useCallback(async (text: string) => {
    const { range: r, bounds: b, rows: rs, columns: cols, gridCols: gc, db: d } = latest.current;
    if (!r || !b || !d.canEdit) return;
    const matrix = parseTsv(text);
    if (matrix.length === 0) return;
    const relationRows = relationRowsFor(cols, (target) => qc.getQueryData<RowsResponse>(qk.rows(target))?.rows);
    const plan = planPaste(matrix, { row: b.top, col: b.left }, rs.length, gc, { users: d.members, relationRows }, { range: b });
    let createExtra = false;
    if (plan.extraRows > 0) {
      createExtra = await confirmDialog({
        title: 'Créer des lignes ?',
        message: `Le collage dépasse la dernière ligne de ${plan.extraRows} ligne${plan.extraRows > 1 ? 's' : ''}. Créer ces lignes, ou ne coller que dans les lignes existantes ?`,
        confirmLabel: `Créer ${plan.extraRows} ligne${plan.extraRows > 1 ? 's' : ''}`,
        cancelLabel: 'Ne pas créer',
      });
    }
    await apply(plan, createExtra);
    // Select what was pasted (existing rows).
    const lastRow = Math.min(rs.length - 1, b.top + Math.max(matrix.length, b.bottom - b.top + 1) - 1);
    const lastCol = Math.min(cols.length - 1, b.left + Math.max(matrix[0]!.length, b.right - b.left + 1) - 1);
    setSel({ anchor: { rowId: rs[b.top]!.id, propId: cols[b.left]!.id }, focus: { rowId: rs[lastRow]!.id, propId: cols[lastCol]!.id } });
  }, [latest, apply, qc]);

  const fillDown = useCallback(() => {
    const { bounds: b, rows: rs, gridCols: gc, db: d } = latest.current;
    if (!b || !d.canEdit || b.bottom <= b.top) return;
    void apply(planFillDown(rs, gc, b));
  }, [latest, apply]);

  const clearValues = useCallback(() => {
    const { bounds: b, rows: rs, gridCols: gc, db: d } = latest.current;
    if (!b || !d.canEdit) return;
    void apply(planClear(rs.length, gc, b));
  }, [latest, apply]);

  // --- pointer -----------------------------------------------------------------------------

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const td = target.closest<HTMLElement>('.ordb-td[data-pid]');
    const tr = td?.closest<HTMLElement>('[data-rid]');
    if (!td || !tr || td.classList.contains('is-editing')) return;
    const start: CellId = { rowId: tr.dataset.rid!, propId: td.dataset.pid! };
    const { sel: cur } = latest.current;
    if (e.shiftKey && cur) {
      e.preventDefault();
      suppressClick.current = true;
      setSel({ anchor: cur.anchor, focus: start });
      focusRoot();
      return;
    }
    if (target.closest(INTERACTIVE)) return;
    if (cur) setSel(null);
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      const cell = cellAt(ev.clientX, ev.clientY);
      if (!cell) return;
      if (!dragged && cell.rowId === start.rowId && cell.propId === start.propId) return;
      if (!dragged) {
        dragged = true;
        document.body.classList.add('ordb-range-dragging');
        window.getSelection()?.removeAllRanges();
      }
      setSel((s) => (s && s.focus.rowId === cell.rowId && s.focus.propId === cell.propId ? s : { anchor: start, focus: cell }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('ordb-range-dragging');
      if (dragged) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        focusRoot();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [latest, focusRoot]);

  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // --- keyboard ----------------------------------------------------------------------------

  const onKeyDownCapture = useCallback((e: ReactKeyboardEvent) => {
    const { editing: ed } = latest.current;
    escaped.current = e.key === 'Escape' && ed ? { rowId: ed.rowId, propId: ed.propId } : null;
  }, [latest]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const { range: r, rows: rs, columns: cols, editing: ed, toId: id, gridCols: gc, db: d } = latest.current;
    if (!r || ed || isTextTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const dir = ARROWS[e.key];
    if (dir && !mod && !e.altKey) {
      e.preventDefault();
      const next = moveRange(r, dir, e.shiftKey, rs.length, cols.length);
      scrollOnChange.current = true;
      setSel({ anchor: id(next.anchor), focus: id(next.focus) });
      return;
    }
    switch (e.key) {
      case 'Tab': {
        e.preventDefault();
        const next = tabRange(r, e.shiftKey, rs.length, cols.length);
        scrollOnChange.current = true;
        setSel({ anchor: id(next.anchor), focus: id(next.focus) });
        return;
      }
      case 'Enter': {
        e.preventDefault();
        const col = gc[r.focus.col];
        const row = rs[r.focus.row];
        if (!col?.writable || !row) return;
        if (col.prop.type === 'checkbox') void d.m.updateRow(row.id, { properties: { [col.prop.id]: row.properties[col.prop.id] !== true } });
        else {
          setSel(null);
          setEditing({ rowId: row.id, propId: col.prop.id });
        }
        return;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setSel(null);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        clearValues();
        return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      e.stopPropagation();
      fillDown();
    }
  }, [latest, setEditing, clearValues, fillDown]);

  const onCopy = useCallback((e: ReactClipboardEvent) => {
    if (!latest.current.range || latest.current.editing || isTextTarget(e.target)) return;
    void copy(false, e);
  }, [latest, copy]);
  const onCut = useCallback((e: ReactClipboardEvent) => {
    if (!latest.current.range || latest.current.editing || isTextTarget(e.target)) return;
    void copy(true, e);
  }, [latest, copy]);
  const onPaste = useCallback((e: ReactClipboardEvent) => {
    if (!latest.current.range || latest.current.editing || isTextTarget(e.target)) return;
    e.preventDefault();
    void paste(e.clipboardData.getData('text/plain'));
  }, [latest, paste]);

  /** Called when a cell editor closes: Escape (or Enter) leaves that cell selected. */
  const onEditingEnded = useCallback((rowId: string, propId: string, move: EditMove) => {
    const esc = escaped.current;
    escaped.current = null;
    if (move === 'down' || (esc && esc.rowId === rowId && esc.propId === propId)) {
      select({ rowId, propId });
      focusRoot();
    }
  }, [select, focusRoot]);

  return {
    bounds,
    focus: range?.focus ?? null,
    count: bounds ? cellCount(bounds) : 0,
    rowsInRange: bounds ? rows.slice(bounds.top, bounds.bottom + 1).map((r) => r.id) : [],
    firstProp: bounds ? columns[bounds.left] ?? null : null,
    clear,
    copy: () => void copy(false),
    fillDown,
    clearValues,
    rootProps: { tabIndex: -1, onKeyDown, onKeyDownCapture, onCopy, onCut, onPaste },
    bodyProps: { onPointerDown, onClickCapture },
    onEditingEnded,
  };
}
