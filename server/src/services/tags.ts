// Organize module (wave H3): workspace tags and workspace page properties (outside databases).
// Tags and property definitions are metadata of the workspace (names visible to every member);
// what they are applied to is not: every list goes through visiblePageClause, every write through
// requirePage (invisible → 404). See docs/SPEC.md « Journal quotidien et organisation ».
import {
  newId,
  positionForInsert,
  shortId,
  sortByPosition,
  TAG_COLORS,
  type ApplyTagsRequest,
  type ApplyTagsResponse,
  type CreatePagePropRequest,
  type PageOrganization,
  type PageProp,
  type PagePropOption,
  type PagePropValue,
  type Tag,
  type TagColor,
  type UpdatePagePropRequest,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { canManageRole, pageAccess, pageAudience, requirePage, requireWorkspace, visiblePageClause, visiblePageParams } from '../access.js';

export const MAX_TAGS = 500;
export const MAX_TAGS_PER_PAGE = 30;
export const MAX_PROPS = 30;
export const MAX_OPTIONS = 50;
export const MAX_BATCH = 100;

/** Accent- and case-insensitive key (unique per workspace). */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const isColor = (c: unknown): c is TagColor => typeof c === 'string' && (TAG_COLORS as readonly string[]).includes(c);

function publishOrganize(ctx: AppContext, workspaceId: string, scope: 'tags' | 'props', only?: string | ((userId: string) => boolean)): void {
  ctx.bus.publish(workspaceId, { entity: 'organize', workspaceId, scope }, only);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

interface TagRow {
  id: string;
  workspace_id: string;
  name: string;
  name_key: string;
  color: string;
  created_by: string | null;
}

const toTag = (r: TagRow, pageCount: number): Tag => ({
  id: r.id,
  name: r.name,
  color: isColor(r.color) ? r.color : 'gray',
  pageCount,
  createdBy: r.created_by,
});

function cleanTagName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Le nom du tag est vide.');
  if (name.length > 40) throw badRequest('Le nom du tag est trop long (40 caractères).');
  return name;
}

/** Tags of a workspace with the number of pages the viewer can see (never counts hidden pages). */
export function listTags(db: Db, userId: string, workspaceId: string): Tag[] {
  requireWorkspace(db, userId, workspaceId);
  const rows = db.all<TagRow & { n: number }>(
    `SELECT t.*, (
       SELECT COUNT(*) FROM org_page_tags pt JOIN pages p ON p.id = pt.page_id
       WHERE pt.tag_id = t.id AND p.workspace_id = t.workspace_id AND p.trashed_at IS NULL AND ${visiblePageClause('p')}
     ) AS n
     FROM org_tags t WHERE t.workspace_id = ? ORDER BY t.name_key, t.id`,
    ...visiblePageParams(userId),
    workspaceId,
  );
  return rows.map((r) => toTag(r, r.n));
}

export function createTag(ctx: AppContext, userId: string, workspaceId: string, input: { name: string; color?: TagColor }): Tag {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'edit');
    const name = cleanTagName(input.name);
    const key = nameKey(name);
    if (db.get('SELECT 1 AS x FROM org_tags WHERE workspace_id = ? AND name_key = ?', workspaceId, key)) {
      throw conflict('Un tag porte déjà ce nom.');
    }
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM org_tags WHERE workspace_id = ?', workspaceId)!.n;
    if (count >= MAX_TAGS) throw conflict('Trop de tags dans cet espace.');
    const id = newId();
    db.run(
      'INSERT INTO org_tags (id, workspace_id, name, name_key, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      name,
      key,
      input.color && isColor(input.color) ? input.color : TAG_COLORS[(count * 5) % TAG_COLORS.length]!,
      userId,
      Date.now(),
    );
    publishOrganize(ctx, workspaceId, 'tags');
    return toTag(db.get<TagRow>('SELECT * FROM org_tags WHERE id = ?', id)!, 0);
  });
}

/** Tag of a workspace the user belongs to, else 404. */
export function tagOf(db: Db, userId: string, tagId: string): { tag: TagRow; role: NonNullable<ReturnType<typeof requireWorkspace>['role']> } {
  const tag = db.get<TagRow>('SELECT * FROM org_tags WHERE id = ?', tagId);
  if (!tag) throw notFound('Tag introuvable.');
  try {
    const { role } = requireWorkspace(db, userId, tag.workspace_id);
    return { tag, role };
  } catch {
    throw notFound('Tag introuvable.');
  }
}

