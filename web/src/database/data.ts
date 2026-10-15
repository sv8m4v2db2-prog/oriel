// Data layer of the database module: queries (keys from lib/queryKeys) and mutations with
// optimistic cache updates, settled by invalidation once no mutation is pending anymore.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  DatabaseResponse,
  DatabaseSchema,
  DeletePropertyMirrorMode,
  FileValue,
  ImportRowsRequest,
  ImportRowsResponse,
  Member,
  Page,
  PageDetailResponse,
  PropertyDef,
  PropertyValue,
  PublicUser,
  RowsResponse,
  SessionResponse,
  TemplateRecurrence,
  TemplatesResponse,
  TwoWayRelationRequest,
  UpdatePageRequest,
  UpdatePropertyRequest,
  View,
  ViewConfig,
  ViewType,
} from '@oriel/shared';
import { newId, positionForInsert, renameFormulaReferences, shortId, sortByPosition } from '@oriel/shared';
import { api, ApiError } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { createRowContext, type RelatedResolver, type RowContext } from './logic/values';
import { moveInViewOrder } from './logic/viewOrder';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function databaseKey(databaseId: string, publicMode: boolean, linkId?: string) {
  const base = publicMode ? qk.publicDatabase(databaseId) : qk.database(databaseId);
  // Linked block views: under the database key, so that database/view invalidations reach them.
  return linkId ? ([...base, 'link', linkId] as const) : base;
}
/** Row templates of a database (under the rows key: row changes refresh them). */
export function templatesKey(databaseId: string) {
  return [...qk.rows(databaseId), 'templates'] as const;
}
export function rowsKey(databaseId: string, publicMode: boolean) {
  return publicMode ? qk.publicRows(databaseId) : qk.rows(databaseId);
}

