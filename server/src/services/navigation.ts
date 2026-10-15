// Navigation module (wave G7): personal sidebar shortcuts and sections, folders, page views and
// statistics, people profiles. Every read re-applies access control: a shortcut, folder entry,
// statistic or profile line never names a page the viewer cannot read.
import {
  positionForInsert,
  sortByPosition,
  type Crumb,
  type FolderSummary,
  type NavigationSettings,
  type PageStatsResponse,
  type ProfileResponse,
  type PublicUser,
  type SidebarItem,
  type SidebarItemKind,
  type SidebarResponse,
  type SidebarRowsResponse,
  type WorkspaceRole,
} from '@oriel/shared';
import { newId } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson, toCrumb, toPublicUser, type PageRow, type UserRow, type ViewRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  canEditRole,
  canSeePage,
  getPageRow,
  pageAccess,
  requireDatabasePage,
  requirePage,
  requireWorkspace,
  roleOf,
  visiblePageClause,
  visiblePageParams,
} from '../access.js';
import { teamspaceOf } from './teamspaces.js';

const MAX_ITEMS = 300;
const MAX_SECTIONS = 50;
const MAX_FOLDERS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A member's views of a page are counted once per half hour at most. */
export const VIEW_DEDUP_MS = 30 * 60 * 1000;

const clampName = (name: string, max = 100) => name.trim().replace(/\s+/g, ' ').slice(0, max);

function publishSidebar(ctx: AppContext, workspaceId: string, userId: string): void {
  ctx.bus.publish(workspaceId, { entity: 'navigation', workspaceId, scope: 'sidebar' }, userId);
}

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------

/** http(s) URL without credentials, at most 2048 characters; null otherwise. */
export function safeExternalUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Sidebar shortcuts
// ---------------------------------------------------------------------------

interface ItemRow {
  id: string;
  user_id: string;
  workspace_id: string;
  section_id: string | null;
  kind: SidebarItemKind;
  page_id: string | null;
  view_id: string | null;
  url: string | null;
  label: string;
  position: string;
  created_at: number;
}

interface SectionRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  position: string;
  collapsed: number;
  created_at: number;
}

/** The page of a shortcut if the user can read it (live, same workspace), else null. */
function readablePage(db: Db, userId: string, workspaceId: string, pageId: string | null): PageRow | null {
  if (!pageId) return null;
  const access = pageAccess(db, userId, pageId);
  if (!access || access.page.workspace_id !== workspaceId || access.page.trashed_at !== null) return null;
  return access.page;
}

function toItem(db: Db, userId: string, r: ItemRow): SidebarItem | null {
  const base = { id: r.id, sectionId: r.section_id, kind: r.kind, position: r.position, label: r.label, page: null, view: null, url: null };
  if (r.kind === 'link') return r.url ? { ...base, url: r.url } : null;
  if (r.kind === 'page') {
    const page = readablePage(db, userId, r.workspace_id, r.page_id);
    return page ? { ...base, page: { id: page.id, title: page.title, icon: page.icon, kind: page.kind } } : null;
  }
  const view = r.view_id ? db.get<ViewRow>('SELECT * FROM views WHERE id = ?', r.view_id) : undefined;
  const page = view ? readablePage(db, userId, r.workspace_id, view.database_id) : null;
  if (!view || !page) return null;
  return { ...base, page: { id: page.id, title: page.title, icon: page.icon, kind: page.kind }, view: { id: view.id, name: view.name, type: view.type } };
}

export function getSidebar(db: Db, userId: string, workspaceId: string): SidebarResponse {
  requireWorkspace(db, userId, workspaceId);
  const sections = sortByPosition(
    db.all<SectionRow>('SELECT * FROM nav_sidebar_sections WHERE user_id = ? AND workspace_id = ?', userId, workspaceId),
  ).map((s) => ({ id: s.id, name: s.name, position: s.position, collapsed: s.collapsed === 1 }));
  const items = sortByPosition(db.all<ItemRow>('SELECT * FROM nav_sidebar_items WHERE user_id = ? AND workspace_id = ?', userId, workspaceId))
    .map((r) => toItem(db, userId, r))
    .filter((i): i is SidebarItem => !!i);
  return { sections, items };
}