export function updateTag(ctx: AppContext, userId: string, tagId: string, input: { name?: string; color?: TagColor }): Tag {
  const { db } = ctx;
  return db.tx(() => {
    const { tag } = tagOf(db, userId, tagId);
    requireWorkspace(db, userId, tag.workspace_id, 'edit');
    let name = tag.name;
    let key = tag.name_key;
    if (input.name !== undefined) {
      name = cleanTagName(input.name);
      key = nameKey(name);
      if (db.get('SELECT 1 AS x FROM org_tags WHERE workspace_id = ? AND name_key = ? AND id != ?', tag.workspace_id, key, tag.id)) {
        throw conflict('Un tag porte déjà ce nom.');
      }
    }
    const color = input.color !== undefined && isColor(input.color) ? input.color : tag.color;
    db.run('UPDATE org_tags SET name = ?, name_key = ?, color = ? WHERE id = ?', name, key, color, tag.id);
    publishOrganize(ctx, tag.workspace_id, 'tags');
    return listTags(db, userId, tag.workspace_id).find((t) => t.id === tag.id)!;
  });
}

/** Author of the tag, workspace owners and admins. Removes the tag from every page. */
export function deleteTag(ctx: AppContext, userId: string, tagId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const { tag, role } = tagOf(db, userId, tagId);
    requireWorkspace(db, userId, tag.workspace_id, 'edit');
    if (tag.created_by !== userId && !canManageRole(role)) {
      throw forbidden('Seuls l’auteur du tag et les administrateurs peuvent le supprimer.');
    }
    // Folder placement is not a foreign key (kind + ref id).
    db.run("DELETE FROM org_folder_items WHERE kind = 'tag' AND ref_id = ?", tag.id);
    db.run('DELETE FROM org_tags WHERE id = ?', tag.id);
    publishOrganize(ctx, tag.workspace_id, 'tags');
  });
}

function tagIdsOf(db: Db, pageId: string): string[] {
  return db
    .all<{ tag_id: string }>('SELECT pt.tag_id FROM org_page_tags pt JOIN org_tags t ON t.id = pt.tag_id WHERE pt.page_id = ? ORDER BY t.name_key, t.id', pageId)
    .map((r) => r.tag_id);
}

/** Replaces the tags of a page. Needs edit rights on the page; tags must belong to its workspace. */
export function setPageTags(ctx: AppContext, userId: string, pageId: string, tagIds: string[]): string[] {
  const { db } = ctx;
  return db.tx(() => {
    const { page } = requirePage(db, userId, pageId, 'edit');
    if (page.trashed_at !== null) throw badRequest('La page est dans la corbeille.');
    const unique = [...new Set(tagIds)];
    if (unique.length > MAX_TAGS_PER_PAGE) throw badRequest(`Une page porte ${MAX_TAGS_PER_PAGE} tags au plus.`);
    for (const id of unique) {
      if (!db.get('SELECT 1 AS x FROM org_tags WHERE id = ? AND workspace_id = ?', id, page.workspace_id)) throw notFound('Tag introuvable.');
    }
    db.run('DELETE FROM org_page_tags WHERE page_id = ?', page.id);
    for (const id of unique) db.run('INSERT INTO org_page_tags (page_id, tag_id) VALUES (?, ?)', page.id, id);
    publishOrganize(ctx, page.workspace_id, 'tags', pageAudience(db, page));
    return tagIdsOf(db, page.id);
  });
}

/**
 * Batch add/remove. Each page is checked on its own: pages the user does not see or cannot edit are
 * counted as skipped (invisible and read-only are indistinguishable, so nothing leaks).
 */
export function applyTags(ctx: AppContext, userId: string, workspaceId: string, input: ApplyTagsRequest): ApplyTagsResponse {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'edit');
    const pageIds = [...new Set(input.pageIds)];
    if (pageIds.length > MAX_BATCH) throw badRequest(`${MAX_BATCH} pages au plus par opération.`);
    const add = [...new Set(input.add ?? [])];
    const remove = [...new Set(input.remove ?? [])];
    if (add.length > MAX_TAGS_PER_PAGE || remove.length > MAX_TAGS_PER_PAGE) throw badRequest('Trop de tags.');
    for (const id of [...add, ...remove]) {
      if (!db.get('SELECT 1 AS x FROM org_tags WHERE id = ? AND workspace_id = ?', id, workspaceId)) throw notFound('Tag introuvable.');
    }
    let changed = 0;
    let skipped = 0;
    for (const id of pageIds) {
      const access = pageAccess(db, userId, id);
      if (!access || !access.canEdit || access.page.workspace_id !== workspaceId || access.page.trashed_at !== null) {
        skipped++;
        continue;
      }
      const have = new Set(tagIdsOf(db, id));
      const next = new Set(have);
      remove.forEach((t) => next.delete(t));
      add.forEach((t) => next.add(t));
      if (next.size > MAX_TAGS_PER_PAGE) {
        skipped++;
        continue;
      }
      let touched = false;
      for (const t of remove) if (have.has(t)) { db.run('DELETE FROM org_page_tags WHERE page_id = ? AND tag_id = ?', id, t); touched = true; }
      for (const t of add) if (!have.has(t)) { db.run('INSERT INTO org_page_tags (page_id, tag_id) VALUES (?, ?)', id, t); touched = true; }
      if (touched) {
        changed++;
        publishOrganize(ctx, workspaceId, 'tags', pageAudience(db, access.page));
      }
    }
    return { changed, skipped };
  });
}

