// Page actions of a sidebar entry: the "…" menu and the right-click menu share the same entries.
import type { ReactNode } from 'react';
import { Menu } from '@mantine/core';
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  FilePlus2,
  FileUp,
  FolderInput,
  LayoutTemplate,
  Link,
  Pencil,
  Star,
  StarOff,
  Trash,
} from 'lucide-react';
import type { TreeNode } from '@oriel/shared';
import { copyPageLink, duplicatePage, importMarkdown, setFavorite, trashPage } from '../lib/pages';
import { Bookmark, Folder, FolderMinus, FolderPlus, Users } from 'lucide-react';
import { moveWithConsent, openConvertToTeamspace } from './nav/access';
import { addPageShortcut } from './nav/SidebarShortcuts';
import { createFolder, folderAction, folderOfPage, foldersOfSpace } from './nav/folders';
import { navApi } from './nav/api';
import { openPagePicker } from '../lib/ui';
import { appNavigate, pagePath } from '../lib/util';
import type { TreeIndex } from '../lib/tree';
import { descendantIds } from '../lib/tree';
import { MenuEntries, type ContextMenuEntries, type ContextMenuEntry } from '../components/ContextMenu';
import { openTemplatePicker, setPageTemplate } from '../editor/templates';

export function openMovePicker(workspaceId: string, index: TreeIndex | null, pageId: string) {
  const exclude = index ? descendantIds(index, pageId) : new Set<string>();
  exclude.add(pageId);
  openPagePicker({
    title: 'Déplacer vers…',
    allowRoots: true,
    exclude,
    onPick: (target) => {
      if (target.kind === 'root') {
        void moveWithConsent(workspaceId, pageId, { parentType: 'workspace', parentId: workspaceId, visibility: target.visibility });
      } else {
        void moveWithConsent(workspaceId, pageId, { parentType: 'page', parentId: target.id });
      }
    },
  });
}

export interface PageActionContext {
  node: TreeNode;
  workspaceId: string;
  index: TreeIndex;
  canEdit: boolean;
  /** Workspace owner/admin (navigation module: only they turn a page into a teamspace). */
  canManage?: boolean;
  isFavorite: boolean;
  onRename?: () => void;
  /** Right-click menus also offer to open the page. */
  withOpen?: boolean;
}

/** Entries of a page's action menu (sidebar "…" button, right-click on a sidebar entry or favorite). */
export function pageActionEntries(ctx: PageActionContext): ContextMenuEntry[] {
  const { node, workspaceId, index, canEdit, isFavorite, onRename, withOpen } = ctx;
  const isPage = node.kind === 'page';
  const entries: ContextMenuEntries = [
    withOpen && { label: 'Ouvrir', icon: <ArrowUpRight size={15} />, onClick: () => appNavigate(pagePath(workspaceId, node.id)) },
    withOpen && {
      label: 'Ouvrir dans un nouvel onglet',
      icon: <ExternalLink size={15} />,
      onClick: () => window.open(pagePath(workspaceId, node.id), '_blank', 'noopener'),
    },
    withOpen && { divider: true },
    canEdit && !!onRename && { label: 'Renommer', icon: <Pencil size={15} />, onClick: onRename },
    canEdit && { label: 'Dupliquer', icon: <Copy size={15} />, onClick: () => void duplicatePage(workspaceId, node.id, false) },
    {
      label: isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris',
      icon: isFavorite ? <StarOff size={15} /> : <Star size={15} />,
      onClick: () => void setFavorite(workspaceId, node.id, !isFavorite),
    },
    canEdit && { label: 'Déplacer vers…', icon: <FolderInput size={15} />, onClick: () => openMovePicker(workspaceId, index, node.id) },
    ...navigationEntries(ctx),
    { label: 'Copier le lien', icon: <Link size={15} />, onClick: () => void copyPageLink(workspaceId, node.id) },
    canEdit &&
      isPage && {
        label: 'Nouvelle sous-page depuis un modèle…',
        icon: <FilePlus2 size={15} />,
        onClick: () => openTemplatePicker(workspaceId, { parentType: 'page', parentId: node.id }),
      },
    canEdit &&
      isPage && {
        label: node.isTemplate ? 'Ne plus utiliser comme modèle' : 'Utiliser comme modèle',
        icon: <LayoutTemplate size={15} />,
        onClick: () => void setPageTemplate(workspaceId, node.id, !node.isTemplate),
      },
    canEdit &&
      isPage && {
        label: 'Importer Markdown',
        icon: <FileUp size={15} />,
        onClick: () => void importMarkdown({ workspaceId, parentType: 'page', parentId: node.id }),
      },
    canEdit && { divider: true },
    canEdit && { label: 'Supprimer', icon: <Trash size={15} />, danger: true, onClick: () => void trashPage(workspaceId, node.id) },
  ];
  return entries.filter((e): e is ContextMenuEntry => !!e);
}