function ownSection(db: Db, userId: string, workspaceId: string, sectionId: string | null | undefined): string | null {
  if (!sectionId) return null;
  const row = db.get<SectionRow>('SELECT * FROM nav_sidebar_sections WHERE id = ? AND user_id = ? AND workspace_id = ?', sectionId, userId, workspaceId);
  if (!row) throw notFound('Section introuvable.');
  return row.id;
}

function itemSiblings(db: Db, userId: string, workspaceId: string, sectionId: string | null) {
  return db.all<{ id: string; position: string }>(
    'SELECT id, position FROM nav_sidebar_items WHERE user_id = ? AND workspace_id = ? AND section_id IS ?',
    userId,
    workspaceId,
    sectionId,
  );
}

export function createSidebarItem(
  ctx: AppContext,
  userId: string,
  workspaceId: string,
  input: { kind: SidebarItemKind; sectionId?: string | null; pageId?: string; viewId?: string; url?: string; label?: string; after?: string | null },
): SidebarItem {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId);
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM nav_sidebar_items WHERE user_id = ? AND workspace_id = ?', userId, workspaceId)!.n;
    if (count >= MAX_ITEMS) throw conflict('Trop de raccourcis.');
    const sectionId = ownSection(db, userId, workspaceId, input.sectionId);
    let pageId: string | null = null;
    let viewId: string | null = null;
    let url: string | null = null;
    let label = clampName(input.label ?? '', 200);
    if (input.kind === 'page') {
      const { page } = requirePage(db, userId, input.pageId ?? '');
      if (page.workspace_id !== workspaceId || page.trashed_at !== null) throw notFound('Page introuvable.');
      pageId = page.id;
      const dup = db.get('SELECT 1 AS x FROM nav_sidebar_items WHERE user_id = ? AND workspace_id = ? AND kind = ? AND page_id = ? AND section_id IS ?', userId, workspaceId, 'page', pageId, sectionId);
      if (dup) throw conflict('Ce raccourci existe déjà.');
    } else if (input.kind === 'view') {
      const view = db.get<ViewRow & { link_id?: string | null }>('SELECT * FROM views WHERE id = ?', input.viewId ?? '');
      const page = view ? readablePage(db, userId, workspaceId, view.database_id) : null;
      if (!view || !page) throw notFound('Vue introuvable.');
      viewId = view.id;
    } else {
      url = safeExternalUrl(input.url ?? '');
      if (!url) throw badRequest('Adresse invalide : seuls les liens http et https sont acceptés.');
      if (!label) label = new URL(url).hostname;
    }
    const id = newId();
    const position = positionForInsert(itemSiblings(db, userId, workspaceId, sectionId), input.after);
    db.run(
      `INSERT INTO nav_sidebar_items (id, user_id, workspace_id, section_id, kind, page_id, view_id, url, label, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      workspaceId,
      sectionId,
      input.kind,
      pageId,
      viewId,
      url,
      label,
      position,
      Date.now(),
    );
    publishSidebar(ctx, workspaceId, userId);
    return toItem(db, userId, db.get<ItemRow>('SELECT * FROM nav_sidebar_items WHERE id = ?', id)!)!;
  });
}

function ownItem(db: Db, userId: string, itemId: string): ItemRow {
  const row = db.get<ItemRow>('SELECT * FROM nav_sidebar_items WHERE id = ? AND user_id = ?', itemId, userId);
  if (!row) throw notFound('Raccourci introuvable.');
  requireWorkspace(db, userId, row.workspace_id);
  return row;
}

export function updateSidebarItem(
  ctx: AppContext,
  userId: string,
  itemId: string,
  input: { label?: string; url?: string; sectionId?: string | null; after?: string | null },
): void {
  const { db } = ctx;
  db.tx(() => {
    const row = ownItem(db, userId, itemId);
    const label = input.label !== undefined ? clampName(input.label, 200) : row.label;
    let url = row.url;
    if (input.url !== undefined) {
      if (row.kind !== 'link') throw badRequest('Seul un lien externe a une adresse.');
      url = safeExternalUrl(input.url);
      if (!url) throw badRequest('Adresse invalide : seuls les liens http et https sont acceptés.');
    }
    if (row.kind === 'link' && !label) throw badRequest('Donnez un nom au lien.');
    const sectionId = input.sectionId !== undefined ? ownSection(db, userId, row.workspace_id, input.sectionId) : row.section_id;
    const position =
      input.after !== undefined || sectionId !== row.section_id
        ? positionForInsert(itemSiblings(db, userId, row.workspace_id, sectionId), input.after, row.id)
        : row.position;
    db.run('UPDATE nav_sidebar_items SET label = ?, url = ?, section_id = ?, position = ? WHERE id = ?', label, url, sectionId, position, row.id);
    publishSidebar(ctx, row.workspace_id, userId);
  });
}

export function deleteSidebarItem(ctx: AppContext, userId: string, itemId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const row = ownItem(db, userId, itemId);
    db.run('DELETE FROM nav_sidebar_items WHERE id = ?', row.id);
    publishSidebar(ctx, row.workspace_id, userId);
  });
}

export function createSection(ctx: AppContext, userId: string, workspaceId: string, input: { name: string; after?: string | null }) {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId);
    const name = clampName(input.name);
    if (!name) throw badRequest('Donnez un nom à la section.');
    const siblings = db.all<{ id: string; position: string }>('SELECT id, position FROM nav_sidebar_sections WHERE user_id = ? AND workspace_id = ?', userId, workspaceId);
    if (siblings.length >= MAX_SECTIONS) throw conflict('Trop de sections.');
    const id = newId();
    const position = positionForInsert(siblings, input.after);
    db.run('INSERT INTO nav_sidebar_sections (id, user_id, workspace_id, name, position, collapsed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', id, userId, workspaceId, name, position, Date.now());
    publishSidebar(ctx, workspaceId, userId);
    return { id, name, position, collapsed: false };
  });
}

function ownSectionRow(db: Db, userId: string, sectionId: string): SectionRow {
  const row = db.get<SectionRow>('SELECT * FROM nav_sidebar_sections WHERE id = ? AND user_id = ?', sectionId, userId);
  if (!row) throw notFound('Section introuvable.');
  requireWorkspace(db, userId, row.workspace_id);
  return row;
}

export function updateSection(ctx: AppContext, userId: string, sectionId: string, input: { name?: string; collapsed?: boolean; after?: string | null }): void {
  const { db } = ctx;
  db.tx(() => {
    const row = ownSectionRow(db, userId, sectionId);
    const name = input.name !== undefined ? clampName(input.name) : row.name;
    if (!name) throw badRequest('Donnez un nom à la section.');
    const position =
      input.after !== undefined
        ? positionForInsert(
            db.all<{ id: string; position: string }>('SELECT id, position FROM nav_sidebar_sections WHERE user_id = ? AND workspace_id = ?', userId, row.workspace_id),
            input.after,
            row.id,
          )
        : row.position;
    const collapsed = input.collapsed !== undefined ? (input.collapsed ? 1 : 0) : row.collapsed;
    db.run('UPDATE nav_sidebar_sections SET name = ?, position = ?, collapsed = ? WHERE id = ?', name, position, collapsed, row.id);
    publishSidebar(ctx, row.workspace_id, userId);
  });
}

/** Deletes a section; its shortcuts go back to "Raccourcis". */
export function deleteSection(ctx: AppContext, userId: string, sectionId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const row = ownSectionRow(db, userId, sectionId);
    const moving = sortByPosition(db.all<{ id: string; position: string }>('SELECT id, position FROM nav_sidebar_items WHERE section_id = ?', row.id));
    for (const item of moving) {
      const position = positionForInsert(itemSiblings(db, userId, row.workspace_id, null), undefined);
      db.run('UPDATE nav_sidebar_items SET section_id = NULL, position = ? WHERE id = ?', position, item.id);
    }
    db.run('DELETE FROM nav_sidebar_sections WHERE id = ?', row.id);
    publishSidebar(ctx, row.workspace_id, userId);
  });
}

/** Light rows of a pinned database, by position, paginated (loaded on demand by the sidebar). */
export function sidebarRows(db: Db, userId: string, databaseId: string, offset: number, limit: number): SidebarRowsResponse {
  const { page } = requireDatabasePage(db, userId, databaseId);
  if (page.trashed_at !== null) throw notFound('Base de données introuvable.');
  const where = `parent_type = 'database' AND parent_id = ? AND trashed_at IS NULL
    AND id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)`;
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pages WHERE ${where}`, page.id, page.id)!.n;
  const rows = db.all<{ id: string; title: string; icon: string | null }>(
    `SELECT id, title, icon FROM pages WHERE ${where} ORDER BY position, id LIMIT ? OFFSET ?`,
    page.id,
    page.id,
    limit,
    offset,
  );
  return { rows, total };
}

