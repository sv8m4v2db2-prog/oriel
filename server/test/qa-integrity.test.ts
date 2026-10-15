// QA (integrity): access control core, page tree, workspaces/members/invites, trash/restore/purge,
// duplication, favorites/visits, migrations and jobs. Each test is a reproduction of a suspected
// flaw; those still open are marked `todo` with their QA-INT id.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import type { Page, PageDetailResponse, RowsResponse, SessionResponse, TrashResponse, TreeResponse } from '@oriel/shared';
import { newId } from '@oriel/shared';
import { startServer } from '../src/app.js';
import { resolveConfig } from '../src/config.js';
import { noopCollab, type AppContext } from '../src/context.js';
import { EventBus } from '../src/realtime/events.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { createWorkspace } from '../src/services/workspaces.js';
import { createPage as createPageSvc, restorePage, trashPage } from '../src/services/pages.js';
import { runMaintenance } from '../src/jobs.js';
import { Db, openDatabase } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { FEATURE_MIGRATIONS } from '../src/db/features/index.js';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor, type Res, type TestServer } from './helpers.js';

/** Read-only handle on the test server's database (invariant checks). */
function openRaw(srv: TestServer): DatabaseSync {
  return new DatabaseSync(path.join(srv.dataDir, 'oriel.db'), { readOnly: true });
}

function rawAll<T>(srv: TestServer, sql: string, ...params: Array<string | number | null>): T[] {
  const raw = openRaw(srv);
  try {
    return raw.prepare(sql).all(...params) as T[];
  } finally {
    raw.close();
  }
}

interface TreeRow {
  id: string;
  workspace_id: string;
  parent_type: string;
  parent_id: string;
  kind: string;
  visibility: string;
  owner_id: string;
  trashed_at: number | null;
  trash_root: number;
  position: string;
}

/** Structural invariants of the page tree (ARCHITECTURE §3.2–3.4); returns the violations found. */
function treeViolations(srv: TestServer): string[] {
  const pages = rawAll<TreeRow>(srv, 'SELECT id, workspace_id, parent_type, parent_id, kind, visibility, owner_id, trashed_at, trash_root, position FROM pages');
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: string[] = [];
  const reachesRoot = new Set<string>();
  for (const p of pages) {
    if (p.parent_type === 'workspace') {
      if (p.parent_id !== p.workspace_id) out.push(`${p.id}: workspace root of another workspace`);
    } else {
      const parent = byId.get(p.parent_id);
      if (!parent) {
        out.push(`${p.id}: missing parent ${p.parent_id}`);
        continue;
      }
      if (parent.workspace_id !== p.workspace_id) out.push(`${p.id}: parent in another workspace`);
      if (p.parent_type === 'database' && (parent.kind !== 'database' || p.kind !== 'page')) out.push(`${p.id}: bad row`);
      if (p.parent_type === 'page' && parent.kind !== 'page') out.push(`${p.id}: page under a database`);
      if (parent.visibility !== p.visibility) out.push(`${p.id}: visibility ${p.visibility} under ${parent.visibility}`);
      else if (p.visibility === 'private' && parent.owner_id !== p.owner_id) out.push(`${p.id}: private owner differs from parent`);
      if (parent.trashed_at !== null && p.trashed_at === null) out.push(`${p.id}: alive under a trashed parent`);
      if (p.trashed_at !== null && p.trash_root === 0 && parent.trashed_at === null) out.push(`${p.id}: trashed, not a trash root, alive parent (lost)`);
    }
    if (p.trashed_at === null && p.trash_root !== 0) out.push(`${p.id}: trash_root without trashed_at`);
    if (p.trashed_at !== null && p.trash_root === 0 && p.parent_type === 'workspace') out.push(`${p.id}: trashed root-level page not a trash root (lost)`);
    // No cycle: every page reaches a workspace root (memoized walk, linear overall).
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: TreeRow | undefined = p;
    let cyclic = false;
    while (cur && cur.parent_type !== 'workspace' && !reachesRoot.has(cur.id)) {
      if (onPath.has(cur.id)) {
        cyclic = true;
        break;
      }
      onPath.add(cur.id);
      path.push(cur.id);
      cur = byId.get(cur.parent_id);
    }
    if (cyclic) out.push(`${p.id}: cycle`);
    else for (const id of path) reachesRoot.add(id);
  }
  return out;
}

