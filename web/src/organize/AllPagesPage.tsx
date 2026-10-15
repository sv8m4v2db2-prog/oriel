// « Toutes les pages », tag pages and collection pages: one listing engine (server-side
// pagination, filters, grouping, sorting), list or grid layout, saved views, batch actions.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Menu, Popover, SegmentedControl, Select } from '@mantine/core';
import { ArrowDownAZ, ArrowUpAZ, Bookmark, Columns3, Filter, FolderInput, LayoutGrid, Layers, List, Pencil, Plus, Tag as TagIcon, Trash, X } from 'lucide-react';
import type {
  AllPagesViewConfig,
  PageFilter,
  PageGroupBy,
  PageProp,
  PageQuery,
  PageSort,
  PageSortField,
  SavedPagesView,
} from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { storage } from '../lib/store';
import { confirmDialog, openPagePicker, promptDialog, toast } from '../lib/ui';
import { useDocumentTitle } from '../lib/util';
import { EmptyState, ErrorState, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { orgApi, ok } from './api';
import { CollectionEditor } from './CollectionEditor';
import { emptyFilter, FilterEditor } from './FilterEditor';
import { invalidateOrg, useCollections, usePageProps, useTags } from './hooks';
import { BASE_COLUMNS, columnLabel, PageResults, type ResultsContext } from './PageResults';
import { TagChip, TagPicker } from './TagChip';
import './organize.css';

const DEFAULTS: AllPagesViewConfig = {
  layout: 'list',
  filter: emptyFilter(),
  group: 'none',
  sort: { field: 'updated', dir: 'desc' },
  columns: ['tags', 'updated'],
};
const PAGE = 50;

type Mode = 'all' | 'tag' | 'collection';

function loadState(workspaceId: string, key: string): AllPagesViewConfig {
  try {
    const raw = storage.getJSON<Partial<AllPagesViewConfig> | null>(`oriel:all-pages:${workspaceId}:${key}`, null);
    return raw ? { ...DEFAULTS, ...raw, filter: raw.filter ?? emptyFilter() } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const sortKey = (f: PageSortField) => (typeof f === 'string' ? f : `prop:${f.prop}`);
const groupKey = (g: PageGroupBy) => (typeof g === 'string' ? g : `prop:${g.prop}`);

export function AllPagesPage({ mode }: { mode: Mode }) {
  const { workspaceId, canEdit, workspace } = useWorkspaceCtx();
  const params = useParams();
  const navigate = useNavigate();
  const tagId = mode === 'tag' ? params.tagId : undefined;
  const collectionId = mode === 'collection' ? params.collectionId : undefined;
  const stateKey = mode === 'all' ? 'all' : `${mode}:${tagId ?? collectionId}`;

  const tags = useTags(workspaceId);
  const props = usePageProps(workspaceId);
  const collections = useCollections(workspaceId);
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId), staleTime: 60_000 });
  const views = useQuery({ queryKey: ok.views(workspaceId), queryFn: () => orgApi.views(workspaceId), select: (d) => d.views });

  const [state, setState] = useState<AllPagesViewConfig>(() => loadState(workspaceId, stateKey));
  const [viewId, setViewId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setState(loadState(workspaceId, stateKey));
    setViewId(null);
    setSelected(new Set());
  }, [workspaceId, stateKey]);
  useEffect(() => storage.setJSON(`oriel:all-pages:${workspaceId}:${stateKey}`, state), [workspaceId, stateKey, state]);
  const patch = (p: Partial<AllPagesViewConfig>) => {
    setState((s) => ({ ...s, ...p }));
    setSelected(new Set());
  };

  const tag = tags.data?.find((t) => t.id === tagId);
  const collection = collections.data?.find((c) => c.id === collectionId);
  const title = mode === 'tag' ? (tag ? `Tag : ${tag.name}` : 'Tag') : mode === 'collection' ? collection?.name ?? 'Collection' : 'Toutes les pages';
  useDocumentTitle(`${title} · ${workspace.name}`);

  const query: PageQuery = useMemo(() => {
    let filter: PageFilter | undefined = state.filter.conditions.length > 0 ? state.filter : undefined;
    if (mode === 'tag' && tagId) {
      filter = { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tagId] }, ...(state.filter.conditions ?? [])] };
    }
    const propIds = state.columns.filter((c) => c.startsWith('prop:')).map((c) => c.slice(5));
    return {
      ...(filter ? { filter } : {}),
      ...(collectionId ? { collectionId } : {}),
      group: state.group,
      sort: state.sort,
      propIds,
    };
  }, [state, mode, tagId, collectionId]);

  const list = useInfiniteQuery({
    queryKey: ok.list(workspaceId, query),
    queryFn: ({ pageParam }) => orgApi.query(workspaceId, { ...query, offset: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + PAGE : undefined),
    enabled: mode === 'all' || (mode === 'tag' && !!tagId) || (mode === 'collection' && !!collectionId),
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;

  const ctx: ResultsContext = useMemo(
    () => ({
      workspaceId,
      tags: new Map((tags.data ?? []).map((t) => [t.id, t] as const)),
      props: new Map((props.data ?? []).map((p) => [p.id, p] as const)),
      members: new Map((members.data ?? []).map((m) => [m.user.id, m] as const)),
    }),
    [workspaceId, tags.data, props.data, members.data],
  );

  const refreshAfterBatch = () => {
    setSelected(new Set());
    invalidateOrg('list', 'tags', 'preview');
    void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.trash(workspaceId) });
  };

  const applyTag = async (add: string[], remove: string[]) => {
    try {
      const r = await orgApi.applyTags(workspaceId, { pageIds: [...selected], add, remove });
      toast.success(`${r.changed} page${r.changed > 1 ? 's' : ''} modifiée${r.changed > 1 ? 's' : ''}${r.skipped ? ` · ${r.skipped} ignorée${r.skipped > 1 ? 's' : ''}` : ''}`);
    } catch (e) {
      toast.error(errorMessage(e, 'Action impossible.'));
    } finally {
      refreshAfterBatch();
    }
  };

  const trash = async () => {
    const n = selected.size;
    if (!(await confirmDialog({ title: `Mettre ${n} page${n > 1 ? 's' : ''} à la corbeille ?`, message: 'Les sous-pages suivent. Vous pourrez les restaurer.', confirmLabel: 'Mettre à la corbeille', danger: true }))) return;
    try {
      const r = await orgApi.batch(workspaceId, { action: 'trash', pageIds: [...selected] });
      toast.success(`${r.done.length} page${r.done.length > 1 ? 's' : ''} à la corbeille${r.failed.length ? ` · ${r.failed.length} refusée${r.failed.length > 1 ? 's' : ''}` : ''}`);
    } catch (e) {
      toast.error(errorMessage(e, 'Action impossible.'));
    } finally {
      refreshAfterBatch();
    }
  };

  const move = () => {
    const ids = [...selected];
    openPagePicker({
      title: `Déplacer ${ids.length} page${ids.length > 1 ? 's' : ''} vers…`,
      allowRoots: true,
      exclude: new Set(ids),
      onPick: (target) => {
        const dest =
          target.kind === 'root'
            ? ({ parentType: 'workspace', parentId: workspaceId, visibility: target.visibility } as const)
            : ({ parentType: 'page', parentId: target.id } as const);
        void (async () => {
          try {
            let r = await orgApi.batch(workspaceId, { action: 'move', pageIds: ids, ...dest });
            const needsConsent = r.failed.filter((f) => /accès|confirm/i.test(f.reason));
            if (needsConsent.length > 0 && (await confirmDialog({ title: 'Modifier l’accès à ces pages ?', message: `${needsConsent.length} page(s) changeront de lecteurs en arrivant à cette place.`, confirmLabel: 'Déplacer quand même' }))) {
              const again = await orgApi.batch(workspaceId, { action: 'move', pageIds: needsConsent.map((f) => f.id), ...dest, confirmAccess: true });
              r = { done: [...r.done, ...again.done], failed: [...r.failed.filter((f) => !needsConsent.includes(f)), ...again.failed] };
            }
            toast.success(`${r.done.length} page${r.done.length > 1 ? 's' : ''} déplacée${r.done.length > 1 ? 's' : ''}${r.failed.length ? ` · ${r.failed.length} refusée${r.failed.length > 1 ? 's' : ''}` : ''}`);
          } catch (e) {
            toast.error(errorMessage(e, 'Action impossible.'));
          } finally {
            refreshAfterBatch();
          }
        })();
      },
    });
  };

  const collectionAction = async (mode: 'include' | 'exclude', ids: string[]) => {
    if (!collectionId) return;
    try {
      await Promise.all(ids.map((id) => orgApi.setCollectionPage(collectionId, id, mode)));
    } catch (e) {
      toast.error(errorMessage(e, 'Action impossible.'));
    } finally {
      invalidateOrg('collections', 'list', 'preview');
      setSelected(new Set());
    }
  };

  const addByHand = () =>
    openPagePicker({
      title: 'Ajouter une page à la collection',
      includeRows: true,
      onPick: (target) => {
        if (target.kind === 'page') void collectionAction('include', [target.id]);
      },
    });

  // --- saved views ---------------------------------------------------------------
  const saveView = async () => {
    const name = await promptDialog({ title: 'Enregistrer la vue', label: 'Nom', placeholder: 'Ex. : Rushes à valider', confirmLabel: 'Enregistrer' });
    if (!name?.trim()) return;
    try {
      const v = await orgApi.createView(workspaceId, { name, config: state });
      setViewId(v.id);
      invalidateOrg('views');
    } catch (e) {
      toast.error(errorMessage(e, 'Enregistrement impossible.'));
    }
  };
  const updateView = async (v: SavedPagesView) => {
    try {
      await orgApi.updateView(v.id, { config: state });
      invalidateOrg('views');
      toast.success('Vue mise à jour');
    } catch (e) {
      toast.error(errorMessage(e, 'Mise à jour impossible.'));
    }
  };
  const shareView = async (v: SavedPagesView) => {
    try {
      await orgApi.updateView(v.id, { shared: !v.shared });
      invalidateOrg('views');
    } catch (e) {
      toast.error(errorMessage(e, 'Modification impossible.'));
    }
  };
  const deleteView = async (v: SavedPagesView) => {
    try {
      await orgApi.deleteView(v.id);
      if (viewId === v.id) setViewId(null);
      invalidateOrg('views');
    } catch (e) {
      toast.error(errorMessage(e, 'Suppression impossible.'));
    }
  };
  const activeView = views.data?.find((v) => v.id === viewId) ?? null;

  const propList: PageProp[] = props.data ?? [];
  const groupData = [
    { value: 'none', label: 'Aucun regroupement' },
    { value: 'tag', label: 'Par tag' },
    { value: 'author', label: 'Par créateur' },
    { value: 'created_month', label: 'Par mois de création' },
    { value: 'updated_month', label: 'Par mois de modification' },
    { value: 'type', label: 'Par type' },
    ...propList.filter((p) => p.type === 'select' || p.type === 'checkbox').map((p) => ({ value: `prop:${p.id}`, label: `Par ${p.name}` })),
  ];
  const sortData = [
    { value: 'title', label: 'Titre' },
    { value: 'created', label: 'Création' },
    { value: 'updated', label: 'Modification' },
    ...propList.map((p) => ({ value: `prop:${p.id}`, label: p.name })),
  ];
  const allColumns = [...BASE_COLUMNS.map((c) => c.id), ...propList.map((p) => `prop:${p.id}`)];
  const columns = state.columns.filter((c) => allColumns.includes(c));
  const activeFilters = state.filter.conditions.length;

  return (
    <>
      <TopBar>
        <span className="topbar__title">{title}</span>
      </TopBar>
      <div className="main-scroll">
        <div className="org-page">
          <div className="org-page__head">
            <h1 className="narrow-page__title org-page__title">
              {mode === 'tag' && tag ? <TagChip tag={tag} /> : title}
            </h1>
            {mode === 'collection' && canEdit && collection && (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Modifier la collection
              </button>
            )}
          </div>
          <p className="muted org-page__sub">
            {list.isLoading ? '' : `${total} page${total > 1 ? 's' : ''}`}
            {mode === 'collection' ? ' · résultat selon vos droits de lecture' : ''}
          </p>

          <div className="org-toolbar" role="toolbar" aria-label="Affichage">
            <SegmentedControl
              size="xs"
              aria-label="Mise en page"
              value={state.layout}
              onChange={(v) => patch({ layout: v === 'grid' ? 'grid' : 'list' })}
              data={[
                { value: 'list', label: <span className="org-seg"><List size={13} /> Liste</span> },
                { value: 'grid', label: <span className="org-seg"><LayoutGrid size={13} /> Grille</span> },
              ]}
            />
            <button type="button" className={`btn${showFilters || activeFilters ? ' is-active' : ''}`} onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
              <Filter size={14} /> Filtres{activeFilters ? ` (${activeFilters})` : ''}
            </button>
            <Select
              size="xs"
              w={190}
              leftSection={<Layers size={13} />}
              aria-label="Regroupement"
              allowDeselect={false}
              data={groupData}
              value={groupKey(state.group)}
              onChange={(v) => patch({ group: !v || v === 'none' ? 'none' : v.startsWith('prop:') ? { prop: v.slice(5) } : (v as PageGroupBy) })}
            />
            <Select
              size="xs"
              w={150}
              aria-label="Trier par"
              allowDeselect={false}
              data={sortData}
              value={sortKey(state.sort.field)}
              onChange={(v) => v && patch({ sort: { ...state.sort, field: v.startsWith('prop:') ? { prop: v.slice(5) } : (v as PageSort['field']) } })}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={state.sort.dir === 'asc' ? 'Ordre croissant' : 'Ordre décroissant'}
              title={state.sort.dir === 'asc' ? 'Ordre croissant' : 'Ordre décroissant'}
              onClick={() => patch({ sort: { ...state.sort, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' } })}
            >
              {state.sort.dir === 'asc' ? <ArrowUpAZ size={16} /> : <ArrowDownAZ size={16} />}
            </button>
            <Popover position="bottom-end" shadow="md" withinPortal width={230}>
              <Popover.Target>
                <button type="button" className="btn">
                  <Columns3 size={14} /> Colonnes
                </button>
              </Popover.Target>
              <Popover.Dropdown p={8}>
                {allColumns.map((c) => (
                  <label className="org-check" key={c}>
                    <input
                      type="checkbox"
                      checked={state.columns.includes(c)}
                      onChange={(e) => patch({ columns: e.target.checked ? [...state.columns, c] : state.columns.filter((x) => x !== c) })}
                    />
                    {columnLabel(c, ctx)}
                  </label>
                ))}
              </Popover.Dropdown>
            </Popover>
            <span className="org-toolbar__spacer" />
            <Menu position="bottom-end" withinPortal shadow="md" width={250}>
              <Menu.Target>
                <button type="button" className="btn">
                  <Bookmark size={14} /> {activeView ? activeView.name : 'Vues'}
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                {(views.data ?? []).map((v) => (
                  <Menu.Item
                    key={v.id}
                    onClick={() => {
                      setState({ ...DEFAULTS, ...v.config });
                      setViewId(v.id);
                      setSelected(new Set());
                    }}
                  >
                    {v.name} {v.shared ? <span className="muted">· partagée</span> : null}
                  </Menu.Item>
                ))}
                {(views.data ?? []).length === 0 && <Menu.Label>Aucune vue enregistrée</Menu.Label>}
                <Menu.Divider />
                <Menu.Item leftSection={<Plus size={14} />} onClick={() => void saveView()}>
                  Enregistrer la vue actuelle…
                </Menu.Item>
                {activeView?.mine && <Menu.Item onClick={() => void updateView(activeView)}>Mettre à jour « {activeView.name} »</Menu.Item>}
                {activeView?.mine && <Menu.Item onClick={() => void shareView(activeView)}>{activeView.shared ? 'Ne plus partager' : 'Partager avec l’espace'}</Menu.Item>}
                {activeView?.mine && (
                  <Menu.Item color="red" onClick={() => void deleteView(activeView)}>
                    Supprimer la vue
                  </Menu.Item>
                )}
                {activeView && (
                  <Menu.Item
                    onClick={() => {
                      setState(DEFAULTS);
                      setViewId(null);
                    }}
                  >
                    Revenir à l’affichage par défaut
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          </div>

          {showFilters && (
            <div className="org-panel">
              <FilterEditor
                workspaceId={workspaceId}
                value={state.filter}
                onChange={(filter) => patch({ filter })}
                tags={tags.data ?? []}
                props={propList}
                allowMatch={mode !== 'tag'}
              />
            </div>
          )}

          {selected.size > 0 && (
            <div className="org-batch" role="region" aria-label="Actions sur la sélection">
              <strong>
                {selected.size} sélectionnée{selected.size > 1 ? 's' : ''}
              </strong>
              {canEdit && (
                <>
                  <Popover position="bottom-start" shadow="md" withinPortal width={260}>
                    <Popover.Target>
                      <button type="button" className="btn">
                        <TagIcon size={14} /> Ajouter un tag
                      </button>
                    </Popover.Target>
                    <Popover.Dropdown p={6}>
                      <TagPicker workspaceId={workspaceId} tags={tags.data ?? []} selected={new Set()} canCreate onToggle={(id) => void applyTag([id], [])} />
                    </Popover.Dropdown>
                  </Popover>
                  <Popover position="bottom-start" shadow="md" withinPortal width={260}>
                    <Popover.Target>
                      <button type="button" className="btn">
                        <X size={14} /> Retirer un tag
                      </button>
                    </Popover.Target>
                    <Popover.Dropdown p={6}>
                      <TagPicker workspaceId={workspaceId} tags={tags.data ?? []} selected={new Set()} canCreate={false} onToggle={(id) => void applyTag([], [id])} />
                    </Popover.Dropdown>
                  </Popover>
                  <button type="button" className="btn" onClick={move}>
                    <FolderInput size={14} /> Déplacer…
                  </button>
                  {mode === 'collection' && (
                    <button type="button" className="btn" onClick={() => void collectionAction('exclude', [...selected])}>
                      Exclure de la collection
                    </button>
                  )}
                  <button type="button" className="btn btn--danger" onClick={() => void trash()}>
                    <Trash size={14} /> Corbeille
                  </button>
                </>
              )}
              <button type="button" className="btn" onClick={() => setSelected(new Set())}>
                Désélectionner
              </button>
            </div>
          )}

          {mode === 'collection' && canEdit && selected.size === 0 && (
            <div className="org-page__actions">
              <button type="button" className="btn" onClick={addByHand}>
                <Plus size={14} /> Ajouter une page à la main
              </button>
            </div>
          )}

          {list.isLoading ? (
            <div className="list-skeleton">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={34} radius={6} />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState onRetry={() => void list.refetch()} message={errorMessage(list.error, 'Impossible de charger les pages.')} />
          ) : items.length === 0 ? (
            <EmptyState icon={<Layers size={26} />} title="Aucune page">
              {activeFilters || mode !== 'all' ? 'Aucune page visible ne correspond à ces critères.' : 'Les pages que vous pouvez lire apparaîtront ici.'}
            </EmptyState>
          ) : (
            <>
              <PageResults
                items={items}
                layout={state.layout}
                columns={columns}
                group={state.group}
                ctx={ctx}
                selected={selected}
                onToggle={(id, on) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (on) n.add(id);
                    else n.delete(id);
                    return n;
                  })
                }
                onToggleAll={(on) => setSelected(on ? new Set(items.map((i) => i.id)) : new Set())}
              />
              {list.hasNextPage && (
                <div className="org-more">
                  <button type="button" className="btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? 'Chargement…' : `Afficher plus (${items.length} sur ${total})`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {editing && collection && (
        <CollectionEditor
          workspaceId={workspaceId}
          collection={collection}
          onClose={() => setEditing(false)}
          onDeleted={() => {
            setEditing(false);
            navigate(`/w/${workspaceId}/all-pages`);
          }}
        />
      )}
    </>
  );
}