export function useDatabaseQuery(databaseId: string, publicMode: boolean, enabled = true, linkId?: string) {
  return useQuery<DatabaseResponse>({
    queryKey: databaseKey(databaseId, publicMode, linkId),
    queryFn: () => (publicMode ? api.public.database(databaseId, linkId) : api.databases.get(databaseId, linkId)),
    enabled: enabled && !!databaseId,
    retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
}

export function useRowsQuery(databaseId: string, publicMode: boolean, enabled = true) {
  return useQuery<RowsResponse>({
    queryKey: rowsKey(databaseId, publicMode),
    queryFn: () => (publicMode ? api.public.rows(databaseId) : api.databases.rows(databaseId)),
    enabled: enabled && !!databaseId,
    retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
}

export function useMembersQuery(workspaceId: string | undefined, enabled: boolean) {
  return useQuery<Member[]>({
    queryKey: qk.members(workspaceId ?? ''),
    queryFn: () => api.workspaces.members(workspaceId!),
    enabled: enabled && !!workspaceId,
    staleTime: 60_000,
  });
}

export function useTemplatesQuery(databaseId: string, enabled = true) {
  return useQuery<TemplatesResponse>({
    queryKey: templatesKey(databaseId),
    queryFn: () => api.databases.templates(databaseId),
    enabled: enabled && !!databaseId,
    staleTime: 30_000,
    retry: false,
  });
}

export interface RelatedPage {
  id: string;
  title: string;
  icon: string | null;
}

export interface RelatedData {
  /** Pages of the related databases (relation chips, titles). */
  pages: Map<string, RelatedPage>;
  /** Rows and schemas of related databases, for rollups. */
  resolver: RelatedResolver;
  /**
   * Related databases whose rows are loaded: an id of such a database missing from `pages` is a
   * trashed row (latent link of a two-way relation, restored with it) and is not displayed.
   */
  loaded: ReadonlySet<string>;
}

const relationTargets = (properties: PropertyDef[] | undefined): string[] => {
  const set = new Set<string>();
  for (const p of properties ?? []) if (p.type === 'relation' && p.relation?.databaseId) set.add(p.relation.databaseId);
  return [...set];
};

/** Whether formulas of a schema read properties of related pages (page.prop("…"), I2). */
const PAGE_PROP = /\.\s*prop\s*\(/;
const readsPages = (properties: PropertyDef[] | undefined): boolean =>
  !!properties?.some((p) => p.type === 'formula' && PAGE_PROP.test(p.formula ?? ''));

/**
 * Relation targets whose schema is needed: those used by the rollups of a schema, and all of them when
 * its formulas read related pages (or `followRelations`: a formula above walks several levels).
 */
const rollupTargets = (properties: PropertyDef[] | undefined, followRelations = false): string[] => {
  const set = new Set<string>();
  for (const p of properties ?? []) {
    if (p.type !== 'rollup' || !p.rollup) continue;
    const rel = properties?.find((x) => x.id === p.rollup!.relationPropertyId);
    if (rel?.relation?.databaseId) set.add(rel.relation.databaseId);
  }
  if (followRelations || readsPages(properties)) for (const t of relationTargets(properties)) set.add(t);
  return [...set];
};

const MAX_RELATED_DATABASES = 16;

/**
 * Rows of every database targeted by a relation property (titles, icons) and, for rollups, the
 * schemas of the targets of rollups — followed transitively for rollups of rollups.
 */
export function useRelatedData(properties: PropertyDef[] | undefined, publicMode: boolean, users: PublicUser[] = []): RelatedData {
  const direct = useMemo(() => relationTargets(properties), [properties]);
  const directSchemas = useMemo(() => rollupTargets(properties), [properties]);
  const [nested, setNested] = useState<string[]>([]);
  const schemaIds = useMemo(() => [...new Set([...directSchemas, ...nested])].sort().slice(0, MAX_RELATED_DATABASES), [directSchemas, nested]);
  const rowIds = useMemo(() => [...new Set([...direct, ...schemaIds])].sort().slice(0, MAX_RELATED_DATABASES), [direct, schemaIds]);
  const rowResults = useQueries({
    queries: rowIds.map((t) => ({
      queryKey: rowsKey(t, publicMode),
      queryFn: () => (publicMode ? api.public.rows(t) : api.databases.rows(t)),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const schemaResults = useQueries({
    queries: schemaIds.map((t) => ({
      queryKey: databaseKey(t, publicMode),
      queryFn: () => (publicMode ? api.public.database(t) : api.databases.get(t)),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const stamp =
    rowIds.join(',') +
    '|' +
    rowResults.map((r) => r.dataUpdatedAt).join(',') +
    '|' +
    schemaIds.join(',') +
    '|' +
    schemaResults.map((r) => r.dataUpdatedAt).join(',') +
    '|' +
    users.length;

  // Rollups whose target is itself a rollup, and formulas walking relations, need the next level of related databases.
  useEffect(() => {
    const next = new Set(nested);
    const walksPages = readsPages(properties);
    for (const r of schemaResults) for (const t of rollupTargets(r.data?.schema.properties, walksPages)) next.add(t);
    for (const t of directSchemas) next.delete(t);
    if (next.size !== nested.length) setNested([...next].sort());
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // `rowResults` / `schemaResults` are read inside the memo: it is recomputed whenever data changes.
  return useMemo(() => {
    const pages = new Map<string, RelatedPage>();
    const rowById = new Map<string, Page>();
    const allUsers = new Map<string, PublicUser>();
    for (const u of users) allUsers.set(u.id, u);
    for (const res of rowResults) {
      for (const r of res.data?.rows ?? []) {
        pages.set(r.id, { id: r.id, title: r.title, icon: r.icon });
        rowById.set(r.id, r);
      }
      for (const u of res.data?.users ?? []) if (!allUsers.has(u.id)) allUsers.set(u.id, u);
    }
    const schemas = new Map<string, PropertyDef[]>();
    schemaIds.forEach((id, i) => {
      const props = schemaResults[i]?.data?.schema.properties;
      if (props) schemas.set(id, props);
    });
    const contexts = new Map<string, RowContext>();
    const resolver: RelatedResolver = {
      row: (id) => rowById.get(id),
      context: (databaseId) => {
        const cached = contexts.get(databaseId);
        if (cached) return cached;
        const props = schemas.get(databaseId);
        if (!props) return undefined;
        const c = createRowContext(props, { users: allUsers.values(), relationTitle: (id) => pages.get(id)?.title, related: resolver });
        contexts.set(databaseId, c);
        return c;
      },
    };
    const loaded = new Set(rowIds.filter((_, i) => rowResults[i]?.isSuccess));
    return { pages, resolver, loaded };
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Rows of every database targeted by a relation property, indexed by page id. */
export function useRelatedPages(properties: PropertyDef[] | undefined, publicMode: boolean): Map<string, RelatedPage> {
  return useRelatedData(properties, publicMode).pages;
}

/** Runs `fn` over `items` with at most `limit` concurrent promises. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Optimistic mutation runner
// ---------------------------------------------------------------------------

const pendingByScope = new Map<string, number>();
/** Rows whose creation request is still in flight: later writes on them wait for it. */
const pendingCreates = new Map<string, Promise<unknown>>();
const afterCreate = (id: string) => pendingCreates.get(id) ?? Promise.resolve();

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Une erreur inattendue est survenue.';
}

interface RunOptions<T> {
  /** Cache entries touched optimistically (snapshotted, rolled back on error, invalidated at the end). */
  keys: QueryKey[];
  apply?: () => void;
  request: () => Promise<T>;
  onSuccess?: (result: T) => void;
  /** Extra keys to invalidate when settled. */
  invalidate?: QueryKey[];
}

function useRunner(scope: string, onError: (message: string) => void) {
  const qc = useQueryClient();
  return useCallback(
    async function run<T>(opts: RunOptions<T>): Promise<T | undefined> {
      pendingByScope.set(scope, (pendingByScope.get(scope) ?? 0) + 1);
      // Prevent in-flight refetches from overwriting (or reverting) the optimistic state.
      await Promise.all(opts.keys.map((k) => qc.cancelQueries({ queryKey: k, exact: true })));
      const snapshots = opts.keys.map((k) => [k, qc.getQueryData(k)] as const);
      opts.apply?.();
      try {
        const result = await opts.request();
        opts.onSuccess?.(result);
        return result;
      } catch (err) {
        for (const [k, data] of snapshots) qc.setQueryData(k, data);
        onError(errorMessage(err));
        return undefined;
      } finally {
        const left = (pendingByScope.get(scope) ?? 1) - 1;
        pendingByScope.set(scope, left);
        if (left <= 0) {
          for (const k of [...opts.keys, ...(opts.invalidate ?? [])]) void qc.invalidateQueries({ queryKey: k, exact: true });
        }
      }
    },
    [qc, scope, onError],
  );
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function patchRowsCache(qc: QueryClient, databaseId: string, fn: (rows: Page[]) => Page[]) {
  qc.setQueryData<RowsResponse>(qk.rows(databaseId), (old) => (old ? { ...old, rows: fn(old.rows) } : old));
}

function patchDatabaseCache(qc: QueryClient, key: QueryKey, fn: (d: DatabaseResponse) => DatabaseResponse) {
  qc.setQueryData<DatabaseResponse>(key, (old) => (old ? fn(old) : old));
}

function patchSchema(qc: QueryClient, key: QueryKey, fn: (props: PropertyDef[]) => PropertyDef[]) {
  patchDatabaseCache(qc, key, (d) => ({ ...d, schema: { ...d.schema, properties: fn(d.schema.properties) } }));
}

function setSchemaFromServer(qc: QueryClient, key: QueryKey, schema: DatabaseSchema) {
  patchDatabaseCache(qc, key, (d) => ({ ...d, schema }));
}

function applyPagePatch(page: Page, patch: UpdatePageRequest, userId: string | undefined): Page {
  const next: Page = { ...page, updatedAt: Date.now(), updatedBy: userId ?? page.updatedBy };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.icon !== undefined) next.icon = patch.icon;
  if (patch.cover !== undefined) next.cover = patch.cover;
  if (patch.format) next.format = { ...page.format, ...patch.format };
  if (patch.properties) {
    const props = { ...page.properties };
    for (const [k, v] of Object.entries(patch.properties)) {
      if (v === null) delete props[k];
      else props[k] = v;
    }
    next.properties = props;
  }
  return next;
}

function currentUserId(qc: QueryClient): string | undefined {
  return qc.getQueryData<SessionResponse>(qk.session)?.user.id;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateRowInput {
  id?: string;
  title?: string;
  properties?: Record<string, PropertyValue>;
  /** Position hint: undefined = last, null = first, id = right after that row. */
  after?: string | null;
  /** Create from this row template (content and sub-pages duplicated on the server). */
  templateId?: string;
  /** Template data, for the optimistic row. */
  template?: Page;
}

export interface DbMutations {
  updateRow(rowId: string, patch: UpdatePageRequest): Promise<Page | undefined>;
  /** Same patch on several rows. */
  updateRows(rowIds: string[], patch: UpdatePageRequest): Promise<void>;
  /** Different values per row (table grid), batched by 500 with one invalidation; false on error. */
  updateRowsEach(updates: Array<{ id: string; title?: string; properties?: Record<string, PropertyValue> }>): Promise<boolean>;
  /** Optimistically inserts the row; `done` resolves with the server row (undefined on failure). */
  createRow(input: CreateRowInput): { id: string; done: Promise<Page | undefined> };
  trashRows(ids: string[]): Promise<void>;
  duplicateRow(id: string): Promise<Page | undefined>;
  duplicateRows(ids: string[]): Promise<void>;
  moveRow(id: string, after: string | null): Promise<Page | undefined>;
  /** I1: places a row after `after` (null = first) in the manual order of one view only. */
  moveRowInView(viewId: string, id: string, after: string | null): Promise<void>;
  updateDatabasePage(patch: UpdatePageRequest): Promise<Page | undefined>;
  createProperty(
    def: Omit<PropertyDef, 'id'>,
    after?: string | null,
    opts?: { twoWay?: TwoWayRelationRequest },
  ): { id: string; done: Promise<DatabaseSchema | undefined> };
  updateProperty(propId: string, patch: UpdatePropertyRequest): Promise<DatabaseSchema | undefined>;
  deleteProperty(propId: string, mirror?: DeletePropertyMirrorMode): Promise<DatabaseSchema | undefined>;
  createTemplate(title?: string, fromTemplateId?: string): Promise<Page | undefined>;
  setDefaultTemplate(templateId: string | null): Promise<TemplatesResponse | undefined>;
  /** I1: copy of an existing row (with its sub-pages) as a template; the original may go to the trash. */
  convertRowToTemplate(rowId: string, opts?: { trashOriginal?: boolean }): Promise<Page | undefined>;
  /** I1: recurring template (null stops it). */
  setTemplateRecurrence(templateId: string, recurrence: TemplateRecurrence | null): Promise<TemplatesResponse | undefined>;
  importRows(body: ImportRowsRequest): Promise<ImportRowsResponse | undefined>;
  moveProperty(propId: string, after: string | null): Promise<DatabaseSchema | undefined>;
  createView(name: string, type: ViewType, config?: Partial<ViewConfig>, after?: string | null): Promise<View | undefined>;
  updateView(viewId: string, patch: { name?: string; type?: ViewType; config?: Partial<ViewConfig> }): Promise<View | undefined>;
  deleteView(viewId: string): Promise<void>;
  moveView(viewId: string, after: string | null): Promise<View | undefined>;
  duplicateView(viewId: string): Promise<View | undefined>;
  uploadFile(workspaceId: string, file: File): Promise<FileValue | undefined>;
  createRowIn(targetDatabaseId: string, title: string): Promise<Page | undefined>;
}

export function useDbMutations(databaseId: string, onError: (message: string) => void, opts: { linkId?: string } = {}): DbMutations {
  const qc = useQueryClient();
  const run = useRunner(databaseId, onError);
  const linkId = opts.linkId;

  return useMemo<DbMutations>(() => {
    // The cache entry displayed (native views, or a linked block's views).
    const dbKey = databaseKey(databaseId, false, linkId) as QueryKey;
    const rowsK = qk.rows(databaseId);
    const relationTargetOf = (propId: string): string | undefined =>
      qc.getQueryData<DatabaseResponse>(dbKey)?.schema.properties.find((p) => p.id === propId)?.relation?.databaseId;
    /** Two-way relations modify the target database too. */
    const targetKeys = (target: string | undefined): QueryKey[] =>
      target && target !== databaseId ? [qk.database(target), qk.rows(target)] : [];

    const updateRow: DbMutations['updateRow'] = (rowId, patch) => {
      const uid = currentUserId(qc);
      return run({
        keys: [rowsK, qk.page(rowId)],
        apply: () => {
          patchRowsCache(qc, databaseId, (rows) => rows.map((r) => (r.id === rowId ? applyPagePatch(r, patch, uid) : r)));
          qc.setQueryData<PageDetailResponse>(qk.page(rowId), (old) =>
            old ? { ...old, page: applyPagePatch(old.page, patch, uid) } : old,
          );
        },
        request: () => afterCreate(rowId).then(() => api.pages.update(rowId, patch)),
      });
    };

    const updateRows: DbMutations['updateRows'] = async (rowIds, patch) => {
      const uid = currentUserId(qc);
      const set = new Set(rowIds);
      await run({
        keys: [rowsK],
        apply: () => patchRowsCache(qc, databaseId, (rows) => rows.map((r) => (set.has(r.id) ? applyPagePatch(r, patch, uid) : r))),
        request: () => mapLimit(rowIds, 6, (id) => afterCreate(id).then(() => api.pages.update(id, patch))),
        invalidate: rowIds.map((id) => qk.page(id)),
      });
    };

    const updateRowsEach: DbMutations['updateRowsEach'] = async (updates) => {
      if (updates.length === 0) return true;
      const uid = currentUserId(qc);
      const byId = new Map(updates.map((u) => [u.id, u]));
      const result = await run({
        keys: [rowsK],
        apply: () =>
          patchRowsCache(qc, databaseId, (rows) =>
            rows.map((r) => {
              const u = byId.get(r.id);
              return u ? applyPagePatch(r, { title: u.title, properties: u.properties }, uid) : r;
            }),
          ),
        request: async () => {
          await Promise.all(updates.map((u) => afterCreate(u.id)));
          for (let i = 0; i < updates.length; i += 500) {
            await api.databases.updateRowsBatch(databaseId, { updates: updates.slice(i, i + 500) });
          }
          return true;
        },
      });
      return result === true;
    };

    const createRow: DbMutations['createRow'] = (input) => {
      const id = input.id ?? newId();
      const uid = currentUserId(qc) ?? '';
      const rowsData = qc.getQueryData<RowsResponse>(rowsK);
      const dbData = qc.getQueryData<DatabaseResponse>(dbKey);
      const now = Date.now();
      const optimistic: Page = {
        id,
        workspaceId: dbData?.page.workspaceId ?? '',
        parentType: 'database',
        parentId: databaseId,
        kind: 'page',
        title: input.title ?? input.template?.title ?? '',
        icon: input.template?.icon ?? null,
        cover: input.template?.cover ?? null,
        position: positionForInsert(rowsData?.rows ?? [], input.after),
        visibility: dbData?.page.visibility ?? 'workspace',
        ownerId: uid,
        properties: { ...(input.template?.properties ?? {}), ...(input.properties ?? {}) },
        format: {},
        isInline: false,
        isPublic: false,
        trashedAt: null,
        trashedBy: null,
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        version: 1,
      };
      const done = run({
        keys: [rowsK],
        apply: () => patchRowsCache(qc, databaseId, (rows) => [...rows, optimistic]),
        request: () =>
          api.databases.createRow(databaseId, {
            id,
            title: input.title,
            properties: input.properties,
            after: input.after,
            templateId: input.templateId,
          }),
        onSuccess: (page) =>
          patchRowsCache(qc, databaseId, (rows) =>
            rows.map((r) => (r.id === id ? { ...page, title: r.title, properties: { ...page.properties, ...r.properties } } : r)),
          ),
      });
      pendingCreates.set(id, done);
      void done.finally(() => pendingCreates.delete(id));
      return { id, done };
    };

    const trashRows: DbMutations['trashRows'] = async (ids) => {
      const set = new Set(ids);
      await run({
        keys: [rowsK],
        apply: () => patchRowsCache(qc, databaseId, (rows) => rows.filter((r) => !set.has(r.id))),
        request: () => mapLimit(ids, 6, (id) => afterCreate(id).then(() => api.pages.trash(id))),
      });
    };

    const duplicateRow: DbMutations['duplicateRow'] = (id) =>
      run({
        keys: [rowsK],
        request: () => api.pages.duplicate(id),
        onSuccess: (page) =>
          patchRowsCache(qc, databaseId, (rows) => (rows.some((r) => r.id === page.id) ? rows : [...rows, page])),
      });

    const duplicateRows: DbMutations['duplicateRows'] = async (ids) => {
      await run({
        keys: [rowsK],
        // Sequential: each copy is placed right after its original.
        request: () => mapLimit(ids, 1, (id) => api.pages.duplicate(id)),
        onSuccess: (pages) =>
          patchRowsCache(qc, databaseId, (rows) => [...rows, ...pages.filter((p) => !rows.some((r) => r.id === p.id))]),
      });
    };

    const moveRow: DbMutations['moveRow'] = (id, after) =>
      run({
        keys: [rowsK],
        apply: () =>
          patchRowsCache(qc, databaseId, (rows) => {
            const position = positionForInsert(rows, after, id);
            return rows.map((r) => (r.id === id ? { ...r, position } : r));
          }),
        request: () => afterCreate(id).then(() => api.pages.move(id, { parentType: 'database', parentId: databaseId, after })),
      });

    const updateDatabasePage: DbMutations['updateDatabasePage'] = (patch) => {
      const uid = currentUserId(qc);
      return run({
        keys: [dbKey, qk.page(databaseId)],
        invalidate: linkId ? [qk.database(databaseId)] : [],
        apply: () => {
          patchDatabaseCache(qc, dbKey, (d) => ({ ...d, page: applyPagePatch(d.page, patch, uid) }));
          qc.setQueryData<PageDetailResponse>(qk.page(databaseId), (old) =>
            old ? { ...old, page: applyPagePatch(old.page, patch, uid) } : old,
          );
        },
        request: () => api.pages.update(databaseId, patch),
      });
    };

    const createProperty: DbMutations['createProperty'] = (def, after, opts) => {
      const id = shortId(6);
      const property: PropertyDef = { ...def, id };
      const done = run({
        keys: [dbKey],
        apply: () =>
          patchSchema(qc, dbKey, (props) => {
            const next = [...props];
            const anchor = after ? next.findIndex((p) => p.id === after) : -1;
            if (after === null) next.unshift(property);
            else if (anchor >= 0) next.splice(anchor + 1, 0, property);
            else next.push(property);
            return next;
          }),
        request: () => api.databases.createProperty(databaseId, { property, after, twoWay: opts?.twoWay }),
        onSuccess: (schema) => setSchemaFromServer(qc, dbKey, schema),
        invalidate: [rowsK, ...(opts?.twoWay ? targetKeys(def.relation?.databaseId) : [])],
      });
      return { id, done };
    };

    const updateProperty: DbMutations['updateProperty'] = (propId, patch) => {
      const relational = patch.twoWay !== undefined || !!patch.relation || !!patch.type;
      const target = relationTargetOf(propId) ?? patch.relation?.databaseId;
      const { twoWay: _tw, ...defPatch } = patch;
      return run({
        keys: [dbKey],
        apply: () =>
          patchSchema(qc, dbKey, (props) => {
            const before = props.find((p) => p.id === propId);
            const next = props.map((p) =>
              p.id === propId ? { ...p, ...defPatch, relation: defPatch.relation ? { ...p.relation, ...defPatch.relation } : p.relation } : p,
            );
            // Same rewrite of prop("…") as the server's rename (its response then replaces the schema).
            // I2: current.prop("…") over pages of this database too (other databases follow the server's notification).
            const schemaOf = (id: string) => qc.getQueryData<DatabaseResponse>(databaseKey(id, false))?.schema.properties;
            return before && defPatch.name !== undefined ? renameFormulaReferences(next, propId, before.name, { databaseId, schemaOf }) : next;
          }),
        request: () => api.databases.updateProperty(databaseId, propId, patch),
        onSuccess: (schema) => setSchemaFromServer(qc, dbKey, schema),
        invalidate: [...(patch.type || patch.options || relational ? [rowsK] : []), ...(relational ? targetKeys(target) : [])],
      });
    };

    const deleteProperty: DbMutations['deleteProperty'] = (propId, mirror) => {
      const target = relationTargetOf(propId);
      return run({
        keys: [dbKey],
        apply: () => patchSchema(qc, dbKey, (props) => props.filter((p) => p.id !== propId)),
        request: () => api.databases.deleteProperty(databaseId, propId, mirror),
        onSuccess: (schema) => setSchemaFromServer(qc, dbKey, schema),
        invalidate: [rowsK, ...targetKeys(target)],
      });
    };

    const moveProperty: DbMutations['moveProperty'] = (propId, after) =>
      run({
        keys: [dbKey],
        apply: () =>
          patchSchema(qc, dbKey, (props) => {
            const moving = props.find((p) => p.id === propId);
            if (!moving) return props;
            const rest = props.filter((p) => p.id !== propId);
            const idx = after === null ? 0 : rest.findIndex((p) => p.id === after) + 1;
            rest.splice(idx <= 0 && after !== null ? rest.length : idx, 0, moving);
            return rest;
          }),
        request: () => api.databases.moveProperty(databaseId, propId, { after }),
        onSuccess: (schema) => setSchemaFromServer(qc, dbKey, schema),
      });

    const upsertView = (view: View) =>
      patchDatabaseCache(qc, dbKey, (d) => {
        const exists = d.views.some((v) => v.id === view.id);
        const views = exists ? d.views.map((v) => (v.id === view.id ? view : v)) : [...d.views, view];
        return { ...d, views: sortByPosition(views) };
      });

    const createView: DbMutations['createView'] = (name, type, config, after) =>
      run({
        keys: [dbKey],
        request: () => api.databases.createView(databaseId, { name, type, config, after, linkId }),
        onSuccess: upsertView,
      });

    const updateView: DbMutations['updateView'] = (viewId, patch) =>
      run({
        keys: [dbKey],
        apply: () =>
          patchDatabaseCache(qc, dbKey, (d) => ({
            ...d,
            views: d.views.map((v) =>
              v.id === viewId
                ? {
                    ...v,
                    name: patch.name ?? v.name,
                    type: patch.type ?? v.type,
                    config: patch.config ? ({ ...v.config, ...patch.config } as ViewConfig) : v.config,
                  }
                : v,
            ),
          })),
        request: () => api.views.update(viewId, patch),
      });

    const deleteView: DbMutations['deleteView'] = async (viewId) => {
      await run({
        keys: [dbKey],
        apply: () => patchDatabaseCache(qc, dbKey, (d) => ({ ...d, views: d.views.filter((v) => v.id !== viewId) })),
        request: () => api.views.remove(viewId),
      });
    };

    const moveView: DbMutations['moveView'] = (viewId, after) =>
      run({
        keys: [dbKey],
        apply: () =>
          patchDatabaseCache(qc, dbKey, (d) => {
            const position = positionForInsert(d.views, after, viewId);
            return { ...d, views: sortByPosition(d.views.map((v) => (v.id === viewId ? { ...v, position } : v))) };
          }),
        request: () => api.views.move(viewId, { after }),
      });

    const moveRowInView: DbMutations['moveRowInView'] = async (viewId, id, after) => {
      await run({
        keys: [dbKey],
        apply: () =>
          patchDatabaseCache(qc, dbKey, (d) => {
            const rows = qc.getQueryData<RowsResponse>(rowsK)?.rows ?? [];
            return { ...d, views: d.views.map((v) => (v.id === viewId ? { ...v, rowOrder: moveInViewOrder(rows, v.rowOrder, id, after) } : v)) };
          }),
        request: () => afterCreate(id).then(() => api.views.moveRow(viewId, { rowId: id, after })),
        onSuccess: (res) =>
          patchDatabaseCache(qc, dbKey, (d) => ({ ...d, views: d.views.map((v) => (v.id === res.viewId ? { ...v, rowOrder: res.rowOrder } : v)) })),
      });
    };

    const duplicateView: DbMutations['duplicateView'] = (viewId) =>
      run({ keys: [dbKey], request: () => api.views.duplicate(viewId), onSuccess: upsertView });

    const uploadFile: DbMutations['uploadFile'] = async (workspaceId, file) => {
      try {
        const up = await api.workspaces.upload(workspaceId, file);
        return { name: up.name, url: up.url, size: up.size, mime: up.mime };
      } catch (err) {
        onError(errorMessage(err));
        return undefined;
      }
    };

    const createRowIn: DbMutations['createRowIn'] = (targetDatabaseId, title) =>
      run({
        keys: [qk.rows(targetDatabaseId)],
        request: () => api.databases.createRow(targetDatabaseId, { id: newId(), title }),
        onSuccess: (page) =>
          patchRowsCache(qc, targetDatabaseId, (rows) => (rows.some((r) => r.id === page.id) ? rows : [...rows, page])),
      });

    const tplKey = templatesKey(databaseId);
    const createTemplate: DbMutations['createTemplate'] = (title, fromTemplateId) =>
      run({
        keys: [tplKey],
        request: () => api.databases.createTemplate(databaseId, { title, fromTemplateId }),
        onSuccess: (page) =>
          qc.setQueryData<TemplatesResponse>(tplKey, (old) =>
            old && !old.rows.some((r) => r.id === page.id) ? { ...old, rows: [...old.rows, page] } : old,
          ),
      });

    const setDefaultTemplate: DbMutations['setDefaultTemplate'] = (templateId) =>
      run({
        keys: [tplKey],
        apply: () => qc.setQueryData<TemplatesResponse>(tplKey, (old) => (old ? { ...old, defaultTemplateId: templateId } : old)),
        request: () => api.databases.setDefaultTemplate(databaseId, templateId),
        onSuccess: (res) => qc.setQueryData(tplKey, res),
      });

    const convertRowToTemplate: DbMutations['convertRowToTemplate'] = (rowId, opts) =>
      run({
        keys: [tplKey, rowsK],
        apply: () => {
          if (opts?.trashOriginal) patchRowsCache(qc, databaseId, (rows) => rows.filter((r) => r.id !== rowId));
        },
        request: () => afterCreate(rowId).then(() => api.databases.createTemplate(databaseId, { fromRowId: rowId, trashOriginal: opts?.trashOriginal })),
        onSuccess: (page) =>
          qc.setQueryData<TemplatesResponse>(tplKey, (old) =>
            old && !old.rows.some((r) => r.id === page.id) ? { ...old, rows: [...old.rows, page] } : old,
          ),
      });

    const setTemplateRecurrence: DbMutations['setTemplateRecurrence'] = (templateId, recurrence) =>
      run({
        keys: [tplKey],
        request: () => api.databases.setTemplateRecurrence(databaseId, templateId, { recurrence }),
        onSuccess: (res) => qc.setQueryData(tplKey, res),
      });

    const importRows: DbMutations['importRows'] = (body) =>
      run({ keys: [rowsK], request: () => api.databases.importRows(databaseId, body) });

    return {
      moveRowInView,
      convertRowToTemplate,
      setTemplateRecurrence,
      updateRow,
      updateRows,
      updateRowsEach,
      createRow,
      trashRows,
      duplicateRow,
      duplicateRows,
      moveRow,
      updateDatabasePage,
      createProperty,
      updateProperty,
      deleteProperty,
      moveProperty,
      createView,
      updateView,
      deleteView,
      moveView,
      duplicateView,
      uploadFile,
      createRowIn,
      createTemplate,
      setDefaultTemplate,
      importRows,
    };
  }, [qc, run, databaseId, onError, linkId]);
}

/** Users known for display: workspace members + users referenced by rows. */
export function mergeUsers(members: Member[] | undefined, rowsUsers: PublicUser[] | undefined): PublicUser[] {
  const map = new Map<string, PublicUser>();
  for (const u of rowsUsers ?? []) map.set(u.id, u);
  for (const m of members ?? []) map.set(m.user.id, m.user);
  return [...map.values()];
}
