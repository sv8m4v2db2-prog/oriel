// H5 — block metadata: who created / last modified each block, fed by /collab, stored outside Yjs,
// bounded, readable by readers of the page only. Also the CSP of the SPA (WebAssembly for the Typst
// preview worker, and nothing else).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { BLOCK_META_MAX_PER_PAGE, BLOCK_META_MAX_PER_WINDOW, type BlockMeta } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { BlockTouches, documentBlockIds, flushBlockMeta } from '../src/services/blockMeta.js';
import type { AppContext } from '../src/context.js';

async function connect(wsBase: string, pageId: string, cookie: string | null) {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: cookie ? { cookie: `oriel_session=${cookie}` } : {} });
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `page:${pageId}`, document: doc });
  provider.attach();
  await waitFor(() => provider.isSynced, 5000, 'collab sync');
  return {
    doc,
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
}

function group(doc: Y.Doc): Y.XmlElement {
  const fragment = doc.getXmlFragment('blocknote');
  let g = fragment.get(0) as Y.XmlElement | undefined;
  if (!g) {
    g = new Y.XmlElement('blockGroup');
    fragment.insert(0, [g]);
  }
  return g;
}

function addBlock(doc: Y.Doc, id: string, value: string): Y.XmlText {
  let t!: Y.XmlText;
  doc.transact(() => {
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', id);
    const paragraph = new Y.XmlElement('paragraph');
    t = new Y.XmlText();
    t.insert(0, value);
    paragraph.insert(0, [t]);
    container.insert(0, [paragraph]);
    const g = group(doc);
    g.insert(g.length, [container]);
  });
  return t;
}

function removeBlock(doc: Y.Doc, id: string) {
  doc.transact(() => {
    const g = group(doc);
    const index = g.toArray().findIndex((c) => c instanceof Y.XmlElement && c.getAttribute('id') === id);
    if (index >= 0) g.delete(index, 1);
  });
}

