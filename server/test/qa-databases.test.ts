// QA (security + consistency) of the database module: properties, views, rows, relations, rollups,
// linked views, row templates, bulk import and public databases. Each test reproduces a scenario
// probed during the review; findings are tagged QA-DB-xx.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type {
  DatabaseResponse,
  DatabaseSchema,
  ImportRowsResponse,
  Page,
  PageDetailResponse,
  PropertyDef,
  RowsResponse,
  SessionResponse,
  TemplatesResponse,
  View,
} from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

/** Anonymous /collab authentication of `page:<id>` (raw Hocuspocus Auth message): "authenticated" or "denied". */
async function anonymousCollabAuth(wsBase: string, pageId: string): Promise<string> {
  const ws = new WebSocket(`${wsBase}/collab`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const reply = new Promise<string>((resolve) => {
      ws.on('message', (data) => {
        const dec = decoding.createDecoder(new Uint8Array(data as Buffer));
        decoding.readVarString(dec);
        if (decoding.readVarUint(dec) !== 2) return; // not an Auth message
        resolve(decoding.readVarUint(dec) === 2 ? 'authenticated' : 'denied');
      });
      ws.once('close', () => resolve('closed'));
      setTimeout(() => resolve('timeout'), 5000).unref();
    });
    const e = encoding.createEncoder();
    encoding.writeVarString(e, `page:${pageId}`);
    encoding.writeVarUint(e, 2); // Auth
    encoding.writeVarUint(e, 0); // Token
    encoding.writeVarString(e, 'anonymous');
    ws.send(encoding.toUint8Array(e));
    return await reply;
  } finally {
    ws.close();
  }
}

