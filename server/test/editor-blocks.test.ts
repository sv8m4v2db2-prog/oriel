// Advanced editor blocks (editor module): the HTML block frame (static bootstrap route and its
// sandbox CSP) and synced blocks (owner page, workspace, `synced:<id>` documents on /collab,
// revocations, ingest guard, references, AI reader, export). Constraints of the security audit:
// see the security constraints recorded for these blocks in docs/QA-REPORT.md.
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { HTML_FRAME_PATH, SYNCED_ID_PATTERN, isSyncedId, parseSyncedDocumentName, type SyncedBlockInfo } from '@oriel/shared';
import { Db } from '../src/db/index.js';
import { WorkspaceReader } from '../src/ai/reader.js';
import { extractContent } from '../src/content/ydoc.js';
import { HTML_FRAME_CSP } from '../src/routes/editor.js';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

// --- helpers -------------------------------------------------------------------

const opened: Array<{ close(): void }> = [];
const closeAll = () => {
  for (const c of opened.splice(0)) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
};

interface CollabClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  readonly failed: string | null;
  readonly closed: boolean;
  readonly readOnly: boolean | null;
  close(): void;
}

/** Provider on a document name (`page:<id>` or `synced:<id>`) with a cookie (null: anonymous). */
async function connect(wsBase: string, name: string, cookie: string | null): Promise<CollabClient> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const state: { failed: string | null; closed: boolean; readOnly: boolean | null } = { failed: null, closed: false, readOnly: null };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    onAuthenticated: ({ scope }) => {
      state.readOnly = scope === 'readonly';
    },
    onAuthenticationFailed: ({ reason }) => {
      state.failed = reason || 'denied';
    },
    onClose: () => {
      state.closed = true;
    },
  });
  provider.attach();
  const client: CollabClient = {
    doc,
    provider,
    get failed() {
      return state.failed;
    },
    get closed() {
      return state.closed;
    },
    get readOnly() {
      return state.readOnly;
    },
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
  opened.push(client);
  await waitFor(() => provider.isSynced || state.failed, 5000, `collab sync ${name}`);
  return client;
}

/** Appends a BlockNote block to a document (`content`: a text paragraph, or another block element). */
function appendBlock(doc: Y.Doc, make: () => Y.XmlElement): void {
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    let group = fragment.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement('blockGroup');
      fragment.insert(0, [group]);
    }
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', `b${Math.random().toString(36).slice(2)}`);
    container.insert(0, [make()]);
    group.insert(group.length, [container]);
  });
}
const paragraph = (text: string) => () => {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
};
const syncedElement = (syncedId: string) => () => {
  const el = new Y.XmlElement('syncedBlock');
  el.setAttribute('syncedId', syncedId);
  return el;
};
const docText = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toString();
const syncedName = (id: string) => `synced:${id}`;

