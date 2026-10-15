// I1 — manual order per view (native and linked views), and advanced row templates: default template per
// view, conversion of an existing row, recurring templates (background job) and « cette page » remapping.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, type TemplateRecurrence, type DatabaseResponse, type DatabaseSchema, type Page, type RowsResponse, type TemplatesResponse, type View } from '@oriel/shared';
import WebSocket from 'ws';
import type { Change, ServerMessage } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, signup, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import type { AppContext } from '../src/context.js';
import { runTemplateRecurrences } from '../src/services/templateRecurrence.js';

function parisMs(date: string, hour: number, minute = 0): number {
  for (const offset of [1, 2]) {
    const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - offset, minute);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (Number(parts) === hour) return t;
  }
  throw new Error('no Paris time');
}

describe('I1: manual order per view', () => {
  let srv: TestServer;
  let admin: Client;
  let viewer: Client;
  let outsider: Client;
  let wid: string;
  let ctx: AppContext;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ({ client: viewer } = await addMember(admin, wid, 'lecteur-i1@oriel.test', 'Lou', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    ({ client: outsider } = await signup(srv.base, 'dehors-i1@oriel.test', 'Dehors'));
    ctx = collabContexts.get(srv.dataDir)!;
  });
  after(async () => {
    await srv.stop();
  });

  async function setup(title: string) {
    const dbPage = await createPage(admin, wid, { kind: 'database', title, emptyDatabase: true });
    const rows: Page[] = [];
    for (const t of ['A', 'B', 'C', 'D']) rows.push(expectOk(await admin.post<Page>(`/databases/${dbPage.id}/rows`, { title: t })));
    const first = expectOk(await admin.get<DatabaseResponse>(`/databases/${dbPage.id}`)).views[0]!;
    const second = expectOk(await admin.post<View>(`/databases/${dbPage.id}/views`, { name: 'Kanban', type: 'board' }));
    return { did: dbPage.id, rows, first, second };
  }

  /** Titles of the rows in the effective manual order of a view (stored order, else page position). */
  function ordered(view: View, rows: Page[]): string[] {
    const key = (r: Page) => view.rowOrder?.[r.id] ?? r.position;
    return [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1)).map((r) => r.title);
  }

  test('two views of one database keep their own order after reloading', async () => {
    const { did, rows, first, second } = await setup('Ordre');
    const [a, b, c, d] = rows;
    // View 1: D first. View 2: A after C.
    expectOk(await admin.post(`/views/${first.id}/rows/move`, { rowId: d!.id, after: null }));
    const moved = expectOk(await admin.post<{ viewId: string; rowOrder: Record<string, string> }>(`/views/${second.id}/rows/move`, { rowId: a!.id, after: c!.id }));
    assert.equal(moved.viewId, second.id);
    assert.ok(moved.rowOrder[a!.id]);

    const reloaded = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`));
    const live = expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
    const v1 = reloaded.views.find((v) => v.id === first.id)!;
    const v2 = reloaded.views.find((v) => v.id === second.id)!;
    assert.deepEqual(ordered(v1, live), ['D', 'A', 'B', 'C']);
    assert.deepEqual(ordered(v2, live), ['B', 'C', 'A', 'D']);
    // The page positions (fallback of views without a manual order) are unchanged.
    assert.deepEqual(live.map((r) => r.title), ['A', 'B', 'C', 'D']);
    assert.equal(live.find((r) => r.id === b!.id)!.position, b!.position);

    // A view without a manual order falls back to the page position.
    const third = expectOk(await admin.post<View>(`/databases/${did}/views`, { name: 'Liste', type: 'list' }));
    assert.deepEqual(ordered(third, live), ['A', 'B', 'C', 'D']);
    assert.equal(third.rowOrder, undefined);
  });

  test('a linked view keeps an order independent of the native views', async () => {
    const { did, rows, first } = await setup('Liée');
    const linkId = crypto.randomUUID();
    const linked = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}?linkId=${linkId}`)).views[0]!;
    assert.equal(linked.linkId, linkId);
    expectOk(await admin.post(`/views/${linked.id}/rows/move`, { rowId: rows[2]!.id, after: null }));
    expectOk(await admin.post(`/views/${first.id}/rows/move`, { rowId: rows[0]!.id, after: rows[3]!.id }));
    const live = expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
    const linkedNow = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}?linkId=${linkId}`)).views[0]!;
    const nativeNow = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === first.id)!;
    assert.deepEqual(ordered(linkedNow, live), ['C', 'A', 'B', 'D']);
    assert.deepEqual(ordered(nativeNow, live), ['B', 'C', 'D', 'A']);
  });

  test('a duplicated view starts with the same order', async () => {
    const { did, rows, first } = await setup('Copie');
    expectOk(await admin.post(`/views/${first.id}/rows/move`, { rowId: rows[3]!.id, after: rows[0]!.id }));
    const copy = expectOk(await admin.post<View>(`/views/${first.id}/duplicate`));
    const live = expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
    assert.deepEqual(ordered(copy, live), ['A', 'D', 'B', 'C']);
    // Moving in the copy leaves the original alone.
    expectOk(await admin.post(`/views/${copy.id}/rows/move`, { rowId: rows[0]!.id, after: rows[2]!.id }));
    const views = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views;
    assert.deepEqual(ordered(views.find((v) => v.id === first.id)!, live), ['A', 'D', 'B', 'C']);
    assert.deepEqual(ordered(views.find((v) => v.id === copy.id)!, live), ['D', 'B', 'C', 'A']);
  });

  test('equal imported positions are renumbered for the view, not for the pages', async () => {
    const { did, rows, first } = await setup('Égalités');
    for (const r of rows) ctx.db.run('UPDATE pages SET position = ? WHERE id = ?', 'a0', r.id);
    const sorted = [...rows].sort((x, y) => (x.id < y.id ? -1 : 1));
    // Between two rows sharing a position: impossible without renumbering.
    expectOk(await admin.post(`/views/${first.id}/rows/move`, { rowId: sorted[3]!.id, after: sorted[0]!.id }));
    const live = expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;
    const view = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === first.id)!;
    assert.deepEqual(ordered(view, live), [sorted[0], sorted[3], sorted[1], sorted[2]].map((r) => r!.title));
    assert.ok(live.every((r) => r.position === 'a0'), 'page positions untouched');
  });

  test('access: readers cannot reorder, invisible views and foreign rows are 404', async () => {
    const { first, rows } = await setup('Accès');
    const other = await setup('Autre');
    assert.equal((await viewer.post(`/views/${first.id}/rows/move`, { rowId: rows[0]!.id, after: null })).status, 403);
    assert.equal((await outsider.post(`/views/${first.id}/rows/move`, { rowId: rows[0]!.id, after: null })).status, 404);
    assert.equal((await admin.post(`/views/${first.id}/rows/move`, { rowId: other.rows[0]!.id, after: null })).status, 404);
    // A private database of another member: its views do not exist for the others.
    const { client: member } = await addMember(admin, wid, 'membre-i1@oriel.test', 'Max', 'member');
    const priv = await createPage(admin, wid, { kind: 'database', title: 'Privée', emptyDatabase: true, visibility: 'private' });
    const privRow = expectOk(await admin.post<Page>(`/databases/${priv.id}/rows`, { title: 'Secret' }));
    const pv = expectOk(await admin.get<DatabaseResponse>(`/databases/${priv.id}`)).views[0]!;
    assert.equal((await member.post(`/views/${pv.id}/rows/move`, { rowId: privRow.id, after: null })).status, 404);
    // Trashed and template rows cannot be ordered.
    const tpl = expectOk(await admin.post<Page>(`/databases/${first.databaseId}/templates`, { title: 'Modèle' }));
    assert.equal((await admin.post(`/views/${first.id}/rows/move`, { rowId: tpl.id, after: null })).status, 404);
  });

  test('a move invalidates the view through /api/events', async () => {
    const { rows, second } = await setup('Temps réel');
    const ws = new WebSocket(`${srv.wsBase}/api/events`, { headers: { cookie: `oriel_session=${viewer.cookie}` } });
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise((r) => ws.on('open', r));
    try {
      ws.send(JSON.stringify({ type: 'subscribe', workspaceId: wid }));
      await waitFor(() => messages.find((m) => m.type === 'subscribed'));
      expectOk(await admin.post(`/views/${second.id}/rows/move`, { rowId: rows[3]!.id, after: null }));
      const changes = (): Change[] => messages.flatMap((m) => (m.type === 'changes' ? m.changes : []));
      const change = await waitFor(() => changes().find((c) => c.entity === 'view' && c.id === second.id));
      assert.equal(change.entity === 'view' && change.databaseId, second.databaseId);
    } finally {
      ws.close();
    }
  });

  test('the order of a deleted view or row goes with it', async () => {
    const { did, rows, first, second } = await setup('Suppression');
    expectOk(await admin.post(`/views/${second.id}/rows/move`, { rowId: rows[0]!.id, after: null }));
    expectOk(await admin.del(`/views/${second.id}`));
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM database_view_row_order WHERE view_id = ?', second.id)!.n, 0);
    expectOk(await admin.post(`/views/${first.id}/rows/move`, { rowId: rows[1]!.id, after: null }));
    expectOk(await admin.post(`/pages/${rows[1]!.id}/trash`));
    const view = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === first.id)!;
    assert.equal(view.rowOrder?.[rows[1]!.id], undefined, 'trashed rows are left out');
  });
});

describe('I1: advanced row templates', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let ctx: AppContext;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ctx = collabContexts.get(srv.dataDir)!;
  });
  after(async () => {
    await srv.stop();
  });

  const propId = (schema: DatabaseSchema, name: string) => schema.properties.find((p) => p.name === name)!.id;

  test('default template per view: a template of the database, blank, or the database default', async () => {
    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Défauts', emptyDatabase: true });
    const view = expectOk(await admin.get<DatabaseResponse>(`/databases/${dbPage.id}`)).views[0]!;
    const tpl = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/templates`, { title: 'Réunion' }));
    const row = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/rows`, { title: 'Ligne' }));
    const other = await createPage(admin, wid, { kind: 'database', title: 'Autre', emptyDatabase: true });
    const foreign = expectOk(await admin.post<Page>(`/databases/${other.id}/templates`, { title: 'Ailleurs' }));

    const set = expectOk(await admin.patch<View>(`/views/${view.id}`, { config: { defaultTemplateId: tpl.id } }));
    assert.equal(set.config.defaultTemplateId, tpl.id);
    assert.equal(expectOk(await admin.patch<View>(`/views/${view.id}`, { config: { defaultTemplateId: 'blank' } })).config.defaultTemplateId, 'blank');
    assert.equal(expectOk(await admin.patch<View>(`/views/${view.id}`, { config: { defaultTemplateId: null } })).config.defaultTemplateId, null);
    assert.equal((await admin.patch(`/views/${view.id}`, { config: { defaultTemplateId: row.id } })).status, 400, 'a row is not a template');
    assert.equal((await admin.patch(`/views/${view.id}`, { config: { defaultTemplateId: foreign.id } })).status, 400, 'template of another database');
    // The database default is independent of the view default.
    expectOk(await admin.put(`/databases/${dbPage.id}/templates/default`, { templateId: tpl.id }));
    const second = expectOk(await admin.post<View>(`/databases/${dbPage.id}/views`, { name: 'Vierge', type: 'table', config: { defaultTemplateId: 'blank' } }));
    assert.equal(second.config.defaultTemplateId, 'blank');
    assert.equal(expectOk(await admin.get<TemplatesResponse>(`/databases/${dbPage.id}/templates`)).defaultTemplateId, tpl.id);
  });

  test('an existing row with its sub-pages becomes a template', async () => {
    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Conversion', emptyDatabase: true });
    const row = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/rows`, { title: 'Projet type' }));
    const child = await createPage(admin, wid, { parentType: 'page', parentId: row.id, title: 'Checklist' });

    const tpl = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/templates`, { fromRowId: row.id }));
    assert.equal(tpl.title, 'Projet type');
    const templates = expectOk(await admin.get<TemplatesResponse>(`/databases/${dbPage.id}/templates`));
    assert.ok(templates.rows.some((r) => r.id === tpl.id));
    const children = ctx.db.all<{ title: string }>("SELECT title FROM pages WHERE parent_type = 'page' AND parent_id = ? AND trashed_at IS NULL", tpl.id);
    assert.deepEqual(children.map((c) => c.title), ['Checklist'], 'sub-pages copied');
    // The original stays a visible row (default) …
    let rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    assert.ok(rows.some((r) => r.id === row.id));
    assert.ok(!rows.some((r) => r.id === tpl.id), 'the template is hidden from the views');
    // … or goes to the trash on request.
    const tpl2 = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/templates`, { fromRowId: row.id, title: 'Projet v2', trashOriginal: true }));
    assert.equal(tpl2.title, 'Projet v2');
    rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbPage.id}/rows`)).rows;
    assert.ok(!rows.some((r) => r.id === row.id), 'original in the trash');
    assert.ok(ctx.db.get('SELECT 1 AS x FROM pages WHERE id = ? AND trashed_at IS NULL', child.id) === undefined);
    // Only live rows of this database can be converted.
    const other = await createPage(admin, wid, { kind: 'database', title: 'Autre', emptyDatabase: true });
    const foreign = expectOk(await admin.post<Page>(`/databases/${other.id}/rows`, { title: 'X' }));
    assert.equal((await admin.post(`/databases/${dbPage.id}/templates`, { fromRowId: foreign.id })).status, 404);
    assert.equal((await admin.post(`/databases/${dbPage.id}/templates`, { fromRowId: row.id })).status, 404, 'trashed row');
    assert.equal((await admin.post(`/databases/${dbPage.id}/templates`, { fromRowId: tpl.id })).status, 404, 'already a template');
  });

  test('a recurring template creates one row at the right moment, never twice', async () => {
    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Hebdo', emptyDatabase: true });
    const tpl = expectOk(await admin.post<Page>(`/databases/${dbPage.id}/templates`, { title: 'Point hebdo' }));
    const startDate = '2031-03-03'; // a Monday
    assert.equal((await admin.put(`/databases/${dbPage.id}/templates/${tpl.id}/recurrence`, { recurrence: { frequency: 'weekly', interval: 1, startDate, time: '25:00' } })).status, 400);
    assert.equal((await admin.put(`/databases/${dbPage.id}/templates/${crypto.randomUUID()}/recurrence`, { recurrence: { frequency: 'daily', interval: 1, startDate, time: '09:00' } })).status, 404);
    const res = expectOk(
      await admin.put<TemplatesResponse>(`/databases/${dbPage.id}/templates/${tpl.id}/recurrence`, {
        recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 4], startDate, time: '09:30' },
      }),
    );
    const info = res.recurrences!.find((r) => r.templateId === tpl.id)!;
    assert.equal(info.nextRun, '2031-03-03T09:30');

    const rowsOf = async () => expectOk(await admin.get<RowsResponse>(`/databases/${dbPage.id}/rows`));
    const count = async () => (await rowsOf()).rows.length;
    assert.equal(runTemplateRecurrences(ctx, parisMs(startDate, 9, 29)), 0, 'not before 09:30');
    assert.equal(runTemplateRecurrences(ctx, parisMs(startDate, 9, 30)), 1, 'at 09:30');
    assert.equal(runTemplateRecurrences(ctx, parisMs(startDate, 9, 31)), 0, 'once');
    const created = (await rowsOf()).rows;
    assert.equal(created.length, 1);
    assert.equal(created[0]!.title, 'Point hebdo');
    let state = expectOk(await admin.get<TemplatesResponse>(`/databases/${dbPage.id}/templates`)).recurrences![0]!;
    assert.equal(state.nextRun, '2031-03-06T09:30', 'next: Thursday');
    assert.equal(state.lastRowId, created[0]!.id);

    // A restart that lost the schedule state replays the same occurrence: the claim prevents a duplicate.
    ctx.db.run("UPDATE database_template_recurrences SET next_run = '2031-03-03T09:30' WHERE template_id = ?", tpl.id);
    assert.equal(runTemplateRecurrences(ctx, parisMs(startDate, 9, 45)), 0);
    assert.equal(await count(), 1);

    // After a long downtime, a single catch-up row, and the schedule moves to the future.
    ctx.db.run("UPDATE database_template_recurrences SET next_run = '2031-03-06T09:30' WHERE template_id = ?", tpl.id);
    assert.equal(runTemplateRecurrences(ctx, parisMs('2031-03-20', 12)), 1);
    assert.equal(await count(), 2);
    state = expectOk(await admin.get<TemplatesResponse>(`/databases/${dbPage.id}/templates`)).recurrences![0]!;
    assert.equal(state.nextRun, '2031-03-24T09:30');

    // A template in the trash creates nothing; stopping the recurrence removes it.
    expectOk(await admin.post(`/pages/${tpl.id}/trash`));
    assert.equal(runTemplateRecurrences(ctx, parisMs('2031-03-24', 10)), 0);
    assert.equal(await count(), 2);
    expectOk(await admin.post(`/pages/${tpl.id}/restore`));
    const stopped = expectOk(await admin.put<TemplatesResponse>(`/databases/${dbPage.id}/templates/${tpl.id}/recurrence`, { recurrence: null }));
    assert.equal(stopped.recurrences!.length, 0);
  });

  test('« cette page »: relations and filters pointing at the template follow the new row', async () => {
    const projects = await createPage(admin, wid, { kind: 'database', title: 'Projets', emptyDatabase: true });
    let pschema = expectOk(await admin.post<DatabaseSchema>(`/databases/${projects.id}/properties`, { property: { name: 'Parent', type: 'relation', relation: { databaseId: projects.id } } }));
    const parentProp = propId(pschema, 'Parent');
    const tpl = expectOk(await admin.post<Page>(`/databases/${projects.id}/templates`, { title: 'Projet' }));
    // The template points at itself.
    expectOk(await admin.patch(`/pages/${tpl.id}`, { properties: { [parentProp]: [tpl.id] } }));

    // Inside the template: a tasks database whose rows point at the template, and a filtered view.
    const tasks = await createPage(admin, wid, { kind: 'database', parentType: 'page', parentId: tpl.id, title: 'Tâches', emptyDatabase: true });
    const tschema = expectOk(await admin.post<DatabaseSchema>(`/databases/${tasks.id}/properties`, { property: { name: 'Projet', type: 'relation', relation: { databaseId: projects.id } } }));
    const projProp = propId(tschema, 'Projet');
    const task = expectOk(await admin.post<Page>(`/databases/${tasks.id}/rows`, { title: 'Brief', properties: { [projProp]: [tpl.id] } }));
    assert.deepEqual(task.properties[projProp], [tpl.id], 'a row inside the template may point at it');
    const tview = expectOk(await admin.get<DatabaseResponse>(`/databases/${tasks.id}`)).views[0]!;
    expectOk(
      await admin.patch(`/views/${tview.id}`, {
        config: { filter: { conjunction: 'and', rules: [{ id: 'r1', propertyId: projProp, operator: 'contains', value: [tpl.id] }] } },
      }),
    );
    expectOk(await admin.post(`/views/${tview.id}/rows/move`, { rowId: task.id, after: null }));
    // A row outside the template cannot point at it.
    const outside = await createPage(admin, wid, { kind: 'database', title: 'Dehors', emptyDatabase: true });
    const oschema = expectOk(await admin.post<DatabaseSchema>(`/databases/${outside.id}/properties`, { property: { name: 'Projet', type: 'relation', relation: { databaseId: projects.id } } }));
    const stray = expectOk(await admin.post<Page>(`/databases/${outside.id}/rows`, { title: 'X', properties: { [propId(oschema, 'Projet')]: [tpl.id] } }));
    assert.equal(stray.properties[propId(oschema, 'Projet')], undefined);

    // Instantiate.
    const row = expectOk(await admin.post<Page>(`/databases/${projects.id}/rows`, { templateId: tpl.id, title: 'Projet Alpha' }));
    assert.deepEqual(row.properties[parentProp], [row.id], 'self relation remapped');
    const copiedTasks = ctx.db.get<{ id: string }>("SELECT id FROM pages WHERE parent_type = 'page' AND parent_id = ? AND kind = 'database'", row.id)!;
    assert.ok(copiedTasks);
    const copiedRows = expectOk(await admin.get<RowsResponse>(`/databases/${copiedTasks.id}/rows`)).rows;
    assert.equal(copiedRows.length, 1);
    assert.deepEqual(copiedRows[0]!.properties[projProp], [row.id], 'relation of the inner row remapped');
    const copiedView = expectOk(await admin.get<DatabaseResponse>(`/databases/${copiedTasks.id}`)).views[0]!;
    assert.deepEqual(copiedView.config.filter?.rules[0]?.value, [row.id], 'filter remapped');
    assert.ok(copiedView.rowOrder?.[copiedRows[0]!.id], 'view order copied');
    // The new row is live: the two-way mirrors and the template are unchanged.
    pschema = expectOk(await admin.get<DatabaseResponse>(`/databases/${projects.id}`)).schema;
    const tplNow = expectOk(await admin.get<TemplatesResponse>(`/databases/${projects.id}/templates`)).rows.find((r) => r.id === tpl.id)!;
    assert.deepEqual(tplNow.properties[parentProp], [tpl.id]);
    assert.ok(pschema);
  });
});

describe('I1: recurrence calendar', () => {
  test('daily, weekly, monthly and yearly occurrences', () => {
    const base = { interval: 1, startDate: '2031-01-31', time: '08:00' } as const;
    assert.equal(nextOccurrence({ ...base, frequency: 'daily' }, '2031-01-30T12:00'), '2031-01-31T08:00');
    assert.equal(nextOccurrence({ ...base, frequency: 'daily' }, '2031-01-31T08:00'), '2031-02-01T08:00', 'strictly after');
    assert.equal(nextOccurrence({ ...base, frequency: 'daily', interval: 3 }, '2031-02-01T09:00'), '2031-02-03T08:00');
    // Monthly on the 31st: clamped to the end of shorter months.
    assert.equal(nextOccurrence({ ...base, frequency: 'monthly' }, '2031-02-01T00:00'), '2031-02-28T08:00');
    assert.equal(nextOccurrence({ ...base, frequency: 'monthly' }, '2031-02-28T08:00'), '2031-03-31T08:00');
    assert.equal(nextOccurrence({ ...base, frequency: 'yearly' }, '2031-02-01T00:00'), '2032-01-31T08:00');
    // Weekly: every two weeks on Monday and Friday, from Wednesday 2031-01-01.
    const weekly: TemplateRecurrence = { frequency: 'weekly', interval: 2, weekdays: [1, 5], startDate: '2031-01-01', time: '10:00' };
    assert.equal(nextOccurrence(weekly, '2031-01-01T00:00'), '2031-01-03T10:00');
    assert.equal(nextOccurrence(weekly, '2031-01-03T10:00'), '2031-01-13T10:00');
    // End date.
    assert.equal(nextOccurrence({ ...base, frequency: 'daily', endDate: '2031-02-01' }, '2031-02-01T08:00'), null);
  });
});
