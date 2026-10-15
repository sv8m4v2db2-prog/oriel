// Organize module routes (wave H3): journal, tags, workspace page properties, collections,
// "All pages" listing, saved views, batch actions, folder items.
// Every route authenticates, then goes through access.ts (invisible → 404).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_CONDITIONS,
  TAG_COLORS,
  type ApplyTagsResponse,
  type Collection,
  type CollectionsResponse,
  type FolderItemsResponse,
  type JournalMonthResponse,
  type JournalOpenResponse,
  type PageCondition,
  type PageListResponse,
  type PageQuery,
  type PageOrganization,
  type PageProp,
  type PagePropsResponse,
  type PagesBatchResponse,
  type SavedPagesView,
  type SavedPagesViewsResponse,
  type Tag,
  type TagsResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';
import { journalMonth, openJournalDay, setJournalTemplate } from '../services/journal.js';
import {
  applyTags,
  createProp,
  createTag,
  deleteProp,
  deleteTag,
  listProps,
  listTags,
  pageOrganization,
  setPageTags,
  setPropValue,
  updateProp,
  updateTag,
} from '../services/tags.js';
import {
  batchPages,
  collectionPages,
  createCollection,
  createSavedView,
  deleteCollection,
  deleteSavedView,
  getCollection,
  listCollections,
  listFolderItems,
  listPages,
  listSavedViews,
  previewCollection,
  putFolderItem,
  removeFolderItem,
  setCollectionPage,
  updateCollection,
  updateSavedView,
} from '../services/collections.js';

const widParams = z.object({ wid: idParam });
const idParams = z.object({ id: idParam });
const pidParams = z.object({ pid: idParam });
const pidPropParams = z.object({ pid: idParam, propId: idParam });
const cidPidParams = z.object({ id: idParam, pid: idParam });
const dayParams = z.object({ wid: idParam, day: z.string().min(1).max(16) });
const itemParams = z.object({ id: idParam, kind: z.enum(['tag', 'collection']), refId: idParam });

const color = z.enum(TAG_COLORS);
const after = z.string().min(1).max(128).nullable().optional();
const ids = z.array(idParam).max(100);

const condition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), op: z.enum(['any', 'all', 'none']), tagIds: z.array(idParam).max(50) }).strict(),
  z.object({ type: z.literal('user'), by: z.enum(['created', 'updated']), userIds: z.array(idParam).max(50) }).strict(),
  z
    .object({
      type: z.literal('date'),
      field: z.enum(['created', 'updated']),
      after: z.string().max(10).optional(),
      before: z.string().max(10).optional(),
      lastDays: z.number().int().min(1).max(36500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prop'),
      propId: idParam,
      op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'empty', 'not_empty', 'checked', 'unchecked']),
      value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]).optional(),
    })
    .strict(),
  z.object({ type: z.literal('space'), space: idParam }).strict(),
  z.object({ type: z.literal('kind'), kinds: z.array(z.enum(['page', 'database', 'row', 'template', 'journal'])).max(5) }).strict(),
  z.object({ type: z.literal('title'), value: z.string().max(200) }).strict(),
]);
const filter = z.object({ match: z.enum(['all', 'any']), conditions: z.array(condition).max(MAX_CONDITIONS) }).strict();
const group = z.union([z.enum(['none', 'tag', 'author', 'created_month', 'updated_month', 'type']), z.object({ prop: idParam }).strict()]);
const sort = z
  .object({ field: z.union([z.enum(['title', 'created', 'updated']), z.object({ prop: idParam }).strict()]), dir: z.enum(['asc', 'desc']) })
  .strict();
const paging = { offset: z.number().int().min(0).max(100000).optional(), limit: z.number().int().min(1).max(100).optional() };
const queryBody = z
  .object({
    filter: filter.optional(),
    collectionId: idParam.optional(),
    group: group.optional(),
    sort: sort.optional(),
    propIds: z.array(idParam).max(12).optional(),
    ...paging,
  })
  .strict();
const viewConfig = z
  .object({ layout: z.enum(['list', 'grid']), filter, group, sort, columns: z.array(z.string().min(1).max(140)).max(18) })
  .strict();

const option = z.object({ id: z.string().max(40).optional(), name: z.string().max(40), color }).strict();
const manualPages = z.array(idParam).max(500);

