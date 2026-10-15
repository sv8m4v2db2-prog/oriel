// Security regression tests: access control on the REST API (ARCHITECTURE §3.3).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseResponse, Page, PublicPageResponse, RowsResponse, SearchResponse, SessionResponse, TreeResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('security: access control', () => {
  let srv: TestServer;
  let owner: Client;
  let wid: string;
  let admin: Client;
  let adminId: string;
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let outsider: Client;
  let otherWid: string;
  let ownerId: string;

  before(async () => {
    srv = await startTestServer();
    let session: SessionResponse;
    ({ admin: owner, wid, session } = await setupAdmin(srv.base));
    ownerId = session.user.id;
    ({ client: admin, user: { id: adminId } } = await addMember(owner, wid, 'admin2@oriel.test', 'Adrien', 'admin'));
    ({ client: member, user: { id: memberId } } = await addMember(owner, wid, 'membre@oriel.test', 'Marc', 'member'));
    ({ client: viewer } = await addMember(owner, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await owner.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    const s = expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    otherWid = s.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  const createDatabase = async (c: Client, w: string, body: Record<string, unknown> = {}) =>
    createPage(c, w, { kind: 'database', title: 'Base', ...body });

  test('cross-workspace references and IDOR are refused (404, never 200)', async () => {
    const page = await createPage(owner, wid, { title: 'Confidentiel' });
    const dbPage = await createDatabase(owner, wid);
    const dbRes = expectOk(await owner.get<DatabaseResponse>(`/databases/${dbPage.id}`));
    const viewId = dbRes.views[0]!.id;
    const mine = await createPage(outsider, otherWid, { title: 'À moi' });
    const myDb = await createDatabase(outsider, otherWid);

    // Reads
    for (const url of [
      `/pages/${page.id}`,
      `/pages/${page.id}/backlinks`,
      `/pages/${page.id}/snapshots`,
      `/databases/${dbPage.id}`,
      `/databases/${dbPage.id}/rows`,
      `/workspaces/${wid}`,
      `/workspaces/${wid}/tree`,
      `/workspaces/${wid}/members`,
      `/workspaces/${wid}/search?q=Confidentiel`,
      `/workspaces/${wid}/trash`,
    ]) {
      assert.equal((await outsider.get(url)).status, 404, url);
    }
    // Writes on foreign objects
    assert.equal((await outsider.patch(`/pages/${page.id}`, { title: 'x' })).status, 404);
    assert.equal((await outsider.post(`/pages/${page.id}/trash`)).status, 404);
    assert.equal((await outsider.post(`/pages/${page.id}/publish`, { isPublic: true })).status, 404);
    assert.equal((await outsider.post(`/pages/${page.id}/duplicate`)).status, 404);
    assert.equal((await outsider.put(`/pages/${page.id}/favorite`, { favorite: true })).status, 404);
    assert.equal((await outsider.post(`/databases/${dbPage.id}/rows`, {})).status, 404);
    assert.equal((await outsider.post(`/databases/${dbPage.id}/properties`, { property: { type: 'text' } })).status, 404);
    assert.equal((await outsider.post(`/databases/${dbPage.id}/views`, { name: 'x', type: 'table' })).status, 404);
    assert.equal((await outsider.patch(`/views/${viewId}`, { name: 'x' })).status, 404);
    assert.equal((await outsider.del(`/views/${viewId}`)).status, 404);
    assert.equal((await outsider.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid })).status, 404);
    assert.equal((await outsider.post(`/workspaces/${wid}/invites`, { role: 'member' })).status, 404);
    assert.equal((await outsider.patch(`/workspaces/${wid}/members/${memberId}`, { role: 'viewer' })).status, 404);

    // Pointing own objects at foreign ones
    assert.equal((await outsider.post(`/workspaces/${otherWid}/pages`, { parentType: 'page', parentId: page.id })).status, 404);
    assert.equal((await outsider.post(`/workspaces/${otherWid}/pages`, { parentType: 'workspace', parentId: wid })).status, 400);
    assert.equal((await outsider.post(`/workspaces/${otherWid}/pages`, { parentType: 'database', parentId: dbPage.id })).status, 404);
    assert.equal((await outsider.post(`/pages/${mine.id}/move`, { parentType: 'page', parentId: page.id })).status, 404);
    assert.equal((await outsider.post(`/pages/${mine.id}/move`, { parentType: 'workspace', parentId: wid })).status, 400);
    assert.equal(
      (await outsider.post(`/databases/${myDb.id}/properties`, { property: { type: 'relation', relation: { databaseId: dbPage.id } } })).status,
      400,
    );
    // Reusing an existing id (from another workspace) for a new page/view is refused.
    assert.equal((await outsider.post(`/workspaces/${otherWid}/pages`, { id: page.id, parentType: 'workspace', parentId: otherWid })).status, 409);
    assert.equal((await outsider.post(`/databases/${myDb.id}/views`, { id: viewId, name: 'x', type: 'table' })).status, 409);

    // Nothing changed.
    const still = expectOk(await owner.get<{ page: Page }>(`/pages/${page.id}`)).page;
    assert.equal(still.title, 'Confidentiel');
    assert.equal(still.isPublic, false);
    assert.equal(still.trashedAt, null);
  });

  test('snapshots are bound to their page', async () => {
    const page = await createPage(owner, wid, { title: 'Historique' });
    const mine = await createPage(outsider, otherWid, { title: 'Mon historique' });
    const sid = randomUUID();
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare("INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, '[]', 'auto')").run(sid, page.id, new Uint8Array([0, 0]), Date.now());
    } finally {
      raw.close();
    }
    assert.equal((await outsider.get(`/pages/${page.id}/snapshots/${sid}`)).status, 404);
    assert.equal((await outsider.get(`/pages/${mine.id}/snapshots/${sid}`)).status, 404);
    assert.equal((await outsider.post(`/pages/${mine.id}/snapshots/${sid}/restore`)).status, 404);
    assert.equal((await viewer.post(`/pages/${page.id}/snapshots/${sid}/restore`)).status, 403);
    assert.equal((await member.get(`/pages/${page.id}/snapshots/${sid}`)).status, 200);
  });

  test('viewers cannot write anything', async () => {
    const page = await createPage(owner, wid, { title: 'Lecture seule' });
    const dbPage = await createDatabase(owner, wid);
    const viewId = expectOk(await owner.get<DatabaseResponse>(`/databases/${dbPage.id}`)).views[0]!.id;
    const rows = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    const attempts: Array<[string, Promise<{ status: number }>]> = [
      ['create page', viewer.post(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid })],
      ['create sub-page', viewer.post(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: page.id })],
      ['update', viewer.patch(`/pages/${page.id}`, { title: 'x' })],
      ['move', viewer.post(`/pages/${page.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' })],
      ['trash', viewer.post(`/pages/${page.id}/trash`)],
      ['publish', viewer.post(`/pages/${page.id}/publish`, { isPublic: true })],
      ['duplicate', viewer.post(`/pages/${page.id}/duplicate`)],
      ['row', viewer.post(`/databases/${dbPage.id}/rows`, {})],
      ['row update', viewer.patch(`/pages/${rows[0]!.id}`, { title: 'x' })],
      ['property', viewer.post(`/databases/${dbPage.id}/properties`, { property: { type: 'text' } })],
      ['view', viewer.patch(`/views/${viewId}`, { name: 'x' })],
      ['invite', viewer.post(`/workspaces/${wid}/invites`, { role: 'viewer' })],
      ['rename workspace', viewer.patch(`/workspaces/${wid}`, { name: 'x' })],
    ];
    for (const [label, p] of attempts) assert.equal((await p).status, 403, label);
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const up = await fetch(`${srv.base}/api/workspaces/${wid}/files`, { method: 'POST', headers: { cookie: `oriel_session=${viewer.cookie}` }, body: form });
    assert.equal(up.status, 403);
  });

  test('private pages are invisible to everyone else, admins and owners included', async () => {
    const secret = await createPage(member, wid, { title: 'Journal intime zéphyr', visibility: 'private' });
    const sub = await createPage(member, wid, { parentType: 'page', parentId: secret.id, title: 'Sous-page zéphyr' });
    const privDb = await createDatabase(member, wid, { parentType: 'page', parentId: secret.id, isInline: true });
    const shared = await createPage(member, wid, { title: 'Partagée' });
    for (const c of [owner, admin, viewer]) {
      for (const id of [secret.id, sub.id]) {
        assert.equal((await c.get(`/pages/${id}`)).status, 404);
        assert.equal((await c.patch(`/pages/${id}`, { title: 'x' })).status, 404);
        assert.equal((await c.post(`/pages/${id}/trash`)).status, 404);
        assert.equal((await c.put(`/pages/${id}/favorite`, { favorite: true })).status, 404);
      }
      assert.equal((await c.get(`/databases/${privDb.id}/rows`)).status, 404);
      const tree = expectOk(await c.get<TreeResponse>(`/workspaces/${wid}/tree`));
      assert.ok(!tree.nodes.some((n) => [secret.id, sub.id, privDb.id].includes(n.id)));
      const search = expectOk(await c.get<SearchResponse>(`/workspaces/${wid}/search?q=zéphyr`));
      assert.equal(search.results.length, 0);
    }
    // Cannot attach to / move under / relate to someone else's private page or database.
    assert.equal((await admin.post(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: secret.id })).status, 404);
    assert.equal((await admin.post(`/pages/${shared.id}/move`, { parentType: 'page', parentId: secret.id })).status, 404);
    const adminDb = await createDatabase(admin, wid);
    assert.equal(
      (await admin.post(`/databases/${adminDb.id}/properties`, { property: { type: 'relation', relation: { databaseId: privDb.id } } })).status,
      400,
    );
    // The owner still sees everything.
    expectOk(await member.get(`/pages/${sub.id}`));
  });

  test('role management: no escalation to owner, the last owner stays', async () => {
    assert.equal((await admin.patch(`/workspaces/${wid}/members/${adminId}`, { role: 'owner' })).status, 403);
    assert.equal((await admin.patch(`/workspaces/${wid}/members/${memberId}`, { role: 'owner' })).status, 403);
    assert.equal((await admin.patch(`/workspaces/${wid}/members/${ownerId}`, { role: 'member' })).status, 403);
    assert.equal((await admin.del(`/workspaces/${wid}/members/${ownerId}`)).status, 403);
    assert.equal((await admin.del(`/workspaces/${wid}`)).status, 403);
    assert.equal((await member.patch(`/workspaces/${wid}/members/${memberId}`, { role: 'admin' })).status, 403);
    assert.equal((await member.get(`/workspaces/${wid}/invites`)).status, 403);
    assert.equal((await owner.patch(`/workspaces/${wid}/members/${ownerId}`, { role: 'admin' })).status, 409);
    assert.equal((await owner.del(`/workspaces/${wid}/members/${ownerId}`)).status, 409);
    assert.equal((await admin.get('/admin/users')).status, 403);
    assert.equal((await admin.patch('/admin/settings', { signupMode: 'open' })).status, 403);
    // Accepting an invite never changes the role of an existing member.
    const invite = expectOk(await owner.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'admin' }));
    expectOk(await member.post(`/invites/${invite.token}/accept`));
    const members = expectOk(await owner.get<Array<{ user: { id: string }; role: string }>>(`/workspaces/${wid}/members`));
    assert.equal(members.find((m) => m.user.id === memberId)?.role, 'member');
  });

  test('public endpoints expose only published, non-trashed content', async () => {
    const parent = await createPage(owner, wid, { title: 'Parent non publié' });
    const pub = await createPage(owner, wid, { parentType: 'page', parentId: parent.id, title: 'Publié' });
    const child = await createPage(owner, wid, { parentType: 'page', parentId: pub.id, title: 'Enfant' });
    const trashedChild = await createPage(owner, wid, { parentType: 'page', parentId: pub.id, title: 'Enfant supprimé' });
    const inlineDb = await createDatabase(owner, wid, { parentType: 'page', parentId: pub.id, isInline: true });
    const sibling = await createPage(owner, wid, { parentType: 'page', parentId: parent.id, title: 'Voisin' });
    expectOk(await owner.post(`/pages/${pub.id}/publish`, { isPublic: true }));
    expectOk(await owner.post(`/pages/${trashedChild.id}/trash`));
    const anon = new Client(srv.base);

    const res = expectOk(await anon.get<PublicPageResponse>(`/public/pages/${pub.id}`));
    assert.deepEqual(res.ancestors, [], 'unpublished ancestors are not disclosed');
    assert.ok(!res.children.some((c) => c.id === trashedChild.id));
    expectOk(await anon.get(`/public/pages/${child.id}`));
    assert.equal((await anon.get(`/public/pages/${trashedChild.id}`)).status, 404);
    assert.equal((await anon.get(`/public/pages/${parent.id}`)).status, 404);
    assert.equal((await anon.get(`/public/pages/${sibling.id}`)).status, 404);
    const rows = expectOk(await anon.get<RowsResponse>(`/public/databases/${inlineDb.id}/rows`));
    assert.ok(rows.users.length > 0);
    assert.ok(rows.users.every((u) => u.email === ''), 'emails are hidden from the public');
    // Session-only endpoints stay closed to anonymous visitors.
    assert.equal((await anon.get(`/pages/${pub.id}`)).status, 401);
    assert.equal((await anon.get(`/databases/${inlineDb.id}/rows`)).status, 401);

    expectOk(await owner.post(`/pages/${pub.id}/trash`));
    assert.equal((await anon.get(`/public/pages/${pub.id}`)).status, 404);
    assert.equal((await anon.get(`/public/pages/${child.id}`)).status, 404);
    assert.equal((await anon.get(`/public/databases/${inlineDb.id}`)).status, 404);
  });

  test('removed members lose access immediately', async () => {
    const { client: temp, user } = await addMember(owner, wid, 'temp@oriel.test', 'Tim', 'member');
    const page = await createPage(owner, wid, { title: 'Après départ' });
    expectOk(await temp.get(`/pages/${page.id}`));
    expectOk(await admin.del(`/workspaces/${wid}/members/${user.id}`));
    assert.equal((await temp.get(`/pages/${page.id}`)).status, 404);
    assert.equal((await temp.get(`/workspaces/${wid}/tree`)).status, 404);
  });
});
