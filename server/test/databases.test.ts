import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseResponse, DatabaseSchema, Page, PageDetailResponse, PropertyDef, RowsResponse, TreeResponse, View } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';

describe('databases', () => {
  let srv: TestServer;
  let admin: Client;
  let viewer: Client;
  let wid: string;
  let adminId: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    adminId = s.session.user.id;
    ({ client: viewer } = await addMember(admin, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
  });
  after(async () => {
    await srv.stop();
  });

  const newDb = async (title = 'Tâches', extra: Record<string, unknown> = {}) => {
    const page = await createPage(admin, wid, { kind: 'database', title, ...extra });
    return { page, info: expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`)) };
  };
  const rowsOf = async (did: string) => expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
  const addProp = async (did: string, property: Record<string, unknown> & { type: PropertyDef['type'] }, after?: string | null) =>
    expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property, after }));

  test('default schema, view and rows', async () => {
    const { page, info } = await newDb();
    assert.equal(page.kind, 'database');
    assert.equal(info.canEdit, true);
    assert.equal(info.schema.id, page.id);
    assert.equal(info.schema.workspaceId, wid);
    assert.equal(info.schema.properties.length, 2);
    assert.deepEqual(info.schema.properties[0], { id: 'title', name: 'Nom', type: 'title' });
    assert.equal(info.schema.properties[1]!.name, 'Étiquettes');
    assert.equal(info.schema.properties[1]!.type, 'multi_select');
    assert.match(info.schema.properties[1]!.id, /^[a-z0-9]{4,8}$/);
    assert.equal(info.views.length, 1);
    assert.equal(info.views[0]!.name, 'Tableau');
    assert.equal(info.views[0]!.type, 'table');
    assert.deepEqual(info.views[0]!.config.propertyOrder, ['title', info.schema.properties[1]!.id]);
    const rows = await rowsOf(page.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.parentType === 'database' && r.parentId === page.id && r.title === ''));
    assert.ok(rows[0]!.position < rows[1]!.position && rows[1]!.position < rows[2]!.position);
    // rows are not in the tree
    const tree = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`));
    assert.ok(tree.nodes.some((n) => n.id === page.id));
    assert.ok(!tree.nodes.some((n) => rows.some((r) => r.id === n.id)));
    // empty database
    const empty = await createPage(admin, wid, { kind: 'database', title: 'Vide', emptyDatabase: true });
    assert.equal((await rowsOf(empty.id)).length, 0);
    // viewer sees but cannot edit
    const vinfo = expectOk(await viewer.get<DatabaseResponse>(`/databases/${page.id}`));
    assert.equal(vinfo.canEdit, false);
    assert.equal((await viewer.post(`/databases/${page.id}/rows`, {})).status, 403);
  });

  test('rows: create with properties, unique ids, row page detail', async () => {
    const { page, info } = await newDb('Tickets');
    const tags = info.schema.properties[1]!;
    let schema = await addProp(page.id, { name: 'ID', type: 'unique_id', uniqueIdPrefix: 'TASK' });
    const uid = schema.properties.find((p) => p.type === 'unique_id')!;
    // existing rows were numbered
    const numbered = await rowsOf(page.id);
    assert.deepEqual(
      numbered.map((r) => r.properties[uid.id]).sort(),
      [1, 2, 3],
    );
    schema = expectOk(
      await admin.patch<DatabaseSchema>(`/databases/${page.id}/properties/${tags.id}`, {
        options: [
          { id: 'bug', name: 'Bug', color: 'red' },
          { id: 'idee', name: 'Idée', color: 'blue' },
        ],
      }),
    );
    const row = expectOk(
      await admin.post<Page>(`/databases/${page.id}/rows`, { title: 'Corriger le login', properties: { [tags.id]: ['bug'] }, after: null }),
    );
    assert.equal(row.title, 'Corriger le login');
    assert.deepEqual(row.properties[tags.id], ['bug']);
    assert.equal(row.properties[uid.id], 4);
    const rows = await rowsOf(page.id);
    assert.equal(rows[0]!.id, row.id, 'after:null inserts first');
    const detail = expectOk(await admin.get<PageDetailResponse>(`/pages/${row.id}`));
    assert.equal(detail.parentDatabase?.id, page.id);
    assert.deepEqual(
      detail.ancestors.map((a) => a.id),
      [page.id],
    );
    const res = expectOk(await admin.get<RowsResponse>(`/databases/${page.id}/rows`));
    assert.ok(res.users.some((u) => u.id === adminId));
    // also through the generic page endpoint
    const viaPages = await createPage(admin, wid, { parentType: 'database', parentId: page.id, title: 'Autre' });
    assert.equal(viaPages.properties[uid.id], 5);
    // row reordering stays within the database
    expectOk(await admin.post(`/pages/${viaPages.id}/move`, { parentType: 'database', parentId: page.id, after: null }));
    assert.equal((await rowsOf(page.id))[0]!.id, viaPages.id);
    assert.equal((await admin.post(`/pages/${viaPages.id}/move`, { parentType: 'workspace', parentId: wid })).status, 400);
  });

  test('property value validation', async () => {
    const { page, info } = await newDb('Validation');
    const tags = info.schema.properties[1]!;
    await addProp(page.id, { name: 'Prix', type: 'number', numberFormat: 'euro' });
    await addProp(page.id, { name: 'Fait', type: 'checkbox' });
    await addProp(page.id, { name: 'Échéance', type: 'date' });
    await addProp(page.id, { name: 'Statut', type: 'status' });
    await addProp(page.id, { name: 'Responsable', type: 'person' });
    const schema = await addProp(page.id, { name: 'Créé', type: 'created_time' });
    const byName = (n: string) => schema.properties.find((p) => p.name === n)!;
    const status = byName('Statut');
    assert.deepEqual(
      status.options!.map((o) => [o.name, o.group]),
      [
        ['Pas commencé', 'todo'],
        ['En cours', 'in_progress'],
        ['Terminé', 'done'],
      ],
    );
    const [row] = await rowsOf(page.id);
    const patch = (properties: Record<string, unknown>) => admin.patch(`/pages/${row!.id}`, { properties });

    const ok = expectOk(
      await patch({
        [byName('Prix').id]: 12.5,
        [byName('Fait').id]: true,
        [byName('Échéance').id]: { start: '2026-10-13', end: '2026-10-20' },
        [status.id]: status.options![1]!.id,
        [byName('Responsable').id]: [adminId],
      }),
    );
    assert.equal(ok.properties[byName('Prix').id], 12.5);
    assert.deepEqual(ok.properties[byName('Échéance').id], { start: '2026-10-13', end: '2026-10-20' });

    const bad: Array<[string, unknown]> = [
      [byName('Prix').id, 'douze'],
      [byName('Fait').id, 'oui'],
      [byName('Échéance').id, { start: 'demain' }],
      [status.id, 'inconnu'],
      [tags.id, ['nope']],
      [byName('Responsable').id, ['not-a-member-id']],
      [byName('Créé').id, 123],
      ['zzzz', 'x'],
    ];
    for (const [key, value] of bad) {
      const res = await patch({ [key]: value });
      assert.equal(res.status, 400, `${key} = ${JSON.stringify(value)}`);
      assert.equal(res.body.error.code, 'validation');
    }
    // null clears
    const cleared = expectOk(await patch({ [byName('Prix').id]: null }));
    assert.ok(!(byName('Prix').id in cleared.properties));
    // properties on a non-row page are rejected
    const plain = await createPage(admin, wid, { title: 'Simple' });
    assert.equal((await admin.patch(`/pages/${plain.id}`, { properties: { x: 1 } })).status, 400);
    // the title property cannot be deleted or retyped, a second title cannot be created
    assert.equal((await admin.del(`/databases/${page.id}/properties/title`)).status, 400);
    assert.equal((await admin.patch(`/databases/${page.id}/properties/title`, { type: 'text' })).status, 400);
    assert.equal((await admin.post(`/databases/${page.id}/properties`, { property: { name: 'T2', type: 'title' } })).status, 400);
    // relation needs a visible target database
    assert.equal((await admin.post(`/databases/${page.id}/properties`, { property: { name: 'Rel', type: 'relation' } })).status, 400);
    const withRel = await addProp(page.id, { name: 'Rel', type: 'relation', relation: { databaseId: page.id } });
    assert.ok(withRel.properties.some((p) => p.type === 'relation' && p.relation?.databaseId === page.id));
  });

  test('property type conversion', async () => {
    const { page } = await newDb('Conversion');
    let schema = await addProp(page.id, { name: 'Texte', type: 'text' });
    const text = schema.properties.find((p) => p.name === 'Texte')!;
    const rows = await rowsOf(page.id);
    const values = ['42', 'Oui', 'rouge, vert'];
    for (const [i, v] of values.entries()) expectOk(await admin.patch(`/pages/${rows[i]!.id}`, { properties: { [text.id]: v } }));

    // text → number
    schema = expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'number' }));
    let current = await rowsOf(page.id);
    assert.equal(current.find((r) => r.id === rows[0]!.id)!.properties[text.id], 42);
    assert.ok(!(text.id in current.find((r) => r.id === rows[1]!.id)!.properties));
    // number → text
    expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'text' }));
    current = await rowsOf(page.id);
    assert.equal(current.find((r) => r.id === rows[0]!.id)!.properties[text.id], '42');

    // text → select creates options
    for (const [i, v] of values.entries()) expectOk(await admin.patch(`/pages/${rows[i]!.id}`, { properties: { [text.id]: v } }));
    schema = expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'select' }));
    let def = schema.properties.find((p) => p.id === text.id)!;
    assert.equal(def.type, 'select');
    assert.deepEqual(
      def.options!.map((o) => o.name).sort(),
      ['42', 'Oui', 'rouge, vert'],
    );
    current = await rowsOf(page.id);
    const optOui = def.options!.find((o) => o.name === 'Oui')!;
    assert.equal(current.find((r) => r.id === rows[1]!.id)!.properties[text.id], optOui.id);

    // select → status keeps options, group todo
    schema = expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'status' }));
    def = schema.properties.find((p) => p.id === text.id)!;
    assert.ok(def.options!.every((o) => o.group === 'todo'));
    assert.equal((await rowsOf(page.id)).find((r) => r.id === rows[1]!.id)!.properties[text.id], optOui.id);

    // status → multi_select → value wrapped
    schema = expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'multi_select' }));
    assert.deepEqual((await rowsOf(page.id)).find((r) => r.id === rows[1]!.id)!.properties[text.id], [optOui.id]);
    // multi_select → text → names
    expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'text' }));
    assert.equal((await rowsOf(page.id)).find((r) => r.id === rows[1]!.id)!.properties[text.id], 'Oui');
    // text → checkbox (« Oui » → coché)
    expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'checkbox' }));
    current = await rowsOf(page.id);
    assert.equal(current.find((r) => r.id === rows[1]!.id)!.properties[text.id], true);
    assert.equal(current.find((r) => r.id === rows[0]!.id)!.properties[text.id], false);
    // checkbox → text (« Oui » / vide)
    expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'text' }));
    current = await rowsOf(page.id);
    assert.equal(current.find((r) => r.id === rows[1]!.id)!.properties[text.id], 'Oui');
    assert.ok(!(text.id in current.find((r) => r.id === rows[0]!.id)!.properties));
    // → computed type clears values
    expectOk(await admin.patch(`/databases/${page.id}/properties/${text.id}`, { type: 'formula', formula: 'prop("Nom")' }));
    current = await rowsOf(page.id);
    assert.ok(current.every((r) => !(text.id in r.properties)));
  });

  test('option removal and property deletion clean rows and views', async () => {
    const { page, info } = await newDb('Nettoyage');
    const tags = info.schema.properties[1]!;
    let schema = await addProp(page.id, { name: 'Phase', type: 'select', options: [{ name: 'A', color: 'green' }, { name: 'B', color: 'blue' }] });
    const phase = schema.properties.find((p) => p.name === 'Phase')!;
    const [optA, optB] = phase.options!;
    schema = expectOk(
      await admin.patch<DatabaseSchema>(`/databases/${page.id}/properties/${tags.id}`, {
        options: [
          { id: 'x', name: 'X', color: 'gray' },
          { id: 'y', name: 'Y', color: 'pink' },
        ],
      }),
    );
    const [r1, r2] = await rowsOf(page.id);
    expectOk(await admin.patch(`/pages/${r1!.id}`, { properties: { [phase.id]: optA!.id, [tags.id]: ['x', 'y'] } }));
    expectOk(await admin.patch(`/pages/${r2!.id}`, { properties: { [phase.id]: optB!.id, [tags.id]: ['x'] } }));

    // remove option B of "Phase" and option x of tags
    expectOk(await admin.patch(`/databases/${page.id}/properties/${phase.id}`, { options: [optA] }));
    expectOk(await admin.patch(`/databases/${page.id}/properties/${tags.id}`, { options: [{ id: 'y', name: 'Y', color: 'pink' }] }));
    let rows = await rowsOf(page.id);
    assert.equal(rows.find((r) => r.id === r1!.id)!.properties[phase.id], optA!.id);
    assert.ok(!(phase.id in rows.find((r) => r.id === r2!.id)!.properties));
    assert.deepEqual(rows.find((r) => r.id === r1!.id)!.properties[tags.id], ['y']);
    assert.ok(!(tags.id in rows.find((r) => r.id === r2!.id)!.properties));

    // a board grouped by Phase with filters/sorts referencing it
    const view = expectOk(
      await admin.post<View>(`/databases/${page.id}/views`, {
        name: 'Par phase',
        type: 'board',
        config: {
          groupBy: phase.id,
          filter: { conjunction: 'and', rules: [{ id: 'f1', propertyId: phase.id, operator: 'is_not_empty' }] },
          sorts: [{ propertyId: phase.id, direction: 'asc' }],
          hiddenProperties: [phase.id],
          propertyWidths: { [phase.id]: 200 },
          calculations: { [phase.id]: 'count_values' },
        },
      }),
    );
    assert.equal(view.config.groupBy, phase.id);
    schema = expectOk(await admin.del<DatabaseSchema>(`/databases/${page.id}/properties/${phase.id}`));
    assert.ok(!schema.properties.some((p) => p.id === phase.id));
    rows = await rowsOf(page.id);
    assert.ok(rows.every((r) => !(phase.id in r.properties)));
    const info2 = expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`));
    const cleaned = info2.views.find((v) => v.id === view.id)!;
    assert.equal(cleaned.config.groupBy, null);
    assert.deepEqual(cleaned.config.filter?.rules, []);
    assert.deepEqual(cleaned.config.sorts, []);
    assert.ok(!cleaned.config.propertyOrder.includes(phase.id));
    assert.ok(!cleaned.config.hiddenProperties.includes(phase.id));
    assert.deepEqual(cleaned.config.propertyWidths, {});
    assert.deepEqual(cleaned.config.calculations, {});
  });

  test('property create position, move and view propertyOrder', async () => {
    const { page, info } = await newDb('Ordre');
    const tags = info.schema.properties[1]!;
    let schema = await addProp(page.id, { name: 'Début', type: 'text' }, null);
    assert.equal(schema.properties[0]!.name, 'Début');
    schema = await addProp(page.id, { name: 'Milieu', type: 'text' }, 'title');
    assert.deepEqual(
      schema.properties.map((p) => p.name),
      ['Début', 'Nom', 'Milieu', 'Étiquettes'],
    );
    const milieu = schema.properties.find((p) => p.name === 'Milieu')!;
    const views = expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`)).views;
    assert.deepEqual(views[0]!.config.propertyOrder.slice(0, 3), [schema.properties[0]!.id, 'title', milieu.id]);
    schema = expectOk(await admin.post<DatabaseSchema>(`/databases/${page.id}/properties/${milieu.id}/move`, { after: tags.id }));
    assert.deepEqual(
      schema.properties.map((p) => p.name),
      ['Début', 'Nom', 'Étiquettes', 'Milieu'],
    );
    const renamed = expectOk(await admin.patch<DatabaseSchema>(`/databases/${page.id}/properties/${milieu.id}`, { name: 'Fin' }));
    assert.equal(renamed.properties.at(-1)!.name, 'Fin');
    assert.ok(renamed.version > info.schema.version);
  });

  test('views CRUD', async () => {
    const { page, info } = await newDb('Vues');
    const table = info.views[0]!;
    const schema = await addProp(page.id, { name: 'Statut', type: 'status' });
    const status = schema.properties.find((p) => p.type === 'status')!;
    const board = expectOk(await admin.post<View>(`/databases/${page.id}/views`, { name: 'Kanban', type: 'board' }));
    assert.equal(board.config.groupBy, status.id);
    assert.ok(board.position > table.position);
    const cal = expectOk(await admin.post<View>(`/databases/${page.id}/views`, { name: 'Calendrier', type: 'calendar', after: null }));
    assert.ok(cal.position < table.position);
    const updated = expectOk(
      await admin.patch<View>(`/views/${board.id}`, { name: 'Tableau Kanban', config: { cardSize: 'large', wrap: true } }),
    );
    assert.equal(updated.name, 'Tableau Kanban');
    assert.equal(updated.config.cardSize, 'large');
    assert.equal(updated.config.groupBy, status.id, 'shallow merge keeps other keys');
    assert.equal(updated.version, 2);
    const asTable = expectOk(await admin.patch<View>(`/views/${board.id}`, { type: 'table' }));
    assert.equal(asTable.type, 'table');
    const moved = expectOk(await admin.post<View>(`/views/${board.id}/move`, { after: null }));
    assert.ok(moved.position < cal.position);
    const currentTable = expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`)).views.find((v) => v.id === table.id)!;
    assert.ok(currentTable.config.propertyOrder.includes(status.id), 'new property appended to existing views');
    const copy = expectOk(await admin.post<View>(`/views/${table.id}/duplicate`));
    assert.equal(copy.name, 'Tableau (copie)');
    assert.deepEqual(copy.config, currentTable.config);
    const bad = await admin.patch(`/views/${table.id}`, { config: { cardSize: 'géante' } });
    assert.equal(bad.status, 400);
    expectOk(await admin.del(`/views/${cal.id}`));
    expectOk(await admin.del(`/views/${copy.id}`));
    expectOk(await admin.del(`/views/${board.id}`));
    const last = await admin.del(`/views/${table.id}`);
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, 'conflict');
    assert.equal((await viewer.patch(`/views/${table.id}`, { name: 'x' })).status, 403);
    const listed = expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`)).views;
    assert.deepEqual(
      listed.map((v) => v.id),
      [table.id],
    );
  });

  test('trashing a row hides it; restoring brings it back', async () => {
    const { page } = await newDb('Corbeille lignes');
    const [row] = await rowsOf(page.id);
    expectOk(await admin.post(`/pages/${row!.id}/trash`));
    assert.equal((await rowsOf(page.id)).length, 2);
    const trash = expectOk(await admin.get(`/workspaces/${wid}/trash`));
    assert.ok(trash.items.some((i: { page: Page }) => i.page.id === row!.id));
    const restored = expectOk(await admin.post<Page>(`/pages/${row!.id}/restore`));
    assert.equal(restored.parentId, page.id);
    assert.equal((await rowsOf(page.id)).length, 3);
  });
});
