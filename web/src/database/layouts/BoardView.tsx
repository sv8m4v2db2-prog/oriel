// Board (kanban): columns = options of a select / status property (+ "Sans valeur"). Cards move
// across columns (value change) and within a column (manual order); hidden and collapsed columns.
import { useMemo, useState } from 'react';
import { Menu } from '@mantine/core';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronsLeft, ChevronsRight, Ellipsis, EyeOff, Plus } from 'lucide-react';
import type { Page, PropertyDef } from '@oriel/shared';
import { useDb } from '../context';
import { canBoardBy, computeGroups, moveGroupValue, type RowGroup } from '../logic/group';
import { newPropertyDef } from '../logic/properties';
import { sortByManualOrder } from '../logic/sort';
import { useChunk } from '../ui/hooks';
import { cx, IconBtn } from '../ui/primitives';
import type { ViewState } from '../view/types';
import { AddRowButton, Card, dragClock, EmptyState, GroupLabel, NewCardInput } from './common';

const COLUMN_WIDTH = { small: 220, medium: 264, large: 320 } as const;

interface DropTarget {
  groupKey: string;
  /** Insert before this row id; null = end of column. */
  beforeId: string | null;
}

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const card = hits.find((h) => String(h.id).startsWith('card:'));
  if (card) return [card];
  const col = hits.find((h) => String(h.id).startsWith('col:'));
  if (col) return [col];
  return rectIntersection(args).filter((h) => String(h.id).startsWith('col:'));
};

function BoardCard({
  row,
  groupKey,
  vs,
  draggable,
  dropBefore,
}: {
  row: Page;
  groupKey: string;
  vs: ViewState;
  draggable: boolean;
  dropBefore: boolean;
}) {
  const drag = useDraggable({ id: row.id, data: { groupKey }, disabled: !draggable });
  const drop = useDroppable({ id: `card:${row.id}`, data: { groupKey, rowId: row.id } });
  return (
    <div ref={drop.setNodeRef} className="ordb-board-slot">
      {dropBefore && <div className="ordb-drop-line" />}
      <Card
        ref={drag.setNodeRef}
        row={row}
        props={vs.visibleProps}
        cover={vs.config.cardCover === 'cover'}
        size={vs.config.cardSize}
        dimmed={drag.isDragging}
        dragHandle={draggable ? { ...drag.listeners } : undefined}
      />
    </div>
  );
}

function Column({
  group,
  groupProp,
  vs,
  draggable,
  drop,
  onHide,
  onCollapse,
}: {
  group: RowGroup;
  groupProp: PropertyDef;
  vs: ViewState;
  draggable: boolean;
  drop: DropTarget | null;
  onHide: () => void;
  onCollapse: () => void;
}) {
  const { canEdit } = useDb();
  const { setNodeRef, isOver } = useDroppable({ id: `col:${group.key}`, data: { groupKey: group.key } });
  const [adding, setAdding] = useState(false);
  const chunk = useChunk(group.rows.length, 60, group.key);
  const assignable = group.value !== undefined;
  const width = COLUMN_WIDTH[vs.config.cardSize] ?? COLUMN_WIDTH.medium;
  const dropHere = drop && drop.groupKey === group.key;

  const create = (title: string) => {
    const last = group.rows[group.rows.length - 1];
    vs.createRow({
      title,
      properties: assignable ? { [groupProp.id]: group.value ?? null } : undefined,
      after: vs.manualOrder && last ? last.id : undefined,
    });
  };

  return (
    <div className={cx('ordb-board-col', (isOver || dropHere) && 'is-over')} style={{ width }}>
      <div className="ordb-board-col-head">
        <GroupLabel group={group} />
        <span className="ordb-group-count">{group.rows.length}</span>
        <span className="ordb-option-spacer" />
        <Menu position="bottom-end" shadow="md" width={200}>
          <Menu.Target>
            <IconBtn label="Options de la colonne">
              <Ellipsis size={14} />
            </IconBtn>
          </Menu.Target>
          <Menu.Dropdown className="ordb-mantine-menu">
            <Menu.Item leftSection={<ChevronsLeft size={14} />} onClick={onCollapse}>
              Replier la colonne
            </Menu.Item>
            <Menu.Item leftSection={<EyeOff size={14} />} onClick={onHide}>
              Masquer la colonne
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        {canEdit && assignable && (
          <IconBtn label="Nouvelle carte" onClick={() => setAdding(true)}>
            <Plus size={14} />
          </IconBtn>
        )}
      </div>
      <div ref={setNodeRef} className="ordb-board-cards">
        {group.rows.slice(0, chunk.count).map((row) => (
          <BoardCard
            key={row.id}
            row={row}
            groupKey={group.key}
            vs={vs}
            draggable={draggable}
            dropBefore={!!dropHere && drop!.beforeId === row.id}
          />
        ))}
        {chunk.hasMore && (
          <div ref={chunk.sentinel} className="ordb-more">
            <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
              Afficher plus ({group.rows.length - chunk.count})
            </button>
          </div>
        )}
        {dropHere && drop!.beforeId === null && <div className="ordb-drop-line" />}
        {adding && <NewCardInput onCreate={(t) => create(t)} onClose={() => setAdding(false)} />}
        {canEdit && assignable && !adding && <AddRowButton onClick={() => setAdding(true)} />}
      </div>
    </div>
  );
}