describe('block metadata', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let adminId: string;
  let member: Client;
  let memberId: string;
  let outsider: Client;
  let wid: string;
  let pageId: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    adminId = expectOk(await admin.get<{ user: { id: string } }>('/auth/me')).user.id;
    const added = await addMember(admin, wid, 'membre@oriel.test', 'Marc', 'member');
    member = added.client;
    memberId = added.user.id;
    // Member of another workspace only: the first workspace's pages do not exist for them.
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre espace' }));
    outsider = (await addMember(admin, other.id, 'dehors@oriel.test', 'Dora', 'member')).client;
    ctx = [...collabContexts.values()].find((c) => c.config.dataDir === srv.dataDir)!;
    pageId = (await createPage(admin, wid, { title: 'Scénario' })).id;
  });
  after(async () => {
    await srv.stop();
  });

  const meta = async (c: Client, id: string, page = pageId) => c.get<BlockMeta>(`/pages/${page}/blocks/${id}/meta`);
  const rows = () => ctx.db.all<{ block_id: string; created_by: string | null; modified_by: string | null }>('SELECT * FROM editor_block_meta WHERE page_id = ?', pageId);

  test('creation and modification are attributed to the connected author', async () => {
    const a = await connect(srv.wsBase, pageId, admin.cookie);
    addBlock(a.doc, 'blk-1', 'Plan 1');
    await waitFor(() => rows().some((r) => r.block_id === 'blk-1'), 5000, 'block row');
    const first = expectOk(await meta(admin, 'blk-1'));
    assert.equal(first.createdBy?.id, adminId);
    assert.equal(first.modifiedBy?.id, adminId);
    assert.equal(first.createdBy?.name.length > 0, true);
    assert.ok(first.createdAt! > 0 && first.modifiedAt! >= first.createdAt!);

    // Another member edits the text: modification changes, creation stays.
    const b = await connect(srv.wsBase, pageId, member.cookie);
    await waitFor(() => b.doc.getXmlFragment('blocknote').length > 0, 5000, 'second client sync');
    const g = b.doc.getXmlFragment('blocknote').get(0) as Y.XmlElement;
    const container = g.get(0) as Y.XmlElement;
    const text = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    await sleep(30);
    text.insert(text.length, ' (modifié)');
    await waitFor(async () => (await meta(admin, 'blk-1')).body.modifiedBy?.id === memberId, 5000, 'modified by member');
    const second = expectOk(await meta(admin, 'blk-1'));
    assert.equal(second.createdBy?.id, adminId);
    assert.equal(second.modifiedBy?.id, memberId);
    assert.ok(second.modifiedAt! >= first.modifiedAt!);
    a.close();
    b.close();
  });

  test('metadata never enters the Yjs document', async () => {
    const stored = ctx.db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', pageId)!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored.state);
    const json = JSON.stringify(doc.getXmlFragment('blocknote').toJSON());
    assert.ok(!json.includes(adminId));
    assert.ok(!json.includes(memberId));
  });

  test('deleted blocks lose their row', async () => {
    const a = await connect(srv.wsBase, pageId, admin.cookie);
    addBlock(a.doc, 'blk-2', 'Éphémère');
    await waitFor(() => rows().some((r) => r.block_id === 'blk-2'), 5000, 'second block');
    removeBlock(a.doc, 'blk-2');
    await waitFor(() => !rows().some((r) => r.block_id === 'blk-2'), 5000, 'row pruned');
    assert.ok(rows().some((r) => r.block_id === 'blk-1'));
    a.close();
  });

  test('an unknown block answers with empty fields, a bad id is refused', async () => {
    const unknown = expectOk(await meta(admin, 'blk-inconnu'));
    assert.deepEqual([unknown.createdBy, unknown.createdAt, unknown.modifiedBy, unknown.modifiedAt], [null, null, null, null]);
    assert.equal((await meta(admin, 'a b')).status, 400);
    // Longer than the router's parameter limit: never matched, never answered with data.
    assert.ok([400, 404].includes((await meta(admin, 'x'.repeat(200))).status));
    assert.equal((await meta(admin, 'x'.repeat(129))).status === 200, false);
  });

  test('access: readers only, no identity for anonymous visitors or outsiders', async () => {
    assert.equal((await meta(member, 'blk-1')).status, 200);
    // Not a member of the workspace: the page does not exist for them.
    assert.equal((await meta(outsider, 'blk-1')).status, 404);
    // No session at all (what a public visitor has).
    const anon = new Client(srv.base);
    assert.equal((await meta(anon, 'blk-1')).status, 401);
    // Publishing the page does not open the route.
    expectOk(await admin.post(`/pages/${pageId}/publish`, { isPublic: true }));
    assert.equal((await meta(anon, 'blk-1')).status, 401);
    // A page the caller cannot see answers like a missing page.
    assert.equal((await meta(admin, 'blk-1', '00000000-0000-4000-8000-000000000000')).status, 404);
  });

  test('a private page is invisible to other members', async () => {
    const priv = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    const a = await connect(srv.wsBase, priv.id, admin.cookie);
    addBlock(a.doc, 'blk-p', 'secret');
    await waitFor(() => ctx.db.get('SELECT 1 AS x FROM editor_block_meta WHERE page_id = ?', priv.id), 5000, 'private row');
    assert.equal((await meta(admin, 'blk-p', priv.id)).status, 200);
    assert.equal((await meta(member, 'blk-p', priv.id)).status, 404);
    a.close();
  });

  test('anonymous or server-side changes are attributed to nobody', async () => {
    const touches = new BlockTouches();
    const doc = new Y.Doc();
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      // The collaboration layer calls record() only for an authenticated user: nothing here.
      void tr;
    });
    addBlock(doc, 'blk-srv', 'serveur');
    assert.ok(touches.isEmpty);
    flushBlockMeta(ctx.db, pageId, doc, touches);
    assert.ok(!rows().some((r) => r.block_id === 'blk-srv'));
  });
});

