// QA wave G, review D: version history (G6) and page reading (G4). Each test is named after its
// finding (QA-G6-xx / QA-G4-xx); see the final report of the review for the scenarios.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { newId, type DeletedBlocksResponse, type PageActivityResponse, type RestoreBlocksResponse } from '@oriel/shared';
import type { AppContext } from '../src/context.js';
import { collabContexts } from '../src/routes/collab.js';
import { MAX_CONTENT_DEPTH } from '../src/content/ydoc.js';
import { reconcileDocument, reinsertBlock, revertBlock } from '../src/content/restore.js';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function block(id: string, text: string, children: Y.XmlElement[] = []): Y.XmlElement {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', id);
  const paragraph = new Y.XmlElement('paragraph');
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  container.insert(0, [paragraph]);
  if (children.length > 0) {
    const g = new Y.XmlElement('blockGroup');
    g.insert(0, children);
    container.insert(1, [g]);
  }
  return container;
}

/** A chain of nested blocks `levels` deep (each level adds a container and a group: 2 depths). */
function chain(prefix: string, levels: number, leaf: Y.XmlElement | null = null): Y.XmlElement {
  let node: Y.XmlElement | null = leaf;
  for (let i = levels - 1; i >= 0; i--) node = block(`${prefix}${i}`, `${prefix}${i}`, node ? [node] : []);
  return node!;
}

function docWith(blocks: Y.XmlElement[]): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement('blockGroup');
  doc.getXmlFragment('blocknote').insert(0, [g]);
  g.insert(0, blocks);
  return doc;
}

/** Deepest XML element (fragment = 0, root group = 1), iterative. */
function maxDepth(doc: Y.Doc): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[doc.getXmlFragment('blocknote'), 0]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (n instanceof Y.XmlElement && d > max) max = d;
    if (n instanceof Y.XmlElement || n instanceof Y.XmlFragment) for (const c of n.toArray()) stack.push([c, d + 1]);
  }
  return max;
}

