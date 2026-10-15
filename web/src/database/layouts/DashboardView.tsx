// Dashboard view: widgets (charts or short lists of rows) on a 4-column grid. Each widget has its
// own filter (on top of the view's), its sorts and limit (lists) and its span (1–4 × 1–3). Editors
// add, edit, duplicate, delete and drag widgets to reorder them; readers only look.
import { useMemo, useState } from 'react';
import { Modal } from '@mantine/core';
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { Copy, Ellipsis, GripVertical, Pencil, Plus, Trash } from 'lucide-react';
import type { ChartViewType, DashboardWidget, Page, SortRule, ViewConfig } from '@oriel/shared';
import { defaultChartConfig } from '@oriel/shared';
import { useDb } from '../context';
import { LazyChart } from '../charts/LazyChart';
import { ChartSettings } from '../charts/ChartSettings';
import { useElementSize } from '../charts/useElementSize';
import { chartValueLabel, numberCaption, type ChartCategory } from '../logic/chart';
import {
  duplicateWidget,
  MAX_WIDGETS,
  moveWidget,
  newWidget,
  retypeWidget,
  updateWidget,
  WIDGET_TYPE_LABELS,
  WIDGET_TYPES,
  widgetRows,
  widgetTitle,
  type WidgetType,
} from '../logic/dashboard';
import { DbPopover as Popover } from '../ui/DbPopover';
import { ViewIcon } from '../ui/icons';
import { useDndSensors, useSortableItem } from '../ui/Sortable';
import { Btn, cx, IconBtn, MenuDivider, MenuItem, MenuLabel, NativeSelect, stopEscape } from '../ui/primitives';
import { ValueDisplay } from '../ui/ValueDisplay';
import { FilterMenu } from '../view/FilterMenu';
import type { ViewState } from '../view/types';
import { CategoryRows, useChartData, useChartProblem } from './ChartView';
import { EmptyState, openRow, RowTitle } from './common';
import '../views.css';

const widgetIcon = (type: WidgetType) => <ViewIcon type={type === 'list' ? 'list' : type} />;

function columnsFor(width: number): number {
  if (width > 0 && width < 560) return 1;
  if (width > 0 && width < 900) return 2;
  return 4;
}

// ---------------------------------------------------------------------------
// Widget bodies
// ---------------------------------------------------------------------------

function ChartWidgetBody({ widget, rows, vs }: { widget: DashboardWidget; rows: Page[]; vs: ViewState }) {
  const { properties } = useDb();
  const type = widget.type as ChartViewType;
  const chart = useMemo(() => widget.chart ?? defaultChartConfig(type, properties), [widget.chart, type, properties]);
  const data = useChartData(rows, type, chart, vs.kinds);
  const problem = useChartProblem(type, chart);
  const [selected, setSelected] = useState<string | null>(null);
  const category: ChartCategory | undefined = selected ? data.categories.find((c) => c.key === selected) : undefined;
  if (problem) return <div className="ordb-widget-empty">{problem}</div>;
  return (
    <>
      <div className="ordb-widget-chart">
        <LazyChart
          type={type}
          data={data}
          config={chart}
          compact
          label={`${widgetTitle(widget)} — ${chartValueLabel(data, chart.aggregate)}`}
          caption={numberCaption(data, chart.aggregate)}
          onSelect={type === 'chart_number' ? undefined : (key) => setSelected((s) => (s === key ? null : key))}
          selected={category ? selected : null}
        />
      </div>
      {category && (
        <div className="ordb-widget-drill">
          <CategoryRows category={category} rows={rows} onClose={() => setSelected(null)} />
        </div>
      )}
    </>
  );
}

