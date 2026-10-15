// Navigation module routes (wave G7): teamspaces directory and members, conversion of a page,
// move preview, personal sidebar, folders, page statistics, navigation settings, profiles.
// Every route authenticates, then goes through access.ts (invisible → 404).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AccessEffect,
  FoldersResponse,
  NavigationSettings,
  PageStatsResponse,
  ProfileResponse,
  SidebarResponse,
  SidebarRowsResponse,
  TeamspaceMembersResponse,
  TeamspacesResponse,
  TeamspaceSummary,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { toPage } from '../db/rows.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requirePage, requireWorkspace } from '../access.js';
import { notFound } from '../errors.js';
import {
  addMember,
  answerRequest,
  convertToTeamspace,
  joinTeamspace,
  listMembers,
  listTeamspaces,
  moveAccess,
  previewConversion,
  removeMember,
  requestAccess,
  teamspaceSummary,
  updateTeamspace,
} from '../services/teamspaces.js';
import {
  createFolder,
  createSection,
  createSidebarItem,
  deleteFolder,
  deleteSection,
  deleteSidebarItem,
  getSidebar,
  listFolders,
  navigationSettings,
  pageStats,
  profileOf,
  putPageInFolder,
  removePageFromFolder,
  sidebarRows,
  updateFolder,
  updateNavigationSettings,
  updateSection,
  updateSidebarItem,
} from '../services/navigation.js';

const widParams = z.object({ wid: idParam });
const tidParams = z.object({ tid: idParam });
const tidUidParams = z.object({ tid: idParam, uid: idParam });
const pidParams = z.object({ pid: idParam });
const idParams = z.object({ id: idParam });
const folderPageParams = z.object({ id: idParam, pid: idParam });
const didParams = z.object({ did: idParam });
const widUidParams = z.object({ wid: idParam, uid: idParam });

const access = z.enum(['open', 'closed', 'private']);
const after = z.string().min(1).max(128).nullable().optional();
const name = z.string().max(200);

const updateTeamspaceSchema = z
  .object({ access: access.optional(), isDefault: z.boolean().optional(), description: z.string().max(500).optional(), confirmAccess: z.boolean().optional() })
  .strict();
const memberRoleSchema = z.object({ role: z.enum(['owner', 'member']) }).strict();
const answerSchema = z.object({ accept: z.boolean() }).strict();
const convertSchema = z.object({ access, confirmAccess: z.boolean().optional() }).strict();
const movePreviewSchema = z
  .object({ parentType: z.enum(['workspace', 'page']), parentId: idParam, visibility: z.enum(['workspace', 'private']).optional() })
  .strict();
const createItemSchema = z
  .object({
    kind: z.enum(['page', 'view', 'link']),
    sectionId: idParam.nullable().optional(),
    pageId: idParam.optional(),
    viewId: idParam.optional(),
    url: z.string().max(2048).optional(),
    label: name.optional(),
    after,
  })
  .strict();
const updateItemSchema = z
  .object({ label: name.optional(), url: z.string().max(2048).optional(), sectionId: idParam.nullable().optional(), after })
  .strict();