describe('block metadata bounds', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let pageId: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    ctx = [...collabContexts.values()].find((c) => c.config.dataDir === srv.dataDir)!;
    pageId = (await createPage(s.admin, s.wid, { title: 'Gros' })).id;
  });
  after(async () => {
    await srv.stop();
  });

  const count = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM editor_block_meta WHERE page_id = ?', pageId)!.n;

  test('a window follows at most BLOCK_META_MAX_PER_WINDOW blocks', () => {
    const doc = new Y.Doc();
    const touches = new BlockTouches();
    doc.on('afterTransaction', (tr: Y.Transaction) => touches.record(tr, 'u1'));
    doc.transact(() => {
      const g = group(doc);
      const containers: Y.XmlElement[] = [];
      for (let i = 0; i < BLOCK_META_MAX_PER_WINDOW + 500; i++) {
        const c = new Y.XmlElement('blockContainer');
        c.setAttribute('id', `b${i}`);
        c.insert(0, [new Y.XmlElement('paragraph')]);
        containers.push(c);
      }
      g.insert(0, containers);
    });
    assert.equal(touches.touched.size, BLOCK_META_MAX_PER_WINDOW);
    assert.ok(touches.structural);
  });

  test('forged ids are ignored and rows are capped per page', () => {
    const doc = new Y.Doc();
    const touches = new BlockTouches();
    doc.on('afterTransaction', (tr: Y.Transaction) => touches.record(tr, 'u1'));
    doc.transact(() => {
      const g = group(doc);
      for (const id of ['ok-1', 'a b', '', 'x'.repeat(300), '<script>']) {
        const c = new Y.XmlElement('blockContainer');
        c.setAttribute('id', id);
        g.insert(g.length, [c]);
      }
    });
    assert.deepEqual([...touches.touched.keys()], ['ok-1']);
    // Fill the page up to the cap, then more touches create nothing.
    ctx.db.tx(() => {
      for (let i = 0; i < BLOCK_META_MAX_PER_PAGE; i++) {
        ctx.db.run('INSERT INTO editor_block_meta (page_id, block_id, modified_by, modified_at) VALUES (?, ?, ?, ?)', pageId, `f${i}`, 'u0', 1);
      }
    });
    assert.equal(count(), BLOCK_META_MAX_PER_PAGE);
    // The stored rows are not in `doc`: pruning is skipped only when the document is too large; here it runs
    // after the inserts below, so use a document holding all the ids to keep them.
    const keep = new Y.Doc();
    keep.transact(() => {
      const g = group(keep);
      for (let i = 0; i < 10; i++) {
        const c = new Y.XmlElement('blockContainer');
        c.setAttribute('id', `f${i}`);
        g.insert(g.length, [c]);
      }
    });
    const touches2 = new BlockTouches();
    keep.on('afterTransaction', (tr: Y.Transaction) => touches2.record(tr, 'u1'));
    keep.transact(() => {
      const c = new Y.XmlElement('blockContainer');
      c.setAttribute('id', 'one-too-many');
      group(keep).insert(0, [c]);
    });
    touches2.structural = false; // no pruning in this assertion
    flushBlockMeta(ctx.db, pageId, keep, touches2);
    assert.equal(count(), BLOCK_META_MAX_PER_PAGE);
    assert.ok(!ctx.db.get("SELECT 1 AS x FROM editor_block_meta WHERE page_id = ? AND block_id = 'one-too-many'", pageId));
  });

  test('a huge group is not scanned for every transaction (bounded cost)', () => {
    const doc = new Y.Doc();
    const g = group(doc);
    doc.transact(() => {
      const many: Y.XmlElement[] = [];
      for (let i = 0; i < 5_001; i++) {
        const c = new Y.XmlElement('blockContainer');
        c.setAttribute('id', `m${i}`);
        many.push(c);
      }
      g.insert(0, many);
    });
    const touches = new BlockTouches();
    doc.on('afterTransaction', (tr: Y.Transaction) => touches.record(tr, 'u1'));
    doc.transact(() => {
      const c = new Y.XmlElement('blockContainer');
      c.setAttribute('id', 'late');
      g.insert(g.length, [c]);
    });
    assert.ok(touches.structural, 'rows are still pruned');
    assert.equal(touches.touched.size, 0, 'but the new block of a group this large is not attributed');
  });

  test('documentBlockIds walks nested blocks', () => {
    const doc = new Y.Doc();
    const g = group(doc);
    const outer = new Y.XmlElement('blockContainer');
    outer.setAttribute('id', 'outer');
    const inner = new Y.XmlElement('blockGroup');
    const child = new Y.XmlElement('blockContainer');
    child.setAttribute('id', 'child');
    inner.insert(0, [child]);
    outer.insert(0, [new Y.XmlElement('paragraph'), inner]);
    g.insert(0, [outer]);
    assert.deepEqual([...documentBlockIds(doc)!].sort(), ['child', 'outer']);
  });
});

describe('CSP of the application', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.stop();
  });

  test('WebAssembly compilation is allowed, JavaScript eval and inline scripts are not', async () => {
    const res = await fetch(`${srv.base}/une/route`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const script = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
    assert.match(script, /'self'/);
    assert.match(script, /'wasm-unsafe-eval'/);
    assert.ok(!/'unsafe-eval'|'unsafe-inline'/.test(script));
    assert.ok(!/default-src[^;]*\*/.test(csp));
  });
});
