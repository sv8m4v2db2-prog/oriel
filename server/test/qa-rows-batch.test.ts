// QA of the batched row updates of the table grid (SPEC §5.10, vague G2): access, scope, size,
// validation and atomicity. Findings are tagged QA-GRID-xx.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchUpdateRowsResponse, DatabaseSchema, Page, PropertyDef, RowsResponse, SessionResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('qa: rows batch (grid)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let viewer: Client;
  let outsider: Client;
  let did: string;
  let props: PropertyDef[];
  let rows: Page[];

  const byName = (name: string) => props.find((p) => p.name === name)!.id;
  const batch = (c: Client, db: string, updates: unknown) => c.post<BatchUpdateRowsResponse>(`/databases/${db}/rows/batch`, { updates });
  const rowsOf = async (db: string) => expectOk(await admin.get<RowsResponse>(`/databases/${db}/rows`)).rows;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    ({ client: member } = await addMember(admin, wid, 'grille-membre@oriel.test', 'Marc', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'grille-lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'grille-dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    did = (await createPage(admin, wid, { kind: 'database', title: 'Grille', emptyDatabase: true })).id;
    for (const property of [
      { name: 'Budget', type: 'number' },
      { name: 'Étape', type: 'select', options: [{ id: 'o1', name: 'Fini', color: 'green' }] },
      { name: 'Calcul', type: 'formula', formula: 'prop("Budget") * 2' },
    ]) {
      props = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties;
    }
    for (const title of ['A', 'B', 'C']) expectOk(await admin.post<Page>(`/databases/${did}/rows`, { title }));
    rows = await rowsOf(did);
  });
  after(async () => {
    await srv.stop();
  });

  test('a member writes several rows in one call', async () => {
    const budget = byName('Budget');
    const res = expectOk(
      await batch(member, did, [
        { id: rows[0]!.id, title: 'A2', properties: { [budget]: 10 } },
        { id: rows[1]!.id, properties: { [budget]: 20, [byName('Étape')]: 'o1' } },
        { id: rows[2]!.id, properties: { [budget]: null } },
      ]),
    );
    assert.equal(res.updated, 3);
    const after = await rowsOf(did);
    const get = (id: string) => after.find((r) => r.id === id)!;
    assert.equal(get(rows[0]!.id).title, 'A2');
    assert.equal(get(rows[0]!.id).properties[budget], 10);
    assert.equal(get(rows[1]!.id).properties[byName('Étape')], 'o1');
    assert.equal(get(rows[2]!.id).properties[budget], undefined);
  });

  test('QA-GRID-01: outsiders get 404, readers cannot write', async () => {
    const u = [{ id: rows[0]!.id, properties: { [byName('Budget')]: 1 } }];
    assert.equal((await batch(outsider, did, u)).status, 404);
    assert.equal((await batch(viewer, did, u)).status, 403);
    assert.equal((await batch(new Client(srv.base), did, u)).status, 401);
  });

  test('QA-GRID-02: a row of another database (or a non-row page) is invisible → 404, nothing written', async () => {
    const other = (await createPage(admin, wid, { kind: 'database', title: 'Autre', emptyDatabase: true })).id;
    const foreign = expectOk(await admin.post<Page>(`/databases/${other}/rows`, { title: 'Étrangère' }));
    const page = await createPage(admin, wid, { title: 'Simple page' });
    for (const id of [foreign.id, page.id, did, '00000000-0000-0000-0000-000000000000']) {
      const res = await batch(member, did, [
        { id: rows[1]!.id, title: 'ne doit pas rester' },
        { id, title: 'piratée' },
      ]);
      assert.equal(res.status, 404, id);
    }
    const after = await rowsOf(did);
    assert.notEqual(after.find((r) => r.id === rows[1]!.id)!.title, 'ne doit pas rester', 'all or nothing');
    assert.equal((await rowsOf(other))[0]!.title, 'Étrangère');
  });

  test('QA-GRID-03: values are validated, computed properties refused, atomically', async () => {
    const before = await rowsOf(did);
    const budget = byName('Budget');
    for (const bad of [
      { [budget]: 'pas un nombre' },
      { [byName('Étape')]: 'option-inconnue' },
      { [byName('Calcul')]: 3 },
      { inconnue: 1 },
    ]) {
      const res = await batch(member, did, [
        { id: rows[0]!.id, properties: { [budget]: 999 } },
        { id: rows[1]!.id, properties: bad },
      ]);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(
      (await rowsOf(did)).map((r) => r.properties[budget]),
      before.map((r) => r.properties[budget]),
      'nothing written',
    );
  });

  test('QA-GRID-04: request size is bounded', async () => {
    const many = Array.from({ length: 501 }, () => ({ id: rows[0]!.id, title: 'x' }));
    assert.equal((await batch(member, did, many)).status, 400);
    assert.equal((await batch(member, did, [])).status, 400);
    assert.equal((await batch(member, did, [{ id: rows[0]!.id, extra: true }])).status, 400);
  });

  test('QA-GRID-05: a trashed row is invisible', async () => {
    const r = expectOk(await admin.post<Page>(`/databases/${did}/rows`, { title: 'À jeter' }));
    expectOk(await admin.post(`/pages/${r.id}/trash`, {}));
    assert.equal((await batch(member, did, [{ id: r.id, title: 'ressuscitée' }])).status, 404);
  });
  test('QA-GRID-06: per-property rights (§5.9) apply to every row of the batch', async () => {
    const budget = byName('Budget');
    expectOk(await admin.put(`/databases/${did}/properties/${budget}/access`, { editRoles: [] }));
    assert.equal((await batch(member, did, [{ id: rows[0]!.id, properties: { [budget]: 5 } }])).status, 403);
    expectOk(await admin.put(`/databases/${did}/properties/${budget}/access`, { readRoles: [], editRoles: null }));
    assert.equal((await batch(member, did, [{ id: rows[0]!.id, properties: { [budget]: 5 } }])).status, 400);
    expectOk(await batch(admin, did, [{ id: rows[0]!.id, properties: { [budget]: 5 } }]));
    expectOk(await admin.put(`/databases/${did}/properties/${budget}/access`, { readRoles: null, editRoles: null }));
  });
});
