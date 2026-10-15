// QA (security) of per-property permissions (D30, SPEC §5.9): a property hidden from a viewer must be
// absent from every output path (schema and values), and writes on hidden / read-only properties are
// refused. One test per output path; findings are tagged QA-PROP-xx.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import type {
  CreatedApiToken,
  DatabaseResponse,
  DatabaseSchema,
  Page,
  PageDetailResponse,
  PropertyDef,
  RelationGraphResponse,
  RowsResponse,
  SearchResponse,
  ServerMessage,
  TemplatesResponse,
  TrashResponse,
  View,
} from '@oriel/shared';
import { Db } from '../src/db/index.js';
import { WorkspaceReader } from '../src/ai/reader.js';
import { formTestHooks } from '../src/routes/forms.js';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type Res, type TestServer } from './helpers.js';

const SALARY = 987654;
const NOTES = 'SECRET-NOTES-4242';
const SECRETS = [String(SALARY), NOTES, 'SalaireZ', 'NotesZ', 'RespZ', 'Carole Cachée'];

/** Fails when any secret of `secrets` appears in the serialized body. */
function assertNoLeak(body: unknown, label: string, secrets = SECRETS): void {
  const text = JSON.stringify(body) ?? '';
  for (const s of secrets) assert.ok(!text.includes(s), `${label}: « ${s} » a fuité`);
}

async function bearer<T = any>(base: string, token: string, method: string, url: string, body?: unknown): Promise<Res<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

