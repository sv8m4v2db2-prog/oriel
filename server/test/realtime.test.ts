import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { BacklinksResponse, Change, Page, SearchResponse, ServerMessage, SessionResponse, SnapshotResponse, SnapshotsResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// /api/events helpers
// ---------------------------------------------------------------------------

interface EventsClient {
  ws: WebSocket;
  messages: ServerMessage[];
  changes(): Change[];
  send(msg: unknown): void;
  close(): void;
}

function connectEvents(wsBase: string, cookie: string | null, origin?: string): Promise<EventsClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = `oriel_session=${cookie}`;
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`${wsBase}/api/events`, { headers });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        changes: () => messages.flatMap((m) => (m.type === 'changes' ? m.changes : [])),
        send: (msg) => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// /collab helpers
// ---------------------------------------------------------------------------

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
  await waitFor(() => provider.isSynced || state.failed, 5000, 'collab sync');
  return {
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
}

function appendParagraph(doc: Y.Doc, text: string, mentionPageId?: string): void {
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    let group = fragment.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement('blockGroup');
      fragment.insert(0, [group]);
    }
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', crypto.randomUUID());
    const paragraph = new Y.XmlElement('paragraph');
    const content = new Y.XmlText();
    content.insert(0, text);
    const inline: Array<Y.XmlElement | Y.XmlText> = [content];
    if (mentionPageId) {
      const mention = new Y.XmlElement('pageMention');
      mention.setAttribute('pageId', mentionPageId);
      inline.push(mention);
    }
    paragraph.insert(0, inline);
    container.insert(0, [paragraph]);
    group.insert(group.length, [container]);
  });
}

const docText = (doc: Y.Doc) => doc.getXmlFragment('blocknote').toString();

describe('real-time invalidation bus (/api/events)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let memberId: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    const m = await addMember(admin, wid, 'membre@oriel.test', 'Marc', 'member');
    member = m.client;
    memberId = m.user.id;
  });
  after(async () => {
    await srv.stop();
  });

  test('rejects unauthenticated and cross-origin upgrades', async () => {
    await assert.rejects(connectEvents(srv.wsBase, null), /401/);
    await assert.rejects(connectEvents(srv.wsBase, admin.cookie, 'https://evil.example'), /403/);
  });

  test('hello, subscribe, ping/pong and changes after a mutation', async () => {
    const ev = await connectEvents(srv.wsBase, admin.cookie);
    await waitFor(() => ev.messages.find((m) => m.type === 'hello'));
    ev.send({ type: 'subscribe', workspaceId: wid });
    await waitFor(() => ev.messages.find((m) => m.type === 'subscribed' && m.workspaceId === wid));
    ev.send({ type: 'ping' });
    await waitFor(() => ev.messages.find((m) => m.type === 'pong'));

    const page = await createPage(member, wid, { title: 'Nouvelle page' });
    const change = await waitFor(() => ev.changes().find((c) => c.entity === 'page' && c.id === page.id));
    assert.deepEqual(change, {
      entity: 'page',
      id: page.id,
      kind: 'page',
      parentType: 'workspace',
      parentId: wid,
      databaseId: null,
      affectsTree: true,
    });

    // database row change carries the database id and does not affect the tree
    const db = await createPage(member, wid, { kind: 'database', title: 'Base' });
    const row = expectOk(await member.post<Page>(`/databases/${db.id}/rows`, { title: 'Ligne' }));
    const rowChange = await waitFor(() => ev.changes().find((c) => c.entity === 'page' && c.id === row.id));
    assert.equal(rowChange.entity === 'page' && rowChange.databaseId, db.id);
    assert.equal(rowChange.entity === 'page' && rowChange.affectsTree, false);
    expectOk(await member.post(`/databases/${db.id}/properties`, { property: { name: 'Note', type: 'number' } }));
    await waitFor(() => ev.changes().find((c) => c.entity === 'database' && c.id === db.id));
    ev.close();
  });

  test('private pages and favorites only reach their owner; non-members are revoked', async () => {
    const adminEv = await connectEvents(srv.wsBase, admin.cookie);
    const memberEv = await connectEvents(srv.wsBase, member.cookie);
    for (const ev of [adminEv, memberEv]) {
      ev.send({ type: 'subscribe', workspaceId: wid });
      await waitFor(() => ev.messages.find((m) => m.type === 'subscribed'));
    }
    const priv = await createPage(member, wid, { title: 'Privé', visibility: 'private' });
    expectOk(await member.put(`/pages/${priv.id}/favorite`, { favorite: true }));
    const marker = await createPage(admin, wid, { title: 'Marqueur' });
    await waitFor(() => adminEv.changes().find((c) => c.entity === 'page' && c.id === marker.id));
    await waitFor(() => memberEv.changes().find((c) => c.entity === 'page' && c.id === marker.id));
    assert.ok(memberEv.changes().some((c) => c.entity === 'page' && c.id === priv.id));
    assert.ok(memberEv.changes().some((c) => c.entity === 'favorites'));
    assert.ok(!adminEv.changes().some((c) => c.entity === 'page' && c.id === priv.id), 'private change leaked');
    assert.ok(!adminEv.changes().some((c) => c.entity === 'favorites'), 'favorites change leaked');

    // subscribing to a foreign workspace → revoked
    adminEv.send({ type: 'subscribe', workspaceId: 'not-a-workspace' });
    await waitFor(() => adminEv.messages.find((m) => m.type === 'revoked' && m.workspaceId === 'not-a-workspace'));

    // removing the member revokes their subscription
    expectOk(await admin.del(`/workspaces/${wid}/members/${memberId}`));
    await waitFor(() => memberEv.messages.find((m) => m.type === 'revoked' && m.workspaceId === wid));
    await waitFor(() => adminEv.changes().find((c) => c.entity === 'members'));
    adminEv.close();
    memberEv.close();
  });
});

