// <DatabaseView>: data, active view state, derived rows, tabs + toolbar + layout.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CircleAlert, Maximize2, X } from 'lucide-react';
import type { Page, PropertyDef, TemplateRecurrenceInfo, View, ViewConfig } from '@oriel/shared';
import { shortId, sortByPosition } from '@oriel/shared';
import { navigation } from '../../lib/navigation';
import { useSession } from '../../lib/session';
import { DbProvider, useDb, type DbContextValue } from '../context';
import {
  errorMessage,
  mergeUsers,
  useDatabaseQuery,
  useDbMutations,
  useMembersQuery,
  useRelatedData,
  useRowsQuery,
  useTemplatesQuery,
} from '../data';
import { defaultRule } from '../logic/filter';
import { valuesForNewRow } from '../logic/newRow';
import { effectiveTemplateId } from '../logic/viewOrder';
import { deriveRows } from '../logic/pipeline';
import { createRowContext, propertyKind, schemaReadsClock, TIME_BUCKET_MS, type ValueKind } from '../logic/values';
import { normalizeConfig, orderedProperties, visibleProperties } from '../logic/viewConfig';
import { BoardView } from '../layouts/BoardView';
import { CalendarView } from '../layouts/CalendarView';
import { GalleryView, ListView } from '../layouts/ListGalleryViews';
import { TableView } from '../layouts/TableView';
import { TimelineView } from '../layouts/TimelineView';
import { ChartView } from '../layouts/ChartView';
import { DashboardView } from '../layouts/DashboardView';
import { FeedView } from '../layouts/FeedView';
import { FormView } from '../layouts/FormView';
import { MapView } from '../layouts/MapView';
import { CommitInput, cx, IconBtn } from '../ui/primitives';
import { Toolbar, type ToolbarMenu } from './Toolbar';
import type { NewRowRequest, ViewState } from './types';
import { ViewTabs } from './ViewTabs';

const EMPTY_PROPS: PropertyDef[] = [];
const EMPTY_ROWS: Page[] = [];
const EMPTY_RECURRENCES: TemplateRecurrenceInfo[] = [];

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Clock of a view: changes every TIME_BUCKET_MS when formulas read now(), else at midnight (filters
 * relative to today). The row context is rebuilt on each change, so every cell and filter follows.
 */
function useViewClock(everyMinute: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = new Date();
      const next = everyMinute
        ? (Math.floor(now.getTime() / TIME_BUCKET_MS) + 1) * TIME_BUCKET_MS
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      timer = setTimeout(() => {
        setTick((t) => t + 1);
        schedule();
      }, next - now.getTime() + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [everyMinute]);
  return tick;
}

/** Width of an element (callback ref), tracked with a ResizeObserver. */
function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    setWidth(el.getBoundingClientRect().width || 1000);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

export interface DatabaseRootProps {
  databaseId: string;
  inline?: boolean;
  readOnly?: boolean;
  publicMode?: boolean;
  /** Linked database block: its own views (rows and schema are the source database's). */
  linkId?: string;
  /** I1: page whose content shows the block (« cette page »). */
  hostPageId?: string;
}

