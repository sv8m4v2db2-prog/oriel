// View tabs: switch, add by type, rename, change layout, duplicate, delete (≥ 1 kept), drag to reorder.
import { useState } from 'react';
import { DbPopover as Popover } from '../ui/DbPopover';
import { Check, ChevronDown, Copy, Pencil, Plus, Trash } from 'lucide-react';
import { openContextMenu } from '../../components/ContextMenu';
import type { View, ViewType } from '@oriel/shared';
import { VIEW_TYPE_LABELS } from '@oriel/shared';
import { useDb } from '../context';
import { ViewIcon } from '../ui/icons';
import { CommitInput, cx, IconBtn, MenuDivider, MenuItem, MenuLabel, stopEscape } from '../ui/primitives';
import { moveId, SortableList, useSortableItem } from '../ui/Sortable';

import { MENU_VIEW_TYPES as VIEW_TYPES } from './viewTypes';

function uniqueViewName(base: string, views: View[]): string {
  const names = new Set(views.map((v) => v.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function ViewTabs({
  views,
  activeId,
  onActivate,
}: {
  views: View[];
  activeId: string;
  onActivate: (id: string) => void;
}) {
  const { canEdit, m } = useDb();
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const add = async (type: ViewType) => {
    setAdding(false);
    const view = await m.createView(uniqueViewName(VIEW_TYPE_LABELS[type], views), type);
    if (view) onActivate(view.id);
  };

  const onMove = (activeViewId: string, overId: string, place: 'before' | 'after') => {
    const ids = moveId(
      views.map((v) => v.id),
      activeViewId,
      overId,
      place,
    );
    const idx = ids.indexOf(activeViewId);
    void m.moveView(activeViewId, idx === 0 ? null : ids[idx - 1]!);
  };

  return (
    <div className="ordb-tabs" role="tablist" aria-label="Vues">
      <SortableList ids={views.map((v) => v.id)} onMove={onMove} axis="x" disabled={!canEdit}>
        {views.map((v) => (
          <ViewTab
            key={v.id}
            view={v}
            views={views}
            active={v.id === activeId}
            menuOpen={menuFor === v.id}
            setMenuOpen={(o) => setMenuFor(o ? v.id : null)}
            onActivate={() => onActivate(v.id)}
            onActivateOther={onActivate}
          />
        ))}
      </SortableList>
      {canEdit && (
        <Popover opened={adding} onChange={setAdding} position="bottom-start" width={220} shadow="md">
          <Popover.Target>
            <IconBtn label="Ajouter une vue" onClick={() => setAdding((o) => !o)} className="ordb-tab-add">
              <Plus size={15} />
            </IconBtn>
          </Popover.Target>
          <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
            <MenuLabel>Nouvelle vue</MenuLabel>
            {VIEW_TYPES.map((t) => (
              <MenuItem key={t} icon={<ViewIcon type={t} />} label={VIEW_TYPE_LABELS[t]} onClick={() => void add(t)} />
            ))}
          </Popover.Dropdown>
        </Popover>
      )}
    </div>
  );
}

function ViewTab({
  view,
  views,
  active,
  menuOpen,
  setMenuOpen,
  onActivate,
  onActivateOther,
}: {
  view: View;
  views: View[];
  active: boolean;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  onActivate: () => void;
  onActivateOther: (id: string) => void;
}) {
  const { canEdit, m } = useDb();
  const { setNodeRef, style, handleProps } = useSortableItem(view.id, !canEdit);
  const duplicate = async () => {
    setMenuOpen(false);
    const copy = await m.duplicateView(view.id);
    if (copy) onActivateOther(copy.id);
  };
  const remove = () => {
    setMenuOpen(false);
    const other = views.find((v) => v.id !== view.id);
    if (!other) return;
    if (active) onActivateOther(other.id);
    void m.deleteView(view.id);
  };

  const tab = (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      className={cx('ordb-tab', active && 'is-active')}
      {...handleProps}
      role="tab"
      aria-selected={active}
      onClick={() => {
        if (active && canEdit) setMenuOpen(!menuOpen);
        else onActivate();
      }}
      onContextMenu={(e) => {
        if (!canEdit) return;
        openContextMenu(e, [
          { header: view.name || 'Sans nom' },
          {
            label: 'Renommer',
            icon: <Pencil size={15} />,
            onClick: () => {
              if (!active) onActivate();
              setMenuOpen(true);
            },
          },
          { label: 'Dupliquer', icon: <Copy size={15} />, onClick: () => void duplicate() },
          { divider: true },
          { label: 'Supprimer', icon: <Trash size={15} />, danger: true, disabled: views.length <= 1, onClick: remove },
        ]);
      }}
      title={active && canEdit ? 'Options de la vue' : view.name}
    >
      <ViewIcon type={view.type} />
      <span className="ordb-tab-name">{view.name || 'Sans nom'}</span>
      {active && canEdit && <ChevronDown size={12} className="ordb-tab-chevron" />}
    </button>
  );

  if (!canEdit || !active) return tab;

  return (
    <Popover opened={menuOpen} onChange={setMenuOpen} position="bottom-start" width={250} shadow="md">
      <Popover.Target>{tab}</Popover.Target>
      <Popover.Dropdown className="ordb-dropdown" onKeyDown={stopEscape}>
        {menuOpen && (
          <>
            <div className="ordb-panel-body">
              <CommitInput
                value={view.name}
                ariaLabel="Nom de la vue"
                autoFocus
                selectOnFocus
                onCommit={(name) => name.trim() && void m.updateView(view.id, { name: name.trim() })}
              />
            </div>
            <MenuLabel>Disposition</MenuLabel>
            <div className="ordb-layout-grid">
              {VIEW_TYPES.map((t) => (
                <button
                  type="button"
                  key={t}
                  className={cx('ordb-layout-choice', view.type === t && 'is-active')}
                  onClick={() => void m.updateView(view.id, { type: t })}
                >
                  <ViewIcon type={t} size={18} />
                  <span>{VIEW_TYPE_LABELS[t]}</span>
                  {view.type === t && <Check size={12} className="ordb-layout-check" />}
                </button>
              ))}
            </div>
            <MenuDivider />
            <MenuItem icon={<Copy size={14} />} label="Dupliquer la vue" onClick={() => void duplicate()} />
            <MenuItem
              icon={<Trash size={14} />}
              label="Supprimer la vue"
              danger
              disabled={views.length <= 1}
              title={views.length <= 1 ? 'Une base doit garder au moins une vue' : undefined}
              onClick={remove}
            />
          </>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