describe('qa: per-property permissions (D30)', () => {
  let srv: TestServer;
  let admin: Client;
  let member: Client;
  let viewer: Client;
  let wid: string;
  let carolId: string;
  let did: string;
  let rowId: string;
  const ids = {} as Record<'sal' | 'notes' | 'resp' | 'ro' | 'open', string>;

  before(async () => {
    formTestHooks.ipLimit = 1000;
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: member } = await addMember(admin, wid, 'prop-membre@oriel.test', 'Max Membre', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'prop-lecteur@oriel.test', 'Lise Lectrice', 'viewer'));
    carolId = (await addMember(admin, wid, 'prop-carole@oriel.test', 'Carole Cachée', 'member')).user.id;

    did = (await createPage(admin, wid, { kind: 'database', title: 'Équipe', emptyDatabase: true })).id;
    const add = async (property: Record<string, unknown>) => {
      const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property }));
      return s.properties.find((p) => p.name === property.name)!.id;
    };
    ids.sal = await add({ name: 'SalaireZ', type: 'number' });
    ids.notes = await add({ name: 'NotesZ', type: 'text' });
    ids.resp = await add({ name: 'RespZ', type: 'person' });
    ids.ro = await add({ name: 'LectureSeule', type: 'text' });
    ids.open = await add({ name: 'Ouvert', type: 'text' });
    const row = expectOk(
      await admin.post<Page>(`/databases/${did}/rows`, {
        title: 'Alice',
        properties: { [ids.sal]: SALARY, [ids.notes]: NOTES, [ids.resp]: [carolId], [ids.ro]: 'visible-ro', [ids.open]: 'libre' },
      }),
    );
    rowId = row.id;
    // Salary and person: admins only. Notes: members (not readers, not anonymous). Read-only: admins edit.
    for (const [prop, body] of [
      [ids.sal, { readRoles: [] }],
      [ids.resp, { readRoles: [] }],
      [ids.notes, { readRoles: ['member'] }],
      [ids.ro, { editRoles: [] }],
    ] as const) {
      expectOk(await admin.put(`/databases/${did}/properties/${prop}/access`, body));
    }
  });
  after(async () => {
    for (const k of Object.keys(formTestHooks)) delete (formTestHooks as Record<string, unknown>)[k];
    await srv.stop();
  });

  const anon = () => new Client(srv.base);

  test('QA-PROP-01: only owners/admins set permissions; the title cannot be restricted', async () => {
    assert.equal((await member.put(`/databases/${did}/properties/${ids.open}/access`, { readRoles: [] })).status, 403);
    assert.equal((await viewer.put(`/databases/${did}/properties/${ids.open}/access`, { readRoles: [] })).status, 403);
    assert.equal((await admin.put(`/databases/${did}/properties/title/access`, { readRoles: [] })).status, 400);
    assert.equal((await admin.put(`/databases/${did}/properties/${ids.open}/access`, { readRoles: ['owner'] })).status, 400);
    // A regular property PATCH (rename) neither drops nor sets the permissions.
    expectOk(await admin.patch(`/databases/${did}/properties/${ids.sal}`, { name: 'SalaireZ', access: { readRoles: ['viewer'] } }));
    const sal = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties.find((p) => p.id === ids.sal)!;
    assert.deepEqual(sal.access, { readRoles: [] });
  });

  test('QA-PROP-02: REST schema and rows (cookie and API token) hide the properties', async () => {
    const adminRows = expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`));
    assert.equal(adminRows.rows[0]!.properties[ids.sal], SALARY, 'admins see everything');
    for (const [label, c] of [
      ['membre', member],
      ['lecteur', viewer],
    ] as const) {
      const schema = expectOk(await c.get<DatabaseResponse>(`/databases/${did}`));
      const rows = expectOk(await c.get<RowsResponse>(`/databases/${did}/rows`));
      const secrets = label === 'membre' ? SECRETS.filter((s) => s !== NOTES && s !== 'NotesZ') : SECRETS;
      assertNoLeak(schema, `${label} GET /databases`, secrets);
      assertNoLeak(rows, `${label} GET /rows`, secrets);
      assert.ok(!rows.users.some((u) => u.id === carolId), `${label}: personne d'une propriété cachée listée`);
      assert.equal(rows.rows[0]!.properties[ids.ro], 'visible-ro');
    }
    // readOnly: computed per viewer, never stored (admins get no flag).
    const roOf = async (c: Client) => expectOk(await c.get<DatabaseResponse>(`/databases/${did}`)).schema.properties.find((p) => p.id === ids.ro)!;
    assert.equal((await roOf(member)).readOnly, true);
    assert.equal((await roOf(admin)).readOnly, undefined);
    assert.equal((await roOf(viewer)).readOnly, undefined, 'readers edit nothing anyway');
    const memberRows = expectOk(await member.get<RowsResponse>(`/databases/${did}/rows`));
    assert.equal(memberRows.rows[0]!.properties[ids.notes], NOTES, 'members see the notes');
    // MCP: API token of the reader.
    const token = expectOk(await viewer.post<CreatedApiToken>('/me/tokens', { name: 'mcp', scope: 'read' })).token;
    assertNoLeak((await bearer(srv.base, token, 'GET', `/databases/${did}`)).body, 'jeton GET /databases');
    assertNoLeak((await bearer(srv.base, token, 'GET', `/databases/${did}/rows`)).body, 'jeton GET /rows');
    assertNoLeak((await bearer(srv.base, token, 'GET', `/pages/${rowId}?visit=0`)).body, 'jeton GET /pages');
  });

  test('QA-PROP-03: row page detail (values and parent schema)', async () => {
    const detail = expectOk(await viewer.get<PageDetailResponse>(`/pages/${rowId}`));
    assertNoLeak(detail, 'lecteur GET /pages/:row');
    assert.ok(detail.parentDatabase!.properties.some((p) => p.id === ids.ro));
  });

  test('QA-PROP-04: row templates', async () => {
    const tpl = expectOk(await admin.post<Page>(`/databases/${did}/templates`, { title: 'Modèle' }));
    expectOk(await admin.patch(`/pages/${tpl.id}`, { properties: { [ids.sal]: SALARY, [ids.notes]: NOTES } }));
    assertNoLeak(expectOk(await viewer.get<TemplatesResponse>(`/databases/${did}/templates`)), 'lecteur GET /templates');
  });

  test('QA-PROP-05: published database and row page (anonymous)', async () => {
    expectOk(await admin.post(`/pages/${did}/publish`, { isPublic: true }));
    try {
      const a = anon();
      assertNoLeak(expectOk(await a.get(`/public/databases/${did}`)), 'anonyme GET /public/databases');
      assertNoLeak(expectOk(await a.get(`/public/databases/${did}/rows`)), 'anonyme GET /public/…/rows');
      assertNoLeak(expectOk(await a.get(`/public/pages/${rowId}`)), 'anonyme GET /public/pages/:row');
    } finally {
      expectOk(await admin.post(`/pages/${did}/publish`, { isPublic: false }));
    }
  });

  test('QA-PROP-06: public and member forms never expose nor write restricted properties', async () => {
    const view = expectOk(
      await admin.post<View>(`/databases/${did}/views`, {
        name: 'Formulaire',
        type: 'form',
        config: {
          form: {
            acceptResponses: true,
            isPublic: true,
            questions: [
              { id: 'q1', propertyId: 'title' },
              { id: 'q2', propertyId: ids.notes },
              { id: 'q3', propertyId: ids.ro },
              { id: 'q4', propertyId: ids.open },
            ],
          },
        },
      }),
    );
    const def = expectOk(await anon().get(`/public/forms/${view.id}`));
    assertNoLeak(def, 'anonyme GET /public/forms');
    assert.ok(!JSON.stringify(def).includes('LectureSeule'), 'question en lecture seule proposée aux anonymes');
    assert.equal((await anon().post(`/public/forms/${view.id}/submit`, { answers: { q1: 'x', q2: 'injecté' } })).status, 400);
    assert.equal((await anon().post(`/public/forms/${view.id}/submit`, { answers: { q1: 'x', q3: 'injecté' } })).status, 400);
    expectOk(await anon().post(`/public/forms/${view.id}/submit`, { answers: { q1: 'Anonyme ok', q4: 'libre' } }));
    // Members: the reader cannot answer the notes (hidden) nor the read-only property.
    assert.equal((await viewer.post(`/forms/${view.id}/submit`, { answers: { q1: 'x', q2: 'injecté' } })).status, 400);
    assert.equal((await viewer.post(`/forms/${view.id}/submit`, { answers: { q1: 'x', q3: 'injecté' } })).status, 400);
    assert.equal((await member.post(`/forms/${view.id}/submit`, { answers: { q1: 'x', q3: 'injecté' } })).status, 400);
    expectOk(await member.post(`/forms/${view.id}/submit`, { answers: { q1: 'Membre ok', q2: 'note du membre' } }));
  });

  test('QA-PROP-07: value writes on hidden (400) and read-only (403) properties are refused', async () => {
    assert.equal((await member.patch(`/pages/${rowId}`, { properties: { [ids.sal]: 1 } })).status, 400);
    assert.equal((await member.patch(`/pages/${rowId}`, { properties: { [ids.sal]: null } })).status, 400);
    assert.equal((await member.patch(`/pages/${rowId}`, { properties: { [ids.ro]: 'x' } })).status, 403);
    assert.equal((await member.post(`/databases/${did}/rows`, { title: 'x', properties: { [ids.sal]: 1 } })).status, 400);
    assert.equal((await member.post(`/databases/${did}/import`, { rows: [{ title: 'x', properties: { [ids.ro]: 'x' } }] })).status, 403);
    const res = expectOk(await member.patch<Page>(`/pages/${rowId}`, { properties: { [ids.open]: 'modifié' } }));
    assertNoLeak(res, 'membre PATCH /pages', [String(SALARY), 'Carole']);
    const back = expectOk(await admin.get<PageDetailResponse>(`/pages/${rowId}`)).page.properties;
    assert.equal(back[ids.sal], SALARY, 'hidden value kept after a member write');
    assert.deepEqual(back[ids.resp], [carolId]);
  });

  test('QA-PROP-08: structure operations on hidden (404) and read-only (403) properties', async () => {
    assert.equal((await member.patch(`/databases/${did}/properties/${ids.sal}`, { name: 'x' })).status, 404);
    assert.equal((await member.del(`/databases/${did}/properties/${ids.sal}`)).status, 404);
    assert.equal((await member.post(`/databases/${did}/properties/${ids.sal}/move`, { after: null })).status, 404);
    assert.equal((await member.patch(`/databases/${did}/properties/${ids.ro}`, { name: 'x' })).status, 403);
    assert.equal((await member.del(`/databases/${did}/properties/${ids.ro}`)).status, 403);
    // A schema write by a member answers with the schema they may see.
    const created = expectOk(await member.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name: 'Ajout membre', type: 'text' } }));
    assertNoLeak(created, 'membre POST /properties', ['SalaireZ', 'RespZ']);
  });

  test('QA-PROP-09: duplicate, trash list and restore responses', async () => {
    const copy = expectOk(await member.post<Page>(`/pages/${rowId}/duplicate`));
    assertNoLeak(copy, 'membre duplicate', [String(SALARY), carolId]);
    expectOk(await member.post(`/pages/${copy.id}/trash`));
    assertNoLeak(expectOk(await viewer.get<TrashResponse>(`/workspaces/${wid}/trash`)), 'lecteur GET /trash');
    assertNoLeak(expectOk(await member.get<TrashResponse>(`/workspaces/${wid}/trash`)), 'membre GET /trash', [String(SALARY), carolId]);
    assertNoLeak(expectOk(await member.post<Page>(`/pages/${copy.id}/restore`)), 'membre restore', [String(SALARY), carolId]);
  });

  test('QA-PROP-10: rollups and formulas over a related database never receive hidden values', async () => {
    const projects = (await createPage(admin, wid, { kind: 'database', title: 'Projets', emptyDatabase: true })).id;
    let s = expectOk(await admin.post<DatabaseSchema>(`/databases/${projects}/properties`, { property: { name: 'Équipe', type: 'relation', relation: { databaseId: did } } }));
    const rel = s.properties.find((p) => p.name === 'Équipe')!.id;
    s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${projects}/properties`, {
        property: { name: 'Masse', type: 'rollup', rollup: { relationPropertyId: rel, targetPropertyId: ids.sal, function: 'sum' } },
      }),
    );
    expectOk(await admin.post(`/databases/${projects}/rows`, { title: 'Film', properties: { [rel]: [rowId] } }));
    // What the web client loads to compute the rollup: the project rows and the related rows + schema.
    for (const url of [`/databases/${projects}/rows`, `/databases/${projects}`, `/databases/${did}/rows`, `/databases/${did}`]) {
      assertNoLeak(expectOk(await viewer.get(url)), `lecteur GET ${url}`);
    }
  });

  test('QA-PROP-16 (D33): formulas/rollups through a private related database receive no value', async () => {
    const priv = (await createPage(admin, wid, { kind: 'database', title: 'Primes privées', emptyDatabase: true, visibility: 'private' })).id;
    let s = expectOk(await admin.post<DatabaseSchema>(`/databases/${priv}/properties`, { property: { name: 'Prime', type: 'number' } }));
    const prime = s.properties.find((p) => p.name === 'Prime')!.id;
    const secretRow = expectOk(await admin.post<Page>(`/databases/${priv}/rows`, { title: 'Prime-Titre-Privé', properties: { [prime]: 31337 } }));
    const shared = (await createPage(admin, wid, { kind: 'database', title: 'Budget', emptyDatabase: true })).id;
    s = expectOk(await admin.post<DatabaseSchema>(`/databases/${shared}/properties`, { property: { name: 'Primes', type: 'relation', relation: { databaseId: priv } } }));
    const rel = s.properties.find((p) => p.name === 'Primes')!.id;
    expectOk(
      await admin.post(`/databases/${shared}/properties`, {
        property: { name: 'Total', type: 'rollup', rollup: { relationPropertyId: rel, targetPropertyId: prime, function: 'sum' } },
      }),
    );
    expectOk(await admin.post(`/databases/${shared}/rows`, { title: 'Ligne', properties: { [rel]: [secretRow.id] } }));
    // The web client asks for the related rows and schema: the private database stays invisible.
    assert.equal((await member.get(`/databases/${priv}/rows`)).status, 404);
    assert.equal((await member.get(`/databases/${priv}`)).status, 404);
    assert.equal((await member.get(`/pages/${secretRow.id}?visit=0`)).status, 404);
    assertNoLeak(expectOk(await member.get(`/databases/${shared}/rows`)), 'membre lignes Budget', ['31337', 'Prime-Titre-Privé']);
  });

  test('QA-PROP-17 (D29): the relation schema lists only readable databases and visible relations', async () => {
    const mk = async (title: string, extra: Record<string, unknown> = {}) => (await createPage(admin, wid, { kind: 'database', title, emptyDatabase: true, ...extra })).id;
    const center = await mk('Centre');
    const open = await mk('Ouverte');
    const secret = await mk('Base-Privée-Z', { visibility: 'private' });
    const incoming = await mk('Entrante');
    const rel = async (from: string, to: string, name: string, twoWay?: Record<string, unknown>) =>
      expectOk(await admin.post<DatabaseSchema>(`/databases/${from}/properties`, { property: { name, type: 'relation', relation: { databaseId: to } }, ...(twoWay ? { twoWay } : {}) }))
        .properties.find((p) => p.name === name)!;
    await rel(center, open, 'Vers ouverte', { name: 'Retour centre' });
    await rel(center, secret, 'Vers privée');
    const hidden = await rel(incoming, center, 'Lien-Caché-Z');
    await rel(incoming, center, 'Lien visible');
    expectOk(await admin.put(`/databases/${incoming}/properties/${hidden.id}/access`, { readRoles: [] }));

    const full = expectOk(await admin.get<RelationGraphResponse>(`/databases/${center}/relation-graph`));
    assert.equal(full.databases[0]!.id, center);
    assert.equal(full.links.length, 4, JSON.stringify(full.links));
    const twoWay = full.links.find((l) => l.propertyName === 'Vers ouverte')!;
    assert.equal(twoWay.twoWay, true);
    assert.equal(twoWay.mirrorName, 'Retour centre');
    assert.ok(!full.links.some((l) => l.propertyName === 'Retour centre'), 'a two-way pair is one link');

    const seen = expectOk(await member.get<RelationGraphResponse>(`/databases/${center}/relation-graph`));
    assertNoLeak(seen, 'membre relation-graph', ['Base-Privée-Z', secret, 'Lien-Caché-Z']);
    assert.deepEqual(seen.databases.map((d) => d.title).sort(), ['Centre', 'Entrante', 'Ouverte']);
    assert.equal((await member.get(`/databases/${secret}/relation-graph`)).status, 404);
  });

  test('QA-PROP-11: full-text search does not index property values', async () => {
    const res = expectOk(await viewer.get<SearchResponse>(`/workspaces/${wid}/search?q=${encodeURIComponent(NOTES)}`));
    assertNoLeak(res, 'lecteur recherche');
    assert.equal(res.results.length, 0);
  });

  test('QA-PROP-12: real-time events carry no value', async () => {
    const ws = new WebSocket(`${srv.wsBase}/api/events`, { headers: { cookie: `oriel_session=${viewer.cookie}` } });
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    try {
      ws.send(JSON.stringify({ type: 'subscribe', workspaceId: wid }));
      await waitFor(() => messages.find((m) => m.type === 'subscribed'));
      expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [ids.sal]: SALARY + 1, [ids.notes]: NOTES } }));
      await waitFor(() => messages.find((m) => m.type === 'changes'));
      await sleep(100);
      assertNoLeak(messages, 'événements', [String(SALARY + 1), NOTES]);
    } finally {
      ws.close();
    }
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [ids.sal]: SALARY } }));
  });

  test('QA-PROP-13: history (snapshots) carries no property value', async () => {
    assertNoLeak(expectOk(await member.get(`/pages/${rowId}/snapshots`)), 'membre GET /snapshots', [String(SALARY), carolId]);
  });

  test('QA-PROP-14: the AI brief reader (service account) only reads unrestricted properties', () => {
    const db = new Db(path.join(srv.dataDir, 'oriel.db'));
    try {
      const reader = new WorkspaceReader(db, wid, '2026-10-15');
      assertNoLeak(reader.queryDatabase({ baseId: did }), 'IA queryDatabase');
      assertNoLeak(reader.readPage({ pageId: rowId }), 'IA readPage');
      assertNoLeak(reader.listSources([did]), 'IA listSources');
      assert.ok(JSON.stringify(reader.queryDatabase({ baseId: did })).includes('Ouvert'));
    } finally {
      db.close();
    }
  });

  test('QA-PROP-15: a member can neither delete nor write through a restricted mirror of a two-way relation', async () => {
    const other = (await createPage(admin, wid, { kind: 'database', title: 'Lieux', emptyDatabase: true })).id;
    const s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${other}/properties`, {
        property: { name: 'Équipiers', type: 'relation', relation: { databaseId: did } },
        twoWay: { name: 'MiroirZ' },
      }),
    );
    const relProp = s.properties.find((p) => p.name === 'Équipiers') as PropertyDef;
    const mirror = relProp.relation!.syncedPropertyId!;
    expectOk(await admin.put(`/databases/${did}/properties/${mirror}/access`, { editRoles: [] }));
    assert.equal((await member.del(`/databases/${other}/properties/${relProp.id}?mirror=delete`)).status, 403);
    assert.ok(expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties.some((p) => p.id === mirror));
    // Writing the relation would change the restricted mirror too: refused.
    const place = expectOk(await admin.post<Page>(`/databases/${other}/rows`, { title: 'Studio' }));
    assert.equal((await member.patch(`/pages/${place.id}`, { properties: { [relProp.id]: [rowId] } })).status, 403);
    expectOk(await admin.patch(`/pages/${place.id}`, { properties: { [relProp.id]: [rowId] } }));
  });
});