export function DatabaseRoot({ databaseId, inline = false, readOnly = false, publicMode = false, linkId, hostPageId }: DatabaseRootProps) {
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((message: string) => setError(message), []);
  const dbQ = useDatabaseQuery(databaseId, publicMode, true, linkId);
  const rowsQ = useRowsQuery(databaseId, publicMode);
  const data = dbQ.data;
  const workspaceId = data?.page.workspaceId ?? data?.schema.workspaceId ?? '';
  const canEdit = !!data?.canEdit && !readOnly && !publicMode;
  const membersQ = useMembersQuery(workspaceId, !publicMode && !!data);
  const properties = data?.schema.properties ?? EMPTY_PROPS;
  const users = useMemo(() => mergeUsers(membersQ.data, rowsQ.data?.users), [membersQ.data, rowsQ.data?.users]);
  const { pages: related, resolver, loaded: relatedLoaded } = useRelatedData(data ? properties : undefined, publicMode, users);
  const m = useDbMutations(databaseId, reportError, { linkId });
  const { ref: rootRef, width } = useElementWidth<HTMLDivElement>();

  const members = useMemo(() => (membersQ.data ?? []).map((mb) => mb.user), [membersQ.data]);
  const relationTitle = useCallback((id: string) => related.get(id)?.title, [related]);
  // « Moi » in the people filters; undefined in public views.
  const currentUserId = useSession().data?.user.id;
  const clock = useViewClock(useMemo(() => schemaReadsClock(properties, resolver), [properties, resolver]));
  const ctx = useMemo(
    () => createRowContext(properties, { users, relationTitle, related: resolver, currentUserId: publicMode ? undefined : currentUserId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [properties, users, relationTitle, resolver, currentUserId, publicMode, clock],
  );

  const dbValue = useMemo<DbContextValue | null>(
    () =>
      data
        ? {
            databaseId,
            workspaceId,
            page: data.page,
            properties,
            members,
            ctx,
            canEdit,
            publicMode,
            m,
            related,
            relatedLoaded,
            reportError,
            linkId,
            hostPageId,
          }
        : null,
    [data, databaseId, workspaceId, properties, members, ctx, canEdit, publicMode, m, related, relatedLoaded, reportError, linkId, hostPageId],
  );

  if (dbQ.isLoading) {
    return (
      <div className={cx('ordb-root', inline && 'is-inline')} aria-busy="true">
        <div className="ordb-skeleton" />
        <div className="ordb-skeleton is-short" />
        <div className="ordb-skeleton" />
      </div>
    );
  }
  if (!data || !dbValue) {
    return (
      <div className={cx('ordb-root', inline && 'is-inline')}>
        <div className="ordb-error" role="alert">
          <CircleAlert size={15} />
          <span>
            Impossible d'afficher cette base de données
            {dbQ.error ? ` (${errorMessage(dbQ.error)})` : ''}. Elle a peut-être été supprimée, ou vous n'y avez pas accès.
          </span>
        </div>
      </div>
    );
  }

  return (
    <DbProvider value={dbValue}>
      <div ref={rootRef} className={cx('ordb-root', inline && 'is-inline', !canEdit && 'is-readonly')}>
        <DatabaseBody
          views={data.views}
          rows={rowsQ.data?.rows ?? EMPTY_ROWS}
          rowsLoading={rowsQ.isLoading}
          inline={inline}
          compact={inline || width < 720}
          error={error}
          clearError={() => setError(null)}
        />
      </div>
    </DbProvider>
  );
}

function InlineTitle() {
  const { page, canEdit, m, databaseId, linkId } = useDb();
  return (
    <div className={cx('ordb-inline-head', linkId && 'is-linked')}>
      {linkId && (
        <span className="ordb-linked-badge" title="Vue liée : les lignes et les propriétés sont celles de la base d'origine">
          <ArrowUpRight size={13} />
        </span>
      )}
      {page?.icon && <span className="ordb-emoji ordb-inline-icon">{page.icon}</span>}
      {canEdit ? (
        <CommitInput
          className="ordb-inline-title"
          value={page?.title ?? ''}
          placeholder="Base sans titre"
          ariaLabel="Titre de la base de données"
          onCommit={(title) => void m.updateDatabasePage({ title })}
        />
      ) : (
        <span className="ordb-inline-title is-static">{page?.title || 'Base sans titre'}</span>
      )}
      <IconBtn label="Ouvrir en pleine page" onClick={() => navigation.openPage(databaseId)} className="ordb-inline-open">
        <Maximize2 size={14} />
      </IconBtn>
    </div>
  );
}

function DatabaseBody({
  views: rawViews,
  rows,
  rowsLoading,
  inline,
  compact,
  error,
  clearError,
}: {
  views: View[];
  rows: Page[];
  rowsLoading: boolean;
  inline: boolean;
  compact: boolean;
  error: string | null;
  clearError: () => void;
}) {
  const { databaseId, properties, ctx, canEdit, m, publicMode, linkId } = useDb();
  const views = useMemo(() => sortByPosition(rawViews), [rawViews]);
  const storageKey = `oriel:db-view:${databaseId}${linkId ? `:${linkId}` : ''}`;
  const [activeId, setActiveId] = useState<string | null>(() => storageGet(storageKey));
  const view = views.find((v) => v.id === activeId) ?? views[0];
  const activate = useCallback(
    (id: string) => {
      setActiveId(id);
      storageSet(storageKey, id);
    },
    [storageKey],
  );

  const [overrides, setOverrides] = useState<Record<string, Partial<ViewConfig>>>({});
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [keepIds, setKeepIds] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<ToolbarMenu>(null);
  const [editTitleOf, setEditTitleOf] = useState<string | null>(null);
  const templatesQ = useTemplatesQuery(databaseId, canEdit);
  const templates = templatesQ.data?.rows ?? EMPTY_ROWS;
  const databaseDefaultTemplateId = templatesQ.data?.defaultTemplateId ?? null;
  const recurrences = templatesQ.data?.recurrences ?? EMPTY_RECURRENCES;

  useEffect(() => {
    setKeepIds(new Set());
    setMenu(null);
  }, [view?.id]);

  const viewId = view?.id ?? '';
  const viewType = view?.type ?? 'table';
  const config = useMemo(
    () => normalizeConfig({ ...(view?.config ?? {}), ...(overrides[viewId] ?? {}) }, viewType, properties),
    [view?.config, overrides, viewId, viewType, properties],
  );

  const setConfig = useCallback(
    (patch: Partial<ViewConfig>) => {
      if (!viewId) return;
      if (canEdit) void m.updateView(viewId, { config: patch });
      else setOverrides((o) => ({ ...o, [viewId]: { ...(o[viewId] ?? {}), ...patch } }));
    },
    [canEdit, m, viewId],
  );

  // I1: the view's own manual order (a sort of the view takes precedence).
  const rowOrder = view?.rowOrder;
  const derived = useMemo(
    () => deriveRows(rows, config, ctx, { search: deferredSearch, keepIds, rowOrder }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, config.filter, config.sorts, ctx, deferredSearch, keepIds, rowOrder],
  );
  const defaultTemplateId = effectiveTemplateId(config.defaultTemplateId, databaseDefaultTemplateId, templates);
  const moveRow = useCallback(
    (id: string, after: string | null) => {
      if (canEdit && viewId) void m.moveRowInView(viewId, id, after);
    },
    [canEdit, m, viewId],
  );
  const kinds = useMemo(() => {
    const map = new Map<string, ValueKind>();
    for (const p of properties) map.set(p.id, propertyKind(p, rows, ctx));
    return map;
  }, [properties, rows, ctx]);
  const orderedProps = useMemo(() => orderedProperties(config, properties), [config, properties]);
  const visibleProps = useMemo(() => visibleProperties(config, properties), [config, properties]);
  const manualOrder = config.sorts.filter((s) => properties.some((p) => p.id === s.propertyId)).length === 0;

  const createRow = useCallback(
    (req?: NewRowRequest, opts?: { open?: boolean }) => {
      if (!canEdit) return null;
      const fromFilter = valuesForNewRow(config.filter, ctx);
      const props = { ...fromFilter.properties, ...(req?.properties ?? {}) };
      const title = req?.title ?? fromFilter.title;
      const wanted = req?.templateId === null ? null : (req?.templateId ?? defaultTemplateId);
      const template = wanted ? templates.find((t) => t.id === wanted) : undefined;
      const { id, done } = m.createRow({
        title,
        properties: Object.keys(props).length ? props : undefined,
        after: req?.after,
        templateId: template?.id,
        template,
      });
      setKeepIds((s) => new Set(s).add(id));
      // The side panel reads the row from the server: open it once the row exists.
      if (opts?.open) void done.then((page) => page && navigation.openPeek(id));
      else if (!template && (!req || req.templateId === null) && viewType === 'table') setEditTitleOf(id);
      return id;
    },
    [canEdit, config.filter, ctx, m, viewType, templates, defaultTemplateId],
  );

  const filterOnProperty = useCallback(
    (propertyId: string) => {
      const p = properties.find((x) => x.id === propertyId);
      if (!p) return;
      const rule = defaultRule(shortId(8), p, kinds.get(p.id) ?? 'text');
      setConfig({
        filter: { ...config.filter, conjunction: config.filter?.conjunction ?? 'and', rules: [...(config.filter?.rules ?? []), rule] },
      });
      setMenu('filter');
    },
    [properties, kinds, setConfig, config.filter],
  );

  const clearEditTitle = useCallback(() => setEditTitleOf(null), []);

  if (!view) {
    return (
      <div className="ordb-error" role="alert">
        <CircleAlert size={15} /> Cette base n'a aucune vue.
        {canEdit && (
          <button type="button" className="ordb-btn is-primary is-sm" onClick={() => void m.createView('Tableau', 'table')}>
            Créer une vue Tableau
          </button>
        )}
      </div>
    );
  }

  const vs: ViewState = {
    view,
    config,
    setConfig,
    rows: derived,
    totalRows: rows.length,
    allRows: rows,
    orderedProps,
    visibleProps,
    kinds,
    manualOrder,
    createRow,
    filterOnProperty,
    editTitleOf,
    clearEditTitle,
    templates,
    defaultTemplateId,
    databaseDefaultTemplateId,
    recurrences,
    moveRow,
  };

  let layout;
  switch (view.type) {
    case 'board':
      layout = <BoardView vs={vs} />;
      break;
    case 'list':
      layout = <ListView vs={vs} />;
      break;
    case 'gallery':
      layout = <GalleryView vs={vs} />;
      break;
    case 'calendar':
      layout = <CalendarView vs={vs} />;
      break;
    case 'timeline':
      layout = <TimelineView vs={vs} />;
      break;
    // A1 : fil d'actualité, graphiques, tableau de bord.
    case 'feed':
      layout = <FeedView vs={vs} />;
      break;
    case 'chart_bar':
    case 'chart_hbar':
    case 'chart_line':
    case 'chart_donut':
    case 'chart_number':
      layout = <ChartView vs={vs} />;
      break;
    case 'dashboard':
      layout = <DashboardView vs={vs} />;
      break;
    // A2 : carte et formulaire.
    case 'map':
      layout = <MapView vs={vs} />;
      break;
    case 'form':
      layout = <FormView vs={vs} />;
      break;
    default:
      layout = <TableView vs={vs} />;
  }

  return (
    <>
      {inline && <InlineTitle />}
      <div className="ordb-topbar">
        <ViewTabs views={views} activeId={view.id} onActivate={activate} />
        <Toolbar
          vs={vs}
          search={search}
          onSearch={setSearch}
          menu={menu}
          setMenu={setMenu}
          compact={compact}
          unfilteredRows={rows}
        />
      </div>
      {!canEdit && !publicMode && Object.keys(overrides[view.id] ?? {}).length > 0 && (
        <div className="ordb-notice">Vos réglages de vue (filtres, tris…) ne sont pas enregistrés : vous êtes en lecture seule.</div>
      )}
      {error && (
        <div className="ordb-error" role="alert">
          <CircleAlert size={15} />
          <span>Modification impossible : {error}</span>
          <IconBtn label="Fermer" onClick={clearError}>
            <X size={14} />
          </IconBtn>
        </div>
      )}
      <div className={cx('ordb-view', `is-${view.type}`)} aria-busy={rowsLoading}>
        {rowsLoading ? (
          <>
            <div className="ordb-skeleton" />
            <div className="ordb-skeleton is-short" />
          </>
        ) : (
          layout
        )}
      </div>
    </>
  );
}
