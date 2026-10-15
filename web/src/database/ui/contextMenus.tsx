// Right-click menus of the database module (rows, cells, cards, headers, view tabs), built on the
// app-wide openContextMenu().
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  ClipboardCopy,
  Columns2,
  Copy,
  Eraser,
  LayoutTemplate,
  EyeOff,
  Link as LinkIcon,
  ListFilter,
  Maximize2,
  PanelRightOpen,
  Pencil,
  Settings2,
  Trash,
  X,
} from 'lucide-react';
import type { Page, PropertyDef } from '@oriel/shared';
import { openContextMenu, type ContextMenuEntry } from '../../components/ContextMenu';
import { api } from '../../lib/api';
import { navigation } from '../../lib/navigation';
import { splitActions } from '../../split/actions';
import { toast } from '../../lib/ui';
import { copyToClipboard, pagePath } from '../../lib/util';
import type { DbContextValue } from '../context';
import { displayText } from '../logic/format';
import { isComputedType } from '../logic/values';

const ICON = 15;

export async function copyRowLink(workspaceId: string, rowId: string) {
  const ok = await copyToClipboard(`${window.location.origin}${pagePath(workspaceId, rowId)}`);
  if (ok) toast.success('Lien copié');
  else toast.error('Impossible de copier le lien.');
}

/** Trash rows with an « Annuler » toast. */
export function trashRowsWithUndo(db: Pick<DbContextValue, 'm'>, ids: string[]) {
  if (ids.length === 0) return;
  void db.m.trashRows(ids).then(() =>
    toast(ids.length > 1 ? `${ids.length} lignes placées dans la corbeille` : 'Ligne placée dans la corbeille', {
      tone: 'success',
      action: {
        label: 'Annuler',
        onClick: () => void Promise.all(ids.map((id) => api.pages.restore(id).catch(() => undefined))),
      },
    }),
  );
}

/** Entries acting on one row (table rows, cards, list rows, calendar / timeline items). */
export function rowEntries(db: DbContextValue, row: Pick<Page, 'id'>): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [
    { label: 'Ouvrir', icon: <PanelRightOpen size={ICON} />, onClick: () => navigation.openPeek(row.id) },
    { label: 'Ouvrir en pleine page', icon: <Maximize2 size={ICON} />, onClick: () => navigation.openPage(row.id) },
    { divider: true },
  ];
  // Split view (lot E): the same row, in the pane beside.
  if (!db.publicMode) {
    entries.splice(2, 0, { label: 'Ouvrir à côté', icon: <Columns2 size={ICON} />, shortcut: '⌥clic', onClick: () => splitActions.openBeside(row.id) });
  }
  if (db.canEdit) entries.push({ label: 'Dupliquer', icon: <Copy size={ICON} />, onClick: () => void db.m.duplicateRow(row.id) });
  // I1: the row (with its sub-pages) copied as a row template of its database.
  if (db.canEdit) {
    entries.push({
      label: 'Enregistrer comme modèle',
      icon: <LayoutTemplate size={ICON} />,
      onClick: () =>
        void db.m.convertRowToTemplate(row.id).then((tpl) => {
          if (tpl) toast.success('Modèle créé : il apparaît dans le menu « Nouveau ».');
        }),
    });
  }
  if (!db.publicMode) entries.push({ label: 'Copier le lien', icon: <LinkIcon size={ICON} />, onClick: () => void copyRowLink(db.workspaceId, row.id) });
  if (db.canEdit) {
    entries.push({ divider: true }, { label: 'Supprimer', icon: <Trash size={ICON} />, danger: true, onClick: () => trashRowsWithUndo(db, [row.id]) });
  }
  return entries;
}

export function openRowMenu(e: ReactMouseEvent, db: DbContextValue, row: Pick<Page, 'id'>) {
  openContextMenu(e, rowEntries(db, row));
}