/** Workspace membership removed: personal navigation data of that workspace goes too. */
export function forgetNavigationOf(db: Db, workspaceId: string, userId: string): void {
  db.run('DELETE FROM nav_sidebar_items WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  db.run('DELETE FROM nav_sidebar_sections WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  db.run("DELETE FROM nav_folders WHERE workspace_id = ? AND space = 'private' AND owner_id = ?", workspaceId, userId);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

interface FolderRow {
  id: string;
  workspace_id: string;
  space: string;
  owner_id: string | null;
  name: string;
  position: string;
  created_by: string;
  created_at: number;
}

/** Can the user see folders of that space? Teamspace spaces follow the root page's access. */
function canSeeSpace(db: Db, userId: string, role: WorkspaceRole, f: Pick<FolderRow, 'workspace_id' | 'space' | 'owner_id'>): boolean {
  if (f.space === 'workspace') return true;
  if (f.space === 'private') return f.owner_id === userId;
  const root = getPageRow(db, f.space);
  return !!root && root.workspace_id === f.workspace_id && root.trashed_at === null && !!teamspaceOf(db, root) && canSeePage(userId, role, root, db);
}

/** A page belongs to a space when it is one of its root pages. */
function pageInSpace(page: PageRow, f: Pick<FolderRow, 'space' | 'owner_id'>, isRoot: (p: PageRow) => boolean): boolean {
  if (page.trashed_at !== null) return false;
  if (f.space === 'workspace') return page.parent_type === 'workspace' && page.visibility === 'workspace' && !isRoot(page);
  if (f.space === 'private') return page.parent_type === 'workspace' && page.visibility === 'private' && page.owner_id === f.owner_id;
  return page.parent_type === 'page' && page.parent_id === f.space;
}

export function listFolders(db: Db, userId: string, workspaceId: string): FolderSummary[] {
  const { role } = requireWorkspace(db, userId, workspaceId);
  const isRoot = (p: PageRow) => !!teamspaceOf(db, p);
  const out: FolderSummary[] = [];
  for (const f of sortByPosition(db.all<FolderRow>('SELECT * FROM nav_folders WHERE workspace_id = ?', workspaceId))) {
    if (!canSeeSpace(db, userId, role, f)) continue;
    const pageIds = sortByPosition(
      db.all<PageRow & { fp_position: string }>(
        `SELECT p.*, fp.position AS fp_position FROM nav_folder_pages fp JOIN pages p ON p.id = fp.page_id
         WHERE fp.folder_id = ? AND ${visiblePageClause('p')}`,
        f.id,
        ...visiblePageParams(userId),
      ).map((p) => ({ ...p, position: p.fp_position })),
    )
      .filter((p) => pageInSpace(p, f, isRoot))
      .map((p) => p.id);
    out.push({ id: f.id, space: f.space, name: f.name, position: f.position, pageIds });
  }
  return out;
}

function publishFolders(ctx: AppContext, f: Pick<FolderRow, 'workspace_id' | 'space' | 'owner_id'>): void {
  ctx.bus.publish(f.workspace_id, { entity: 'navigation', workspaceId: f.workspace_id, scope: 'folders' }, f.space === 'private' ? f.owner_id ?? undefined : undefined);
}

/** Folder the user may change: visible space, and edit rights (own folders for 'private'). */
function editableFolder(db: Db, userId: string, folderId: string): FolderRow {
  const f = db.get<FolderRow>('SELECT * FROM nav_folders WHERE id = ?', folderId);
  const role = f ? roleOf(db, userId, f.workspace_id) : null;
  if (!f || !role || !canSeeSpace(db, userId, role, f)) throw notFound('Dossier introuvable.');
  if (f.space !== 'private' && !canEditRole(role)) throw forbidden("Vous n'avez pas les droits de modification.");
  return f;
}

export function createFolder(ctx: AppContext, userId: string, workspaceId: string, input: { space: string; name: string; after?: string | null }): FolderSummary {
  const { db } = ctx;
  return db.tx(() => {
    const { role } = requireWorkspace(db, userId, workspaceId);
    const name = clampName(input.name);
    if (!name) throw badRequest('Donnez un nom au dossier.');
    const f = { workspace_id: workspaceId, space: input.space, owner_id: input.space === 'private' ? userId : null };
    if (!canSeeSpace(db, userId, role, f)) throw notFound('Espace introuvable.');
    if (f.space !== 'private' && !canEditRole(role)) throw forbidden("Vous n'avez pas les droits de modification.");
    const siblings = db.all<{ id: string; position: string }>('SELECT id, position FROM nav_folders WHERE workspace_id = ? AND space = ?', workspaceId, f.space);
    if (siblings.length >= MAX_FOLDERS) throw conflict('Trop de dossiers.');
    const id = newId();
    const position = positionForInsert(siblings, input.after);
    db.run(
      'INSERT INTO nav_folders (id, workspace_id, space, owner_id, name, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      f.space,
      f.owner_id,
      name,
      position,
      userId,
      Date.now(),
    );
    publishFolders(ctx, f);
    return { id, space: f.space, name, position, pageIds: [] };
  });
}

export function updateFolder(ctx: AppContext, userId: string, folderId: string, input: { name?: string; after?: string | null }): void {
  const { db } = ctx;
  db.tx(() => {
    const f = editableFolder(db, userId, folderId);
    const name = input.name !== undefined ? clampName(input.name) : f.name;
    if (!name) throw badRequest('Donnez un nom au dossier.');
    const position =
      input.after !== undefined
        ? positionForInsert(db.all<{ id: string; position: string }>('SELECT id, position FROM nav_folders WHERE workspace_id = ? AND space = ?', f.workspace_id, f.space), input.after, f.id)
        : f.position;
    db.run('UPDATE nav_folders SET name = ?, position = ? WHERE id = ?', name, position, f.id);
    publishFolders(ctx, f);
  });
}

/** Deletes a folder; its pages stay where they are (root of the space). */
export function deleteFolder(ctx: AppContext, userId: string, folderId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const f = editableFolder(db, userId, folderId);
    db.run('DELETE FROM nav_folders WHERE id = ?', f.id);
    publishFolders(ctx, f);
  });
}

