// Tags and collections tools (wave H3): read only, access-checked by the API.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, connectMcp, createPage, createToken, expectOk, setupAdmin, startTestServer, type HttpClient, type Mcp, type TestServer } from './helpers.js';

describe('MCP organize tools', () => {
  let srv: TestServer;
  let admin: HttpClient;
  let wid: string;
  let alice: Mcp;
  let bob: Mcp;
  let aliceRead: Mcp;
  let tagId: string;
  let sharedId: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    const { client: bobClient } = await addMember(admin, wid, 'bob@oriel.test', 'Bob', 'member');
    alice = await connectMcp(srv.base, (await createToken(admin, { name: 'Alice', scope: 'write' })).token);
    aliceRead = await connectMcp(srv.base, (await createToken(admin, { name: 'Alice lecture', scope: 'read' })).token);
    bob = await connectMcp(srv.base, (await createToken(bobClient, { name: 'Bob', scope: 'read' })).token);
    tagId = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/tags`, { name: 'Épisode', color: 'blue' }), 201).id;
    const shared = await createPage(admin, wid, { title: 'Scénario' });
    const secret = await createPage(admin, wid, { title: 'Carnet privé', visibility: 'private' });
    sharedId = shared.id;
    for (const p of [shared, secret]) expectOk(await admin.put(`/pages/${p.id}/tags`, { tagIds: [tagId] }));
    expectOk(await admin.post(`/workspaces/${wid}/collections`, { name: 'À relire', rules: { match: 'all', conditions: [{ type: 'tag', op: 'any', tagIds: [tagId] }] } }), 201);
  });
  after(async () => {
    await alice?.close();
    await aliceRead?.close();
    await bob?.close();
    await srv?.stop();
  });

  test('lists tags with the count of pages visible to the token', async () => {
    const a = await alice.json('oriel_list_tags');
    assert.equal(a.tags[0].nom, 'Épisode');
    assert.equal(a.tags[0].pages, 2);
    assert.equal((await bob.json('oriel_list_tags')).tags[0].pages, 1);
  });

  test('lists collections and their pages, per viewer, with a read-only token', async () => {
    const list = await aliceRead.json('oriel_list_collections');
    assert.equal(list.collections[0].nom, 'À relire');
    const mine = await aliceRead.json('oriel_query_pages', { collection: 'a relire' });
    assert.equal(mine.total, 2);
    const theirs = await bob.json('oriel_query_pages', { collection: list.collections[0].id });
    assert.equal(theirs.total, 1);
    assert.equal(theirs.pages[0].id, sharedId);
    assert.deepEqual(theirs.pages[0].tags, ['Épisode']);
  });

  test('pages by tag name, unknown names are errors, read-only annotations', async () => {
    const r = await bob.json('oriel_query_pages', { tag: 'episode' });
    assert.deepEqual(r.pages.map((p: { titre: string }) => p.titre), ['Scénario']);
    const err = await bob.call('oriel_query_pages', { tag: 'Inconnu' }, { allowError: true });
    assert.equal(err.isError, true);
    const { tools } = await alice.client.listTools();
    for (const n of ['oriel_list_tags', 'oriel_list_collections', 'oriel_query_pages']) {
      assert.equal(tools.find((t) => t.name === n)!.annotations?.readOnlyHint, true, n);
    }
  });
});
