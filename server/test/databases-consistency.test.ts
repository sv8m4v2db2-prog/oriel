// Two-way relation consistency across every write path (database module).
// Invariant checked after each step, for live rows: t ∈ r.A ⇔ r ∈ t.B (templates excluded).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseResponse, DatabaseSchema, ImportRowsResponse, Page, PropertyDef, RowsResponse, TemplatesResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('databases: two-way relation consistency', () => {
  let srv: TestServer;
  let admin: Client;
  let member: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    ({ client: member } = await addMember(admin, wid, 'membre-rel@oriel.test', 'Marc', 'member'));
  });
  after(async () => {
    await srv.stop();
  });

  const newDb = async (title: string, extra: Record<string, unknown> = {}) =>
    (await createPage(admin, wid, { kind: 'database', title, emptyDatabase: true, ...extra })).id;
  const schemaOf = async (did: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
  const rowsOf = async (did: string) => expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
  const row = async (did: string, title: string, properties: Record<string, unknown> = {}, client = admin) =>
    expectOk(await client.post<Page>(`/databases/${did}/rows`, { title, properties }));
  const patch = async (id: string, properties: Record<string, unknown>, client = admin) =>
    expectOk(await client.patch<Page>(`/pages/${id}`, { properties }));
  const byName = (props: PropertyDef[], name: string) => {
    const p = props.find((x) => x.name === name);
    assert.ok(p, `property ${name}`);
    return p;
  };
  const ids = (v: unknown) => ((v as string[] | undefined) ?? []).slice().sort();
  const titlesOf = async (did: string, propId: string) => {
    const rows = await rowsOf(did);
    const all = new Map<string, string>();
    for (const d of new Set([did, ...((await schemaOf(did)).filter((p) => p.type === 'relation').map((p) => p.relation!.databaseId))])) {
      for (const r of await rowsOf(d)) all.set(r.id, r.title);
    }
    const out: Record<string, string[]> = {};
    for (const r of rows) out[r.title] = ids(r.properties[propId]).map((id) => all.get(id) ?? `?${id}`).sort();
    return out;
  };

  /**
   * Asserts the two-way invariant between `s.a` and `t.b` for live rows. A live row may still list a
   * trashed row (latent link, restored with it): such ids are ignored here (`latent`: allowed count).
   */
  const checkPair = async (s: string, a: string, t: string, b: string, latent = 0) => {
    const sRows = await rowsOf(s);
    const tRows = s === t ? sRows : await rowsOf(t);
    const sById = new Map(sRows.map((r) => [r.id, r]));
    const tById = new Map(tRows.map((r) => [r.id, r]));
    let hidden = 0;
    for (const r of sRows) {
      for (const x of ids(r.properties[a])) {
        const target = tById.get(x);
        if (!target) {
          hidden++;
          continue;
        }
        assert.ok(ids(target.properties[b]).includes(r.id), `${target.title}.${b} should list ${r.title}`);
      }
    }
    for (const r of tRows) {
      for (const x of ids(r.properties[b])) {
        const source = sById.get(x);
        if (!source) {
          hidden++;
          continue;
        }
        assert.ok(ids(source.properties[a]).includes(r.id), `${source.title}.${a} should list ${r.title}`);
      }
    }
    assert.equal(hidden, latent, 'latent links to trashed rows');
  };

  const twoWay = async (s: string, t: string, name: string, mirrorName: string, relation: Record<string, unknown> = {}) => {
    const schema = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${s}/properties`, {
        property: { name, type: 'relation', relation: { databaseId: t, ...relation } },
        twoWay: { name: mirrorName },
      }),
    );
    const a = byName(schema.properties, name);
    const b = byName(await schemaOf(t), mirrorName);
    return { a: a.id, b: b.id };
  };

  test('row templates are kept out of the mirror; rows created from them are mirrored', async () => {
    const projets = await newDb('Projets T');
    const taches = await newDb('Tâches T');
    const { a, b } = await twoWay(taches, projets, 'Projet', 'Tâches');
    const alpha = await row(projets, 'Alpha');
    const tpl = expectOk(await admin.post<Page>(`/databases/${taches}/templates`, { title: 'Tâche type' }));
    await patch(tpl.id, { [a]: [alpha.id] });
    assert.deepEqual(ids((await patch(tpl.id, {}))?.properties[a]), [alpha.id], 'the template keeps its value');
    assert.deepEqual((await titlesOf(projets, b))['Alpha'], [], 'a template never appears in a mirror');
    await checkPair(taches, a, projets, b);

    // A row created from the template is mirrored.
    const created = expectOk(await admin.post<Page>(`/databases/${taches}/rows`, { templateId: tpl.id, title: 'Dessin' }));
    assert.deepEqual(ids(created.properties[a]), [alpha.id]);
    assert.deepEqual((await titlesOf(projets, b))['Alpha'], ['Dessin']);
    await checkPair(taches, a, projets, b);

    // The mirror side cannot link a template either (the id is dropped).
    const res = await patch(alpha.id, { [b]: [created.id, tpl.id] });
    assert.deepEqual(ids(res.properties[b]), [created.id]);
    await checkPair(taches, a, projets, b);

    // Duplicating the template keeps the copy out of the mirror.
    expectOk(await admin.post<Page>(`/databases/${taches}/templates`, { fromTemplateId: tpl.id }));
    assert.deepEqual((await titlesOf(projets, b))['Alpha'], ['Dessin']);

    // Making an existing relation two-way ignores template values too.
    const s2 = expectOk(await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, { property: { name: 'Projet 2', type: 'relation', relation: { databaseId: projets } } }));
    const a2 = byName(s2.properties, 'Projet 2').id;
    await patch(tpl.id, { [a2]: [alpha.id] });
    await patch(created.id, { [a2]: [alpha.id] });
    expectOk(await admin.patch(`/databases/${taches}/properties/${a2}`, { twoWay: { name: 'Tâches 2' } }));
    const b2 = byName(await schemaOf(projets), 'Tâches 2').id;
    assert.deepEqual((await titlesOf(projets, b2))['Alpha'], ['Dessin']);
    await checkPair(taches, a2, projets, b2);
    const tpls = expectOk(await admin.get<TemplatesResponse>(`/databases/${taches}/templates`));
    assert.equal(tpls.rows.length, 2);
  });

  test('ids that cannot hold the link back are dropped (unknown pages, other databases, invisible rows)', async () => {
    const pub = await newDb('Public');
    const priv = await newDb('Privée', { visibility: 'private' });
    const other = await newDb('Autre');
    const { a, b } = await twoWay(pub, priv, 'Secret', 'Retour');
    const s1 = await row(priv, 'S1');
    const o1 = await row(other, 'O1');
    const p1 = await row(pub, 'P1', { [a]: [s1.id, o1.id, crypto.randomUUID()] });
    assert.deepEqual(ids(p1.properties[a]), [s1.id], 'only rows of the target database are kept');
    await checkPair(pub, a, priv, b);
    // A member cannot see the private database: forging its row ids does not write into it.
    assert.equal((await member.get(`/databases/${priv}/rows`)).status, 404);
    const mine = await row(pub, 'P2', {}, member);
    const res = await patch(mine.id, { [a]: [s1.id] }, member);
    assert.deepEqual(ids(res.properties[a]), []);
    assert.deepEqual((await titlesOf(priv, b))['S1'], ['P1']);
    await checkPair(pub, a, priv, b);
    // Unlinking always applies (the private row loses the member's row when it is unlinked).
    const res2 = await patch(p1.id, { [a]: null }, member);
    assert.deepEqual(ids(res2.properties[a]), []);
    assert.deepEqual((await titlesOf(priv, b))['S1'], []);
    await checkPair(pub, a, priv, b);
  });

  test('self relation: duplicate, trash/restore in any order, permanent delete', async () => {
    const plan = await newDb('Rétro-planning');
    const { a, b } = await twoWay(plan, plan, 'Bloqué par', 'Bloque');
    const t1 = await row(plan, 'Cadrage');
    const t2 = await row(plan, 'Dessin', { [a]: [t1.id] });
    const t3 = await row(plan, 'Bilan', { [a]: [t2.id] });
    const t4 = await row(plan, 'Recette', { [a]: [t2.id, t3.id] });
    await checkPair(plan, a, plan, b);
    assert.deepEqual((await titlesOf(plan, b))['Dessin'], ['Recette', 'Bilan'].sort());

    // Duplicating a row copies its blockers and mirrors them; the copy blocks nothing.
    const copy = expectOk(await admin.post<Page>(`/pages/${t4.id}/duplicate`));
    assert.deepEqual(ids(copy.properties[a]), [t2.id, t3.id].sort());
    assert.deepEqual(ids(copy.properties[b]), []);
    await checkPair(plan, a, plan, b);

    // Trash t2 then t3, restore t2 then t3: links come back.
    expectOk(await admin.post(`/pages/${t2.id}/trash`));
    await checkPair(plan, a, plan, b);
    expectOk(await admin.post(`/pages/${t3.id}/trash`));
    await checkPair(plan, a, plan, b);
    assert.deepEqual((await titlesOf(plan, a))['Recette'], []);
    expectOk(await admin.post(`/pages/${t2.id}/restore`));
    // Dessin still lists the trashed Bilan (it comes back with it).
    await checkPair(plan, a, plan, b, 1);
    expectOk(await admin.post(`/pages/${t3.id}/restore`));
    await checkPair(plan, a, plan, b);
    assert.deepEqual((await titlesOf(plan, a))['Recette'], ['Dessin', 'Bilan'].sort());
    assert.deepEqual((await titlesOf(plan, a))['Bilan'], ['Dessin']);

    // Restore in the reverse order of the trash.
    expectOk(await admin.post(`/pages/${t1.id}/trash`));
    expectOk(await admin.post(`/pages/${t2.id}/trash`));
    expectOk(await admin.post(`/pages/${t1.id}/restore`));
    await checkPair(plan, a, plan, b, 1);
    expectOk(await admin.post(`/pages/${t2.id}/restore`));
    await checkPair(plan, a, plan, b);
    assert.deepEqual((await titlesOf(plan, a))['Dessin'], ['Cadrage']);

    // Permanent delete.
    expectOk(await admin.post(`/pages/${t2.id}/trash`));
    expectOk(await admin.del(`/pages/${t2.id}`));
    await checkPair(plan, a, plan, b);
    assert.deepEqual((await titlesOf(plan, a))['Recette'], ['Bilan']);
  });

  test('permanent deletion of a related database unlinks the pair', async () => {
    const s = await newDb('Source D');
    const t = await newDb('Cible D');
    const { a, b } = await twoWay(s, t, 'Cible', 'Source');
    const x = await row(t, 'X');
    const r = await row(s, 'R', { [a]: [x.id] });
    expectOk(await admin.post(`/pages/${t}/trash`));
    assert.deepEqual(ids((await rowsOf(s)).find((p) => p.id === r.id)!.properties[a]), [], 'trashed rows leave the mirror');
    expectOk(await admin.post(`/pages/${t}/restore`));
    assert.deepEqual(ids((await rowsOf(s)).find((p) => p.id === r.id)!.properties[a]), [x.id], 'restored rows come back');
    await checkPair(s, a, t, b);
    expectOk(await admin.post(`/pages/${t}/trash`));
    expectOk(await admin.del(`/pages/${t}`));
    const def = byName(await schemaOf(s), 'Cible');
    assert.equal(def.relation?.syncedPropertyId, undefined);
    assert.deepEqual(ids((await rowsOf(s)).find((p) => p.id === r.id)!.properties[a]), []);
    // Writes on the orphan relation do not fail.
    await patch(r.id, { [a]: [] });
  });

  test('CSV import and bulk updates keep both sides in sync', async () => {
    const s = await newDb('Clients');
    const t = await newDb('Factures');
    const { a, b } = await twoWay(t, s, 'Client', 'Factures', { singlePage: true });
    const c1 = await row(s, 'Client Alpha');
    const c2 = await row(s, 'Fondation Nord');
    const res = expectOk(
      await admin.post<ImportRowsResponse>(`/databases/${t}/import`, {
        rows: [
          { title: 'F-001', properties: { [a]: [c1.id] } },
          { title: 'F-002', properties: { [a]: [c1.id] } },
          { title: 'F-003', properties: { [a]: [c2.id] } },
        ],
      }),
    );
    assert.deepEqual(res, { created: 3, updated: 0 });
    await checkPair(t, a, s, b);
    assert.deepEqual((await titlesOf(s, b))['Client Alpha'], ['F-001', 'F-002']);
    // Update by title moves an invoice to another client (single page: replaced on both sides).
    expectOk(await admin.post(`/databases/${t}/import`, { rows: [{ title: 'F-002', properties: { [a]: [c2.id] } }], updateByTitle: true }));
    await checkPair(t, a, s, b);
    assert.deepEqual((await titlesOf(s, b))['Fondation Nord'], ['F-002', 'F-003']);
    // The mirror side takes an invoice from the other client.
    await patch(c1.id, { [b]: [(await rowsOf(t)).find((r) => r.title === 'F-003')!.id] });
    await checkPair(t, a, s, b);
    assert.deepEqual((await titlesOf(t, a))['F-003'], ['Client Alpha']);
    assert.deepEqual((await titlesOf(s, b))['Fondation Nord'], ['F-002']);
  });

  test('type conversion: text ↔ relation by title (migration of imported relations)', async () => {
    const projets = await newDb('Projets C');
    const taches = await newDb('Tâches C');
    for (const t of ['Documentaire, saison 2', 'Spot ONG', 'Clip']) await row(projets, t);
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, { property: { name: 'Projet', type: 'text' } }));
    const p = byName(s.properties, 'Projet').id;
    await row(taches, 'T1', { [p]: 'Documentaire, saison 2, Spot ONG' });
    await row(taches, 'T2', { [p]: 'spot ong (Projets%20C/Spot%20ONG%20abc.md)' });
    await row(taches, 'T3', { [p]: 'Inconnu, Clip' });
    await row(taches, 'T4', { [p]: 'Rien' });
    expectOk(await admin.patch(`/databases/${taches}/properties/${p}`, { type: 'relation', relation: { databaseId: projets }, twoWay: { name: 'Tâches' } }));
    assert.deepEqual(await titlesOf(taches, p), {
      T1: ['Documentaire, saison 2', 'Spot ONG'].sort(),
      T2: ['Spot ONG'],
      T3: ['Clip'],
      T4: [],
    });
    const mirror = byName(await schemaOf(projets), 'Tâches').id;
    await checkPair(taches, p, projets, mirror);
    assert.deepEqual((await titlesOf(projets, mirror))['Spot ONG'], ['T1', 'T2']);

    // Relation → text: titles of the related pages; the mirror stays as a one-way relation.
    expectOk(await admin.patch(`/databases/${taches}/properties/${p}`, { type: 'text' }));
    const rows = await rowsOf(taches);
    assert.equal(rows.find((r) => r.title === 'T3')!.properties[p], 'Clip');
    assert.equal(rows.find((r) => r.title === 'T4')!.properties[p], undefined);
    assert.equal(byName(await schemaOf(projets), 'Tâches').relation?.syncedPropertyId, undefined);

    // Multi-select → relation (single page keeps the last match).
    const s2 = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, {
        property: { name: 'Tags', type: 'multi_select', options: [{ name: 'Clip', color: 'red' }, { name: 'Spot ONG', color: 'blue' }] },
      }),
    );
    const tags = byName(s2.properties, 'Tags');
    const [clip, spot] = tags.options!;
    await patch(rows.find((r) => r.title === 'T1')!.id, { [tags.id]: [clip!.id, spot!.id] });
    expectOk(await admin.patch(`/databases/${taches}/properties/${tags.id}`, { type: 'relation', relation: { databaseId: projets, singlePage: true } }));
    assert.deepEqual((await titlesOf(taches, tags.id))['T1'], ['Spot ONG']);
    // Relation → multi-select: one option per title.
    expectOk(await admin.patch(`/databases/${taches}/properties/${tags.id}`, { type: 'multi_select' }));
    const def = byName(await schemaOf(taches), 'Tags');
    assert.deepEqual(def.options!.map((o) => o.name), ['Spot ONG']);
  });

  test('pairing two imported one-way relations into a two-way relation (values merged)', async () => {
    // Both sides of a relation imported as text, converted to relations, then paired.
    const projets = await newDb('Projets P');
    const taches = await newDb('Tâches P');
    const p = byName(expectOk(await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, { property: { name: 'Projet', type: 'text' } })).properties, 'Projet').id;
    const t = byName(expectOk(await admin.post<DatabaseSchema>(`/databases/${projets}/properties`, { property: { name: 'Tâches', type: 'text' } })).properties, 'Tâches').id;
    await row(projets, 'Alpha', { [t]: 'Dessin, Recette' });
    await row(projets, 'Béta', { [t]: 'Bilan' });
    await row(taches, 'Dessin', { [p]: 'Alpha' });
    await row(taches, 'Recette', { [p]: 'Alpha' });
    await row(taches, 'Bilan', { [p]: 'Alpha' }); // the other side says Béta: merged
    await row(taches, 'Cadrage', { [p]: 'Béta' }); // only listed on this side
    expectOk(await admin.patch(`/databases/${taches}/properties/${p}`, { type: 'relation', relation: { databaseId: projets } }));
    expectOk(await admin.patch(`/databases/${projets}/properties/${t}`, { type: 'relation', relation: { databaseId: taches } }));
    // Invalid pairings are refused.
    assert.equal((await admin.patch(`/databases/${taches}/properties/${p}`, { twoWay: { pairWith: 'nope' } })).status, 400);
    expectOk(await admin.patch(`/databases/${taches}/properties/${p}`, { twoWay: { pairWith: t } }));
    const ps = byName(await schemaOf(taches), 'Projet');
    const ts = byName(await schemaOf(projets), 'Tâches');
    assert.equal(ps.relation?.syncedPropertyId, t);
    assert.equal(ts.relation?.syncedPropertyId, p);
    assert.equal((await schemaOf(projets)).filter((x) => x.type === 'relation').length, 1, 'no extra mirror created');
    await checkPair(taches, p, projets, t);
    assert.deepEqual(await titlesOf(projets, t), { Alpha: ['Dessin', 'Recette', 'Bilan'].sort(), Béta: ['Bilan', 'Cadrage'].sort() });
    // Both sides stay in sync afterwards.
    const cadrage = (await rowsOf(taches)).find((r) => r.title === 'Cadrage')!;
    await patch(cadrage.id, { [p]: [] });
    assert.deepEqual((await titlesOf(projets, t))['Béta'], ['Bilan']);
    // A synced property cannot be paired again.
    const other = byName(expectOk(await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, { property: { name: 'Projet 2', type: 'relation', relation: { databaseId: projets } } })).properties, 'Projet 2').id;
    assert.equal((await admin.patch(`/databases/${taches}/properties/${other}`, { twoWay: { pairWith: t } })).status, 400);
  });

  test('self relation: pairing « Bloqué par » with an existing « Bloque »', async () => {
    const plan = await newDb('Planning P');
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${plan}/properties`, { property: { name: 'Bloqué par', type: 'relation', relation: { databaseId: plan } } }));
    const a = byName(s.properties, 'Bloqué par').id;
    const b = byName(expectOk(await admin.post<DatabaseSchema>(`/databases/${plan}/properties`, { property: { name: 'Bloque', type: 'relation', relation: { databaseId: plan } } })).properties, 'Bloque').id;
    const x = await row(plan, 'X');
    const y = await row(plan, 'Y', { [a]: [x.id] });
    const z = await row(plan, 'Z');
    await patch(x.id, { [b]: [z.id] }); // Z blocked by X, only stated on X
    assert.equal((await admin.patch(`/databases/${plan}/properties/${a}`, { twoWay: { pairWith: a } })).status, 400, 'not with itself');
    expectOk(await admin.patch(`/databases/${plan}/properties/${a}`, { twoWay: { pairWith: b } }));
    await checkPair(plan, a, plan, b);
    assert.deepEqual(await titlesOf(plan, b), { X: ['Y', 'Z'], Y: [], Z: [] });
    assert.deepEqual(ids((await rowsOf(plan)).find((r) => r.id === z.id)!.properties[a]), [x.id]);
    void y;
  });
});