const createSectionSchema = z.object({ name, after }).strict();
const updateSectionSchema = z.object({ name: name.optional(), collapsed: z.boolean().optional(), after }).strict();
const createFolderSchema = z.object({ space: z.union([z.enum(['workspace', 'private']), idParam]), name, after }).strict();
const updateFolderSchema = z.object({ name: name.optional(), after }).strict();
const folderPageSchema = z.object({ after }).strict();
const rowsQuery = z.object({ offset: z.coerce.number().int().min(0).max(100000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const settingsSchema = z.object({ showReaders: z.boolean().optional() }).strict();

export function registerNavigationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // --- teamspaces ----------------------------------------------------------------

  app.get('/api/workspaces/:wid/teamspaces', async (req): Promise<TeamspacesResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    return { teamspaces: listTeamspaces(db, user.id, wid) };
  });

  app.get('/api/teamspaces/:tid', async (req): Promise<TeamspaceSummary> => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    return teamspaceSummary(db, user.id, tid);
  });

  app.patch('/api/teamspaces/:tid', async (req): Promise<TeamspaceSummary> => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    return updateTeamspace(ctx, user.id, tid, parse(updateTeamspaceSchema, req.body));
  });

  app.post('/api/teamspaces/:tid/join', async (req): Promise<TeamspaceSummary> => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    return joinTeamspace(ctx, user.id, tid);
  });

  app.post('/api/teamspaces/:tid/request', async (req): Promise<TeamspaceSummary> => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    return requestAccess(ctx, user.id, tid);
  });

  app.post('/api/teamspaces/:tid/leave', async (req) => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    removeMember(ctx, user.id, tid, user.id);
    return { ok: true as const };
  });

  app.get('/api/teamspaces/:tid/members', async (req): Promise<TeamspaceMembersResponse> => {
    const { user } = requireAuth(req);
    const { tid } = parse(tidParams, req.params);
    return listMembers(db, user.id, tid);
  });

  app.put('/api/teamspaces/:tid/members/:uid', async (req) => {
    const { user } = requireAuth(req);
    const { tid, uid } = parse(tidUidParams, req.params);
    addMember(ctx, user.id, tid, uid, parse(memberRoleSchema, req.body).role);
    return { ok: true as const };
  });

  app.delete('/api/teamspaces/:tid/members/:uid', async (req) => {
    const { user } = requireAuth(req);
    const { tid, uid } = parse(tidUidParams, req.params);
    removeMember(ctx, user.id, tid, uid);
    return { ok: true as const };
  });

  app.post('/api/teamspaces/:tid/requests/:uid', async (req) => {
    const { user } = requireAuth(req);
    const { tid, uid } = parse(tidUidParams, req.params);
    answerRequest(ctx, user.id, tid, uid, parse(answerSchema, req.body).accept);
    return { ok: true as const };
  });

  app.post('/api/pages/:pid/teamspace/preview', async (req): Promise<AccessEffect> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return previewConversion(db, user.id, pid, parse(convertSchema, req.body).access);
  });

  app.post('/api/pages/:pid/teamspace', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(convertSchema, req.body);
    return toPage(convertToTeamspace(ctx, user.id, pid, body.access, body.confirmAccess === true));
  });

  app.post('/api/pages/:pid/move/preview', async (req): Promise<AccessEffect & { needsConfirm: boolean }> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(movePreviewSchema, req.body);
    const { page } = requirePage(db, user.id, pid, 'edit');
    if (body.parentType === 'page') requirePage(db, user.id, body.parentId);
    else if (body.parentId !== page.workspace_id) throw notFound('Destination introuvable.');
    const result = moveAccess(db, user.id, page, body);
    return { ...result.effect, needsConfirm: result.needsConfirm };
  });

  // --- personal sidebar -----------------------------------------------------------

  app.get('/api/workspaces/:wid/sidebar', async (req): Promise<SidebarResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return getSidebar(db, user.id, wid);
  });

  app.post('/api/workspaces/:wid/sidebar/items', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return createSidebarItem(ctx, user.id, wid, parse(createItemSchema, req.body));
  });

  app.patch('/api/sidebar/items/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    updateSidebarItem(ctx, user.id, id, parse(updateItemSchema, req.body));
    return { ok: true as const };
  });

  app.delete('/api/sidebar/items/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteSidebarItem(ctx, user.id, id);
    return { ok: true as const };
  });

  app.post('/api/workspaces/:wid/sidebar/sections', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return createSection(ctx, user.id, wid, parse(createSectionSchema, req.body));
  });

  app.patch('/api/sidebar/sections/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    updateSection(ctx, user.id, id, parse(updateSectionSchema, req.body));
    return { ok: true as const };
  });

  app.delete('/api/sidebar/sections/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteSection(ctx, user.id, id);
    return { ok: true as const };
  });

  app.get('/api/sidebar/databases/:did/rows', async (req): Promise<SidebarRowsResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const q = parse(rowsQuery, req.query ?? {});
    return sidebarRows(db, user.id, did, q.offset ?? 0, q.limit ?? 25);
  });

  // --- folders --------------------------------------------------------------------

  app.get('/api/workspaces/:wid/folders', async (req): Promise<FoldersResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return { folders: listFolders(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/folders', async (req) => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return createFolder(ctx, user.id, wid, parse(createFolderSchema, req.body));
  });

  app.patch('/api/folders/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    updateFolder(ctx, user.id, id, parse(updateFolderSchema, req.body));
    return { ok: true as const };
  });

  app.delete('/api/folders/:id', async (req) => {
    const { user } = requireAuth(req);
    const { id } = parse(idParams, req.params);
    deleteFolder(ctx, user.id, id);
    return { ok: true as const };
  });

  app.put('/api/folders/:id/pages/:pid', async (req) => {
    const { user } = requireAuth(req);
    const { id, pid } = parse(folderPageParams, req.params);
    putPageInFolder(ctx, user.id, id, pid, parse(folderPageSchema, req.body ?? {}).after);
    return { ok: true as const };
  });

  app.delete('/api/folders/pages/:pid', async (req) => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    removePageFromFolder(ctx, user.id, pid);
    return { ok: true as const };
  });

  // --- statistics, settings, profiles ---------------------------------------------

  app.get('/api/pages/:pid/stats', async (req): Promise<PageStatsResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return pageStats(db, user.id, pid);
  });

  app.get('/api/workspaces/:wid/navigation-settings', async (req): Promise<NavigationSettings> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    return navigationSettings(db, wid);
  });

  app.patch('/api/workspaces/:wid/navigation-settings', async (req): Promise<NavigationSettings> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    return updateNavigationSettings(ctx, user.id, wid, parse(settingsSchema, req.body));
  });

  app.get('/api/workspaces/:wid/people/:uid', async (req): Promise<ProfileResponse> => {
    const { user } = requireAuth(req);
    const { wid, uid } = parse(widUidParams, req.params);
    return profileOf(db, user.id, wid, uid);
  });
}
