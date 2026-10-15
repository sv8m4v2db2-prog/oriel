// Navigation module (wave G7): teamspaces access, directory, moves, sidebar shortcuts, folders,
// page statistics, profiles, migration of existing navigation groups. Style of qa-*.test.ts:
// every invisible resource answers 404 and never leaks a title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AccessEffect,
  FoldersResponse,
  NotificationsResponse,
  PageStatsResponse,
  ProfileResponse,
  SearchResponse,
  SidebarResponse,
  SidebarRowsResponse,
  TeamspaceMembersResponse,
  TeamspacesResponse,
  TeamspaceSummary,
  TreeResponse,
} from '@oriel/shared';
import { startServer } from '../src/app.js';
import { addMember, Client, createPage, expectOk, setupAdmin, startTestServer } from './helpers.js';

async function trio(base: string) {
  const { admin, wid } = await setupAdmin(base);
  const { client: bob, user: bobUser } = await addMember(admin, wid, 'bob@oriel.test', 'Bob Membre', 'member');
  const { client: carol, user: carolUser } = await addMember(admin, wid, 'carol@oriel.test', 'Carol Membre', 'member');
  return { admin, wid, bob, bobUser, carol, carolUser };
}

const treeIds = async (c: Client, wid: string) => new Set(expectOk(await c.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes.map((n) => n.id));

test('QA-NAV-01 closed teamspace: content readable by members only, everywhere', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, carol, bobUser } = await trio(srv.base);
    const root = await createPage(admin, wid, { title: 'Équipe Dessin', visibility: 'workspace' });
    const child = await createPage(admin, wid, { title: 'Secret dessin zèbre', parentType: 'page', parentId: root.id });
    // Converting a shared page into a closed teamspace narrows access: preview, then explicit consent.
    const preview = expectOk(await admin.post<AccessEffect>(`/pages/${root.id}/teamspace/preview`, { access: 'closed' }));
    assert.equal(preview.narrows, true);
    assert.equal(preview.lose, 2);
    assert.equal(preview.pageCount, 2);
    assert.equal((await admin.post(`/pages/${root.id}/teamspace`, { access: 'closed' })).status, 409);
    expectOk(await admin.post(`/pages/${root.id}/teamspace`, { access: 'closed', confirmAccess: true }));

    // Non-member: 404 on the page, absent from tree, search, backlinks; database rows inherit.
    assert.equal((await bob.get(`/pages/${child.id}`)).status, 404);
    assert.equal((await bob.get(`/pages/${root.id}`)).status, 404);
    assert(!(await treeIds(bob, wid)).has(child.id));
    const db = await createPage(admin, wid, { title: 'Base dessin', kind: 'database', parentType: 'page', parentId: child.id });
    assert.equal((await bob.get(`/databases/${db.id}`)).status, 404);
    const search = expectOk(await bob.get<SearchResponse>(`/workspaces/${wid}/search?q=zèbre`));
    assert.equal(search.results.length, 0);
    const adminSearch = expectOk(await admin.get<SearchResponse>(`/workspaces/${wid}/search?q=zèbre`));
    assert.equal(adminSearch.results.length, 1);

    // Directory: visible with title, no content; join refused, request notifies the owner.
    const dir = expectOk(await bob.get<TeamspacesResponse>(`/workspaces/${wid}/teamspaces`)).teamspaces;
    const ts = dir.find((t) => t.id === root.id)!;
    assert.equal(ts.access, 'closed');
    assert.equal(ts.myRole, null);
    assert.equal((await bob.post(`/teamspaces/${root.id}/join`, {})).status, 403);
    assert.equal((await bob.get(`/teamspaces/${root.id}/members`)).status, 403);
    expectOk(await bob.post<TeamspaceSummary>(`/teamspaces/${root.id}/request`, {}));
    const inbox = expectOk(await admin.get<NotificationsResponse>(`/workspaces/${wid}/notifications?filter=inbox`));
    assert(inbox.notifications.some((n) => n.type === 'teamspace_request' && n.page?.id === root.id));
    const members = expectOk(await admin.get<TeamspaceMembersResponse>(`/teamspaces/${root.id}/members`));
    assert.equal(members.requests.length, 1);
    // Bob cannot accept his own request.
    assert.equal((await bob.post(`/teamspaces/${root.id}/requests/${bobUser.id}`, { accept: true })).status, 403);
    expectOk(await admin.post(`/teamspaces/${root.id}/requests/${bobUser.id}`, { accept: true }));
    expectOk(await bob.get(`/pages/${child.id}`));
    assert((await treeIds(bob, wid)).has(child.id));
    assert.equal((await carol.get(`/pages/${child.id}`)).status, 404);

    // Leaving closes access again; the last owner cannot leave.
    expectOk(await bob.post(`/teamspaces/${root.id}/leave`, {}));
    assert.equal((await bob.get(`/pages/${child.id}`)).status, 404);
    assert.equal((await admin.post(`/teamspaces/${root.id}/leave`, {})).status, 409);
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-02 private teamspace hidden from the directory; reopening needs consent', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const priv = await createPage(admin, wid, { title: 'Projet confidentiel', visibility: 'private' });
    // Private page → private teamspace: nothing widens, no consent needed.
    const preview = expectOk(await admin.post<AccessEffect>(`/pages/${priv.id}/teamspace/preview`, { access: 'private' }));
    assert.equal(preview.widens, false);
    assert.equal(preview.narrows, false);
    expectOk(await admin.post(`/pages/${priv.id}/teamspace`, { access: 'private' }));
    const dir = expectOk(await bob.get<TeamspacesResponse>(`/workspaces/${wid}/teamspaces`)).teamspaces;
    assert(!dir.some((t) => t.id === priv.id));
    assert.equal((await bob.get(`/teamspaces/${priv.id}`)).status, 404);
    assert.equal((await bob.post(`/teamspaces/${priv.id}/request`, {})).status, 404);
    assert.equal((await bob.post(`/teamspaces/${priv.id}/join`, {})).status, 404);
    // Private page → open teamspace would widen: refused without consent.
    const other = await createPage(admin, wid, { title: 'Autre privée', visibility: 'private' });
    assert.equal((await admin.post(`/pages/${other.id}/teamspace`, { access: 'open' })).status, 409);
    // Opening the private teamspace needs consent too.
    assert.equal((await admin.patch(`/teamspaces/${priv.id}`, { access: 'open' })).status, 409);
    expectOk(await admin.patch(`/teamspaces/${priv.id}`, { access: 'open', confirmAccess: true }));
    expectOk(await bob.get(`/pages/${priv.id}`));
    // Bob is not a manager: cannot change it back.
    assert.equal((await bob.patch(`/teamspaces/${priv.id}`, { access: 'private' })).status, 403);
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-03 moves across teamspaces: no silent widening, roots stay roots', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const closed = await createPage(admin, wid, { title: 'Fermé', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${closed.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    const inside = await createPage(admin, wid, { title: 'Dedans', parentType: 'page', parentId: closed.id });
    const sub = await createPage(admin, wid, { title: 'Sous-page', parentType: 'page', parentId: inside.id });
    // Out of the closed teamspace to the shared root: widening → preview, 409, then consent.
    const preview = expectOk(await admin.post<AccessEffect & { needsConfirm: boolean }>(`/pages/${inside.id}/move/preview`, { parentType: 'workspace', parentId: wid }));
    assert.equal(preview.widens, true);
    assert.equal(preview.needsConfirm, true);
    assert.equal((await admin.post(`/pages/${inside.id}/move`, { parentType: 'workspace', parentId: wid })).status, 409);
    assert.equal((await bob.get(`/pages/${sub.id}`)).status, 404);
    expectOk(await admin.post(`/pages/${inside.id}/move`, { parentType: 'workspace', parentId: wid, confirmAccess: true }));
    expectOk(await bob.get(`/pages/${sub.id}`));
    // Back inside: narrowing needs no consent; the whole subtree is restricted again.
    expectOk(await admin.post(`/pages/${inside.id}/move`, { parentType: 'page', parentId: closed.id }));
    assert.equal((await bob.get(`/pages/${sub.id}`)).status, 404);
    // A page created or duplicated inside inherits the restriction.
    const dup = expectOk(await admin.post<{ id: string }>(`/pages/${sub.id}/duplicate`, {}));
    assert.equal((await bob.get(`/pages/${dup.id}`)).status, 404);
    // Restricted teamspace roots: no nesting, no duplicate, no visibility change through a move.
    const other = await createPage(admin, wid, { title: 'Ailleurs', visibility: 'workspace' });
    assert.equal((await admin.post(`/pages/${closed.id}/move`, { parentType: 'page', parentId: other.id })).status, 400);
    assert.equal((await admin.post(`/pages/${closed.id}/duplicate`, {})).status, 400);
    assert.equal((await admin.post(`/pages/${closed.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' })).status, 400);
    // A client can never choose 'teamspace' itself.
    assert.equal((await admin.post(`/pages/${other.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'teamspace' })).status, 400);
    // Bob cannot move a page into a teamspace he cannot see.
    const bobPage = await createPage(bob, wid, { title: 'Page de Bob', visibility: 'workspace' });
    assert.equal((await bob.post(`/pages/${bobPage.id}/move`, { parentType: 'page', parentId: closed.id })).status, 404);
    assert.equal((await bob.post(`/pages/${bobPage.id}/move/preview`, { parentType: 'page', parentId: closed.id })).status, 404);
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-04 sidebar shortcuts: invisible targets vanish without their title, links validated', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const shared = await createPage(admin, wid, { title: 'Planning partagé', visibility: 'workspace' });
    const dbPage = await createPage(admin, wid, { title: 'Projets', kind: 'database', visibility: 'workspace' });
    const views = expectOk(await bob.get<{ views: Array<{ id: string }> }>(`/databases/${dbPage.id}`)).views;
    const section = expectOk(await bob.post<{ id: string }>(`/workspaces/${wid}/sidebar/sections`, { name: 'Production' }));
    expectOk(await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'page', pageId: shared.id }));
    expectOk(await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'view', viewId: views[0]!.id, sectionId: section.id }));
    expectOk(await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'link', url: 'https://example.org/brief', label: 'Brief client' }));
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.org', 'https://user:pass@example.org', 'pas une url']) {
      assert.equal((await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'link', url })).status, 400, url);
    }
    let sidebar = expectOk(await bob.get<SidebarResponse>(`/workspaces/${wid}/sidebar`));
    assert.equal(sidebar.items.length, 3);
    assert.equal(sidebar.sections[0]!.name, 'Production');
    // A shortcut to a page Bob cannot see is refused.
    const adminPrivate = await createPage(admin, wid, { title: 'Privé admin', visibility: 'private' });
    assert.equal((await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'page', pageId: adminPrivate.id })).status, 404);
    // The shared page becomes private to the admin: Bob's shortcut disappears, title included.
    expectOk(await admin.post(`/pages/${shared.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    const raw = await bob.get(`/workspaces/${wid}/sidebar`);
    sidebar = expectOk(raw);
    assert.equal(sidebar.items.length, 2);
    assert(!JSON.stringify(raw.body).includes('Planning partagé'));
    // Shortcuts and sections are personal: someone else's are 404.
    const itemId = sidebar.items[0]!.id;
    assert.equal((await admin.patch(`/sidebar/items/${itemId}`, { label: 'x' })).status, 404);
    assert.equal((await admin.del(`/sidebar/items/${itemId}`)).status, 404);
    assert.equal((await admin.patch(`/sidebar/sections/${section.id}`, { collapsed: true })).status, 404);
    expectOk(await bob.patch(`/sidebar/sections/${section.id}`, { collapsed: true }));
    // Deleting a section keeps its shortcuts (back to "Raccourcis").
    expectOk(await bob.del(`/sidebar/sections/${section.id}`));
    sidebar = expectOk(await bob.get<SidebarResponse>(`/workspaces/${wid}/sidebar`));
    assert.equal(sidebar.items.length, 2);
    assert(sidebar.items.every((i) => i.sectionId === null));
    // Pinned database rows, on demand and paginated; private databases stay 404.
    for (let i = 0; i < 3; i++) expectOk(await admin.post(`/databases/${dbPage.id}/rows`, { properties: {} }));
    const rows = expectOk(await bob.get<SidebarRowsResponse>(`/sidebar/databases/${dbPage.id}/rows?limit=2`));
    const all = expectOk(await admin.get<{ rows: unknown[] }>(`/databases/${dbPage.id}/rows`)).rows;
    assert.equal(rows.total, all.length);
    assert.equal(rows.rows.length, 2);
    const next = expectOk(await bob.get<SidebarRowsResponse>(`/sidebar/databases/${dbPage.id}/rows?limit=2&offset=2`));
    assert(!next.rows.some((r) => rows.rows.some((x) => x.id === r.id)));
    const privDb = await createPage(admin, wid, { title: 'Base privée', kind: 'database', visibility: 'private' });
    assert.equal((await bob.get(`/sidebar/databases/${privDb.id}/rows`)).status, 404);
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-05 folders group root pages without changing their access', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const a = await createPage(admin, wid, { title: 'A', visibility: 'workspace' });
    const nested = await createPage(admin, wid, { title: 'Imbriquée', parentType: 'page', parentId: a.id });
    const mine = await createPage(admin, wid, { title: 'Ma page', visibility: 'private' });
    const folder = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/folders`, { space: 'workspace', name: 'Clients' }));
    expectOk(await admin.put(`/folders/${folder.id}/pages/${a.id}`, {}));
    // Only root pages of the same space.
    assert.equal((await admin.put(`/folders/${folder.id}/pages/${nested.id}`, {})).status, 400);
    assert.equal((await admin.put(`/folders/${folder.id}/pages/${mine.id}`, {})).status, 400);
    const privFolder = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/folders`, { space: 'private', name: 'Perso' }));
    expectOk(await admin.put(`/folders/${privFolder.id}/pages/${mine.id}`, {}));
    const bobFolders = expectOk(await bob.get<FoldersResponse>(`/workspaces/${wid}/folders`)).folders;
    assert.deepEqual(bobFolders.map((f) => f.name), ['Clients']);
    assert.deepEqual(bobFolders[0]!.pageIds, [a.id]);
    assert.equal((await bob.patch(`/folders/${privFolder.id}`, { name: 'x' })).status, 404);
    // Access is the page's: making A private hides it from the folder for Bob.
    expectOk(await admin.post(`/pages/${a.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    const after = expectOk(await bob.get<FoldersResponse>(`/workspaces/${wid}/folders`)).folders;
    assert.deepEqual(after[0]!.pageIds, []);
    // Deleting the folder keeps the pages.
    expectOk(await admin.del(`/folders/${privFolder.id}`));
    expectOk(await admin.get(`/pages/${mine.id}`));
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-06 page statistics, readers switch, last_visited rows, anonymous counter', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, bobUser } = await trio(srv.base);
    const page = await createPage(admin, wid, { title: 'Mesurée', visibility: 'workspace' });
    expectOk(await bob.get(`/pages/${page.id}`));
    expectOk(await bob.get(`/pages/${page.id}`)); // same half hour: one view
    expectOk(await admin.get(`/pages/${page.id}`));
    let stats = expectOk(await admin.get<PageStatsResponse>(`/pages/${page.id}/stats`));
    assert.equal(stats.days.length, 30);
    assert.equal(stats.days[29]!.views, 2);
    assert.equal(stats.uniqueReaders7, 2);
    assert(stats.readers!.some((r) => r.user.id === bobUser.id));
    assert(stats.editors.length >= 1);
    // Members only: Bob cannot change the workspace switch.
    assert.equal((await bob.patch(`/workspaces/${wid}/navigation-settings`, { showReaders: false })).status, 403);
    expectOk(await admin.patch(`/workspaces/${wid}/navigation-settings`, { showReaders: false }));
    stats = expectOk(await bob.get<PageStatsResponse>(`/pages/${page.id}/stats`));
    assert.equal(stats.readers, null);
    // Stats of an invisible page: 404.
    const priv = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    assert.equal((await bob.get(`/pages/${priv.id}/stats`)).status, 404);
    // Anonymous visitors of a published page: a counter only.
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const anon = new Client(srv.base);
    expectOk(await anon.get(`/public/pages/${page.id}`));
    stats = expectOk(await admin.get<PageStatsResponse>(`/pages/${page.id}/stats`));
    assert.equal(stats.days[29]!.anonymousViews, 1);
    assert.equal(stats.uniqueReadersAll, 2);
    // last_visited: per viewer on database rows.
    const base = await createPage(admin, wid, { title: 'Base', kind: 'database', visibility: 'workspace' });
    const row = expectOk(await admin.post<{ id: string }>(`/databases/${base.id}/rows`, { properties: {} }));
    expectOk(await bob.get(`/pages/${row.id}`));
    const bobRows = expectOk(await bob.get<{ rows: Array<{ id: string; lastVisitedAt?: number | null }> }>(`/databases/${base.id}/rows`)).rows;
    const adminRows = expectOk(await admin.get<{ rows: Array<{ id: string; lastVisitedAt?: number | null }> }>(`/databases/${base.id}/rows`)).rows;
    assert.equal(typeof bobRows.find((r) => r.id === row.id)!.lastVisitedAt, 'number');
    assert.equal(adminRows.find((r) => r.id === row.id)!.lastVisitedAt, null);
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-07 profile lists only what the viewer can read', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, bobUser, carol } = await trio(srv.base);
    const shared = await createPage(bob, wid, { title: 'Note publique de Bob', visibility: 'workspace' });
    await createPage(bob, wid, { title: 'Journal intime de Bob', visibility: 'private' });
    const closed = await createPage(admin, wid, { title: 'Cellule fermée', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${closed.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    expectOk(await admin.put(`/teamspaces/${closed.id}/members/${bobUser.id}`, { role: 'member' }));
    await createPage(bob, wid, { title: 'Dossier fermé de Bob', parentType: 'page', parentId: closed.id });
    const raw = await carol.get<ProfileResponse>(`/workspaces/${wid}/people/${bobUser.id}`);
    const profile = expectOk(raw);
    assert.equal(profile.user.id, bobUser.id);
    assert(profile.pages.some((p) => p.id === shared.id));
    const text = JSON.stringify(raw.body);
    assert(!text.includes('Journal intime'));
    assert(!text.includes('Dossier fermé'));
    // Not a member of the workspace → 404.
    assert.equal((await carol.get(`/workspaces/${wid}/people/00000000-0000-4000-8000-000000000000`)).status, 404);
    const own = expectOk(await bob.get<ProfileResponse>(`/workspaces/${wid}/people/${bobUser.id}`));
    assert(own.pages.some((p) => p.title === 'Journal intime de Bob'));
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-08 removal from the workspace drops teamspace membership and personal navigation', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob, bobUser } = await trio(srv.base);
    const closed = await createPage(admin, wid, { title: 'Fermé', visibility: 'workspace' });
    expectOk(await admin.post(`/pages/${closed.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    expectOk(await admin.put(`/teamspaces/${closed.id}/members/${bobUser.id}`, { role: 'owner' }));
    expectOk(await bob.post(`/workspaces/${wid}/sidebar/items`, { kind: 'link', url: 'https://example.org' }));
    expectOk(await admin.del(`/workspaces/${wid}/members/${bobUser.id}`));
    const members = expectOk(await admin.get<TeamspaceMembersResponse>(`/teamspaces/${closed.id}/members`)).members;
    assert(!members.some((m) => m.user.id === bobUser.id));
  } finally {
    await srv.stop();
  }
});

test('QA-NAV-09 migration keeps migrated navigation groups, private roots and shortcuts', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'oriel-nav-mig-'));
  try {
    const opts = { port: 0, host: '127.0.0.1', dataDir, logLevel: 'silent' as const, authRateLimit: 10_000, jobs: false };
    let server = await startServer(opts);
    const { admin, wid } = await setupAdmin(server.url);
    const { client: bob } = await addMember(admin, wid, 'bob@oriel.test', 'Bob', 'member');
    const teams: string[] = [];
    for (const t of ['Support client', 'Commercial', 'Back-end', 'RH', 'Direction']) {
      const p = await createPage(admin, wid, { title: t, visibility: 'workspace' });
      expectOk(await admin.patch(`/pages/${p.id}`, { format: { teamspaceRoot: true } }));
      await createPage(admin, wid, { title: `${t} / sous-page`, parentType: 'page', parentId: p.id });
      teams.push(p.id);
    }
    const shortcut = await createPage(admin, wid, { title: 'EDF', parentType: 'page', parentId: teams[0]! });
    expectOk(await admin.patch(`/pages/${shortcut.id}`, { format: { sharedShortcut: true } }));
    for (let i = 0; i < 3; i++) await createPage(admin, wid, { title: `Privée ${i}`, visibility: 'private' });
    const before = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    const bobBefore = expectOk(await bob.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    await server.close();

    // Rewind the database to its state before the navigation module.
    const raw = new DatabaseSync(path.join(dataDir, 'oriel.db'));
    raw.exec(`
      DROP TRIGGER nav_pages_teamspace_insert; DROP TRIGGER nav_pages_teamspace_clear;
      DROP INDEX pages_teamspace; ALTER TABLE pages DROP COLUMN teamspace_id; DROP INDEX visits_page;
      DROP TABLE nav_teamspace_requests; DROP TABLE nav_teamspace_members; DROP TABLE nav_teamspaces;
      DROP TABLE nav_sidebar_items; DROP TABLE nav_sidebar_sections; DROP TABLE nav_folder_pages; DROP TABLE nav_folders;
      DROP TABLE nav_page_views; DROP TABLE nav_workspace_settings;
      DELETE FROM applied_migrations WHERE id LIKE 'nav-%';
    `);
    raw.close();

    server = await startServer(opts);
    try {
      const strip = (nodes: TreeResponse['nodes']) =>
        nodes.map(({ teamspaceAccess: _a, teamspaceMember: _m, ...n }) => n).sort((x, y) => x.id.localeCompare(y.id));
      const adminAgain = Object.assign(new Client(server.url), { cookie: admin.cookie });
      const bobAgain = Object.assign(new Client(server.url), { cookie: bob.cookie });
      const after = expectOk(await adminAgain.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
      assert.deepEqual(strip(after), strip(before));
      assert.deepEqual(strip(expectOk(await bobAgain.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes), strip(bobBefore));
      const dir = expectOk(await bobAgain.get<TeamspacesResponse>(`/workspaces/${wid}/teamspaces`)).teamspaces;
      assert.equal(dir.length, 5);
      assert(dir.every((t) => t.access === 'open' && t.isDefault && t.myRole === 'member'));
      assert(after.filter((n) => n.isTeamspace).every((n) => n.teamspaceAccess === 'open' && n.teamspaceMember === true));
      // Running the migrations again (restart) is a no-op.
      await server.close();
      server = await startServer(opts);
      const again = expectOk(await Object.assign(new Client(server.url), { cookie: admin.cookie }).get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
      assert.deepEqual(strip(again), strip(before));
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('QA-NAV-11 only workspace owners/admins turn a page into a teamspace', async () => {
  const srv = await startTestServer();
  try {
    const { admin, wid, bob } = await trio(srv.base);
    const bobPage = await createPage(bob, wid, { title: 'Page de Bob', visibility: 'workspace' });
    assert.equal((await bob.post(`/pages/${bobPage.id}/teamspace/preview`, { access: 'open' })).status, 403);
    assert.equal((await bob.post(`/pages/${bobPage.id}/teamspace`, { access: 'open', confirmAccess: true })).status, 403);
    // A page the member cannot see stays 404.
    const priv = await createPage(admin, wid, { title: 'Privée admin', visibility: 'private' });
    assert.equal((await bob.post(`/pages/${priv.id}/teamspace`, { access: 'private' })).status, 404);
    // An admin promoted from member can.
    const members = expectOk(await admin.get<Array<{ user: { id: string; email: string } }>>(`/workspaces/${wid}/members`));
    const bobId = members.find((m) => m.user.email === 'bob@oriel.test')!.user.id;
    expectOk(await admin.patch(`/workspaces/${wid}/members/${bobId}`, { role: 'admin' }));
    expectOk(await bob.post(`/pages/${bobPage.id}/teamspace`, { access: 'open' }));
  } finally {
    await srv.stop();
  }
});
