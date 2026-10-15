// G1 / D23: new filter operators through the MCP (same evaluation as the web client), including the
// viewer-specific « last_visited » property.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { connectMcp, createToken, expectOk, setupAdmin, startTestServer, type HttpClient, type Mcp, type TestServer } from './helpers.js';

const pad = (n: number) => String(n).padStart(2, '0');
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('MCP filters (G1)', () => {
  let srv: TestServer;
  let admin: HttpClient;
  let mcp: Mcp;
  let dbId: string;
  let visitedRowId: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    const token = await createToken(admin, { name: 'G1', scope: 'write' });
    mcp = await connectMcp(srv.base, token.token);
    const db = await mcp.json('oriel_create_database', {
      parent: { type: 'workspace' },
      title: 'Tâches G1',
      properties: [
        { name: 'Étiquettes', type: 'multi_select', options: ['Urgent', 'Client', 'Interne'] },
        { name: 'Échéance', type: 'date' },
      ],
    });
    dbId = db.id;
    expectOk(await admin.post(`/databases/${dbId}/properties`, { property: { name: 'Dernière visite', type: 'last_visited' } }));
    const created = await mcp.json('oriel_create_rows', {
      databaseId: dbId,
      rows: [
        { title: 'A', properties: { Étiquettes: ['Urgent', 'Client'], Échéance: day(-3) } },
        { title: 'B', properties: { Étiquettes: ['Urgent'], Échéance: day(2) } },
        { title: 'C', properties: { Étiquettes: ['Client', 'Interne'], Échéance: day(-40) } },
      ],
    });
    visitedRowId = created.creees.find((r: { titre?: string; title?: string }) => (r.titre ?? r.title) === 'B').id;
    expectOk(await admin.get(`/pages/${visitedRowId}`)); // the token user's visit of row B
  });
  after(async () => {
    await mcp?.close();
    await srv?.stop();
  });

  const q = (filters: unknown[]) =>
    mcp.json('oriel_query_database', { databaseId: dbId, filters }).then((r) => r.lignes.map((l: { titre: string }) => l.titre).sort());

  test('« contains all » versus « contains » (any)', async () => {
    assert.deepEqual(await q([{ property: 'Étiquettes', operator: 'contains_all', value: ['Urgent', 'Client'] }]), ['A']);
    assert.deepEqual(await q([{ property: 'Étiquettes', operator: 'contains', value: ['Urgent', 'Interne'] }]), ['A', 'B', 'C']);
    assert.deepEqual(await q([{ property: 'Étiquettes', operator: 'not_contains', value: ['Urgent'] }]), ['C']);
  });

  test('dates relative to a duration', async () => {
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'within_last', value: { amount: 1, unit: 'week' } }]), ['A']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'within_last', value: { amount: 2, unit: 'month' } }]), ['A', 'C']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'within_next', value: { amount: 3, unit: 'day' } }]), ['B']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'exactly_ago', value: { amount: 3, unit: 'day' } }]), ['A']);
    assert.deepEqual(await q([{ property: 'Échéance', operator: 'exactly_ahead', value: { amount: 2, unit: 'day' } }]), ['B']);
    const w = await mcp.call('oriel_query_database', { databaseId: dbId, filters: [{ property: 'Échéance', operator: 'within', value: 'tomorrow' }] }, { allowError: true }); assert.equal(w.isError, false, w.texts.join(' '));
  });

  test('invalid durations are refused with a message', async () => {
    const bad = await mcp.call('oriel_query_database', { databaseId: dbId, filters: [{ property: 'Échéance', operator: 'within_last', value: '7 jours' }] }, { allowError: true });
    assert.equal(bad.isError, true);
    assert.match(bad.texts.join(' '), /Durée invalide/);
  });

  test('last_visited: the token user’s own visit, readable and filterable', async () => {
    assert.deepEqual(await q([{ property: 'Dernière visite', operator: 'within_last', value: { amount: 1, unit: 'day' } }]), ['B']);
    assert.deepEqual(await q([{ property: 'Dernière visite', operator: 'is_empty' }]), ['A', 'C']);
    assert.deepEqual(await q([{ property: 'Dernière visite', operator: 'is_not_empty' }]), ['B']);
    assert.deepEqual(await q([{ property: 'Dernière visite', operator: 'on_or_after', value: 'yesterday' }]), ['B']);
    const all = await mcp.json('oriel_query_database', { databaseId: dbId });
    const b = all.lignes.find((l: { titre: string }) => l.titre === 'B');
    assert.match(String(b.proprietes['Dernière visite']), /^\d{4}-\d{2}-\d{2}T/);
  });

  test('a quantifier outside a « show original » rollup is refused', async () => {
    const bad = await mcp.call(
      'oriel_query_database',
      { databaseId: dbId, filters: [{ property: 'Étiquettes', operator: 'contains', value: 'Urgent', quantifier: 'every' }] },
      { allowError: true },
    );
    assert.equal(bad.isError, true);
    assert.match(bad.texts.join(' '), /quantificateur/);
  });
});
