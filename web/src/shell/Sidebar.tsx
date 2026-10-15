import { SidebarFeatureLinks } from '../features/registry';
import { OrganizeSidebarSection } from '../organize/SidebarOrganize';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Menu, Tooltip } from '@mantine/core';
import { FolderPlus } from 'lucide-react';
import { Presentation as CanvasIcon } from 'lucide-react';
import { createCanvasPage } from '../canvas';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  Database,
  Ellipsis,
  FileText,
  FileUp,
  House,
  LayoutTemplate,
  Plus,
  Search,
  Settings,
  Trash,
} from 'lucide-react';
import type { TreeNode, Visibility } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { createPage, importMarkdown, setFavorite, updatePage } from '../lib/pages';
import { storage } from '../lib/store';
import { ancestorsOf, childrenOf, descendantIds, rootNodes, siblingsOf, useTree, type TreeIndex } from '../lib/tree';
import { SIDEBAR_MAX, SIDEBAR_MIN, openSearch, sidebarStore, toggleSidebar } from '../lib/ui';
import { modKey, pagePath, pageTitle } from '../lib/util';
import { Kbd, PageIcon, Skeleton } from '../components/common';
import { useWorkspaceCtx } from './WorkspaceContext';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { PageActionsMenu, pageActionEntries } from './PageActionsMenu';
import { openContextMenu } from '../components/ContextMenu';
import { openTemplatePicker, setPageTemplate } from '../editor/templates';
import { currentSection } from './shortcuts';
import { moveWithConsent } from './nav/access';
import { SidebarShortcuts } from './nav/SidebarShortcuts';
import { FolderBlock, createFolder, folderAction, folderOfPage, groupByFolders, useFolders } from './nav/folders';
import { navApi } from './nav/api';
import './nav/nav.css';

// ---------------------------------------------------------------------------
// Tree UI state
// ---------------------------------------------------------------------------

type DropPosition = 'before' | 'after' | 'inside';
interface DropIndicator {
  overId: string;
  position: DropPosition;
}

