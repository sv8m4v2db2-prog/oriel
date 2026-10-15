// Security regression tests for the real-time endpoints (/collab and /api/events).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { ServerMessage, SessionResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

// --- helpers -------------------------------------------------------------------

/** Everything a test opened; closed in `after` even when an assertion failed mid-test. */
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
  failed: string | null;
  close(): void;
}

async function connectCollab(wsBase: string, pageId: string, cookie: string | null): Promise<CollabClient> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, cookie ? { headers: { cookie: `oriel_session=${cookie}` } } : {});
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const state: { failed: string | null } = { failed: null };
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `page:${pageId}`,
    document: doc,
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
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
  opened.push(client);
  await waitFor(() => provider.isSynced || state.failed, 5000, 'collab sync');
  return client;
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
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    container.insert(0, [paragraph]);
    group.insert(group.length, [container]);
  });
}

const docText = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toString();

/** Hand-rolled Hocuspocus protocol client (lets a test send frames a well-behaved provider never sends). */
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

  async auth(pageId: string): Promise<string> {
    const doc = `page:${pageId}`;
    const before = this.auths.get(doc)?.length ?? 0;
    this.send(doc, (e) => {
      encoding.writeVarUint(e, 2); // Auth
      encoding.writeVarUint(e, 0); // Token
      encoding.writeVarString(e, 'session');
    });
    await waitFor(() => (this.auths.get(doc)?.length ?? 0) > before || this.closed, 5000, 'auth reply');
    return this.auths.get(doc)?.[before] ?? 'closed';
  }

  sendUpdate(pageId: string, update: Uint8Array): void {
    this.send(`page:${pageId}`, (e) => {
      encoding.writeVarUint(e, 0); // Sync
      encoding.writeVarUint(e, 2); // messageYjsUpdate
      encoding.writeVarUint8Array(e, update);
    });
  }

  sendSyncStep2(pageId: string, update: Uint8Array): void {
    this.send(`page:${pageId}`, (e) => {
      encoding.writeVarUint(e, 0); // Sync
      encoding.writeVarUint(e, 1); // messageYjsSyncStep2
      encoding.writeVarUint8Array(e, update);
    });
  }

  sendAwareness(pageId: string, update: Uint8Array): void {
    this.send(`page:${pageId}`, (e) => {
      encoding.writeVarUint(e, 1); // Awareness
      encoding.writeVarUint8Array(e, update);
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** A Yjs update appending one paragraph (as produced by an editor). */
function paragraphUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  appendParagraph(doc, text);
  return Y.encodeStateAsUpdate(doc);
}

/** An awareness update carrying `state` for `clientId` with a high clock (wins over the real owner). */
function forgedAwareness(clientId: number, state: Record<string, unknown> | null): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  const aw = new Awareness(doc);
  for (let i = 0; i < 50; i++) aw.setLocalState({ i });
  aw.setLocalState(state);
  const update = encodeAwarenessUpdate(aw, [clientId]);
  aw.destroy();
  doc.destroy();
  return update;
}

function connectEvents(wsBase: string, cookie: string): Promise<{ ws: WebSocket; messages: ServerMessage[]; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/events`, { headers: { cookie: `oriel_session=${cookie}` } });
    const messages: ServerMessage[] = [];
    let closed = false;
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    ws.on('close', () => {
      closed = true;
    });
    ws.on('error', reject);
    opened.push({ close: () => ws.terminate() });
    ws.on('open', () => resolve({ ws, messages, closed: () => closed }));
  });
}

// --- tests -----------------------------------------------------------------------

describe('security: /collab', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let memberEmail: string;
  let memberName: string;
  let viewer: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    memberEmail = 'membre@oriel.test';
    memberName = 'Marc Membre';
    ({ client: member } = await addMember(admin, wid, memberEmail, memberName, 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('read-only connections (viewer, anonymous) cannot push raw updates or sync step 2', async () => {
    const page = await createPage(admin, wid, { title: 'Brut' });
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Original');

    const v = await RawCollab.open(srv.wsBase, viewer.cookie);
    assert.equal(await v.auth(page.id), 'authenticated:readonly');
    v.sendUpdate(page.id, paragraphUpdate('Vandalisme lecteur'));
    v.sendSyncStep2(page.id, paragraphUpdate('Vandalisme lecteur 2'));

    const anon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await anon.auth(page.id), 'authenticated:readonly');
    anon.sendUpdate(page.id, paragraphUpdate('Vandalisme anonyme'));
    anon.sendSyncStep2(page.id, paragraphUpdate('Vandalisme anonyme 2'));

    await sleep(400);
    assert.doesNotMatch(docText(a.doc), /Vandalisme/);
    for (const c of [v, anon]) c.close();
    a.close();
  });

  test('document names are validated and access is checked per document on a shared socket', async () => {
    const page = await createPage(admin, wid, { title: 'Partagé' });
    const priv = await createPage(admin, wid, { title: 'Secret', visibility: 'private' });
    const raw = await RawCollab.open(srv.wsBase, member.cookie);
    assert.equal(await raw.auth(page.id), 'authenticated:read-write');
    assert.equal(await raw.auth(priv.id), 'denied');
    assert.equal(await raw.auth('../../etc/passwd'), 'denied');
    raw.close();
  });

  test('anonymous viewers lose live access when a published page is trashed', async () => {
    const page = await createPage(admin, wid, { title: 'Annonce' });
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Avant');
    const anon = await connectCollab(srv.wsBase, page.id, null);
    assert.equal(anon.failed, null);
    await waitFor(() => docText(anon.doc).includes('Avant'));

    expectOk(await admin.post(`/pages/${page.id}/trash`));
    assert.equal((await new Client(srv.base).get(`/public/pages/${page.id}`)).status, 404);
    await sleep(200);
    appendParagraph(a.doc, 'Après corbeille');
    await waitFor(() => docText(a.doc).includes('Après corbeille'));
    await sleep(400);
    assert.doesNotMatch(docText(anon.doc), /Après corbeille/, 'trashed page content must not keep streaming to anonymous viewers');
    a.close();
    anon.close();
  });

  test('anonymous viewers lose live access when a page is moved out of a published tree', async () => {
    const root = await createPage(admin, wid, { title: 'Site public' });
    const child = await createPage(admin, wid, { parentType: 'page', parentId: root.id, title: 'Brouillon' });
    expectOk(await admin.post(`/pages/${root.id}/publish`, { isPublic: true }));
    const a = await connectCollab(srv.wsBase, child.id, admin.cookie);
    appendParagraph(a.doc, 'Public');
    const anon = await connectCollab(srv.wsBase, child.id, null);
    assert.equal(anon.failed, null);
    await waitFor(() => docText(anon.doc).includes('Public'));

    expectOk(await admin.post(`/pages/${child.id}/move`, { parentType: 'workspace', parentId: wid }));
    assert.equal((await new Client(srv.base).get(`/public/pages/${child.id}`)).status, 404);
    await sleep(200);
    appendParagraph(a.doc, 'Plus public');
    await waitFor(() => docText(a.doc).includes('Plus public'));
    await sleep(400);
    assert.doesNotMatch(docText(anon.doc), /Plus public/, 'unpublished page content must not keep streaming to anonymous viewers');
    a.close();
    anon.close();
  });

  test('a /collab socket opened with a session that was revoked cannot open new documents nor keep writing', async () => {
    const page1 = await createPage(admin, wid, { title: 'Doc 1' });
    const page2 = await createPage(admin, wid, { title: 'Doc 2' });
    const { client: victim } = await addMember(admin, wid, 'victime@oriel.test', 'Victor', 'member');
    // "Stolen" second session of the victim.
    const thief = new Client(srv.base);
    expectOk(await thief.post<SessionResponse>('/auth/login', { email: 'victime@oriel.test', password: 'motdepasse-solide' }));
    const raw = await RawCollab.open(srv.wsBase, thief.cookie);
    assert.equal(await raw.auth(page1.id), 'authenticated:read-write');

    // The victim changes their password: every other session is revoked.
    expectOk(await victim.post('/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-mot-de-passe' }));
    assert.equal((await thief.get('/auth/me')).status, 401);

    const a = await connectCollab(srv.wsBase, page1.id, admin.cookie);
    if (!raw.closed) {
      assert.notEqual(await raw.auth(page2.id), 'authenticated:read-write', 'revoked session must not open new documents');
      raw.sendUpdate(page1.id, paragraphUpdate('Écrit avec une session révoquée'));
    }
    await sleep(400);
    assert.doesNotMatch(docText(a.doc), /session révoquée/);
    raw.close();
    a.close();
  });

  test('logout closes the collab connections of that session', async () => {
    const page = await createPage(admin, wid, { title: 'Déconnexion' });
    const page2 = await createPage(admin, wid, { title: 'Déconnexion 2' });
    // The cookie leaked to an attacker who keeps a /collab socket open; the victim then logs out.
    const { client: victim } = await addMember(admin, wid, 'deconnexion@oriel.test', 'Denis', 'member');
    const raw = await RawCollab.open(srv.wsBase, victim.cookie);
    assert.equal(await raw.auth(page.id), 'authenticated:read-write');
    expectOk(await victim.post('/auth/logout'));
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    if (!raw.closed) {
      assert.notEqual(await raw.auth(page2.id), 'authenticated:read-write', 'logged-out session must not open new documents');
      raw.sendUpdate(page.id, paragraphUpdate('Après déconnexion'));
    }
    await sleep(400);
    assert.doesNotMatch(docText(a.doc), /Après déconnexion/);
    raw.close();
    a.close();
  });

  test('awareness: anonymous visitors cannot inject presence; members cannot impersonate or hijack peers', async () => {
    const page = await createPage(admin, wid, { title: 'Présence' });
    expectOk(await admin.post(`/pages/${page.id}/publish`, { isPublic: true }));
    const adminMe = expectOk(await admin.get<SessionResponse>('/auth/me')).user;
    const memberMe = expectOk(await member.get<SessionResponse>('/auth/me')).user;

    const observer = await connectCollab(srv.wsBase, page.id, admin.cookie);
    const m = await connectCollab(srv.wsBase, page.id, member.cookie);
    m.provider.setAwarenessField('user', { id: memberMe.id, name: memberName, color: '#123456' });
    const memberClientId = m.doc.clientID;
    await waitFor(() => (observer.provider.awareness!.getStates().get(memberClientId) as { user?: { name?: string } } | undefined)?.user?.name === memberName);

    // 1. Anonymous visitor tries to appear as the admin.
    const anon = await connectCollab(srv.wsBase, page.id, null);
    anon.provider.setAwarenessField('user', { id: adminMe.id, name: 'Alice Admin (support)', color: '#ff0000' });
    // 2. Anonymous visitor tries to overwrite / remove the member's presence.
    const rawAnon = await RawCollab.open(srv.wsBase, null);
    assert.equal(await rawAnon.auth(page.id), 'authenticated:readonly');
    rawAnon.sendAwareness(page.id, forgedAwareness(memberClientId, { user: { id: memberMe.id, name: 'Cliquez ici : evil.example' } }));
    // 3. Another member tries to impersonate the admin and to hijack the member's client id.
    const { client: mallory } = await addMember(admin, wid, 'mallory@oriel.test', 'Mallory', 'member');
    const mal = await connectCollab(srv.wsBase, page.id, mallory.cookie);
    mal.provider.setAwarenessField('user', { id: adminMe.id, name: 'Alice Admin', color: '#00ff00' });
    const rawMal = await RawCollab.open(srv.wsBase, mallory.cookie);
    assert.equal(await rawMal.auth(page.id), 'authenticated:read-write');
    rawMal.sendAwareness(page.id, forgedAwareness(memberClientId, { user: { id: memberMe.id, name: 'Marc (piraté)' } }));

    await waitFor(() => observer.provider.awareness!.getStates().has(mal.doc.clientID), 5000, 'mallory presence');
    await sleep(400);
    const states = observer.provider.awareness!.getStates();
    assert.equal(states.has(anon.doc.clientID), false, 'anonymous presence must not reach members');
    const memberState = states.get(memberClientId) as { user?: { name?: string } } | undefined;
    assert.equal(memberState?.user?.name, memberName, 'a peer cannot overwrite another client presence');
    const malState = states.get(mal.doc.clientID) as { user?: { id?: string; name?: string } } | undefined;
    assert.notEqual(malState?.user?.id, adminMe.id, 'presence identity is stamped by the server');
    assert.equal(malState?.user?.name, 'Mallory');

    for (const c of [observer, m, anon, mal]) c.close();
    rawAnon.close();
    rawMal.close();
  });
});

describe('security: /api/events', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    closeAll();
    await srv.stop();
  });

  test('foreign workspaces cannot be subscribed', async () => {
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const other = new Client(srv.base);
    const s = expectOk(await other.post<SessionResponse>('/auth/signup', { email: 'autre@oriel.test', name: 'Otto', password: 'motdepasse-solide' }));
    const ev = await connectEvents(srv.wsBase, other.cookie!);
    ev.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: wid }));
    await waitFor(() => ev.messages.find((m) => m.type === 'revoked'));
    await createPage(admin, wid, { title: 'Invisible' });
    await sleep(150);
    assert.equal(ev.messages.filter((m) => m.type === 'changes').length, 0);
    assert.ok(s.workspaces[0]);
    ev.ws.close();
  });

  test('sockets of revoked sessions are closed on password change', async () => {
    const { client: member } = await addMember(admin, wid, 'events@oriel.test', 'Eve', 'member');
    const thief = new Client(srv.base);
    expectOk(await thief.post('/auth/login', { email: 'events@oriel.test', password: 'motdepasse-solide' }));
    const ev = await connectEvents(srv.wsBase, thief.cookie!);
    ev.ws.send(JSON.stringify({ type: 'subscribe', workspaceId: wid }));
    await waitFor(() => ev.messages.find((m) => m.type === 'subscribed'));
    expectOk(await member.post('/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-mot-de-passe' }));
    await waitFor(() => ev.closed(), 3000, 'events socket of the revoked session closed');
  });
});
