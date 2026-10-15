// Page content API used by workspace import / export: GET/PUT /api/pages/:pid/content.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { BacklinksResponse, PageContentResponse, SearchResponse, SnapshotsResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor, type TestServer } from './helpers.js';

// --- helpers -------------------------------------------------------------------------

/** Standalone BlockNote-shaped document: blockGroup > blockContainer > paragraph per line. */
function blocksDoc(lines: string[], opts: { mentionPageId?: string } = {}): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
    for (const line of lines) {
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', crypto.randomUUID());
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, line);
      const inline: Array<Y.XmlText | Y.XmlElement> = [text];
      if (opts.mentionPageId) {
        const mention = new Y.XmlElement('pageMention');
        mention.setAttribute('pageId', opts.mentionPageId);
        inline.push(mention);
      }
      paragraph.insert(0, inline);
      container.insert(0, [paragraph]);
      group.insert(group.length, [container]);
    }
  });
  return doc;
}

const encode = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

function docLines(doc: Y.Doc): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (node instanceof Y.XmlElement) {
      if (node.nodeName === 'paragraph') {
        out.push(
          node
            .toArray()
            .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
            .join(''),
        );
      }
      for (const c of node.toArray()) visit(c);
    }
  };
  for (const n of doc.getXmlFragment('blocknote').toArray()) visit(n);
  return out;
}

function decodeContent(body: PageContentResponse): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(body.update, 'base64'));
  return doc;
}

