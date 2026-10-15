import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { BacklinksResponse, DatabaseResponse, Page, View } from '@oriel/shared';
import { Client, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

async function connectCollab(wsBase: string, pageId: string, cookie: string | null) {
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

function appendLinkedBlock(doc: Y.Doc, databaseId: string, linkId: string): void {
  const fragment = doc.getXmlFragment('blocknote');
  doc.transact(() => {
    let group = fragment.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement('blockGroup');
      fragment.insert(0, [group]);
    }
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', crypto.randomUUID());
    const block = new Y.XmlElement('linkedDatabase');
    block.setAttribute('databaseId', databaseId);
    block.setAttribute('linkId', linkId);
    container.insert(0, [block]);
    group.insert(group.length, [container]);
  });
}

function linkedBlocks(doc: Y.Doc): Array<{ databaseId: string; linkId: string }> {
  const out: Array<{ databaseId: string; linkId: string }> = [];
  const walk = (nodes: Array<Y.XmlElement | Y.XmlText | Y.XmlHook>) => {
    for (const n of nodes) {
      if (!(n instanceof Y.XmlElement)) continue;
      if (n.nodeName === 'linkedDatabase') out.push({ databaseId: String(n.getAttribute('databaseId')), linkId: String(n.getAttribute('linkId')) });
      walk(n.toArray());
    }
  };
  walk(doc.getXmlFragment('blocknote').toArray());
  return out;
}

describe('linked database blocks', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  test('duplicating the host page gives the copied block its own views', async () => {
    const source = await createPage(admin, wid, { kind: 'database', title: 'Source', emptyDatabase: true });
    const host = await createPage(admin, wid, { title: 'Hôte' });
    const linkId = crypto.randomUUID();
    const first = expectOk(await admin.get<DatabaseResponse>(`/databases/${source.id}?linkId=${linkId}`)).views;
    expectOk(await admin.post<View>(`/databases/${source.id}/views`, { name: 'Planning', type: 'timeline', linkId }));

    const a = await connectCollab(srv.wsBase, host.id, admin.cookie);
    appendLinkedBlock(a.doc, source.id, linkId);
    // The block is a page reference: the backlink shows once the document is stored.
    await waitFor(async () => expectOk(await admin.get<BacklinksResponse>(`/pages/${source.id}/backlinks`)).pages.some((p) => p.id === host.id));
    a.close();
    await sleep(50);

    const copy = expectOk(await admin.post<Page>(`/pages/${host.id}/duplicate`));
    const c = await connectCollab(srv.wsBase, copy.id, admin.cookie);
    const blocks = linkedBlocks(c.doc);
    c.close();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.databaseId, source.id);
    assert.notEqual(blocks[0]!.linkId, linkId);
    const copied = expectOk(await admin.get<DatabaseResponse>(`/databases/${source.id}?linkId=${blocks[0]!.linkId}`)).views;
    assert.deepEqual(
      copied.map((v) => [v.name, v.type]),
      [
        [first[0]!.name, 'table'],
        ['Planning', 'timeline'],
      ],
    );
    assert.ok(copied.every((v) => v.linkId === blocks[0]!.linkId));
    // The original block keeps its own views.
    const original = expectOk(await admin.get<DatabaseResponse>(`/databases/${source.id}?linkId=${linkId}`)).views;
    assert.equal(original.length, 2);
    assert.ok(original.every((v) => !copied.some((x) => x.id === v.id)));
  });
});
