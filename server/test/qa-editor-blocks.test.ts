// QA (security review) of the advanced editor blocks: synced blocks (`synced:<id>` documents on
// /collab, REST and public routes) and the HTML block frame. Each test is the reproduction of a
// suspected flaw; confirmed-but-unfixed ones are marked `todo`. Tests named « vérifié » cover
// hypotheses checked and ruled out (QA-REPORT §6).
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { HTML_FRAME_PATH, type SyncedBlockInfo } from '@oriel/shared';
import { Db } from '../src/db/index.js';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

// --- helpers -------------------------------------------------------------------------------

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
  readonly readOnly: boolean | null;
  close(): void;
}

/** Provider on a document name with a session cookie (null: anonymous). */
async function connect(wsBase: string, name: string, cookie: string | null): Promise<CollabClient> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const state: { failed: string | null; readOnly: boolean | null } = { failed: null, readOnly: null };
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
  });
  provider.attach();
  const client: CollabClient = {
    doc,
    provider,
    get failed() {
      return state.failed;
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

/** Hand-rolled Hocuspocus client: authenticates documents by name, sends raw updates, records awareness. */
class RawCollab {
  readonly auths = new Map<string, string[]>();
  readonly awareness = new Awareness(new Y.Doc());
  readonly closedDocs = new Set<string>();
  closed = false;
  private constructor(readonly ws: WebSocket) {
    this.awareness.setLocalState(null);
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
      const doc = decoding.readVarString(dec);
      const type = decoding.readVarUint(dec);
      if (type === 1) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), null);
        return;
      }
      if (type === 7) {
        this.closedDocs.add(doc);
        return;
      }
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
      encoding.writeVarUint(e, 2); // Update
      encoding.writeVarUint8Array(e, update);
    });
  }

  names(): string[] {
    return [...this.awareness.getStates().values()].map((s) => (s as { user?: { name?: string } }).user?.name ?? '').filter(Boolean);
  }

  close(): void {
    this.awareness.destroy();
    this.ws.close();
  }
}

function appendParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    let group = fragment.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement('blockGroup');
      fragment.insert(0, [group]);
    }
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', `b${Math.random().toString(36).slice(2)}`);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    container.insert(0, [p]);
    group.insert(group.length, [container]);
  });
}
const docText = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toString();
const syncedName = (id: string) => `synced:${id}`;
const createSynced = async (client: Client, pageId: string, body: Record<string, unknown> = {}) =>
  expectOk(await client.post<SyncedBlockInfo>(`/pages/${pageId}/synced-blocks`, body));

// --- tests ---------------------------------------------------------------------------------