function ListWidgetBody({ widget, rows }: { widget: DashboardWidget; rows: Page[] }) {
  const { properties } = useDb();
  const sortProp = properties.find((p) => p.id === widget.sorts?.[0]?.propertyId && p.type !== 'title');
  if (rows.length === 0) return <div className="ordb-widget-empty">Aucune ligne.</div>;
  return (
    <ul className="ordb-widget-list">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" className="ordb-widget-row" onClick={() => openRow(r.id)}>
            <RowTitle row={r} />
            {sortProp && (
              <span className="ordb-widget-row-value">
                <ValueDisplay row={r} prop={sortProp} variant="card" />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Widget card
// ---------------------------------------------------------------------------

function WidgetCard({
  widget,
  vs,
  cols,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  widget: DashboardWidget;
  vs: ViewState;
  cols: number;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { canEdit, ctx } = useDb();
  const { setNodeRef, style, handleProps, isDragging } = useSortableItem(widget.id, !canEdit);
  const [menu, setMenu] = useState(false);
  // Lists without any sort (theirs or the view's) show the newest rows first.
  const base = useMemo(
    () => (widget.type === 'list' && vs.manualOrder && !widget.sorts?.length ? [...vs.rows].reverse().sort((a, b) => b.createdAt - a.createdAt) : vs.rows),
    [vs.rows, vs.manualOrder, widget.type, widget.sorts],
  );
  const rows = useMemo(() => widgetRows(base, widget, ctx), [base, widget, ctx]);
  const span = Math.min(widget.w, cols);
  const filtered = (widget.filter?.rules.length ?? 0) + (widget.filter?.groups?.length ?? 0) > 0;
  return (
    <section
      ref={setNodeRef}
      className={cx('ordb-widget', `is-${widget.type}`, isDragging && 'is-dragging')}
      style={{ ...style, gridColumn: `span ${span}`, gridRow: `span ${widget.h}` }}
      aria-label={widgetTitle(widget)}
    >
      <header className="ordb-widget-head">
        {canEdit && (
          <span className="ordb-widget-grip" {...handleProps} aria-label="Déplacer le widget" title="Glisser pour déplacer">
            <GripVertical size={14} />
          </span>
        )}
        <span className="ordb-widget-title">{widgetTitle(widget)}</span>
        {filtered && <span className="ordb-widget-badge">Filtré</span>}
        {canEdit && (
          <Popover opened={menu} onChange={setMenu} position="bottom-end" width={200} shadow="md">
            <Popover.Target>
              <IconBtn label="Options du widget" onClick={() => setMenu((o) => !o)} className="ordb-widget-menu">
                <Ellipsis size={15} />
              </IconBtn>
            </Popover.Target>
            <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
              <MenuItem
                icon={<Pencil size={14} />}
                label="Modifier"
                onClick={() => {
                  setMenu(false);
                  onEdit();
                }}
              />
              <MenuItem
                icon={<Copy size={14} />}
                label="Dupliquer"
                onClick={() => {
                  setMenu(false);
                  onDuplicate();
                }}
              />
              <MenuDivider />
              <MenuItem
                icon={<Trash size={14} />}
                label="Supprimer"
                danger
                onClick={() => {
                  setMenu(false);
                  onDelete();
                }}
              />
            </Popover.Dropdown>
          </Popover>
        )}
      </header>
      <div className="ordb-widget-body">
        {widget.type === 'list' ? <ListWidgetBody widget={widget} rows={rows} /> : <ChartWidgetBody widget={widget} rows={rows} vs={vs} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Widget editor
// ---------------------------------------------------------------------------

const SPAN_W = [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} colonne${n > 1 ? 's' : ''}` }));
const SPAN_H = [1, 2, 3].map((n) => ({ value: String(n), label: ['Petite', 'Moyenne', 'Grande'][n - 1]! }));
const LIMITS = [3, 5, 10, 20, 50].map((n) => ({ value: String(n), label: `${n} lignes` }));

function WidgetEditor({ widget, vs, onChange, onClose }: { widget: DashboardWidget; vs: ViewState; onChange: (w: DashboardWidget) => void; onClose: () => void }) {
  const { properties } = useDb();
  const [title, setTitle] = useState(widget.title ?? '');
  const hasFilter = (widget.filter?.rules.length ?? 0) + (widget.filter?.groups?.length ?? 0) > 0;
  const [filtering, setFiltering] = useState(hasFilter);
  const sort: SortRule | undefined = widget.sorts?.[0];
  // FilterMenu edits `config.filter` through `setConfig`: a view state of its own carries the widget filter.
  const filterVs: ViewState = {
    ...vs,
    config: { ...vs.config, filter: widget.filter ?? null },
    setConfig: (patch: Partial<ViewConfig>) => {
      if (patch.filter !== undefined) onChange({ ...widget, filter: patch.filter });
    },
  };
  const commitTitle = () => {
    const t = title.trim().slice(0, 200);
    if (t !== (widget.title ?? '')) onChange({ ...widget, title: t || undefined });
  };
  return (
    <Modal opened onClose={onClose} title="Modifier le widget" centered size="lg" zIndex={400}>
      <div className="ordb-widget-editor">
        <label className="ordb-field-row">
          <span>Titre</span>
          <input
            className="ordb-input"
            value={title}
            placeholder={widgetTitle({ ...widget, title: undefined })}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === 'Enter' && commitTitle()}
          />
        </label>
        <div className="ordb-field-row">
          <span>Type</span>
          <NativeSelect
            ariaLabel="Type de widget"
            value={widget.type}
            onChange={(v) => onChange(retypeWidget(widget, v as WidgetType, properties))}
            choices={WIDGET_TYPES.map((t) => ({ value: t, label: WIDGET_TYPE_LABELS[t] }))}
          />
        </div>
        <div className="ordb-field-row">
          <span>Largeur</span>
          <NativeSelect ariaLabel="Largeur du widget" value={String(widget.w)} onChange={(v) => onChange({ ...widget, w: Number(v) })} choices={SPAN_W} />
        </div>
        <div className="ordb-field-row">
          <span>Hauteur</span>
          <NativeSelect ariaLabel="Hauteur du widget" value={String(widget.h)} onChange={(v) => onChange({ ...widget, h: Number(v) })} choices={SPAN_H} />
        </div>
        {widget.type === 'list' ? (
          <>
            <MenuLabel>Lignes affichées</MenuLabel>
            <div className="ordb-field-row">
              <span>Trier par</span>
              <NativeSelect
                ariaLabel="Tri de la liste"
                value={sort?.propertyId ?? ''}
                onChange={(v) => onChange({ ...widget, sorts: v ? [{ propertyId: v, direction: sort?.direction ?? 'desc' }] : undefined })}
                choices={[{ value: '', label: 'Ordre de la vue' }, ...properties.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </div>
            {sort && (
              <div className="ordb-field-row">
                <span>Sens</span>
                <NativeSelect
                  ariaLabel="Sens du tri"
                  value={sort.direction}
                  onChange={(v) => onChange({ ...widget, sorts: [{ ...sort, direction: v as SortRule['direction'] }] })}
                  choices={[
                    { value: 'asc', label: 'Croissant' },
                    { value: 'desc', label: 'Décroissant' },
                  ]}
                />
              </div>
            )}
            <div className="ordb-field-row">
              <span>Nombre</span>
              <NativeSelect
                ariaLabel="Nombre de lignes"
                value={String(widget.limit ?? 5)}
                onChange={(v) => onChange({ ...widget, limit: Number(v) })}
                choices={LIMITS.some((l) => l.value === String(widget.limit ?? 5)) ? LIMITS : [...LIMITS, { value: String(widget.limit), label: `${widget.limit} lignes` }]}
              />
            </div>
          </>
        ) : (
          <>
            <MenuLabel>Graphique</MenuLabel>
            <ChartSettings
              type={widget.type as ChartViewType}
              chart={widget.chart ?? defaultChartConfig(widget.type as ChartViewType, properties)}
              kinds={vs.kinds}
              onChange={(patch) =>
                onChange({ ...widget, chart: { ...(widget.chart ?? defaultChartConfig(widget.type as ChartViewType, properties)), ...patch } })
              }
            />
          </>
        )}
        <MenuLabel>Filtre du widget (en plus de ceux de la vue)</MenuLabel>
        {filtering || hasFilter ? (
          <div className="ordb-widget-filter">
            <FilterMenu vs={filterVs} />
          </div>
        ) : (
          <button type="button" className="ordb-add-row ordb-widget-add" onClick={() => setFiltering(true)}>
            <Plus size={14} /> Ajouter un filtre
          </button>
        )}
        <div className="ordb-widget-editor-foot">
          <Btn variant="primary" onClick={onClose}>
            Terminé
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DashboardView({ vs }: { vs: ViewState }) {
  const { canEdit, properties } = useDb();
  const widgets = vs.config.widgets ?? [];
  const grid = useElementSize<HTMLDivElement>();
  const cols = columnsFor(grid.width);
  const sensors = useDndSensors();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const save = (next: DashboardWidget[]) => vs.setConfig({ widgets: next });
  const editingWidget = editing ? widgets.find((w) => w.id === editing) : undefined;

  const add = (type: WidgetType) => {
    setAdding(false);
    const w = newWidget(type, widgets, properties);
    save([...widgets, w]);
    setEditing(w.id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = widgets.findIndex((w) => w.id === active.id);
    const to = widgets.findIndex((w) => w.id === over.id);
    if (from === -1 || to === -1) return;
    save(moveWidget(widgets, String(active.id), String(over.id), from < to ? 'after' : 'before'));
  };

  const addButton = canEdit && widgets.length < MAX_WIDGETS && (
    <Popover opened={adding} onChange={setAdding} position="bottom-start" width={230} shadow="md">
      <Popover.Target>
        <button type="button" className="ordb-add-row ordb-widget-add" onClick={() => setAdding((o) => !o)}>
          <Plus size={14} /> Ajouter un widget
        </button>
      </Popover.Target>
      <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
        <MenuLabel>Nouveau widget</MenuLabel>
        {WIDGET_TYPES.map((t) => (
          <MenuItem key={t} icon={widgetIcon(t)} label={WIDGET_TYPE_LABELS[t]} onClick={() => add(t)} />
        ))}
      </Popover.Dropdown>
    </Popover>
  );

  if (widgets.length === 0) {
    return <EmptyState action={addButton || undefined}>Ce tableau de bord n’a aucun widget.</EmptyState>;
  }

  const cards = widgets.map((w) => (
    <WidgetCard
      key={w.id}
      widget={w}
      vs={vs}
      cols={cols}
      onEdit={() => setEditing(w.id)}
      onDuplicate={() => save(duplicateWidget(widgets, w.id))}
      onDelete={() => save(widgets.filter((x) => x.id !== w.id))}
    />
  ));

  return (
    <div className="ordb-dashboard">
      {vs.rows.length === 0 && vs.totalRows > 0 && <div className="ordb-menu-hint">Aucune ligne ne correspond aux filtres de la vue.</div>}
      <div ref={grid.ref} className="ordb-dashboard-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {canEdit ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
              {cards}
            </SortableContext>
          </DndContext>
        ) : (
          cards
        )}
      </div>
      {addButton}
      {editingWidget && (
        <WidgetEditor
          key={editingWidget.id}
          widget={editingWidget}
          vs={vs}
          onChange={(w) => save(updateWidget(widgets, w.id, w))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
