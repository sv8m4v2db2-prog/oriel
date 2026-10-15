// QA (audit de sécurité) — cœur : fusion contrôlée de l'API de contenu (`mode: 'merge'`), marqueurs
// de navigation (`teamspaceRoot`, `sharedShortcut`), verrouillage. Instance jetable en processus
// (127.0.0.1, port 0). Voir docs/QA-REPORT.md.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, type PageContentResponse, type SnapshotsResponse, type TreeResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

const encode = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

function blocksDoc(lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement('blockGroup');
  group.insert(
    0,
    lines.map((line, i) => {
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', `b${i}`);
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, line);
      paragraph.insert(0, [text]);
      container.insert(0, [paragraph]);
      return container;
    }),
  );
  doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group]);
  return doc;
}

/** Copy of the page's current document (same CRDT history), optionally with a fixed client id. */
async function serverCopy(client: Client, pageId: string, clientID?: number): Promise<Y.Doc> {
  const { update } = expectOk(await client.get<PageContentResponse>(`/pages/${pageId}/content`));
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  Y.applyUpdate(doc, Buffer.from(update, 'base64'));
  return doc;
}

const rootGroup = (doc: Y.Doc) => doc.getXmlFragment(COLLAB_FRAGMENT).get(0) as Y.XmlElement;
const textOf = (doc: Y.Doc) => rootGroup(doc).toArray().map((c) => ((c as Y.XmlElement).get(0) as Y.XmlElement).get(0)?.toString() ?? '');