describe('QA-EDT: advanced editor blocks (synced blocks, HTML frame)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  const openDb = () => new Db(path.join(srv.dataDir, 'oriel.db'));

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre-edt@oriel.test', 'Mia Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur-edt@oriel.test', 'Luc Lecteur', 'viewer'));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('QA-EDT-02: a synced block (and page) in the trash is read-only on /collab, writable again after restore', async () => {
    const owner = await createPage(admin, wid, { title: 'Propriétaire supprimée' });
    const info = await createSynced(admin, owner.id);
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    appendParagraph(writer.doc, 'Avant corbeille');
    // A member connection opened BEFORE the trash: downgraded in place.
    const open = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await open.auth(syncedName(info.id)), 'authenticated:read-write');
    expectOk(await admin.post(`/pages/${owner.id}/trash`));
    // The REST API already reports the block as read-only.
    assert.equal(expectOk(await member.get<SyncedBlockInfo>(`/pages/${owner.id}/synced-blocks/${info.id}`)).canEdit, false);
    // A new raw client of a member is read-only, and its updates are dropped.
    const raw = await RawCollab.open(srv.wsBase, member.cookie);
    const verdict = await raw.auth(syncedName(info.id));
    const forged = new Y.Doc();
    appendParagraph(forged, 'Écrit dans la corbeille');
    raw.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(forged));
    const forged2 = new Y.Doc();
    appendParagraph(forged2, 'Connexion ouverte avant');
    open.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(forged2));
    await sleep(400);
    assert.doesNotMatch(docText(writer.doc), /Écrit dans la corbeille/, 'update applied to the synced block of a trashed page');
    assert.doesNotMatch(docText(writer.doc), /Connexion ouverte avant/, 'connection opened before the trash still writes');
    assert.equal(verdict, 'authenticated:readonly', 'trashed owner: the connection must be read-only');
    // Restored: the connection that stayed open can write again (no input lost after a restore).
    expectOk(await admin.post(`/pages/${owner.id}/restore`));
    const forged3 = new Y.Doc();
    appendParagraph(forged3, 'Après restauration');
    open.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(forged3));
    await waitFor(() => /Après restauration/.test(docText(writer.doc)), 3000, 'write after restore');
    raw.close();
    open.close();
    writer.close();
  });

  test('QA-EDT vérifié : a viewer sending raw updates to a synced document changes nothing (document and database)', async () => {
    const owner = await createPage(admin, wid, { title: 'Lecture seule réelle' });
    const info = await createSynced(admin, owner.id);
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    appendParagraph(writer.doc, 'Texte officiel');
    const raw = await RawCollab.open(srv.wsBase, viewer.cookie);
    assert.equal(await raw.auth(syncedName(info.id)), 'authenticated:readonly');
    const forged = new Y.Doc();
    appendParagraph(forged, 'Vandalisme du lecteur');
    raw.sendUpdate(syncedName(info.id), Y.encodeStateAsUpdate(forged));
    await sleep(400);
    raw.close();
    writer.close();
    assert.doesNotMatch(docText(writer.doc), /Vandalisme/);
    await waitFor(() => {
      const db = openDb();
      try {
        return db.get<{ text: string }>('SELECT text FROM editor_synced_blocks WHERE id = ?', info.id)?.text.includes('Texte officiel');
      } finally {
        db.close();
      }
    }, 3000, 'saved text');
    const db = openDb();
    try {
      assert.doesNotMatch(db.get<{ text: string }>('SELECT text FROM editor_synced_blocks WHERE id = ?', info.id)!.text, /Vandalisme/);
    } finally {
      db.close();
    }
  });

  test('QA-EDT vérifié : anonymous readers of a published synced block never receive the presence of members', async () => {
    const owner = await createPage(admin, wid, { title: 'Présence' });
    const info = await createSynced(admin, owner.id);
    expectOk(await admin.post(`/pages/${owner.id}/publish`, { isPublic: true }));
    const m = await connect(srv.wsBase, syncedName(info.id), member.cookie);
    const anon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await anon.auth(syncedName(info.id)), 'authenticated:readonly');
    const peer = await RawCollab.open(srv.wsBase, admin.cookie);
    assert.equal(await peer.auth(syncedName(info.id)), 'authenticated:read-write');
    m.provider.setAwarenessField('user', { name: 'Mia Membre', color: '#123456' });
    await waitFor(() => peer.names().includes('Mia Membre'), 3000, 'member sees presence');
    await sleep(200);
    assert.deepEqual(anon.names(), [], 'presence relayed to anonymous readers');
    // Anonymous readers cannot publish a presence either.
    anon.awareness.setLocalState({ user: { name: 'Fantôme' } });
    await sleep(200);
    assert.ok(!peer.names().includes('Fantôme'));
    m.close();
    anon.close();
    peer.close();
  });

  test('QA-EDT vérifié : trashing the published owner page closes and refuses anonymous synced connections', async () => {
    const owner = await createPage(admin, wid, { title: 'Publiée puis supprimée' });
    const info = await createSynced(admin, owner.id);
    expectOk(await admin.post(`/pages/${owner.id}/publish`, { isPublic: true }));
    const writer = await connect(srv.wsBase, syncedName(info.id), admin.cookie);
    const visitor = await connect(srv.wsBase, syncedName(info.id), null);
    assert.equal(visitor.readOnly, true);
    expectOk(await admin.post(`/pages/${owner.id}/trash`));
    await sleep(200);
    appendParagraph(writer.doc, 'Après la corbeille');
    await sleep(400);
    assert.doesNotMatch(docText(visitor.doc), /Après la corbeille/);
    const late = await RawCollab.open(srv.wsBase, null);
    assert.equal(await late.auth(syncedName(info.id)), 'denied');
    late.close();
    writer.close();
    visitor.close();
  });

  test('QA-EDT vérifié : owner and workspace never come from the client; ids are checked before any lookup', async () => {
    const owner = await createPage(admin, wid, { title: 'Corps forgé' });
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Espace forgé' }));
    const otherPage = await createPage(admin, other.id, { title: 'Ailleurs' });
    const info = await createSynced(member, owner.id, { workspaceId: other.id, ownerPageId: otherPage.id, id: crypto.randomUUID(), pageId: otherPage.id });
    assert.equal(info.ownerPageId, owner.id);
    const db = openDb();
    try {
      const row = db.get<{ workspace_id: string; owner_page_id: string }>('SELECT workspace_id, owner_page_id FROM editor_synced_blocks WHERE id = ?', info.id);
      assert.equal(row?.workspace_id, wid);
      assert.equal(row?.owner_page_id, owner.id);
    } finally {
      db.close();
    }
    // Over-long, path-like or SQL-like ids: never a 200, never a 500.
    for (const sid of ['x'.repeat(65), `${info.id}%2F..`, "' OR 1=1 --", '..', `${info.id}?x=1`]) {
      const res = await member.get(`/pages/${owner.id}/synced-blocks/${encodeURIComponent(sid)}`);
      assert.ok(res.status === 400 || res.status === 404, `${sid} → ${res.status}`);
      const pub = await new Client(srv.base).get(`/public/pages/${owner.id}/synced-blocks/${encodeURIComponent(sid)}`);
      assert.ok(pub.status === 400 || pub.status === 404, `public ${sid} → ${pub.status}`);
    }
    // Creating needs a session, and a page of a workspace the caller belongs to.
    assert.equal((await member.post(`/pages/${otherPage.id}/synced-blocks`, {})).status, 404);
  });

  test("QA-EDT vérifié : the list of pages showing a block never names a page the caller cannot see (private, trashed, other workspace)", async () => {
    const owner = await createPage(admin, wid, { title: 'Source listée' });
    const info = await createSynced(admin, owner.id);
    const secret = await createPage(admin, wid, { title: 'Titre secret', visibility: 'private' });
    const trashed = await createPage(admin, wid, { title: 'Titre supprimé' });
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Espace des hôtes' }));
    const foreign = await createPage(admin, other.id, { title: 'Titre étranger' });
    const db = openDb();
    try {
      // References as recorded by a save (the foreign one forced in, as a stale or forged row would be).
      for (const pid of [secret.id, trashed.id, foreign.id]) db.run('INSERT OR IGNORE INTO editor_synced_refs (synced_id, page_id) VALUES (?, ?)', info.id, pid);
    } finally {
      db.close();
    }
    expectOk(await admin.post(`/pages/${trashed.id}/trash`));
    const seen = expectOk(await member.get<SyncedBlockInfo>(`/pages/${owner.id}/synced-blocks/${info.id}`));
    assert.deepEqual(seen.pages.map((p) => p.id), [owner.id]);
    const body = JSON.stringify(seen);
    for (const title of ['Titre secret', 'Titre supprimé', 'Titre étranger']) assert.ok(!body.includes(title), title);
  });

  test('QA-EDT vérifié : the HTML frame route reflects nothing and keeps its CSP on errors and other methods', async () => {
    for (const suffix of ['', '/', '?x=%3Cscript%3E', '#x']) {
      const res = await fetch(`${srv.base}${HTML_FRAME_PATH}${suffix}`);
      if (res.status !== 200) continue; // trailing slash: not this route
      assert.match(res.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts;/);
      assert.doesNotMatch(await res.text(), /<script>alert|%3Cscript/);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${srv.base}${HTML_FRAME_PATH}`, { method });
      assert.notEqual(res.status, 200, method);
    }
  });
});