describe('collaboration (/collab)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let viewer: Client;
  let outsider: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
  });
  after(async () => {
    await srv.stop();
  });

  const readDocumentRow = (pageId: string) => {
    const db = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'), { readOnly: true });
    try {
      return db.prepare('SELECT text, length(state) AS size FROM documents WHERE page_id = ?').get(pageId) as
        | { text: string; size: number }
        | undefined;
    } finally {
      db.close();
    }
  };

  test('edit, persist, extract text/links, search, reload', async () => {
    const target = await createPage(admin, wid, { title: 'Glossaire' });
    const page = await createPage(admin, wid, { title: 'Notes de réunion' });
    const ev = await connectEvents(srv.wsBase, admin.cookie);
    ev.send({ type: 'subscribe', workspaceId: wid });
    await waitFor(() => ev.messages.find((m) => m.type === 'subscribed'));

    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    assert.equal(a.failed, null);
    appendParagraph(a.doc, 'Bonjour la oriel', target.id);
    appendParagraph(a.doc, 'Deuxième paragraphe sur les icebergs');

    const row = await waitFor(() => {
      const r = readDocumentRow(page.id);
      return r && r.text.includes('icebergs') ? r : null;
    }, 5000, 'document persisted');
    assert.equal(row.text, 'Bonjour la oriel\nDeuxième paragraphe sur les icebergs');
    assert.ok(row.size > 0);

    // content store publishes a non-tree page change
    const change = await waitFor(() => ev.changes().find((c) => c.entity === 'page' && c.id === page.id && !c.affectsTree));
    assert.equal(change.entity, 'page');

    const search = expectOk(await admin.get<SearchResponse>(`/workspaces/${wid}/search?q=iceberg`));
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0]!.page.id, page.id);
    assert.match(search.results[0]!.snippet, /\[\[icebergs\]\]/);

    const backlinks = expectOk(await admin.get<BacklinksResponse>(`/pages/${target.id}/backlinks`));
    assert.deepEqual(
      backlinks.pages.map((p) => p.id),
      [page.id],
    );

    const detail = expectOk(await admin.get(`/pages/${page.id}`));
    assert.ok(detail.page.updatedAt >= page.updatedAt);

    a.close();
    await sleep(100);
    const b = await connectCollab(srv.wsBase, page.id, admin.cookie);
    assert.match(docText(b.doc), /Bonjour la oriel/);
    assert.match(docText(b.doc), /icebergs/);
    b.close();
    ev.close();
  });

  test('two clients see each other’s edits', async () => {
    const page = await createPage(admin, wid, { title: 'Collaboratif' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    const b = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Écrit par A');
    await waitFor(() => docText(b.doc).includes('Écrit par A'), 5000, 'propagation');
    a.close();
    b.close();
  });

  test('viewer connects read-only; outsiders are denied', async () => {
    const page = await createPage(admin, wid, { title: 'Consignes' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Texte officiel');
    const v = await connectCollab(srv.wsBase, page.id, viewer.cookie);
    assert.equal(v.failed, null);
    await waitFor(() => docText(v.doc).includes('Texte officiel'));
    appendParagraph(v.doc, 'Modification interdite');
    await sleep(400);
    assert.doesNotMatch(docText(a.doc), /Modification interdite/);
    await waitFor(() => readDocumentRow(page.id)?.text.includes('Texte officiel'));
    assert.doesNotMatch(readDocumentRow(page.id)!.text, /interdite/);

    const o = await connectCollab(srv.wsBase, page.id, outsider.cookie);
    assert.ok(o.failed, 'outsider must be denied');
    const anon = await connectCollab(srv.wsBase, page.id, null);
    assert.ok(anon.failed, 'anonymous must be denied on unpublished pages');
    for (const c of [a, v, o, anon]) c.close();
  });

  test('published pages are readable anonymously (read-only)', async () => {
    const root = await createPage(admin, wid, { title: 'Blog' });
    const child = await createPage(admin, wid, { parentType: 'page', parentId: root.id, title: 'Article' });
    const a = await connectCollab(srv.wsBase, child.id, admin.cookie);
    appendParagraph(a.doc, 'Contenu public');
    expectOk(await admin.post(`/pages/${root.id}/publish`, { isPublic: true }));
    const anon = await connectCollab(srv.wsBase, child.id, null);
    assert.equal(anon.failed, null);
    await waitFor(() => docText(anon.doc).includes('Contenu public'));
    appendParagraph(anon.doc, 'Graffiti');
    await sleep(400);
    assert.doesNotMatch(docText(a.doc), /Graffiti/);
    // an outsider (logged in elsewhere) also gets read-only access
    const o = await connectCollab(srv.wsBase, child.id, outsider.cookie);
    assert.equal(o.failed, null);
    a.close();
    anon.close();
    o.close();
  });

  test('snapshots: list, read and restore', async () => {
    const page = await createPage(admin, wid, { title: 'Historique' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    appendParagraph(a.doc, 'Version initiale');
    const snaps = await waitFor(async () => {
      const s = expectOk(await admin.get<SnapshotsResponse>(`/pages/${page.id}/snapshots`)).snapshots;
      return s.length > 0 ? s : null;
    }, 5000, 'first snapshot');
    assert.equal(snaps[0]!.pageId, page.id);
    assert.ok(snaps[0]!.authors.some((u) => u.email === 'admin@oriel.test'));
    const snap = expectOk(await admin.get<SnapshotResponse>(`/pages/${page.id}/snapshots/${snaps[0]!.id}`));
    const preview = new Y.Doc();
    Y.applyUpdate(preview, Buffer.from(snap.update, 'base64'));
    assert.match(docText(preview), /Version initiale/);

    appendParagraph(a.doc, 'Ajout ultérieur');
    await waitFor(() => readDocumentRow(page.id)?.text.includes('Ajout ultérieur'));
    assert.equal((await viewer.post(`/pages/${page.id}/snapshots/${snaps[0]!.id}/restore`)).status, 403);
    expectOk(await admin.post(`/pages/${page.id}/snapshots/${snaps[0]!.id}/restore`));
    await waitFor(() => !docText(a.doc).includes('Ajout ultérieur'), 5000, 'restored content propagated');
    assert.match(docText(a.doc), /Version initiale/);
    await waitFor(() => readDocumentRow(page.id)?.text === 'Version initiale', 5000, 'restored content persisted');
    const after = expectOk(await admin.get<SnapshotsResponse>(`/pages/${page.id}/snapshots`)).snapshots;
    assert.ok(after.some((s) => s.reason === 'before-restore'));
    a.close();
  });

  test('duplicating a page remaps page references inside the copied document', async () => {
    const parent = await createPage(admin, wid, { title: 'Parent' });
    const child = await createPage(admin, wid, { parentType: 'page', parentId: parent.id, title: 'Enfant' });
    const a = await connectCollab(srv.wsBase, parent.id, admin.cookie);
    appendParagraph(a.doc, 'Lien vers enfant', child.id);
    await waitFor(() => readDocumentRow(parent.id)?.text.includes('Lien vers enfant'));
    a.close();
    await sleep(50);
    const copy = expectOk(await admin.post<Page>(`/pages/${parent.id}/duplicate`));
    const tree = expectOk(await admin.get(`/workspaces/${wid}/tree`)).nodes as Array<{ id: string; parentId: string }>;
    const childCopy = tree.find((n) => n.parentId === copy.id)!;
    assert.ok(childCopy);
    const back = expectOk(await admin.get<BacklinksResponse>(`/pages/${childCopy.id}/backlinks`));
    assert.deepEqual(
      back.pages.map((p) => p.id),
      [copy.id],
    );
    const orig = expectOk(await admin.get<BacklinksResponse>(`/pages/${child.id}/backlinks`));
    assert.deepEqual(
      orig.pages.map((p) => p.id),
      [parent.id],
    );
    const c = await connectCollab(srv.wsBase, copy.id, admin.cookie);
    assert.match(docText(c.doc), new RegExp(childCopy.id));
    assert.doesNotMatch(docText(c.doc), new RegExp(child.id));
    c.close();
  });
});
