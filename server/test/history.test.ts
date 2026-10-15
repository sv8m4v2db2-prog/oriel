// Version history (G6): merged restores, chosen blocks, recovery of deleted blocks, row properties.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  newId,
  type DatabaseSchema,
  type DeletedBlocksResponse,
  type HistoryPropertiesResponse,
  type PageContentResponse,
  type RestoreBlocksResponse,
  type SnapshotsResponse,
} from '@oriel/shared';
import type { AppContext } from '../src/context.js';
import { collabContexts } from '../src/routes/collab.js';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';

interface CollabClient {
  doc: Y.Doc;
  close(): void;
}

/** Every client opened by a test, closed in `after` even when the test fails. */
const opened: CollabClient[] = [];

async function connect(wsBase: string, pageId: string, cookie: string): Promise<CollabClient> {
  class CookieWebSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie: `oriel_session=${cookie}` } });
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: CookieWebSocket });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `page:${pageId}`, document: doc });
  provider.attach();
  const client: CollabClient = {
    doc,
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
  opened.push(client);
  await waitFor(() => provider.isSynced, 5000, 'collab sync');
  return client;
}

const group = (doc: Y.Doc): Y.XmlElement => {
  const fragment = doc.getXmlFragment('blocknote');
  let g = fragment.get(0) as Y.XmlElement | undefined;
  if (!g) {
    g = new Y.XmlElement('blockGroup');
    fragment.insert(0, [g]);
  }
  return g;
};

function block(id: string, text: string): Y.XmlElement {
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', id);
  const paragraph = new Y.XmlElement('paragraph');
  const content = new Y.XmlText();
  content.insert(0, text);
  paragraph.insert(0, [content]);
  container.insert(0, [paragraph]);
  return container;
}

const findBlock = (doc: Y.Doc, id: string) => group(doc).toArray().find((c) => (c as Y.XmlElement).getAttribute('id') === id) as Y.XmlElement | undefined;
const textOf = (doc: Y.Doc, id: string) => ((findBlock(doc, id)?.get(0) as Y.XmlElement | undefined)?.get(0) as Y.XmlText | undefined)?.toString();
const ids = (doc: Y.Doc) => group(doc).toArray().map((c) => (c as Y.XmlElement).getAttribute('id'));