export function BoardView({ vs }: { vs: ViewState }) {
  const { properties, ctx, canEdit, m } = useDb();
  const groupProp = properties.find((p) => p.id === vs.config.groupBy && canBoardBy(p)) ?? null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const groups = useMemo(() => (groupProp ? computeGroups(vs.rows, groupProp, ctx) : []), [groupProp, vs.rows, ctx]);
  const hidden = new Set(vs.config.hiddenGroups);
  const collapsed = new Set(vs.config.collapsedGroups);
  const shown = groups.filter((g) => !hidden.has(g.key));
  const hiddenGroups = groups.filter((g) => hidden.has(g.key));
  const draggable = canEdit;

  if (!groupProp) {
    const candidates = properties.filter(canBoardBy);
    return (
      <EmptyState
        action={
          canEdit ? (
            candidates.length > 0 ? (
              <span className="ordb-empty-actions">
                {candidates.map((p) => (
                  <button key={p.id} type="button" className="ordb-btn is-outline is-sm" onClick={() => vs.setConfig({ groupBy: p.id })}>
                    Colonnes selon « {p.name} »
                  </button>
                ))}
              </span>
            ) : (
              <button
                type="button"
                className="ordb-btn is-primary is-sm"
                onClick={() => {
                  const { id } = m.createProperty(newPropertyDef('status', properties, { name: 'Statut' }));
                  vs.setConfig({ groupBy: id });
                }}
              >
                Créer une propriété Statut
              </button>
            )
          ) : undefined
        }
      >
        Le tableau Kanban range les cartes en colonnes selon une propriété Sélection ou Statut.
      </EmptyState>
    );
  }

  const allSorted = sortByManualOrder(vs.rows, vs.view.rowOrder);

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragOver = (e: DragOverEvent) => {
    const over = e.over;
    if (!over) return setDrop(null);
    const data = over.data.current as { groupKey: string; rowId?: string } | undefined;
    if (!data) return setDrop(null);
    if (data.rowId) {
      if (data.rowId === e.active.id) return setDrop(null);
      const activeRect = e.active.rect.current.translated;
      const after = activeRect ? activeRect.top + activeRect.height / 2 > over.rect.top + over.rect.height / 2 : false;
      const g = groups.find((x) => x.key === data.groupKey);
      const idx = g ? g.rows.findIndex((r) => r.id === data.rowId) : -1;
      const beforeId = after ? (g?.rows[idx + 1]?.id ?? null) : data.rowId;
      setDrop({ groupKey: data.groupKey, beforeId: beforeId === e.active.id ? null : beforeId });
    } else {
      setDrop({ groupKey: data.groupKey, beforeId: null });
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    dragClock.endedAt = Date.now();
    const target = drop;
    const rowId = String(e.active.id);
    setActiveId(null);
    setDrop(null);
    if (!target || !e.over) return;
    const fromKey = (e.active.data.current as { groupKey: string } | undefined)?.groupKey;
    const group = groups.find((g) => g.key === target.groupKey);
    if (!group) return;
    const row = vs.rows.find((r) => r.id === rowId);
    const value = row ? moveGroupValue(row, groupProp, fromKey, group) : group.value;
    if (fromKey !== group.key && value !== undefined) {
      void m.updateRow(rowId, { properties: { [groupProp.id]: value } });
    }
    if (!vs.manualOrder) return;
    // Manual order: place right after the previous card of the target column (global order).
    const colRows = group.rows.filter((r) => r.id !== rowId);
    let after: string | null | undefined;
    if (target.beforeId) {
      const idx = colRows.findIndex((r) => r.id === target.beforeId);
      if (idx > 0) after = colRows[idx - 1]!.id;
      else {
        const gi = allSorted.findIndex((r) => r.id === target.beforeId);
        const prev = allSorted.slice(0, gi).reverse().find((r) => r.id !== rowId);
        after = prev ? prev.id : null;
      }
    } else {
      after = colRows.length ? colRows[colRows.length - 1]!.id : undefined;
    }
    // I1: the order of this view only.
    if (after !== undefined && after !== rowId) vs.moveRow(rowId, after);
  };

  const activeRow = activeId ? vs.rows.find((r) => r.id === activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setDrop(null);
      }}
    >
      <div className="ordb-board" data-hscroll="">
        {shown.map((g) =>
          collapsed.has(g.key) ? (
            <button
              type="button"
              key={g.key}
              className="ordb-board-collapsed"
              onClick={() => vs.setConfig({ collapsedGroups: vs.config.collapsedGroups.filter((k) => k !== g.key) })}
              title="Déplier la colonne"
            >
              <ChevronsRight size={14} />
              <GroupLabel group={g} />
              <span className="ordb-group-count">{g.rows.length}</span>
            </button>
          ) : (
            <Column
              key={g.key}
              group={g}
              groupProp={groupProp}
              vs={vs}
              draggable={draggable}
              drop={drop}
              onHide={() => vs.setConfig({ hiddenGroups: [...vs.config.hiddenGroups, g.key] })}
              onCollapse={() => vs.setConfig({ collapsedGroups: [...vs.config.collapsedGroups, g.key] })}
            />
          ),
        )}
        {hiddenGroups.length > 0 && (
          <div className="ordb-board-hidden">
            <div className="ordb-menu-label">Colonnes masquées</div>
            {hiddenGroups.map((g) => (
              <button
                type="button"
                key={g.key}
                className="ordb-board-hidden-item"
                onClick={() => vs.setConfig({ hiddenGroups: vs.config.hiddenGroups.filter((k) => k !== g.key) })}
                title="Afficher la colonne"
              >
                <GroupLabel group={g} />
                <span className="ordb-group-count">{g.rows.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeRow ? (
          <Card
            row={activeRow}
            props={vs.visibleProps}
            cover={vs.config.cardCover === 'cover'}
            size={vs.config.cardSize}
            className="is-overlay"
            style={{ width: COLUMN_WIDTH[vs.config.cardSize] - 16 }}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