describe('qa: databases', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let outsider: Client;
  let outsiderId: string;
  let otherWid: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    ({ client: member, user: { id: memberId } } = await addMember(admin, wid, 'qa-membre@oriel.test', 'Marc', 'member'));
    ({ client: viewer } = await addMember(admin, wid, 'qa-lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    const o = expectOk(await outsider.post<SessionResponse>('/auth/signup', { email: 'qa-dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    outsiderId = o.user.id;
    otherWid = o.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  const newDb = async (c: Client, w: string, title: string, extra: Record<string, unknown> = {}) =>
    (await createPage(c, w, { kind: 'database', title, emptyDatabase: true, ...extra })).id;
  const schemaOf = async (did: string, c = admin) => expectOk(await c.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
  const rowsOf = async (did: string, c = admin) => expectOk(await c.get<RowsResponse>(`/databases/${did}/rows`)).rows;
  const row = async (did: string, title: string, properties: Record<string, unknown> = {}, c = admin) =>
    expectOk(await c.post<Page>(`/databases/${did}/rows`, { title, properties }));
  const patchRow = async (id: string, properties: Record<string, unknown>, c = admin) => expectOk(await c.patch<Page>(`/pages/${id}`, { properties }));
  const addProp = async (did: string, property: Record<string, unknown>, c = admin, twoWay?: Record<string, unknown>) =>
    expectOk(await c.post<DatabaseSchema>(`/databases/${did}/properties`, { property, ...(twoWay ? { twoWay } : {}) })).properties;
  const byName = (props: PropertyDef[], name: string) => {
    const p = props.find((x) => x.name === name);
    assert.ok(p, `property ${name}`);
    return p;
  };
  const ids = (v: unknown) => ((v as string[] | undefined) ?? []).slice().sort();

  // -------------------------------------------------------------------------------------------
  // QA-DB-01: relation → text/select conversion resolved the titles of ANY page id stored in the
  // relation (other workspaces, other users' private pages).
  // -------------------------------------------------------------------------------------------
  test('QA-DB-01: converting a relation never reveals titles of pages outside the visible target rows', async () => {
    // Cross-workspace: the outsider stores ids of pages of another workspace in a one-way relation.
    const secret = await createPage(admin, wid, { title: 'Fusion confidentielle Zircon' });
    const memberSecret = await createPage(member, wid, { title: 'Journal privé Quartz', visibility: 'private' });
    const mine = await newDb(outsider, otherWid, 'Mes notes');
    const target = await newDb(outsider, otherWid, 'Cible');
    const t1 = await row(target, 'Ma cible', {}, outsider);
    const rel = byName(await addProp(mine, { name: 'Lien', type: 'relation', relation: { databaseId: target } }, outsider), 'Lien').id;
    const r = await outsider.post<Page>(`/databases/${mine}/rows`, { title: 'Sonde', properties: { [rel]: [secret.id, memberSecret.id, t1.id] } });
    expectOk(r);
    expectOk(await outsider.patch(`/databases/${mine}/properties/${rel}`, { type: 'text' }));
    const text = String((await rowsOf(mine, outsider)).find((x) => x.title === 'Sonde')!.properties[rel] ?? '');
    assert.ok(!text.includes('Zircon'), `title of another workspace's page leaked: ${text}`);
    assert.ok(!text.includes('Quartz'), `title of a private page leaked: ${text}`);
    assert.equal(text, 'Ma cible', 'titles of the target rows are kept');

    // Same workspace: a member converts a relation listing rows of the admin's private database.
    const pub = await newDb(admin, wid, 'Partagée QA1');
    const priv = await newDb(admin, wid, 'Privée QA1', { visibility: 'private' });
    const s1 = await row(priv, 'Salaire du directeur');
    const a = byName(await addProp(pub, { name: 'Secret', type: 'relation', relation: { databaseId: priv } }), 'Secret').id;
    await row(pub, 'P1', { [a]: [s1.id] });
    expectOk(await member.patch(`/databases/${pub}/properties/${a}`, { type: 'select' }));
    const schema = await schemaOf(pub, member);
    const names = (byName(schema, 'Secret').options ?? []).map((o) => o.name);
    assert.ok(!names.some((n) => n.includes('directeur')), `private row title leaked into options: ${names.join(', ')}`);

    // The owner of the private rows still gets their titles.
    const b = byName(await addProp(pub, { name: 'Secret 2', type: 'relation', relation: { databaseId: priv } }), 'Secret 2').id;
    const p2 = await row(pub, 'P2', { [b]: [s1.id] });
    expectOk(await admin.patch(`/databases/${pub}/properties/${b}`, { type: 'text' }));
    assert.equal((await rowsOf(pub)).find((x) => x.id === p2.id)!.properties[b], 'Salaire du directeur');
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-02: deleting / un-syncing a two-way relation deleted the mirror property inside a
  // database the actor cannot see (someone else's private database).
  // -------------------------------------------------------------------------------------------
  test('QA-DB-02: a two-way relation cannot be used to delete a property of an invisible database', async () => {
    const pub = await newDb(admin, wid, 'Partagée QA2');
    const priv = await newDb(admin, wid, 'Privée QA2', { visibility: 'private' });
    const s1 = await row(priv, 'S1');
    // Mirror living in the private database (relation created from the shared one).
    const a = byName(await addProp(pub, { name: 'Vers privé', type: 'relation', relation: { databaseId: priv } }, admin, { name: 'Retour' }), 'Vers privé').id;
    // Mirror living in the shared database (relation created from the private one).
    const c = byName(await addProp(priv, { name: 'Depuis privé', type: 'relation', relation: { databaseId: pub } }, admin, { name: 'Miroir partagé' }), 'Depuis privé').id;
    const d = byName(await schemaOf(pub), 'Miroir partagé').id;
    const p1 = await row(pub, 'P1', { [a]: [s1.id] });
    await patchRow(s1.id, { [c]: [p1.id] });
    const retour = byName(await schemaOf(priv), 'Retour').id;
    assert.deepEqual(ids((await rowsOf(priv)).find((x) => x.id === s1.id)!.properties[retour]), [p1.id]);

    // The member (who cannot see `priv`) deletes / un-syncs the shared-side properties asking to delete the mirrors.
    const un = await member.patch(`/databases/${pub}/properties/${d}`, { twoWay: null });
    assert.ok(un.status === 200 || un.status === 400, `twoWay: null → ${un.status}`);
    expectOk(await member.del(`/databases/${pub}/properties/${d}?mirror=delete`));
    expectOk(await member.del(`/databases/${pub}/properties/${a}?mirror=delete`));

    const privSchema = await schemaOf(priv);
    assert.ok(privSchema.some((p) => p.id === retour), 'the mirror inside the private database survives');
    assert.ok(privSchema.some((p) => p.id === c), 'the relation of the private database survives');
    assert.equal(byName(privSchema, 'Retour').relation?.syncedPropertyId, undefined, 'it became a one-way relation');
    const s1Now = (await rowsOf(priv)).find((x) => x.id === s1.id)!;
    assert.deepEqual(ids(s1Now.properties[retour]), [p1.id], 'its values are kept');
    assert.deepEqual(ids(s1Now.properties[c]), [p1.id]);

    // The owner can still delete both sides at once.
    const e = byName(await addProp(pub, { name: 'Encore', type: 'relation', relation: { databaseId: priv } }, admin, { name: 'Encore retour' }), 'Encore').id;
    expectOk(await admin.del(`/databases/${pub}/properties/${e}?mirror=delete`));
    assert.ok(!(await schemaOf(priv)).some((p) => p.name === 'Encore retour'));
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-03: one-way relation values accepted any string (ids of other workspaces, of plain pages,
  // of templates…): dangling/foreign references stored in rows.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-03: one-way relation values only keep rows of the target database', async () => {
    const src = await newDb(admin, wid, 'Source QA3');
    const target = await newDb(admin, wid, 'Cible QA3');
    const other = await newDb(admin, wid, 'Autre QA3');
    const t1 = await row(target, 'T1');
    const t2 = await row(target, 'T2');
    const o1 = await row(other, 'O1');
    const plain = await createPage(admin, wid, { title: 'Page simple' });
    const foreign = await createPage(outsider, otherWid, { title: 'Ailleurs' });
    const tpl = expectOk(await admin.post<Page>(`/databases/${target}/templates`, { title: 'Modèle' }));
    const rel = byName(await addProp(src, { name: 'Lien', type: 'relation', relation: { databaseId: target } }), 'Lien').id;
    const r = await row(src, 'R', { [rel]: [t1.id, o1.id, plain.id, foreign.id, tpl.id, randomUUID(), target] });
    assert.deepEqual(ids(r.properties[rel]), [t1.id]);
    // Latent links (rows trashed after being linked) are kept on later writes.
    const r2 = await row(src, 'R2', { [rel]: [t1.id, t2.id] });
    expectOk(await admin.post(`/pages/${t2.id}/trash`));
    const again = await patchRow(r2.id, { [rel]: [t2.id, t1.id, o1.id] });
    assert.deepEqual(ids(again.properties[rel]), [t1.id, t2.id].sort());
    // Self relations accept rows of the same database.
    const self = byName(await addProp(src, { name: 'Soi', type: 'relation', relation: { databaseId: src } }), 'Soi').id;
    assert.deepEqual(ids((await patchRow(r.id, { [self]: [r2.id, t1.id] })).properties[self]), [r2.id]);
    // CSV import goes through the same validation.
    const imported = expectOk(await admin.post<ImportRowsResponse>(`/databases/${src}/import`, { rows: [{ title: 'Imp', properties: { [rel]: [t1.id, foreign.id] } }] }));
    assert.equal(imported.created, 1);
    assert.deepEqual(ids((await rowsOf(src)).find((x) => x.title === 'Imp')!.properties[rel]), [t1.id]);
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-04: writing the relation of a trashed row put it back into the mirror lists of live rows.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-04: a trashed row edited through the API is not mirrored until it is restored', async () => {
    const s = await newDb(admin, wid, 'Tâches QA4');
    const t = await newDb(admin, wid, 'Projets QA4');
    const a = byName(await addProp(s, { name: 'Projet', type: 'relation', relation: { databaseId: t } }, admin, { name: 'Tâches' }), 'Projet').id;
    const b = byName(await schemaOf(t), 'Tâches').id;
    const p1 = await row(t, 'P1');
    const p2 = await row(t, 'P2');
    const r = await row(s, 'R', { [a]: [p1.id] });
    expectOk(await admin.post(`/pages/${r.id}/trash`));
    const mirrorOf = async (id: string) => ids((await rowsOf(t)).find((x) => x.id === id)!.properties[b]);
    assert.deepEqual(await mirrorOf(p1.id), []);
    const res = await admin.patch<Page>(`/pages/${r.id}`, { properties: { [a]: [p1.id, p2.id] } });
    if (res.status === 200) {
      assert.deepEqual(await mirrorOf(p1.id), [], 'a trashed row stays out of live mirror lists');
      assert.deepEqual(await mirrorOf(p2.id), []);
      expectOk(await admin.post(`/pages/${r.id}/restore`));
      assert.deepEqual(await mirrorOf(p1.id), [r.id], 'restoring puts it back');
      assert.deepEqual(await mirrorOf(p2.id), [r.id]);
    } else {
      assert.ok(res.status === 400 || res.status === 409, `unexpected ${res.status}`);
    }
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-05: a relation whose target database was deleted for good could no longer be edited
  // (renaming it failed with « Base de données liée introuvable »).
  // -------------------------------------------------------------------------------------------
  test('QA-DB-05: a relation to a database deleted for good can still be renamed', async () => {
    const s = await newDb(admin, wid, 'Source QA5');
    const t = await newDb(admin, wid, 'Cible QA5');
    const a = byName(await addProp(s, { name: 'Cible', type: 'relation', relation: { databaseId: t } }, admin, { name: 'Source' }), 'Cible').id;
    const one = byName(await addProp(s, { name: 'Simple', type: 'relation', relation: { databaseId: t } }), 'Simple').id;
    expectOk(await admin.post(`/pages/${t}/trash`));
    expectOk(await admin.del(`/pages/${t}`));
    expectOk(await admin.patch(`/databases/${s}/properties/${a}`, { name: 'Ancienne cible' }));
    expectOk(await admin.patch(`/databases/${s}/properties/${one}`, { name: 'Ancienne simple' }));
    // Re-targeting to a missing database, or making it two-way, is still refused.
    assert.equal((await admin.patch(`/databases/${s}/properties/${one}`, { relation: { databaseId: randomUUID() } })).status, 400);
    assert.ok([400, 404].includes((await admin.patch(`/databases/${s}/properties/${one}`, { twoWay: {} })).status));
    // A relation to an invisible database is still not editable by others (QA-DB-02).
    const priv = await newDb(admin, wid, 'Privée QA5', { visibility: 'private' });
    const pub = await newDb(admin, wid, 'Partagée QA5');
    const p = byName(await addProp(pub, { name: 'Vers privé', type: 'relation', relation: { databaseId: priv } }), 'Vers privé').id;
    assert.equal((await member.patch(`/databases/${pub}/properties/${p}`, { twoWay: {} })).status, 400);
    assert.ok(!(await schemaOf(priv)).some((x) => x.type === 'relation'), 'no mirror created in the private database');
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-06: making a relation two-way kept ids that can never hold the link back.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-06: making a relation two-way keeps only ids that hold the link back (or latent ones)', async () => {
    const s = await newDb(admin, wid, 'Source QA6');
    const t = await newDb(admin, wid, 'Cible QA6');
    const other = await newDb(admin, wid, 'Autre QA6');
    const t1 = await row(t, 'T1');
    const t2 = await row(t, 'T2');
    const o1 = await row(other, 'O1');
    const tpl = expectOk(await admin.post<Page>(`/databases/${t}/templates`, { title: 'Modèle' }));
    const a = byName(await addProp(s, { name: 'Lien', type: 'relation', relation: { databaseId: t } }), 'Lien').id;
    const r = await row(s, 'R');
    // Legacy values (written before one-way values were validated).
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare('UPDATE pages SET properties = ? WHERE id = ?').run(JSON.stringify({ [a]: [t1.id, t2.id, o1.id, tpl.id, randomUUID()] }), r.id);
    } finally {
      raw.close();
    }
    expectOk(await admin.post(`/pages/${t2.id}/trash`));
    expectOk(await admin.patch(`/databases/${s}/properties/${a}`, { twoWay: { name: 'Retour' } }));
    const b = byName(await schemaOf(t), 'Retour').id;
    const rNow = (await rowsOf(s)).find((x) => x.id === r.id)!;
    assert.deepEqual(ids(rNow.properties[a]), [t1.id, t2.id].sort(), 'only target rows are kept (t2: latent link)');
    assert.deepEqual(ids((await rowsOf(t)).find((x) => x.id === t1.id)!.properties[b]), [r.id]);
    expectOk(await admin.post(`/pages/${t2.id}/restore`));
    assert.deepEqual(ids((await rowsOf(t)).find((x) => x.id === t2.id)!.properties[b]), [r.id]);
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-07: text → relation conversion resolved titles in cubic time (and stripped export
  // references with quadratic regexes): one 100 000-character value froze the event loop.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-07: converting huge text values to a relation stays fast', async () => {
    const did = await newDb(admin, wid, 'Texte QA7');
    const target = await newDb(admin, wid, 'Cible QA7');
    const alpha = await row(target, 'Alpha');
    const bg = await row(target, 'Beta, Gamma');
    const txt = byName(await addProp(did, { name: 'Liens', type: 'text' }), 'Liens').id;
    await row(did, 'Virgules', { [txt]: 'x,'.repeat(49_990) + 'Beta, Gamma' });
    await row(did, 'Espaces', { [txt]: ' '.repeat(99_000) + 'Alpha' });
    await row(did, 'Parenthèse', { [txt]: '(' + '/'.repeat(99_000) });
    await row(did, 'Export', { [txt]: 'Alpha (Cible/Alpha%20abc.md), Beta, Gamma (https://www.notion.so/x)' });
    const t0 = Date.now();
    expectOk(await admin.patch(`/databases/${did}/properties/${txt}`, { type: 'relation', relation: { databaseId: target } }));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `conversion took ${elapsed} ms`);
    const byTitle = new Map((await rowsOf(did)).map((r) => [r.title, ids(r.properties[txt])]));
    assert.deepEqual(byTitle.get('Virgules'), [bg.id]);
    assert.deepEqual(byTitle.get('Espaces'), [alpha.id]);
    assert.deepEqual(byTitle.get('Parenthèse'), []);
    assert.deepEqual(byTitle.get('Export'), [alpha.id, bg.id].sort());
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-08: duplicating a page copied the views of the linked database blocks found in its
  // document whatever the database (another workspace included).
  // -------------------------------------------------------------------------------------------
  test('QA-DB-08: duplicating a page never copies views into a database the actor cannot see', async () => {
    const victim = await newDb(admin, wid, 'Victime QA8');
    const linkId = randomUUID();
    expectOk(await admin.get(`/databases/${victim}?linkId=${linkId}`));
    const countViews = () => {
      const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
      try {
        return (raw.prepare('SELECT COUNT(*) AS n FROM views WHERE database_id = ?').get(victim) as { n: number }).n;
      } finally {
        raw.close();
      }
    };
    const before = countViews();
    // The outsider's page holds a linked block pointing at the victim database (forged document).
    const host = await createPage(outsider, otherWid, { title: 'Hôte forgé' });
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('blocknote');
    const group = new Y.XmlElement('blockGroup');
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', randomUUID());
    const block = new Y.XmlElement('linkedDatabase');
    block.setAttribute('databaseId', victim);
    block.setAttribute('linkId', linkId);
    container.insert(0, [block]);
    group.insert(0, [container]);
    fragment.insert(0, [group]);
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare("INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, '', ?, '[]')").run(host.id, Y.encodeStateAsUpdate(doc), Date.now());
    } finally {
      raw.close();
    }
    expectOk(await outsider.post<Page>(`/pages/${host.id}/duplicate`));
    assert.equal(countViews(), before, 'no view created in the foreign database');
    // Same workspace, invisible database: same rule.
    const priv = await newDb(member, wid, 'Privée QA8', { visibility: 'private' });
    const privLink = randomUUID();
    expectOk(await member.get(`/databases/${priv}?linkId=${privLink}`));
    const own = await createPage(admin, wid, { title: 'Hôte admin' });
    const doc2 = new Y.Doc();
    const f2 = doc2.getXmlFragment('blocknote');
    const g2 = new Y.XmlElement('blockGroup');
    const c2 = new Y.XmlElement('blockContainer');
    c2.setAttribute('id', randomUUID());
    const b2 = new Y.XmlElement('linkedDatabase');
    b2.setAttribute('databaseId', priv);
    b2.setAttribute('linkId', privLink);
    c2.insert(0, [b2]);
    g2.insert(0, [c2]);
    f2.insert(0, [g2]);
    const raw2 = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    let privBefore = 0;
    try {
      raw2.prepare("INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, '', ?, '[]')").run(own.id, Y.encodeStateAsUpdate(doc2), Date.now());
      privBefore = (raw2.prepare('SELECT COUNT(*) AS n FROM views WHERE database_id = ?').get(priv) as { n: number }).n;
    } finally {
      raw2.close();
    }
    expectOk(await admin.post<Page>(`/pages/${own.id}/duplicate`));
    const raw3 = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      assert.equal((raw3.prepare('SELECT COUNT(*) AS n FROM views WHERE database_id = ?').get(priv) as { n: number }).n, privBefore);
    } finally {
      raw3.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  // Consistency: duplication of databases with two-way relations, property deletion in views.
  // -------------------------------------------------------------------------------------------
  test('duplicating databases keeps every two-way pair consistent', async () => {
    const host = await createPage(admin, wid, { title: 'Hôte QA' });
    const s = await newDb(admin, wid, 'S', { parentType: 'page', parentId: host.id, isInline: true });
    const t = await newDb(admin, wid, 'T', { parentType: 'page', parentId: host.id, isInline: true });
    const outside = await newDb(admin, wid, 'Hors hôte');
    const a = byName(await addProp(s, { name: 'A', type: 'relation', relation: { databaseId: t } }, admin, { name: 'B' }), 'A').id;
    const b = byName(await schemaOf(t), 'B').id;
    const c = byName(await addProp(s, { name: 'C', type: 'relation', relation: { databaseId: outside } }, admin, { name: 'D' }), 'C').id;
    const d = byName(await schemaOf(outside), 'D').id;
    const t1 = await row(t, 't1');
    const x1 = await row(outside, 'x1');
    await row(s, 's1', { [a]: [t1.id], [c]: [x1.id] });

    const pairOk = async (sid: string, ap: string, tid: string, bp: string) => {
      const sRows = await rowsOf(sid);
      const tRows = await rowsOf(tid);
      for (const r of sRows) for (const x of ids(r.properties[ap])) assert.ok(ids(tRows.find((y) => y.id === x)?.properties[bp]).includes(r.id), `${r.title}→${x}`);
      for (const r of tRows) for (const x of ids(r.properties[bp])) assert.ok(ids(sRows.find((y) => y.id === x)?.properties[ap]).includes(r.id), `${r.title}←${x}`);
    };
    const copy = expectOk(await admin.post<Page>(`/pages/${host.id}/duplicate`));
    const tree = expectOk(await admin.get<{ nodes: Array<{ id: string; parentId: string; title: string }> }>(`/workspaces/${wid}/tree`)).nodes;
    const sCopy = tree.find((n) => n.parentId === copy.id && n.title === 'S')!.id;
    const tCopy = tree.find((n) => n.parentId === copy.id && n.title === 'T')!.id;
    const sSchema = await schemaOf(sCopy);
    assert.equal(byName(sSchema, 'A').relation?.databaseId, tCopy);
    assert.ok(byName(sSchema, 'A').relation?.syncedPropertyId, 'pair between copied databases kept');
    assert.equal(byName(sSchema, 'C').relation?.syncedPropertyId, undefined, 'pair to a database outside the copy becomes one-way');
    await pairOk(s, a, t, b);
    await pairOk(sCopy, a, tCopy, b);
    await pairOk(s, c, outside, d);
    assert.deepEqual(ids((await rowsOf(outside)).find((x) => x.id === x1.id)!.properties[d]).length, 1, 'outside rows do not list the copies');
  });

  test('deleting or retyping a property cleans nested filters and layout settings of every view', async () => {
    const did = await newDb(admin, wid, 'Vues QA');
    const date = byName(await addProp(did, { name: 'Date', type: 'date' }), 'Date').id;
    const fin = byName(await addProp(did, { name: 'Fin', type: 'date' }), 'Fin').id;
    const dep = byName(await addProp(did, { name: 'Bloqué par', type: 'relation', relation: { databaseId: did } }), 'Bloqué par').id;
    const rule = (propertyId: string) => ({ id: randomUUID().slice(0, 8), propertyId, operator: 'is_not_empty' });
    const view = expectOk(
      await admin.post<View>(`/databases/${did}/views`, {
        name: 'Chrono',
        type: 'timeline',
        config: {
          dateProperty: date,
          dateEndProperty: fin,
          dependencyProperty: dep,
          filter: { conjunction: 'and', rules: [rule(date)], groups: [{ conjunction: 'or', rules: [rule(date), rule(fin), rule(dep)] }] },
        },
      }),
    );
    expectOk(await admin.del(`/databases/${did}/properties/${date}`));
    expectOk(await admin.patch(`/databases/${did}/properties/${fin}`, { type: 'text' }));
    expectOk(await admin.patch(`/databases/${did}/properties/${dep}`, { type: 'text' }));
    const cfg = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === view.id)!.config;
    assert.equal(cfg.dateProperty, null);
    assert.equal(cfg.dateEndProperty, null);
    assert.equal(cfg.dependencyProperty, null);
    assert.deepEqual(cfg.filter?.rules, []);
    assert.deepEqual(cfg.filter?.groups?.[0]?.rules, []);
  });

  // -------------------------------------------------------------------------------------------
  // Public databases.
  // -------------------------------------------------------------------------------------------
  test('public databases expose only published rows, never emails, other databases or new views', async () => {
    const pubPage = await createPage(admin, wid, { title: 'Publiée QA' });
    const pubDb = await newDb(admin, wid, 'Base publiée', { parentType: 'page', parentId: pubPage.id, isInline: true });
    const hidden = await newDb(admin, wid, 'Base non publiée');
    const h1 = await row(hidden, 'Ligne secrète');
    const rel = byName(await addProp(pubDb, { name: 'Lien', type: 'relation', relation: { databaseId: hidden } }), 'Lien').id;
    const who = byName(await addProp(pubDb, { name: 'Qui', type: 'person' }), 'Qui').id;
    const roll = byName(
      await addProp(pubDb, { name: 'Cumul', type: 'rollup', rollup: { relationPropertyId: rel, targetPropertyId: 'title', function: 'show_original' } }),
      'Cumul',
    ).id;
    await row(pubDb, 'Visible', { [rel]: [h1.id], [who]: [memberId] });
    const tpl = expectOk(await admin.post<Page>(`/databases/${pubDb}/templates`, { title: 'Modèle brouillon' }));
    expectOk(await admin.post(`/pages/${pubPage.id}/publish`, { isPublic: true }));
    const anon = new Client(srv.base);
    const rows = expectOk(await anon.get<RowsResponse>(`/public/databases/${pubDb}/rows`));
    assert.deepEqual(rows.rows.map((r) => r.title), ['Visible']);
    assert.ok(rows.users.every((u) => u.email === ''));
    assert.ok(!JSON.stringify(rows).includes('Ligne secrète'));
    assert.ok(!JSON.stringify(rows).includes('@oriel.test'));
    assert.ok(!(roll in rows.rows[0]!.properties), 'rollups are computed client-side, never stored');
    for (const url of [`/public/databases/${hidden}`, `/public/databases/${hidden}/rows`, `/public/pages/${h1.id}`]) {
      assert.equal((await anon.get(url)).status, 404, url);
    }
    // Reading with a link id never creates views.
    const before = expectOk(await admin.get<DatabaseResponse>(`/databases/${pubDb}`)).views.length;
    const linkId = randomUUID();
    expectOk(await anon.get(`/public/databases/${pubDb}?linkId=${linkId}`));
    const views = await (async () => {
      const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
      try {
        return (raw.prepare('SELECT COUNT(*) AS n FROM views WHERE database_id = ?').get(pubDb) as { n: number }).n;
      } finally {
        raw.close();
      }
    })();
    assert.equal(views, before);
    // Publishing a single row does not publish its database.
    const r2 = await row(hidden, 'Ligne publiée');
    expectOk(await admin.post(`/pages/${r2.id}/publish`, { isPublic: true }));
    assert.equal((await anon.get(`/public/databases/${hidden}/rows`)).status, 404);
    expectOk(await anon.get(`/public/pages/${r2.id}`));
    // Informational: the row templates of a published database are reachable by id.
    const tplRes = await anon.get(`/public/pages/${tpl.id}`);
    assert.ok(tplRes.status === 200 || tplRes.status === 404);
  });

  // -------------------------------------------------------------------------------------------
  // Role checks on every database endpoint (viewer) and IDOR (outsider / private database).
  // -------------------------------------------------------------------------------------------
  test('viewers cannot write templates, imports, properties or views', async () => {
    const did = await newDb(admin, wid, 'Lecture QA');
    const prop = byName(await addProp(did, { name: 'Texte', type: 'text' }), 'Texte').id;
    const tpl = expectOk(await admin.post<Page>(`/databases/${did}/templates`, { title: 'Modèle' }));
    const viewId = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views[0]!.id;
    const before = JSON.stringify([await schemaOf(did), expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views, await rowsOf(did)]);
    const attempts: Array<[string, Promise<{ status: number }>]> = [
      ['template', viewer.post(`/databases/${did}/templates`, { title: 'x' })],
      ['template copy', viewer.post(`/databases/${did}/templates`, { fromTemplateId: tpl.id })],
      ['default template', viewer.put(`/databases/${did}/templates/default`, { templateId: tpl.id })],
      ['row from template', viewer.post(`/databases/${did}/rows`, { templateId: tpl.id })],
      ['template edit', viewer.patch(`/pages/${tpl.id}`, { title: 'x' })],
      ['import', viewer.post(`/databases/${did}/import`, { rows: [{ title: 'x' }] })],
      ['property update', viewer.patch(`/databases/${did}/properties/${prop}`, { name: 'x' })],
      ['property delete', viewer.del(`/databases/${did}/properties/${prop}`)],
      ['property move', viewer.post(`/databases/${did}/properties/${prop}/move`, { after: null })],
      ['view create', viewer.post(`/databases/${did}/views`, { name: 'x', type: 'board' })],
      ['view delete', viewer.del(`/views/${viewId}`)],
      ['view move', viewer.post(`/views/${viewId}/move`, { after: null })],
      ['view duplicate', viewer.post(`/views/${viewId}/duplicate`)],
    ];
    for (const [label, p] of attempts) assert.equal((await p).status, 403, label);
    // Reading the database with a link id never creates views for a viewer.
    const linked = expectOk(await viewer.get<DatabaseResponse>(`/databases/${did}?linkId=${randomUUID()}`));
    assert.ok(linked.views.every((v) => v.linkId === null));
    const afterState = JSON.stringify([await schemaOf(did), expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views, await rowsOf(did)]);
    assert.equal(afterState, before, 'nothing changed');
  });

  test('foreign or invisible databases, views and templates are 404 on every endpoint', async () => {
    const did = await newDb(admin, wid, 'Cible IDOR');
    const prop = byName(await addProp(did, { name: 'Texte', type: 'text' }), 'Texte').id;
    const tpl = expectOk(await admin.post<Page>(`/databases/${did}/templates`, { title: 'Modèle' }));
    const viewId = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views[0]!.id;
    const priv = await newDb(member, wid, 'Privée membre', { visibility: 'private' });
    const privTpl = expectOk(await member.post<Page>(`/databases/${priv}/templates`, { title: 'Modèle privé' }));
    const privView = expectOk(await member.get<DatabaseResponse>(`/databases/${priv}`)).views[0]!.id;
    const privProp = byName(await addProp(priv, { name: 'Texte', type: 'text' }, member), 'Texte').id;
    const mine = await newDb(outsider, otherWid, 'Mienne');

    const probes = (c: Client, d: string, p: string, v: string, t: string): Array<[string, Promise<{ status: number }>]> => [
      ['get', c.get(`/databases/${d}`)],
      ['get linked', c.get(`/databases/${d}?linkId=${randomUUID()}`)],
      ['rows', c.get(`/databases/${d}/rows`)],
      ['templates', c.get(`/databases/${d}/templates`)],
      ['template create', c.post(`/databases/${d}/templates`, { title: 'x' })],
      ['template copy', c.post(`/databases/${d}/templates`, { fromTemplateId: t })],
      ['default template', c.put(`/databases/${d}/templates/default`, { templateId: t })],
      ['row from template', c.post(`/databases/${d}/rows`, { templateId: t })],
      ['import', c.post(`/databases/${d}/import`, { rows: [{ title: 'x' }] })],
      ['property create', c.post(`/databases/${d}/properties`, { property: { type: 'text' } })],
      ['property update', c.patch(`/databases/${d}/properties/${p}`, { name: 'x' })],
      ['property delete', c.del(`/databases/${d}/properties/${p}`)],
      ['property move', c.post(`/databases/${d}/properties/${p}/move`, { after: null })],
      ['view create', c.post(`/databases/${d}/views`, { name: 'x', type: 'table' })],
      ['view update', c.patch(`/views/${v}`, { name: 'x' })],
      ['view delete', c.del(`/views/${v}`)],
      ['view move', c.post(`/views/${v}/move`, { after: null })],
      ['view duplicate', c.post(`/views/${v}/duplicate`)],
      ['template page', c.get(`/pages/${t}`)],
    ];
    for (const [label, p] of probes(outsider, did, prop, viewId, tpl.id)) assert.equal((await p).status, 404, `outsider: ${label}`);
    for (const c of [admin, viewer]) {
      for (const [label, p] of probes(c, priv, privProp, privView, privTpl.id)) assert.equal((await p).status, 404, `private db: ${label}`);
    }
    // Pointing own objects at foreign ones.
    const myTpl = expectOk(await outsider.post<Page>(`/databases/${mine}/templates`, { title: 'Le mien' }));
    assert.equal((await outsider.post(`/databases/${mine}/rows`, { templateId: tpl.id })).status, 404);
    assert.equal((await outsider.post(`/databases/${mine}/templates`, { fromTemplateId: tpl.id })).status, 404);
    assert.equal((await outsider.put(`/databases/${mine}/templates/default`, { templateId: tpl.id })).status, 404);
    assert.equal((await admin.post(`/databases/${did}/rows`, { templateId: myTpl.id })).status, 404);
    const rel = byName(await addProp(mine, { name: 'Lien', type: 'relation', relation: { databaseId: mine } }, outsider), 'Lien').id;
    assert.equal((await outsider.patch(`/databases/${mine}/properties/${rel}`, { relation: { databaseId: did } })).status, 400);
    const memberDb = await newDb(member, wid, 'Partagée membre');
    const mrel = byName(await addProp(memberDb, { name: 'Lien', type: 'relation', relation: { databaseId: memberDb } }, member), 'Lien').id;
    assert.equal((await admin.patch(`/databases/${memberDb}/properties/${mrel}`, { relation: { databaseId: priv } })).status, 400);
    assert.equal((await admin.post(`/databases/${memberDb}/properties`, { property: { type: 'relation', relation: { databaseId: priv } }, twoWay: {} })).status, 400);
    // A template of another database of the same workspace, and a regular row, are not templates here.
    const did2 = await newDb(admin, wid, 'Autre base');
    const plainRow = await row(did, 'Ligne normale');
    assert.equal((await admin.post(`/databases/${did2}/rows`, { templateId: tpl.id })).status, 404);
    assert.equal((await admin.post(`/databases/${did}/rows`, { templateId: plainRow.id })).status, 404);
    assert.equal((await admin.put(`/databases/${did2}/templates/default`, { templateId: tpl.id })).status, 404);
    assert.equal((await admin.put(`/databases/${did}/templates/default`, { templateId: plainRow.id })).status, 404);
    assert.equal((await admin.post(`/databases/${did}/templates`, { fromTemplateId: plainRow.id })).status, 404);
    // The member's private database never received anything.
    assert.equal((await member.get<RowsResponse>(`/databases/${priv}/rows`)).body.rows.length, 0);
    assert.equal(expectOk(await member.get<TemplatesResponse>(`/databases/${priv}/templates`)).rows.length, 1);
  });

  // -------------------------------------------------------------------------------------------
  // Value validation per type (computed types, numbers, dates, options, people, files…).
  // -------------------------------------------------------------------------------------------
  test('property values: computed types, malformed shapes, foreign people and unsafe file urls are refused', async () => {
    const did = await newDb(admin, wid, 'Validation QA');
    const types = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id'];
    const props: Record<string, string> = {};
    for (const type of types) props[type] = byName(await addProp(did, { name: type, type }), type).id;
    for (const type of ['number', 'date', 'select', 'person', 'files', 'text', 'checkbox', 'multi_select', 'url']) {
      props[type] = byName(await addProp(did, { name: type, type, ...(type.includes('select') ? { options: [{ id: 'ok', name: 'OK' }] } : {}) }), type).id;
    }
    const r = await row(did, 'R');
    for (const type of types) {
      assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [props[type]!]: 1 } })).status, 400, `write ${type}`);
      assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [props[type]!]: null } })).status, 400, `clear ${type}`);
      assert.equal((await admin.post(`/databases/${did}/import`, { rows: [{ properties: { [props[type]!]: 1 } }] })).status, 400, `import ${type}`);
    }
    // 1e400 parses as Infinity.
    const inf = await admin.req('PATCH', `/pages/${r.id}`, undefined, { rawBody: `{"properties":{"${props.number}":1e400}}`, contentType: 'application/json' });
    assert.equal(inf.status, 400);
    const bad: Array<[string, unknown]> = [
      ['number', '12'],
      ['date', { start: '2024-13-45' }],
      ['date', { start: '2024-01-01', end: 'demain' }],
      ['date', '2024-01-01'],
      ['select', 'inconnue'],
      ['select', ['ok']],
      ['multi_select', ['ok', 'inconnue']],
      ['person', [outsiderId]],
      ['person', 'x'],
      ['files', [{ name: 'x', url: 'javascript:alert(1)' }]],
      ['files', [{ name: 'x', url: 'data:text/html,<script>alert(1)</script>' }]],
      ['files', [{ name: { evil: 1 }, url: '/api/files/x/y' }]],
      ['text', { nested: { deep: 1 } }],
      ['text', 'x'.repeat(100_001)],
      ['checkbox', 'true'],
    ];
    for (const [type, value] of bad) {
      assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [props[type]!]: value } })).status, 400, `${type}: ${JSON.stringify(value).slice(0, 60)}`);
    }
    assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { inconnue: 'x' } })).status, 400);
    // Valid writes still work, and the person value accepts members only.
    const ok = await patchRow(r.id, { [props.person!]: [memberId], [props.number!]: 1.5, [props.date!]: { start: '2024-02-29' } });
    assert.deepEqual(ok.properties[props.person!], [memberId]);
    assert.ok(!(await rowsOf(did)).some((x) => Object.keys(x.properties).some((k) => [props.formula, props.rollup].includes(k))));
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-09: impossible calendar days were accepted (Date.parse rolls "2024-02-30" over to 1 March).
  // -------------------------------------------------------------------------------------------
  test('QA-DB-09: dates must be real calendar days', async () => {
    const did = await newDb(admin, wid, 'Dates QA9');
    const date = byName(await addProp(did, { name: 'Quand', type: 'date' }), 'Quand').id;
    const txt = byName(await addProp(did, { name: 'Texte', type: 'text' }), 'Texte').id;
    const r = await row(did, 'R', { [txt]: '2023-02-29' });
    for (const start of ['2024-02-30', '2023-02-29', '2024-04-31', '2024-06-31T10:00']) {
      assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [date]: { start } } })).status, 400, start);
    }
    assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [date]: { start: '2024-01-01', end: '2024-11-31' } } })).status, 400);
    assert.deepEqual((await patchRow(r.id, { [date]: { start: '2024-02-29', end: '2024-12-31T23:59' } })).properties[date], { start: '2024-02-29', end: '2024-12-31T23:59' });
    // Text → date conversion drops impossible days too.
    expectOk(await admin.patch(`/databases/${did}/properties/${txt}`, { type: 'date' }));
    assert.equal((await rowsOf(did)).find((x) => x.id === r.id)!.properties[txt], undefined);
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-10: rows (and templates) listed the e-mail of every referenced user — creator, last
  // editor, person values — former members included, to every reader.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-10: rows never expose the e-mail of a former member', async () => {
    const did = await newDb(admin, wid, 'Départ QA10');
    const person = byName(await addProp(did, { name: 'Qui', type: 'person' }), 'Qui').id;
    const { client: temp, user } = await addMember(admin, wid, 'qa-depart@oriel.test', 'Dora', 'member');
    await row(did, 'Écrite par Dora', { [person]: [user.id, memberId] }, temp);
    expectOk(await temp.post<Page>(`/databases/${did}/templates`, { title: 'Modèle de Dora' }));
    expectOk(await admin.del(`/workspaces/${wid}/members/${user.id}`));
    for (const c of [viewer, admin]) {
      const lists = [
        expectOk(await c.get<RowsResponse>(`/databases/${did}/rows`)).users,
        expectOk(await c.get<TemplatesResponse>(`/databases/${did}/templates`)).users,
      ];
      for (const users of lists) {
        assert.ok(!users.some((u) => u.email === 'qa-depart@oriel.test'));
        // Still displayed (creator, person value) by name, without e-mail; current members keep theirs.
        const dora = users.find((u) => u.id === user.id);
        assert.equal(dora?.name, 'Dora');
        assert.equal(dora?.email, '');
      }
      assert.equal(lists[0]!.find((u) => u.id === memberId)?.email, 'qa-membre@oriel.test');
    }
  });

  // -------------------------------------------------------------------------------------------
  // QA-DB-11: /api/public/pages/:id and the anonymous /collab connection served the row templates
  // of a published database (and their sub-pages) to anyone who knew their id.
  // -------------------------------------------------------------------------------------------
  test('QA-DB-11: row templates of a published database are not public', async () => {
    const host = await createPage(admin, wid, { title: 'Publiée QA11' });
    const did = await newDb(admin, wid, 'Base QA11', { parentType: 'page', parentId: host.id, isInline: true });
    const tpl = expectOk(await admin.post<Page>(`/databases/${did}/templates`, { title: 'Brouillon interne' }));
    const under = await createPage(admin, wid, { parentType: 'page', parentId: tpl.id, title: 'Sous-page du modèle' });
    const live = await row(did, 'Ligne publiée');
    expectOk(await admin.post(`/pages/${host.id}/publish`, { isPublic: true }));
    const anon = new Client(srv.base);
    assert.equal((await anon.get(`/public/pages/${tpl.id}`)).status, 404);
    assert.equal((await anon.get(`/public/pages/${under.id}`)).status, 404);
    expectOk(await anon.get(`/public/pages/${live.id}`));
    assert.deepEqual(expectOk(await anon.get<RowsResponse>(`/public/databases/${did}/rows`)).rows.map((r) => r.id), [live.id]);
    // Same rule for the anonymous real-time connection.
    assert.equal(await anonymousCollabAuth(srv.wsBase, tpl.id), 'denied');
    assert.equal(await anonymousCollabAuth(srv.wsBase, under.id), 'denied');
    assert.equal(await anonymousCollabAuth(srv.wsBase, live.id), 'authenticated');
    // Members still open the template, which is not reported as published.
    assert.equal(expectOk(await admin.get<PageDetailResponse>(`/pages/${tpl.id}`)).publiclyVisible, false);
    assert.equal(expectOk(await admin.get<PageDetailResponse>(`/pages/${live.id}`)).publiclyVisible, true);
  });

  test('QA-DB-12: a database in the trash is read-only', async () => {
    const did = await newDb(admin, wid, 'Corbeille QA12');
    const viewId = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views[0]!.id;
    expectOk(await admin.post(`/pages/${did}/trash`));
    assert.equal((await admin.post(`/databases/${did}/properties`, { property: { type: 'text' } })).status, 400);
    assert.equal((await admin.post(`/databases/${did}/views`, { name: 'x', type: 'table' })).status, 400);
    assert.equal((await admin.patch(`/views/${viewId}`, { name: 'renommée' })).status, 400);
    assert.equal((await admin.post(`/views/${viewId}/duplicate`)).status, 400);
    // Still readable, and writable again once restored.
    expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`));
    expectOk(await admin.post(`/pages/${did}/restore`));
    expectOk(await admin.patch(`/views/${viewId}`, { name: 'renommée' }));
  });

  test('bulk import: size limit and atomicity', async () => {
    const did = await newDb(admin, wid, 'Import QA');
    const num = byName(await addProp(did, { name: 'N', type: 'number' }), 'N').id;
    const tooMany = Array.from({ length: 5001 }, () => ({}));
    assert.equal((await admin.post(`/databases/${did}/import`, { rows: tooMany })).status, 400);
    // One invalid row: nothing is imported.
    const res = await admin.post(`/databases/${did}/import`, { rows: [{ title: 'A', properties: { [num]: 1 } }, { title: 'B', properties: { [num]: 'x' } }] });
    assert.equal(res.status, 400);
    assert.equal((await rowsOf(did)).length, 0, 'no partial import');
    // A trashed database refuses imports.
    expectOk(await admin.post(`/pages/${did}/trash`));
    assert.equal((await admin.post(`/databases/${did}/import`, { rows: [{ title: 'A' }] })).status, 400);
  });

  test('unique ids stay unique under concurrent row creation', async () => {
    const did = await newDb(admin, wid, 'Compteur QA');
    const uid = byName(await addProp(did, { name: 'ID', type: 'unique_id', uniqueIdPrefix: 'T' }), 'ID').id;
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => row(did, `R${i}`, {}, i % 2 ? member : admin)));
    const imported = expectOk(await admin.post<ImportRowsResponse>(`/databases/${did}/import`, { rows: [{ title: 'I1' }, { title: 'I2' }] }));
    assert.equal(imported.created, 2);
    const values = (await rowsOf(did)).map((r) => r.properties[uid]);
    assert.equal(values.length, 14);
    assert.equal(new Set(values).size, 14, `duplicates: ${values.join(',')}`);
    assert.ok(created.every((r) => typeof r.properties[uid] === 'number'));
  });

  // -------------------------------------------------------------------------------------------
  // Error handling: unknown ids → 404, corrupted JSON in the database → no 500.
  // -------------------------------------------------------------------------------------------
  test('unknown ids are 404 and corrupted stored JSON never causes a 500', async () => {
    const did = await newDb(admin, wid, 'Erreurs QA');
    const r = await row(did, 'R');
    const page = await createPage(admin, wid, { title: 'Page' });
    const unknown = randomUUID();
    const notFound: Array<[string, Promise<{ status: number }>]> = [
      ['view patch', admin.patch(`/views/${unknown}`, { name: 'x' })],
      ['view delete', admin.del(`/views/${unknown}`)],
      ['view move', admin.post(`/views/${unknown}/move`, { after: null })],
      ['view duplicate', admin.post(`/views/${unknown}/duplicate`)],
      ['db', admin.get(`/databases/${unknown}`)],
      ['db of a page', admin.get(`/databases/${page.id}`)],
      ['rows of a row', admin.get(`/databases/${r.id}/rows`)],
      ['property patch', admin.patch(`/databases/${did}/properties/zzzz`, { name: 'x' })],
      ['property delete', admin.del(`/databases/${did}/properties/zzzz`)],
      ['property move', admin.post(`/databases/${did}/properties/zzzz/move`, { after: null })],
      ['template', admin.post(`/databases/${did}/rows`, { templateId: unknown })],
      ['default template', admin.put(`/databases/${did}/templates/default`, { templateId: unknown })],
      ['properties on page', admin.post(`/databases/${page.id}/properties`, { property: { type: 'text' } })],
    ];
    for (const [label, p] of notFound) assert.equal((await p).status, 404, label);

    const viewId = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views[0]!.id;
    const raw = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      raw.prepare('UPDATE views SET config = ? WHERE id = ?').run('{not json', viewId);
      raw.prepare("UPDATE pages SET properties = '[1,' WHERE id = ?").run(r.id);
    } finally {
      raw.close();
    }
    expectOk(await admin.get(`/databases/${did}`));
    expectOk(await admin.get(`/databases/${did}/rows`));
    expectOk(await admin.patch<View>(`/views/${viewId}`, { name: 'Réparée', config: { wrap: true } }));
    expectOk(await admin.post(`/databases/${did}/properties`, { property: { name: 'Après', type: 'text' } }));
    expectOk(await admin.post(`/views/${viewId}/duplicate`));
    expectOk(await admin.patch(`/pages/${r.id}`, { title: 'Réparée' }));
  });
});
