// Personal sidebar (navigation module, N04): shortcuts to pages, database views and external links,
// grouped in named, reorderable, collapsible sections. A pinned database unfolds into its views,
// then its rows (loaded on demand). The server omits shortcuts whose target became invisible.
import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Menu, Tooltip } from '@mantine/core';
import { ChevronRight, Ellipsis, ExternalLink, FolderPlus, Globe, Link as LinkIcon, Pencil, Plus, Trash, ArrowRightLeft, FileText } from 'lucide-react';
import type { SidebarItem, SidebarSection } from '@oriel/shared';
import { api } from '../../lib/api';
import { errorMessage, queryClient } from '../../lib/queryClient';
import { qk } from '../../lib/queryKeys';
import { storage } from '../../lib/store';
import { openPagePicker, promptDialog, toast } from '../../lib/ui';
import { pagePath, pageTitle } from '../../lib/util';
import { safeWebUrl } from '../../lib/safeUrl';
import { PageIcon } from '../../components/common';
import { openContextMenu, type ContextMenuEntry } from '../../components/ContextMenu';
import { VIEW_ICONS } from '../../database/ui/icons';
import { useWorkspaceCtx } from '../WorkspaceContext';
import { navApi, nk } from './api';

const ROWS_PAGE = 25;

async function act(workspaceId: string, fn: () => Promise<unknown>, fallback: string) {
  try {
    await fn();
  } catch (e) {
    toast.error(errorMessage(e, fallback));
  } finally {
    void queryClient.invalidateQueries({ queryKey: nk.sidebar(workspaceId) });
  }
}

/** "Ajouter aux raccourcis" (page actions). */
export function addPageShortcut(workspaceId: string, pageId: string) {
  void act(workspaceId, async () => {
    await navApi.addItem(workspaceId, { kind: 'page', pageId });
    toast.success('Ajouté aux raccourcis');
  }, 'Impossible d’ajouter ce raccourci.');
}

export async function addLinkShortcut(workspaceId: string, sectionId: string | null) {
  const url = await promptDialog({ title: 'Ajouter un lien externe', label: 'Adresse (http ou https)', placeholder: 'https://…', confirmLabel: 'Continuer' });
  if (!url) return;
  const label = await promptDialog({ title: 'Nom du lien', label: 'Nom affiché', placeholder: 'Ex. : Drive du projet', confirmLabel: 'Ajouter' });
  if (label === null) return;
  void act(workspaceId, () => navApi.addItem(workspaceId, { kind: 'link', url: url.trim(), label, sectionId }), 'Adresse invalide.');
}

function addPageFromPicker(workspaceId: string, sectionId: string | null) {
  openPagePicker({
    title: 'Ajouter un raccourci vers…',
    onPick: (target) => {
      if (target.kind !== 'page') return;
      void act(workspaceId, () => navApi.addItem(workspaceId, { kind: 'page', pageId: target.id, sectionId }), 'Impossible d’ajouter ce raccourci.');
    },
  });
}

async function newSection(workspaceId: string) {
  const name = await promptDialog({ title: 'Nouvelle section', label: 'Nom', placeholder: 'Ex. : Cadrage', confirmLabel: 'Créer' });
  if (name?.trim()) void act(workspaceId, () => navApi.addSection(workspaceId, name), 'Impossible de créer la section.');
}

export function useSidebarShortcuts(workspaceId: string) {
  return useQuery({ queryKey: nk.sidebar(workspaceId), queryFn: () => navApi.sidebar(workspaceId) });
}

const DRAG_TYPE = 'application/x-oriel-shortcut';

export function SidebarShortcuts() {
  const { workspaceId } = useWorkspaceCtx();
  const data = useSidebarShortcuts(workspaceId).data;
  const sections = data?.sections ?? [];
  const items = data?.items ?? [];
  const loose = items.filter((i) => i.sectionId === null);

  return (
    <>
      <ShortcutGroup section={null} items={loose} sections={sections} />
      {sections.map((s) => (
        <ShortcutGroup key={s.id} section={s} items={items.filter((i) => i.sectionId === s.id)} sections={sections} />
      ))}
    </>
  );
}