describe('version history (G6)', () => {
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
    const other = await setupOther(srv.base);
    outsider = other;
  });
  after(async () => {
    for (const c of opened) c.close();
    await srv.stop();
  });

  async function setupOther(base: string): Promise<Client> {
    const c = new Client(base);
    // Signup is open only for the first user: an outsider is a member of another workspace.
    const res = await admin.post<{ token: string }>(`/workspaces`, { name: 'Autre' });
    const otherWid = (res.body as { id?: string }).id;
    if (otherWid) {
      const invite = expectOk(await admin.post<{ token: string }>(`/workspaces/${otherWid}/invites`, { role: 'member' }));
      expectOk(await c.post('/auth/signup', { email: 'dehors@oriel.test', name: 'Dehors', password: 'motdepasse-solide', inviteToken: invite.token }));
    }
    return c;
  }

  /** Records the current server content of a page as a version (as the collab store would). */
  async function snapshotNow(pageId: string): Promise<string> {
    const { update } = expectOk(await admin.get<PageContentResponse>(`/pages/${pageId}/content`));
    const sid = newId();
    ctx.db.run(
      "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, '[]', 'auto')",
      sid,
      pageId,
      Buffer.from(update, 'base64'),
      Date.now() - 60_000,
    );
    return sid;
  }

  async function pageWithBlocks(title: string) {
    const page = await createPage(admin, wid, { title });
    const a = await connect(srv.wsBase, page.id, admin.cookie!);
    a.doc.transact(() => group(a.doc).insert(0, [block('b1', 'Un'), block('b2', 'Deux'), block('b3', 'Trois')]));
    await waitFor(async () => {
      const { update } = expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`));
      const d = new Y.Doc();
      Y.applyUpdate(d, Buffer.from(update, 'base64'));
      return ids(d).length === 3;
    });
    return { page, a };
  }

  test('whole restore is merged: untouched blocks keep their identity, connected editors follow', async () => {
    const { page, a } = await pageWithBlocks('Restauration fusionnée');
    const sid = await snapshotNow(page.id);
    const rootItem = group(a.doc)._item!.id;
    const b1Item = findBlock(a.doc, 'b1')!._item!.id;
    a.doc.transact(() => {
      const g = group(a.doc);
      ((findBlock(a.doc, 'b2')!.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(4, ' bis');
      g.delete(2, 1); // b3
      g.insert(g.length, [block('b4', 'Quatre')]);
    });
    await sleep(300);
    const b = await connect(srv.wsBase, page.id, member.cookie!);
    expectOk(await admin.post(`/pages/${page.id}/snapshots/${sid}/restore`));
    for (const doc of [a.doc, b.doc]) {
      await waitFor(() => ids(doc).join() === 'b1,b2,b3' && textOf(doc, 'b2') === 'Deux', 5000, 'restored everywhere');
    }
    // Editing goes on normally on both sides, without duplicates.
    ((findBlock(b.doc, 'b1')!.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(2, ' (B)');
    await waitFor(() => textOf(a.doc, 'b1') === 'Un (B)', 5000, 'edit after restore');
    assert.deepEqual(ids(a.doc), ['b1', 'b2', 'b3']);
    assert.deepEqual(group(a.doc)._item!.id, rootItem, 'root group kept');
    assert.deepEqual(findBlock(a.doc, 'b1')!._item!.id, b1Item, 'unchanged block kept');
    const snaps = expectOk(await admin.get<SnapshotsResponse>(`/pages/${page.id}/snapshots`)).snapshots;
    const restored = snaps.find((s) => s.reason === 'restore');
    assert.ok(restored, 'a restore version is recorded');
    assert.equal(restored!.restoredFrom?.id, sid);
    assert.ok(snaps.some((s) => s.reason === 'before-restore'));
    a.close();
    b.close();
  });

  test('chosen blocks: reinsert at the nearest place, revert a text, skips reported', async () => {
    const { page, a } = await pageWithBlocks('Blocs choisis');
    const sid = await snapshotNow(page.id);
    a.doc.transact(() => {
      ((findBlock(a.doc, 'b1')!.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(2, ' modifié');
      group(a.doc).delete(1, 1); // b2
      group(a.doc).insert(group(a.doc).length, [block('b5', 'Cinq')]);
    });
    await sleep(300);
    const res = expectOk(
      await admin.post<RestoreBlocksResponse>(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, {
        items: [
          { blockId: 'b2', action: 'reinsert' },
          { blockId: 'b1', action: 'revert' },
          { blockId: 'b3', action: 'reinsert' },
          { blockId: 'nope', action: 'revert' },
        ],
      }),
    );
    assert.deepEqual(res.restored, ['b2', 'b1']);
    assert.deepEqual(res.skipped, [
      { blockId: 'b3', reason: 'exists' },
      { blockId: 'nope', reason: 'not-in-version' },
    ]);
    await waitFor(() => ids(a.doc).join() === 'b1,b2,b3,b5' && textOf(a.doc, 'b1') === 'Un', 5000, 'chosen blocks restored');
    // Reinserting again does not duplicate.
    const again = expectOk(await admin.post<RestoreBlocksResponse>(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, { items: [{ blockId: 'b2', action: 'reinsert' }] }));
    assert.deepEqual(again.skipped, [{ blockId: 'b2', reason: 'exists' }]);
    await sleep(200);
    assert.equal(ids(a.doc).filter((x) => x === 'b2').length, 1);
    a.close();
  });

  test('recovery lists blocks deleted since a recent version', async () => {
    const { page, a } = await pageWithBlocks('Récupération');
    await snapshotNow(page.id);
    a.doc.transact(() => group(a.doc).delete(2, 1)); // b3
    await sleep(300);
    const list = expectOk(await admin.get<DeletedBlocksResponse>(`/pages/${page.id}/history/deleted`));
    // The collab store also records versions: the deletion may fall between two of them.
    assert.deepEqual(
      list.blocks.map((b) => [b.blockId, b.text, b.childCount]),
      [['b3', 'Trois', 0]],
    );
    assert.ok(list.scanned >= 1);
    a.close();
  });

  test('row properties are recorded and filtered by property rights', async () => {
    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Suivi' });
    const schema = expectOk(await admin.post<DatabaseSchema>(`/databases/${dbPage.id}/properties`, { property: { name: 'Note', type: 'text' } }));
    const secret = expectOk(await admin.post<DatabaseSchema>(`/databases/${dbPage.id}/properties`, { property: { name: 'Secret', type: 'text' } }));
    const noteId = schema.properties.find((p) => p.name === 'Note')!.id;
    const secretId = secret.properties.find((p) => p.name === 'Secret')!.id;
    const row = await createPage(admin, wid, { parentType: 'database', parentId: dbPage.id, title: 'Ligne' });
    const t0 = Date.now();
    await sleep(5);
    expectOk(await admin.patch(`/pages/${row.id}`, { title: 'Ligne v2', properties: { [noteId]: 'Bonjour', [secretId]: 'caché' } }));
    expectOk(await admin.put(`/databases/${dbPage.id}/properties/${secretId}/access`, { readRoles: [] }));

    const then = expectOk(await admin.get<HistoryPropertiesResponse>(`/pages/${row.id}/history/properties?at=${t0}`));
    assert.equal(then.known, true);
    assert.equal(then.title, 'Ligne');
    const now = expectOk(await member.get<HistoryPropertiesResponse>(`/pages/${row.id}/history/properties`));
    assert.equal(now.title, 'Ligne v2');
    assert.equal(now.values[noteId], 'Bonjour');
    assert.equal(secretId in now.values, false, 'hidden property absent for a member');
    const asAdmin = expectOk(await admin.get<HistoryPropertiesResponse>(`/pages/${row.id}/history/properties?at=${Date.now()}`));
    assert.equal(asAdmin.values[secretId], 'caché');
  });

  test('access: viewers 403, outsiders 404, trashed pages and bad bodies refused', async () => {
    const { page, a } = await pageWithBlocks('Droits');
    const sid = await snapshotNow(page.id);
    a.close();
    for (const url of [`/pages/${page.id}/snapshots`, `/pages/${page.id}/snapshots/${sid}`, `/pages/${page.id}/history/deleted`, `/pages/${page.id}/history/properties`]) {
      assert.equal((await viewer.get(url)).status, 403, url);
      assert.equal((await outsider.get(url)).status, 404, url);
      assert.equal((await member.get(url)).status, 200, url);
    }
    const body = { items: [{ blockId: 'b1', action: 'revert' }] };
    assert.equal((await viewer.post(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, body)).status, 403);
    assert.equal((await outsider.post(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, body)).status, 404);
    assert.equal((await outsider.post(`/pages/${page.id}/snapshots/${sid}/restore`)).status, 404);
    // A version of another page is not reachable through this one.
    const other = await createPage(admin, wid, { title: 'Autre page' });
    assert.equal((await admin.get(`/pages/${other.id}/snapshots/${sid}`)).status, 404);
    assert.equal((await admin.post(`/pages/${other.id}/snapshots/${sid}/restore-blocks`, body)).status, 404);
    for (const bad of [{}, { items: [] }, { items: [{ blockId: '../x', action: 'revert' }] }, { items: [{ blockId: 'b1', action: 'drop' }] }]) {
      assert.equal((await admin.post(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, bad)).status, 400, JSON.stringify(bad));
    }
    expectOk(await admin.post(`/pages/${page.id}/trash`));
    assert.equal((await admin.post(`/pages/${page.id}/snapshots/${sid}/restore-blocks`, body)).status, 400);
  });
});
