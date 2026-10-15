// Sidebar folders (navigation module, N09): group root pages of a section ("Partagé", "Privé" or a
// teamspace) without a parent page. No content; each page keeps its own access.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
import { ChevronRight, Folder, FolderOpen, Pencil, Trash } from 'lucide-react';
import type { FolderSummary, TreeNode } from '@oriel/shared';
import { errorMessage, queryClient } from '../../lib/queryClient';
import { promptDialog, toast } from '../../lib/ui';
import { openContextMenu, type ContextMenuEntry } from '../../components/ContextMenu';
import { navApi, nk } from './api';
import { FolderOrganizeItems, useFolderOrganizeCount } from '../../organize/SidebarOrganize';

export function useFolders(workspaceId: string) {
  return useQuery({ queryKey: nk.folders(workspaceId), queryFn: () => navApi.folders(workspaceId) });
}

export async function folderAction(workspaceId: string, fn: () => Promise<unknown>, fallback = 'Action impossible.') {
  try {
    await fn();
  } catch (e) {
    toast.error(errorMessage(e, fallback));
  } finally {
    void queryClient.invalidateQueries({ queryKey: nk.folders(workspaceId) });
  }
}

export async function createFolder(workspaceId: string, space: string) {
  const name = await promptDialog({ title: 'Nouveau dossier', label: 'Nom', placeholder: 'Ex. : Clients', confirmLabel: 'Créer' });
  if (name?.trim()) await folderAction(workspaceId, () => navApi.addFolder(workspaceId, space, name));
}

/** Folder of a page (from the cached folders list), if any. */
export function folderOfPage(workspaceId: string, pageId: string): FolderSummary | null {
  const data = queryClient.getQueryData<{ folders: FolderSummary[] }>(nk.folders(workspaceId));
  return data?.folders.find((f) => f.pageIds.includes(pageId)) ?? null;
}

/** Folders of a space ('workspace' | 'private' | teamspace root id), from the cache. */
export function foldersOfSpace(workspaceId: string, space: string): FolderSummary[] {
  const data = queryClient.getQueryData<{ folders: FolderSummary[] }>(nk.folders(workspaceId));
  return (data?.folders ?? []).filter((f) => f.space === space);
}

/** Splits the root nodes of a space into its folders and the remaining (loose) nodes. */
export function groupByFolders(nodes: TreeNode[], folders: FolderSummary[] | undefined, space: string) {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const used = new Set<string>();
  const groups = (folders ?? [])
    .filter((f) => f.space === space)
    .map((folder) => {
      const items = folder.pageIds.map((id) => byId.get(id)).filter((n): n is TreeNode => !!n);
      items.forEach((n) => used.add(n.id));
      return { folder, nodes: items };
    });
  return { groups, loose: nodes.filter((n) => !used.has(n.id)) };
}

export function FolderBlock({
  workspaceId,
  folder,
  nodes,
  depth,
  expanded,
  onToggle,
  canEdit,
  isDropTarget,
  renderNode,
}: {
  workspaceId: string;
  folder: FolderSummary;
  nodes: TreeNode[];
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  isDropTarget: boolean;
  renderNode: (node: TreeNode) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `folder:${folder.id}`, data: { kind: 'folder', folderId: folder.id } });
  const editable = canEdit || folder.space === 'private';
  const entries = (): ContextMenuEntry[] =>
    editable
      ? [
          {
            label: 'Renommer le dossier',
            icon: <Pencil size={15} />,
            onClick: async () => {
              const name = await promptDialog({ title: 'Renommer le dossier', label: 'Nom', initialValue: folder.name, confirmLabel: 'Renommer' });
              if (name?.trim()) void folderAction(workspaceId, () => navApi.updateFolder(folder.id, { name }));
            },
          },
          {
            label: 'Supprimer le dossier (garde les pages)',
            icon: <Trash size={15} />,
            danger: true,
            onClick: () => void folderAction(workspaceId, () => navApi.deleteFolder(folder.id)),
          },
        ]
      : [];
  const Icon = expanded ? FolderOpen : Folder;
  // Organize module: tags and collections placed in this folder.
  const extraCount = useFolderOrganizeCount(folder.id);
  return (
    <div className="tree-node">
      <div
        ref={setNodeRef}
        className={`tree-row nav-folder${isDropTarget ? ' drop-inside' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded)) onToggle();
        }}
        onContextMenu={(e) => openContextMenu(e, entries())}
      >
        <span className={`tree-row__chevron${expanded ? ' is-open' : ''}`} aria-hidden>
          <ChevronRight size={14} />
        </span>
        <Icon size={16} className="nav-folder__icon" aria-hidden />
        <span className="tree-row__title">{folder.name}</span>
        <span className="nav-folder__count" aria-label={`${nodes.length + extraCount} éléments`}>
          {nodes.length + extraCount}
        </span>
      </div>
      {expanded && (
        <div role="group">
          <FolderOrganizeItems folderId={folder.id} depth={depth + 1} />
          {nodes.length === 0 && extraCount === 0 ? (
            <div className="tree-row__none" style={{ paddingLeft: 30 + depth * 14 }}>
              Glissez des pages dans ce dossier.
            </div>
          ) : (
            nodes.map(renderNode)
          )}
        </div>
      )}
    </div>
  );
}
