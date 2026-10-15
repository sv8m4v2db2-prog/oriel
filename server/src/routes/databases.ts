import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  positionForInsert,
  type DatabaseResponse,
  type DatabaseSchema,
  type ImportRowsResponse,
  type MoveViewRowResponse,
  type PublicFormsResponse,
  type RowsResponse,
  type TemplatesResponse,
  type ViewConfig,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { PAGE_COLUMNS, parseJson, toPage, toSchema, type DatabaseRow, type PageRow, type ViewRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { assertButtonTarget, pageAudience, registerPublicExclusion, requireDatabasePage, type PageAccess } from '../access.js';
import {
  createPropertySchema,
  createRowSchema,
  createTemplateSchema,
  createViewSchema,
  deletePropertyQuerySchema,
  importRowsSchema,
  linkQuerySchema,
  moveViewRowSchema,
  positionSchema,
  setDefaultTemplateSchema,
  templateRecurrenceSchema,
  updatePropertySchema,
  updateViewSchema,
} from '../schemas.js';
import {
  chainHasTemplate,
  completeConfig,
  createProperty,
  defaultTemplateId,
  deleteProperty,
  ensureLinkedViews,
  getViewRow,
  importRows,
  insertView,
  isPublicForm,
  isTemplate,
  listViews,
  loadSchema,
  markTemplate,
  moveProperty,
  publishDatabase,
  rowsUsers,
  setDefaultTemplate,
  templateRows,
  toLinkedView,
  updateProperty,
  viewSiblings,
  withPrivateForm,
  type LinkedViewRow,
  type SchemaWriteCtx,
} from '../services/databases.js';
import { createPage, duplicatePage, emitPage, trashPage } from '../services/pages.js';
import { copyViewRowOrder, moveRowInView, viewRowOrders } from '../services/viewOrder.js';
import { listRecurrences, setRecurrence } from '../services/templateRecurrence.js';
import {
  assertPropertyStructure,
  hiddenPropertyIds,
  pageFor,
  pagesFor,
  restoreHiddenViewSettings,
  schemaFor,
  viewFor,
  viewsFor,
  visibleProperties,
  type PropertyViewer,
} from '../services/propertyAccess.js';
import { withLastVisits } from '../services/navigation.js';

const didParams = z.object({ did: idParam });
const propParams = z.object({ did: idParam, propId: z.string().min(1).max(64) });
const vidParams = z.object({ vid: idParam });
const templateParams = z.object({ did: idParam, tid: idParam });

/**
 * Database page + schema + views. With `linkId` (linked database block): that block's views
 * (created on first open when `createLinked`), falling back to the native views otherwise.
 */
export function databaseResponse(
  db: Db,
  page: PageRow,
  canEdit: boolean,
  opts: { linkId?: string; createLinked?: boolean; role?: PropertyViewer } = {},
): DatabaseResponse {
  const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', page.id);
  if (!row) throw notFound('Base de données introuvable.');
  let views: ViewRow[] = [];
  if (opts.linkId) views = opts.createLinked ? ensureLinkedViews(db, page.id, opts.linkId) : listViews(db, page.id, opts.linkId);
  if (views.length === 0) views = listViews(db, page.id);
  // Per-property permissions (D30): no role = anonymous visitor, unrestricted properties only. The view
  // settings naming a hidden property are left out too (QA-G1-01, QA-G3-06).
  const role = opts.role ?? null;
  // I1: each view carries its own manual order of the rows.
  const orders = viewRowOrders(db, page.id, views.map((v) => v.id), page.trashed_at);
  const withOrder = views.map((v) => {
    const rowOrder = orders.get(v.id);
    return rowOrder ? { ...toLinkedView(v), rowOrder } : toLinkedView(v);
  });
  return { page: toPage(page), schema: schemaFor(db, row, page.workspace_id, role), views: viewsFor(db, role, page.id, withOrder), canEdit };
}

/** View with its manual order of the rows (I1). */
function viewWithOrder(db: Db, view: ViewRow): ReturnType<typeof toLinkedView> {
  const rowOrder = viewRowOrders(db, view.database_id, [view.id]).get(view.id);
  return rowOrder ? { ...toLinkedView(view), rowOrder } : toLinkedView(view);
}

/** I1: a view's default template is « blank », the database default (null), or one of its templates. */
function assertViewTemplate(db: Db, databaseId: string, config: Partial<ViewConfig> | undefined): void {
  const id = config?.defaultTemplateId;
  if (!id || id === 'blank') return;
  if (!db.get('SELECT 1 AS x FROM database_templates t JOIN pages p ON p.id = t.page_id WHERE t.page_id = ? AND t.database_id = ? AND p.trashed_at IS NULL', id, databaseId)) {
    throw badRequest('Modèle introuvable pour cette base.');
  }
}

/**
 * Non-trashed rows ordered by position (row templates excluded). When the database itself is in the
 * trash, the rows trashed together with it are listed too (so its page can still be displayed with
 * the "in trash" banner).
 */
export function rowsResponse(db: Db, databasePage: PageRow, opts: { hideEmails?: boolean; role?: PropertyViewer } = {}): RowsResponse {
  const rows = db.all<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages WHERE parent_type = 'database' AND parent_id = ?
       AND (trashed_at IS NULL OR trashed_at = ?)
       AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)
     ORDER BY position, id`,
    databasePage.id,
    databasePage.trashed_at ?? -1,
    databasePage.id,
  );
  const role = opts.role ?? null;
  const schema = visibleProperties(db, loadSchema(db, databasePage.id).properties, role);
  return { rows: pagesFor(db, role, rows), users: rowsUsers(db, rows, schema, opts) };
}

export function templatesResponse(db: Db, databasePage: PageRow, role: PropertyViewer): TemplatesResponse {
  const rows = templateRows(db, databasePage.id);
  const schema = visibleProperties(db, loadSchema(db, databasePage.id).properties, role);
  return {
    rows: pagesFor(db, role, rows),
    users: rowsUsers(db, rows, schema),
    defaultTemplateId: defaultTemplateId(db, databasePage.id),
    recurrences: listRecurrences(db, databasePage.id),
  };
}

function schemaResponse(db: Db, access: PageAccess): DatabaseSchema {
  const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', access.page.id)!;
  return schemaFor(db, row, access.page.workspace_id, access.role);
}

/**
 * Opening a form to anonymous visitors is a publication: like POST /api/pages/:pid/publish (COOKIE_ONLY
 * in auth/apiTokens.ts), it needs the cookie session, never an API token (QA-VIEW-01). Closing it, or
 * editing a form that is already public, stays possible with a token.
 */
function assertFormPublication(req: FastifyRequest, opened: boolean): void {
  if (opened && req.apiToken) {
    throw forbidden("Ouvrir un formulaire aux personnes sans compte n'est pas possible avec un jeton d'API : connectez-vous à Oriel dans le navigateur.");
  }
}

function emitDatabase(ctx: AppContext, page: PageRow): void {
  ctx.bus.publish(page.workspace_id, { entity: 'database', id: page.id }, pageAudience(ctx.db, page));
}

function emitView(ctx: AppContext, page: PageRow, viewId: string): void {
  ctx.bus.publish(
    page.workspace_id,
    { entity: 'view', id: viewId, databaseId: page.id },
    pageAudience(ctx.db, page),
  );
}

export function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  // Row templates are never public (/api/public/*, anonymous /collab), even in a published tree.
  registerPublicExclusion('databases:row-templates', chainHasTemplate);

  app.get('/api/databases/:did', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const { linkId } = parse(linkQuerySchema, req.query ?? {});
    const access = requireDatabasePage(db, user.id, did);
    // Readers see the block's views once an editor has opened it (native views until then).
    return databaseResponse(db, access.page, access.canEdit, { linkId, createLinked: access.canEdit, role: access.role });
  });

  app.get('/api/databases/:did/rows', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const access = requireDatabasePage(db, user.id, did);
    // Navigation module: viewer's last visit of each row (property 'last_visited').
    return withLastVisits(db, user.id, rowsResponse(db, access.page, { role: access.role }));
  });

  app.post('/api/databases/:did/rows', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(createRowSchema, req.body);
    const access = requireDatabasePage(db, user.id, did, 'edit');
    if (body.viaButtonOn) assertButtonTarget(db, user.id, body.viaButtonOn, access.page);
    if (body.templateId) {
      const templateId = body.templateId;
      const row = db.tx(() => {
        const template = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, templateId);
        if (!template || template.parent_type !== 'database' || template.parent_id !== did || !isTemplate(db, templateId)) {
          throw notFound('Modèle introuvable.');
        }
        return duplicatePage(ctx, user.id, templateId, {
          id: body.id,
          title: body.title ?? template.title,
          properties: body.properties,
          position: { after: body.after },
          asTemplate: false,
        });
      });
      return pageFor(db, access.role, row);
    }
    const row = createPage(ctx, user.id, access.page.workspace_id, {
      id: body.id,
      parentType: 'database',
      parentId: did,
      kind: 'page',
      title: body.title,
      icon: body.icon,
      properties: body.properties,
      after: body.after,
    });
    return pageFor(db, access.role, row);
  });

  // --- row templates -------------------------------------------------------------

  app.get('/api/databases/:did/templates', async (req): Promise<TemplatesResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const access = requireDatabasePage(db, user.id, did);
    return templatesResponse(db, access.page, access.role);
  });

  app.post('/api/databases/:did/templates', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(createTemplateSchema, req.body ?? {});
    const access = requireDatabasePage(db, user.id, did, 'edit');
    const page = db.tx(() => {
      if (body.fromRowId) {
        // I1: an existing row becomes a template (copy with its sub-pages); the original may go to the trash.
        const fromId = body.fromRowId;
        const source = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, fromId);
        if (!source || source.parent_type !== 'database' || source.parent_id !== did || source.trashed_at !== null || isTemplate(db, fromId)) {
          throw notFound('Ligne introuvable.');
        }
        const copy = duplicatePage(ctx, user.id, fromId, { asTemplate: true, title: body.title ?? source.title });
        if (body.trashOriginal) trashPage(ctx, user.id, fromId);
        return copy;
      }
      if (body.fromTemplateId) {
        const fromId = body.fromTemplateId;
        const source = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, fromId);
        if (!source || source.parent_type !== 'database' || source.parent_id !== did || !isTemplate(db, fromId)) {
          throw notFound('Modèle introuvable.');
        }
        return duplicatePage(ctx, user.id, fromId, { asTemplate: true, title: body.title });
      }
      const created = createPage(ctx, user.id, access.page.workspace_id, {
        parentType: 'database',
        parentId: did,
        kind: 'page',
        title: body.title ?? '',
      });
      markTemplate(db, created.id, did);
      return created;
    });
    return pageFor(db, access.role, page);
  });

  app.put('/api/databases/:did/templates/default', async (req): Promise<TemplatesResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(setDefaultTemplateSchema, req.body);
    return db.tx(() => {
      const access = requireDatabasePage(db, user.id, did, 'edit');
      const previous = defaultTemplateId(db, did);
      setDefaultTemplate(db, did, body.templateId);
      for (const id of [previous, body.templateId]) {
        const row = id ? db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, id) : undefined;
        if (row) emitPage(ctx, row, false);
      }
      return templatesResponse(db, access.page, access.role);
    });
  });

  // I1 — recurring templates: the rows are created by a background job (services/templateRecurrence.ts).
  app.put('/api/databases/:did/templates/:tid/recurrence', async (req): Promise<TemplatesResponse> => {
    const { user } = requireAuth(req);
    const { did, tid } = parse(templateParams, req.params);
    const body = parse(templateRecurrenceSchema, req.body);
    return db.tx(() => {
      const access = requireLiveDatabase(user.id, did);
      setRecurrence(db, did, tid, user.id, body.recurrence);
      const row = db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, tid);
      if (row) emitPage(ctx, row, false);
      return templatesResponse(db, access.page, access.role);
    });
  });

  /** Edit access to a database that is not in the trash (a trashed database is read-only, like its rows). */
  const requireLiveDatabase = (userId: string, did: string): PageAccess => {
    const access = requireDatabasePage(db, userId, did, 'edit');
    if (access.page.trashed_at !== null) throw badRequest('La base de données est dans la corbeille.');
    return access;
  };

  // --- CSV import ------------------------------------------------------------------

  app.post('/api/databases/:did/import', async (req): Promise<ImportRowsResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(importRowsSchema, req.body);
    const access = requireLiveDatabase(user.id, did);
    return importRows(ctx, user.id, access.page, body.rows, body.updateByTitle ?? false);
  });

  // --- properties ------------------------------------------------------------

  const schemaWrite = (did: string, userId: string, fn: (access: PageAccess, sctx: SchemaWriteCtx) => void): DatabaseSchema =>
    db.tx(() => {
      const access = requireLiveDatabase(userId, did);
      const sctx: SchemaWriteCtx = { databaseId: did, workspaceId: access.page.workspace_id, actorId: userId, touched: new Set() };
      fn(access, sctx);
      emitDatabase(ctx, access.page);
      for (const other of sctx.touched ?? []) if (other !== did) publishDatabase(ctx, other);
      return schemaResponse(db, access);
    });

  app.post('/api/databases/:did/properties', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(createPropertySchema, req.body);
    return schemaWrite(did, user.id, (_access, sctx) => {
      createProperty(db, sctx, body.property, body.after, body.twoWay);
    });
  });

  app.patch('/api/databases/:did/properties/:propId', async (req) => {
    const { user } = requireAuth(req);
    const { did, propId } = parse(propParams, req.params);
    const body = parse(updatePropertySchema, req.body);
    return schemaWrite(did, user.id, (access, sctx) => {
      assertPropertyStructure(db, access.role, did, propId);
      updateProperty(db, sctx, propId, body);
    });
  });

  app.delete('/api/databases/:did/properties/:propId', async (req) => {
    const { user } = requireAuth(req);
    const { did, propId } = parse(propParams, req.params);
    const { mirror } = parse(deletePropertyQuerySchema, req.query ?? {});
    return schemaWrite(did, user.id, (access, sctx) => {
      assertPropertyStructure(db, access.role, did, propId, mirror === 'delete');
      deleteProperty(db, sctx, propId, mirror ?? 'keep');
    });
  });

  app.post('/api/databases/:did/properties/:propId/move', async (req) => {
    const { user } = requireAuth(req);
    const { did, propId } = parse(propParams, req.params);
    const body = parse(positionSchema, req.body);
    return schemaWrite(did, user.id, (access) => {
      assertPropertyStructure(db, access.role, did, propId);
      moveProperty(db, did, propId, body.after);
    });
  });

  // --- views -------------------------------------------------------------------

  app.post('/api/databases/:did/views', async (req) => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(createViewSchema, req.body);
    let role: PropertyViewer = null;
    const view = db.tx(() => {
      const access = requireLiveDatabase(user.id, did);
      role = access.role;
      const props = loadSchema(db, did).properties;
      const config = completeConfig(body.type, props, body.config as Partial<ViewConfig> | undefined);
      assertFormPublication(req, isPublicForm(body.type, config));
      assertViewTemplate(db, did, body.config as Partial<ViewConfig> | undefined);
      if (body.id && getViewRow(db, body.id)) throw conflict('Une vue avec cet identifiant existe déjà.');
      const created = insertView(db, did, {
        id: body.id,
        name: body.name || 'Vue',
        type: body.type,
        position: positionForInsert(viewSiblings(db, did, body.linkId ?? null), body.after),
        config,
        linkId: body.linkId ?? null,
      });
      emitView(ctx, access.page, created.id);
      return created;
    });
    return viewFor(db, role, toLinkedView(view));
  });

  const viewAccess = (vid: string, userId: string) => {
    const view = getViewRow(db, vid) as LinkedViewRow | undefined;
    if (!view) throw notFound('Vue introuvable.');
    try {
      return { view, access: requireLiveDatabase(userId, view.database_id) };
    } catch (err) {
      // Do not reveal views of invisible databases.
      if ((err as { status?: number }).status === 404) throw notFound('Vue introuvable.');
      throw err;
    }
  };

  app.patch('/api/views/:vid', async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    const body = parse(updateViewSchema, req.body);
    let role: PropertyViewer = null;
    const updated = db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      role = access.role;
      const props = loadSchema(db, view.database_id).properties;
      const type = body.type ?? view.type;
      const current = parseJson<ViewConfig>(view.config, completeConfig(view.type, props, undefined));
      const partial = body.config as Partial<ViewConfig> | undefined;
      assertViewTemplate(db, view.database_id, partial);
      let config = completeConfig(type, props, partial, current);
      // The settings on properties hidden from the editor are kept as stored (QA-G1-01): it was served
      // the view without them, and completeConfig replaces whole top-level keys.
      const sent = new Set(Object.entries(partial ?? {}).filter(([, v]) => v !== undefined).map(([k]) => k));
      config = restoreHiddenViewSettings(config, current, hiddenPropertyIds(db, props, access.role), sent);
      if (type !== view.type) {
        // Fill layout-specific settings the new type needs.
        const defaults = completeConfig(type, props, undefined);
        if ((type === 'board') && !config.groupBy) config = { ...config, groupBy: defaults.groupBy };
        if ((type === 'calendar' || type === 'timeline') && !config.dateProperty) config = { ...config, dateProperty: defaults.dateProperty };
      }
      assertFormPublication(req, isPublicForm(type, config) && !isPublicForm(view.type, current));
      db.run(
        'UPDATE views SET name = ?, type = ?, config = ?, version = version + 1, updated_at = ? WHERE id = ?',
        body.name !== undefined ? body.name || view.name : view.name,
        type,
        JSON.stringify(config),
        Date.now(),
        vid,
      );
      emitView(ctx, access.page, vid);
      return getViewRow(db, vid)!;
    });
    return viewFor(db, role, viewWithOrder(db, updated));
  });

  // I1 — manual order of one view: the page position and the other views are left unchanged.
  app.post('/api/views/:vid/rows/move', async (req): Promise<MoveViewRowResponse> => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    const body = parse(moveViewRowSchema, req.body);
    return db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      const rowOrder = moveRowInView(db, view.database_id, vid, body.rowId, body.after);
      emitView(ctx, access.page, vid);
      return { viewId: vid, rowOrder };
    });
  });

  app.delete('/api/views/:vid', async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      if (viewSiblings(db, view.database_id, view.link_id ?? null).length <= 1) {
        throw conflict('Une base de données doit conserver au moins une vue.');
      }
      db.run('DELETE FROM views WHERE id = ?', vid);
      emitView(ctx, access.page, vid);
    });
    return { ok: true as const };
  });

  app.post('/api/views/:vid/move', async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    const body = parse(positionSchema, req.body);
    let role: PropertyViewer = null;
    const moved = db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      role = access.role;
      const position = positionForInsert(viewSiblings(db, view.database_id, view.link_id ?? null), body.after, vid);
      db.run('UPDATE views SET position = ?, version = version + 1, updated_at = ? WHERE id = ?', position, Date.now(), vid);
      emitView(ctx, access.page, vid);
      return getViewRow(db, vid)!;
    });
    return viewFor(db, role, viewWithOrder(db, moved));
  });

  app.post('/api/views/:vid/duplicate', async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    let role: PropertyViewer = null;
    const copy = db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      role = access.role;
      const created = insertView(db, view.database_id, {
        name: `${view.name} (copie)`.slice(0, 200),
        type: view.type,
        position: positionForInsert(viewSiblings(db, view.database_id, view.link_id ?? null), vid),
        config: withPrivateForm(parseJson<ViewConfig>(view.config, completeConfig(view.type, loadSchema(db, view.database_id).properties, undefined))),
        linkId: view.link_id ?? null,
      });
      copyViewRowOrder(db, vid, created.id); // I1: the copy starts with the same manual order
      emitView(ctx, access.page, created.id);
      return created;
    });
    return viewFor(db, role, viewWithOrder(db, copy));
  });

  // --- public forms (QA-VIEW-05) ----------------------------------------------------------------------
  // Views of linked blocks are keyed by a linkId, not tied to a host page: a public form whose block is
  // gone (or never existed) is listed here, with the database's own views, so that it can be closed.

  app.get('/api/databases/:did/public-forms', async (req): Promise<PublicFormsResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    requireDatabasePage(db, user.id, did);
    const rows = db.all<LinkedViewRow>("SELECT * FROM views WHERE database_id = ? AND type = 'form' ORDER BY link_id IS NOT NULL, position, id", did);
    const forms: PublicFormsResponse['forms'] = [];
    for (const v of rows) {
      const form = parseJson<Partial<ViewConfig>>(v.config, {}).form;
      if (!isPublicForm(v.type, { form } as Partial<ViewConfig>)) continue;
      forms.push({ id: v.id, name: v.name, linkId: v.link_id ?? null, acceptResponses: form?.acceptResponses === true });
    }
    return { forms };
  });

  // Closing is the safe direction: allowed to anyone who can edit the database, API tokens included.
  app.post('/api/views/:vid/close-public-form', async (req) => {
    const { user } = requireAuth(req);
    const { vid } = parse(vidParams, req.params);
    let role: PropertyViewer = null;
    const closed = db.tx(() => {
      const { view, access } = viewAccess(vid, user.id);
      role = access.role;
      const config = parseJson<ViewConfig>(view.config, {} as ViewConfig);
      if (isPublicForm(view.type, config)) {
        db.run(
          'UPDATE views SET config = ?, version = version + 1, updated_at = ? WHERE id = ?',
          JSON.stringify(withPrivateForm(config)),
          Date.now(),
          vid,
        );
        emitView(ctx, access.page, vid);
      }
      return getViewRow(db, vid)!;
    });
    return viewFor(db, role, toLinkedView(closed));
  });
}
