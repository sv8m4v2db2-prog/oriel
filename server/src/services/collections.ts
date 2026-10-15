// Organize module (wave H3): the page-listing engine behind « Toutes les pages », tag pages and
// smart collections, plus collections, saved views, sidebar folder items and batch page actions.
//
// Every listing is restricted to pages the viewer sees (visiblePageClause) and never lists the
// trash, so a private page or a page of a restricted teamspace is absent from tags, collections,
// counts and listings, whatever the rules say. Lists are paginated (offset/limit) and sorted in SQL.
import {
  MAX_CONDITIONS,
  newId,
  positionForInsert,
  sortByPosition,
  type AllPagesViewConfig,
  type Collection,
  type CollectionInput,
  type FolderItem,
  type FolderItemKind,
  type PageCondition,
  type PageFilter,
  type PageGroupBy,
  type PageListItem,
  type PageListResponse,
  type PagePropValue,
  type PageQuery,
  type PageSort,
  type PagesBatchRequest,
  type PagesBatchResponse,
  type SavedPagesView,
  type SavedPagesViewInput,
  type UpdateCollectionRequest,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/rows.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import { canEditRole, pageAccess, requireWorkspace, roleOf, visiblePageClause, visiblePageParams } from '../access.js';
import { movePage, trashPage } from './pages.js';
import { MAX_BATCH } from './tags.js';

export const MAX_COLLECTIONS = 100;
export const MAX_VIEWS = 100;
export const MAX_MANUAL_PAGES = 500;
export const MAX_COLUMNS = 12;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100_000;
const DAY_MS = 86_400_000;

const EMPTY_FILTER: PageFilter = { match: 'all', conditions: [] };

/**
 * Accent- and case-insensitive text matching: a SQL function registered on first use (SQLite's own
 * lower() only folds ASCII, so « episode » would not find « Épisode »). Falls back to lower().
 */
let foldFn = 'lower';
const foldedConnections = new WeakSet<object>();
function ensureFold(db: Db): void {
  if (!foldedConnections.has(db.raw)) {
    try {
      db.raw.function('oriel_fold', { deterministic: true }, (v) =>
        typeof v === 'string' ? v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() : v,
      );
      foldedConnections.add(db.raw);
    } catch {
      /* older runtime: ASCII lower() */
    }
  }
  foldFn = foldedConnections.has(db.raw) ? 'oriel_fold' : 'lower';
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

interface Built {
  sql: string;
  params: Array<string | number>;
}

interface PropMeta {
  id: string;
  type: string;
  options: Array<{ id: string }>;
}

const SUBTREE = `(WITH RECURSIVE d(id) AS (
  SELECT ? UNION SELECT c.id FROM pages c JOIN d ON c.parent_id = d.id AND c.parent_type IN ('page', 'database')
) SELECT id FROM d)`;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

function dayStart(day: string | undefined): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function propValueSql(propId: string): Built {
  return { sql: '(SELECT json_extract(v.value, \'$\') FROM org_page_prop_values v WHERE v.page_id = p.id AND v.prop_id = ?)', params: [propId] };
}

function compileCondition(c: PageCondition, props: Map<string, PropMeta>, now: number): Built {
  const NONE: Built = { sql: '0', params: [] };
  switch (c.type) {
    case 'tag': {
      const ids = (c.tagIds ?? []).slice(0, 50);
      if (ids.length === 0) return c.op === 'none' ? { sql: '1', params: [] } : NONE;
      if (c.op === 'all') {
        return {
          sql: '(' + ids.map(() => 'EXISTS (SELECT 1 FROM org_page_tags x WHERE x.page_id = p.id AND x.tag_id = ?)').join(' AND ') + ')',
          params: [...ids],
        };
      }
      const exists = `EXISTS (SELECT 1 FROM org_page_tags x WHERE x.page_id = p.id AND x.tag_id IN (${placeholders(ids.length)}))`;
      return { sql: c.op === 'none' ? `NOT ${exists}` : exists, params: [...ids] };
    }
    case 'user': {
      const ids = (c.userIds ?? []).slice(0, 50);
      if (ids.length === 0) return NONE;
      return { sql: `p.${c.by === 'updated' ? 'updated_by' : 'created_by'} IN (${placeholders(ids.length)})`, params: [...ids] };
    }
    case 'date': {
      const col = c.field === 'updated' ? 'p.updated_at' : 'p.created_at';
      const parts: string[] = [];
      const params: number[] = [];
      const after = dayStart(c.after);
      const before = dayStart(c.before);
      if (after !== null) {
        parts.push(`${col} >= ?`);
        params.push(after);
      }
      if (before !== null) {
        parts.push(`${col} < ?`);
        params.push(before + DAY_MS);
      }
      if (typeof c.lastDays === 'number' && Number.isFinite(c.lastDays) && c.lastDays > 0) {
        parts.push(`${col} >= ?`);
        params.push(now - Math.min(Math.floor(c.lastDays), 36_500) * DAY_MS);
      }
      return parts.length === 0 ? NONE : { sql: `(${parts.join(' AND ')})`, params };
    }
    case 'prop': {
      const def = props.get(c.propId);
      if (!def) return NONE;
      const v = propValueSql(c.propId);
      const lit = (x: PagePropValue | undefined): string | number | null => (typeof x === 'boolean' ? (x ? 1 : 0) : x === undefined ? null : x);
      const value = lit(c.value);
      switch (c.op) {
        case 'empty':
          return { sql: `(${v.sql} IS NULL)`, params: v.params };
        case 'not_empty':
          return { sql: `(${v.sql} IS NOT NULL)`, params: v.params };
        case 'checked':
          return { sql: `(${v.sql} = 1)`, params: v.params };
        case 'unchecked':
          return { sql: `(COALESCE(${v.sql}, 0) = 0)`, params: v.params };
        case 'eq':
          return value === null ? NONE : { sql: `(${v.sql} = ?)`, params: [...v.params, value] };
        case 'neq':
          return value === null ? NONE : { sql: `(COALESCE(${v.sql}, '') != ?)`, params: [...v.params, value] };
        case 'contains':
          return typeof value !== 'string' || !value
            ? NONE
            : { sql: `(instr(${foldFn}(COALESCE(${v.sql}, '')), ${foldFn}(?)) > 0)`, params: [...v.params, value.slice(0, 200)] };
        case 'gt':
          return value === null ? NONE : { sql: `(${v.sql} > ?)`, params: [...v.params, value] };
        case 'lt':
          return value === null ? NONE : { sql: `(${v.sql} < ?)`, params: [...v.params, value] };
        default:
          return NONE;
      }
    }
    case 'space': {
      if (c.space === 'private') return { sql: "p.visibility = 'private'", params: [] };
      if (c.space === 'workspace') return { sql: "p.visibility = 'workspace'", params: [] };
      if (typeof c.space !== 'string' || c.space.length === 0 || c.space.length > 128) return NONE;
      return { sql: `p.id IN ${SUBTREE}`, params: [c.space] };
    }
    case 'kind': {
      const parts: string[] = [];
      for (const k of new Set(c.kinds ?? [])) {
        if (k === 'page') parts.push("(p.kind = 'page' AND p.parent_type != 'database')");
        else if (k === 'database') parts.push("p.kind = 'database'");
        else if (k === 'row') parts.push("p.parent_type = 'database'");
        else if (k === 'template') parts.push('p.is_template = 1');
        else if (k === 'journal') parts.push('EXISTS (SELECT 1 FROM org_journal_entries j WHERE j.page_id = p.id)');
      }
      return parts.length === 0 ? NONE : { sql: `(${parts.join(' OR ')})`, params: [] };
    }
    case 'title': {
      const value = String(c.value ?? '').slice(0, 200);
      return value ? { sql: `(instr(${foldFn}(p.title), ${foldFn}(?)) > 0)`, params: [value] } : { sql: '1', params: [] };
    }
    default:
      return NONE;
  }
}

function hasRowKind(filter: PageFilter | undefined): boolean {
  return !!filter?.conditions.some((c) => c.type === 'kind' && c.kinds?.includes('row'));
}

/** Rules → SQL. `emptyMatchesAll`: an empty list means "no restriction" (listing) or "nothing" (rules). */
function compileFilter(filter: PageFilter | undefined, props: Map<string, PropMeta>, now: number, emptyMatchesAll: boolean): Built {
  const conditions = (filter?.conditions ?? []).slice(0, MAX_CONDITIONS);
  if (conditions.length === 0) return { sql: emptyMatchesAll ? '1' : '0', params: [] };
  const built = conditions.map((c) => compileCondition(c, props, now));
  return {
    sql: '(' + built.map((b) => b.sql).join(filter?.match === 'any' ? ' OR ' : ' AND ') + ')',
    params: built.flatMap((b) => b.params),
  };
}

/** Validates the shape of a filter coming from a client (zod covers the types; this bounds sizes). */
export function checkFilter(filter: PageFilter | undefined): void {
  if (!filter) return;
  if (filter.conditions.length > MAX_CONDITIONS) throw badRequest(`${MAX_CONDITIONS} conditions au plus.`);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

interface ManualPages {
  collectionId?: string;
  included?: string[];
  excluded?: string[];
}

interface ListInput extends Omit<PageQuery, 'collectionId'> {
  /** A collection: its rules (union its included pages, minus its excluded pages) AND the filter. */
  collection?: { rules: PageFilter; manual: ManualPages };
}

function workspaceProps(db: Db, workspaceId: string): Map<string, PropMeta & { options: Array<{ id: string }> }> {
  const map = new Map<string, PropMeta>();
  for (const r of db.all<{ id: string; type: string; options: string }>('SELECT id, type, options FROM org_page_props WHERE workspace_id = ?', workspaceId)) {
    map.set(r.id, { id: r.id, type: r.type, options: parseJson<Array<{ id: string }>>(r.options, []) });
  }
  return map;
}

interface SqlPart {
  sql: string;
  params: string[];
}

/** Group key (selected) and group ordering; parameters are positional, in the order they appear. */
function groupExpr(group: PageGroupBy | undefined, props: Map<string, PropMeta>): { key: SqlPart; order: SqlPart } | null {
  if (!group || group === 'none') return null;
  const plain = (sql: string): SqlPart => ({ sql, params: [] });
  if (group === 'tag') {
    return {
      key: plain('(SELECT pt.tag_id FROM org_page_tags pt JOIN org_tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id ORDER BY t.name_key, t.id LIMIT 1)'),
      order: plain("COALESCE((SELECT t.name_key FROM org_page_tags pt JOIN org_tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id ORDER BY t.name_key, t.id LIMIT 1), 'zzzzzzzz')"),
    };
  }
  if (group === 'author') {
    return { key: plain('p.created_by'), order: plain('(SELECT u.name FROM users u WHERE u.id = p.created_by) COLLATE NOCASE') };
  }
  if (group === 'created_month') {
    const k = "strftime('%Y-%m', p.created_at / 1000, 'unixepoch')";
    return { key: plain(k), order: plain(`${k} DESC`) };
  }
  if (group === 'updated_month') {
    const k = "strftime('%Y-%m', p.updated_at / 1000, 'unixepoch')";
    return { key: plain(k), order: plain(`${k} DESC`) };
  }
  if (group === 'type') {
    const k = "CASE WHEN p.parent_type = 'database' THEN 'row' WHEN p.kind = 'database' THEN 'database' WHEN p.is_template = 1 THEN 'template' ELSE 'page' END";
    return { key: plain(k), order: plain(k) };
  }
  if (typeof group === 'object' && 'prop' in group) {
    const def = props.get(group.prop);
    if (!def || (def.type !== 'select' && def.type !== 'checkbox')) return null;
    const v = propValueSql(group.prop);
    if (def.type === 'checkbox') {
      return { key: { sql: `COALESCE(${v.sql}, 0)`, params: [group.prop] }, order: { sql: `COALESCE(${v.sql}, 0) DESC`, params: [group.prop] } };
    }
    const cases = def.options.map((o, i) => `WHEN '${o.id.replace(/'/g, "''")}' THEN ${i}`).join(' ');
    return { key: { sql: v.sql, params: [group.prop] }, order: { sql: `CASE ${v.sql} ${cases} ELSE 9999 END`, params: [group.prop] } };
  }
  return null;
}

function sortExpr(sort: PageSort | undefined, props: Map<string, PropMeta>): { sql: string; params: string[]; dir: 'ASC' | 'DESC' } {
  const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC';
  const f = sort?.field ?? 'updated';
  if (f === 'title') return { sql: 'p.title COLLATE NOCASE', params: [], dir };
  if (f === 'created') return { sql: 'p.created_at', params: [], dir };
  if (f === 'updated') return { sql: 'p.updated_at', params: [], dir: sort ? dir : 'DESC' };
  if (typeof f === 'object' && 'prop' in f) {
    const def = props.get(f.prop);
    if (!def) return { sql: 'p.updated_at', params: [], dir: 'DESC' };
    const v = propValueSql(f.prop);
    if (def.type === 'select') {
      const cases = def.options.map((o, i) => `WHEN '${o.id.replace(/'/g, "''")}' THEN ${i}`).join(' ');
      return { sql: `CASE ${v.sql} ${cases} END`, params: [f.prop], dir };
    }
    return { sql: v.sql, params: [f.prop], dir };
  }
  return { sql: 'p.updated_at', params: [], dir: 'DESC' };
}

/**
 * Lists the pages of a workspace the user can see, filtered, grouped, sorted and paginated.
 * The caller has already checked workspace membership.
 */
export function listPages(db: Db, userId: string, workspaceId: string, input: ListInput): PageListResponse {
  ensureFold(db);
  const now = Date.now();
  const props = workspaceProps(db, workspaceId);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), MAX_OFFSET);
  checkFilter(input.filter);

  const where: string[] = ['p.workspace_id = ?', 'p.trashed_at IS NULL', visiblePageClause('p')];
  const params: Array<string | number> = [workspaceId, ...visiblePageParams(userId)];

  // Rows and inline databases are noise in a general listing unless asked for.
  const base = hasRowKind(input.filter) || hasRowKind(input.collection?.rules) ? '1' : "(p.parent_type != 'database' AND p.is_inline = 0)";
  const manualIncluded = (m: ManualPages): Built => {
    if (m.collectionId) return { sql: "EXISTS (SELECT 1 FROM org_collection_pages cp WHERE cp.collection_id = ? AND cp.page_id = p.id AND cp.mode = 'include')", params: [m.collectionId] };
    const ids = (m.included ?? []).slice(0, MAX_MANUAL_PAGES);
    return ids.length ? { sql: `p.id IN (${placeholders(ids.length)})`, params: ids } : { sql: '0', params: [] };
  };
  const manualExcluded = (m: ManualPages): Built => {
    if (m.collectionId) return { sql: "EXISTS (SELECT 1 FROM org_collection_pages cp WHERE cp.collection_id = ? AND cp.page_id = p.id AND cp.mode = 'exclude')", params: [m.collectionId] };
    const ids = (m.excluded ?? []).slice(0, MAX_MANUAL_PAGES);
    return ids.length ? { sql: `p.id IN (${placeholders(ids.length)})`, params: ids } : { sql: '0', params: [] };
  };

  if (input.collection) {
    const rules = compileFilter(input.collection.rules, props, now, false);
    const inc = manualIncluded(input.collection.manual);
    const exc = manualExcluded(input.collection.manual);
    where.push(`((${base} AND ${rules.sql}) OR ${inc.sql})`, `NOT ${exc.sql}`);
    params.push(...rules.params, ...inc.params, ...exc.params);
  } else {
    where.push(base);
  }
  const filter = compileFilter(input.filter, props, now, true);
  where.push(filter.sql);
  params.push(...filter.params);

  const whereSql = where.join(' AND ');
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pages p WHERE ${whereSql}`, ...params)!.n;

  const group = groupExpr(input.group, props);
  const sort = sortExpr(input.sort, props);
  const orderParts: string[] = [];
  const orderParams: string[] = [];
  if (group) {
    orderParts.push(group.order.sql);
    orderParams.push(...group.order.params);
  }
  orderParts.push(`(${sort.sql}) IS NULL`, `${sort.sql} ${sort.dir}`, 'p.id');
  orderParams.push(...sort.params, ...sort.params);
  // Parameters are positional: select list (group key), join, WHERE, ORDER BY, LIMIT/OFFSET.
  const groupKeyParams = group ? group.key.params : [];
  const rows = db.all<{
    id: string;
    kind: PageListItem['kind'];
    parent_type: PageListItem['parentType'];
    parent_id: string;
    parent_title: string | null;
    title: string;
    icon: string | null;
    visibility: PageListItem['visibility'];
    is_template: number;
    created_at: number;
    created_by: string;
    updated_at: number;
    updated_by: string;
    grp: string | number | null;
  }>(
    `SELECT p.id, p.kind, p.parent_type, p.parent_id, p.title, p.icon, p.visibility, p.is_template, p.created_at, p.created_by,
            p.updated_at, p.updated_by, par.title AS parent_title, ${group ? group.key.sql : 'NULL'} AS grp
     FROM pages p
     LEFT JOIN pages par ON par.id = p.parent_id AND p.parent_type IN ('page', 'database') AND par.trashed_at IS NULL AND ${visiblePageClause('par')}
     WHERE ${whereSql}
     ORDER BY ${orderParts.join(', ')}
     LIMIT ? OFFSET ?`,
    ...groupKeyParams,
    ...visiblePageParams(userId),
    ...params,
    ...orderParams,
    limit,
    offset,
  );

  // Hydration: tags and requested property values of the page of results only.
  const ids = rows.map((r) => r.id);
  const tagMap = new Map<string, string[]>();
  const valueMap = new Map<string, Record<string, PagePropValue>>();
  if (ids.length > 0) {
    for (const t of db.all<{ page_id: string; tag_id: string }>(
      `SELECT pt.page_id, pt.tag_id FROM org_page_tags pt JOIN org_tags t ON t.id = pt.tag_id
       WHERE pt.page_id IN (${placeholders(ids.length)}) ORDER BY t.name_key, t.id`,
      ...ids,
    )) {
      (tagMap.get(t.page_id) ?? tagMap.set(t.page_id, []).get(t.page_id)!).push(t.tag_id);
    }
    const propIds = (input.propIds ?? []).filter((id) => props.has(id)).slice(0, MAX_COLUMNS);
    if (propIds.length > 0) {
      for (const v of db.all<{ page_id: string; prop_id: string; value: string }>(
        `SELECT page_id, prop_id, value FROM org_page_prop_values
         WHERE page_id IN (${placeholders(ids.length)}) AND prop_id IN (${placeholders(propIds.length)})`,
        ...ids,
        ...propIds,
      )) {
        const rec = valueMap.get(v.page_id) ?? valueMap.set(v.page_id, {}).get(v.page_id)!;
        rec[v.prop_id] = parseJson<PagePropValue>(v.value, null);
      }
    }
  }
  const items: PageListItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    parentType: r.parent_type,
    parentId: r.parent_id,
    parentTitle: r.parent_title,
    title: r.title,
    icon: r.icon,
    visibility: r.visibility,
    isTemplate: r.is_template === 1,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    tagIds: tagMap.get(r.id) ?? [],
    props: valueMap.get(r.id) ?? {},
    group: group ? (r.grp === null ? '' : String(r.grp)) : null,
  }));
  return { items, total, offset, hasMore: offset + items.length < total };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

interface CollectionRow {
  id: string;
  workspace_id: string;
  name: string;
  icon: string | null;
  rules: string;
  position: string;
  created_by: string | null;
}

function cleanRules(rules: PageFilter | undefined): PageFilter {
  if (!rules) return EMPTY_FILTER;
  checkFilter(rules);
  return { match: rules.match === 'any' ? 'any' : 'all', conditions: rules.conditions };
}

function cleanName(raw: string, what: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest(`Le nom ${what} est vide.`);
  if (name.length > 80) throw badRequest(`Le nom ${what} est trop long (80 caractères).`);
  return name;
}

function collectionRow(db: Db, userId: string, collectionId: string): CollectionRow {
  const row = db.get<CollectionRow>('SELECT * FROM org_collections WHERE id = ?', collectionId);
  if (!row || !roleOf(db, userId, row.workspace_id)) throw notFound('Collection introuvable.');
  return row;
}

function toCollection(db: Db, userId: string, r: CollectionRow): Collection {
  // Manual additions/exclusions are returned only for pages the viewer can see.
  const manual = db.all<{ page_id: string; mode: string }>(
    `SELECT cp.page_id, cp.mode FROM org_collection_pages cp JOIN pages p ON p.id = cp.page_id
     WHERE cp.collection_id = ? AND p.trashed_at IS NULL AND ${visiblePageClause('p')}`,
    r.id,
    ...visiblePageParams(userId),
  );
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    rules: parseJson<PageFilter>(r.rules, EMPTY_FILTER),
    included: manual.filter((m) => m.mode === 'include').map((m) => m.page_id),
    excluded: manual.filter((m) => m.mode === 'exclude').map((m) => m.page_id),
    position: r.position,
    createdBy: r.created_by,
  };
}

export function listCollections(db: Db, userId: string, workspaceId: string): Collection[] {
  requireWorkspace(db, userId, workspaceId);
  return sortByPosition(db.all<CollectionRow>('SELECT * FROM org_collections WHERE workspace_id = ?', workspaceId)).map((r) => toCollection(db, userId, r));
}

export function getCollection(db: Db, userId: string, collectionId: string): Collection {
  return toCollection(db, userId, collectionRow(db, userId, collectionId));
}

function publish(ctx: AppContext, workspaceId: string, scope: 'collections' | 'views' | 'folder-items' | 'journal', only?: string): void {
  ctx.bus.publish(workspaceId, { entity: 'organize', workspaceId, scope }, only);
}

export function createCollection(ctx: AppContext, userId: string, workspaceId: string, input: CollectionInput): Collection {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'edit');
    const siblings = db.all<{ id: string; position: string }>('SELECT id, position FROM org_collections WHERE workspace_id = ?', workspaceId);
    if (siblings.length >= MAX_COLLECTIONS) throw conflict('Trop de collections dans cet espace.');
    const id = newId();
    db.run(
      'INSERT INTO org_collections (id, workspace_id, name, icon, rules, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      cleanName(input.name, 'de la collection'),
      input.icon ? input.icon.slice(0, 16) : null,
      JSON.stringify(cleanRules(input.rules)),
      positionForInsert(siblings, undefined),
      userId,
      Date.now(),
    );
    publish(ctx, workspaceId, 'collections');
    return toCollection(db, userId, db.get<CollectionRow>('SELECT * FROM org_collections WHERE id = ?', id)!);
  });
}

export function updateCollection(ctx: AppContext, userId: string, collectionId: string, input: UpdateCollectionRequest): Collection {
  const { db } = ctx;
  return db.tx(() => {
    const row = collectionRow(db, userId, collectionId);
    requireWorkspace(db, userId, row.workspace_id, 'edit');
    let position = row.position;
    if (input.after !== undefined) {
      position = positionForInsert(
        db.all<{ id: string; position: string }>('SELECT id, position FROM org_collections WHERE workspace_id = ?', row.workspace_id),
        input.after,
        row.id,
      );
    }
    db.run(
      'UPDATE org_collections SET name = ?, icon = ?, rules = ?, position = ? WHERE id = ?',
      input.name !== undefined ? cleanName(input.name, 'de la collection') : row.name,
      input.icon !== undefined ? (input.icon ? input.icon.slice(0, 16) : null) : row.icon,
      input.rules !== undefined ? JSON.stringify(cleanRules(input.rules)) : row.rules,
      position,
      row.id,
    );
    publish(ctx, row.workspace_id, 'collections');
    return toCollection(db, userId, db.get<CollectionRow>('SELECT * FROM org_collections WHERE id = ?', row.id)!);
  });
}

/** The author and workspace managers delete a collection; editors may not remove others' work. */
export function deleteCollection(ctx: AppContext, userId: string, collectionId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const row = collectionRow(db, userId, collectionId);
    const { role } = requireWorkspace(db, userId, row.workspace_id, 'edit');
    if (row.created_by !== userId && role !== 'owner' && role !== 'admin') {
      throw forbidden('Seuls l’auteur de la collection et les administrateurs peuvent la supprimer.');
    }
    db.run("DELETE FROM org_folder_items WHERE kind = 'collection' AND ref_id = ?", row.id);
    db.run('DELETE FROM org_collections WHERE id = ?', row.id);
    publish(ctx, row.workspace_id, 'collections');
  });
}

/** Adds a page by hand (`include`), excludes it (`exclude`) or restores the rules' verdict (null). */
export function setCollectionPage(ctx: AppContext, userId: string, collectionId: string, pageId: string, mode: 'include' | 'exclude' | null): void {
  const { db } = ctx;
  db.tx(() => {
    const row = collectionRow(db, userId, collectionId);
    requireWorkspace(db, userId, row.workspace_id, 'edit');
    const access = pageAccess(db, userId, pageId);
    // The page must be visible (404 otherwise) — editing it is not required to list it.
    if (!access || access.page.workspace_id !== row.workspace_id || access.page.trashed_at !== null) throw notFound('Page introuvable.');
    if (mode === null) db.run('DELETE FROM org_collection_pages WHERE collection_id = ? AND page_id = ?', row.id, pageId);
    else {
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_collection_pages WHERE collection_id = ?', row.id)!.n;
      if (n >= MAX_MANUAL_PAGES) throw conflict('Trop de pages ajoutées ou exclues à la main.');
      db.run(
        `INSERT INTO org_collection_pages (collection_id, page_id, mode) VALUES (?, ?, ?)
         ON CONFLICT(collection_id, page_id) DO UPDATE SET mode = excluded.mode`,
        row.id,
        pageId,
        mode,
      );
    }
    publish(ctx, row.workspace_id, 'collections');
  });
}

export function collectionPages(db: Db, userId: string, workspaceId: string, collectionId: string, query: PageQuery): PageListResponse {
  const row = collectionRow(db, userId, collectionId);
  // A collection of another workspace is unknown here, even to someone who belongs to both.
  if (row.workspace_id !== workspaceId) throw notFound('Collection introuvable.');
  requireWorkspace(db, userId, row.workspace_id);
  return listPages(db, userId, row.workspace_id, {
    ...query,
    collection: { rules: parseJson<PageFilter>(row.rules, EMPTY_FILTER), manual: { collectionId: row.id } },
  });
}

/** Live preview of an unsaved draft. Manual ids are checked against the viewer's visibility by the query. */
export function previewCollection(
  db: Db,
  userId: string,
  workspaceId: string,
  input: { rules: PageFilter; included?: string[]; excluded?: string[]; offset?: number; limit?: number },
): PageListResponse {
  requireWorkspace(db, userId, workspaceId);
  return listPages(db, userId, workspaceId, {
    offset: input.offset,
    limit: input.limit,
    sort: { field: 'updated', dir: 'desc' },
    collection: { rules: cleanRules(input.rules), manual: { included: input.included, excluded: input.excluded } },
  });
}

// ---------------------------------------------------------------------------
// Saved views of "All pages"
// ---------------------------------------------------------------------------

interface ViewRowOrg {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  shared: number;
  config: string;
  position: string;
}

const toSavedView = (r: ViewRowOrg, userId: string): SavedPagesView => ({
  id: r.id,
  name: r.name,
  shared: r.shared === 1,
  ownerId: r.owner_id,
  mine: r.owner_id === userId,
  config: parseJson<AllPagesViewConfig>(r.config, { layout: 'list', filter: EMPTY_FILTER, group: 'none', sort: { field: 'updated', dir: 'desc' }, columns: [] }),
});

function cleanViewConfig(c: AllPagesViewConfig): AllPagesViewConfig {
  checkFilter(c.filter);
  if (c.columns.length > MAX_COLUMNS + 6) throw badRequest('Trop de colonnes.');
  return {
    layout: c.layout === 'grid' ? 'grid' : 'list',
    filter: cleanRules(c.filter),
    group: c.group ?? 'none',
    sort: c.sort ?? { field: 'updated', dir: 'desc' },
    columns: c.columns,
  };
}

export function listSavedViews(db: Db, userId: string, workspaceId: string): SavedPagesView[] {
  requireWorkspace(db, userId, workspaceId);
  const rows = db.all<ViewRowOrg>(
    'SELECT * FROM org_saved_views WHERE workspace_id = ? AND (owner_id = ? OR shared = 1)',
    workspaceId,
    userId,
  );
  return sortByPosition(rows).map((r) => toSavedView(r, userId));
}

export function createSavedView(ctx: AppContext, userId: string, workspaceId: string, input: SavedPagesViewInput): SavedPagesView {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId);
    const mine = db.all<{ id: string; position: string }>('SELECT id, position FROM org_saved_views WHERE workspace_id = ? AND owner_id = ?', workspaceId, userId);
    if (mine.length >= MAX_VIEWS) throw conflict('Trop de vues enregistrées.');
    const id = newId();
    db.run(
      'INSERT INTO org_saved_views (id, workspace_id, owner_id, name, shared, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      userId,
      cleanName(input.name, 'de la vue'),
      input.shared ? 1 : 0,
      JSON.stringify(cleanViewConfig(input.config)),
      positionForInsert(mine, undefined),
      Date.now(),
    );
    publish(ctx, workspaceId, 'views', input.shared ? undefined : userId);
    return toSavedView(db.get<ViewRowOrg>('SELECT * FROM org_saved_views WHERE id = ?', id)!, userId);
  });
}

function ownView(db: Db, userId: string, viewId: string): ViewRowOrg {
  const row = db.get<ViewRowOrg>('SELECT * FROM org_saved_views WHERE id = ?', viewId);
  // Not yours and not shared (or another workspace): indistinguishable from missing.
  if (!row || !roleOf(db, userId, row.workspace_id) || (row.owner_id !== userId && row.shared !== 1)) throw notFound('Vue introuvable.');
  if (row.owner_id !== userId) throw forbidden('Seul l’auteur d’une vue la modifie.');
  return row;
}

export function updateSavedView(ctx: AppContext, userId: string, viewId: string, input: Partial<SavedPagesViewInput>): SavedPagesView {
  const { db } = ctx;
  return db.tx(() => {
    const row = ownView(db, userId, viewId);
    db.run(
      'UPDATE org_saved_views SET name = ?, shared = ?, config = ? WHERE id = ?',
      input.name !== undefined ? cleanName(input.name, 'de la vue') : row.name,
      input.shared !== undefined ? (input.shared ? 1 : 0) : row.shared,
      input.config ? JSON.stringify(cleanViewConfig(input.config)) : row.config,
      row.id,
    );
    publish(ctx, row.workspace_id, 'views');
    return toSavedView(db.get<ViewRowOrg>('SELECT * FROM org_saved_views WHERE id = ?', row.id)!, userId);
  });
}

export function deleteSavedView(ctx: AppContext, userId: string, viewId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const row = ownView(db, userId, viewId);
    db.run('DELETE FROM org_saved_views WHERE id = ?', row.id);
    publish(ctx, row.workspace_id, 'views');
  });
}

// ---------------------------------------------------------------------------
// Batch actions
// ---------------------------------------------------------------------------

/** Each page goes through the single-page service (its own rights); one refusal does not stop the rest. */
export function batchPages(ctx: AppContext, userId: string, workspaceId: string, input: PagesBatchRequest): PagesBatchResponse {
  const { db } = ctx;
  requireWorkspace(db, userId, workspaceId, 'edit');
  const ids = [...new Set(input.pageIds)];
  if (ids.length > MAX_BATCH) throw badRequest(`${MAX_BATCH} pages au plus par opération.`);
  const done: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    try {
      const access = pageAccess(db, userId, id);
      if (!access || access.page.workspace_id !== workspaceId) throw notFound('Page introuvable.');
      if (input.action === 'trash') trashPage(ctx, userId, id);
      else {
        movePage(ctx, userId, id, {
          parentType: input.parentType,
          parentId: input.parentId,
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.confirmAccess ? { confirmAccess: true } : {}),
        });
      }
      done.push(id);
    } catch (e) {
      // 404 and 403 are reported alike for pages the user does not see: no existence oracle.
      const reason = e instanceof HttpError && e.status !== 404 ? e.message : 'Page introuvable ou non modifiable.';
      failed.push({ id, reason });
    }
  }
  return { done, failed };
}

// ---------------------------------------------------------------------------
// Sidebar folder items (tags and collections placed in a navigation folder)
// ---------------------------------------------------------------------------

/**
 * The folder's own access rules (visible space, edit rights; private folders only for their author)
 * are those of the navigation module; the check is reproduced here from its stored columns.
 */
function folderForItems(db: Db, userId: string, folderId: string): { id: string; workspace_id: string; space: string; owner_id: string | null } {
  const f = db.get<{ id: string; workspace_id: string; space: string; owner_id: string | null }>('SELECT id, workspace_id, space, owner_id FROM nav_folders WHERE id = ?', folderId);
  const role = f ? roleOf(db, userId, f.workspace_id) : null;
  if (!f || !role) throw notFound('Dossier introuvable.');
  if (f.space === 'private') {
    if (f.owner_id !== userId) throw notFound('Dossier introuvable.');
  } else {
    if (f.space !== 'workspace') {
      const root = pageAccess(db, userId, f.space);
      if (!root || root.page.workspace_id !== f.workspace_id || root.page.trashed_at !== null) throw notFound('Dossier introuvable.');
    }
    if (!canEditRole(role)) throw forbidden("Vous n'avez pas les droits de modification.");
  }
  return f;
}

export function listFolderItems(db: Db, userId: string, workspaceId: string): FolderItem[] {
  requireWorkspace(db, userId, workspaceId);
  const rows = db.all<{ folder_id: string; kind: FolderItemKind; ref_id: string; position: string; space: string; owner_id: string | null }>(
    `SELECT i.folder_id, i.kind, i.ref_id, i.position, f.space, f.owner_id FROM org_folder_items i
     JOIN nav_folders f ON f.id = i.folder_id WHERE f.workspace_id = ?`,
    workspaceId,
  );
  const out: FolderItem[] = [];
  for (const r of rows) {
    // Private folders only for their author; teamspace folders only when the teamspace root is visible.
    if (r.space === 'private') {
      if (r.owner_id !== userId) continue;
    } else if (r.space !== 'workspace') {
      const root = pageAccess(db, userId, r.space);
      if (!root || root.page.workspace_id !== workspaceId || root.page.trashed_at !== null) continue;
    }
    out.push({ folderId: r.folder_id, kind: r.kind, refId: r.ref_id, position: r.position });
  }
  return sortByPosition(out.map((o) => ({ ...o, id: `${o.kind}:${o.refId}` })))
    .map(({ id: _id, ...rest }) => rest);
}

export function putFolderItem(ctx: AppContext, userId: string, folderId: string, input: { kind: FolderItemKind; refId: string; after?: string | null }): void {
  const { db } = ctx;
  db.tx(() => {
    const f = folderForItems(db, userId, folderId);
    const exists =
      input.kind === 'tag'
        ? db.get('SELECT 1 AS x FROM org_tags WHERE id = ? AND workspace_id = ?', input.refId, f.workspace_id)
        : db.get('SELECT 1 AS x FROM org_collections WHERE id = ? AND workspace_id = ?', input.refId, f.workspace_id);
    if (!exists) throw notFound('Élément introuvable.');
    const siblings = db
      .all<{ kind: string; ref_id: string; position: string }>('SELECT kind, ref_id, position FROM org_folder_items WHERE folder_id = ?', f.id)
      .map((s) => ({ id: `${s.kind}:${s.ref_id}`, position: s.position }));
    const self = `${input.kind}:${input.refId}`;
    db.run(
      `INSERT INTO org_folder_items (folder_id, kind, ref_id, position) VALUES (?, ?, ?, ?)
       ON CONFLICT(folder_id, kind, ref_id) DO UPDATE SET position = excluded.position`,
      f.id,
      input.kind,
      input.refId,
      positionForInsert(siblings, input.after ?? undefined, self),
    );
    publish(ctx, f.workspace_id, 'folder-items', f.space === 'private' ? userId : undefined);
  });
}

export function removeFolderItem(ctx: AppContext, userId: string, folderId: string, kind: FolderItemKind, refId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const f = folderForItems(db, userId, folderId);
    db.run('DELETE FROM org_folder_items WHERE folder_id = ? AND kind = ? AND ref_id = ?', f.id, kind, refId);
    publish(ctx, f.workspace_id, 'folder-items', f.space === 'private' ? userId : undefined);
  });
}