/** Hand-rolled Hocuspocus client: authenticates documents by name and sends raw frames. */
class RawCollab {
  readonly auths = new Map<string, string[]>();
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
      const doc = decoding.readVarString(dec);
      const type = decoding.readVarUint(dec);
      if (type !== 2) return;
      const sub = decoding.readVarUint(dec);
      const list = this.auths.get(doc) ?? [];
      list.push(sub === 2 ? `authenticated:${decoding.readVarString(dec)}` : 'denied');
      this.auths.set(doc, list);
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  static open(wsBase: string, cookie: string | null): Promise<RawCollab> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/collab`, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
      ws.on('open', () => {
        const raw = new RawCollab(ws);
        opened.push(raw);
        resolve(raw);
      });
      ws.on('error', reject);
    });
  }

  private send(doc: string, write: (e: encoding.Encoder) => void): void {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, doc);
    write(e);
    this.ws.send(encoding.toUint8Array(e));
  }

  async auth(doc: string): Promise<string> {
    const before = this.auths.get(doc)?.length ?? 0;
    this.send(doc, (e) => {
      encoding.writeVarUint(e, 2); // Auth
      encoding.writeVarUint(e, 0); // Token
      encoding.writeVarString(e, 'session');
    });
    await waitFor(() => (this.auths.get(doc)?.length ?? 0) > before || this.closed, 5000, 'auth reply');
    return this.auths.get(doc)?.[before] ?? 'closed';
  }

  sendUpdate(doc: string, update: Uint8Array): void {
    this.send(doc, (e) => {
      encoding.writeVarUint(e, 0); // Sync
      encoding.writeVarUint(e, 2); // messageYjsUpdate
      encoding.writeVarUint8Array(e, update);
    });
  }

  close(): void {
    this.ws.close();
  }
}

const createSynced = async (client: Client, pageId: string) => expectOk(await client.post<SyncedBlockInfo>(`/pages/${pageId}/synced-blocks`, {}));

// --- shared contract ---------------------------------------------------------------

describe('synced block ids', () => {
  test('only server-generated UUIDs are accepted', () => {
    const id = crypto.randomUUID();
    assert.ok(isSyncedId(id));
    assert.equal(parseSyncedDocumentName(`synced:${id}`), id);
    for (const bad of [
      id.toUpperCase(),
      `${id} `,
      `${id}/x`,
      `../${id}`,
      id.replace(/-/g, ''),
      '00000000-0000-0000-0000-000000000000',
      'synced',
      '',
      `page:${id}`,
    ]) {
      assert.equal(parseSyncedDocumentName(`synced:${bad}`), null, bad);
    }
    assert.equal(parseSyncedDocumentName(`page:${id}`), null);
    assert.equal(isSyncedId({}), false);
    assert.ok(SYNCED_ID_PATTERN.test(id));
  });

  test('page text includes equations, tab titles and button labels; synced ids are listed', () => {
    const doc = new Y.Doc();
    const id = crypto.randomUUID();
    appendBlock(doc, () => {
      const el = new Y.XmlElement('equation');
      el.setAttribute('tex', 'E = mc^2');
      return el;
    });
    appendBlock(doc, () => {
      const p = new Y.XmlElement('paragraph');
      const a = new Y.XmlText();
      a.insert(0, 'Soit');
      const eq = new Y.XmlElement('inlineEquation');
      eq.setAttribute('tex', 'x^2');
      const b = new Y.XmlText();
      b.insert(0, 'la formule');
      p.insert(0, [a, eq, b]);
      return p;
    });
    appendBlock(doc, () => {
      const el = new Y.XmlElement('button');
      el.setAttribute('label', 'Nouvelle tâche');
      return el;
    });
    appendBlock(doc, syncedElement(id));
    appendBlock(doc, syncedElement('pas-un-id'));
    const out = extractContent(doc);
    assert.match(out.text, /E = mc\^2/);
    assert.match(out.text, /Soit x\^2 la formule/);
    assert.match(out.text, /Nouvelle tâche/);
    assert.deepEqual(out.synced, [id]);
    assert.deepEqual(out.links, []);
  });
});

// --- server ---------------------------------------------------------------------------

describe('editor blocks: HTML frame and synced blocks', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let memberId: string;
  let viewerId: string;
  const openDb = () => new Db(path.join(srv.dataDir, 'oriel.db'));

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member, user: { id: memberId } } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    ({ client: viewer, user: { id: viewerId } } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer'));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  // --- HTML block ---------------------------------------------------------------------

  test('the HTML frame bootstrap is static and served with its own sandbox CSP', async () => {
    for (const [cookie, query] of [
      [null, ''],
      [admin.cookie, '?html=%3Cscript%3Ealert(1)%3C/script%3E'],
    ] as const) {
      const res = await fetch(`${srv.base}${HTML_FRAME_PATH}${query}`, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get('content-security-policy'),
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
      );
      assert.equal(res.headers.get('content-security-policy'), HTML_FRAME_CSP);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.match(res.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
      assert.equal(res.headers.get('set-cookie'), null);
      const body = await res.text();
      assert.doesNotMatch(body, /alert\(1\)/, 'nothing of the request is reflected');
      // The bootstrap only accepts a `render` message from its parent window, once.
      assert.match(body, /event\.source !== parentWindow/);
      assert.match(body, /data\.type !== 'render'/);
      assert.match(body, /if \(rendered/);
      assert.doesNotMatch(body, /allow-same-origin/);
    }
    // Every request gets the same bytes.
    const a = await (await fetch(`${srv.base}${HTML_FRAME_PATH}`)).text();
    const b = await (await fetch(`${srv.base}${HTML_FRAME_PATH}?x=1`)).text();
    assert.equal(a, b);
    // Not a route for other methods.
    assert.notEqual((await fetch(`${srv.base}${HTML_FRAME_PATH}`, { method: 'POST' })).status, 200);
  });

  test("the SPA CSP lets the app frame its own origin (the HTML block) without widening frame-src", async () => {
    const res = await fetch(`${srv.base}/w/x`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const frame = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src'))!;
    const sources = frame.split(/\s+/).slice(1);
    assert.ok(sources.includes("'self'"));
    for (const wide of ['*', 'https:', 'http:', 'data:', 'blob:', 'filesystem:']) assert.ok(!sources.includes(wide), wide);
    assert.ok(sources.every((s) => s === "'self'" || /^https:\/\/[a-z0-9.-]+$/.test(s)), frame);
  });

  // --- synced blocks: REST ----------------------------------------------------------------

  test('creating a synced block needs edit access to the page; the page becomes its owner', async () => {
    const page = await createPage(admin, wid, { title: 'Procédures' });
    assert.equal((await new Client(srv.base).post(`/pages/${page.id}/synced-blocks`, {})).status, 401);
    assert.equal((await viewer.post(`/pages/${page.id}/synced-blocks`, {})).status, 403);
    const priv = await createPage(admin, wid, { title: 'Notes privées', visibility: 'private' });
    assert.equal((await member.post(`/pages/${priv.id}/synced-blocks`, {})).status, 404);
    assert.equal((await member.post(`/pages/inconnue/synced-blocks`, {})).status, 404);

    const info = await createSynced(member, page.id);
    assert.ok(isSyncedId(info.id));
    assert.equal(info.ownerPageId, page.id);
    assert.equal(info.ownerTitle, 'Procédures');
    assert.equal(info.canEdit, true);
    assert.deepEqual(info.pages.map((p) => p.id), [page.id]);
    // A client-provided owner or workspace is never used.
    const forged = await createSynced(member, page.id);
    assert.notEqual(forged.id, info.id);
    const db = openDb();
    try {
      const row = db.get<{ workspace_id: string; owner_page_id: string; created_by: string }>('SELECT * FROM editor_synced_blocks WHERE id = ?', info.id);
      assert.deepEqual({ ...row }, { ...row, workspace_id: wid, owner_page_id: page.id, created_by: memberId });
    } finally {
      db.close();
    }
    // Viewers read it, without edit rights.
    const seen = expectOk(await viewer.get<SyncedBlockInfo>(`/pages/${page.id}/synced-blocks/${info.id}`));
    assert.equal(seen.canEdit, false);
    // Trashed pages cannot create one.
    expectOk(await admin.post(`/pages/${page.id}/trash`));
    assert.equal((await member.post(`/pages/${page.id}/synced-blocks`, {})).status, 400);
    const trashedOwner = expectOk(await member.get<SyncedBlockInfo>(`/pages/${page.id}/synced-blocks/${info.id}`));
    assert.equal(trashedOwner.canEdit, false);
  });

  test('a synced block is resolved only for a visible page of its workspace and a visible owner', async () => {
    const owner = await createPage(admin, wid, { title: 'Source' });
    const host = await createPage(admin, wid, { title: 'Hôte' });
    const info = await createSynced(admin, owner.id);
    // Any visible page of the same workspace can show it.
    expectOk(await member.get(`/pages/${host.id}/synced-blocks/${info.id}`));
    // Ids are checked strictly; unknown ids are 404.
    for (const sid of [info.id.toUpperCase(), `${info.id}x`, 'abc', crypto.randomUUID()]) {
      assert.equal((await member.get(`/pages/${host.id}/synced-blocks/${encodeURIComponent(sid)}`)).status, 404, sid);
    }
    // Owner page private (someone else's): invisible, even through a shared page.
    const privOwner = await createPage(admin, wid, { title: 'Brouillon privé', visibility: 'private' });
    const secret = await createSynced(admin, privOwner.id);
    expectOk(await admin.get(`/pages/${host.id}/synced-blocks/${secret.id}`));
    assert.equal((await member.get(`/pages/${host.id}/synced-blocks/${secret.id}`)).status, 404);
    assert.equal((await member.get(`/pages/${host.id}/synced-blocks/${secret.id}/content`)).status, 404);

    // Another workspace: never resolved, even for a member of both.
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Autre espace' }));
    const otherPage = await createPage(admin, other.id, { title: 'Ailleurs' });
    assert.equal((await admin.get(`/pages/${otherPage.id}/synced-blocks/${info.id}`)).status, 404);
    assert.equal((await admin.get(`/pages/${otherPage.id}/synced-blocks/${info.id}/content`)).status, 404);
    const foreign = await createSynced(admin, otherPage.id);
    assert.equal((await admin.get(`/pages/${host.id}/synced-blocks/${foreign.id}`)).status, 404);
    // Non-members of the owner's workspace.
    assert.equal((await member.get(`/pages/${otherPage.id}/synced-blocks/${foreign.id}`)).status, 404);
  });

  test('published pages resolve a published synced block of their own workspace only', async () => {
    const owner = await createPage(admin, wid, { title: 'Source publique' });
    const host = await createPage(admin, wid, { title: 'Hôte public' });
    const info = await createSynced(admin, owner.id);
    const anonymous = new Client(srv.base);
    const status = async (pid: string, sid = info.id) => (await anonymous.get(`/public/pages/${pid}/synced-blocks/${encodeURIComponent(sid)}`)).status;
    assert.equal(await status(host.id), 404, 'nothing published');
    expectOk(await admin.post(`/pages/${host.id}/publish`, { isPublic: true }));
    assert.equal(await status(host.id), 404, 'owner page not published');
    expectOk(await admin.post(`/pages/${owner.id}/publish`, { isPublic: true }));
    const seen = expectOk(await anonymous.get<SyncedBlockInfo>(`/public/pages/${host.id}/synced-blocks/${info.id}`));
    assert.deepEqual(seen, { id: info.id, ownerPageId: owner.id, ownerTitle: 'Source publique', ownerIcon: null, canEdit: false, pages: [] });
    // The session cookie gives nothing more on this route.
    assert.deepEqual(expectOk(await admin.get<SyncedBlockInfo>(`/public/pages/${host.id}/synced-blocks/${info.id}`)), seen);
    for (const sid of [info.id.toUpperCase(), 'abc', crypto.randomUUID()]) assert.equal(await status(host.id, sid), 404, sid);
    // A published page of another workspace never resolves it.
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Espace public 2' }));
    const otherPage = await createPage(admin, other.id, { title: 'Ailleurs publié' });
    expectOk(await admin.post(`/pages/${otherPage.id}/publish`, { isPublic: true }));
    assert.equal(await status(otherPage.id), 404);
    // Owner unpublished, host trashed: 404 again.
    expectOk(await admin.post(`/pages/${owner.id}/publish`, { isPublic: false }));
    assert.equal(await status(host.id), 404);
    expectOk(await admin.post(`/pages/${owner.id}/publish`, { isPublic: true }));
    expectOk(await admin.post(`/pages/${host.id}/trash`));
    assert.equal(await status(host.id), 404);
  });

  // --- synced blocks: /collab ------------------------------------------------------------------

  test('synced documents follow the owner page: names, roles, private pages, anonymous visitors', async () => {
    const page = await createPage(admin, wid, { title: 'Bloc partagé' });
    const info = await createSynced(admin, page.id);
    const raw = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await raw.auth(syncedName(info.id)), 'authenticated:read-write');
    for (const bad of [`synced:${info.id.toUpperCase()}`, `synced:${info.id}/../x`, 'synced:abc', `synced:${crypto.randomUUID()}`, 'synced:', `Synced:${info.id}`]) {
      assert.equal(await raw.auth(bad), 'denied', bad);
    }
    raw.close();

    const v = await RawCollab.open(srv.wsBase, viewer.cookie);
    assert.equal(await v.auth(syncedName(info.id)), 'authenticated:readonly');
    v.close();

    const anon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await anon.auth(syncedName(info.id)), 'denied');
    anon.close();

    const priv = await createPage(admin, wid, { title: 'Privée', visibility: 'private' });
    const privSynced = await createSynced(admin, priv.id);
    const m = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await m.auth(syncedName(privSynced.id)), 'denied');
    m.close();
    const a = await RawCollab.open(srv.wsBase, admin.cookie);
    assert.equal(await a.auth(syncedName(privSynced.id)), 'authenticated:read-write');
    a.close();

    // Published owner page: anonymous visitors read it (read-only), and cannot write.
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    appendBlock(writer.doc, paragraph('Texte public'));
    const visitor = await connect(srv.wsBase, syncedName(info.id), null);
    assert.equal(visitor.failed, null);
    assert.equal(visitor.readOnly, true);
    await waitFor(() => docText(visitor.doc).includes('Texte public'), 3000, 'anonymous read');
    const rawAnon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await rawAnon.auth(syncedName(info.id)), 'authenticated:readonly');
    const vandal = new Y.Doc();
    appendBlock(vandal, paragraph('Vandalisme'));
    rawAnon.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(vandal));
    await sleep(300);
    assert.doesNotMatch(docText(writer.doc), /Vandalisme/);
    rawAnon.close();

    // Unpublished: anonymous connections are closed and new ones refused.
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: false }));
    await sleep(200);
    appendBlock(writer.doc, paragraph('Après dépublication'));
    await waitFor(() => docText(writer.doc).includes('Après dépublication'));
    await sleep(400);
    assert.doesNotMatch(docText(visitor.doc), /Après dépublication/, 'unpublished synced content must not stream to visitors');
    const late = await RawCollab.open(srv.wsBase, null);
    assert.equal(await late.auth(syncedName(info.id)), 'denied');
    late.close();
    writer.close();
    visitor.close();
  });

  test('connections to a synced block are revoked and downgraded like its owner page', async () => {
    const page = await createPage(admin, wid, { title: 'Révocations' });
    const info = await createSynced(admin, page.id);
    const { client: temp, user: tempUser } = await addMember(admin, wid, 'temp@oriel.test', 'Tom Temporaire', 'member');
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    const t = await connect(srv.wsBase, syncedName(info.id), temp.cookie);
    assert.equal(t.readOnly, false);

    // Downgrade to viewer: its updates stop being applied.
    expectOk(await admin.patch(`/workspaces/${wid}/members/${tempUser.id}`, { role: 'viewer' }));
    await sleep(150);
    appendBlock(t.doc, paragraph('Écrit après rétrogradation'));
    await sleep(400);
    assert.doesNotMatch(docText(writer.doc), /après rétrogradation/);
    t.close();

    // Owner page becomes private: others are disconnected.
    const m = await connect(srv.wsBase, syncedName(info.id), member.cookie);
    appendBlock(writer.doc, paragraph('Avant privé'));
    await waitFor(() => docText(m.doc).includes('Avant privé'));
    expectOk(await admin.post(`/pages/${page.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    await sleep(200);
    appendBlock(writer.doc, paragraph('Devenu privé'));
    await waitFor(() => docText(writer.doc).includes('Devenu privé'));
    await sleep(400);
    assert.doesNotMatch(docText(m.doc), /Devenu privé/, 'a page made private must not keep streaming its synced blocks');
    m.close();

    // Removed from the workspace: closed.
    expectOk(await admin.post(`/pages/${page.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'workspace' }));
    const { client: gone, user: goneUser } = await addMember(admin, wid, 'parti@oriel.test', 'Paul Parti', 'member');
    const g = await connect(srv.wsBase, syncedName(info.id), gone.cookie);
    assert.equal(g.failed, null);
    expectOk(await admin.del(`/workspaces/${wid}/members/${goneUser.id}`));
    await sleep(200);
    appendBlock(writer.doc, paragraph('Après départ'));
    await waitFor(() => docText(writer.doc).includes('Après départ'));
    await sleep(400);
    assert.doesNotMatch(docText(g.doc), /Après départ/);
    g.close();

    // Owner page deleted for good: the block goes with it.
    expectOk(await admin.post(`/pages/${page.id}/trash`));
    const res = await admin.del(`/pages/${page.id}`);
    assert.ok(res.status === 200 || res.status === 204, String(res.status));
    await sleep(300);
    const after = await RawCollab.open(srv.wsBase, admin.cookie);
    assert.equal(await after.auth(syncedName(info.id)), 'denied');
    after.close();
    writer.close();
  });

  test('updates of synced documents go through the Yjs structure guard and are saved', async () => {
    const page = await createPage(admin, wid, { title: 'Garde' });
    const info = await createSynced(admin, page.id);
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    appendBlock(writer.doc, paragraph('Contenu synchronisé initial'));

    // A Y.Map root (or a map inside the fragment) breaks every editor: refused.
    const raw = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await raw.auth(syncedName(info.id)), 'authenticated:read-write');
    const evil = new Y.Doc();
    evil.getMap('intrus').set('x', 1);
    raw.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(evil));
    await sleep(300);
    raw.close();
    const evil2 = new Y.Doc();
    appendBlock(evil2, () => {
      const p = new Y.XmlElement('paragraph');
      p.setAttribute('x', new Y.Map() as never);
      return p;
    });
    const raw2 = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await raw2.auth(syncedName(info.id)), 'authenticated:read-write');
    raw2.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(evil2));
    await sleep(300);
    raw2.close();
    assert.equal(writer.doc.share.has('intrus'), false);
    assert.doesNotMatch(docText(writer.doc), /x=/);

    // Saved: state, text, and readable through the content route of a page showing it.
    await waitFor(async () => {
      const res = await admin.get<{ update: string }>(`/pages/${page.id}/synced-blocks/${info.id}/content`);
      if (res.status !== 200) return false;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(res.body.update, 'base64'));
      return docText(doc).includes('Contenu synchronisé initial');
    }, 3000, 'content route');
    writer.close();
    await waitFor(() => {
      const db = openDb();
      try {
        return db.get<{ text: string }>('SELECT text FROM editor_synced_blocks WHERE id = ?', info.id)?.text.includes('Contenu synchronisé initial');
      } finally {
        db.close();
      }
    }, 3000, 'saved text');
  });

  test('pages showing a synced block are recorded (same workspace only) and read by the AI brief safely', async () => {
    const owner = await createPage(admin, wid, { title: 'Propriétaire' });
    const host = await createPage(admin, wid, { title: 'Page hôte' });
    const info = await createSynced(admin, owner.id);
    const content = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    appendBlock(content.doc, paragraph('Consignes de chantier partagées'));
    // The host page shows it (a reference in its content), plus a block of another workspace.
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Espace voisin' }));
    const otherPage = await createPage(admin, other.id, { title: 'Voisine' });
    const foreign = await createSynced(admin, otherPage.id);
    const foreignContent = await connect(srv.wsBase, syncedName(foreign.id), admin.cookie);
    appendBlock(foreignContent.doc, paragraph('Secret du voisin'));
    const hostDoc = await connect(srv.wsBase, `page:${host.id}`, admin.cookie);
    appendBlock(hostDoc.doc, paragraph('Introduction'));
    appendBlock(hostDoc.doc, syncedElement(info.id));
    appendBlock(hostDoc.doc, syncedElement(foreign.id));
    const ownerDoc = await connect(srv.wsBase, `page:${owner.id}`, admin.cookie);
    appendBlock(ownerDoc.doc, syncedElement(info.id));

    await waitFor(async () => {
      const seen = expectOk(await member.get<SyncedBlockInfo>(`/pages/${host.id}/synced-blocks/${info.id}`));
      return seen.pages.some((p) => p.id === host.id) && seen.pages[0]!.id === owner.id;
    }, 3000, 'host page listed');
    for (const c of [content, foreignContent, hostDoc, ownerDoc]) c.close();
    await sleep(300);

    const db = openDb();
    try {
      const refs = db.all<{ synced_id: string }>('SELECT synced_id FROM editor_synced_refs WHERE page_id = ?', host.id).map((r) => r.synced_id);
      assert.deepEqual(refs, [info.id], 'a block of another workspace is never recorded');
      const reader = new WorkspaceReader(db, wid, '2026-10-15');
      const read = reader.readPage({ pageId: host.id }) as { contenu?: string };
      assert.match(read.contenu ?? '', /Introduction/);
      assert.match(read.contenu ?? '', /Consignes de chantier partagées/);
      assert.doesNotMatch(read.contenu ?? '', /Secret du voisin/);

      // Owner page private or trashed: the AI never reads the block, even through a shared page.
      db.run("UPDATE pages SET visibility = 'private' WHERE id = ?", owner.id);
      const priv = new WorkspaceReader(db, wid, '2026-10-15').readPage({ pageId: host.id }) as { contenu?: string };
      assert.doesNotMatch(priv.contenu ?? '', /Consignes de chantier/);
      db.run("UPDATE pages SET visibility = 'workspace', trashed_at = ? WHERE id = ?", Date.now(), owner.id);
      const trashed = new WorkspaceReader(db, wid, '2026-10-15').readPage({ pageId: host.id }) as { contenu?: string };
      assert.doesNotMatch(trashed.contenu ?? '', /Consignes de chantier/);
      db.run('UPDATE pages SET trashed_at = NULL WHERE id = ?', owner.id);
    } finally {
      db.close();
    }

    // A copy of the host page shows the same block (a reference, not a copy of its content).
    const copy = expectOk(await admin.post<{ id: string }>(`/pages/${host.id}/duplicate`, {}));
    const listed = expectOk(await admin.get<SyncedBlockInfo>(`/pages/${copy.id}/synced-blocks/${info.id}`));
    assert.ok(listed.pages.some((p) => p.id === copy.id));
    const db2 = openDb();
    try {
      assert.deepEqual(
        db2.all<{ synced_id: string }>('SELECT synced_id FROM editor_synced_refs WHERE page_id = ?', copy.id).map((r) => r.synced_id),
        [info.id],
      );
      assert.equal(db2.get<{ n: number }>('SELECT COUNT(*) AS n FROM editor_synced_blocks WHERE owner_page_id = ?', copy.id)?.n, 0);
    } finally {
      db2.close();
    }

    // Pages the caller cannot see are not listed.
    const privHost = await createPage(admin, wid, { title: 'Hôte privé', visibility: 'private' });
    const privDoc = await connect(srv.wsBase, `page:${privHost.id}`, admin.cookie);
    appendBlock(privDoc.doc, syncedElement(info.id));
    await waitFor(async () => (await admin.get<SyncedBlockInfo>(`/pages/${host.id}/synced-blocks/${info.id}`)).body.pages.some((p) => p.id === privHost.id));
    const forMember = expectOk(await member.get<SyncedBlockInfo>(`/pages/${host.id}/synced-blocks/${info.id}`));
    assert.ok(!forMember.pages.some((p) => p.id === privHost.id));
    privDoc.close();
    void viewerId;
  });
});