interface TreeUi {
  index: TreeIndex;
  expanded: Set<string>;
  toggle: (id: string) => void;
  expand: (id: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  currentPageId: string | undefined;
  favoriteIds: Set<string>;
  indicator: DropIndicator | null;
  draggingId: string | null;
}

const TreeUiContext = createContext<TreeUi | null>(null);
const useTreeUi = () => useContext(TreeUiContext)!;

function useExpanded(workspaceId: string) {
  const key = `oriel:expanded:${workspaceId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(storage.getJSON<string[]>(key, [])));
  useEffect(() => {
    storage.setJSON(key, [...expanded]);
  }, [key, expanded]);
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expand = useCallback((id: string) => {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const expandMany = useCallback((ids: string[]) => {
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);
  return { expanded, toggle, expand, expandMany };
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const ctx = useWorkspaceCtx();
  const { workspaceId, canEdit } = ctx;
  const { pageId } = useParams();
  const tree = useTree(workspaceId);
  const favorites = useQuery({ queryKey: qk.favorites(workspaceId), queryFn: () => api.workspaces.favorites(workspaceId) });
  const { expanded, toggle, expand, expandMany } = useExpanded(workspaceId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const indicatorRef = useRef<DropIndicator | null>(null);
  const index = tree.index;

  // Reveal the current page in the tree.
  useEffect(() => {
    if (!pageId || !index.byId.has(pageId)) return;
    const anc = ancestorsOf(index, pageId).map((a) => a.id);
    if (anc.length) expandMany(anc);
  }, [pageId, index, expandMany]);

  const favoriteIds = useMemo(() => new Set((favorites.data?.favorites ?? []).map((f) => f.id)), [favorites.data]);

  const ui: TreeUi = {
    index,
    expanded,
    toggle,
    expand,
    renamingId,
    setRenamingId,
    currentPageId: pageId,
    favoriteIds,
    indicator,
    draggingId,
  };

  // --- Drag and drop ------------------------------------------------------------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const setInd = (next: DropIndicator | null) => {
    const prev = indicatorRef.current;
    if (prev?.overId === next?.overId && prev?.position === next?.position) return;
    indicatorRef.current = next;
    setIndicator(next);
  };

  const onDragStart = (e: DragStartEvent) => {
    setDraggingId(String(e.active.id));
  };

  /** Drop target under the pointer (before / after / inside), or null if not allowed. */
  const computeIndicator = (e: DragMoveEvent | DragEndEvent): DropIndicator | null => {
    const over = e.over;
    if (!over) return null;
    const activeKind = (e.active.data.current as { kind: string } | undefined)?.kind;
    const overData = over.data.current as { kind: string; nodeId?: string } | undefined;
    if (!overData || over.id === e.active.id) return null;
    if (activeKind === 'fav' && overData.kind !== 'fav') return null;
    if (activeKind === 'tpl' || overData.kind === 'tpl') return null;
    if (activeKind === 'tree' && overData.kind === 'fav') return null;
    if (overData.kind === 'root') return activeKind === 'tree' ? { overId: String(over.id), position: 'inside' } : null;
    // Navigation module: dropping a root page on a folder puts it inside.
    if (overData.kind === 'folder') return activeKind === 'tree' ? { overId: String(over.id), position: 'inside' } : null;
    const activator = e.activatorEvent as PointerEvent;
    const y = (activator.clientY ?? 0) + e.delta.y;
    const rel = (y - over.rect.top) / Math.max(1, over.rect.height);
    const target = overData.nodeId ? index.byId.get(overData.nodeId) : undefined;
    const allowInside = overData.kind === 'tree' && target?.kind === 'page';
    const position: DropPosition = allowInside
      ? rel < 0.28
        ? 'before'
        : rel > 0.72
          ? 'after'
          : 'inside'
      : rel < 0.5
        ? 'before'
        : 'after';
    // Cannot drop into itself or its descendants.
    const activeNode = (e.active.data.current as { nodeId?: string } | undefined)?.nodeId;
    if (activeKind === 'tree' && activeNode && overData.nodeId) {
      if (overData.nodeId === activeNode || descendantIds(index, activeNode).has(overData.nodeId)) return null;
    }
    return { overId: String(over.id), position };
  };

  const onDragMove = (e: DragMoveEvent) => setInd(computeIndicator(e));

  const onDragEnd = (e: DragEndEvent) => {
    const ind = computeIndicator(e) ?? indicatorRef.current;
    setInd(null);
    setDraggingId(null);
    const active = e.active.data.current as { kind: 'tree' | 'fav'; nodeId: string } | undefined;
    if (!active || !ind) return;
    const [overKind, overRef] = splitId(ind.overId);
    if (active.kind === 'fav') {
      if (overKind !== 'fav' || overRef === active.nodeId) return;
      const list = (favorites.data?.favorites ?? []).filter((f) => f.id !== active.nodeId);
      const idx = list.findIndex((f) => f.id === overRef);
      const after = ind.position === 'after' ? overRef : idx > 0 ? list[idx - 1]!.id : null;
      void setFavorite(workspaceId, active.nodeId, true, after);
      return;
    }
    const id = active.nodeId;
    if (overKind === 'folder') {
      void folderAction(workspaceId, () => navApi.putInFolder(overRef, id), 'Seules les pages à la racine de cette section vont dans ce dossier.');
      return;
    }
    if (overKind === 'root') {
      const inFolder = folderOfPage(workspaceId, id);
      void moveWithConsent(workspaceId, id, { parentType: 'workspace', parentId: workspaceId, visibility: overRef as Visibility }).then(() => {
        if (inFolder) void folderAction(workspaceId, () => navApi.removeFromFolder(id));
      });
      return;
    }
    const target = index.byId.get(overRef);
    if (!target || target.id === id || descendantIds(index, id).has(target.id)) return;
    if (ind.position === 'inside') {
      void moveWithConsent(workspaceId, id, { parentType: 'page', parentId: target.id });
      expand(target.id);
      return;
    }
    const siblings = siblingsOf(index, target).filter((n) => n.id !== id);
    const i = siblings.findIndex((n) => n.id === target.id);
    const after = ind.position === 'after' ? target.id : i > 0 ? siblings[i - 1]!.id : null;
    void moveWithConsent(workspaceId, id, {
      parentType: target.parentType,
      parentId: target.parentId,
      after,
      visibility: target.parentType === 'workspace' ? target.visibility : undefined,
    });
  };

  const draggingNode = draggingId ? index.byId.get(splitId(draggingId)[1]) : undefined;

  // --- Resize ---------------------------------------------------------------------
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarStore.get().width;
    const move = (ev: PointerEvent) => {
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
      sidebarStore.set((s) => ({ ...s, width: w }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing');
    };
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const newPage = () =>
    void createPage({
      workspaceId,
      parentType: 'workspace',
      parentId: workspaceId,
      visibility: currentSection(workspaceId, pageId),
    }).catch(() => undefined);

  return (
    <aside className="sidebar" aria-label="Barre latérale">
      <div className="sidebar__header">
        <WorkspaceSwitcher />
        <Tooltip label={`Masquer la barre latérale (${modKey()}\\)`} openDelay={400}>
          <button type="button" className="icon-btn sidebar__collapse" aria-label="Masquer la barre latérale" onClick={toggleSidebar}>
            <ChevronsLeft size={17} />
          </button>
        </Tooltip>
      </div>

      <nav className="sidebar__nav">
        <button type="button" className="nav-item" onClick={openSearch}>
          <Search size={16} />
          <span className="nav-item__label">Rechercher</span>
          <Kbd>{modKey()}K</Kbd>
        </button>
        <NavLink end to={`/w/${workspaceId}`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
          <House size={16} />
          <span className="nav-item__label">Accueil</span>
        </NavLink>
        <SidebarFeatureLinks />
        <NavLink to={`/w/${workspaceId}/settings`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
          <Settings size={16} />
          <span className="nav-item__label">Réglages</span>
        </NavLink>
      </nav>

      <TreeUiContext.Provider value={ui}>
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setInd(null);
            setDraggingId(null);
          }}
        >
          <div className="sidebar__scroll">
            {(favorites.data?.favorites.length ?? 0) > 0 && (
              <section className="sidebar__section">
                <div className="section-header">
                  <span className="section-header__title">Favoris</span>
                </div>
                {favorites.data!.favorites.map((f) => (
                  <TreeItem key={`fav-${f.id}`} node={index.byId.get(f.id) ?? f} depth={0} variant="fav" />
                ))}
              </section>
            )}
            <SidebarShortcuts />
            <TeamspacesSection />
            <TreeSection visibility="workspace" title={rootNodes(index, workspaceId, 'workspace').some((n) => n.isTeamspace) ? 'Partagé' : 'Espace de travail'} loading={tree.isLoading} />
            <TreeSection visibility="private" title="Privé" loading={tree.isLoading} />
            <TemplatesSection />
            <OrganizeSidebarSection />
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingNode && (
              <div className="tree-drag-preview">
                <PageIcon icon={draggingNode.icon} kind={draggingNode.kind} size={16} />
                <span>{pageTitle(draggingNode.title)}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </TreeUiContext.Provider>

      <div className="sidebar__footer">
        <NavLink to={`/w/${workspaceId}/trash`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
          <Trash size={16} />
          <span className="nav-item__label">Corbeille</span>
        </NavLink>
        {canEdit && (
          <div className="nav-split">
            <button type="button" className="nav-item nav-item--new" onClick={newPage}>
              <Plus size={16} />
              <span className="nav-item__label">Nouvelle page</span>
            </button>
            <Menu position="top-end" width={230} withinPortal>
              <Menu.Target>
                <button type="button" className="icon-btn icon-btn--sm nav-split__more" aria-label="Autres façons de créer une page">
                  <ChevronDown size={14} />
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<FileText size={15} />} onClick={newPage}>
                  Page vide
                </Menu.Item>
                <Menu.Item
                  leftSection={<CanvasIcon size={15} />}
                  onClick={() =>
                    void createCanvasPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility: currentSection(workspaceId, pageId) }).catch(() => undefined)
                  }
                >
                  Canevas
                </Menu.Item>
                <Menu.Item
                  leftSection={<LayoutTemplate size={15} />}
                  onClick={() =>
                    openTemplatePicker(workspaceId, {
                      parentType: 'workspace',
                      parentId: workspaceId,
                      visibility: currentSection(workspaceId, pageId),
                    })
                  }
                >
                  Depuis un modèle…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        )}
      </div>
      <div className="sidebar__resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Redimensionner la barre latérale" />
    </aside>
  );
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(':');
  return [id.slice(0, i), id.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function TeamspacesSection() {
  const { workspaceId } = useWorkspaceCtx();
  const ui = useTreeUi();
  // Navigation module: joined teamspaces only (open, closed or private); the directory lists the others.
  const roots = (ui.index.children.get(`workspace:${workspaceId}`) ?? []).filter((n) => n.isTeamspace && !n.isTemplate && n.teamspaceMember !== false);
  if (roots.length === 0) return null;
  return (
    <section className="sidebar__section" aria-label="Espaces d’équipe">
      <div className="section-header"><span className="section-header__title">Espaces d’équipe</span></div>
      {roots.map((n) => <TreeItem key={n.id} node={n} depth={0} variant="tree" />)}
    </section>
  );
}

function TreeSection({ visibility, title, loading }: { visibility: Visibility; title: string; loading: boolean }) {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const ui = useTreeUi();
  const roots = rootNodes(ui.index, workspaceId, visibility).filter((n) => !n.isTemplate && !n.isTeamspace && (visibility !== 'private' || !n.isSharedShortcut));
  if (visibility === 'workspace') {
    const ids = new Set(roots.map((n) => n.id));
    for (const n of ui.index.byId.values()) if (n.isSharedShortcut && !n.isTemplate && !ids.has(n.id)) { roots.push(n); ids.add(n.id); }
  }
  const dropId = `root:${visibility}`;
  const { setNodeRef } = useDroppable({ id: dropId, data: { kind: 'root' } });
  const isDropTarget = ui.indicator?.overId === dropId;
  const [menuOpen, setMenuOpen] = useState(false);
  const folders = useFolders(workspaceId).data?.folders;
  const { groups, loose } = groupByFolders(roots, folders, visibility);

  const create = (kind: 'page' | 'database') =>
    void createPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility, kind }).catch(() => undefined);

  return (
    <section className="sidebar__section">
      <div ref={setNodeRef} className={`section-header${isDropTarget ? ' is-drop-target' : ''}`}>
        <span className="section-header__title">{title}</span>
        {canEdit && (
          <Menu opened={menuOpen} onChange={setMenuOpen} position="bottom-end" width={220} withinPortal>
            <Menu.Target>
              <button type="button" className="icon-btn icon-btn--sm section-header__add" aria-label={`Ajouter dans ${title}`}>
                <Plus size={14} />
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<FileText size={15} />} onClick={() => create('page')}>
                Nouvelle page
              </Menu.Item>
              <Menu.Item leftSection={<Database size={15} />} onClick={() => create('database')}>
                Nouvelle base de données
              </Menu.Item>
              <Menu.Item
                leftSection={<CanvasIcon size={15} />}
                onClick={() => void createCanvasPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility }).catch(() => undefined)}
              >
                Nouveau canevas
              </Menu.Item>
              <Menu.Item
                leftSection={<LayoutTemplate size={15} />}
                onClick={() => openTemplatePicker(workspaceId, { parentType: 'workspace', parentId: workspaceId, visibility })}
              >
                Depuis un modèle…
              </Menu.Item>
              <Menu.Item
                leftSection={<FileUp size={15} />}
                onClick={() => void importMarkdown({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility })}
              >
                Importer Markdown
              </Menu.Item>
              <Menu.Item leftSection={<FolderPlus size={15} />} onClick={() => void createFolder(workspaceId, visibility)}>
                Nouveau dossier…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
      {loading ? (
        <div className="tree-skeleton">
          <Skeleton width="70%" height={12} />
          <Skeleton width="55%" height={12} />
          <Skeleton width="62%" height={12} />
        </div>
      ) : roots.length === 0 && groups.length === 0 ? (
        <div className="tree-empty">
          {visibility === 'private' ? 'Vos pages personnelles apparaîtront ici.' : 'Aucune page partagée pour l’instant.'}
          {canEdit && (
            <button type="button" className="link-button" onClick={() => create('page')}>
              Ajouter une page
            </button>
          )}
        </div>
      ) : (
        <>
          {groups.map(({ folder, nodes }) => (
            <FolderBlock
              key={folder.id}
              workspaceId={workspaceId}
              folder={folder}
              nodes={nodes}
              depth={0}
              expanded={ui.expanded.has(`folder:${folder.id}`)}
              onToggle={() => ui.toggle(`folder:${folder.id}`)}
              canEdit={canEdit}
              isDropTarget={ui.indicator?.overId === `folder:${folder.id}`}
              renderNode={(n) => <TreeItem key={n.id} node={n} depth={1} variant="tree" />}
            />
          ))}
          {loose.map((n) => <TreeItem key={n.id} node={n} depth={0} variant="tree" />)}
        </>
      )}
    </section>
  );
}

/** "Modèles": page templates (collapsed by default), instantiated with "Nouvelle page › Depuis un modèle…". */
function TemplatesSection() {
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const ui = useTreeUi();
  const key = `oriel:templates-open:${workspaceId}`;
  const [open, setOpen] = useState(() => storage.getJSON<boolean>(key, false));
  useEffect(() => storage.setJSON(key, open), [key, open]);
  const templates = useMemo(
    () => [...ui.index.byId.values()].filter((n) => n.isTemplate).sort((a, b) => pageTitle(a.title).localeCompare(pageTitle(b.title), 'fr')),
    [ui.index],
  );
  const createTemplate = async () => {
    setOpen(true);
    try {
      const page = await createPage({ workspaceId, parentType: 'workspace', parentId: workspaceId, visibility: 'workspace', title: 'Nouveau modèle' });
      await setPageTemplate(workspaceId, page.id, true);
    } catch {
      /* already reported */
    }
  };
  return (
    <section className="sidebar__section sidebar__section--templates">
      <div className="section-header">
        <button type="button" className="section-header__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={12} className={`section-header__chevron${open ? ' is-open' : ''}`} />
          <span className="section-header__title">Modèles</span>
          {templates.length > 0 && <span className="section-header__count">{templates.length}</span>}
        </button>
        {canEdit && (
          <Tooltip label="Nouveau modèle" openDelay={400}>
            <button type="button" className="icon-btn icon-btn--sm section-header__add" aria-label="Nouveau modèle" onClick={() => void createTemplate()}>
              <Plus size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {open &&
        (templates.length === 0 ? (
          <div className="tree-empty">Aucun modèle. Menu « … » d’une page › « Utiliser comme modèle ».</div>
        ) : (
          templates.map((n) => <TreeItem key={`tpl-${n.id}`} node={n} depth={0} variant="tpl" />)
        ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

function TreeItem({ node, depth, variant }: { node: TreeNode; depth: number; variant: 'tree' | 'fav' | 'tpl' }) {
  const ui = useTreeUi();
  const { workspaceId, canEdit, canManage } = useWorkspaceCtx();
  const navigate = useNavigate();
  const dndId = `${variant}:${node.id}`;
  // Templates live in the "Modèles" section, not under their parent in the regular tree.
  const children = (node.kind === 'page' || node.isInline || node.kind === 'database' ? childrenOf(ui.index, node.id) : []).filter(
    (c) => !c.isTemplate,
  );
  const expandKey = variant === 'fav' ? `fav:${node.id}` : variant === 'tpl' ? `tpl:${node.id}` : node.id;
  const isExpanded = ui.expanded.has(expandKey);
  const isActive = ui.currentPageId === node.id;
  const [menuOpen, setMenuOpen] = useState(false);
  // Navigation module: a teamspace's root pages may be grouped in folders (tree variant only).
  const folderList = useFolders(workspaceId).data?.folders;
  const teamspaceFolders =
    node.isTeamspace && variant === 'tree' ? groupByFolders(children, folderList, node.id) : { groups: [], loose: children };
  const renaming = ui.renamingId === dndId;

  const drag = useDraggable({
    id: dndId,
    data: { kind: variant, nodeId: node.id },
    disabled: variant === 'tpl' || (!canEdit && variant === 'tree'),
  });
  const drop = useDroppable({ id: dndId, data: { kind: variant, nodeId: node.id } });
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };
  const ind = ui.indicator?.overId === dndId ? ui.indicator.position : null;

  const open = () => {
    if (renaming) return;
    navigate(pagePath(workspaceId, node.id));
  };

  const addChild = (e: ReactMouseEvent) => {
    e.stopPropagation();
    ui.expand(expandKey);
    void createPage({ workspaceId, parentType: 'page', parentId: node.id }).catch(() => undefined);
  };

  return (
    <div className="tree-node">
      <div
        {...drag.attributes}
        ref={setRef}
        className={`tree-row${isActive ? ' is-active' : ''}${drag.isDragging ? ' is-dragging' : ''}${menuOpen ? ' is-menu-open' : ''}${ind ? ` drop-${ind}` : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        data-page-id={node.id}
        aria-selected={isActive}
        aria-expanded={children.length ? isExpanded : undefined}
        tabIndex={0}
        onClick={open}
        onContextMenu={(e) => {
          if (renaming) return;
          openContextMenu(
            e,
            pageActionEntries({
              node,
              workspaceId,
              index: ui.index,
              canEdit,
              canManage,
              isFavorite: ui.favoriteIds.has(node.id),
              onRename: () => ui.setRenamingId(dndId),
              withOpen: true,
            }),
          );
        }}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (renaming) return;
          if (e.key === 'Enter') open();
          if (e.key === 'ArrowRight' && children.length && !isExpanded) ui.toggle(expandKey);
          if (e.key === 'ArrowLeft' && isExpanded) ui.toggle(expandKey);
        }}
        {...drag.listeners}
      >
        <button
          type="button"
          className={`tree-row__chevron${children.length ? '' : ' is-empty'}${isExpanded ? ' is-open' : ''}`}
          aria-label={isExpanded ? 'Replier' : 'Déplier'}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            ui.toggle(expandKey);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ChevronRight size={14} />
        </button>
        <PageIcon icon={node.icon} kind={node.kind} size={16} />
        {renaming ? (
          <RenameInput node={node} onDone={() => ui.setRenamingId(null)} />
        ) : (
          <span className="tree-row__title">{pageTitle(node.title)}</span>
        )}
        <span className="tree-row__actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <PageActionsMenu
            node={node}
            workspaceId={workspaceId}
            index={ui.index}
            canEdit={canEdit}
            canManage={canManage}
            isFavorite={ui.favoriteIds.has(node.id)}
            opened={menuOpen}
            onChange={setMenuOpen}
            onRename={() => ui.setRenamingId(dndId)}
          >
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Actions de la page">
              <Ellipsis size={15} />
            </button>
          </PageActionsMenu>
          {canEdit && node.kind === 'page' && (
            <Tooltip label="Ajouter une sous-page" openDelay={500}>
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Ajouter une sous-page" onClick={addChild}>
                <Plus size={15} />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
      {isExpanded && (
        <div role="group">
          {children.length === 0 && teamspaceFolders.groups.length === 0 ? (
            <div className="tree-row__none" style={{ paddingLeft: 30 + depth * 14 }}>
              {node.kind === 'database' ? 'Les lignes s’affichent dans la base' : 'Aucune sous-page'}
            </div>
          ) : (
            <>
              {teamspaceFolders.groups.map(({ folder, nodes }) => (
                <FolderBlock
                  key={folder.id}
                  workspaceId={workspaceId}
                  folder={folder}
                  nodes={nodes}
                  depth={depth + 1}
                  expanded={ui.expanded.has(`folder:${folder.id}`)}
                  onToggle={() => ui.toggle(`folder:${folder.id}`)}
                  canEdit={canEdit}
                  isDropTarget={ui.indicator?.overId === `folder:${folder.id}`}
                  renderNode={(c) => <TreeItem key={`${variant}-${c.id}`} node={c} depth={depth + 2} variant={variant} />}
                />
              ))}
              {teamspaceFolders.loose.map((c) => <TreeItem key={`${variant}-${c.id}`} node={c} depth={depth + 1} variant={variant} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RenameInput({ node, onDone }: { node: TreeNode; onDone: () => void }) {
  const { workspaceId } = useWorkspaceCtx();
  const [value, setValue] = useState(node.title);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (value !== node.title) void updatePage(workspaceId, node.id, { title: value.trim() }).catch(() => undefined);
    onDone();
  };
  return (
    <input
      className="tree-row__rename"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          done.current = true;
          onDone();
        }
      }}
    />
  );
}