/** Puts a root page of the folder's space into the folder (or moves it inside). */
export function putPageInFolder(ctx: AppContext, userId: string, folderId: string, pageId: string, after?: string | null): void {
  const { db } = ctx;
  db.tx(() => {
    const f = editableFolder(db, userId, folderId);
    const { page } = requirePage(db, userId, pageId, f.space === 'private' ? 'read' : 'edit');
    if (page.workspace_id !== f.workspace_id || !pageInSpace(page, f, (p) => !!teamspaceOf(db, p))) {
      throw badRequest('Seules les pages à la racine de cette section peuvent aller dans ce dossier.');
    }
    const siblings = db.all<{ id: string; position: string }>('SELECT page_id AS id, position FROM nav_folder_pages WHERE folder_id = ?', f.id);
    const position = positionForInsert(siblings, after, page.id);
    db.run(
      `INSERT INTO nav_folder_pages (page_id, folder_id, position) VALUES (?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET folder_id = excluded.folder_id, position = excluded.position`,
      page.id,
      f.id,
      position,
    );
    publishFolders(ctx, f);
  });
}

export function removePageFromFolder(ctx: AppContext, userId: string, pageId: string): void {
  const { db } = ctx;
  db.tx(() => {
    const link = db.get<{ folder_id: string }>('SELECT folder_id FROM nav_folder_pages WHERE page_id = ?', pageId);
    if (!link) throw notFound('Page introuvable dans un dossier.');
    const f = editableFolder(db, userId, link.folder_id);
    requirePage(db, userId, pageId);
    db.run('DELETE FROM nav_folder_pages WHERE page_id = ?', pageId);
    publishFolders(ctx, f);
  });
}