describe('qa integrity: page tree and access core', () => {
  let srv: TestServer;
  let owner: Client;
  let ownerId: string;
  let wid: string;
  let admin: Client;
  let member: Client;
  let memberId: string;
  let member2: Client;
  let viewer: Client;
  let outsider: Client;
  let otherWid: string;

  before(async () => {
    srv = await startTestServer();
    let session: SessionResponse;
    ({ admin: owner, wid, session } = await setupAdmin(srv.base));
    ownerId = session.user.id;
    ({ client: admin } = await addMember(owner, wid, 'qa-admin@oriel.test', 'Adèle', 'admin'));
    ({ client: member, user: { id: memberId } } = await addMember(owner, wid, 'qa-member@oriel.test', 'Marius', 'member'));
    ({ client: member2 } = await addMember(owner, wid, 'qa-member2@oriel.test', 'Maud', 'member'));
    ({ client: viewer } = await addMember(owner, wid, 'qa-viewer@oriel.test', 'Victor', 'viewer'));
    expectOk(await owner.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    const s = expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'qa-out@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    otherWid = s.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  test('move: visibility and owner follow the destination over the whole subtree (rows, inline db, trashed)', async () => {
    const p = await createPage(owner, wid, { title: 'Partagée' });
    const c = await createPage(owner, wid, { parentType: 'page', parentId: p.id, title: 'Enfant' });
    const inline = await createPage(owner, wid, { parentType: 'page', parentId: c.id, kind: 'database', isInline: true, title: 'Base' });
    const t = await createPage(owner, wid, { parentType: 'page', parentId: c.id, title: 'Supprimée' });
    expectOk(await owner.post(`/pages/${t.id}/trash`));
    const q = await createPage(member, wid, { title: 'Privée de Marius', visibility: 'private' });
    expectOk(await member.post(`/pages/${p.id}/move`, { parentType: 'page', parentId: q.id }));
    const ids = [p.id, c.id, inline.id, t.id];
    const rows = rawAll<{ id: string; visibility: string; owner_id: string }>(
      srv,
      `WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id AND p.parent_type IN ('page','database'))
       SELECT p.id, p.visibility, p.owner_id FROM pages p JOIN d ON d.id = p.id`,
      p.id,
    );
    assert.ok(rows.length >= ids.length + 3, 'subtree includes the database rows');
    for (const r of rows) {
      assert.equal(r.visibility, 'private', r.id);
      assert.equal(r.owner_id, memberId, r.id);
    }
    for (const id of ids) assert.equal((await owner.get(`/pages/${id}`)).status, 404);
    // Back to the shared section.
    expectOk(await member.post(`/pages/${p.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'workspace' }));
    for (const id of ids) expectOk(await owner.get(`/pages/${id}`));
  });

  test('move: parent type / parent id mismatches are refused', async () => {
    const a = await createPage(owner, wid, { title: 'A' });
    const dbPage = await createPage(owner, wid, { kind: 'database', title: 'Base A' });
    const dbB = await createPage(owner, wid, { kind: 'database', title: 'Base B' });
    const rows = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    const row = rows[0]!;
    const trashed = await createPage(owner, wid, { title: 'Corbeille' });
    expectOk(await owner.post(`/pages/${trashed.id}/trash`));
    const foreign = await createPage(outsider, otherWid, { title: 'Ailleurs' });

    const cases: Array<[string, string, Record<string, unknown>, number]> = [
      ['page into a database', a.id, { parentType: 'database', parentId: dbPage.id }, 400],
      ['page under a database (parentType page)', a.id, { parentType: 'page', parentId: dbPage.id }, 400],
      ['row out of its database', row.id, { parentType: 'workspace', parentId: wid }, 400],
      ['row under a page', row.id, { parentType: 'page', parentId: a.id }, 400],
      ['row into another database', row.id, { parentType: 'database', parentId: dbB.id }, 400],
      ['database under its own row', dbPage.id, { parentType: 'page', parentId: row.id }, 400],
      ['into a trashed parent', a.id, { parentType: 'page', parentId: trashed.id }, 400],
      ['to another workspace root', a.id, { parentType: 'workspace', parentId: otherWid }, 400],
      ['workspace root with a page id', a.id, { parentType: 'workspace', parentId: a.id }, 400],
      ['under a foreign page', a.id, { parentType: 'page', parentId: foreign.id }, 404],
      ['trashed page itself', trashed.id, { parentType: 'workspace', parentId: wid }, 400],
    ];
    for (const [label, id, body, status] of cases) {
      assert.equal((await owner.post(`/pages/${id}/move`, body)).status, status, label);
    }
    // Rows can still be reordered inside their database.
    expectOk(await owner.post(`/pages/${row.id}/move`, { parentType: 'database', parentId: dbPage.id, after: rows[2]!.id }));
  });

  test('create: parents, kinds and values are validated', async () => {
    const page = await createPage(owner, wid, { title: 'Parent' });
    const dbPage = await createPage(owner, wid, { kind: 'database', title: 'Base' });
    const trashed = await createPage(owner, wid, { title: 'Corbeille' });
    expectOk(await owner.post(`/pages/${trashed.id}/trash`));
    const priv = await createPage(member, wid, { title: 'Secret', visibility: 'private' });
    const post = (c: Client, body: Record<string, unknown>) => c.post(`/workspaces/${wid}/pages`, body);
    const cases: Array<[string, Client, Record<string, unknown>, number]> = [
      ['row in a non-database', owner, { parentType: 'database', parentId: page.id }, 400],
      ['sub-page of a database', owner, { parentType: 'page', parentId: dbPage.id }, 400],
      ['database as a row', owner, { parentType: 'database', parentId: dbPage.id, kind: 'database' }, 400],
      ['under a trashed page', owner, { parentType: 'page', parentId: trashed.id }, 400],
      ["under someone else's private page", admin, { parentType: 'page', parentId: priv.id }, 404],
      ['viewer', viewer, { parentType: 'workspace', parentId: wid }, 403],
      ['unknown kind', owner, { parentType: 'workspace', parentId: wid, kind: 'folder' }, 400],
      ['javascript: cover', owner, { parentType: 'workspace', parentId: wid, cover: { type: 'image', url: 'javascript:alert(1)' } }, 400],
      ['data: cover', owner, { parentType: 'workspace', parentId: wid, cover: { type: 'image', url: 'data:text/html,x' } }, 400],
      ['huge icon', owner, { parentType: 'workspace', parentId: wid, icon: 'x'.repeat(10_000) }, 400],
      ['huge title', owner, { parentType: 'workspace', parentId: wid, title: 'x'.repeat(5000) }, 400],
      ['properties on a page', owner, { parentType: 'workspace', parentId: wid, properties: { x: 'y' } }, 400],
      ['bad id', owner, { parentType: 'workspace', parentId: wid, id: '../../etc' }, 400],
    ];
    for (const [label, c, body, status] of cases) assert.equal((await post(c, body)).status, status, label);
  });

  test("trash, restore and permanent delete of someone else's private page are refused; trash list hides them", async () => {
    const priv = await createPage(member, wid, { title: 'Brouillon privé' });
    expectOk(await member.post(`/pages/${priv.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    expectOk(await member.post(`/pages/${priv.id}/trash`));
    for (const c of [owner, admin, member2]) {
      assert.equal((await c.post(`/pages/${priv.id}/restore`)).status, 404);
      assert.equal((await c.del(`/pages/${priv.id}`)).status, 404);
      const trash = expectOk(await c.get<TrashResponse>(`/workspaces/${wid}/trash`));
      assert.ok(!trash.items.some((i) => i.page.id === priv.id));
    }
    const mine = expectOk(await member.get<TrashResponse>(`/workspaces/${wid}/trash`));
    assert.ok(mine.items.some((i) => i.page.id === priv.id));
    // A viewer can neither restore nor delete shared trash.
    const shared = await createPage(owner, wid, { title: 'Partagée supprimée' });
    expectOk(await owner.post(`/pages/${shared.id}/trash`));
    assert.equal((await viewer.post(`/pages/${shared.id}/restore`)).status, 403);
    assert.equal((await viewer.del(`/pages/${shared.id}`)).status, 403);
  });

  test('permanent delete leaves no orphan rows behind', async () => {
    const root = await createPage(owner, wid, { title: 'À détruire' });
    const child = await createPage(owner, wid, { parentType: 'page', parentId: root.id, title: 'Enfant' });
    const dbPage = await createPage(owner, wid, { parentType: 'page', parentId: root.id, kind: 'database', title: 'Base' });
    expectOk(await member.put(`/pages/${child.id}/favorite`, { favorite: true }));
    expectOk(await member.get(`/pages/${child.id}`));
    expectOk(await owner.post(`/databases/${dbPage.id}/views`, { name: 'Kanban', type: 'board' }));
    expectOk(await owner.post(`/databases/${dbPage.id}/templates`, { title: 'Modèle' }));
    expectOk(await owner.post(`/pages/${root.id}/trash`));
    expectOk(await owner.del(`/pages/${root.id}`));
    const orphans = (sql: string) => rawAll<{ n: number }>(srv, sql)[0]!.n;
    for (const [table, col] of [
      ['favorites', 'page_id'],
      ['visits', 'page_id'],
      ['documents', 'page_id'],
      ['snapshots', 'page_id'],
      ['page_links', 'source_id'],
      ['databases', 'page_id'],
      ['database_templates', 'page_id'],
      ['collab_threads', 'page_id'],
      ['collab_reminders', 'page_id'],
      ['collab_page_mentions', 'page_id'],
    ] as const) {
      assert.equal(orphans(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} NOT IN (SELECT id FROM pages)`), 0, table);
    }
    assert.equal(orphans('SELECT COUNT(*) AS n FROM views WHERE database_id NOT IN (SELECT page_id FROM databases)'), 0, 'views');
    assert.equal(orphans('SELECT COUNT(*) AS n FROM search WHERE page_id NOT IN (SELECT id FROM pages)'), 0, 'search');
    assert.equal(
      orphans(`SELECT COUNT(*) AS n FROM pages WHERE parent_type != 'workspace' AND parent_id NOT IN (SELECT id FROM pages)`),
      0,
      'pages without parent',
    );
  });

  test('restore: rows wait for their database; a restored database brings its rows back', async () => {
    const dbPage = await createPage(owner, wid, { kind: 'database', title: 'Base restaurée' });
    const rows = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    expectOk(await owner.post(`/pages/${rows[0]!.id}/trash`));
    // (Same-millisecond deletions: see QA-INT-01.)
    expectOk(await owner.post(`/pages/${dbPage.id}/trash`));
    assert.equal((await owner.post(`/pages/${rows[1]!.id}/restore`)).status, 409);
    expectOk(await owner.post(`/pages/${dbPage.id}/restore`));
    const after = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    assert.deepEqual(after.map((r) => r.id).sort(), [rows[1]!.id, rows[2]!.id].sort(), 'the row trashed on its own stays in the trash');
    expectOk(await owner.post(`/pages/${rows[0]!.id}/restore`));
  });

  test('QA-INT-01: restoring a page does not resurrect a descendant trashed on its own in the same millisecond', async () => {
    const parent = await createPage(owner, wid, { title: 'Parent même ms' });
    const child = await createPage(owner, wid, { parentType: 'page', parentId: parent.id, title: 'Enfant supprimé seul' });
    const dbPage = await createPage(owner, wid, { kind: 'database', title: 'Base même ms' });
    const rows = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    // Two deletions within the same millisecond (bulk delete, API scripts): the server runs in-process.
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      expectOk(await owner.post(`/pages/${child.id}/trash`));
      expectOk(await owner.post(`/pages/${parent.id}/trash`));
      expectOk(await owner.post(`/pages/${rows[0]!.id}/trash`));
      expectOk(await owner.post(`/pages/${dbPage.id}/trash`));
    } finally {
      Date.now = realNow;
    }
    expectOk(await owner.post(`/pages/${parent.id}/restore`));
    expectOk(await owner.post(`/pages/${dbPage.id}/restore`));
    const childNow = expectOk(await owner.get<PageDetailResponse>(`/pages/${child.id}`)).page;
    assert.ok(childNow.trashedAt !== null, 'the child deleted on its own stays in the trash');
    const live = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows.map((r) => r.id);
    assert.ok(!live.includes(rows[0]!.id), 'the row deleted on its own stays in the trash');
    const trash = expectOk(await owner.get<TrashResponse>(`/workspaces/${wid}/trash`)).items.map((i) => i.page.id);
    assert.ok(trash.includes(child.id) && trash.includes(rows[0]!.id));
    assert.deepEqual(treeViolations(srv), []);
  });

  test('QA-INT-04: pages and rows in the trash are read-only (PATCH refused like move/content)', async () => {
    const page = await createPage(owner, wid, { title: 'Corbeille lecture seule' });
    const dbPage = await createPage(owner, wid, { kind: 'database', title: 'Base corbeille' });
    const schema = expectOk(await owner.get<{ schema: { properties: Array<{ id: string; type: string }> } }>(`/databases/${dbPage.id}`)).schema;
    const text = schema.properties.find((p) => p.type === 'text' || p.type === 'multi_select')!;
    const row = expectOk(await owner.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows[0]!;
    expectOk(await owner.post(`/pages/${page.id}/trash`));
    expectOk(await owner.post(`/pages/${dbPage.id}/trash`));
    const before = rawAll<{ id: string; title: string; properties: string; version: number }>(
      srv,
      'SELECT id, title, properties, version FROM pages WHERE id IN (?, ?) ORDER BY id',
      page.id,
      row.id,
    );
    for (const [id, body] of [
      [page.id, { title: 'modifiée' }],
      [page.id, { format: { fullWidth: true } }],
      [row.id, { title: 'modifiée' }],
      [row.id, { properties: { [text.id]: text.type === 'text' ? 'x' : [] } }],
    ] as const) {
      assert.equal((await owner.patch(`/pages/${id}`, body)).status, 400, `${id} ${JSON.stringify(body)}`);
    }
    const after = rawAll<{ id: string; title: string; properties: string; version: number }>(
      srv,
      'SELECT id, title, properties, version FROM pages WHERE id IN (?, ?) ORDER BY id',
      page.id,
      row.id,
    );
    assert.deepEqual(after, before);
    // Once restored, writes work again.
    expectOk(await owner.post(`/pages/${page.id}/restore`));
    expectOk(await owner.patch(`/pages/${page.id}`, { title: 'restaurée' }));
  });

  test('QA-INT-04b: a snapshot cannot be restored into a page that is in the trash', async () => {
    const page = await createPage(owner, wid, { title: 'Historique en corbeille' });
    expectOk(await owner.put(`/pages/${page.id}/content`, { update: mentionDoc(page.id), mode: 'replace' }));
    const sid = newId();
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare("INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, '[]', 'auto')").run(sid, page.id, Y.encodeStateAsUpdate(new Y.Doc()), Date.now());
    } finally {
      raw.close();
    }
    expectOk(await owner.post(`/pages/${page.id}/trash`));
    assert.equal((await owner.post(`/pages/${page.id}/snapshots/${sid}/restore`)).status, 400);
    expectOk(await owner.post(`/pages/${page.id}/restore`));
    expectOk(await owner.post(`/pages/${page.id}/snapshots/${sid}/restore`));
  });

  test('duplicate: private copies stay private to their owner, trashed descendants are not copied', async () => {
    const priv = await createPage(member, wid, { title: 'Privée', visibility: 'private' });
    const sub = await createPage(member, wid, { parentType: 'page', parentId: priv.id, title: 'Sous-page' });
    const gone = await createPage(member, wid, { parentType: 'page', parentId: priv.id, title: 'Supprimée' });
    expectOk(await member.post(`/pages/${gone.id}/trash`));
    const copy = expectOk(await member.post<Page>(`/pages/${priv.id}/duplicate`));
    assert.equal(copy.visibility, 'private');
    for (const c of [owner, admin, member2]) assert.equal((await c.get(`/pages/${copy.id}`)).status, 404);
    const children = rawAll<{ title: string; visibility: string; owner_id: string; trashed_at: number | null }>(
      srv,
      'SELECT title, visibility, owner_id, trashed_at FROM pages WHERE parent_id = ?',
      copy.id,
    );
    assert.deepEqual(
      children.map((c) => c.title),
      ['Sous-page'],
    );
    assert.equal(children[0]!.visibility, 'private');
    assert.equal(children[0]!.owner_id, memberId);
    assert.equal((await owner.post(`/pages/${sub.id}/duplicate`)).status, 404);
  });

  test('instantiate (template copy) targets are checked', async () => {
    const tpl = await createPage(member, wid, { title: 'Modèle projet' });
    expectOk(await member.put(`/pages/${tpl.id}/template`, { isTemplate: true }));
    const priv = await createPage(member2, wid, { title: 'Privée de Maud', visibility: 'private' });
    const trashed = await createPage(owner, wid, { title: 'Corbeille' });
    expectOk(await owner.post(`/pages/${trashed.id}/trash`));
    const foreign = await createPage(outsider, otherWid, { title: 'Ailleurs' });
    const inst = (c: Client, body: Record<string, unknown>) => c.post(`/pages/${tpl.id}/instantiate`, body);
    assert.equal((await inst(member, { parentType: 'page', parentId: priv.id })).status, 404);
    assert.equal((await inst(member, { parentType: 'page', parentId: trashed.id })).status, 400);
    assert.equal((await inst(member, { parentType: 'page', parentId: foreign.id })).status, 404);
    assert.equal((await inst(member, { parentType: 'workspace', parentId: otherWid })).status, 400);
    assert.equal((await inst(viewer, { parentType: 'workspace', parentId: wid })).status, 403);
    assert.equal((await inst(outsider, { parentType: 'workspace', parentId: otherWid })).status, 404);
    const copy = expectOk(await inst(member2, { parentType: 'page', parentId: priv.id }));
    assert.equal(copy.visibility, 'private');
  });

  test('favorites and recents never list pages that became invisible', async () => {
    const p = await createPage(owner, wid, { title: 'Bientôt privée' });
    expectOk(await member2.put(`/pages/${p.id}/favorite`, { favorite: true }));
    expectOk(await member2.get(`/pages/${p.id}`));
    expectOk(await member.post(`/pages/${p.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    const favs = expectOk(await member2.get<{ favorites: Array<{ id: string }> }>(`/workspaces/${wid}/favorites`));
    assert.ok(!favs.favorites.some((f) => f.id === p.id));
    const recent = expectOk(await member2.get<{ pages: Array<{ id: string }> }>(`/workspaces/${wid}/recent`));
    assert.ok(!recent.pages.some((f) => f.id === p.id));
    const res = expectOk(await member2.put<{ favorites: string[] }>(`/pages/${(await createPage(owner, wid, { title: 'x' })).id}/favorite`, { favorite: true }));
    assert.ok(!res.favorites.includes(p.id));
  });

  test('tree invariants hold after a long mixed sequence of tree operations', async () => {
    const ok = <T = any>(p: Promise<Res<T>>) => p.then((r) => expectOk(r));
    const a = await createPage(owner, wid, { title: 'Seq A' });
    const b = await createPage(owner, wid, { parentType: 'page', parentId: a.id, title: 'Seq B' });
    const c = await createPage(owner, wid, { parentType: 'page', parentId: b.id, title: 'Seq C' });
    const d = await createPage(owner, wid, { parentType: 'page', parentId: c.id, kind: 'database', isInline: true, title: 'Seq DB' });
    const rows = (await ok<RowsResponse>(owner.get(`/databases/${d.id}/rows`))).rows;
    const sub = await createPage(owner, wid, { parentType: 'page', parentId: rows[0]!.id, title: 'Sous-page de ligne' });
    const tpl = await ok<Page>(owner.post(`/databases/${d.id}/templates`, { title: 'Modèle de ligne' }));
    await ok(owner.post(`/databases/${d.id}/rows`, { templateId: tpl.id }));
    await ok(owner.post(`/databases/${d.id}/import`, { rows: [{ title: 'Importée' }] }));
    const priv = await createPage(member, wid, { title: 'Seq privée', visibility: 'private' });
    // Trash pieces at different times, then their ancestors.
    await ok(owner.post(`/pages/${rows[1]!.id}/trash`));
    await ok(owner.post(`/pages/${c.id}/trash`));
    await ok(owner.post(`/pages/${a.id}/trash`));
    assert.deepEqual(treeViolations(srv), []);
    // Restore a deep descendant alone (its parent is trashed → root), then the rest.
    await ok(owner.post(`/pages/${sub.id}/restore`));
    await ok(owner.post(`/pages/${a.id}/restore`));
    assert.deepEqual(treeViolations(srv), []);
    await ok(owner.post(`/pages/${c.id}/restore`));
    await ok(owner.post(`/pages/${rows[1]!.id}/restore`));
    // Move the whole tree into a private page and back, duplicate it, delete pieces for good.
    await ok(member.post(`/pages/${a.id}/move`, { parentType: 'page', parentId: priv.id }));
    assert.deepEqual(treeViolations(srv), []);
    const copy = await ok<Page>(member.post(`/pages/${a.id}/duplicate`));
    await ok(member.post(`/pages/${a.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'workspace' }));
    await ok(owner.post(`/pages/${b.id}/move`, { parentType: 'page', parentId: sub.id }));
    await ok(owner.post(`/pages/${b.id}/trash`));
    await ok(owner.del(`/pages/${b.id}`));
    await ok(member.post(`/pages/${copy.id}/trash`));
    await ok(member.post(`/pages/${priv.id}/trash`));
    await ok(member.del(`/pages/${priv.id}`));
    assert.deepEqual(treeViolations(srv), []);

    // Private database with row templates, rows created from them, imported rows, then a template
    // page holding it instantiated into someone else's private page.
    const tplPage = await createPage(member, wid, { title: 'Modèle avec base' });
    const pdb = await createPage(member, wid, { parentType: 'page', parentId: tplPage.id, kind: 'database', title: 'Base du modèle' });
    const rowTpl = await ok<Page>(member.post(`/databases/${pdb.id}/templates`, { title: 'Ligne modèle' }));
    await ok(member.put(`/databases/${pdb.id}/templates/default`, { templateId: rowTpl.id }));
    await ok(member.post(`/databases/${pdb.id}/rows`, { templateId: rowTpl.id }));
    await ok(member.post(`/databases/${pdb.id}/import`, { rows: [{ title: 'Importée' }, { title: 'Autre' }] }));
    await ok(member.put(`/pages/${tplPage.id}/template`, { isTemplate: true }));
    const target = await createPage(member2, wid, { title: 'Privée cible', visibility: 'private' });
    const inst = await ok<Page>(member2.post(`/pages/${tplPage.id}/instantiate`, { parentType: 'page', parentId: target.id }));
    assert.equal(inst.visibility, 'private');
    await ok(member.post(`/pages/${tplPage.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    await ok(member.post(`/pages/${pdb.id}/duplicate`));
    assert.deepEqual(treeViolations(srv), []);
  });

  test('tree, trash and detail of a page never expose private ancestors', async () => {
    const priv = await createPage(member, wid, { title: 'Ancêtre privé', visibility: 'private' });
    const sub = await createPage(member, wid, { parentType: 'page', parentId: priv.id, title: 'Sous-page' });
    const tree = expectOk(await owner.get<TreeResponse>(`/workspaces/${wid}/tree`));
    assert.ok(!tree.nodes.some((n) => n.id === priv.id || n.id === sub.id));
    const detail = expectOk(await member.get<PageDetailResponse>(`/pages/${sub.id}`));
    assert.deepEqual(
      detail.ancestors.map((a) => a.id),
      [priv.id],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Content references across workspaces, members and invites
// ---------------------------------------------------------------------------------------------

/** BlockNote-shaped document with one paragraph holding a page mention. */
function mentionDoc(pageId: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'b1');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'voir ');
    const mention = new Y.XmlElement('pageMention');
    mention.setAttribute('pageId', pageId);
    paragraph.insert(0, [text, mention]);
    container.insert(0, [paragraph]);
    group.insert(0, [container]);
  });
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

describe('qa integrity: references, members and invites', () => {
  let srv: TestServer;
  let owner: Client;
  let wid: string;
  let outsider: Client;
  let otherWid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin: owner, wid } = await setupAdmin(srv.base));
    expectOk(await owner.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    const s = expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'qa-ref-out@oriel.test', name: 'Olga', password: 'motdepasse-solide' }));
    otherWid = s.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  test('a mention of a foreign page (also through a duplicate) never surfaces in its backlinks', async () => {
    const foreign = await createPage(outsider, otherWid, { title: 'Cible étrangère' });
    const page = await createPage(owner, wid, { title: 'Titre confidentiel W1' });
    expectOk(await owner.put(`/pages/${page.id}/content`, { update: mentionDoc(foreign.id), mode: 'replace' }));
    await waitFor(() => rawAll(srv, 'SELECT 1 FROM page_links WHERE source_id = ?', page.id).length > 0, 5000, 'links stored');
    const copy = expectOk(await owner.post<Page>(`/pages/${page.id}/duplicate`));
    assert.ok(rawAll(srv, 'SELECT 1 FROM page_links WHERE source_id = ? AND target_id = ?', copy.id, foreign.id).length > 0);
    const back = expectOk(await outsider.get<{ pages: Array<{ id: string }> }>(`/pages/${foreign.id}/backlinks`));
    assert.deepEqual(back.pages, []);
    // The copy's content keeps the foreign id but gives no access to it.
    assert.equal((await owner.get(`/pages/${foreign.id}`)).status, 404);
  });

  test('roles: changes apply immediately, invites never change an existing role, owners can leave only if another stays', async () => {
    const { client: m, user: mu } = await addMember(owner, wid, 'qa-role-m@oriel.test', 'Mia', 'member');
    const { client: a, user: au } = await addMember(owner, wid, 'qa-role-a@oriel.test', 'Alma', 'admin');
    const page = await createPage(owner, wid, { title: 'Rôles' });
    expectOk(await m.patch(`/pages/${page.id}`, { title: 'ok' }));
    expectOk(await owner.patch(`/workspaces/${wid}/members/${mu.id}`, { role: 'viewer' }));
    assert.equal((await m.patch(`/pages/${page.id}`, { title: 'non' })).status, 403);
    // Accepting a viewer invite does not downgrade an admin.
    const inv = expectOk(await owner.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'viewer' }));
    expectOk(await a.post(`/invites/${inv.token}/accept`));
    const members = expectOk(await owner.get<Array<{ user: { id: string }; role: string }>>(`/workspaces/${wid}/members`));
    assert.equal(members.find((x) => x.user.id === au.id)?.role, 'admin');
    // A second owner may leave; the last one may not.
    expectOk(await owner.patch(`/workspaces/${wid}/members/${au.id}`, { role: 'owner' }));
    expectOk(await a.del(`/workspaces/${wid}/members/${au.id}`));
    assert.equal((await a.get(`/workspaces/${wid}`)).status, 404);
  });

  test('invites: expired, revoked, and those of a demoted admin stop working', async () => {
    const { client: a, user: au } = await addMember(owner, wid, 'qa-inv-a@oriel.test', 'Anna', 'admin');
    const fromAdmin = expectOk(await a.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'member' }));
    const expired = expectOk(await owner.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'member' }));
    const revoked = expectOk(await owner.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'member' }));
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(Date.now() - 1, expired.token);
    } finally {
      raw.close();
    }
    expectOk(await owner.del(`/workspaces/${wid}/invites/${revoked.token}`));
    expectOk(await owner.patch(`/workspaces/${wid}/members/${au.id}`, { role: 'member' }));
    const joiner = new Client(srv.base);
    expectOk(await joiner.post('/auth/signup', { email: 'qa-joiner@oriel.test', name: 'Jo', password: 'motdepasse-solide' }));
    for (const t of [fromAdmin.token, expired.token, revoked.token]) {
      assert.equal((await joiner.post(`/invites/${t}/accept`)).status, 404, t);
      assert.equal(expectOk(await joiner.get<{ valid: boolean }>(`/invites/${t}`)).valid, false);
    }
    assert.equal((await joiner.get(`/workspaces/${wid}`)).status, 404);
  });

  test('workspace deletion leaves no rows bound to its pages', async () => {
    const ws = expectOk(await owner.post<{ id: string }>('/workspaces', { name: 'Éphémère' }));
    const p = await createPage(owner, ws.id, { title: 'Page éphémère' });
    await createPage(owner, ws.id, { parentType: 'page', parentId: p.id, kind: 'database', title: 'Base éphémère' });
    expectOk(await owner.put(`/pages/${p.id}/favorite`, { favorite: true }));
    expectOk(await owner.get(`/pages/${p.id}`));
    expectOk(await owner.post(`/workspaces/${ws.id}/invites`, { role: 'member' }));
    expectOk(await owner.del(`/workspaces/${ws.id}`));
    const count = (sql: string, ...params: string[]) => rawAll<{ n: number }>(srv, sql, ...params)[0]!.n;
    assert.equal(count('SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ?', ws.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM search WHERE workspace_id = ?', ws.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM favorites WHERE workspace_id = ?', ws.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM visits WHERE workspace_id = ?', ws.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM invites WHERE workspace_id = ?', ws.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM databases WHERE page_id NOT IN (SELECT id FROM pages)'), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM views WHERE database_id NOT IN (SELECT page_id FROM databases)'), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Migrations and maintenance job
// ---------------------------------------------------------------------------------------------

describe('qa integrity: migrations and jobs', () => {
  const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'oriel-qa-int-'));

  test('migrations are idempotent across restarts and upgrade an old (V1-only) database', async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'oriel.db');
      // An install that only ran the first core migration and no feature migration.
      const old = new DatabaseSync(file);
      old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      old.exec(MIGRATIONS[0]!);
      old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
      old.close();
      for (let i = 0; i < 2; i++) {
        const db = openDatabase(file);
        try {
          assert.equal(db.getMeta('schema_version'), String(MIGRATIONS.length));
          assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM applied_migrations')!.n, FEATURE_MIGRATIONS.length);
          assert.ok(db.get("SELECT 1 AS x FROM pragma_table_info('pages') WHERE name = 'is_template'"));
        } finally {
          db.close();
        }
      }
      // A full server boots twice on the same data directory.
      for (let i = 0; i < 2; i++) {
        const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, logLevel: 'silent', jobs: false });
        await s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('purge: only pages trashed for more than 30 days go, live descendants restored elsewhere survive', () => {
    const dir = tmp();
    const config = resolveConfig({ dataDir: dir });
    const db = openDatabase(config.dbFile);
    const ctx: AppContext = { db, config, bus: new EventBus(db, 10, () => true), collab: noopCollab, authLimiter: new RateLimiter(10, 60_000) };
    try {
      const DAY = 24 * 60 * 60 * 1000;
      const uid = newId();
      const now = Date.now();
      db.run("INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, 'p@x.test', 'P', 'x', ?, ?)", uid, now, now);
      const ws = createWorkspace(ctx, uid, 'W', null);
      const mk = (title: string, parentId?: string, kind: 'page' | 'database' = 'page') =>
        createPageSvc(ctx, uid, ws.id, { parentType: parentId ? 'page' : 'workspace', parentId: parentId ?? ws.id, title, kind });
      const ageTrash = (id: string, days: number) => db.run('UPDATE pages SET trashed_at = ? WHERE trashed_at = (SELECT trashed_at FROM pages WHERE id = ?)', now - days * DAY, id);
      // old root with a child restored (to the root) before the purge
      const old = mk('Ancienne');
      const rescued = mk('Sauvée', old.id);
      const oldDb = mk('Base ancienne', old.id, 'database');
      trashPage(ctx, uid, old.id);
      ageTrash(old.id, 31);
      restorePage(ctx, uid, rescued.id);
      // recent root containing an older, separately trashed child
      const recent = mk('Récente');
      const olderChild = mk('Enfant plus ancien', recent.id);
      const keptChild = mk('Enfant récent', recent.id);
      trashPage(ctx, uid, olderChild.id);
      ageTrash(olderChild.id, 40);
      trashPage(ctx, uid, recent.id);
      ageTrash(recent.id, 29);
      const live = mk('Vivante');
      const aliveBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE trashed_at IS NULL')!.n;

      runMaintenance(ctx, now);
      const exists = (id: string) => !!db.get('SELECT 1 AS x FROM pages WHERE id = ?', id);
      assert.equal(exists(old.id), false);
      assert.equal(exists(oldDb.id), false);
      assert.equal(db.get('SELECT 1 AS x FROM databases WHERE page_id = ?', oldDb.id), undefined);
      assert.equal(exists(rescued.id), true, 'restored child survives the purge of its former parent');
      assert.equal(exists(olderChild.id), false, 'trashed on its own more than 30 days ago');
      assert.equal(exists(recent.id), true);
      assert.equal(exists(keptChild.id), true);
      assert.equal(exists(live.id), true);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE trashed_at IS NULL')!.n, aliveBefore, 'no live page purged');
    } finally {
      ctx.bus.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('QA-INT-02: two processes migrating the same database at once do not crash the second one', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'oriel.db');
      const a = new Db(file);
      const b = new Db(file);
      try {
        // Interleaving of two processes started together: B migrates everything between A's read of
        // schema_version and A's first BEGIN IMMEDIATE (B holds the write lock, A waits on it).
        const realTx = a.tx.bind(a);
        let interleaved = false;
        a.tx = <T>(fn: () => T): T => {
          if (!interleaved) {
            interleaved = true;
            b.migrate();
          }
          return realTx(fn);
        };
        assert.doesNotThrow(() => a.migrate());
        assert.equal(a.getMeta('schema_version'), String(MIGRATIONS.length));
        assert.equal(a.get<{ n: number }>('SELECT COUNT(*) AS n FROM applied_migrations')!.n, FEATURE_MIGRATIONS.length);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('qa integrity: very deep trees', () => {
  let srv: TestServer;
  let owner: Client;
  let wid: string;
  let ownerId: string;

  before(async () => {
    srv = await startTestServer();
    let session: SessionResponse;
    ({ admin: owner, wid, session } = await setupAdmin(srv.base));
    ownerId = session.user.id;
  });
  after(async () => {
    await srv.stop();
  });

  test('QA-INT-03: the move cycle check is not bounded by the ancestor walk depth', async () => {
    // A chain deeper than the 10 000 levels walked by pageChain (each level reachable through the
    // API: one sub-page per request; inserted directly here to keep the test fast).
    const DEPTH = 10_005;
    const ids = Array.from({ length: DEPTH }, () => newId());
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      const now = Date.now();
      const insert = raw.prepare(
        `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, position, visibility, owner_id, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'page', ?, 'a0', 'workspace', ?, ?, ?, ?, ?)`,
      );
      raw.exec('BEGIN');
      ids.forEach((id, i) =>
        insert.run(id, wid, i === 0 ? 'workspace' : 'page', i === 0 ? wid : ids[i - 1]!, `Niveau ${i}`, ownerId, now, ownerId, now, ownerId),
      );
      raw.exec('COMMIT');
    } finally {
      raw.close();
    }
    const res = await owner.post(`/pages/${ids[0]}/move`, { parentType: 'page', parentId: ids[DEPTH - 1] });
    assert.equal(res.status, 400, 'moving the top of the chain under its deepest descendant must be refused');
    assert.deepEqual(
      treeViolations(srv).filter((v) => v.includes('cycle')),
      [],
    );
  });
});
