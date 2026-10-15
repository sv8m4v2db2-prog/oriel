// Thin wrappers around dnd-kit for simple sortable lists (options, sorts, properties, tabs, columns).
import type { CSSProperties, ReactNode } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { restrictToAxis } from './dndModifiers';
import { CSS } from '@dnd-kit/utilities';

export function useDndSensors(distance = 4) {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

export function SortableList({
  ids,
  onMove,
  axis = 'y',
  disabled,
  children,
}: {
  ids: string[];
  /** Called on drop with the dragged id and the id it was dropped on. */
  onMove: (activeId: string, overId: string, place: 'before' | 'after') => void;
  axis?: 'x' | 'y';
  disabled?: boolean;
  children: ReactNode;
}) {
  const sensors = useDndSensors();
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onMove(String(active.id), String(over.id), from < to ? 'after' : 'before');
  };
  if (disabled) return <>{children}</>;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToAxis(axis)]}>
      <SortableContext items={ids} strategy={axis === 'x' ? horizontalListSortingStrategy : verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function useSortableItem(id: string, disabled?: boolean) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
    position: 'relative',
    opacity: isDragging ? 0.85 : undefined,
  };
  return { setNodeRef, style, handleProps: { ...attributes, ...listeners }, isDragging };
}

/** Ids reordered after moving `activeId` before/after `overId`. */
export function moveId(ids: string[], activeId: string, overId: string, place: 'before' | 'after'): string[] {
  const without = ids.filter((x) => x !== activeId);
  const idx = without.indexOf(overId);
  if (idx === -1) return ids;
  without.splice(place === 'after' ? idx + 1 : idx, 0, activeId);
  return without;
}