// ---------------------------------------------------------------------------
// Views and statistics
// ---------------------------------------------------------------------------

export const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** Called by GET /api/pages/:pid before the visit is stored: counts a view unless one is recent. */
export function recordMemberView(db: Db, pageId: string, previousVisit: number | null, now = Date.now()): void {
  if (previousVisit !== null && now - previousVisit < VIEW_DEDUP_MS) return;
  db.run(
    `INSERT INTO nav_page_views (page_id, day, views, anonymous_views) VALUES (?, ?, 1, 0)
     ON CONFLICT(page_id, day) DO UPDATE SET views = views + 1`,
    pageId,
    dayOf(now),
  );
}

/** Anonymous visitors of a published page: a counter only, capped per page and per minute. */
const anonBuckets = new Map<string, { minute: number; count: number }>();
export const ANON_VIEWS_PER_MINUTE = 30;

export function recordAnonymousView(db: Db, pageId: string, now = Date.now()): void {
  const minute = Math.floor(now / 60000);
  const bucket = anonBuckets.get(pageId);
  if (bucket && bucket.minute === minute) {
    if (bucket.count >= ANON_VIEWS_PER_MINUTE) return;
    bucket.count++;
  } else {
    if (anonBuckets.size > 10000) anonBuckets.clear();
    anonBuckets.set(pageId, { minute, count: 1 });
  }
  db.run(
    `INSERT INTO nav_page_views (page_id, day, views, anonymous_views) VALUES (?, ?, 0, 1)
     ON CONFLICT(page_id, day) DO UPDATE SET anonymous_views = anonymous_views + 1`,
    pageId,
    dayOf(now),
  );
}

