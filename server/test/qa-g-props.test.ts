// QA (security), vague G — review A: per-property permissions (G3 / D30) on the output paths not covered
// by qa-property-access.test.ts, batched row writes (G2) and filters (G1). Findings: QA-G3-xx, QA-G2-xx,
// QA-G1-xx. Tests marked `todo` document a behaviour that needs a decision of the user.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreatedApiToken, DatabaseResponse, DatabaseSchema, NotificationsResponse, Page, PropertyDef, RowsResponse, View } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type Res, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { runCollabJobs } from '../src/collab/jobs.js';
import { shiftDay } from '../src/collab/propertyReminders.js';
import { parisToday } from '../src/collab/time.js';
import type { AppContext } from '../src/context.js';

const addDays = (date: string, days: number) => shiftDay(date, -days);

function parisMs(date: string, hour: number, minute = 0): number {
  for (const offset of [1, 2]) {
    const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour - offset, minute);
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (Number(h) === hour) return t;
  }
  throw new Error('no Paris time');
}

async function bearer<T = any>(base: string, token: string, method: string, url: string, body?: unknown): Promise<Res<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

describe('qa-g: review A (G3 property rights, G2 batch, G1 filters)', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let wid: string;
  let did: string;
  let hiddenDate: string;
  let openDate: string;
  let salary: string;
  let rowId: string;
  const SECRET_DAY = addDays(parisToday(), 20);

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
    ctx = [...collabContexts.values()].find((c) => c.config.dataDir === srv.dataDir)!;
    const m = await addMember(admin, wid, 'g-membre@oriel.test', 'Max Membre', 'member');
    member = m.client;
    memberId = m.user.id;
    ({ client: viewer } = await addMember(admin, wid, 'g-lecteur@oriel.test', 'Lise Lectrice', 'viewer'));
    did = (await createPage(admin, wid, { kind: 'database', title: 'RH', emptyDatabase: true })).id;
    const add = async (property: Record<string, unknown>) =>
      expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties.find((p) => p.name === property.name)!.id;
    hiddenDate = await add({ name: 'FinContratZ', type: 'date', dateReminder: { mode: 'same_day', time: '10:00' } });
    openDate = await add({ name: 'Échéance', type: 'date', dateReminder: { mode: 'same_day', time: '10:00' } });
    salary = await add({ name: 'SalaireZ', type: 'number' });
    rowId = expectOk(
      await admin.post<Page>(`/databases/${did}/rows`, { title: 'Alice', properties: { [hiddenDate]: { start: SECRET_DAY }, [salary]: 987654 } }),
    ).id;
    expectOk(await admin.put(`/databases/${did}/properties/${hiddenDate}/access`, { readRoles: [] }));
    expectOk(await admin.put(`/databases/${did}/properties/${salary}/access`, { readRoles: [] }));
  });
  after(async () => {
    await srv.stop();
  });

  const memberReminders = () =>
    ctx.db.all<{ page_id: string; property_id: string; event_date: string }>('SELECT page_id, property_id, event_date FROM collab_property_reminders WHERE user_id = ?', memberId);
  const memberNotifications = async () =>
    expectOk(await member.get<NotificationsResponse>(`/workspaces/${wid}/notifications`)).notifications.filter((n) => n.type === 'reminder');

  test('QA-G3-01: duplicating a row (or creating it from a template) gives no reminder on a hidden date', async () => {
    const copy = expectOk(await member.post<Page>(`/pages/${rowId}/duplicate`));
    const tpl = expectOk(await admin.post<Page>(`/databases/${did}/templates`, { title: 'Modèle' }));
    expectOk(await admin.patch(`/pages/${tpl.id}`, { properties: { [hiddenDate]: { start: SECRET_DAY } } }));
    const fromTpl = expectOk(await member.post<Page>(`/databases/${did}/rows`, { templateId: tpl.id }));
    assert.equal(copy.properties[hiddenDate], undefined);
    assert.equal(fromTpl.properties[hiddenDate], undefined);
    assert.deepEqual(memberReminders().filter((r) => r.property_id === hiddenDate), [], 'reminder created on a hidden property');
    await runCollabJobs(ctx, parisMs(SECRET_DAY, 10, 5));
    assert.ok(!(await memberNotifications()).some((n) => n.date === SECRET_DAY), 'hidden date revealed by a reminder');
  });

  test('QA-G3-02: a reminder does not fire once its property became hidden from its owner', async () => {
    const day = addDays(parisToday(), 25);
    const row = expectOk(await member.post<Page>(`/databases/${did}/rows`, { title: 'Bob', properties: { [openDate]: { start: day } } }));
    assert.equal(memberReminders().filter((r) => r.page_id === row.id).length, 1);
    expectOk(await admin.put(`/databases/${did}/properties/${openDate}/access`, { readRoles: [] }));
    try {
      await runCollabJobs(ctx, parisMs(day, 10, 5));
      assert.ok(!(await memberNotifications()).some((n) => n.date === day), 'reminder fired on a hidden property');
    } finally {
      expectOk(await admin.put(`/databases/${did}/properties/${openDate}/access`, { readRoles: null }));
    }
  });

  test('QA-G3-03: a relation hidden (or read-only) on one side is hidden (or read-only) through its two-way mirror', async () => {
    const other = (await createPage(admin, wid, { kind: 'database', title: 'Sanctions', emptyDatabase: true })).id;
    const s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${did}/properties`, {
        property: { name: 'SanctionsZ', type: 'relation', relation: { databaseId: other } },
        twoWay: { name: 'Personne' },
      }),
    );
    const rel = s.properties.find((p) => p.name === 'SanctionsZ') as PropertyDef;
    const mirror = rel.relation!.syncedPropertyId!;
    const sanction = expectOk(await admin.post<Page>(`/databases/${other}/rows`, { title: 'Avertissement' }));
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [rel.id]: [sanction.id] } }));
    expectOk(await admin.put(`/databases/${did}/properties/${rel.id}/access`, { readRoles: [] }));
    const rows = expectOk(await member.get<RowsResponse>(`/databases/${other}/rows`)).rows;
    assert.deepEqual(rows[0]!.properties[mirror] ?? [], [], 'the hidden link is read through the mirror');
    const schema = expectOk(await member.get<DatabaseResponse>(`/databases/${other}`)).schema;
    assert.ok(!schema.properties.some((p) => p.id === mirror), 'mirror of a hidden relation listed');
    assert.equal(expectOk(await member.get<{ page: Page }>(`/pages/${sanction.id}`)).page.properties[mirror], undefined);
    assert.equal((await member.patch(`/pages/${sanction.id}`, { properties: { [mirror]: [] } })).status, 400);
    // Read-only on one side: the mirror is read-only too.
    expectOk(await admin.put(`/databases/${did}/properties/${rel.id}/access`, { readRoles: null, editRoles: [] }));
    const ro = expectOk(await member.get<DatabaseResponse>(`/databases/${other}`)).schema.properties.find((p) => p.id === mirror);
    assert.equal(ro?.readOnly, true, 'mirror of a read-only relation shown as editable');
    assert.deepEqual(expectOk(await member.get<RowsResponse>(`/databases/${other}/rows`)).rows[0]!.properties[mirror], [rowId]);
    assert.equal((await member.patch(`/pages/${sanction.id}`, { properties: { [mirror]: [] } })).status, 403);
    // Admins see and edit both sides.
    expectOk(await admin.put(`/databases/${did}/properties/${rel.id}/access`, { readRoles: [], editRoles: null }));
    assert.ok(expectOk(await admin.get<DatabaseResponse>(`/databases/${other}`)).schema.properties.some((p) => p.id === mirror && !p.readOnly));
    assert.deepEqual(expectOk(await admin.get<{ page: Page }>(`/pages/${sanction.id}`)).page.properties[mirror], [rowId]);
  });

  test('QA-G3-05: a member cannot pair a new relation with a hidden / read-only one (pairWith) to read or write it', async () => {
    const other = (await createPage(admin, wid, { kind: 'database', title: 'Dossiers', emptyDatabase: true })).id;
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name: 'DossierZ', type: 'relation', relation: { databaseId: other } } }));
    const hidden = s.properties.find((p) => p.name === 'DossierZ')!.id;
    const file = expectOk(await admin.post<Page>(`/databases/${other}/rows`, { title: 'Dossier disciplinaire' }));
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [hidden]: [file.id] } }));
    expectOk(await admin.put(`/databases/${did}/properties/${hidden}/access`, { readRoles: [] }));
    const res = await member.post<DatabaseSchema>(`/databases/${other}/properties`, {
      property: { name: 'Espion', type: 'relation', relation: { databaseId: did } },
      twoWay: { pairWith: hidden },
    });
    if (res.status === 200) {
      const spy = res.body.properties.find((p) => p.name === 'Espion')!.id;
      const rows = expectOk(await member.get<RowsResponse>(`/databases/${other}/rows`)).rows;
      assert.deepEqual(rows.find((r) => r.id === file.id)!.properties[spy] ?? [], [], 'hidden relation copied into the paired one');
    }
    assert.equal(res.status, 400, 'pairing with a hidden relation accepted');
    // Read-only relation: pairing would merge the member's values into it.
    expectOk(await admin.put(`/databases/${did}/properties/${hidden}/access`, { readRoles: null, editRoles: [] }));
    const ro = await member.post(`/databases/${other}/properties`, { property: { name: 'Espion 2', type: 'relation', relation: { databaseId: did } }, twoWay: { pairWith: hidden } });
    assert.equal(ro.status, 403);
    // Admins still pair.
    expectOk(await admin.post(`/databases/${other}/properties`, { property: { name: 'Retour', type: 'relation', relation: { databaseId: did } }, twoWay: { pairWith: hidden } }));
  });

  test('QA-G3-07: a reader answering a member form cannot write through a restricted mirror of a two-way relation', async () => {
    const places = (await createPage(admin, wid, { kind: 'database', title: 'Salles', emptyDatabase: true })).id;
    const s = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${did}/properties`, {
        property: { name: 'Salle', type: 'relation', relation: { databaseId: places } },
        twoWay: { name: 'Équipe de la salle' },
      }),
    );
    const rel = s.properties.find((p) => p.name === 'Salle') as PropertyDef;
    expectOk(await admin.put(`/databases/${places}/properties/${rel.relation!.syncedPropertyId}/access`, { editRoles: [] }));
    const studio = expectOk(await admin.post<Page>(`/databases/${places}/rows`, { title: 'Studio A' }));
    const view = expectOk(
      await admin.post<{ id: string }>(`/databases/${did}/views`, {
        name: 'Inscription',
        type: 'form',
        config: { form: { acceptResponses: true, questions: [{ id: 'q1', propertyId: 'title' }, { id: 'q2', propertyId: rel.id }] } },
      }),
    );
    // Members (who would get 403 on a PATCH, QA-PROP-15) and readers (whose row is created by the owner): 400.
    assert.equal((await member.post(`/forms/${view.id}/submit`, { answers: { q1: 'M', q2: [studio.id] } })).status, 400);
    assert.equal((await viewer.post(`/forms/${view.id}/submit`, { answers: { q1: 'V', q2: [studio.id] } })).status, 400);
    const back = expectOk(await admin.get<RowsResponse>(`/databases/${places}/rows`)).rows.find((r) => r.id === studio.id)!;
    assert.deepEqual(back.properties[rel.relation!.syncedPropertyId!] ?? [], [], 'mirror written through the form');
    expectOk(await viewer.post(`/forms/${view.id}/submit`, { answers: { q1: 'Sans salle' } }));
  });

  test('QA-G3-06: hidden property ids are not listed in the views served to a member (propertyOrder…)', async () => {
    const res = expectOk(await member.get<DatabaseResponse>(`/databases/${did}`));
    assert.ok(!JSON.stringify(res.views).includes(salary), 'hidden property id in a view config');
    const token = expectOk(await member.post<CreatedApiToken>('/me/tokens', { name: 'vues', scope: 'read' })).token;
    const viaToken = await bearer<DatabaseResponse>(srv.base, token, 'GET', `/databases/${did}`);
    assert.ok(!JSON.stringify(expectOk(viaToken).views).includes(salary), 'hidden property id in a view config (token)');
    // Admins still get the whole configuration.
    assert.ok(JSON.stringify(expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views).includes(salary));
  });

  test('QA-G1-01: view rules on a hidden property are neither served (members, anonymous) nor lost when a member saves the view', async () => {
    const leaks = (x: unknown) => ['777111', '999333', salary].filter((s) => JSON.stringify(x).includes(s));
    const created = expectOk(
      await admin.post<View>(`/databases/${did}/views`, {
        name: 'Hauts salaires',
        type: 'table',
        config: {
          filter: {
            conjunction: 'and',
            rules: [
              { id: 'r1', propertyId: salary, operator: 'gt', value: 777111 },
              { id: 'r2', propertyId: 'title', operator: 'contains', value: 'A' },
            ],
            groups: [{ conjunction: 'or', rules: [{ id: 'r3', propertyId: salary, operator: 'lt', value: 999333 }] }],
          },
          sorts: [{ propertyId: salary, direction: 'desc' }, { propertyId: 'title', direction: 'asc' }],
          calculations: { [salary]: 'sum' },
          propertyWidths: { [salary]: 222 },
          hiddenProperties: [salary],
        },
      }),
    );
    const seen = expectOk(await member.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === created.id)!;
    assert.deepEqual(leaks(seen), [], 'view rules on a hidden property served to a member');
    assert.deepEqual(seen.config.filter!.rules.map((r) => r.id), ['r2']);
    assert.deepEqual(seen.config.sorts, [{ propertyId: 'title', direction: 'asc' }]);
    expectOk(await admin.post(`/pages/${did}/publish`, { isPublic: true }));
    try {
      const anonymous = expectOk(await new Client(srv.base).get<DatabaseResponse>(`/public/databases/${did}`));
      assert.deepEqual(leaks(anonymous.views), [], 'view rules on a hidden property served to anonymous visitors');
    } finally {
      expectOk(await admin.post(`/pages/${did}/publish`, { isPublic: false }));
    }
    // A member saving the view (every key it sees) keeps the admin's hidden rules and entries.
    const patched = expectOk(
      await member.patch<View>(`/views/${created.id}`, {
        config: {
          filter: { conjunction: 'and', rules: [{ id: 'r4', propertyId: 'title', operator: 'contains', value: 'B' }] },
          sorts: [],
          calculations: {},
          propertyWidths: {},
          hiddenProperties: [],
          propertyOrder: seen.config.propertyOrder.slice().reverse(),
        },
      }),
    );
    assert.deepEqual(leaks(patched), [], 'saved view returned unredacted');
    const stored = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === created.id)!.config;
    assert.deepEqual(stored.filter!.rules.map((r) => r.id).sort(), ['r1', 'r4']);
    assert.deepEqual(stored.filter!.groups?.[0]?.rules.map((r) => r.id), ['r3']);
    assert.deepEqual(stored.sorts, [{ propertyId: salary, direction: 'desc' }]);
    assert.equal(stored.calculations[salary], 'sum');
    assert.equal(stored.propertyWidths[salary], 222);
    assert.ok(stored.hiddenProperties.includes(salary));
    assert.ok(stored.propertyOrder.includes(salary));
    assert.equal(stored.filter!.rules.find((r) => r.id === 'r1')!.value, 777111);
    // Duplicating: the copy keeps the rules, the response does not show them.
    const copy = expectOk(await member.post<View>(`/views/${created.id}/duplicate`));
    assert.deepEqual(leaks(copy), []);
    const copyStored = expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).views.find((v) => v.id === copy.id)!.config;
    assert.ok(copyStored.filter!.rules.some((r) => r.id === 'r1'));
  });

  test('QA-G3-04: rights cannot be set on metadata properties (their value is on every page)', async () => {
    for (const type of ['created_by', 'last_edited_by', 'created_time', 'last_edited_time'] as const) {
      const name = `Méta ${type}`;
      const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name, type } }));
      const prop = s.properties.find((p) => p.name === name)!.id;
      assert.equal((await admin.put(`/databases/${did}/properties/${prop}/access`, { readRoles: [] })).status, 400, type);
      assert.equal((await admin.put(`/databases/${did}/properties/${prop}/access`, { editRoles: [] })).status, 400, type);
      // Clearing stays possible.
      expectOk(await admin.put(`/databases/${did}/properties/${prop}/access`, { readRoles: null, editRoles: null }));
    }
    // A restricted property converted to a metadata type loses its restriction.
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name: 'Auteur Z', type: 'text' } }));
    const prop = s.properties.find((p) => p.name === 'Auteur Z')!.id;
    expectOk(await admin.put(`/databases/${did}/properties/${prop}/access`, { readRoles: [] }));
    const after = expectOk(await admin.patch<DatabaseSchema>(`/databases/${did}/properties/${prop}`, { type: 'created_by' }));
    assert.equal(after.properties.find((p) => p.id === prop)!.access, undefined);
  });

  test('QA-G6-07: schema changes are attributed to their author in the property history', async () => {
    const adminId = expectOk(await admin.get<{ user: { id: string } }>('/auth/me')).user.id;
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property: { name: 'CodeZ', type: 'text' } }));
    const code = s.properties.find((p) => p.name === 'CodeZ')!.id;
    const row = expectOk(await member.post<Page>(`/databases/${did}/rows`, { title: 'Historique' }));
    expectOk(await member.patch(`/pages/${row.id}`, { properties: { [code]: 'abc' } }));
    const last = () =>
      ctx.db.get<{ user_id: string | null; properties: string }>('SELECT user_id, properties FROM history_props WHERE page_id = ? ORDER BY id DESC LIMIT 1', row.id)!;
    assert.equal(last().user_id, memberId);
    // Conversion (text → number: 'abc' is dropped).
    expectOk(await admin.patch(`/databases/${did}/properties/${code}`, { type: 'number' }));
    assert.equal(last().user_id, adminId, 'conversion attributed to the last editor of the row');
    expectOk(await member.patch(`/pages/${row.id}`, { properties: { [code]: 12 } }));
    assert.equal(last().user_id, memberId);
    // Deletion of the property.
    expectOk(await admin.del(`/databases/${did}/properties/${code}`));
    assert.equal(last().user_id, adminId, 'deletion attributed to the last editor of the row');
    expectOk(await member.patch(`/pages/${row.id}`, { title: 'Historique 2' }));
    // Numbering of the existing rows (new unique id property).
    expectOk(await admin.post(`/databases/${did}/properties`, { property: { name: 'NuméroZ', type: 'unique_id' } }));
    assert.equal(last().user_id, adminId, 'numbering attributed to the last editor of the row');
  });

  test('QA-G3-08: a member duplicating the whole database (or a page holding it) keeps the restrictions', async () => {
    const copy = expectOk(await member.post<Page>(`/pages/${did}/duplicate`));
    const rows = expectOk(await member.get<RowsResponse>(`/databases/${copy.id}/rows`));
    assert.ok(!JSON.stringify(rows).includes('987654'), 'hidden value readable in the copy');
    const schema = expectOk(await admin.get<DatabaseResponse>(`/databases/${copy.id}`)).schema;
    assert.deepEqual(schema.properties.find((p) => p.name === 'SalaireZ')?.access, { readRoles: [] });
  });

  test('QA-G2-01: batch writes: token scope and workspace restriction, hidden / read-only, templates', async () => {
    const readToken = expectOk(await member.post<CreatedApiToken>('/me/tokens', { name: 'lecture', scope: 'read' })).token;
    const body = { updates: [{ id: rowId, title: 'Piraté' }] };
    assert.equal((await bearer(srv.base, readToken, 'POST', `/databases/${did}/rows/batch`, body)).status, 403);
    // A token restricted to another workspace sees nothing here.
    const otherWid = expectOk(await member.post<{ id: string }>('/workspaces', { name: 'Autre' })).id;
    const scoped = expectOk(await member.post<CreatedApiToken>('/me/tokens', { name: 'autre', scope: 'write', workspaceId: otherWid })).token;
    assert.equal((await bearer(srv.base, scoped, 'POST', `/databases/${did}/rows/batch`, body)).status, 404);
    // Hidden property: unknown (400), the same answer as a made-up id; nothing written.
    const hidden = await member.post(`/databases/${did}/rows/batch`, { updates: [{ id: rowId, title: 'x' }, { id: rowId, properties: { [salary]: 1 } }] });
    const madeUp = await member.post(`/databases/${did}/rows/batch`, { updates: [{ id: rowId, properties: { zzzz: 1 } }] });
    assert.equal(hidden.status, 400);
    assert.equal(madeUp.status, 400);
    assert.equal(expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows.find((r) => r.id === rowId)!.title, 'Alice', 'atomic');
    assert.equal((await viewer.post(`/databases/${did}/rows/batch`, body)).status, 403);
    // Body shape: unknown keys and oversized property maps are refused.
    assert.equal((await member.post(`/databases/${did}/rows/batch`, { updates: [{ id: rowId, parentId: did }] })).status, 400);
  });
});
