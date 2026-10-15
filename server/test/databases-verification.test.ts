// Verification property (D21, SPEC §5.9): stamped by the server, editors only, fixed derived states.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSchema, Page, PageDetailResponse, VerificationValue } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('databases: verification property (D21)', () => {
  let srv: TestServer;
  let admin: Client;
  let member: Client;
  let viewer: Client;
  let wid: string;
  let adminId: string;
  let memberId: string;
  let did: string;
  let prop: string;
  let row: Page;

  before(async () => {
    srv = await startTestServer();
    let session;
    ({ admin, wid, session } = await setupAdmin(srv.base));
    adminId = session.user.id;
    let user;
    ({ client: member, user } = await addMember(admin, wid, 'verif-membre@oriel.test', 'Max', 'member'));
    memberId = user.id;
    ({ client: viewer } = await addMember(admin, wid, 'verif-lecteur@oriel.test', 'Lise', 'viewer'));
    did = (await createPage(admin, wid, { kind: 'database', title: 'Wiki', emptyDatabase: true })).id;
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name: 'Vérifiée', type: 'verification' } }));
    const def = s.properties.find((p) => p.name === 'Vérifiée')!;
    prop = def.id;
    assert.deepEqual(
      def.options?.map((o) => o.id),
      ['verified', 'expired'],
      'fixed derived states, used by filters and sorts',
    );
    row = expectOk(await admin.post<Page>(`/databases/${did}/rows`, { title: 'Procédure' }));
  });
  after(() => srv.stop());

  test('the server stamps the writer and the time, whatever the client sends', async () => {
    const before = Date.now();
    const res = expectOk(
      await member.patch<Page>(`/pages/${row.id}`, {
        properties: { [prop]: { verifiedBy: adminId, verifiedAt: '2001-01-01T00:00:00Z', expiresAt: '2027-01-15' } },
      }),
    );
    const v = res.properties[prop] as VerificationValue;
    assert.equal(v.verifiedBy, memberId);
    assert.ok(Date.parse(v.verifiedAt) >= before - 1000);
    assert.equal(v.expiresAt, '2027-01-15');
  });

  test('no expiry, invalid expiry, removal', async () => {
    const v = expectOk(await admin.patch<Page>(`/pages/${row.id}`, { properties: { [prop]: { expiresAt: null } } })).properties[prop] as VerificationValue;
    assert.equal(v.expiresAt, null);
    assert.equal(v.verifiedBy, adminId);
    for (const bad of ['2027-02-30', 'demain', 12, ['x']]) {
      assert.equal((await admin.patch(`/pages/${row.id}`, { properties: { [prop]: { expiresAt: bad } } })).status, 400, String(bad));
    }
    assert.equal((await admin.patch(`/pages/${row.id}`, { properties: { [prop]: 'verified' } })).status, 400);
    expectOk(await admin.patch(`/pages/${row.id}`, { properties: { [prop]: null } }));
    const detail = expectOk(await admin.get<PageDetailResponse>(`/pages/${row.id}`));
    assert.equal(detail.page.properties[prop], undefined);
  });

  test('readers cannot verify', async () => {
    assert.equal((await viewer.patch(`/pages/${row.id}`, { properties: { [prop]: { expiresAt: null } } })).status, 403);
  });

  test('options cannot be changed', async () => {
    const s = expectOk(
      await admin.patch<DatabaseSchema>(`/databases/${did}/properties/${prop}`, { options: [{ name: 'Autre', color: 'red' }] }),
    );
    assert.deepEqual(
      s.properties.find((p) => p.id === prop)!.options?.map((o) => o.id),
      ['verified', 'expired'],
    );
  });
});
