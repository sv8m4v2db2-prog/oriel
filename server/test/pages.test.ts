import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DatabaseResponse,
  FavoritesResponse,
  Page,
  PageDetailResponse,
  PublicPageResponse,
  RecentResponse,
  RowsResponse,
  SessionResponse,
  TrashResponse,
  TreeResponse,
} from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('pages', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  const tree = async (c: Client) => expectOk(await c.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;

  test('create, read, update a page', async () => {
    const page = await createPage(admin, wid, { title: 'Projets', icon: '📁' });
    assert.equal(page.parentType, 'workspace');
    assert.equal(page.visibility, 'workspace');
    assert.equal(page.version, 1);
    const detail = expectOk(await member.get<PageDetailResponse>(`/pages/${page.id}`));
    assert.equal(detail.page.title, 'Projets');
    assert.equal(detail.role, 'member');
    assert.equal(detail.canEdit, true);
    assert.deepEqual(detail.ancestors, []);
    assert.equal(detail.publiclyVisible, false);

    const updated = expectOk(
      await member.patch<Page>(`/pages/${page.id}`, {
        title: 'Projets 2026',
        cover: { type: 'gradient', value: 'aurora' },
        format: { fullWidth: true, coverPosition: 30 },
      }),
    );
    assert.equal(updated.title, 'Projets 2026');
    assert.deepEqual(updated.cover, { type: 'gradient', value: 'aurora' });
    assert.deepEqual(updated.format, { fullWidth: true, coverPosition: 30 });
    assert.equal(updated.version, 2);
    assert.equal(updated.updatedBy, detail.page.ownerId === updated.updatedBy ? updated.updatedBy : updated.updatedBy);
    const cleared = expectOk(await member.patch<Page>(`/pages/${page.id}`, { format: { fullWidth: null } }));
    assert.deepEqual(cleared.format, { coverPosition: 30 });
    const bad = await member.patch(`/pages/${page.id}`, { cover: { type: 'gradient', value: 'nope' } });
    assert.equal(bad.status, 400);

    // client-provided id + position hints
    const id = crypto.randomUUID();
    const first = await createPage(admin, wid, { id, title: 'Premier', after: null });
    assert.equal(first.id, id);
    const dupId = await admin.post(`/workspaces/${wid}/pages`, { id, parentType: 'workspace', parentId: wid });
    assert.equal(dupId.status, 409);
    const nodes = await tree(admin);
    const roots = nodes.filter((n) => n.parentType === 'workspace').sort((a, b) => (a.position < b.position ? -1 : 1));
    assert.equal(roots[0]!.id, id);
  });

  test('viewer cannot edit', async () => {
    const page = await createPage(admin, wid, { title: 'Lecture seule' });
    const detail = expectOk(await viewer.get<PageDetailResponse>(`/pages/${page.id}`));
    assert.equal(detail.canEdit, false);
    assert.equal(detail.role, 'viewer');
    assert.equal((await viewer.patch(`/pages/${page.id}`, { title: 'Hack' })).status, 403);
    assert.equal((await viewer.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid })).status, 403);
    assert.equal((await viewer.post(`/pages/${page.id}/trash`)).status, 403);
    // but can favorite
    expectOk(await viewer.put(`/pages/${page.id}/favorite`, { favorite: true }));
  });

  test('cross-workspace isolation returns 404', async () => {
    const other = new Client(srv.base);
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const s = expectOk(await other.post<SessionResponse>('/auth/signup', { email: 'autre@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'invite' }));
    const otherWid = s.workspaces[0]!.id;
    const page = await createPage(admin, wid, { title: 'Secret interne' });
    for (const res of [
      await other.get(`/pages/${page.id}`),
      await other.patch(`/pages/${page.id}`, { title: 'x' }),
      await other.get(`/workspaces/${wid}/tree`),
      await other.get(`/workspaces/${wid}`),
      await other.get(`/workspaces/${wid}/members`),
      await other.post(`/pages/${page.id}/trash`),
      await other.get(`/pages/${page.id}/backlinks`),
    ]) {
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'not_found');
    }
    // cannot create a child under a page of another workspace
    const res = await other.post(`/workspaces/${otherWid}/pages`, { parentType: 'page', parentId: page.id });
    assert.equal(res.status, 404);
    const search = expectOk(await other.get(`/workspaces/${otherWid}/search?q=Secret`));
    assert.equal(search.results.length, 0);
  });

  test('private pages are invisible to other members (even admins)', async () => {
    const priv = await createPage(member, wid, { title: 'Journal intime', visibility: 'private' });
    const child = await createPage(member, wid, { parentType: 'page', parentId: priv.id, title: 'Sous-page privée' });
    assert.equal(child.visibility, 'private');
    assert.equal(child.ownerId, priv.ownerId);
    assert.equal((await admin.get(`/pages/${priv.id}`)).status, 404);
    assert.equal((await admin.get(`/pages/${child.id}`)).status, 404);
    assert.ok(!(await tree(admin)).some((n) => n.id === priv.id || n.id === child.id));
    assert.ok((await tree(member)).some((n) => n.id === priv.id));
    const search = expectOk(await admin.get(`/workspaces/${wid}/search?q=intime`));
    assert.equal(search.results.length, 0);
    const mine = expectOk(await member.get(`/workspaces/${wid}/search?q=intime`));
    assert.equal(mine.results.length, 1);
    // moving to the shared section makes the subtree visible
    expectOk(await member.post(`/pages/${priv.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'workspace' }));
    const seen = expectOk(await admin.get<PageDetailResponse>(`/pages/${child.id}`));
    assert.equal(seen.page.visibility, 'workspace');
    // and back to private
    expectOk(await member.post(`/pages/${priv.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    assert.equal((await admin.get(`/pages/${child.id}`)).status, 404);
  });

  test('move: reorder, reparent, cycles rejected', async () => {
    const a = await createPage(admin, wid, { title: 'A' });
    const b = await createPage(admin, wid, { parentType: 'page', parentId: a.id, title: 'B' });
    const c = await createPage(admin, wid, { parentType: 'page', parentId: b.id, title: 'C' });
    for (const target of [a.id, b.id, c.id]) {
      const res = await admin.post(`/pages/${a.id}/move`, { parentType: 'page', parentId: target });
      assert.equal(res.status, 400, `move into ${target}`);
      assert.equal(res.body.error.code, 'validation');
    }
    const moved = expectOk(await admin.post<Page>(`/pages/${c.id}/move`, { parentType: 'page', parentId: a.id, after: null }));
    assert.equal(moved.parentId, a.id);
    assert.ok(moved.position < b.position);
    const detail = expectOk(await admin.get<PageDetailResponse>(`/pages/${c.id}`));
    assert.deepEqual(
      detail.ancestors.map((x) => x.id),
      [a.id],
    );
    const toRoot = expectOk(await admin.post<Page>(`/pages/${b.id}/move`, { parentType: 'workspace', parentId: wid }));
    assert.equal(toRoot.parentType, 'workspace');
    assert.equal((await admin.post(`/pages/${b.id}/move`, { parentType: 'database', parentId: a.id })).status, 400);
  });

  test('trash, restore and permanent delete of a subtree', async () => {
    const root = await createPage(admin, wid, { title: 'Racine corbeille' });
    const child = await createPage(admin, wid, { parentType: 'page', parentId: root.id, title: 'Enfant' });
    const grandchild = await createPage(admin, wid, { parentType: 'page', parentId: child.id, title: 'Petit-enfant' });
    const db = await createPage(admin, wid, { parentType: 'page', parentId: root.id, kind: 'database', title: 'Base' });

    // delete permanently without trash first → conflict
    assert.equal((await admin.del(`/pages/${root.id}`)).status, 409);

    expectOk(await admin.post(`/pages/${root.id}/trash`));
    const nodes = await tree(admin);
    for (const id of [root.id, child.id, grandchild.id, db.id]) assert.ok(!nodes.some((n) => n.id === id));
    const trash = expectOk(await admin.get<TrashResponse>(`/workspaces/${wid}/trash`));
    assert.deepEqual(
      trash.items.map((i) => i.page.id),
      [root.id],
    );
    const trashedChild = expectOk(await admin.get<PageDetailResponse>(`/pages/${grandchild.id}`));
    assert.ok(trashedChild.page.trashedAt);
    // creating under a trashed page is refused
    assert.equal((await admin.post(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: child.id })).status, 400);

    const restored = expectOk(await admin.post<Page>(`/pages/${root.id}/restore`));
    assert.equal(restored.trashedAt, null);
    const after = await tree(admin);
    for (const id of [root.id, child.id, grandchild.id, db.id]) assert.ok(after.some((n) => n.id === id), id);
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${db.id}/rows`));
    assert.equal(rows.rows.length, 3);

    // Child trashed alone, then its parent: restoring the child alone sends it to the root.
    expectOk(await admin.post(`/pages/${child.id}/trash`));
    expectOk(await admin.post(`/pages/${root.id}/trash`));
    const trash2 = expectOk(await admin.get<TrashResponse>(`/workspaces/${wid}/trash`));
    assert.equal(trash2.items.length, 2);
    const back = expectOk(await admin.post<Page>(`/pages/${child.id}/restore`));
    assert.equal(back.parentType, 'workspace');
    assert.equal(back.parentId, wid);
    const gc = expectOk(await admin.get<PageDetailResponse>(`/pages/${grandchild.id}`));
    assert.equal(gc.page.trashedAt, null);

    // Permanent delete removes the whole subtree.
    expectOk(await admin.del(`/pages/${root.id}`));
    assert.equal((await admin.get(`/pages/${root.id}`)).status, 404);
    assert.equal((await admin.get(`/pages/${db.id}`)).status, 404);
    assert.equal((await admin.get(`/databases/${db.id}`)).status, 404);
    assert.equal((await admin.get(`/pages/${child.id}`)).status, 200, 'restored child survives');
    const trash3 = expectOk(await admin.get<TrashResponse>(`/workspaces/${wid}/trash`));
    assert.equal(trash3.items.length, 0);
  });

  test('duplicate a page tree including a database with rows and views', async () => {
    const root = await createPage(admin, wid, { title: 'Modèle' });
    const sub = await createPage(admin, wid, { parentType: 'page', parentId: root.id, title: 'Sous-modèle' });
    const dbPage = await createPage(admin, wid, { parentType: 'page', parentId: root.id, kind: 'database', title: 'Tâches', isInline: true });
    const dbInfo = expectOk(await admin.get<DatabaseResponse>(`/databases/${dbPage.id}`));
    const tags = dbInfo.schema.properties.find((p) => p.type === 'multi_select')!;
    const schema = expectOk(
      await admin.patch(`/databases/${dbPage.id}/properties/${tags.id}`, { options: [{ id: 'urgent', name: 'Urgent', color: 'red' }] }),
    );
    assert.equal(schema.properties[1].options.length, 1);
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    expectOk(await admin.patch(`/pages/${rows[0]!.id}`, { title: 'Écrire la doc', properties: { [tags.id]: ['urgent'] } }));
    expectOk(await admin.post(`/databases/${dbPage.id}/views`, { name: 'Kanban', type: 'board' }));

    const copy = expectOk(await admin.post<Page>(`/pages/${root.id}/duplicate`));
    assert.notEqual(copy.id, root.id);
    assert.equal(copy.title, 'Modèle (copie)');
    assert.equal(copy.parentId, root.parentId);
    assert.ok(copy.position > root.position);
    const nodes = await tree(admin);
    const copiedChildren = nodes.filter((n) => n.parentId === copy.id);
    assert.equal(copiedChildren.length, 2);
    assert.ok(copiedChildren.some((n) => n.title === 'Sous-modèle' && n.id !== sub.id));
    const copiedDb = copiedChildren.find((n) => n.kind === 'database')!;
    assert.equal(copiedDb.isInline, true);
    const copiedInfo = expectOk(await admin.get<DatabaseResponse>(`/databases/${copiedDb.id}`));
    assert.equal(copiedInfo.views.length, 2);
    assert.deepEqual(
      copiedInfo.views.map((v) => v.name),
      ['Tableau', 'Kanban'],
    );
    assert.ok(copiedInfo.views.every((v) => v.databaseId === copiedDb.id && !dbInfo.views.some((o) => o.id === v.id)));
    assert.deepEqual(copiedInfo.schema.properties, schema.properties);
    const copiedRows = expectOk(await admin.get<RowsResponse>(`/databases/${copiedDb.id}/rows`)).rows;
    assert.equal(copiedRows.length, 3);
    const doc = copiedRows.find((r) => r.title === 'Écrire la doc')!;
    assert.deepEqual(doc.properties[tags.id], ['urgent']);
    assert.ok(!rows.some((r) => r.id === doc.id));

    // duplicate a single row stays in its database
    const rowCopy = expectOk(await admin.post<Page>(`/pages/${rows[0]!.id}/duplicate`));
    assert.equal(rowCopy.parentType, 'database');
    assert.equal(rowCopy.parentId, dbPage.id);
    assert.equal(rowCopy.title, 'Écrire la doc (copie)');
  });

  test('favorites are per user and ordered', async () => {
    const p1 = await createPage(admin, wid, { title: 'Fav 1' });
    const p2 = await createPage(admin, wid, { title: 'Fav 2' });
    const p3 = await createPage(admin, wid, { title: 'Fav 3' });
    expectOk(await member.put(`/pages/${p1.id}/favorite`, { favorite: true }));
    expectOk(await member.put(`/pages/${p2.id}/favorite`, { favorite: true }));
    let res = expectOk(await member.put(`/pages/${p3.id}/favorite`, { favorite: true, after: null }));
    assert.deepEqual(res.favorites, [p3.id, p1.id, p2.id]);
    res = expectOk(await member.put(`/pages/${p3.id}/favorite`, { favorite: true, after: p2.id }));
    assert.deepEqual(res.favorites, [p1.id, p2.id, p3.id]);
    const list = expectOk(await member.get<FavoritesResponse>(`/workspaces/${wid}/favorites`));
    assert.deepEqual(
      list.favorites.map((f) => f.id),
      [p1.id, p2.id, p3.id],
    );
    const detail = expectOk(await member.get<PageDetailResponse>(`/pages/${p1.id}`));
    assert.equal(detail.isFavorite, true);
    const adminFavs = expectOk(await admin.get<FavoritesResponse>(`/workspaces/${wid}/favorites`));
    assert.ok(!adminFavs.favorites.some((f) => f.id === p1.id));
    res = expectOk(await member.put(`/pages/${p1.id}/favorite`, { favorite: false }));
    assert.deepEqual(res.favorites, [p2.id, p3.id]);
    // trashed favorites disappear
    expectOk(await admin.post(`/pages/${p2.id}/trash`));
    const after = expectOk(await member.get<FavoritesResponse>(`/workspaces/${wid}/favorites`));
    assert.deepEqual(
      after.favorites.map((f) => f.id),
      [p3.id],
    );
  });

  test('recent pages and search by title', async () => {
    const p = await createPage(admin, wid, { title: 'Réunion hebdomadaire' });
    expectOk(await member.get(`/pages/${p.id}`));
    const recent = expectOk(await member.get<RecentResponse>(`/workspaces/${wid}/recent`));
    assert.equal(recent.pages[0]!.id, p.id);
    assert.ok(recent.pages[0]!.visitedAt > 0);
    const search = expectOk(await member.get(`/workspaces/${wid}/search?q=reunion%20hebdo&limit=5`));
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].page.id, p.id);
    assert.equal(search.results[0].page.workspaceId, wid);
    assert.equal(search.results[0].snippet, '');
    const weird = expectOk(await member.get(`/workspaces/${wid}/search?q=${encodeURIComponent('" OR * NEAR( -')}`));
    assert.deepEqual(weird.results, []);
  });

  test('publish: public read-only access to the page and its descendants', async () => {
    const root = await createPage(admin, wid, { title: 'Site public' });
    const child = await createPage(admin, wid, { parentType: 'page', parentId: root.id, title: 'À propos' });
    const anon = new Client(srv.base);
    assert.equal((await anon.get(`/public/pages/${root.id}`)).status, 404);
    const published = expectOk(await admin.post<Page>(`/pages/${root.id}/publish`, { isPublic: true }));
    assert.equal(published.isPublic, true);
    const pub = expectOk(await anon.get<PublicPageResponse>(`/public/pages/${root.id}`));
    assert.equal(pub.page.title, 'Site public');
    assert.deepEqual(
      pub.children.map((c) => c.id),
      [child.id],
    );
    const pubChild = expectOk(await anon.get<PublicPageResponse>(`/public/pages/${child.id}`));
    assert.deepEqual(
      pubChild.ancestors.map((a) => a.id),
      [root.id],
    );
    const detail = expectOk(await admin.get<PageDetailResponse>(`/pages/${child.id}`));
    assert.equal(detail.publiclyVisible, true);
    // anonymous users cannot write
    assert.equal((await anon.patch(`/pages/${child.id}`, { title: 'x' })).status, 401);
    expectOk(await admin.post(`/pages/${root.id}/publish`, { isPublic: false }));
    assert.equal((await anon.get(`/public/pages/${child.id}`)).status, 404);
  });

  test('members management keeps at least one owner', async () => {
    const members = expectOk(await admin.get(`/workspaces/${wid}/members`));
    const me = members.find((m: { role: string }) => m.role === 'owner');
    const res = await admin.patch(`/workspaces/${wid}/members/${me.user.id}`, { role: 'admin' });
    assert.equal(res.status, 409);
    assert.equal((await admin.del(`/workspaces/${wid}/members/${me.user.id}`)).status, 409);
    const target = members.find((m: { user: { email: string } }) => m.user.email === 'lecteur@oriel.test');
    const updated = expectOk(await admin.patch(`/workspaces/${wid}/members/${target.user.id}`, { role: 'member' }));
    assert.equal(updated.role, 'member');
    assert.equal((await member.patch(`/workspaces/${wid}/members/${target.user.id}`, { role: 'viewer' })).status, 403);
  });
});
