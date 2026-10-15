// List and gallery layouts (both groupable into collapsible sections). I1: in manual order, rows are
// dragged within their section; the drop writes the order of this view only.
import { useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Page, PropertyDef } from '@oriel/shared';
import { useDb } from '../context';
import { canGroupBy, type RowGroup } from '../logic/group';
import { isEmptyValue } from '../logic/values';
import { useChunk } from '../ui/hooks';
import { cx } from '../ui/primitives';
import { ValueDisplay } from '../ui/ValueDisplay';
import { openRowMenu } from '../ui/contextMenus';
import type { ViewState } from '../view/types';
import { afterIdForDrop } from '../logic/viewOrder';
import { useDndSensors, useSortableItem } from '../ui/Sortable';
import { AddRowButton, Card, dragClock, EmptyState, GroupHeader, NewCardInput, openRow, RowTitle, useViewGroups } from './common';

/** Sortable rows of one section (manual order of the view, editors only). */
function SortableRows({ vs, ids, grid, children }: { vs: ViewState; ids: string[]; grid?: boolean; children: ReactNode }) {
  const { canEdit } = useDb();
  const sensors = useDndSensors(5);
  if (!canEdit || !vs.manualOrder) return <>{children}</>;
  const onDragEnd = (e: DragEndEvent) => {
    dragClock.endedAt = Date.now();
    const { active, over } = e;
    if (!over) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const after = afterIdForDrop(ids, vs.rows.map((r) => r.id), String(active.id), String(over.id), from < to ? 'after' : 'before');
    if (after !== undefined) vs.moveRow(String(active.id), after);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={grid ? rectSortingStrategy : verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** Only rendered inside SortableRows' context (editors, manual order). */
function useRowDrag(id: string) {
  const s = useSortableItem(id);
  return { ref: s.setNodeRef, style: s.style, handle: s.handleProps };
}

function SortableListRow({ vs, row }: { vs: ViewState; row: Page }) {
  const drag = useRowDrag(row.id);
  return <ListRow row={row} props={vs.visibleProps} wrap={vs.config.wrap} rowRef={drag.ref} style={drag.style} handle={drag.handle} />;
}

function SortableCard({ vs, row, cover }: { vs: ViewState; row: Page; cover: boolean }) {
  const drag = useRowDrag(row.id);
  return <Card row={row} props={vs.visibleProps} cover={cover} size={vs.config.cardSize} ref={drag.ref} style={drag.style} dragHandle={drag.handle} />;
}

function ListRow({
  row,
  props,
  wrap,
  rowRef,
  style,
  handle,
}: {
  row: Page;
  props: PropertyDef[];
  wrap: boolean;
  rowRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  handle?: Record<string, unknown>;
}) {
  const db = useDb();
  const { ctx } = db;
  const shown = props.filter((p) => p.type !== 'title' && !isEmptyValue(row, p, ctx));
  return (
    <div
      ref={rowRef}
      style={style}
      {...handle}
      className={cx('ordb-list-row', wrap && 'is-wrap')}
      role="button"
      tabIndex={0}
      onClick={() => openRow(row.id)}
      onContextMenu={(e) => openRowMenu(e, db, row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openRow(row.id);
      }}
    >
      <span className="ordb-list-title">
        <RowTitle row={row} />
      </span>
      <span className="ordb-list-props">
        {shown.map((p) => (
          <span key={p.id} className="ordb-list-prop" title={p.name}>
            {p.type === 'checkbox' ? (
              <>
                <ValueDisplay row={row} prop={p} variant="list" /> {p.name}
              </>
            ) : (
              <ValueDisplay row={row} prop={p} variant="list" wrap={wrap} />
            )}
          </span>
        ))}
      </span>
    </div>
  );
}

function ListSection({ rows, vs, group, groupPropId }: { rows: Page[]; vs: ViewState; group?: RowGroup; groupPropId?: string }) {
  const { canEdit } = useDb();
  const sortable = canEdit && vs.manualOrder;
  const chunk = useChunk(rows.length, 100, group?.key);
  const [adding, setAdding] = useState(false);
  const assignable = !group || group.value !== undefined;
  const create = (title: string) =>
    vs.createRow({ title, properties: group && groupPropId && group.value !== undefined ? { [groupPropId]: group.value } : undefined });
  return (
    <div className="ordb-list">
      <SortableRows vs={vs} ids={rows.slice(0, chunk.count).map((r) => r.id)}>
        {rows.slice(0, chunk.count).map((r) =>
          sortable ? <SortableListRow key={r.id} vs={vs} row={r} /> : <ListRow key={r.id} row={r} props={vs.visibleProps} wrap={vs.config.wrap} />,
        )}
      </SortableRows>
      {chunk.hasMore && (
        <div ref={chunk.sentinel} className="ordb-more">
          <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
            Afficher plus ({rows.length - chunk.count})
          </button>
        </div>
      )}
      {adding && <NewCardInput onCreate={create} onClose={() => setAdding(false)} />}
      {canEdit && assignable && !adding && <AddRowButton onClick={() => setAdding(true)} />}
    </div>
  );
}

export function ListView({ vs }: { vs: ViewState }) {
  const { prop, groups, collapsed, toggle } = useViewGroups(vs, canGroupBy);
  if (groups && prop) {
    return (
      <div className="ordb-sections">
        {groups.map((g) => (
          <section key={g.key} className="ordb-section">
            <GroupHeader group={g} collapsed={collapsed.has(g.key)} onToggle={() => toggle(g.key)} />
            {!collapsed.has(g.key) && <ListSection rows={g.rows} vs={vs} group={g} groupPropId={prop.id} />}
          </section>
        ))}
      </div>
    );
  }
  return (
    <>
      {vs.rows.length === 0 && vs.totalRows > 0 && <EmptyState>Aucune ligne ne correspond aux filtres.</EmptyState>}
      <ListSection rows={vs.rows} vs={vs} />
    </>
  );
}

function GallerySection({ rows, vs, group, groupPropId }: { rows: Page[]; vs: ViewState; group?: RowGroup; groupPropId?: string }) {
  const { canEdit } = useDb();
  const sortable = canEdit && vs.manualOrder;
  const chunk = useChunk(rows.length, 60, group?.key);
  const [adding, setAdding] = useState(false);
  const assignable = !group || group.value !== undefined;
  const cover = vs.config.cardCover === 'cover';
  const create = (title: string) =>
    vs.createRow({ title, properties: group && groupPropId && group.value !== undefined ? { [groupPropId]: group.value } : undefined });
  return (
    <>
      <div className={cx('ordb-gallery', `is-${vs.config.cardSize}`)}>
        <SortableRows vs={vs} ids={rows.slice(0, chunk.count).map((r) => r.id)} grid>
          {rows.slice(0, chunk.count).map((r) =>
            sortable ? (
              <SortableCard key={r.id} vs={vs} row={r} cover={cover} />
            ) : (
              <Card key={r.id} row={r} props={vs.visibleProps} cover={cover} size={vs.config.cardSize} />
            ),
          )}
        </SortableRows>
        {adding && <NewCardInput onCreate={create} onClose={() => setAdding(false)} />}
        {canEdit && assignable && !adding && (
          <button type="button" className={cx('ordb-card', 'ordb-gallery-add', `is-${vs.config.cardSize}`)} onClick={() => setAdding(true)}>
            + Nouveau
          </button>
        )}
      </div>
      {chunk.hasMore && (
        <div ref={chunk.sentinel} className="ordb-more">
          <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
            Afficher plus ({rows.length - chunk.count})
          </button>
        </div>
      )}
    </>
  );
}

export function GalleryView({ vs }: { vs: ViewState }) {
  const { prop, groups, collapsed, toggle } = useViewGroups(vs, canGroupBy);
  if (groups && prop) {
    return (
      <div className="ordb-sections">
        {groups.map((g) => (
          <section key={g.key} className="ordb-section">
            <GroupHeader group={g} collapsed={collapsed.has(g.key)} onToggle={() => toggle(g.key)} />
            {!collapsed.has(g.key) && <GallerySection rows={g.rows} vs={vs} group={g} groupPropId={prop.id} />}
          </section>
        ))}
      </div>
    );
  }
  return (
    <>
      {vs.rows.length === 0 && vs.totalRows > 0 && <EmptyState>Aucune ligne ne correspond aux filtres.</EmptyState>}
      <GallerySection rows={vs.rows} vs={vs} />
    </>
  );
}
