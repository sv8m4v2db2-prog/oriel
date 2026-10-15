// Sidebar parts of the organize module: « Toutes les pages » entry, the « Tags et collections »
// section, and the tags / collections placed inside a navigation folder.
import { useState, type MouseEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight, Folder, FolderMinus, LayoutList, Library, Pencil, Plus, Tag as TagIcon } from 'lucide-react';
import type { Collection, FolderItemKind, Tag } from '@oriel/shared';
import { Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../lib/queryClient';
import { storage } from '../lib/store';
import { toast } from '../lib/ui';
import { openContextMenu, type ContextMenuEntry } from '../components/ContextMenu';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { navApi, nk } from '../shell/nav/api';
import { orgApi, ok } from './api';
import { CollectionEditor } from './CollectionEditor';
import { invalidateOrg, useCollections, useTags } from './hooks';
import './organize.css';

/** Entry of the sidebar navigation (under « Accueil »). */
export function AllPagesSidebarLink() {
  const { workspaceId } = useWorkspaceCtx();
  return (
    <NavLink to={`/w/${workspaceId}/all-pages`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
      <LayoutList size={16} />
      <span className="nav-item__label">Toutes les pages</span>
    </NavLink>
  );
}

function useFolderItems(workspaceId: string) {
  return useQuery({ queryKey: ok.folderItems(workspaceId), queryFn: () => orgApi.folderItems(workspaceId), select: (d) => d.items, staleTime: 30_000 });
}

function useItemMenu(workspaceId: string, canEdit: boolean) {
  const folders = useQuery({ queryKey: nk.folders(workspaceId), queryFn: () => navApi.folders(workspaceId) }).data?.folders ?? [];
  return (event: MouseEvent, kind: FolderItemKind, refId: string, folderId: string | null, extra: ContextMenuEntry[] = []) => {
    const place = async (folderId: string) => {
      try {
        await orgApi.putFolderItem(folderId, kind, refId);
      } catch (e) {
        toast.error(errorMessage(e, 'Rangement impossible.'));
      } finally {
        invalidateOrg('folder-items');
      }
    };
    const entries: ContextMenuEntry[] = [...extra];
    if (folderId) {
      entries.push({
        label: 'Retirer du dossier',
        icon: <FolderMinus size={15} />,
        onClick: () => void orgApi.removeFolderItem(folderId, kind, refId).then(() => invalidateOrg('folder-items')).catch((e) => toast.error(errorMessage(e, 'Action impossible.'))),
      });
    }
    const targets = folders.filter((f) => f.id !== folderId && (f.space === 'private' || canEdit));
    if (targets.length > 0) {
      entries.push({
        label: 'Ranger dans un dossier…',
        icon: <Folder size={15} />,
        submenu: targets.map((f) => ({ label: f.name, onClick: () => void place(f.id) })),
      });
    }
    openContextMenu(event, entries);
  };
}

function TagRow({ tag, depth, inFolder, onMenu }: { tag: Tag; depth: number; inFolder: boolean; onMenu: (e: MouseEvent) => void }) {
  const { workspaceId } = useWorkspaceCtx();
  return (
    <NavLink
      to={`/w/${workspaceId}/tags/${tag.id}`}
      className={({ isActive }) => `tree-row org-side-row${isActive ? ' is-active' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onContextMenu={onMenu}
      data-in-folder={inFolder || undefined}
    >
      <TagIcon size={14} className="org-side-row__icon" aria-hidden />
      <span className="tag org-side-tag" data-color={tag.color}>
        {tag.name}
      </span>
      <span className="org-side-row__count">{tag.pageCount}</span>
    </NavLink>
  );
}

function CollectionRow({ collection, depth, onMenu }: { collection: Collection; depth: number; onMenu: (e: MouseEvent) => void }) {
  const { workspaceId } = useWorkspaceCtx();
  return (
    <NavLink
      to={`/w/${workspaceId}/collections/${collection.id}`}
      className={({ isActive }) => `tree-row org-side-row${isActive ? ' is-active' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onContextMenu={onMenu}
    >
      {collection.icon ? <span className="org-side-row__emoji">{collection.icon}</span> : <Library size={14} className="org-side-row__icon" aria-hidden />}
      <span className="tree-row__title">{collection.name}</span>
    </NavLink>
  );
}

/** « Tags et collections » : those not placed in a folder. Folders show their own. */
export function OrganizeSidebarSection() {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const key = `oriel:org-section-open:${workspaceId}`;
  const [open, setOpen] = useState(() => storage.getJSON<boolean>(key, true));
  const [editing, setEditing] = useState<Collection | 'new' | null>(null);
  const tags = useTags(workspaceId);
  const collections = useCollections(workspaceId);
  const items = useFolderItems(workspaceId);
  const menu = useItemMenu(workspaceId, canEdit);
  const placed = new Set((items.data ?? []).map((i) => `${i.kind}:${i.refId}`));
  const looseCollections = (collections.data ?? []).filter((c) => !placed.has(`collection:${c.id}`));
  const looseTags = (tags.data ?? []).filter((t) => !placed.has(`tag:${t.id}`));
  const total = (collections.data?.length ?? 0) + (tags.data?.length ?? 0);
  const toggle = () => {
    setOpen((o) => {
      storage.setJSON(key, !o);
      return !o;
    });
  };

  if (total === 0 && !canEdit) return null;
  return (
    <section className="sidebar__section sidebar__section--org">
      <div className="section-header">
        <button type="button" className="section-header__toggle" aria-expanded={open} onClick={toggle}>
          <ChevronRight size={12} className={`section-header__chevron${open ? ' is-open' : ''}`} />
          <span className="section-header__title">Tags et collections</span>
          {total > 0 && <span className="section-header__count">{total}</span>}
        </button>
        {canEdit && (
          <Tooltip label="Nouvelle collection" openDelay={400}>
            <button type="button" className="icon-btn icon-btn--sm section-header__add" aria-label="Nouvelle collection" onClick={() => setEditing('new')}>
              <Plus size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {open && (
        <>
          {looseCollections.map((c) => (
            <CollectionRow
              key={c.id}
              collection={c}
              depth={0}
              onMenu={(e) =>
                menu(e, 'collection', c.id, null, canEdit ? [{ label: 'Modifier la collection', icon: <Pencil size={15} />, onClick: () => setEditing(c) }] : [])
              }
            />
          ))}
          {looseTags.map((t) => (
            <TagRow key={t.id} tag={t} depth={0} inFolder={false} onMenu={(e) => menu(e, 'tag', t.id, null)} />
          ))}
          {total === 0 && <div className="tree-empty">Aucun tag ni collection. Ajoutez un tag depuis l’en-tête d’une page.</div>}
        </>
      )}
      {editing && (
        <CollectionEditor
          workspaceId={workspaceId}
          collection={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** Tags and collections of a folder, rendered inside the folder block. */
export function FolderOrganizeItems({ folderId, depth }: { folderId: string; depth: number }) {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const items = useFolderItems(workspaceId).data ?? [];
  const tags = useTags(workspaceId).data ?? [];
  const collections = useCollections(workspaceId).data ?? [];
  const menu = useItemMenu(workspaceId, canEdit);
  const mine = items.filter((i) => i.folderId === folderId);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((i) => {
        if (i.kind === 'tag') {
          const t = tags.find((x) => x.id === i.refId);
          return t ? <TagRow key={`t${i.refId}`} tag={t} depth={depth} inFolder onMenu={(e) => menu(e, 'tag', t.id, folderId)} /> : null;
        }
        const c = collections.find((x) => x.id === i.refId);
        return c ? <CollectionRow key={`c${i.refId}`} collection={c} depth={depth} onMenu={(e) => menu(e, 'collection', c.id, folderId)} /> : null;
      })}
    </>
  );
}

/** Number of tag/collection entries of a folder (for its counter). */
export function useFolderOrganizeCount(folderId: string): number {
  const { workspaceId } = useWorkspaceCtx();
  const items = useFolderItems(workspaceId).data ?? [];
  return items.filter((i) => i.folderId === folderId).length;
}
