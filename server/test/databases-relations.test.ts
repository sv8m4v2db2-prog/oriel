import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DatabaseResponse,
  DatabaseSchema,
  ImportRowsResponse,
  Page,
  PropertyDef,
  RowsResponse,
  TemplatesResponse,
  View,
} from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('databases: two-way relations, rollups, templates, linked views, import', () => {
  let srv: TestServer;
  let admin: Client;
  let viewer: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    ({ client: viewer } = await addMember(admin, wid, 'lecteur2@oriel.test', 'Léo', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  const newDb = async (title: string) => {
    const page = await createPage(admin, wid, { kind: 'database', title, emptyDatabase: true });
    return page.id;
  };
  const schemaOf = async (did: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
  const rowsOf = async (did: string) => expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
  const row = async (did: string, title: string, properties: Record<string, unknown> = {}) =>
    expectOk(await admin.post<Page>(`/databases/${did}/rows`, { title, properties }));
  const patch = async (id: string, properties: Record<string, unknown>) => expectOk(await admin.patch<Page>(`/pages/${id}`, { properties }));
  const valuesOf = async (did: string, propId: string) => {
    const out: Record<string, string[]> = {};
    for (const r of await rowsOf(did)) out[r.title] = ((r.properties[propId] as string[] | undefined) ?? []).slice().sort();
    return out;
  };
  const byName = (props: PropertyDef[], name: string) => props.find((p) => p.name === name)!;

  test('two-way relation: mirror creation and synchronised writes on both sides', async () => {
    const projets = await newDb('Projets');
    const taches = await newDb('Tâches');
    const schema = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, {
        property: { name: 'Projet', type: 'relation', relation: { databaseId: projets, syncedPropertyId: 'forged' } },
        twoWay: {},
      }),
    );
    const projet = byName(schema.properties, 'Projet');
    const mirror = byName(await schemaOf(projets), 'Tâches');
    assert.equal(projet.relation?.syncedPropertyId, mirror.id, 'server sets the synced id');
    assert.equal(mirror.type, 'relation');
    assert.deepEqual(mirror.relation, { databaseId: taches, syncedPropertyId: projet.id });
    // The mirror shows up in the target views.
    const targetViews = expectOk(await admin.get<DatabaseResponse>(`/databases/${projets}`)).views;
    assert.ok(targetViews[0]!.config.propertyOrder.includes(mirror.id));

    const alpha = await row(projets, 'Alpha');
    const beta = await row(projets, 'Béta');
    const t1 = await row(taches, 'T1', { [projet.id]: [alpha.id] });
    const t2 = await row(taches, 'T2');
    assert.deepEqual((await valuesOf(projets, mirror.id))['Alpha'], [t1.id]);

    // Write on the source side.
    await patch(t2.id, { [projet.id]: [alpha.id, beta.id] });
    let mv = await valuesOf(projets, mirror.id);
    assert.deepEqual(mv['Alpha'], [t1.id, t2.id].sort());
    assert.deepEqual(mv['Béta'], [t2.id]);
    // Write on the mirror side.
    await patch(beta.id, { [mirror.id]: [t1.id] });
    const sv = await valuesOf(taches, projet.id);
    assert.deepEqual(sv['T1'], [alpha.id, beta.id].sort());
    assert.deepEqual(sv['T2'], [alpha.id]);
    // Clearing a value.
    await patch(alpha.id, { [mirror.id]: null });
    assert.deepEqual((await valuesOf(taches, projet.id))['T1'], [beta.id]);
    assert.deepEqual((await valuesOf(taches, projet.id))['T2'], []);

    // Trash / restore of a row.
    expectOk(await admin.post(`/pages/${t1.id}/trash`));
    assert.deepEqual((await valuesOf(projets, mirror.id))['Béta'], []);
    expectOk(await admin.post(`/pages/${t1.id}/restore`));
    assert.deepEqual((await valuesOf(projets, mirror.id))['Béta'], [t1.id]);
    // Trash target, change source meanwhile is impossible to pick; restore re-links.
    expectOk(await admin.post(`/pages/${beta.id}/trash`));
    assert.deepEqual((await valuesOf(taches, projet.id))['T1'], []);
    expectOk(await admin.post(`/pages/${beta.id}/restore`));
    assert.deepEqual((await valuesOf(taches, projet.id))['T1'], [beta.id]);
    // Permanent delete removes the id everywhere.
    expectOk(await admin.post(`/pages/${beta.id}/trash`));
    expectOk(await admin.del(`/pages/${beta.id}`));
    assert.deepEqual((await valuesOf(taches, projet.id))['T1'], []);

    // Duplicating a row mirrors the copy.
    await patch(t2.id, { [projet.id]: [alpha.id] });
    const copy = expectOk(await admin.post<Page>(`/pages/${t2.id}/duplicate`));
    assert.deepEqual((await valuesOf(projets, mirror.id))['Alpha'], [t2.id, copy.id].sort());
  });

  test('two-way relation: single page limit, deletion modes, conversion', async () => {
    const equipes = await newDb('Équipes');
    const gens = await newDb('Personnes');
    const schema = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${gens}/properties`, {
        property: { name: 'Équipe', type: 'relation', relation: { databaseId: equipes, singlePage: true } },
        twoWay: { name: 'Membres' },
      }),
    );
    const equipe = byName(schema.properties, 'Équipe');
    const membres = byName(await schemaOf(equipes), 'Membres');
    const rouge = await row(equipes, 'Rouge');
    const bleue = await row(equipes, 'Bleue');
    const ana = await row(gens, 'Ana', { [equipe.id]: [rouge.id, bleue.id] });
    assert.deepEqual(ana.properties[equipe.id], [bleue.id], 'single page keeps the last value');
    assert.deepEqual((await valuesOf(equipes, membres.id))['Bleue'], [ana.id]);
    // Adding Ana to Rouge from the mirror side moves her (her single relation is replaced).
    await patch(rouge.id, { [membres.id]: [ana.id] });
    assert.deepEqual((await valuesOf(gens, equipe.id))['Ana'], [rouge.id]);
    assert.deepEqual((await valuesOf(equipes, membres.id))['Bleue'], []);

    // Turning the limit on truncates the existing values.
    await patch(rouge.id, { [membres.id]: [ana.id] });
    const bob = await row(gens, 'Bob', { [equipe.id]: [rouge.id] });
    expectOk(await admin.patch(`/databases/${equipes}/properties/${membres.id}`, { relation: { databaseId: gens, singlePage: true } }));
    const mv = await valuesOf(equipes, membres.id);
    assert.equal(mv['Rouge']!.length, 1);
    const kept = mv['Rouge']![0]!;
    const dropped = kept === ana.id ? 'Bob' : 'Ana';
    assert.deepEqual((await valuesOf(gens, equipe.id))[dropped], []);
    assert.ok([ana.id, bob.id].includes(kept));

    // Delete the source keeping the mirror: it becomes one-way.
    expectOk(await admin.del(`/databases/${gens}/properties/${equipe.id}?mirror=keep`));
    const m2 = byName(await schemaOf(equipes), 'Membres');
    assert.equal(m2.relation?.syncedPropertyId, undefined);

    // Recreate a two-way relation, then delete it together with its mirror.
    const s2 = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${gens}/properties`, {
        property: { name: 'Équipe 2', type: 'relation', relation: { databaseId: equipes } },
        twoWay: { name: 'Membres 2' },
      }),
    );
    const e2 = byName(s2.properties, 'Équipe 2');
    assert.ok(byName(await schemaOf(equipes), 'Membres 2'));
    expectOk(await admin.del(`/databases/${gens}/properties/${e2.id}?mirror=delete`));
    assert.equal((await schemaOf(equipes)).find((p) => p.name === 'Membres 2'), undefined);

    // Making an existing one-way relation two-way fills the mirror; converting it away unlinks.
    const s3 = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${gens}/properties`, {
        property: { name: 'Équipe 3', type: 'relation', relation: { databaseId: equipes } },
      }),
    );
    const e3 = byName(s3.properties, 'Équipe 3');
    await patch(ana.id, { [e3.id]: [bleue.id] });
    expectOk(await admin.patch(`/databases/${gens}/properties/${e3.id}`, { twoWay: { name: 'Membres 3' } }));
    const m3 = byName(await schemaOf(equipes), 'Membres 3');
    assert.deepEqual((await valuesOf(equipes, m3.id))['Bleue'], [ana.id]);
    expectOk(await admin.patch(`/databases/${gens}/properties/${e3.id}`, { type: 'text' }));
    assert.equal(byName(await schemaOf(equipes), 'Membres 3').relation?.syncedPropertyId, undefined);
    // Turning two-way off deletes the mirror.
    const s4 = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${gens}/properties`, {
        property: { name: 'Équipe 4', type: 'relation', relation: { databaseId: equipes } },
        twoWay: { name: 'Membres 4' },
      }),
    );
    const e4 = byName(s4.properties, 'Équipe 4');
    expectOk(await admin.patch(`/databases/${gens}/properties/${e4.id}`, { twoWay: null }));
    assert.equal((await schemaOf(equipes)).find((p) => p.name === 'Membres 4'), undefined);
    assert.equal(byName(await schemaOf(gens), 'Équipe 4').relation?.syncedPropertyId, undefined);
  });

  test('two-way self relation (Bloqué par / Bloque) and database trash', async () => {
    const taches = await newDb('Planning');
    const schema = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${taches}/properties`, {
        property: { name: 'Bloqué par', type: 'relation', relation: { databaseId: taches } },
        twoWay: { name: 'Bloque' },
      }),
    );
    const bloquePar = byName(schema.properties, 'Bloqué par');
    const bloque = byName(schema.properties, 'Bloque');
    assert.equal(bloquePar.relation?.syncedPropertyId, bloque.id);
    assert.equal(bloque.relation?.syncedPropertyId, bloquePar.id);
    const a = await row(taches, 'A');
    const b = await row(taches, 'B', { [bloquePar.id]: [a.id] });
    assert.deepEqual((await valuesOf(taches, bloque.id))['A'], [b.id]);
    const c = await row(taches, 'C');
    await patch(a.id, { [bloque.id]: [b.id, c.id] });
    assert.deepEqual((await valuesOf(taches, bloquePar.id))['C'], [a.id]);
    // A row related to itself.
    await patch(c.id, { [bloquePar.id]: [a.id, c.id] });
    const vals = await valuesOf(taches, bloque.id);
    assert.deepEqual(vals['C'], [c.id]);
    // Trashing and restoring the whole database keeps the internal links.
    expectOk(await admin.post(`/pages/${taches}/trash`));
    expectOk(await admin.post(`/pages/${taches}/restore`));
    assert.deepEqual((await valuesOf(taches, bloque.id))['A'], [b.id, c.id].sort());
    assert.deepEqual((await valuesOf(taches, bloquePar.id))['B'], [a.id]);
    // Duplicating the database keeps the pair inside the copy.
    const dup = expectOk(await admin.post<Page>(`/pages/${taches}/duplicate`));
    const dupSchema = await schemaOf(dup.id);
    assert.equal(byName(dupSchema, 'Bloqué par').relation?.syncedPropertyId, bloque.id);
    const dupVals = await valuesOf(dup.id, bloque.id);
    const dupRows = await rowsOf(dup.id);
    const idOf = (t: string) => dupRows.find((r) => r.title === t)!.id;
    assert.deepEqual(dupVals['A'], [idOf('B'), idOf('C')].sort());
  });

  test('rollup properties are stored as computed definitions', async () => {
    const d = await newDb('Rollups');
    const rel = byName(
      expectOk(await admin.post<DatabaseSchema>(`/databases/${d}/properties`, { property: { name: 'Lien', type: 'relation', relation: { databaseId: d } } }))
        .properties,
      'Lien',
    );
    const s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${d}/properties`, {
        property: { name: 'Somme', type: 'rollup', rollup: { relationPropertyId: rel.id, targetPropertyId: 'title', function: 'count_all' } },
      }),
    );
    const roll = byName(s.properties, 'Somme');
    assert.deepEqual(roll.rollup, { relationPropertyId: rel.id, targetPropertyId: 'title', function: 'count_all' });
    const r = await row(d, 'X');
    assert.equal((await admin.patch(`/pages/${r.id}`, { properties: { [roll.id]: 3 } })).status, 400);
    expectOk(await admin.patch(`/databases/${d}/properties/${roll.id}`, { rollup: { relationPropertyId: rel.id, targetPropertyId: 'title', function: 'percent_empty' } }));
    assert.equal(byName(await schemaOf(d), 'Somme').rollup?.function, 'percent_empty');
    assert.equal(
      (await admin.post(`/databases/${d}/properties`, { property: { name: 'Bad', type: 'rollup', rollup: { relationPropertyId: rel.id, targetPropertyId: 'x', function: 'nope' } } })).status,
      400,
    );
  });

  test('row templates: hidden from rows, default, creating a row from a template', async () => {
    const d = await newDb('Projets modèles');
    const tags = byName(
      expectOk(await admin.post<DatabaseSchema>(`/databases/${d}/properties`, { property: { name: 'Fait', type: 'checkbox' } })).properties,
      'Fait',
    );
    const tpl = expectOk(await admin.post<Page>(`/databases/${d}/templates`, { title: 'Nouveau projet' }));
    expectOk(await admin.patch(`/pages/${tpl.id}`, { properties: { [tags.id]: true } }));
    // A sub-page inside the template is duplicated too.
    await createPage(admin, wid, { parentType: 'page', parentId: tpl.id, title: 'Rétro-planning' });
    assert.equal((await rowsOf(d)).length, 0, 'templates are not rows');
    let tpls = expectOk(await admin.get<TemplatesResponse>(`/databases/${d}/templates`));
    assert.deepEqual(
      tpls.rows.map((r) => r.id),
      [tpl.id],
    );
    assert.equal(tpls.defaultTemplateId, null);
    tpls = expectOk(await admin.put<TemplatesResponse>(`/databases/${d}/templates/default`, { templateId: tpl.id }));
    assert.equal(tpls.defaultTemplateId, tpl.id);
    assert.equal((await viewer.put(`/databases/${d}/templates/default`, { templateId: null })).status, 403);

    const id = crypto.randomUUID();
    const created = expectOk(await admin.post<Page>(`/databases/${d}/rows`, { id, templateId: tpl.id, title: 'Projet X' }));
    assert.equal(created.id, id);
    assert.equal(created.title, 'Projet X');
    assert.equal(created.properties[tags.id], true);
    const rows = await rowsOf(d);
    assert.deepEqual(
      rows.map((r) => r.id),
      [id],
    );
    const tree = expectOk(await admin.get<{ nodes: Array<{ parentId: string; title: string }> }>(`/workspaces/${wid}/tree`));
    assert.ok(tree.nodes.some((n) => n.parentId === id && n.title === 'Rétro-planning'), 'sub-pages are copied');
    // Duplicating a template keeps it a template.
    const copy = expectOk(await admin.post<Page>(`/databases/${d}/templates`, { fromTemplateId: tpl.id }));
    tpls = expectOk(await admin.get<TemplatesResponse>(`/databases/${d}/templates`));
    assert.equal(tpls.rows.length, 2);
    assert.ok(tpls.rows.some((r) => r.id === copy.id));
    assert.equal((await rowsOf(d)).length, 1);
    // A template that is not one is rejected.
    assert.equal((await admin.post(`/databases/${d}/rows`, { templateId: id })).status, 404);
    // Trashed templates disappear from the list and lose the default.
    expectOk(await admin.post(`/pages/${tpl.id}/trash`));
    tpls = expectOk(await admin.get<TemplatesResponse>(`/databases/${d}/templates`));
    assert.equal(tpls.defaultTemplateId, null);
    assert.deepEqual(
      tpls.rows.map((r) => r.id),
      [copy.id],
    );
  });

  test('linked database views: own views per link id, native views untouched', async () => {
    const d = await newDb('Source');
    const native = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views;
    const linkId = crypto.randomUUID();
    const linked = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}?linkId=${linkId}`));
    assert.equal(linked.views.length, 1);
    assert.equal(linked.views[0]!.linkId, linkId);
    assert.notEqual(linked.views[0]!.id, native[0]!.id);
    // Same link id → same views.
    const again = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}?linkId=${linkId}`));
    assert.equal(again.views[0]!.id, linked.views[0]!.id);
    // Creating a view in the linked group.
    const v = expectOk(await admin.post<View>(`/databases/${d}/views`, { name: 'Kanban', type: 'board', linkId }));
    assert.equal(v.linkId, linkId);
    const nativeAfter = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views;
    assert.deepEqual(
      nativeAfter.map((x) => x.id),
      native.map((x) => x.id),
    );
    assert.ok(nativeAfter.every((x) => x.linkId === null));
    const linkedAfter = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}?linkId=${linkId}`)).views;
    assert.equal(linkedAfter.length, 2);
    // Filters are per view.
    expectOk(await admin.patch(`/views/${linkedAfter[0]!.id}`, { config: { filter: { conjunction: 'and', rules: [], groups: [{ conjunction: 'or', rules: [] }] } } }));
    // Deleting: at least one view per group.
    expectOk(await admin.del(`/views/${v.id}`));
    assert.equal((await admin.del(`/views/${linkedAfter[0]!.id}`)).status, 409);
    // Duplicate stays in the group.
    const dupView = expectOk(await admin.post<View>(`/views/${linkedAfter[0]!.id}/duplicate`));
    assert.equal(dupView.linkId, linkId);
    // Duplicating the database copies native views only.
    const dupDb = expectOk(await admin.post<Page>(`/pages/${d}/duplicate`));
    assert.equal(expectOk(await admin.get<DatabaseResponse>(`/databases/${dupDb.id}`)).views.length, native.length);
    // Readers never create views: before an editor opened the block they get the native views.
    const fresh = crypto.randomUUID();
    const seen = expectOk(await viewer.get<DatabaseResponse>(`/databases/${d}?linkId=${fresh}`)).views;
    assert.ok(seen.every((x) => x.linkId === null));
    assert.ok(expectOk(await viewer.get<DatabaseResponse>(`/databases/${d}?linkId=${linkId}`)).views.every((x) => x.linkId === linkId));
    // Property creation updates linked view orders too.
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${d}/properties`, { property: { name: 'Note', type: 'text' } }));
    const note = byName(s.properties, 'Note');
    const lv = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}?linkId=${linkId}`)).views;
    assert.ok(lv.every((x) => x.config.propertyOrder.includes(note.id)));
  });

  test('CSV import endpoint: create and update by title', async () => {
    const d = await newDb('Import');
    const s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${d}/properties`, {
        property: { name: 'Prix', type: 'number' },
      }),
    );
    const prix = byName(s.properties, 'Prix');
    let res = expectOk(
      await admin.post<ImportRowsResponse>(`/databases/${d}/import`, {
        rows: [
          { title: 'A', properties: { [prix.id]: 1 } },
          { title: 'B', properties: { [prix.id]: 2 } },
        ],
      }),
    );
    assert.deepEqual(res, { created: 2, updated: 0 });
    res = expectOk(
      await admin.post<ImportRowsResponse>(`/databases/${d}/import`, {
        rows: [
          { title: 'a', properties: { [prix.id]: 10 } },
          { title: 'C', properties: { [prix.id]: 3 } },
        ],
        updateByTitle: true,
      }),
    );
    assert.deepEqual(res, { created: 1, updated: 1 });
    const rows = await rowsOf(d);
    assert.deepEqual(
      rows.map((r) => [r.title, r.properties[prix.id]]),
      [
        ['A', 10],
        ['B', 2],
        ['C', 3],
      ],
    );
    assert.equal((await admin.post(`/databases/${d}/import`, { rows: [{ title: 'X', properties: { [prix.id]: 'abc' } }] })).status, 400);
    assert.equal((await rowsOf(d)).length, 3, 'failed import is rolled back');
    assert.equal((await viewer.post(`/databases/${d}/import`, { rows: [] })).status, 403);
  });
});