function ShortcutGroup({ section, items, sections }: { section: SidebarSection | null; items: SidebarItem[]; sections: SidebarSection[] }) {
  const { workspaceId } = useWorkspaceCtx();
  const [over, setOver] = useState(false);
  const title = section ? section.name : 'Raccourcis';
  const collapsed = !!section?.collapsed;
  const sectionId = section?.id ?? null;

  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setOver(false);
    if (!id) return;
    e.preventDefault();
    void act(workspaceId, () => navApi.updateItem(id, { sectionId, after: null }), 'Déplacement impossible.');
  };

  return (
    <section className="sidebar__section nav-shortcuts" aria-label={title}>
      <div
        className={`section-header${over ? ' is-drop-target' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {section ? (
          <button
            type="button"
            className="section-header__toggle"
            aria-expanded={!collapsed}
            onClick={() => void act(workspaceId, () => navApi.updateSection(section.id, { collapsed: !collapsed }), 'Action impossible.')}
          >
            <ChevronRight size={12} className={`section-header__chevron${collapsed ? '' : ' is-open'}`} />
            <span className="section-header__title">{title}</span>
          </button>
        ) : (
          <span className="section-header__title">{title}</span>
        )}
        <Menu position="bottom-end" width={230} withinPortal>
          <Menu.Target>
            <button type="button" className="icon-btn icon-btn--sm section-header__add" aria-label={`Ajouter dans ${title}`}>
              <Plus size={14} />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<FileText size={15} />} onClick={() => addPageFromPicker(workspaceId, sectionId)}>
              Raccourci vers une page…
            </Menu.Item>
            <Menu.Item leftSection={<Globe size={15} />} onClick={() => void addLinkShortcut(workspaceId, sectionId)}>
              Lien externe…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<FolderPlus size={15} />} onClick={() => void newSection(workspaceId)}>
              Nouvelle section…
            </Menu.Item>
            {section && (
              <>
                <Menu.Item
                  leftSection={<Pencil size={15} />}
                  onClick={async () => {
                    const name = await promptDialog({ title: 'Renommer la section', label: 'Nom', initialValue: section.name, confirmLabel: 'Renommer' });
                    if (name?.trim()) void act(workspaceId, () => navApi.updateSection(section.id, { name }), 'Action impossible.');
                  }}
                >
                  Renommer la section
                </Menu.Item>
                <MoveSectionItems section={section} sections={sections} />
                <Menu.Item
                  color="red"
                  leftSection={<Trash size={15} />}
                  onClick={() => void act(workspaceId, () => navApi.deleteSection(section.id), 'Action impossible.')}
                >
                  Supprimer la section (garde les raccourcis)
                </Menu.Item>
              </>
            )}
          </Menu.Dropdown>
        </Menu>
      </div>
      {!collapsed &&
        (items.length === 0 ? (
          section ? <div className="tree-empty">Glissez un raccourci ici.</div> : null
        ) : (
          <div role="group">
            {items.map((item, i) => (
              <ShortcutItem key={item.id} item={item} previous={items[i - 1]?.id ?? null} sections={sections} />
            ))}
          </div>
        ))}
    </section>
  );
}

function MoveSectionItems({ section, sections }: { section: SidebarSection; sections: SidebarSection[] }) {
  const { workspaceId } = useWorkspaceCtx();
  const i = sections.findIndex((s) => s.id === section.id);
  const up = i > 0 ? (i > 1 ? sections[i - 2]!.id : null) : undefined;
  const down = i < sections.length - 1 ? sections[i + 1]!.id : undefined;
  return (
    <>
      {up !== undefined && (
        <Menu.Item onClick={() => void act(workspaceId, () => navApi.updateSection(section.id, { after: up }), 'Action impossible.')}>Monter la section</Menu.Item>
      )}
      {down !== undefined && (
        <Menu.Item onClick={() => void act(workspaceId, () => navApi.updateSection(section.id, { after: down }), 'Action impossible.')}>Descendre la section</Menu.Item>
      )}
    </>
  );
}

function openView(workspaceId: string, databaseId: string, viewId: string, navigate: (to: string) => void) {
  // The full-page database remembers its active view in local storage (database module).
  storage.set(`oriel:db-view:${databaseId}`, viewId);
  navigate(pagePath(workspaceId, databaseId));
}

function ShortcutItem({ item, previous, sections }: { item: SidebarItem; previous: string | null; sections: SidebarSection[] }) {
  const { workspaceId } = useWorkspaceCtx();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const isDatabase = item.kind === 'page' && item.page?.kind === 'database';
  const label =
    item.kind === 'link' ? item.label : item.kind === 'view' ? `${pageTitle(item.page?.title)} · ${item.view?.name ?? ''}` : pageTitle(item.page?.title);
  const href = item.kind === 'link' ? safeWebUrl(item.url ?? '') : null;

  const activate = () => {
    if (item.kind === 'link') {
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    } else if (item.kind === 'view' && item.page && item.view) openView(workspaceId, item.page.id, item.view.id, navigate);
    else if (item.page) navigate(pagePath(workspaceId, item.page.id));
  };

  const entries = (): ContextMenuEntry[] => {
    const list: ContextMenuEntry[] = [];
    if (item.kind === 'link') {
      list.push({
        label: 'Modifier le lien…',
        icon: <Pencil size={15} />,
        onClick: async () => {
          const url = await promptDialog({ title: 'Modifier le lien', label: 'Adresse', initialValue: item.url ?? '', confirmLabel: 'Continuer' });
          if (url === null) return;
          const name = await promptDialog({ title: 'Nom du lien', label: 'Nom affiché', initialValue: item.label, confirmLabel: 'Enregistrer' });
          if (name === null) return;
          void act(workspaceId, () => navApi.updateItem(item.id, { url, label: name }), 'Adresse invalide.');
        },
      });
    } else {
      list.push({ label: 'Ouvrir dans un nouvel onglet', icon: <ExternalLink size={15} />, onClick: () => window.open(pagePath(workspaceId, item.page!.id), '_blank', 'noopener') });
    }
    for (const target of [null, ...sections.map((s) => s.id)]) {
      if (target === item.sectionId) continue;
      const name = target === null ? 'Raccourcis' : sections.find((s) => s.id === target)!.name;
      list.push({
        label: `Déplacer vers « ${name} »`,
        icon: <ArrowRightLeft size={15} />,
        onClick: () => void act(workspaceId, () => navApi.updateItem(item.id, { sectionId: target }), 'Déplacement impossible.'),
      });
    }
    list.push({ divider: true });
    list.push({ label: 'Retirer des raccourcis', icon: <Trash size={15} />, danger: true, onClick: () => void act(workspaceId, () => navApi.deleteItem(item.id), 'Action impossible.') });
    return list;
  };

  const showMenu = (e: ReactMouseEvent) => openContextMenu(e, entries());
  const ViewIcon = item.view ? (VIEW_ICONS as Record<string, typeof Globe>)[item.view.type] ?? FileText : null;

  return (
    <div className="tree-node">
      <div
        className={`tree-row nav-shortcut${dropping ? ' drop-after' : ''}`}
        role="treeitem"
        aria-expanded={isDatabase ? open : undefined}
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, item.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (!id || id === item.id) return;
          e.preventDefault();
          void act(workspaceId, () => navApi.updateItem(id, { sectionId: item.sectionId, after: item.id }), 'Déplacement impossible.');
        }}
        style={{ paddingLeft: 8 }}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter') activate();
          if (e.key === 'ArrowRight' && isDatabase) setOpen(true);
          if (e.key === 'ArrowLeft' && isDatabase) setOpen(false);
        }}
        onContextMenu={showMenu}
        data-previous={previous ?? undefined}
      >
        <button
          type="button"
          className={`tree-row__chevron${isDatabase ? '' : ' is-empty'}${open ? ' is-open' : ''}`}
          aria-label={open ? 'Replier' : 'Déplier'}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          <ChevronRight size={14} />
        </button>
        {item.kind === 'link' ? (
          <LinkIcon size={16} className="nav-shortcut__icon" aria-hidden />
        ) : ViewIcon ? (
          <ViewIcon size={16} className="nav-shortcut__icon" aria-hidden />
        ) : (
          <PageIcon icon={item.page?.icon ?? null} kind={item.page?.kind ?? 'page'} size={16} />
        )}
        <span className="tree-row__title">{label}</span>
        {item.kind === 'link' && <ExternalLink size={12} className="nav-shortcut__ext" aria-label="(nouvel onglet)" />}
        <span className="tree-row__actions" onClick={(e) => e.stopPropagation()}>
          <Tooltip label="Actions du raccourci" openDelay={500}>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Actions du raccourci" onClick={showMenu}>
              <Ellipsis size={15} />
            </button>
          </Tooltip>
        </span>
      </div>
      {open && isDatabase && item.page && <PinnedDatabase databaseId={item.page.id} />}
    </div>
  );
}

/** Views of a pinned database, then its rows, fetched only once unfolded. */
function PinnedDatabase({ databaseId }: { databaseId: string }) {
  const { workspaceId } = useWorkspaceCtx();
  const navigate = useNavigate();
  const db = useQuery({ queryKey: qk.database(databaseId), queryFn: () => api.databases.get(databaseId) });
  const [limit, setLimit] = useState(ROWS_PAGE);
  const rows = useQuery({
    queryKey: [...nk.sidebarRows(databaseId), limit],
    queryFn: () => navApi.sidebarRows(databaseId, 0, limit),
  });
  const views = db.data?.views ?? [];
  return (
    <div role="group" className="nav-pinned">
      {views.map((v) => {
        const Icon = (VIEW_ICONS as Record<string, typeof Globe>)[v.type] ?? FileText;
        return (
          <div key={v.id} className="tree-row" style={{ paddingLeft: 30 }} role="treeitem" tabIndex={0} onClick={() => openView(workspaceId, databaseId, v.id, navigate)} onKeyDown={(e) => e.key === 'Enter' && openView(workspaceId, databaseId, v.id, navigate)}>
            <Icon size={15} className="nav-shortcut__icon" aria-hidden />
            <span className="tree-row__title">{v.name}</span>
          </div>
        );
      })}
      {rows.isLoading ? (
        <div className="tree-row__none" style={{ paddingLeft: 30 }}>Chargement…</div>
      ) : (
        <>
          {(rows.data?.rows ?? []).map((r) => (
            <div key={r.id} className="tree-row nav-pinned__row" style={{ paddingLeft: 30 }} role="treeitem" tabIndex={0} onClick={() => navigate(pagePath(workspaceId, r.id))} onKeyDown={(e) => e.key === 'Enter' && navigate(pagePath(workspaceId, r.id))}>
              <PageIcon icon={r.icon} kind="page" size={15} />
              <span className="tree-row__title">{pageTitle(r.title)}</span>
            </div>
          ))}
          {(rows.data?.total ?? 0) > (rows.data?.rows.length ?? 0) && (
            <button type="button" className="link-button nav-pinned__more" style={{ paddingLeft: 30 }} onClick={() => setLimit((l) => l + ROWS_PAGE)}>
              Afficher plus de lignes ({rows.data!.total - rows.data!.rows.length} restantes)
            </button>
          )}
          {rows.data?.total === 0 && <div className="tree-row__none" style={{ paddingLeft: 30 }}>Aucune ligne</div>}
        </>
      )}
    </div>
  );
}