// ---------------------------------------------------------------------------
// Workspace page properties
// ---------------------------------------------------------------------------

interface PropRow {
  id: string;
  workspace_id: string;
  name: string;
  type: PageProp['type'];
  options: string;
  display: PageProp['display'];
  position: string;
}

const toProp = (r: PropRow): PageProp => ({
  id: r.id,
  name: r.name,
  type: r.type,
  options: parseJson<PagePropOption[]>(r.options, []),
  display: r.display,
  position: r.position,
});

export function listProps(db: Db, userId: string, workspaceId: string): PageProp[] {
  requireWorkspace(db, userId, workspaceId);
  return sortByPosition(db.all<PropRow>('SELECT * FROM org_page_props WHERE workspace_id = ?', workspaceId)).map(toProp);
}

function cleanOptions(raw: PagePropOption[] | undefined): PagePropOption[] {
  const out: PagePropOption[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const o of raw ?? []) {
    const name = String(o.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40) throw badRequest('Nom d’option invalide (1 à 40 caractères).');
    const key = nameKey(name);
    if (names.has(key)) throw badRequest('Deux options portent le même nom.');
    names.add(key);
    let id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : shortId(8);
    while (ids.has(id)) id = shortId(8);
    ids.add(id);
    out.push({ id, name, color: isColor(o.color) ? o.color : 'gray' });
  }
  if (out.length > MAX_OPTIONS) throw badRequest(`${MAX_OPTIONS} options au plus.`);
  return out;
}

function cleanPropName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('Le nom de la propriété est vide.');
  if (name.length > 60) throw badRequest('Le nom de la propriété est trop long (60 caractères).');
  return name;
}

export function createProp(ctx: AppContext, userId: string, workspaceId: string, input: CreatePagePropRequest): PageProp {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'edit');
    const name = cleanPropName(input.name);
    const existing = db.all<PropRow>('SELECT * FROM org_page_props WHERE workspace_id = ?', workspaceId);
    if (existing.length >= MAX_PROPS) throw conflict('Trop de propriétés dans cet espace.');
    if (existing.some((p) => nameKey(p.name) === nameKey(name))) throw conflict('Une propriété porte déjà ce nom.');
    const options = input.type === 'select' ? cleanOptions(input.options) : [];
    const id = newId();
    db.run(
      'INSERT INTO org_page_props (id, workspace_id, name, type, options, display, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      name,
      input.type,
      JSON.stringify(options),
      input.display ?? 'hide_empty',
      positionForInsert(existing, undefined),
      userId,
      Date.now(),
    );
    publishOrganize(ctx, workspaceId, 'props');
    return toProp(db.get<PropRow>('SELECT * FROM org_page_props WHERE id = ?', id)!);
  });
}

function propOf(db: Db, userId: string, propId: string): PropRow {
  const prop = db.get<PropRow>('SELECT * FROM org_page_props WHERE id = ?', propId);
  if (!prop) throw notFound('Propriété introuvable.');
  try {
    requireWorkspace(db, userId, prop.workspace_id);
  } catch {
    throw notFound('Propriété introuvable.');
  }
  return prop;
}

