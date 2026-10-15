// Renaming a property rewrites the formulas citing it in the same transaction: the interface, the
// REST API with a token and the MCP all go through PATCH …/properties.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreatedApiToken, DatabaseResponse, DatabaseSchema, PropertyDef } from '@oriel/shared';
import { Client, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('databases: property rename rewrites formula references', () => {
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

  const byName = (props: PropertyDef[], name: string) => {
    const p = props.find((x) => x.name === name);
    assert.ok(p, `property ${name}`);
    return p;
  };
  const setup = async () => {
    const did = (await createPage(admin, wid, { kind: 'database', title: 'Devis', emptyDatabase: true })).id;
    const add = async (property: Record<string, unknown>) =>
      expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties;
    await add({ name: 'Prix', type: 'number' });
    await add({ name: 'Total', type: 'formula', formula: 'prop("Prix") * 2 + length("Prix")' });
    const props = await add({ name: 'Libellé', type: 'formula', formula: 'format(prop("Prix")) + prop("Total")' });
    return { did, prix: byName(props, 'Prix') };
  };

  test('the response and the stored schema carry the rewritten formulas', async () => {
    const { did, prix } = await setup();
    const res = expectOk(await admin.patch<DatabaseSchema>(`/databases/${did}/properties/${prix.id}`, { name: 'Tarif "HT"' }));
    assert.equal(byName(res.properties, 'Total').formula, 'prop("Tarif \\"HT\\"") * 2 + length("Prix")');
    assert.equal(byName(res.properties, 'Libellé').formula, 'format(prop("Tarif \\"HT\\"")) + prop("Total")');
    const stored = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
    assert.equal(byName(stored, 'Total').formula, 'prop("Tarif \\"HT\\"") * 2 + length("Prix")');
  });

  test('renaming a formula rewrites the formulas citing it', async () => {
    const { did } = await setup();
    const props = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
    const res = expectOk(await admin.patch<DatabaseSchema>(`/databases/${did}/properties/${byName(props, 'Total').id}`, { name: 'Montant' }));
    assert.equal(byName(res.properties, 'Libellé').formula, 'format(prop("Prix")) + prop("Montant")');
  });

  test('the API with a personal token gets the same rewrite', async () => {
    const { did, prix } = await setup();
    const token = expectOk(await admin.post<CreatedApiToken>('/me/tokens', { name: 'renommage', scope: 'write' })).token;
    const res = await fetch(`${srv.base}/api/databases/${did}/properties/${prix.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Coût' }),
    });
    assert.equal(res.status, 200);
    const schema = (await res.json()) as DatabaseSchema;
    assert.equal(byName(schema.properties, 'Total').formula, 'prop("Coût") * 2 + length("Prix")');
  });

  test('a homonym listed first keeps its references', async () => {
    const { did } = await setup();
    const add = async (property: Record<string, unknown>) =>
      expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties;
    const props = await add({ name: 'Prix', type: 'number' });
    const second = props.filter((p) => p.name === 'Prix').at(-1)!;
    const res = expectOk(await admin.patch<DatabaseSchema>(`/databases/${did}/properties/${second.id}`, { name: 'Prix 2' }));
    assert.equal(byName(res.properties, 'Total').formula, 'prop("Prix") * 2 + length("Prix")');
  });
});