export function navigationSettings(db: Db, workspaceId: string): NavigationSettings {
  const row = db.get<{ show_readers: number }>('SELECT show_readers FROM nav_workspace_settings WHERE workspace_id = ?', workspaceId);
  return { showReaders: row ? row.show_readers === 1 : true };
}

export function updateNavigationSettings(ctx: AppContext, userId: string, workspaceId: string, input: Partial<NavigationSettings>): NavigationSettings {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'manage');
    const current = navigationSettings(db, workspaceId);
    const showReaders = input.showReaders ?? current.showReaders;
    db.run(
      `INSERT INTO nav_workspace_settings (workspace_id, show_readers) VALUES (?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET show_readers = excluded.show_readers`,
      workspaceId,
      showReaders ? 1 : 0,
    );
    ctx.bus.publish(workspaceId, { entity: 'workspace', id: workspaceId });
    return { showReaders };
  });
}

function usersById(db: Db, ids: string[]): Map<string, PublicUser> {
  const out = new Map<string, PublicUser>();
  for (const id of new Set(ids)) {
    const u = db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (u) out.set(id, toPublicUser(u));
  }
  return out;
}

export function pageStats(db: Db, userId: string, pageId: string, now = Date.now()): PageStatsResponse {
  const { page } = requirePage(db, userId, pageId);
  const since = dayOf(now - 29 * DAY_MS);
  const byDay = new Map(
    db
      .all<{ day: string; views: number; anonymous_views: number }>('SELECT day, views, anonymous_views FROM nav_page_views WHERE page_id = ? AND day >= ?', page.id, since)
      .map((r) => [r.day, r] as const),
  );
  const days: PageStatsResponse['days'] = [];
  for (let i = 29; i >= 0; i--) {
    const date = dayOf(now - i * DAY_MS);
    const r = byDay.get(date);
    days.push({ date, views: r?.views ?? 0, anonymousViews: r?.anonymous_views ?? 0 });
  }
  const totalViews = db.get<{ n: number | null }>('SELECT SUM(views + anonymous_views) AS n FROM nav_page_views WHERE page_id = ?', page.id)!.n ?? 0;
  // Readers: members of the workspace (anonymous visitors leave no trace here).
  const readerRows = db.all<{ user_id: string; visited_at: number }>(
    `SELECT v.user_id, v.visited_at FROM visits v JOIN members m ON m.user_id = v.user_id AND m.workspace_id = ?
     WHERE v.page_id = ? ORDER BY v.visited_at DESC`,
    page.workspace_id,
    page.id,
  );
  const count = (ms: number) => readerRows.filter((r) => r.visited_at >= now - ms).length;
  const settings = navigationSettings(db, page.workspace_id);
  const readersShown = readerRows.slice(0, 50);
  const editorsAt = new Map<string, number>();
  const bump = (id: string | null | undefined, at: number) => {
    if (id && (editorsAt.get(id) ?? 0) < at) editorsAt.set(id, at);
  };
  bump(page.updated_by, page.updated_at);
  const doc = db.get<{ editors: string; updated_at: number }>('SELECT editors, updated_at FROM documents WHERE page_id = ?', page.id);
  if (doc) for (const id of parseJson<string[]>(doc.editors, [])) bump(id, doc.updated_at);
  for (const s of db.all<{ authors: string; created_at: number }>('SELECT authors, created_at FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT 200', page.id)) {
    for (const id of parseJson<string[]>(s.authors, [])) bump(id, s.created_at);
  }
  const editorIds = [...editorsAt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const users = usersById(db, [...readersShown.map((r) => r.user_id), ...editorIds.map(([id]) => id)]);
  return {
    days,
    totalViews,
    uniqueReaders7: count(7 * DAY_MS),
    uniqueReaders30: count(30 * DAY_MS),
    uniqueReadersAll: readerRows.length,
    readers: settings.showReaders
      ? readersShown.flatMap((r) => {
          const user = users.get(r.user_id);
          return user ? [{ user, lastVisitedAt: r.visited_at }] : [];
        })
      : null,
    editors: editorIds.flatMap(([id, at]) => {
      const user = users.get(id);
      return user ? [{ user, at }] : [];
    }),
  };
}

/** Viewer's last visit of each row (database property 'last_visited'). */
export function lastVisitsOf(db: Db, userId: string, rowIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < rowIds.length; i += 500) {
    const chunk = rowIds.slice(i, i + 500);
    for (const r of db.all<{ page_id: string; visited_at: number }>(
      `SELECT page_id, visited_at FROM visits WHERE user_id = ? AND page_id IN (${chunk.map(() => '?').join(',')})`,
      userId,
      ...chunk,
    )) {
      out.set(r.page_id, r.visited_at);
    }
  }
  return out;
}