describe('QA core — API de contenu, fusion contrôlée', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'core-membre@oriel.test', 'Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'core-lecteur@oriel.test', 'Lecteur', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  async function pageWith(lines: string[], visibility: 'workspace' | 'private' = 'workspace', owner = admin) {
    const page = await createPage(owner, wid, { title: 'Fusion', visibility });
    expectOk(await owner.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(lines)), mode: 'replace' }));
    return page;
  }

  test('QA-CORE-01: merge requires edit rights, a live page, the same document, and stays in its workspace', async () => {
    const page = await pageWith(['Un', 'Deux']);
    const copy = await serverCopy(admin, page.id);
    (rootGroup(copy).get(0) as Y.XmlElement).setAttribute('textColor', 'red');
    const body = { update: encode(copy), mode: 'merge' };
    assert.equal((await viewer.put(`/pages/${page.id}/content`, body)).status, 403);
    assert.equal((await new Client(srv.base).put(`/pages/${page.id}/content`, body)).status, 401);
    // A private page of someone else: invisible.
    const secret = await pageWith(['Secret'], 'private');
    assert.equal((await member.put(`/pages/${secret.id}/content`, { update: encode(await serverCopy(admin, secret.id)), mode: 'merge' })).status, 404);
    // A copy of ANOTHER document cannot be merged (would graft a second root group).
    const other = await pageWith(['Autre']);
    assert.equal((await member.put(`/pages/${page.id}/content`, { update: encode(await serverCopy(admin, other.id)), mode: 'merge' })).status, 400);
    // A fresh document (another history) neither.
    assert.equal((await member.put(`/pages/${page.id}/content`, { update: encode(blocksDoc(['x'])), mode: 'merge' })).status, 400);
    expectOk(await member.put(`/pages/${page.id}/content`, body));
    const after = await serverCopy(admin, page.id);
    assert.equal((rootGroup(after).get(0) as Y.XmlElement).getAttribute('textColor'), 'red');
    // Trashed page: read-only.
    expectOk(await admin.post(`/pages/${page.id}/trash`));
    assert.equal((await member.put(`/pages/${page.id}/content`, body)).status, 400);
    copy.destroy();
    after.destroy();
  });

  test('QA-CORE-02: a forged merge reusing ids of the history cannot put blocks inside a text', async () => {
    const page = await pageWith(['Base']);
    const { update: before } = expectOk(await admin.get<PageContentResponse>(`/pages/${page.id}/content`));
    // Step 1 — client 4242 adds a text node directly in the root group: (4242,0) is a Y.XmlText
    // and (4242,1) the character 'x'. Valid for the guard (texts are allowed in elements): accepted.
    const a = await serverCopy(admin, page.id, 4242);
    const t = new Y.XmlText();
    rootGroup(a).insert(rootGroup(a).length, [t]);
    t.insert(0, 'x');
    const first = await member.put(`/pages/${page.id}/content`, { update: encode(a), mode: 'merge' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // Step 2 — a copy of the state BEFORE step 1 reuses the client id 4242: (4242,0) and (4242,1) are
    // elements there, and (4242,2) a third element placed after (4242,1). Alone it is a valid XML tree
    // (decodeContentUpdate accepts it); on the server (4242,1) is the character 'x', so Yjs would
    // integrate the new element INSIDE the text node.
    const b = new Y.Doc();
    b.clientID = 4242;
    Y.applyUpdate(b, Buffer.from(before, 'base64'));
    const outer = new Y.XmlElement('blockContainer');
    const inner = new Y.XmlElement('paragraph');
    const third = new Y.XmlElement('paragraph');
    outer.insert(0, [inner, third]);
    rootGroup(b).insert(rootGroup(b).length, [outer]);
    assert.deepEqual([outer, inner, third].map((n) => [n._item!.id.client, n._item!.id.clock]), [[4242, 0], [4242, 1], [4242, 2]]);
    const res = await member.put(`/pages/${page.id}/content`, { update: encode(b), mode: 'merge' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    // Nothing was integrated in the text node.
    const now = await serverCopy(admin, page.id);
    const texts = rootGroup(now).toArray().filter((n) => n instanceof Y.XmlText) as Y.XmlText[];
    assert.equal(texts.length, 1);
    assert.equal(texts[0]!.toString(), 'x');
    assert.equal(texts[0]!.length, 1);
    a.destroy();
    b.destroy();
    now.destroy();
  });

  test('QA-CORE-03: a merge that deletes existing content keeps the previous version (before-restore snapshot)', async () => {
    const page = await pageWith(['Paragraphe un', 'Paragraphe deux', 'Paragraphe trois']);
    const snapshots = async () => expectOk(await admin.get<SnapshotsResponse>(`/pages/${page.id}/snapshots`)).snapshots.filter((s) => s.reason === 'before-restore').length;
    const initial = await snapshots();
    // A targeted, non-destructive edit (an attribute): no snapshot needed.
    const edit = await serverCopy(admin, page.id);
    (rootGroup(edit).get(1) as Y.XmlElement).setAttribute('backgroundColor', 'blue');
    expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(edit), mode: 'merge' }));
    assert.equal(await snapshots(), initial);
    // A merge deleting blocks (a stale or buggy script): the previous content must stay restorable.
    const wipe = await serverCopy(admin, page.id);
    rootGroup(wipe).delete(0, rootGroup(wipe).length);
    expectOk(await member.put(`/pages/${page.id}/content`, { update: encode(wipe), mode: 'merge' }));
    const now = await serverCopy(admin, page.id);
    assert.equal(rootGroup(now).length, 0);
    assert.equal(await snapshots(), initial + 1);
    edit.destroy();
    wipe.destroy();
    now.destroy();
  });

  test('QA-CORE-04: merge refuses non-XML content and foreign root types before applying', async () => {
    const page = await pageWith(['Conservé']);
    const withMap = await serverCopy(admin, page.id);
    rootGroup(withMap).insert(0, [new Y.XmlElement('blockContainer')]);
    (rootGroup(withMap).get(0) as Y.XmlElement).setAttribute('evil', new Y.Map() as never);
    assert.equal((await member.put(`/pages/${page.id}/content`, { update: encode(withMap), mode: 'merge' })).status, 400);
    const foreign = await serverCopy(admin, page.id);
    foreign.getMap('autre').set('x', 1);
    assert.equal((await member.put(`/pages/${page.id}/content`, { update: encode(foreign), mode: 'merge' })).status, 400);
    const now = await serverCopy(admin, page.id);
    assert.deepEqual(textOf(now), ['Conservé']);
    assert.deepEqual([...now.share.keys()], [COLLAB_FRAGMENT]);
    withMap.destroy();
    foreign.destroy();
    now.destroy();
  });

  test('QA-CORE-05: an API token restricted to another workspace cannot write page content', async () => {
    const page = await pageWith(['Espace A']);
    const other = expectOk(await admin.post<{ id: string }>('/workspaces', { name: 'Espace B' }));
    const created = expectOk(await admin.post<{ token: string }>('/me/tokens', { name: 'b', scope: 'write', workspaceId: other.id }));
    const res = await fetch(`${srv.base}/api/pages/${page.id}/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ update: encode(await serverCopy(admin, page.id)), mode: 'merge' }),
    });
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });

  test('QA-CORE-06 (écarté): the page lock is a UI guard, not a permission — editors may unlock it', async () => {
    const page = await pageWith(['Verrouillé']);
    expectOk(await admin.patch(`/pages/${page.id}`, { format: { locked: true } }));
    // An editor can unlock through the regular API: writing the content of a locked page through the
    // content API or /collab is therefore no privilege escalation.
    expectOk(await member.patch(`/pages/${page.id}`, { format: { locked: false } }));
    assert.equal((await viewer.patch(`/pages/${page.id}`, { format: { locked: false } })).status, 403);
  });
});

describe('QA core — marqueurs de navigation', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'nav-membre@oriel.test', 'Membre', 'member'));
  });
  after(async () => {
    await srv.stop();
  });

  test("QA-CORE-07: shortcut / teamspace markers never reveal someone else's private, trashed or foreign page", async () => {
    const mine = await createPage(admin, wid, { title: 'Brouillon secret', icon: '🔒', visibility: 'private' });
    expectOk(await admin.patch(`/pages/${mine.id}`, { format: { sharedShortcut: true, teamspaceRoot: true } }));
    const shared = await createPage(admin, wid, { title: 'Équipe', visibility: 'workspace' });
    expectOk(await admin.patch(`/pages/${shared.id}`, { format: { sharedShortcut: true, teamspaceRoot: true } }));
    const trashed = await createPage(admin, wid, { title: 'Jeté', visibility: 'workspace' });
    expectOk(await admin.patch(`/pages/${trashed.id}`, { format: { sharedShortcut: true } }));
    expectOk(await admin.post(`/pages/${trashed.id}/trash`));

    const tree = expectOk(await member.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert(!tree.some((n) => n.id === mine.id || n.title === 'Brouillon secret'));
    assert(!tree.some((n) => n.id === trashed.id));
    assert.equal(tree.find((n) => n.id === shared.id)?.isSharedShortcut, true);
    assert.equal(tree.find((n) => n.id === shared.id)?.isTeamspace, true);
    // The private page keeps its markers for its owner only, and is never a teamspace.
    const own = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert.equal(own.find((n) => n.id === mine.id)?.isTeamspace, undefined);
    // Search and the private page itself stay invisible.
    const search = expectOk(await member.get<{ results: Array<{ id: string }> }>(`/workspaces/${wid}/search?q=Brouillon`));
    assert(!JSON.stringify(search).includes(mine.id));
    assert.equal((await member.get(`/pages/${mine.id}`)).status, 404);
    // Nobody can set a marker on a page they cannot see (forged id) or from another workspace.
    assert.equal((await member.patch(`/pages/${mine.id}`, { format: { sharedShortcut: false } })).status, 404);
    // A page becoming private drops out of everyone else's navigation, markers included.
    expectOk(await admin.post(`/pages/${shared.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    const later = expectOk(await member.get<TreeResponse>(`/workspaces/${wid}/tree`)).nodes;
    assert(!later.some((n) => n.id === shared.id));
  });

  test('QA-CORE-09: only workspace managers turn a shared page into a teamspace (workspace-wide navigation)', async () => {
    // User decision (2026-10-15): only workspace owners/admins turn a page into a teamspace.
    const page = await createPage(admin, wid, { title: 'Équipe B', visibility: 'workspace' });
    assert.equal((await member.patch(`/pages/${page.id}`, { format: { teamspaceRoot: true } })).status, 403);
    // Other format changes stay open to editors; the marker itself is untouched.
    expectOk(await member.patch(`/pages/${page.id}`, { format: { fullWidth: true } }));
    expectOk(await admin.patch(`/pages/${page.id}`, { format: { teamspaceRoot: true } }));
    // Removing the marker is the same decision.
    assert.equal((await member.patch(`/pages/${page.id}`, { format: { teamspaceRoot: false } })).status, 403);
    // Sending the current value is not a change.
    expectOk(await member.patch(`/pages/${page.id}`, { format: { teamspaceRoot: true, smallText: true } }));
  });
});