describe('QA-G6 restore copies stay within the content bounds (pure)', () => {
  // Levels so that the anchor sits near MAX_CONTENT_DEPTH in the live document (2 depths per level).
  const deepLevels = Math.floor((MAX_CONTENT_DEPTH - 4) / 2);

  test('QA-G6-01: reinsert after a block nested deep since the version does not exceed MAX_CONTENT_DEPTH', () => {
    // Version: A and X side by side at the root, X holding a deep subtree (each within the bound).
    const source = docWith([block('A', 'Ancre'), chain('x', deepLevels)]);
    assert.ok(maxDepth(source) <= MAX_CONTENT_DEPTH);
    // Live document: A moved to the bottom of a deep chain (allowed by the collab guard); X deleted.
    const target = docWith([chain('t', deepLevels, block('A', 'Ancre'))]);
    assert.ok(maxDepth(target) <= MAX_CONTENT_DEPTH);
    target.transact(() => assert.equal(reinsertBlock(target, source, 'x0'), 'ok'));
    assert.ok(maxDepth(target) <= MAX_CONTENT_DEPTH, `depth ${maxDepth(target)} > ${MAX_CONTENT_DEPTH}`);
  });

  test('QA-G6-01: revert of a block nested deep since the version does not exceed MAX_CONTENT_DEPTH', () => {
    // Version: block R at the root whose content element (a forged one) holds a deep subtree.
    const forged = new Y.XmlElement('blockContainer');
    forged.setAttribute('id', 'R');
    const content = new Y.XmlElement('callout');
    content.insert(0, [chain('r', deepLevels)]);
    forged.insert(0, [content]);
    const source = docWith([forged]);
    assert.ok(maxDepth(source) <= MAX_CONTENT_DEPTH);
    const target = docWith([chain('t', deepLevels, block('R', 'Ancien'))]);
    target.transact(() => assert.equal(revertBlock(target, source, 'R'), 'ok'));
    assert.ok(maxDepth(target) <= MAX_CONTENT_DEPTH, `depth ${maxDepth(target)} > ${MAX_CONTENT_DEPTH}`);
  });

  test('QA-G6-01: whole restore keeps the bound (regression)', () => {
    const source = docWith([chain('x', deepLevels)]);
    const target = docWith([block('B', 'Autre')]);
    target.transact(() => reconcileDocument(target, source));
    assert.ok(maxDepth(target) <= MAX_CONTENT_DEPTH);
  });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

describe('QA-G6 / QA-G4 server', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let outsider: Client;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    ({ admin, wid } = await setupAdmin(srv.base));
    member = (await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member')).client;
    viewer = (await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer')).client;
    const otherWid = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre espace' })).id;
    outsider = (await addMember(admin, otherWid, 'dehors@oriel.test', 'Dehors', 'member')).client;
  });
  after(async () => {
    await srv.stop();
  });

  /** A big flat document (n paragraphs b0…), as stored state. */
  function bigState(n: number): Uint8Array {
    const blocks: Y.XmlElement[] = [];
    for (let i = 0; i < n; i++) blocks.push(block(`b${i}`, `Paragraphe numéro ${i}`));
    const doc = docWith(blocks);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return state;
  }

  function storeContent(pageId: string, state: Uint8Array) {
    ctx.db.run(
      `INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, '', ?, '[]')
       ON CONFLICT(page_id) DO UPDATE SET state = excluded.state`,
      pageId,
      state,
      Date.now(),
    );
  }

  function addSnapshot(pageId: string, state: Uint8Array, at = Date.now() - 60_000, authors: string[] = []): string {
    const sid = newId();
    ctx.db.run(
      "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, ?, 'auto')",
      sid,
      pageId,
      state,
      at,
      JSON.stringify(authors),
    );
    return sid;
  }

  test('QA-G6-02: 200 chosen blocks on a large page are restored without rescanning the page per block', async () => {
    const page = await createPage(admin, wid, { title: 'Grande page' });
    const state = bigState(20_000);
    storeContent(page.id, state);
    const sid = addSnapshot(page.id, state);
    const items = Array.from({ length: 200 }, (_, i) => ({ blockId: `b${i * 100}`, action: 'revert' as const }));
    const t0 = performance.now();
    const res = expectOk(await member.post<RestoreBlocksResponse>(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, { items }));
    const ms = performance.now() - t0;
    assert.equal(res.restored.length, 200);
    // Before the fix: two full scans of both documents per item (~2.5 s here, ~6 s at 50 000 blocks),
    // during which the event loop of the whole instance is blocked.
    assert.ok(ms < 1000, `restore-blocks took ${Math.round(ms)} ms`);
  });

  test('QA-G6-03: the recovery list decodes a bounded amount of version data per request', async () => {
    const page = await createPage(admin, wid, { title: 'Page aux nombreuses versions' });
    const state = bigState(20_000); // ~2 MB per version
    // Current content: the same blocks but the last 10, so that the scan is not cut short by the
    // 200-block limit (an attacker keeps a few deleted blocks only).
    storeContent(page.id, bigState(19_990));
    for (let i = 0; i < 20; i++) addSnapshot(page.id, state, Date.now() - 60_000 - i * 1000);
    const res = expectOk(await member.get<DeletedBlocksResponse>(`/pages/${page.id}/history/deleted`));
    // 20 versions × 2 MB were decoded in full before the fix (~2 s; 60 × 10 MB in the worst case).
    assert.ok(res.scanned * state.byteLength <= 16 * 1024 * 1024 + state.byteLength, `scanned ${res.scanned} versions of ${state.byteLength} bytes`);
    assert.ok(res.scanned >= 1);
    assert.equal(res.blocks.length, 10, 'the versions scanned still list their deleted blocks');
  });

  test('QA-G6-04: page activity does not list versions to readers excluded from the history', async () => {
    const page = await createPage(admin, wid, { title: 'Activité' });
    const adminId = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'admin@oriel.test'")!.id;
    addSnapshot(page.id, bigState(1), Date.now() - 5000, [adminId]);
    assert.equal((await viewer.get(`/pages/${page.id}/snapshots`)).status, 403, 'history is members-only');
    const asViewer = expectOk(await viewer.get<PageActivityResponse>(`/pages/${page.id}/activity`));
    assert.equal(asViewer.events.some((e) => e.kind === 'version'), false, 'versions hidden from a reader');
    assert.ok(asViewer.events.some((e) => e.kind === 'created'));
    const asMember = expectOk(await member.get<PageActivityResponse>(`/pages/${page.id}/activity`));
    assert.ok(asMember.events.some((e) => e.kind === 'version'), 'members still see versions');
  });

  test('QA-G4-01 (écartée): preview and activity of an invisible page answer the plain 404 of a missing page', async () => {
    const missing = `/pages/${newId()}`;
    const root = await createPage(admin, wid, { title: 'Équipe fermée' });
    expectOk(await admin.post(`/pages/${root.id}/teamspace`, { access: 'closed', confirmAccess: true }));
    const inTeam = await createPage(admin, wid, { title: 'Dans l’équipe', parentType: 'page', parentId: root.id });
    const priv = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    const trashedPriv = await createPage(admin, wid, { title: 'Privée jetée', visibility: 'private' });
    expectOk(await admin.post(`/pages/${trashedPriv.id}/trash`));
    for (const route of ['preview', 'activity']) {
      const ref = await member.get(`${missing}/${route}`);
      assert.equal(ref.status, 404);
      for (const p of [inTeam, priv, trashedPriv]) {
        const r = await member.get(`/pages/${p.id}/${route}`);
        assert.equal(r.status, 404, `${route} ${p.title}`);
        assert.deepEqual(r.body, ref.body, `${route} ${p.title}: same body as a missing page`);
      }
      const other = await outsider.get(`/pages/${inTeam.id}/${route}`);
      assert.equal(other.status, 404, `${route} from another workspace`);
      assert.equal((await admin.get(`/pages/${inTeam.id}/${route}`)).status, 200);
    }
    // History routes follow the same rule.
    for (const p of [inTeam, priv]) assert.equal((await member.get(`/pages/${p.id}/snapshots`)).status, 404);
  });

  test('QA-G6-05 (écartée): a version id of another page or workspace is never reachable', async () => {
    const mine = await createPage(admin, wid, { title: 'Ma page' });
    const foreignWid = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Tiers' })).id;
    const foreign = await createPage(admin, foreignWid, { title: 'Page étrangère' });
    const sid = addSnapshot(foreign.id, bigState(3));
    const body = { items: [{ blockId: 'b1', action: 'reinsert' }] };
    assert.equal((await admin.get(`/pages/${mine.id}/snapshots/${sid}`)).status, 404);
    assert.equal((await admin.post(`/pages/${mine.id}/snapshots/${sid}/restore`)).status, 404);
    assert.equal((await admin.post(`/pages/${mine.id}/snapshots/${sid}/restore-blocks`, body)).status, 404);
    // Read-scoped token: no restore.
    const token = expectOk(await admin.post<{ token: string }>('/me/tokens', { name: 'lecture', scope: 'read' })).token;
    const bearer = (method: string, url: string, payload?: unknown) =>
      fetch(`${srv.base}/api${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      }).then((r) => r.status);
    const own = addSnapshot(mine.id, bigState(3));
    assert.equal(await bearer('GET', `/pages/${mine.id}/snapshots/${own}`), 200);
    assert.equal(await bearer('POST', `/pages/${mine.id}/snapshots/${own}/restore`), 403);
    assert.equal(await bearer('POST', `/pages/${mine.id}/snapshots/${own}/restore-blocks`, body), 403);
  });
});
