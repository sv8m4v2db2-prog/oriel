// Page tree operations (ARCHITECTURE §3.4): create, update, move, trash/restore/delete, duplicate,
// publish, favorites. Every write runs in a transaction and publishes invalidations after commit.
import {
  LIMITS,
  newId,
  positionForInsert,
  type Change,
  type Cover,
  type PageFormat,
  type PageKind,
  type ParentType,
  type PropertyDef,
  type PropertyValue,
  type ViewConfig,
  type Visibility,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { PAGE_COLUMNS, parseJson, type DatabaseRow, type PageRow, type ViewRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { visiblePageClause, visiblePageParams } from '../access.js';
import { applySubtreeAccess, canManageTeamspace, isTeamspaceRoot, moveAccess, teamspaceOf } from './teamspaces.js';
import { canManageRole } from '../access.js';
import { canSeePage, getPageRow, isPubliclyVisible, isSelfOrDescendant, pageAudience, requirePage, requireWorkspace, subtreeIds } from '../access.js';
import {
  assignUniqueIds,
  initDatabase,
  loadSchema,
  mergePropertyValues,
  relationsAfterDuplicate,
  relationsAfterRestore,
  relationsAfterTrash,
  relationsBeforeDelete,
  syncRowRelations,
  withPrivateForm,
} from './databases.js';
import { indexPage, removeFromIndex } from './search.js';
import { syncPropertyReminders } from '../collab/propertyReminders.js';
import { remapState } from '../content/ydoc.js';
import { CANVAS_DEFAULT_ICON } from '../canvas/service.js';
import { isCanvasRow, remapCanvasState } from '../canvas/content.js';
import { recordSyncedRefs } from '../content/synced.js';

// ---------------------------------------------------------------------------
// Invalidation helpers
// ---------------------------------------------------------------------------

export function pageChange(page: Pick<PageRow, 'id' | 'kind' | 'parent_type' | 'parent_id'>, affectsTree: boolean): Change {
  const isRow = page.parent_type === 'database';
  return {
    entity: 'page',
    id: page.id,
    kind: page.kind,
    parentType: page.parent_type,
    parentId: page.parent_id,
    databaseId: isRow ? page.parent_id : null,
    affectsTree: affectsTree && !isRow,
  };
}

/**
 * Publishes a page change; private pages only reach their owner, pages of a restricted teamspace its
 * members (QA-G7-04), unless `everyone` (visibility transitions).
 */
export function emitPage(
  ctx: AppContext,
  page: Pick<PageRow, 'id' | 'kind' | 'parent_type' | 'parent_id' | 'workspace_id' | 'visibility' | 'owner_id'> & { teamspace_id?: string | null },
  affectsTree: boolean,
  opts: { everyone?: boolean } = {},
): void {
  ctx.bus.publish(page.workspace_id, pageChange(page, affectsTree), opts.everyone ? undefined : pageAudience(ctx.db, page));
}

export function emitTrash(ctx: AppContext, page: Pick<PageRow, 'id' | 'workspace_id' | 'visibility' | 'owner_id'> & { teamspace_id?: string | null }): void {
  ctx.bus.publish(page.workspace_id, { entity: 'trash', workspaceId: page.workspace_id }, pageAudience(ctx.db, page));
}

/** Format without the teamspace marker (navigation module). */
function withoutTeamspaceMarker(format: string): string {
  const parsed = parseJson<PageFormat>(format, {});
  if (parsed.teamspaceRoot === undefined) return format;
  delete parsed.teamspaceRoot;
  return JSON.stringify(parsed);
}

/**
 * User decision (QA-CORE-09, QA-G7-02): only workspace owners/admins make a page a teamspace. A page
 * still carrying the marker (former teamspace moved away, marker set while nested) that an editor
 * brings to the shared root arrives as a plain page.
 */
function dropMarkerUnlessManager(db: Db, role: Parameters<typeof canManageRole>[0], pageId: string): void {
  if (canManageRole(role)) return;
  const row = getPageRow(db, pageId);
  if (!row || !isTeamspaceRoot(row) || row.visibility !== 'workspace') return;
  db.run('UPDATE pages SET format = ? WHERE id = ?', withoutTeamspaceMarker(row.format), pageId);
}

function siblings(db: Db, parentType: ParentType, parentId: string): Array<{ id: string; position: string }> {
  return db.all<{ id: string; position: string }>('SELECT id, position FROM pages WHERE parent_type = ? AND parent_id = ?', parentType, parentId);
}

const clampTitle = (title: string) => title.slice(0, LIMITS.titleLength);

/**
 * Public (anonymous) collab connections are only checked when they open a document: once a page
 * stops being published (trashed, moved out of a published tree), close those that remain.
 */
function closeUnpublishedAfterCommit(ctx: AppContext, ids: string[]): void {
  ctx.db.afterCommit(() => {
    const gone = ids.filter((id) => !isPubliclyVisible(ctx.db, id));
    if (gone.length > 0) ctx.collab.closeDocuments(gone, { onlyAnonymous: true });
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePageInput {
  id?: string;
  parentType: ParentType;
  parentId: string;
  kind?: PageKind;
  title?: string;
  icon?: string | null;
  cover?: Cover | null;
  visibility?: Visibility;
  properties?: Record<string, unknown>;
  isInline?: boolean;
  emptyDatabase?: boolean;
  after?: string | null;
  /** Canvas module (H1): whiteboard page. Fixed at creation (format.layout), never a database or a row. */
  layout?: 'canvas';
}

/** Creates a page/database/row. Caller must have checked workspace edit rights (re-checked here). */
export function createPage(ctx: AppContext, actorId: string, workspaceId: string, input: CreatePageInput): PageRow {
  const { db } = ctx;
  const { role } = requireWorkspace(db, actorId, workspaceId, 'edit');
  const kind: PageKind = input.kind ?? 'page';
  if (input.layout === 'canvas' && (kind !== 'page' || input.parentType === 'database')) {
    throw badRequest('Un canevas est une page : ni une base de données, ni une ligne de base.');
  }
  const created = db.tx(() => {
    let visibility: Visibility;
    let ownerId = actorId;
    let properties: Record<string, PropertyValue> = {};
    let title = clampTitle(input.title ?? '');
    let schema: PropertyDef[] | null = null;

    if (input.parentType === 'workspace') {
      if (input.parentId !== workspaceId) throw badRequest('Parent invalide.');
      visibility = input.visibility ?? 'workspace';
    } else {
      const parent = getPageRow(db, input.parentId);
      if (!parent || parent.workspace_id !== workspaceId || !canSeePage(actorId, role, parent, db)) {
        throw notFound('Page parente introuvable.');
      }
      if (parent.trashed_at !== null) throw badRequest('La page parente est dans la corbeille.');
      if (input.parentType === 'page' && parent.kind !== 'page') throw badRequest('Le parent doit être une page.');
      if (input.parentType === 'database') {
        if (parent.kind !== 'database') throw badRequest('Le parent doit être une base de données.');
        if (kind !== 'page') throw badRequest('Une ligne de base de données ne peut pas être une base.');
        schema = loadSchema(db, parent.id).properties;
      }
      visibility = parent.visibility;
      if (parent.visibility === 'private') ownerId = parent.owner_id;
    }

    if (input.properties && Object.keys(input.properties).length > 0) {
      if (!schema) throw badRequest('Seules les lignes de base de données ont des propriétés.');
      const merged = mergePropertyValues(db, schema, {}, input.properties, workspaceId, actorId);
      properties = merged.properties;
      if (merged.title !== undefined && input.title === undefined) title = clampTitle(merged.title);
    }
    if (schema) assignUniqueIds(db, input.parentId, schema, properties);

    const id = input.id ?? newId();
    if (getPageRow(db, id)) throw conflict('Une page avec cet identifiant existe déjà.');
    const position = positionForInsert(siblings(db, input.parentType, input.parentId), input.after);
    const now = Date.now();
    const isInline = kind === 'database' && input.parentType === 'page' && input.isInline === true;
    db.run(
      `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, icon, cover, position, visibility, owner_id,
         properties, format, is_inline, is_public, created_at, created_by, updated_at, updated_by, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`,
      id,
      workspaceId,
      input.parentType,
      input.parentId,
      kind,
      title,
      input.icon !== undefined ? input.icon : input.layout === 'canvas' ? CANVAS_DEFAULT_ICON : null,
      input.cover ? JSON.stringify(input.cover) : null,
      position,
      visibility,
      ownerId,
      JSON.stringify(properties),
      input.layout === 'canvas' ? JSON.stringify({ layout: 'canvas' }) : '{}',
      isInline,
      now,
      actorId,
      now,
      actorId,
    );
    if (schema) syncRowRelations(ctx, actorId, id, {}); // two-way relations (database module)
    // Default reminders of date properties: a row created with a date (API, form, template…) gets them too.
    if (schema) syncPropertyReminders(db, actorId, { id, workspace_id: workspaceId }, schema, {}, properties, now);
    const page = getPageRow(db, id)!;
    if (kind === 'database') initDatabase(db, page, actorId, !input.emptyDatabase, now);
    indexPage(db, page, '');
    emitPage(ctx, page, true);
    return page;
  });
  return created;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdatePageInput {
  title?: string;
  icon?: string | null;
  cover?: Cover | null;
  /** Merged key by key; null removes a key. */
  format?: { [K in keyof PageFormat]?: PageFormat[K] | null };
  properties?: Record<string, unknown>;
}

export function updatePage(ctx: AppContext, actorId: string, pageId: string, input: UpdatePageInput): PageRow {
  const { db } = ctx;
  return db.tx(() => {
    const { page, role } = requirePage(db, actorId, pageId, 'edit');
    // Trashed pages (and rows of a trashed database) are read-only, like for move and content (QA-INT-04).
    if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de la modifier.');
    // Navigation module (user decision, QA-CORE-09): only workspace owners/admins turn a page into a
    // teamspace or remove the marker — it reorganizes everyone's sidebar.
    if (
      input.format?.teamspaceRoot !== undefined &&
      (input.format.teamspaceRoot === true) !== (parseJson<PageFormat>(page.format, {}).teamspaceRoot === true) &&
      !canManageRole(role)
    ) {
      throw forbidden("Seuls les propriétaires et administrateurs de l'espace peuvent transformer une page en espace d'équipe.");
    }
    let title = page.title;
    let properties = parseJson<Record<string, PropertyValue>>(page.properties, {});
    if (input.properties && Object.keys(input.properties).length > 0) {
      if (page.parent_type !== 'database') throw badRequest('Seules les lignes de base de données ont des propriétés.');
      const schema = loadSchema(db, page.parent_id).properties;
      const merged = mergePropertyValues(db, schema, properties, input.properties, page.workspace_id, actorId);
      properties = merged.properties;
      if (merged.title !== undefined) title = clampTitle(merged.title);
    }
    if (input.title !== undefined) title = clampTitle(input.title);
    const icon = input.icon !== undefined ? input.icon : page.icon;
    const cover = input.cover !== undefined ? (input.cover ? JSON.stringify(input.cover) : null) : page.cover;
    let format = page.format;
    if (input.format) {
      const merged: PageFormat = { ...parseJson<PageFormat>(page.format, {}) };
      for (const [k, v] of Object.entries(input.format)) {
        if (v === undefined || v === null) delete (merged as Record<string, unknown>)[k];
        else (merged as Record<string, unknown>)[k] = v;
      }
      format = JSON.stringify(merged);
    }
    db.run(
      `UPDATE pages SET title = ?, icon = ?, cover = ?, format = ?, properties = ?, updated_at = ?, updated_by = ?, version = version + 1
       WHERE id = ?`,
      title,
      icon,
      cover,
      format,
      JSON.stringify(properties),
      Date.now(),
      actorId,
      pageId,
    );
    if (page.parent_type === 'database' && input.properties && Object.keys(input.properties).length > 0) {
      syncRowRelations(ctx, actorId, pageId, parseJson<Record<string, PropertyValue>>(page.properties, {})); // two-way relations
      // Default reminders of date properties (G1 / D26).
      syncPropertyReminders(db, actorId, page, loadSchema(db, page.parent_id).properties, parseJson<Record<string, PropertyValue>>(page.properties, {}), properties);
    }
    const updated = getPageRow(db, pageId)!;
    if (title !== page.title) indexPage(db, updated);
    emitPage(ctx, updated, title !== page.title || icon !== page.icon || input.format?.teamspaceRoot !== undefined || input.format?.sharedShortcut !== undefined);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

export interface MovePageInput {
  parentType: ParentType;
  parentId: string;
  visibility?: Visibility;
  after?: string | null;
  /** Navigation module: explicit consent to a move that widens access across teamspaces. */
  confirmAccess?: boolean;
}

export function movePage(ctx: AppContext, actorId: string, pageId: string, input: MovePageInput): PageRow {
  const { db } = ctx;
  let closeForOthers: { ids: string[]; owner: string } | null = null;
  const result = db.tx(() => {
    const { page, role } = requirePage(db, actorId, pageId, 'edit');
    if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de la déplacer.');
    const now = Date.now();

    if (page.parent_type === 'database') {
      if (input.parentType !== 'database' || input.parentId !== page.parent_id) {
        throw badRequest("Une ligne ne peut être déplacée qu'au sein de sa base de données.");
      }
      const position = positionForInsert(siblings(db, 'database', page.parent_id), input.after, page.id);
      db.run('UPDATE pages SET position = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?', position, now, actorId, page.id);
      const moved = getPageRow(db, page.id)!;
      emitPage(ctx, moved, false);
      return moved;
    }

    if (input.parentType === 'database') throw badRequest('Seules les lignes peuvent être placées dans une base de données.');
    const wasPublic = isPubliclyVisible(db, page.id);
    let visibility: Visibility;
    if (input.parentType === 'workspace') {
      if (input.parentId !== page.workspace_id) throw badRequest('Destination invalide.');
      visibility = input.visibility ?? page.visibility;
    } else {
      const parent = getPageRow(db, input.parentId);
      if (!parent || parent.workspace_id !== page.workspace_id || !canSeePage(actorId, role, parent, db)) {
        throw notFound('Page de destination introuvable.');
      }
      if (parent.trashed_at !== null) throw badRequest('La page de destination est dans la corbeille.');
      if (parent.kind !== 'page') throw badRequest('La destination doit être une page.');
      if (isSelfOrDescendant(db, parent.id, page.id)) {
        throw badRequest("Impossible de déplacer une page dans elle-même ou dans l'une de ses sous-pages.");
      }
      visibility = parent.visibility;
    }
    // Navigation module: teamspace roots stay at the root, restricted teamspaces propagate to the
    // subtree, and a move widening access across teamspaces needs explicit consent.
    const navAccess = moveAccess(db, actorId, page, input);
    if (navAccess.needsConfirm && input.confirmAccess !== true) {
      throw conflict('Ce déplacement élargit l’accès à ces pages : confirmez-le explicitement.');
    }
    // User decision (QA-CORE-09, QA-G7-02): taking an open teamspace off the shared root dissolves it,
    // which only workspace owners/admins may do; any editor may still reorder it among root pages.
    const wasTeamspaceRoot = isTeamspaceRoot(page);
    if (
      wasTeamspaceRoot &&
      page.visibility === 'workspace' && // restricted roots: moveAccess only lets them be reordered
      (input.parentType !== 'workspace' || navAccess.place.visibility !== 'workspace') &&
      !canManageRole(role)
    ) {
      throw forbidden("Seuls les propriétaires et administrateurs de l'espace peuvent déplacer un espace d'équipe hors de la racine.");
    }
    visibility = navAccess.place.visibility;
    const teamspaceChanged = (navAccess.place.teamspaceId ?? null) !== (page.teamspace_id ?? null);

    const position = positionForInsert(siblings(db, input.parentType, input.parentId), input.after, page.id);
    db.run(
      'UPDATE pages SET parent_type = ?, parent_id = ?, position = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?',
      input.parentType,
      input.parentId,
      position,
      now,
      actorId,
      page.id,
    );
    const visibilityChanged = visibility !== page.visibility || teamspaceChanged;
    if (visibilityChanged && visibility === 'teamspace') {
      const ids = subtreeIds(db, page.id);
      applySubtreeAccess(db, ids, navAccess.place);
      db.afterCommit(() => ctx.collab.closeUnauthorized?.(ids));
    } else if (visibilityChanged) {
      const ids = subtreeIds(db, page.id);
      for (const id of ids) {
        if (visibility === 'private') db.run("UPDATE pages SET visibility = 'private', owner_id = ? WHERE id = ?", actorId, id);
        else db.run("UPDATE pages SET visibility = 'workspace' WHERE id = ?", id);
      }
      if (visibility === 'private') closeForOthers = { ids, owner: actorId };
    }
    if (!wasTeamspaceRoot && input.parentType === 'workspace') dropMarkerUnlessManager(db, role, page.id);
    const moved = getPageRow(db, page.id)!;
    if (wasPublic && !isPubliclyVisible(db, page.id)) closeUnpublishedAfterCommit(ctx, subtreeIds(db, page.id));
    // A page leaving or entering the shared section must refresh everyone's sidebar.
    emitPage(ctx, moved, true, { everyone: visibilityChanged });
    return moved;
  });
  if (closeForOthers) {
    const c: { ids: string[]; owner: string } = closeForOthers;
    ctx.collab.closeDocuments(c.ids, { keepUserId: c.owner });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Trash / restore / permanent delete
// ---------------------------------------------------------------------------

export function trashPage(ctx: AppContext, actorId: string, pageId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const { page, role } = requirePage(db, actorId, pageId, 'edit');
    if (page.trashed_at !== null) return;
    // The root takes the whole teamspace with it: its owners and the workspace admins only (QA-G7-05).
    if (isTeamspaceRoot(page) && !canManageRole(role)) {
      const ts = teamspaceOf(db, page);
      if (!ts || !canManageTeamspace(db, ts, actorId)) {
        throw forbidden("Seuls les propriétaires de l'espace d'équipe et les administrateurs de l'espace peuvent le mettre à la corbeille.");
      }
    }
    const now = Date.now();
    db.run(
      `WITH RECURSIVE d(id) AS (
         SELECT ?
         UNION
         SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id AND p.parent_type IN ('page', 'database')
       )
       UPDATE pages SET trashed_at = ?, trashed_by = ?, trash_root = (id = ?), version = version + 1
       WHERE id IN (SELECT id FROM d) AND trashed_at IS NULL`,
      page.id,
      now,
      actorId,
      page.id,
    );
    relationsAfterTrash(ctx, actorId, subtreeIds(db, page.id)); // two-way relations
    const trashed = subtreeIds(db, page.id);
    closeUnpublishedAfterCommit(ctx, trashed);
    db.afterCommit(() => ctx.collab.refreshReadOnly(trashed)); // QA-EDT-02
    emitPage(ctx, page, true);
    emitTrash(ctx, page);
  });
}

export function restorePage(ctx: AppContext, actorId: string, pageId: string): PageRow {
  const { db } = ctx;
  return db.tx(() => {
    const { page, role } = requirePage(db, actorId, pageId, 'edit');
    if (page.trashed_at === null) return page;
    let moveToRoot = false;
    /** Navigation module: new parent of a restricted teamspace page whose parent is gone (QA-G7-01). */
    let teamspaceRootId: string | null = null;
    if (page.parent_type !== 'workspace') {
      const parent = getPageRow(db, page.parent_id);
      if (!parent || parent.trashed_at !== null) {
        if (page.parent_type === 'database') throw conflict("Restaurez d'abord la base de données de cette ligne.");
        if (page.visibility === 'teamspace') {
          // At the root it would look like a teamspace of its own, listed to the whole workspace.
          const root = page.teamspace_id ? getPageRow(db, page.teamspace_id) : undefined;
          if (!root || root.id === page.id || root.trashed_at !== null || root.parent_type !== 'workspace') {
            throw conflict("Restaurez d'abord l'espace d'équipe de cette page.");
          }
          teamspaceRootId = root.id;
        } else moveToRoot = true;
      }
    }
    const now = Date.now();
    // Descendants trashed with this page: same timestamp and not trashed on their own (trash_root = 0).
    // The timestamp alone is not enough: two deletions may share a millisecond (QA-INT-01).
    db.run(
      `WITH RECURSIVE d(id) AS (
         SELECT ?
         UNION
         SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id AND p.parent_type IN ('page', 'database')
         WHERE p.trashed_at = ? AND p.trash_root = 0
       )
       UPDATE pages SET trashed_at = NULL, trashed_by = NULL, trash_root = 0, version = version + 1
       WHERE id IN (SELECT id FROM d)`,
      page.id,
      page.trashed_at,
    );
    if (moveToRoot) {
      const position = positionForInsert(siblings(db, 'workspace', page.workspace_id), undefined, page.id);
      db.run(
        "UPDATE pages SET parent_type = 'workspace', parent_id = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        page.workspace_id,
        position,
        now,
        actorId,
        page.id,
      );
      dropMarkerUnlessManager(db, role, page.id); // QA-G7-02
    }
    if (teamspaceRootId) {
      const position = positionForInsert(siblings(db, 'page', teamspaceRootId), undefined, page.id);
      db.run(
        "UPDATE pages SET parent_type = 'page', parent_id = ?, position = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        teamspaceRootId,
        position,
        now,
        actorId,
        page.id,
      );
    }
    relationsAfterRestore(ctx, actorId, subtreeIds(db, page.id)); // two-way relations
    const restored = getPageRow(db, page.id)!;
    const restoredIds = subtreeIds(db, page.id);
    db.afterCommit(() => ctx.collab.refreshReadOnly(restoredIds)); // QA-EDT-02
    emitPage(ctx, restored, true);
    emitTrash(ctx, restored);
    return restored;
  });
}

/** Deletes a subtree for good (no permission check; used by the purge job too). */
export function deleteSubtree(ctx: AppContext, root: PageRow): string[] {
  const { db } = ctx;
  const ids = subtreeIds(db, root.id);
  relationsBeforeDelete(ctx, ids); // relation values pointing to deleted rows
  for (const id of ids) removeFromIndex(db, id);
  db.run(
    `WITH RECURSIVE d(id) AS (
       SELECT ?
       UNION
       SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id AND p.parent_type IN ('page', 'database')
     )
     DELETE FROM pages WHERE id IN (SELECT id FROM d)`,
    root.id,
  );
  emitPage(ctx, root, true);
  emitTrash(ctx, root);
  db.afterCommit(() => ctx.collab.closeDocuments(ids));
  return ids;
}

export function destroyPage(ctx: AppContext, actorId: string, pageId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const { page } = requirePage(db, actorId, pageId, 'edit');
    if (page.trashed_at === null) throw conflict("La page doit d'abord être placée dans la corbeille.");
    deleteSubtree(ctx, page);
  });
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

/** Options of duplicatePage (editor module: instantiating a page template elsewhere). */
export interface DuplicateOptions {
  /** Where to put the copy (default: right after the original, same parent). */
  target?: { parentType: 'workspace' | 'page'; parentId: string; visibility?: Visibility; after?: string | null };
  /** Title of the copy (default: "<title> (copie)"). */
  title?: string;
  /** Database module (rows from templates): id of the root copy. */
  id?: string;
  /** Database module: property values overriding the root row's ones. */
  properties?: Record<string, unknown>;
  /** Database module: position of the root copy among its siblings (default: after the original). */
  position?: { after?: string | null };
  /** Database module: the root copy is a row template (true) or a regular row (false). */
  asTemplate?: boolean;
}

export function duplicatePage(ctx: AppContext, actorId: string, pageId: string, opts: DuplicateOptions = {}): PageRow {
  const { db } = ctx;
  return db.tx(() => {
    // Copying elsewhere (template) only needs read access to the source, plus edit rights on the workspace.
    const { page, role } = requirePage(db, actorId, pageId, opts.target ? 'read' : 'edit');
    if (page.trashed_at !== null) throw badRequest('Impossible de dupliquer une page qui est dans la corbeille.');
    if (isTeamspaceRoot(page)) throw badRequest('Un espace d’équipe ne se duplique pas : dupliquez plutôt ses pages.');
    let placement: { parentType: ParentType; parentId: string; visibility: Visibility; ownerId: string; after?: string | null } | null = null;
    if (opts.target) {
      requireWorkspace(db, actorId, page.workspace_id, 'edit');
      const t = opts.target;
      if (t.parentType === 'workspace') {
        if (t.parentId !== page.workspace_id) throw badRequest('Destination invalide.');
        const visibility = t.visibility ?? 'workspace';
        placement = { parentType: 'workspace', parentId: t.parentId, visibility, ownerId: actorId, after: t.after };
      } else {
        const parent = getPageRow(db, t.parentId);
        if (!parent || parent.workspace_id !== page.workspace_id || !canSeePage(actorId, role, parent, db)) {
          throw notFound('Page de destination introuvable.');
        }
        if (parent.trashed_at !== null) throw badRequest('La page de destination est dans la corbeille.');
        if (parent.kind !== 'page') throw badRequest('La destination doit être une page.');
        placement = {
          parentType: 'page',
          parentId: parent.id,
          visibility: parent.visibility,
          ownerId: parent.visibility === 'private' ? parent.owner_id : actorId,
          after: t.after,
        };
      }
    }
    const rootTitle = clampTitle(opts.title ?? `${page.title || 'Sans titre'} (copie)`);

    // Non-trashed subtree, parents before children.
    const nodes: PageRow[] = [page];
    for (let i = 0; i < nodes.length; i++) {
      nodes.push(
        ...db.all<PageRow>(
          `SELECT ${PAGE_COLUMNS} FROM pages WHERE parent_id = ? AND parent_type IN ('page', 'database') AND trashed_at IS NULL
           ORDER BY position, id`,
          nodes[i]!.id,
        ),
      );
    }
    if (opts.id && getPageRow(db, opts.id)) throw conflict('Une page avec cet identifiant existe déjà.');
    const idMap = new Map(nodes.map((n) => [n.id, n.id === page.id && opts.id ? opts.id : newId()] as const));
    const now = Date.now();
    const schemaCache = new Map<string, PropertyDef[]>();
    const schemaOf = (databaseId: string) => {
      let s = schemaCache.get(databaseId);
      if (!s) {
        s = loadSchema(db, databaseId).properties;
        schemaCache.set(databaseId, s);
      }
      return s;
    };
    const remapRelationDef = (def: PropertyDef): PropertyDef =>
      def.type === 'relation' && def.relation && idMap.has(def.relation.databaseId)
        ? { ...def, relation: { ...def.relation, databaseId: idMap.get(def.relation.databaseId)! } }
        : def;

    for (const n of nodes) {
      const isRoot = n.id === page.id;
      const copyId = idMap.get(n.id)!;
      const parentType = isRoot && placement ? placement.parentType : n.parent_type;
      const parentId = isRoot ? (placement ? placement.parentId : n.parent_id) : (idMap.get(n.parent_id) ?? n.parent_id);
      const position = isRoot
        ? placement
          ? positionForInsert(siblings(db, placement.parentType, placement.parentId), placement.after)
          : positionForInsert(siblings(db, n.parent_type, n.parent_id), opts.position ? opts.position.after : n.id)
        : n.position;
      const visibility = placement ? placement.visibility : n.visibility;
      const ownerId = placement ? placement.ownerId : n.visibility === 'private' ? n.owner_id : actorId;
      let props = parseJson<Record<string, PropertyValue>>(n.properties, {});
      if (n.parent_type === 'database') {
        const schema = schemaOf(n.parent_id);
        if (isRoot && opts.properties) props = mergePropertyValues(db, schema, props, opts.properties, n.workspace_id, actorId).properties;
        for (const def of schema) {
          const v = props[def.id];
          if (def.type === 'relation' && Array.isArray(v)) props[def.id] = (v as string[]).map((id) => idMap.get(id) ?? id);
        }
        if (isRoot) assignUniqueIds(db, n.parent_id, schema, props);
      }
      db.run(
        `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, icon, cover, position, visibility, owner_id,
           properties, format, is_inline, is_public, created_at, created_by, updated_at, updated_by, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`,
        copyId,
        n.workspace_id,
        parentType,
        parentId,
        n.kind,
        isRoot ? rootTitle : n.title,
        n.icon,
        n.cover,
        position,
        visibility,
        ownerId,
        JSON.stringify(props),
        withoutTeamspaceMarker(n.format), // a copy is never a teamspace (QA-G7-02)
        n.is_inline,
        now,
        actorId,
        now,
        actorId,
      );
      if (isRoot && n.parent_type === 'database') {
        syncPropertyReminders(db, actorId, { id: copyId, workspace_id: n.workspace_id }, schemaOf(n.parent_id), {}, props, now);
      }
    }

    for (const n of nodes) {
      if (n.kind !== 'database') continue;
      const copyId = idMap.get(n.id)!;
      const source = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', n.id);
      if (!source) continue;
      const props = parseJson<PropertyDef[]>(source.properties, []).map(remapRelationDef);
      db.run(
        'INSERT INTO databases (page_id, properties, next_unique_id, version) VALUES (?, ?, ?, 1)',
        copyId,
        JSON.stringify(props),
        source.next_unique_id,
      );
      for (const v of db.all<ViewRow>('SELECT * FROM views WHERE database_id = ? AND link_id IS NULL', n.id)) {
        db.run(
          'INSERT INTO views (id, database_id, name, type, position, config, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
          newId(),
          copyId,
          v.name,
          v.type,
          v.position,
          JSON.stringify(withPrivateForm(parseJson<ViewConfig>(v.config, {} as ViewConfig))), // QA-VIEW-01
          now,
          now,
        );
      }
    }

    for (const n of nodes) {
      const copyId = idMap.get(n.id)!;
      const copy = { id: copyId, workspace_id: n.workspace_id, title: n.id === page.id ? rootTitle : n.title };
      const stored = db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', n.id);
      const state = ctx.collab.liveState(n.id) ?? stored?.state ?? null;
      if (!state || state.byteLength === 0) {
        indexPage(db, copy, '');
        continue;
      }
      const remapped = isCanvasRow(n) ? remapCanvasState(state, idMap) : remapState(state, idMap); // canvas module (H1)
      db.run(
        "INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, ?, ?, '[]')",
        copyId,
        remapped.state,
        remapped.text,
        now,
      );
      for (const target of remapped.links) db.run('INSERT OR IGNORE INTO page_links (source_id, target_id) VALUES (?, ?)', copyId, target);
      // Editor module: the copy shows the same synced blocks (references, same workspace only).
      recordSyncedRefs(db, copyId, n.workspace_id, remapped.synced);
      indexPage(db, copy, remapped.text);
    }

    relationsAfterDuplicate(ctx, actorId, idMap, { rootId: page.id, asTemplate: opts.asTemplate }); // database module
    const root = getPageRow(db, idMap.get(page.id)!)!;
    emitPage(ctx, root, true);
    return root;
  });
}

// ---------------------------------------------------------------------------
// Publish & favorites
// ---------------------------------------------------------------------------

export function setPublic(ctx: AppContext, actorId: string, pageId: string, isPublic: boolean): PageRow {
  const { db } = ctx;
  const updated = db.tx(() => {
    const { page } = requirePage(db, actorId, pageId, 'edit');
    db.run(
      'UPDATE pages SET is_public = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?',
      isPublic,
      Date.now(),
      actorId,
      page.id,
    );
    const row = getPageRow(db, page.id)!;
    emitPage(ctx, row, false);
    return row;
  });
  if (!isPublic) ctx.collab.closeDocuments(subtreeIds(db, pageId), { onlyAnonymous: true });
  return updated;
}

export function favoriteIds(db: Db, userId: string, workspaceId: string): string[] {
  return db
    .all<{ id: string }>(
      `SELECT p.id FROM favorites f JOIN pages p ON p.id = f.page_id
       WHERE f.user_id = ? AND f.workspace_id = ? AND p.trashed_at IS NULL AND ${visiblePageClause('p')}
       ORDER BY f.position, f.page_id`,
      userId,
      workspaceId,
      ...visiblePageParams(userId),
    )
    .map((r) => r.id);
}

export function setFavorite(ctx: AppContext, actorId: string, pageId: string, favorite: boolean, after: string | null | undefined): string[] {
  const { db } = ctx;
  return db.tx(() => {
    const { page } = requirePage(db, actorId, pageId, 'read');
    if (favorite) {
      const current = db.all<{ id: string; position: string }>(
        'SELECT page_id AS id, position FROM favorites WHERE user_id = ? AND workspace_id = ?',
        actorId,
        page.workspace_id,
      );
      const exists = current.some((f) => f.id === page.id);
      if (!exists || after !== undefined) {
        const position = positionForInsert(current, after, page.id);
        db.run(
          `INSERT INTO favorites (user_id, page_id, workspace_id, position) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, page_id) DO UPDATE SET position = excluded.position`,
          actorId,
          page.id,
          page.workspace_id,
          position,
        );
      }
    } else {
      db.run('DELETE FROM favorites WHERE user_id = ? AND page_id = ?', actorId, page.id);
    }
    ctx.bus.publish(page.workspace_id, { entity: 'favorites', workspaceId: page.workspace_id }, actorId);
    return favoriteIds(db, actorId, page.workspace_id);
  });
}