/** Adds `lastVisitedAt` (viewer's) to the rows of a rows response. */
export function withLastVisits<T extends { rows: Array<{ id: string; lastVisitedAt?: number | null }> }>(db: Db, userId: string, response: T): T {
  const visits = lastVisitsOf(db, userId, response.rows.map((r) => r.id));
  for (const row of response.rows) row.lastVisitedAt = visits.get(row.id) ?? null;
  return response;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function profileOf(db: Db, viewerId: string, workspaceId: string, targetId: string): ProfileResponse {
  requireWorkspace(db, viewerId, workspaceId);
  const member = db.get<UserRow & { role: WorkspaceRole; joined_at: number }>(
    'SELECT u.*, m.role AS role, m.joined_at AS joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?',
    workspaceId,
    targetId,
  );
  if (!member) throw notFound('Membre introuvable.');
  const visible = `p.workspace_id = ? AND p.trashed_at IS NULL AND ${visiblePageClause('p')}`;
  const params = [workspaceId, ...visiblePageParams(viewerId)];
  const pages = db
    .all<PageRow & { is_template?: number }>(
      `SELECT p.* FROM pages p WHERE ${visible} AND p.created_by = ? AND p.parent_type != 'database' AND p.is_template = 0
       ORDER BY p.updated_at DESC LIMIT 30`,
      ...params,
      targetId,
    )
    .map((p) => ({ ...toCrumb(p), updatedAt: p.updated_at }));
  const activity = db
    .all<PageRow>(`SELECT p.* FROM pages p WHERE ${visible} AND p.updated_by = ? ORDER BY p.updated_at DESC LIMIT 30`, ...params, targetId)
    .map((p) => ({ ...toCrumb(p), at: p.updated_at, created: p.created_by === targetId && p.updated_at - p.created_at < 60_000 }));
  // Co-authors on pages both edited (snapshot authors, live editors), among pages the viewer can read.
  const shared = new Map<string, Set<string>>();
  const consider = (pageId: string, authors: string[]) => {
    if (!authors.includes(targetId)) return;
    for (const a of authors) {
      if (a === targetId) continue;
      let set = shared.get(a);
      if (!set) shared.set(a, (set = new Set()));
      set.add(pageId);
    }
  };
  const authored = db.all<{ page_id: string; authors: string }>(
    `SELECT s.page_id, s.authors FROM snapshots s JOIN pages p ON p.id = s.page_id
     WHERE ${visible} AND EXISTS (SELECT 1 FROM json_each(s.authors) j WHERE j.value = ?)
     ORDER BY s.created_at DESC LIMIT 2000`,
    ...params,
    targetId,
  );
  for (const r of authored) consider(r.page_id, parseJson<string[]>(r.authors, []));
  const live = db.all<{ page_id: string; editors: string }>(
    `SELECT d.page_id, d.editors FROM documents d JOIN pages p ON p.id = d.page_id
     WHERE ${visible} AND EXISTS (SELECT 1 FROM json_each(d.editors) j WHERE j.value = ?) LIMIT 2000`,
    ...params,
    targetId,
  );
  for (const r of live) consider(r.page_id, parseJson<string[]>(r.editors, []));
  for (const r of db.all<{ id: string; created_by: string; updated_by: string }>(
    `SELECT p.id, p.created_by, p.updated_by FROM pages p WHERE ${visible} AND (p.created_by = ? OR p.updated_by = ?) LIMIT 5000`,
    ...params,
    targetId,
    targetId,
  )) {
    consider(r.id, [r.created_by, r.updated_by]);
  }
  const memberIds = new Set(db.all<{ user_id: string }>('SELECT user_id FROM members WHERE workspace_id = ?', workspaceId).map((r) => r.user_id));
  const top = [...shared.entries()]
    .filter(([id]) => memberIds.has(id))
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8);
  const users = usersById(db, top.map(([id]) => id));
  return {
    user: toPublicUser(member),
    role: member.role,
    joinedAt: member.joined_at,
    pages: pages as Array<Crumb & { updatedAt: number }>,
    activity,
    collaborators: top.flatMap(([id, set]) => {
      const user = users.get(id);
      return user ? [{ user, sharedPages: set.size }] : [];
    }),
  };
}

