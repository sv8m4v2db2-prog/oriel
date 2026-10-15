// Table layout: sticky header, resizable / reorderable columns, inline cell editing, row selection
// with bulk delete, manual row order by drag, grouped sections, footer calculations, windowing,
// cell ranges (copy / paste / fill down, SPEC §5.10).
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Menu } from '@mantine/core';
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowDownToLine, Copy, Eraser, GripVertical, PanelRightOpen, Plus, Settings2, Trash } from 'lucide-react';
import { openContextMenu } from '../../components/ContextMenu';
import type { CalculationType, Page, PropertyDef } from '@oriel/shared';
import { navigation } from '../../lib/navigation';
import { useDb } from '../context';
import { CALCULATION_LABELS, CALCULATION_SHORT_LABELS, calculationsForKind, computeCalculation, groupShare } from '../logic/calc';
import { LARGE_VIEW_ROWS, rowSelection, type Bounds, type CellPos } from '../grid/range';
import { useCellRange } from '../grid/useCellRange';
import { canGroupBy } from '../logic/group';
import { columnWidth, insertId, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../logic/viewConfig';
import type { ValueKind } from '../logic/values';
import { restrictToAxis } from '../ui/dndModifiers';
import { useChunk, useLatest, useWindowRange } from '../ui/hooks';
import { PropertyIcon } from '../ui/icons';
import { isEditableProp, PropertyCell } from '../ui/PropertyCell';
import { AddPropertyPopover, PropertyMenu, type PropertyMenuViewActions } from '../ui/PropertyMenu';
import { Btn, CheckBox, cx } from '../ui/primitives';
import { BulkEditModal } from '../ui/BulkEditModal';
import { cellEntries, headerEntries, rowEntries, selectionEntries, trashRowsWithUndo } from '../ui/contextMenus';
import { uniquePropertyName } from '../logic/properties';
import { moveId, useDndSensors, useSortableItem } from '../ui/Sortable';
import type { EditMove } from '../ui/editors/TextEditor';
import type { ViewState } from '../view/types';
import { AddRowButton, EmptyState, GroupHeader, RowIcon, useViewGroups } from './common';

const ROW_H = 34;
const GUTTER = 52;
const ADD_COL = 44;
const WINDOW_THRESHOLD = 120;

type CellEditingHandler = (rowId: string, propId: string, editing: boolean, move?: EditMove) => void;
/** Right click on a row (propId: the clicked cell, null for the gutter). */
type RowMenuHandler = (e: ReactMouseEvent, row: Page, propId: string | null) => void;

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HeaderCell({
  prop,
  menuOpen,
  setMenuOpen,
  onResizeStart,
  sortable,
  actions,
  sampleRow,
  menuPanel,
  onContextMenu,
}: {
  prop: PropertyDef;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  onResizeStart: (e: ReactPointerEvent) => void;
  sortable: boolean;
  actions: PropertyMenuViewActions;
  sampleRow?: Page;
  menuPanel?: 'main' | 'delete';
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const { setNodeRef, style, handleProps, isDragging } = useSortableItem(prop.id, !sortable);
  return (
    <PropertyMenu prop={prop} opened={menuOpen} onOpenedChange={setMenuOpen} view={actions} sampleRow={sampleRow} initialPanel={menuPanel}>
      <div
        ref={setNodeRef}
        style={style}
        className={cx('ordb-th', isDragging && 'is-dragging', menuOpen && 'is-open')}
        {...handleProps}
        role="columnheader"
        onClick={() => setMenuOpen(!menuOpen)}
        onContextMenu={onContextMenu}
      >
        <PropertyIcon type={prop.type} />
        <span className="ordb-th-name">{prop.name}</span>
        <span
          className="ordb-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Redimensionner ${prop.name}`}
          onPointerDown={onResizeStart}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </PropertyMenu>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function TitleCell({
  row,
  prop,
  editing,
  wrap,
  onCellEditing,
}: {
  row: Page;
  prop: PropertyDef;
  editing: boolean;
  wrap: boolean;
  onCellEditing: CellEditingHandler;
}) {
  return (
    <div className="ordb-title-cell">
      {!editing && (
        <span className="ordb-title-icon">
          <RowIcon row={row} />
        </span>
      )}
      <PropertyCell
        row={row}
        prop={prop}
        variant="table"
        wrap={wrap}
        editing={editing}
        onEditingChange={(on, move) => onCellEditing(row.id, prop.id, on, move)}
      />
      {!editing && (
        <button
          type="button"
          className="ordb-open-btn"
          onClick={(e) => {
            e.stopPropagation();
            navigation.openPeek(row.id);
          }}
          title="Ouvrir en aperçu"
        >
          <PanelRightOpen size={13} /> Ouvrir
        </button>
      )}
    </div>
  );
}

interface RowProps {
  row: Page;
  columns: PropertyDef[];
  editingPropId: string | null;
  selected: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onCellEditing: CellEditingHandler;
  wrap: boolean;
  sortable: boolean;
  canSelect: boolean;
  onRowMenu: RowMenuHandler;
  /** Cell range in this row (column indices, -1 when none) and its edges. */
  selLeft: number;
  selRight: number;
  selTop: boolean;
  selBottom: boolean;
  activeCol: number;
}

const TableRow = memo(function TableRow({
  row,
  columns,
  editingPropId,
  selected,
  onSelect,
  onCellEditing,
  wrap,
  sortable,
  canSelect,
  onRowMenu,
  selLeft,
  selRight,
  selTop,
  selBottom,
  activeCol,
}: RowProps) {
  const { setNodeRef, style, handleProps, isDragging } = useSortableItem(row.id, !sortable);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx('ordb-tr', selected && 'is-selected', wrap && 'is-wrap', isDragging && 'is-dragging', editingPropId && 'has-editing')}
      role="row"
      data-rid={row.id}
      onContextMenu={(e) => onRowMenu(e, row, null)}
    >
      <div className="ordb-gutter">
        {sortable && (
          <span className="ordb-grip ordb-row-grip" {...handleProps} aria-label="Déplacer la ligne">
            <GripVertical size={14} />
          </span>
        )}
        {canSelect && (
          <span className="ordb-row-check">
            <CheckBox checked={selected} onChange={(c) => onSelect(row.id, c)} label="Sélectionner la ligne" />
          </span>
        )}
      </div>
      {columns.map((p, ci) => {
        const inRange = ci >= selLeft && ci <= selRight;
        return (
        <div
          key={p.id}
          className={cx(
            'ordb-td',
            `is-${p.type}`,
            editingPropId === p.id && 'is-editing',
            inRange && 'is-range',
            inRange && selTop && 'rg-t',
            inRange && selBottom && 'rg-b',
            inRange && ci === selLeft && 'rg-l',
            inRange && ci === selRight && 'rg-r',
            ci === activeCol && 'is-active',
          )}
          role="cell"
          data-pid={p.id}
          aria-selected={inRange || undefined}
          onContextMenu={(e) => {
            // Editors (inputs, popovers) keep the native menu.
            if (editingPropId === p.id) return;
            onRowMenu(e, row, p.id);
          }}
        >
          {p.type === 'title' ? (
            <TitleCell row={row} prop={p} editing={editingPropId === p.id} wrap={wrap} onCellEditing={onCellEditing} />
          ) : (
            <PropertyCell
              row={row}
              prop={p}
              variant="table"
              wrap={wrap}
              editing={editingPropId === p.id}
              onEditingChange={(on, move) => onCellEditing(row.id, p.id, on, move)}
            />
          )}
        </div>
        );
      })}
      <div className="ordb-td is-filler" />
    </div>
  );
});

function RowsBlock({
  rows,
  columns,
  editing,
  selected,
  onSelect,
  onCellEditing,
  wrap,
  sortable,
  canSelect,
  windowed,
  onRowMenu,
  offset,
  range,
  focus,
}: {
  rows: Page[];
  columns: PropertyDef[];
  editing: { rowId: string; propId: string } | null;
  selected: Set<string>;
  onSelect: (id: string, selected: boolean) => void;
  onCellEditing: CellEditingHandler;
  wrap: boolean;
  sortable: boolean;
  canSelect: boolean;
  windowed: boolean;
  onRowMenu: RowMenuHandler;
  /** Index of the first row in the displayed rows (cell ranges use global indices). */
  offset: number;
  range: Bounds | null;
  focus: CellPos | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const useWindow = windowed && !wrap && rows.length > WINDOW_THRESHOLD;
  const win = useWindowRange(ref, rows.length, ROW_H, useWindow);
  const chunk = useChunk(rows.length, 150, rows.length > 0 ? rows[0]!.id : '');
  const start = useWindow ? win.start : 0;
  const end = useWindow ? win.end : chunk.count;
  const slice = rows.slice(start, end);
  return (
    <div
      ref={ref}
      className="ordb-tbody"
      role="rowgroup"
      style={useWindow ? { paddingTop: start * ROW_H, paddingBottom: (rows.length - end) * ROW_H } : undefined}
    >
      <SortableContext items={slice.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        {slice.map((row, i) => {
          const rs = rowSelection(range, focus, offset + start + i);
          return (
          <TableRow
            key={row.id}
            row={row}
            columns={columns}
            editingPropId={editing && editing.rowId === row.id ? editing.propId : null}
            selected={selected.has(row.id)}
            onSelect={onSelect}
            onCellEditing={onCellEditing}
            wrap={wrap}
            sortable={sortable}
            canSelect={canSelect}
            onRowMenu={onRowMenu}
            selLeft={rs ? rs.left : -1}
            selRight={rs ? rs.right : -1}
            selTop={!!rs?.top}
            selBottom={!!rs?.bottom}
            activeCol={rs ? rs.active : -1}
          />
          );
        })}
      </SortableContext>
      {!useWindow && chunk.hasMore && (
        <div ref={chunk.sentinel} className="ordb-more">
          <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
            Afficher plus ({rows.length - end} restantes)
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer calculations
// ---------------------------------------------------------------------------

function CalcCell({
  prop,
  rows,
  type,
  kind,
  onChange,
}: {
  prop: PropertyDef;
  rows: Page[];
  type: CalculationType;
  kind: ValueKind;
  onChange: (t: CalculationType) => void;
}) {
  const { ctx } = useDb();
  const choices = calculationsForKind(kind);
  const effective = choices.includes(type) ? type : 'none';
  const result = useMemo(
    () => (effective === 'none' ? null : computeCalculation(rows, prop, effective, kind, ctx)),
    [rows, prop, effective, kind, ctx],
  );
  return (
    <Menu position="top-start" shadow="md" width={230}>
      <Menu.Target>
        <button type="button" className={cx('ordb-calc', effective !== 'none' && 'is-set')}>
          {effective === 'none' ? (
            <span className="ordb-calc-placeholder">Calculer</span>
          ) : (
            <>
              <span className="ordb-calc-label">{CALCULATION_SHORT_LABELS[effective]}</span>
              <span className="ordb-calc-value">{result?.display || '—'}</span>
            </>
          )}
        </button>
      </Menu.Target>
      <Menu.Dropdown className="ordb-mantine-menu">
        {choices.map((c) => (
          <Menu.Item key={c} onClick={() => onChange(c)} rightSection={c === effective ? '✓' : undefined}>
            {CALCULATION_LABELS[c]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function CalcRow({ rows, columns, vs, total }: { rows: Page[]; columns: PropertyDef[]; vs: ViewState; total?: number }) {
  return (
    <div className="ordb-tr is-calc" role="row">
      <div className="ordb-gutter">
        {total !== undefined && (
          <span className="ordb-group-share" title="Lignes du groupe et part du total de la vue">
            {groupShare(rows.length, total).display}
          </span>
        )}
      </div>
      {columns.map((p) => (
        <div key={p.id} className="ordb-td is-calc" role="cell">
          <CalcCell
            prop={p}
            rows={rows}
            type={vs.config.calculations[p.id] ?? 'none'}
            kind={vs.kinds.get(p.id) ?? 'text'}
            onChange={(t) => vs.setConfig({ calculations: { ...vs.config.calculations, [p.id]: t } })}
          />
        </div>
      ))}
      <div className="ordb-td is-filler" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function TableView({ vs }: { vs: ViewState }) {
  const db = useDb();
  const { canEdit, m, properties } = db;
  const columns = vs.visibleProps;
  const [menuPanel, setMenuPanel] = useState<'main' | 'delete'>('main');
  const [bulkOpen, setBulkOpen] = useState(false);
  const titleProp = properties.find((p) => p.type === 'title');
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ rowId: string; propId: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [rangeBulk, setRangeBulk] = useState<{ rowIds: string[]; propId?: string } | null>(null);
  const sensors = useDndSensors();

  const { prop: groupProp, groups, collapsed, toggle } = useViewGroups(vs, canGroupBy);

  // Drop local widths once the config caught up.
  useEffect(() => {
    setLocalWidths((lw) => {
      const next = { ...lw };
      let changed = false;
      for (const [id, w] of Object.entries(lw)) {
        if (vs.config.propertyWidths[id] === w) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : lw;
    });
  }, [vs.config.propertyWidths]);

  const widths = columns.map((p) => localWidths[p.id] ?? columnWidth(vs.config, p));
  const template = `${GUTTER}px ${widths.map((w) => `${w}px`).join(' ')} minmax(${ADD_COL}px, 1fr)`;
  const total = GUTTER + widths.reduce((a, b) => a + b, 0) + ADD_COL;

  const displayRows = useMemo(
    () => (groups ? groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows)) : vs.rows),
    [groups, collapsed, vs.rows],
  );
  const latest = useLatest({ displayRows, columns });
  const grid = useCellRange({ rootRef, rows: displayRows, columns, db, vs, editing, setEditing });
  const onEditingEnded = grid.onEditingEnded;

  // Start editing the title of a row just created from the toolbar.
  useEffect(() => {
    if (vs.editTitleOf && titleProp && vs.rows.some((r) => r.id === vs.editTitleOf)) {
      setEditing({ rowId: vs.editTitleOf, propId: titleProp.id });
      vs.clearEditTitle();
    }
  }, [vs.editTitleOf, vs.rows, titleProp, vs]);

  const onCellEditing = useCallback<CellEditingHandler>((rowId, propId, on, move) => {
    if (on) {
      setEditing({ rowId, propId });
      return;
    }
    if (!move || move === 'down') {
      setEditing((cur) => (cur && cur.rowId === rowId && cur.propId === propId ? null : cur));
      onEditingEnded(rowId, propId, move);
      return;
    }
    const { displayRows: rows, columns: cols } = latest.current;
    const editable = cols.filter(isEditableProp);
    const ci = editable.findIndex((p) => p.id === propId);
    const ri = rows.findIndex((r) => r.id === rowId);
    if (ci === -1 || ri === -1 || editable.length === 0) {
      setEditing(null);
      return;
    }
    let nci = ci + (move === 'next' ? 1 : -1);
    let nri = ri;
    if (nci >= editable.length) {
      nci = 0;
      nri++;
    } else if (nci < 0) {
      nci = editable.length - 1;
      nri--;
    }
    const nextRow = rows[nri];
    setEditing(nextRow ? { rowId: nextRow.id, propId: editable[nci]!.id } : null);
  }, [latest, onEditingEnded]);

  const onSelect = useCallback((id: string, on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Keep the selection in sync with existing rows.
  const visibleSelected = useMemo(() => {
    const ids = new Set(vs.rows.map((r) => r.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [selected, vs.rows]);
  const allSelected = displayRows.length > 0 && displayRows.every((r) => visibleSelected.has(r.id));
  const latestSelection = useLatest({ visibleSelected, db });

  const onRowMenu = useCallback<RowMenuHandler>(
    (e, row, propId) => {
      const { visibleSelected: sel, db: ctxDb } = latestSelection.current;
      if (sel.size > 1 && sel.has(row.id)) {
        openContextMenu(e, selectionEntries(ctxDb, [...sel], { onEditProperty: () => setBulkOpen(true), onClear: () => setSelected(new Set()) }));
        return;
      }
      const prop = propId ? ctxDb.properties.find((p) => p.id === propId) : undefined;
      const entries = prop
        ? [...cellEntries(ctxDb, row, prop, () => setEditing({ rowId: row.id, propId: prop.id })), { divider: true as const }, ...rowEntries(ctxDb, row)]
        : rowEntries(ctxDb, row);
      openContextMenu(e, entries);
    },
    [latestSelection],
  );

  const startResize = (prop: PropertyDef, startWidth: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const clamp = (w: number) => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));
    let width = startWidth;
    const onMove = (ev: PointerEvent) => {
      width = clamp(startWidth + ev.clientX - startX);
      setLocalWidths((lw) => ({ ...lw, [prop.id]: width }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('ordb-resizing');
      if (width !== startWidth) vs.setConfig({ propertyWidths: { ...vs.config.propertyWidths, [prop.id]: width } });
    };
    document.body.classList.add('ordb-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const orderedIds = vs.orderedProps.map((p) => p.id);
  const openHeaderMenu = (id: string, panel: 'main' | 'delete' = 'main') => {
    setMenuPanel(panel);
    setMenuFor(id);
  };
  const headerMenu = (prop: PropertyDef) => (e: ReactMouseEvent) => {
    const a = actionsFor(prop);
    openContextMenu(
      e,
      headerEntries(db, prop, {
        edit: () => openHeaderMenu(prop.id),
        sort: (direction) =>
          vs.setConfig({ sorts: [{ propertyId: prop.id, direction }, ...vs.config.sorts.filter((s) => s.propertyId !== prop.id)] }),
        filter: () => vs.filterOnProperty(prop.id),
        hide: () => vs.setConfig({ hiddenProperties: [...new Set([...vs.config.hiddenProperties, prop.id])] }),
        insert: a.onInsert,
        duplicate: () => {
          const { id: _drop, ...rest } = prop;
          const { id } = m.createProperty({ ...rest, name: uniquePropertyName(`${prop.name} (copie)`, properties) }, prop.id);
          a.onDuplicated?.(id);
        },
        remove: () => openHeaderMenu(prop.id, 'delete'),
      }),
    );
  };
  const actionsFor = (prop: PropertyDef): PropertyMenuViewActions => ({
    config: vs.config,
    setConfig: vs.setConfig,
    onFilter: vs.filterOnProperty,
    onInsert: canEdit
      ? (side) => {
          const schemaIdx = properties.findIndex((p) => p.id === prop.id);
          const after = side === 'right' ? prop.id : schemaIdx > 0 ? properties[schemaIdx - 1]!.id : null;
          const { id } = m.createProperty({ name: 'Texte', type: 'text' }, after);
          vs.setConfig({ propertyOrder: insertId(orderedIds, id, prop.id, side === 'left' ? 'before' : 'after') });
          setTimeout(() => openHeaderMenu(id), 50);
        }
      : undefined,
    onDuplicated: (id) => vs.setConfig({ propertyOrder: insertId(orderedIds, id, prop.id, 'after') }),
  });

  const onColumnDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = columns.map((c) => c.id);
    const place = ids.indexOf(String(active.id)) < ids.indexOf(String(over.id)) ? 'after' : 'before';
    vs.setConfig({ propertyOrder: moveId(orderedIds, String(active.id), String(over.id), place) });
  };

  const rowSortable = canEdit && vs.manualOrder && !groups;
  const onRowDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = vs.rows.map((r) => r.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = arrayMove(ids, from, to);
    const idx = next.indexOf(String(active.id));
    vs.moveRow(String(active.id), idx === 0 ? null : next[idx - 1]!); // I1: this view's order only
  };

  const newRow = (props?: Record<string, unknown>) => {
    const id = vs.createRow({ properties: props as never });
    if (id && titleProp) setEditing({ rowId: id, propId: titleProp.id });
  };

  const tableStyle = { '--ordb-cols': template, minWidth: total } as CSSProperties;
  const blockProps = {
    columns,
    editing,
    selected: visibleSelected,
    onSelect,
    onCellEditing,
    wrap: vs.config.wrap,
    canSelect: canEdit,
    onRowMenu,
    range: grid.bounds,
    focus: grid.focus,
  };
  // Offsets of the groups in the displayed rows (collapsed groups contribute no row).
  const groupOffsets: number[] = [];
  if (groups) {
    let n = 0;
    for (const g of groups) {
      groupOffsets.push(n);
      if (!collapsed.has(g.key)) n += g.rows.length;
    }
  }

  return (
    <div ref={rootRef} className="ordb-table" role="table" aria-rowcount={vs.rows.length} aria-multiselectable {...grid.rootProps}>
      {rangeBulk && (
        <BulkEditModal rowIds={rangeBulk.rowIds} initialPropId={rangeBulk.propId} opened onClose={() => setRangeBulk(null)} />
      )}
      {visibleSelected.size > 0 && (
        <div className="ordb-selection-bar">
          <span>
            {visibleSelected.size} ligne{visibleSelected.size > 1 ? 's' : ''} sélectionnée{visibleSelected.size > 1 ? 's' : ''}
          </span>
          <Btn size="sm" onClick={() => setBulkOpen(true)}>
            <Settings2 size={13} /> Modifier la propriété…
          </Btn>
          <Btn size="sm" onClick={() => void m.duplicateRows([...visibleSelected])}>
            <Copy size={13} /> Dupliquer
          </Btn>
          <Btn
            variant="danger"
            size="sm"
            onClick={() => {
              trashRowsWithUndo(db, [...visibleSelected]);
              setSelected(new Set());
            }}
          >
            <Trash size={13} /> Supprimer
          </Btn>
          <Btn size="sm" onClick={() => setSelected(new Set())}>
            Annuler
          </Btn>
        </div>
      )}
      {bulkOpen && <BulkEditModal rowIds={[...visibleSelected]} opened onClose={() => setBulkOpen(false)} />}
      <div
        className="ordb-thead-wrap"
        ref={headRef}
        onWheel={(e) => {
          if (bodyRef.current && e.deltaX) bodyRef.current.scrollLeft += e.deltaX;
        }}
        // Focus / scrollIntoView can scroll the header itself: keep the body aligned.
        onScroll={(e) => {
          const left = e.currentTarget.scrollLeft;
          if (bodyRef.current && bodyRef.current.scrollLeft !== left) bodyRef.current.scrollLeft = left;
        }}
      >
        <div className="ordb-tr is-head" style={tableStyle} role="row">
          <div className="ordb-gutter">
            {canEdit && displayRows.length > 0 && (
              <span className={cx('ordb-row-check', (allSelected || visibleSelected.size > 0) && 'is-visible')}>
                <CheckBox
                  checked={allSelected}
                  indeterminate={!allSelected && visibleSelected.size > 0}
                  label="Tout sélectionner"
                  onChange={(c) => setSelected(c ? new Set(displayRows.map((r) => r.id)) : new Set())}
                />
              </span>
            )}
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onColumnDragEnd} modifiers={[restrictToAxis('x')]}>
            <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              {columns.map((p, i) => (
                <HeaderCell
                  key={p.id}
                  prop={p}
                  menuOpen={menuFor === p.id}
                  setMenuOpen={(o) => (o ? openHeaderMenu(p.id) : setMenuFor(null))}
                  menuPanel={menuFor === p.id ? menuPanel : 'main'}
                  onContextMenu={headerMenu(p)}
                  onResizeStart={startResize(p, widths[i]!)}
                  sortable
                  actions={actionsFor(p)}
                  sampleRow={vs.rows[0]}
                />
              ))}
            </SortableContext>
          </DndContext>
          <div className="ordb-th is-add">
            {canEdit && (
              <AddPropertyPopover
                position="bottom-end"
                onCreated={(id) =>
                  vs.setConfig({
                    propertyOrder: [...orderedIds.filter((x) => x !== id), id],
                    hiddenProperties: vs.config.hiddenProperties.filter((x) => x !== id),
                  })
                }
              >
                <button type="button" className="ordb-iconbtn" aria-label="Ajouter une propriété" title="Ajouter une propriété">
                  <Plus size={15} />
                </button>
              </AddPropertyPopover>
            )}
          </div>
        </div>
      </div>
      <div
        className="ordb-tbody-wrap"
        data-hscroll=""
        ref={bodyRef}
        onScroll={(e) => {
          if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div style={tableStyle} className="ordb-tbody-inner" {...grid.bodyProps}>
          {groups ? (
            groups.map((g, gi) => (
              <div key={g.key} className="ordb-table-group">
                <GroupHeader
                  group={g}
                  collapsed={collapsed.has(g.key)}
                  onToggle={() => toggle(g.key)}
                  onAdd={canEdit && g.value !== undefined && groupProp ? () => newRow({ [groupProp.id]: g.value }) : undefined}
                />
                {!collapsed.has(g.key) && (
                  <>
                    <RowsBlock rows={g.rows} {...blockProps} offset={groupOffsets[gi]!} sortable={false} windowed />
                    {canEdit && g.value !== undefined && groupProp && (
                      <AddRowButton className="is-table" onClick={() => newRow({ [groupProp.id]: g.value })} />
                    )}
                    <CalcRow rows={g.rows} columns={columns} vs={vs} total={vs.rows.length} />
                  </>
                )}
              </div>
            ))
          ) : (
            <>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onRowDragEnd} modifiers={[restrictToAxis('y')]}>
                <RowsBlock rows={vs.rows} {...blockProps} offset={0} sortable={rowSortable} windowed />
              </DndContext>
              {vs.rows.length === 0 && (
                <EmptyState>{vs.totalRows === 0 ? 'Aucune ligne pour le moment.' : 'Aucune ligne ne correspond aux filtres.'}</EmptyState>
              )}
              {canEdit && <AddRowButton className="is-table" onClick={() => newRow()} />}
              <CalcRow rows={vs.rows} columns={columns} vs={vs} />
            </>
          )}
        </div>
      </div>
      {/* At the bottom (sticky): a bar at the top would shift the rows while dragging. */}
      {visibleSelected.size === 0 && grid.count > 1 && (
        <div className="ordb-selection-bar is-range" role="toolbar" aria-label="Plage de cellules">
          <span>{grid.count} cellules sélectionnées</span>
          <Btn size="sm" onClick={grid.copy}>
            <Copy size={13} /> Copier
          </Btn>
          {canEdit && grid.rowsInRange.length > 1 && (
            <Btn size="sm" onClick={grid.fillDown} title="Recopier la première ligne de la plage (⌘D)">
              <ArrowDownToLine size={13} /> Remplir vers le bas
            </Btn>
          )}
          {canEdit && (
            <Btn size="sm" onClick={grid.clearValues} title="Vider les cellules (Suppr)">
              <Eraser size={13} /> Effacer
            </Btn>
          )}
          {canEdit && (
            <Btn size="sm" onClick={() => setRangeBulk({ rowIds: grid.rowsInRange, propId: grid.firstProp?.id })}>
              <Settings2 size={13} /> Modifier la propriété…
            </Btn>
          )}
          <Btn size="sm" onClick={grid.clear}>
            Annuler
          </Btn>
        </div>
      )}
      {vs.totalRows > LARGE_VIEW_ROWS && (
        <div className="ordb-large-note" role="note">
          Base volumineuse : {vs.totalRows.toLocaleString('fr-FR')} lignes chargées. Filtrez la vue pour l’alléger.
        </div>
      )}
    </div>
  );
}