/** Entries for a multi-row selection (table). */
export function selectionEntries(
  db: DbContextValue,
  ids: string[],
  actions: { onEditProperty: () => void; onClear: () => void },
): ContextMenuEntry[] {
  const n = ids.length;
  if (!db.canEdit) return [];
  return [
    { header: `${n} lignes sélectionnées` },
    { label: 'Modifier la propriété…', icon: <Settings2 size={ICON} />, onClick: actions.onEditProperty },
    { label: `Dupliquer ${n} lignes`, icon: <Copy size={ICON} />, onClick: () => void db.m.duplicateRows(ids) },
    { label: 'Désélectionner', icon: <X size={ICON} />, onClick: actions.onClear },
    { divider: true },
    {
      label: `Supprimer ${n} lignes`,
      icon: <Trash size={ICON} />,
      danger: true,
      onClick: () => {
        actions.onClear();
        trashRowsWithUndo(db, ids);
      },
    },
  ];
}

/** Entries of a cell (then the row's ones). */
export function cellEntries(db: DbContextValue, row: Page, prop: PropertyDef, onEdit: () => void): ContextMenuEntry[] {
  const editable = db.canEdit && !isComputedType(prop.type);
  const text = displayText(row, prop, db.ctx);
  const entries: ContextMenuEntry[] = [];
  if (editable && prop.type !== 'checkbox') entries.push({ label: 'Modifier', icon: <Pencil size={ICON} />, onClick: onEdit });
  if (editable) {
    entries.push({
      label: 'Effacer',
      icon: <Eraser size={ICON} />,
      disabled: prop.type === 'title' ? !row.title : row.properties[prop.id] === undefined,
      onClick: () =>
        void (prop.type === 'title' ? db.m.updateRow(row.id, { title: '' }) : db.m.updateRow(row.id, { properties: { [prop.id]: null } })),
    });
  }
  entries.push({
    label: 'Copier la valeur',
    icon: <ClipboardCopy size={ICON} />,
    disabled: !text,
    onClick: () => void copyToClipboard(text).then((ok) => ok && toast.success('Valeur copiée')),
  });
  return entries;
}

export interface HeaderMenuActions {
  sort: (direction: 'asc' | 'desc') => void;
  filter?: () => void;
  hide?: () => void;
  insert?: (side: 'left' | 'right') => void;
  duplicate?: () => void;
  remove?: () => void;
  edit: () => void;
}

/** Entries of a column header (same actions as the header menu). */
export function headerEntries(db: DbContextValue, prop: PropertyDef, a: HeaderMenuActions): ContextMenuEntry[] {
  const isTitle = prop.type === 'title';
  const entries: ContextMenuEntry[] = [{ header: prop.name }];
  entries.push({ label: db.canEdit ? 'Modifier la propriété…' : 'Détails de la propriété…', icon: <Settings2 size={ICON} />, onClick: a.edit });
  entries.push(
    { divider: true },
    { label: 'Trier par ordre croissant', icon: <ArrowUp size={ICON} />, onClick: () => a.sort('asc') },
    { label: 'Trier par ordre décroissant', icon: <ArrowDown size={ICON} />, onClick: () => a.sort('desc') },
  );
  if (a.filter) entries.push({ label: 'Filtrer', icon: <ListFilter size={ICON} />, onClick: a.filter });
  if (a.hide && !isTitle) entries.push({ label: 'Masquer dans la vue', icon: <EyeOff size={ICON} />, onClick: a.hide });
  if (db.canEdit && a.insert) {
    entries.push(
      { divider: true },
      { label: 'Insérer à gauche', icon: <ArrowLeftToLine size={ICON} />, onClick: () => a.insert?.('left') },
      { label: 'Insérer à droite', icon: <ArrowRightToLine size={ICON} />, onClick: () => a.insert?.('right') },
    );
  }
  if (db.canEdit && !isTitle) {
    entries.push({ divider: true });
    if (a.duplicate) entries.push({ label: 'Dupliquer la propriété', icon: <Copy size={ICON} />, onClick: a.duplicate });
    if (a.remove) entries.push({ label: 'Supprimer la propriété', icon: <Trash size={ICON} />, danger: true, onClick: a.remove });
  }
  return entries;
}