export function updateProp(ctx: AppContext, userId: string, propId: string, input: UpdatePagePropRequest): PageProp {
  const { db } = ctx;
  return db.tx(() => {
    const prop = propOf(db, userId, propId);
    requireWorkspace(db, userId, prop.workspace_id, 'edit');
    let name = prop.name;
    if (input.name !== undefined) {
      name = cleanPropName(input.name);
      const others = db.all<PropRow>('SELECT * FROM org_page_props WHERE workspace_id = ? AND id != ?', prop.workspace_id, prop.id);
      if (others.some((p) => nameKey(p.name) === nameKey(name))) throw conflict('Une propriété porte déjà ce nom.');
    }
    let options = prop.options;
    if (input.options !== undefined) {
      if (prop.type !== 'select') throw badRequest('Seule une propriété de sélection a des options.');
      const clean = cleanOptions(input.options);
      options = JSON.stringify(clean);
      // Values pointing to a removed option are dropped.
      const keep = new Set(clean.map((o) => o.id));
      for (const v of db.all<{ page_id: string; value: string }>('SELECT page_id, value FROM org_page_prop_values WHERE prop_id = ?', prop.id)) {
        if (!keep.has(parseJson<string>(v.value, ''))) db.run('DELETE FROM org_page_prop_values WHERE page_id = ? AND prop_id = ?', v.page_id, prop.id);
      }
    }
    let position = prop.position;
    if (input.after !== undefined) {
      const sibs = db.all<{ id: string; position: string }>('SELECT id, position FROM org_page_props WHERE workspace_id = ?', prop.workspace_id);
      position = positionForInsert(sibs, input.after, prop.id);
    }
    db.run('UPDATE org_page_props SET name = ?, options = ?, display = ?, position = ? WHERE id = ?', name, options, input.display ?? prop.display, position, prop.id);
    publishOrganize(ctx, prop.workspace_id, 'props');
    return toProp(db.get<PropRow>('SELECT * FROM org_page_props WHERE id = ?', prop.id)!);
  });
}

/** Owners and admins only (the values of every page go with it). */
export function deleteProp(ctx: AppContext, userId: string, propId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const prop = propOf(db, userId, propId);
    requireWorkspace(db, userId, prop.workspace_id, 'manage');
    db.run('DELETE FROM org_page_props WHERE id = ?', prop.id);
    publishOrganize(ctx, prop.workspace_id, 'props');
  });
}

/** Validates a value for a definition; returns the value to store (null = clear). */
export function validatePropValue(prop: Pick<PageProp, 'type' | 'options'>, value: unknown): PagePropValue {
  if (value === null || value === undefined || value === '') return null;
  switch (prop.type) {
    case 'text':
      if (typeof value !== 'string') throw badRequest('Valeur de texte attendue.');
      if (value.length > 2000) throw badRequest('Texte trop long (2000 caractères).');
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e15) throw badRequest('Nombre attendu.');
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') throw badRequest('Valeur booléenne attendue.');
      return value;
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest('Date attendue (AAAA-MM-JJ).');
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw badRequest('Date invalide.');
      return value;
    }
    case 'select':
      if (typeof value !== 'string' || !prop.options.some((o) => o.id === value)) throw badRequest('Option inconnue.');
      return value;
  }
}

/** Sets (or clears) the value of a workspace property on a page the user can edit. */
export function setPropValue(ctx: AppContext, userId: string, pageId: string, propId: string, value: unknown): PagePropValue {
  const { db } = ctx;
  return db.tx(() => {
    const { page } = requirePage(db, userId, pageId, 'edit');
    if (page.trashed_at !== null) throw badRequest('La page est dans la corbeille.');
    const row = db.get<PropRow>('SELECT * FROM org_page_props WHERE id = ? AND workspace_id = ?', propId, page.workspace_id);
    if (!row) throw notFound('Propriété introuvable.');
    const clean = validatePropValue(toProp(row), value);
    if (clean === null) db.run('DELETE FROM org_page_prop_values WHERE page_id = ? AND prop_id = ?', page.id, row.id);
    else {
      db.run(
        `INSERT INTO org_page_prop_values (page_id, prop_id, value) VALUES (?, ?, ?)
         ON CONFLICT(page_id, prop_id) DO UPDATE SET value = excluded.value`,
        page.id,
        row.id,
        JSON.stringify(clean),
      );
    }
    publishOrganize(ctx, page.workspace_id, 'props', pageAudience(db, page));
    return clean;
  });
}

/** Tags and property values of a visible page (what the header shows). */
export function pageOrganization(db: Db, userId: string, pageId: string): PageOrganization {
  const access = pageAccess(db, userId, pageId);
  if (!access) throw notFound('Page introuvable.');
  const props: Record<string, PagePropValue> = {};
  for (const v of db.all<{ prop_id: string; value: string }>('SELECT prop_id, value FROM org_page_prop_values WHERE page_id = ?', pageId)) {
    props[v.prop_id] = parseJson<PagePropValue>(v.value, null);
  }
  return { tagIds: tagIdsOf(db, pageId), props };
}