interface CollabClient {
  doc: Y.Doc;
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

// --- tests ---------------------------------------------------------------------------

describe('page content API (/api/pages/:pid/content)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let outsider: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'membre@oriel.test', 'Marc Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa Lectrice', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
  });
  after(async () => {
    await srv.stop();
  });

  const documentText = (pageId: string) => {
    const db = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'), { readOnly: true });
    try {
      return (db.prepare('SELECT text FROM documents WHERE page_id = ?').get(pageId) as { text: string } | undefined)?.text;
    } finally {
      db.close();
    }
  };

  test('read access: members and viewers read, others get 404/401', async () => {
    const page = await createPage(admin, wid, { title: 'Lecture' });
    // Never edited: an empty document.
    const empty = expectOk(await viewer.get<PageContentResponse>(`/pages/${page.id}/content`));
    assert.deepEqual(docLines(decodeContent(empty)), []);

    expectOk(await admin.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Bonjour'])), mode: 'replace' }));
    for (const client of [admin, member, viewer]) {
      const body = expectOk(await client.get<PageContentResponse>(`/pages/${page.id}/content`));
      assert.deepEqual(docLines(decodeContent(body)), ['Bonjour']);
    }
    assert.equal((await outsider.get(`/pages/${page.id}/content`)).status, 404);
    assert.equal((await new Client(srv.base).get(`/pages/${page.id}/content`)).status, 401);
    assert.equal((await admin.get('/pages/inconnue/content')).status, 404);

    const secret = await createPage(admin, wid, { title: 'Secret', visibility: 'private' });
    assert.equal((await member.get(`/pages/${secret.id}/content`)).status, 404);
    assert.equal((await member.put(`/pages/${secret.id}/content`, { update: encode(blocksDoc(['x'])), mode: 'replace' })).status, 404);
  });

  test('write access: viewers get 403, outsiders 404, anonymous 401', async () => {
    const page = await createPage(admin, wid, { title: 'Écriture' });
    const body = { update: encode(blocksDoc(['Interdit'])), mode: 'replace' };
    assert.equal((await viewer.put(`/pages/${page.id}/content`, body)).status, 403);
    assert.equal((await outsider.put(`/pages/${page.id}/content`, body)).status, 404);
    assert.equal((await new Client(srv.base).put(`/pages/${page.id}/content`, body)).status, 401);
    const ok = expectOk(await member.put<{ ok: true; blocks: number }>(`/pages/${page.id}/content`, body));
    assert.deepEqual(ok, { ok: true, blocks: 1 });
  });

  test('replace and append are persisted (text, search, history)', async () => {
    const page = await createPage(admin, wid, { title: 'Remplacement' });
    expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Première version', 'Ligne deux'])), mode: 'replace' }));
    assert.equal(documentText(page.id), 'Première version\nLigne deux');

    expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Ajout des morses'])), mode: 'append' }));
    assert.equal(documentText(page.id), 'Première version\nLigne deux\nAjout des morses');
    const read = expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`));
    assert.deepEqual(docLines(decodeContent(read)), ['Première version', 'Ligne deux', 'Ajout des morses']);

    expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Tout neuf sur la oriel'])), mode: 'replace' }));
    assert.equal(documentText(page.id), 'Tout neuf sur la oriel');
    const search = expectOk(await admin.get<SearchResponse>(`/workspaces/${wid}/search?q=morses`));
    assert.equal(search.results.length, 0);
    const search2 = expectOk(await admin.get<SearchResponse>(`/workspaces/${wid}/search?q=oriel`));
    assert.ok(search2.results.some((r) => r.page.id === page.id));

    // The replaced content is kept in the history.
    const snaps = expectOk(await admin.get<SnapshotsResponse>(`/pages/${page.id}/snapshots`)).snapshots;
    assert.ok(snaps.some((s) => s.reason === 'before-restore'));
  });

  test('page references written through the API feed backlinks', async () => {
    const target = await createPage(admin, wid, { title: 'Cible' });
    const source = await createPage(admin, wid, { title: 'Source' });
    expectOk(await admin.put(`/pages/${source.id}/content`, { update: encode(blocksDoc(['Voir '], { mentionPageId: target.id })), mode: 'replace' }));
    const backlinks = expectOk(await admin.get<BacklinksResponse>(`/pages/${target.id}/backlinks`));
    assert.deepEqual(
      backlinks.pages.map((p) => p.id),
      [source.id],
    );
  });

  test('connected editors see replace and append live', async () => {
    const page = await createPage(admin, wid, { title: 'En direct' });
    const a = await connectCollab(srv.wsBase, page.id, admin.cookie);
    try {
      expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Importé en direct'])), mode: 'replace' }));
      await waitFor(() => docLines(a.doc).join('|') === 'Importé en direct', 5000, 'live replace');
      expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Suite'])), mode: 'append' }));
      await waitFor(() => docLines(a.doc).join('|') === 'Importé en direct|Suite', 5000, 'live append');
      expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['Remplacé'])), mode: 'replace' }));
      await waitFor(() => docLines(a.doc).join('|') === 'Remplacé', 5000, 'live replace again');
      // The in-memory state is served while the document is open.
      const read = expectOk(await viewer.get<PageContentResponse>(`/pages/${page.id}/content`));
      assert.deepEqual(docLines(decodeContent(read)), ['Remplacé']);
    } finally {
      a.close();
    }
  });

  test('targeted merge of a current document is persisted and an unrelated history is rejected', async () => {
    const page=await createPage(admin,wid,{title:'Fusion ciblée'});
    expectOk(await admin.put(`/pages/${page.id}/content`,{update:encode(blocksDoc(['Avant'])),mode:'replace'}));
    const state=expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`));
    const copy=decodeContent(state);const group=copy.getXmlFragment('blocknote').get(0) as Y.XmlElement;
    const paragraph=(group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(5,' et après');
    expectOk(await admin.put(`/pages/${page.id}/content`,{update:encode(copy),mode:'merge'}));
    assert.deepEqual(docLines(decodeContent(expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`)))),['Avant et après']);
    assert.equal((await admin.put(`/pages/${page.id}/content`,{update:encode(blocksDoc(['Autre document'])),mode:'merge'})).status,400);
    copy.destroy();
  });

  test('validation: base64, foreign shared types, size, mode, trashed pages', async () => {
    const page = await createPage(admin, wid, { title: 'Validation' });
    const put = (body: unknown) => admin.put(`/pages/${page.id}/content`, body);
    assert.equal((await put({ update: '%%%pas du base64', mode: 'replace' })).status, 400);
    assert.equal((await put({ update: Buffer.from('nimporte quoi').toString('base64'), mode: 'replace' })).status, 400);
    assert.equal((await put({ update: encode(blocksDoc(['x'])), mode: 'merge' })).status, 400);
    assert.equal((await put({ update: encode(blocksDoc(['x'])), mode: 'invalid-mode' })).status,400);
    assert.equal((await put({ mode: 'replace' })).status, 400);

    const evil = blocksDoc(['ok']);
    evil.getMap('threads').set('x', 'pirate');
    const res = await put({ update: encode(evil), mode: 'replace' });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /blocknote/);

    // > 10 MB once decoded, within the HTTP body limit → 413 from the validator.
    const tooBig = 'A'.repeat(Math.ceil(((10 * 1024 * 1024 + 300) * 4) / 3 / 4) * 4);
    assert.equal((await put({ update: tooBig, mode: 'replace' })).status, 413);
    // Beyond the HTTP body limit → 413 too (the server may reset the upload once it has answered).
    const huge = await put({ update: 'A'.repeat(15 * 1024 * 1024), mode: 'replace' }).then(
      (r) => r.status,
      () => 'reset' as const,
    );
    assert.ok(huge === 413 || huge === 'reset', String(huge));

    // Nothing was written by refused requests.
    const read = expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`));
    assert.deepEqual(docLines(decodeContent(read)), []);

    // An empty document clears the page.
    expectOk(await put({ update: encode(blocksDoc(['À effacer'])), mode: 'replace' }));
    expectOk(await put({ update: encode(new Y.Doc()), mode: 'replace' }));
    assert.equal(documentText(page.id), '');

    expectOk(await admin.post(`/pages/${page.id}/trash`));
    assert.equal((await put({ update: encode(blocksDoc(['x'])), mode: 'replace' })).status, 400);
  });
});
