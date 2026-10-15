// Security review, wave G: row actions of the button block (QA-EDT-05). A button runs « Ajouter une
// ligne » / « Modifier des lignes » with the rights of whoever clicks it, while its target database comes
// from the page's shared document. The clicker's client names the page of the button (`viaButtonOn`):
// the server then refuses a database whose audience is narrower than that page's (user decision, 15/10).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, RowsResponse, WorkspaceSummary } from '@oriel/shared';
import { addMember, createPage, expectOk, setupAdmin, startTestServer, type Client, type TestServer } from './helpers.js';

describe('qa: button row actions (QA-EDT-05)', () => {
  let srv: TestServer;
  let admin: Client;
  let bob: Client; // clicks the buttons
  let carol: Client; // a colleague who writes the buttons
  let wid: string;
  let bobDb: string; // Bob's private database
  let bobRow: string;
  let sharedDb: string;
  let sharedRow: string;
  let sharedPage: string; // Carol's page, shared with the workspace
  let bobPage: string; // Bob's private page
  let carolPrivate: string;
  let teamDb: string; // database of a private teamspace (Bob is a member)
  let teamRow: string;
  let teamPage: string;
  let otherWsPage: string; // Bob's page of another workspace

  const addRow = (c: Client, did: string, via?: string) =>
    c.post<Page>(`/databases/${did}/rows`, { title: 'Ajoutée par un bouton', ...(via ? { viaButtonOn: via } : {}) });
  const editRows = (c: Client, did: string, row: string, via?: string) =>
    c.post(`/databases/${did}/rows/batch`, { updates: [{ id: row, title: 'Modifiée par un bouton' }], ...(via ? { viaButtonOn: via } : {}) });
  const rowCount = async (c: Client, did: string) => expectOk(await c.get<RowsResponse>(`/databases/${did}/rows`)).rows.length;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    let bobUser;
    ({ client: bob, user: bobUser } = await addMember(admin, wid, 'bouton-bob@oriel.test', 'Bob', 'member'));
    ({ client: carol } = await addMember(admin, wid, 'bouton-carol@oriel.test', 'Carol', 'member'));

    bobDb = (await createPage(bob, wid, { kind: 'database', title: 'Mes comptes', visibility: 'private', emptyDatabase: true })).id;
    bobRow = expectOk(await bob.post<Page>(`/databases/${bobDb}/rows`, { title: 'Loyer' })).id;
    sharedDb = (await createPage(admin, wid, { kind: 'database', title: 'Planning', emptyDatabase: true })).id;
    sharedRow = expectOk(await admin.post<Page>(`/databases/${sharedDb}/rows`, { title: 'Cadrage' })).id;
    sharedPage = (await createPage(carol, wid, { title: 'Page avec bouton' })).id;
    bobPage = (await createPage(bob, wid, { title: 'Mes boutons', visibility: 'private' })).id;
    carolPrivate = (await createPage(carol, wid, { title: 'Brouillon de Carol', visibility: 'private' })).id;

    const rh = await createPage(admin, wid, { title: 'RH', visibility: 'private' });
    expectOk(await admin.post(`/pages/${rh.id}/teamspace`, { access: 'private' }));
    expectOk(await admin.put(`/teamspaces/${rh.id}/members/${bobUser.id}`, { role: 'member' }));
    const db = await createPage(bob, wid, { kind: 'database', title: 'Salaires', parentType: 'page', parentId: rh.id, emptyDatabase: true });
    assert.equal(db.visibility, 'teamspace');
    teamDb = db.id;
    teamRow = expectOk(await bob.post<Page>(`/databases/${teamDb}/rows`, { title: 'Bob' })).id;
    teamPage = (await createPage(bob, wid, { title: 'Boutons RH', parentType: 'page', parentId: rh.id })).id;

    const other = expectOk(await bob.post<WorkspaceSummary>('/workspaces', { name: 'Perso' }));
    otherWsPage = (await createPage(bob, other.id, { title: 'Ailleurs' })).id;
  });
  after(async () => {
    await srv.stop();
  });

  test('QA-EDT-05: a button of a shared page cannot add or change rows of the clicker’s private database', async () => {
    const before = await rowCount(bob, bobDb);
    const add = await addRow(bob, bobDb, sharedPage);
    assert.equal(add.status, 403);
    assert.match(String((add.body as unknown as { error?: { message?: string } }).error?.message), /base privée/);
    assert.equal((await editRows(bob, bobDb, bobRow, sharedPage)).status, 403);
    assert.equal(await rowCount(bob, bobDb), before);
    const rows = expectOk(await bob.get<RowsResponse>(`/databases/${bobDb}/rows`)).rows;
    assert.equal(rows.find((r) => r.id === bobRow)?.title, 'Loyer');
  });

  test('QA-EDT-05: the same button on the clicker’s own private page may write to his private database', async () => {
    expectOk(await addRow(bob, bobDb, bobPage));
    expectOk(await editRows(bob, bobDb, bobRow, bobPage));
  });

  test('QA-EDT-05: a shared database from a shared (or private) page is allowed', async () => {
    expectOk(await addRow(bob, sharedDb, sharedPage));
    expectOk(await editRows(bob, sharedDb, sharedRow, sharedPage));
    expectOk(await addRow(bob, sharedDb, bobPage));
  });

  test('QA-EDT-05: a database of a restricted teamspace only from a page of that teamspace (or the clicker’s private page)', async () => {
    assert.equal((await addRow(bob, teamDb, sharedPage)).status, 403);
    assert.equal((await editRows(bob, teamDb, teamRow, sharedPage)).status, 403);
    expectOk(await addRow(bob, teamDb, teamPage));
    expectOk(await editRows(bob, teamDb, teamRow, teamPage));
    expectOk(await addRow(bob, teamDb, bobPage));
    // A page of the teamspace may not reach Bob's private database either.
    assert.equal((await addRow(bob, bobDb, teamPage)).status, 403);
  });

  test('QA-EDT-05: a host page invisible to the clicker, unknown or of another workspace → 404', async () => {
    for (const via of [carolPrivate, otherWsPage, '00000000-0000-0000-0000-000000000000']) {
      assert.equal((await addRow(bob, sharedDb, via)).status, 404, via);
      assert.equal((await editRows(bob, sharedDb, sharedRow, via)).status, 404, via);
    }
    assert.equal((await addRow(bob, sharedDb, '../x')).status, 400);
  });

  test('QA-EDT-05: requests without the field (ordinary editing) are unchanged', async () => {
    expectOk(await addRow(bob, bobDb));
    expectOk(await editRows(bob, bobDb, bobRow));
    expectOk(await addRow(carol, sharedDb));
    assert.equal((await addRow(carol, bobDb)).status, 404);
  });
});