export function PageActionsMenu({
  node,
  workspaceId,
  index,
  canEdit,
  canManage,
  isFavorite,
  opened,
  onChange,
  onRename,
  children,
}: {
  node: TreeNode;
  workspaceId: string;
  index: TreeIndex;
  canEdit: boolean;
  canManage?: boolean;
  isFavorite: boolean;
  opened: boolean;
  onChange: (opened: boolean) => void;
  onRename: () => void;
  children: ReactNode;
}) {
  return (
    <Menu opened={opened} onChange={onChange} position="bottom-start" width={250} shadow="md" withinPortal>
      <Menu.Target>{children}</Menu.Target>
      <Menu.Dropdown>
        {opened && <MenuEntries entries={pageActionEntries({ node, workspaceId, index, canEdit, canManage, isFavorite, onRename })} />}
      </Menu.Dropdown>
    </Menu>
  );
}

/** Navigation module entries: shortcuts, folders, teamspaces. */
function navigationEntries(ctx: PageActionContext): ContextMenuEntries {
  const { node, workspaceId, index, canEdit, canManage } = ctx;
  const out: ContextMenuEntries = [{ label: 'Ajouter aux raccourcis', icon: <Bookmark size={15} />, onClick: () => addPageShortcut(workspaceId, node.id) }];
  // Space of a root page: shared / private section, or the teamspace whose root is its parent.
  const parent = node.parentType === 'page' ? index.byId.get(node.parentId) : undefined;
  const space =
    node.parentType === 'workspace' && !node.isTeamspace
      ? node.visibility === 'private'
        ? 'private'
        : 'workspace'
      : parent?.isTeamspace && parent.parentType === 'workspace'
        ? parent.id
        : null;
  const editableSpace = canEdit || space === 'private';
  if (space && editableSpace) {
    const current = folderOfPage(workspaceId, node.id);
    const targets = foldersOfSpace(workspaceId, space).filter((f) => f.id !== current?.id);
    if (targets.length > 0) {
      out.push({
        label: 'Ranger dans un dossier',
        icon: <Folder size={15} />,
        submenu: targets.map((f) => ({ label: f.name, onClick: () => void folderAction(workspaceId, () => navApi.putInFolder(f.id, node.id)) })),
      });
    }
    if (current) {
      out.push({ label: 'Retirer du dossier', icon: <FolderMinus size={15} />, onClick: () => void folderAction(workspaceId, () => navApi.removeFromFolder(node.id)) });
    }
  }
  if (node.isTeamspace && canEdit) {
    out.push({ label: 'Nouveau dossier dans cet espace…', icon: <FolderPlus size={15} />, onClick: () => void createFolder(workspaceId, node.id) });
  }
  // User decision: only workspace owners/admins turn a page into a teamspace.
  if (canEdit && canManage && node.kind === 'page' && !node.isTeamspace && !node.isTemplate) {
    out.push({
      label: 'Transformer en espace d’équipe…',
      icon: <Users size={15} />,
      onClick: () =>
        openConvertToTeamspace({ workspaceId, pageId: node.id, title: node.title, initial: node.visibility === 'workspace' ? 'open' : 'private' }),
    });
  }
  return out;
}