export function registerOrganizeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // --- journal -------------------------------------------------------------------

  app.get('/api/workspaces/:wid/journal', async (req): Promise<JournalMonthResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const { month } = parse(z.object({ month: z.string().max(7) }), req.query);
    return journalMonth(db, user.id, wid, month);
  });

  app.post('/api/workspaces/:wid/journal/days/:day', async (req): Promise<JournalOpenResponse> => {
    const { user } = requireAuth(req);
    const { wid, day } = parse(dayParams, req.params);
    return openJournalDay(ctx, user.id, wid, day);
  });

  app.put('/api/workspaces/:wid/journal/settings', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ templateId: idParam.nullable() }).strict(), req.body);
    return { template: setJournalTemplate(ctx, user.id, wid, body.templateId) };
  });

  // --- tags ----------------------------------------------------------------------

  app.get('/api/workspaces/:wid/tags', async (req): Promise<TagsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { tags: listTags(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/tags', async (req, reply): Promise<Tag> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ name: z.string().max(200), color: color.optional() }).strict(), req.body);
    reply.code(201);
    return createTag(ctx, user.id, wid, body);
  });

  app.patch('/api/tags/:id', async (req): Promise<Tag> => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    return updateTag(ctx, user.id, id, parse(z.object({ name: z.string().max(200).optional(), color: color.optional() }).strict(), req.body));
  });

  app.delete('/api/tags/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteTag(ctx, user.id, id);
    return { ok: true };
  });

  app.post('/api/workspaces/:wid/tags/apply', async (req): Promise<ApplyTagsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ pageIds: ids, add: z.array(idParam).max(30).optional(), remove: z.array(idParam).max(30).optional() }).strict(), req.body);
    return applyTags(ctx, user.id, wid, body);
  });

  app.get('/api/pages/:pid/organization', async (req): Promise<PageOrganization> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return pageOrganization(db, user.id, pid);
  });

  app.put('/api/pages/:pid/tags', async (req): Promise<{ tagIds: string[] }> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(z.object({ tagIds: z.array(idParam).max(30) }).strict(), req.body);
    return { tagIds: setPageTags(ctx, user.id, pid, body.tagIds) };
  });

  // --- workspace page properties -------------------------------------------------

  app.get('/api/workspaces/:wid/page-props', async (req): Promise<PagePropsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { props: listProps(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/page-props', async (req, reply): Promise<PageProp> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(
      z
        .object({
          name: z.string().max(200),
          type: z.enum(['text', 'number', 'date', 'checkbox', 'select']),
          options: z.array(option).max(50).optional(),
          display: z.enum(['always', 'hide_empty', 'hidden']).optional(),
        })
        .strict(),
      req.body,
    );
    reply.code(201);
    return createProp(ctx, user.id, wid, body as Parameters<typeof createProp>[3]);
  });

  app.patch('/api/page-props/:id', async (req): Promise<PageProp> => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z
        .object({ name: z.string().max(200).optional(), options: z.array(option).max(50).optional(), display: z.enum(['always', 'hide_empty', 'hidden']).optional(), after })
        .strict(),
      req.body,
    );
    return updateProp(ctx, user.id, id, body as Parameters<typeof updateProp>[3]);
  });

  app.delete('/api/page-props/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteProp(ctx, user.id, id);
    return { ok: true };
  });

  app.put('/api/pages/:pid/props/:propId', async (req) => {
    const { user } = requireAuth(req);
    const { pid, propId } = parse(pidPropParams, req.params);
    const body = parse(z.object({ value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]) }).strict(), req.body);
    return { value: setPropValue(ctx, user.id, pid, propId, body.value) };
  });

  // --- listing (« Toutes les pages », tag pages) ---------------------------------

  app.post('/api/workspaces/:wid/pages/query', async (req): Promise<PageListResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(queryBody, req.body);
    requireWorkspace(db, user.id, wid);
    if (body.collectionId) return collectionPages(db, user.id, wid, body.collectionId, body as never);
    return listPages(db, user.id, wid, body as never);
  });

  // Read-only variant for clients that may only send GET (read-scoped API tokens, MCP): one tag or
  // collection, an optional title filter, newest first.
  app.get('/api/workspaces/:wid/pages', async (req): Promise<PageListResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const q = parse(
      z.object({
        tagId: idParam.optional(),
        collectionId: idParam.optional(),
        title: z.string().max(200).optional(),
        offset: z.coerce.number().int().min(0).max(100000).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      req.query,
    );
    requireWorkspace(db, user.id, wid);
    const conditions: PageCondition[] = [];
    if (q.tagId) conditions.push({ type: 'tag', op: 'any', tagIds: [q.tagId] });
    if (q.title) conditions.push({ type: 'title', value: q.title });
    const query: PageQuery = {
      ...(conditions.length > 0 ? { filter: { match: 'all', conditions } } : {}),
      sort: { field: 'updated', dir: 'desc' },
      offset: q.offset,
      limit: q.limit,
    };
    if (q.collectionId) return collectionPages(db, user.id, wid, q.collectionId, query);
    return listPages(db, user.id, wid, query);
  });

  app.post('/api/workspaces/:wid/pages/batch', async (req): Promise<PagesBatchResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('trash'), pageIds: ids }).strict(),
        z
          .object({
            action: z.literal('move'),
            pageIds: ids,
            parentType: z.enum(['workspace', 'page']),
            parentId: idParam,
            visibility: z.enum(['workspace', 'private']).optional(),
            confirmAccess: z.boolean().optional(),
          })
          .strict(),
      ]),
      req.body,
    );
    return batchPages(ctx, user.id, wid, body);
  });

  // --- collections ---------------------------------------------------------------

  app.get('/api/workspaces/:wid/collections', async (req): Promise<CollectionsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { collections: listCollections(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/collections', async (req, reply): Promise<Collection> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ name: z.string().max(200), icon: z.string().max(16).nullable().optional(), rules: filter.optional() }).strict(), req.body);
    reply.code(201);
    return createCollection(ctx, user.id, wid, body as never);
  });

  app.post('/api/workspaces/:wid/collections/preview', async (req): Promise<PageListResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ rules: filter, included: manualPages.optional(), excluded: manualPages.optional(), ...paging }).strict(), req.body);
    return previewCollection(db, user.id, wid, body as never);
  });

  app.get('/api/collections/:id', async (req): Promise<Collection> => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    return getCollection(db, user.id, id);
  });

  app.patch('/api/collections/:id', async (req): Promise<Collection> => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ name: z.string().max(200).optional(), icon: z.string().max(16).nullable().optional(), rules: filter.optional(), after }).strict(),
      req.body,
    );
    return updateCollection(ctx, user.id, id, body as never);
  });

  app.delete('/api/collections/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteCollection(ctx, user.id, id);
    return { ok: true };
  });

  app.put('/api/collections/:id/pages/:pid', async (req) => {
    const { user } = requireAuth(req);
    const { id, pid } = parse(cidPidParams, req.params);
    const body = parse(z.object({ mode: z.enum(['include', 'exclude']).nullable() }).strict(), req.body);
    setCollectionPage(ctx, user.id, id, pid, body.mode);
    return { ok: true };
  });

  // --- saved views of "All pages" ------------------------------------------------

  app.get('/api/workspaces/:wid/page-views', async (req): Promise<SavedPagesViewsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { views: listSavedViews(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/page-views', async (req, reply): Promise<SavedPagesView> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const body = parse(z.object({ name: z.string().max(200), shared: z.boolean().optional(), config: viewConfig }).strict(), req.body);
    reply.code(201);
    return createSavedView(ctx, user.id, wid, body as never);
  });

  app.patch('/api/page-views/:id', async (req): Promise<SavedPagesView> => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ name: z.string().max(200).optional(), shared: z.boolean().optional(), config: viewConfig.optional() }).strict(), req.body);
    return updateSavedView(ctx, user.id, id, body as never);
  });

  app.delete('/api/page-views/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteSavedView(ctx, user.id, id);
    return { ok: true };
  });

  // --- sidebar folder items ------------------------------------------------------

  app.get('/api/workspaces/:wid/organize/folder-items', async (req): Promise<FolderItemsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { items: listFolderItems(db, user.id, wid) };
  });

  app.put('/api/folders/:id/items', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ kind: z.enum(['tag', 'collection']), refId: idParam, after }).strict(), req.body);
    putFolderItem(ctx, user.id, id, body);
    return { ok: true };
  });

  app.delete('/api/folders/:id/items/:kind/:refId', async (req) => {
    const { user } = requireAuth(req);
    const { id, kind, refId } = parse(itemParams, req.params);
    removeFolderItem(ctx, user.id, id, kind, refId);
    return { ok: true };
  });
}
