// G1 / D26 — default reminders on date properties; D25 — number settings persisted; D23 — new filter
// operators accepted (and the quantifier kept) by view schemas.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseResponse, DatabaseSchema, NotificationsResponse, RowsResponse } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { runCollabJobs } from '../src/collab/jobs.js';
import { eventDay, reminderMoment, shiftDay } from '../src/collab/propertyReminders.js';
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

describe('reminder arithmetic', () => {
  test('moments', () => {
    assert.deepEqual(reminderMoment({ start: '2026-11-12' }, { mode: 'day_before' }), { eventDate: '2026-11-12', date: '2026-11-11', minutes: 540 });
    assert.deepEqual(reminderMoment({ start: '2026-03-01' }, { mode: 'week_before', time: '08:30' }), { eventDate: '2026-03-01', date: '2026-02-22', minutes: 510 });
    assert.deepEqual(reminderMoment({ start: '2026-01-01' }, { mode: 'same_day', time: '17:45' })?.date, '2026-01-01');
    assert.equal(reminderMoment({ start: '2026-01-01' }, { mode: 'none' }), null);
    assert.equal(reminderMoment({ start: 'nope' }, { mode: 'same_day' }), null);
    assert.equal(reminderMoment(null, { mode: 'same_day' }), null);
    // Invalid time falls back to 09:00.
    assert.equal(reminderMoment({ start: '2026-01-01' }, { mode: 'same_day', time: '25:99' })?.minutes, 540);
  });
  test('values with a time use the Paris day', () => {
    assert.equal(eventDay({ start: '2026-11-12T23:30:00.000Z', includeTime: true }), '2026-11-13');
    assert.equal(eventDay({ start: '2026-07-12T21:30:00.000Z', includeTime: true }), '2026-07-12');
  });
});

describe('date property default reminders (API)', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let member: Client;
  let memberId: string;
  let wid: string;
  let dbId: string;
  let dateProp: string;
  let rowId: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    const added = await addMember(admin, wid, 'membre@oriel.test', 'Marc', 'member');
    member = added.client;
    memberId = added.user.id;
    ctx = [...collabContexts.values()].find((c) => c.config.dataDir === srv.dataDir)!;
    const page = await createPage(admin, wid, { kind: 'database', title: 'Livraisons', emptyDatabase: true });
    dbId = page.id;
    const schema = expectOk(await admin.post<DatabaseSchema>(`/databases/${dbId}/properties`, { property: { name: 'Échéance', type: 'date' } }));
    dateProp = schema.properties.find((p) => p.type === 'date')!.id;
    rowId = expectOk(await admin.post<{ id: string }>(`/databases/${dbId}/rows`, {})).id;
  });
  after(async () => {
    await srv.stop();
  });

  const reminders = () => ctx.db.all<{ user_id: string; event_date: string; remind_date: string; remind_minutes: number; fired_at: number | null }>('SELECT * FROM collab_property_reminders WHERE page_id = ?', rowId);

  test('settings are validated and persisted', async () => {
    const bad = await admin.patch(`/databases/${dbId}/properties/${dateProp}`, { dateReminder: { mode: 'tomorrow' } });
    assert.equal(bad.status, 400);
    const badTime = await admin.patch(`/databases/${dbId}/properties/${dateProp}`, { dateReminder: { mode: 'same_day', time: '9h' } });
    assert.equal(badTime.status, 400);
    const ok = expectOk(await admin.patch<DatabaseSchema>(`/databases/${dbId}/properties/${dateProp}`, { dateReminder: { mode: 'day_before', time: '08:00' } }));
    assert.deepEqual(ok.properties.find((p) => p.id === dateProp)!.dateReminder, { mode: 'day_before', time: '08:00' });
  });

  test('a date typed in the column creates the author’s reminder, which fires once', async () => {
    const event = addDays(parisToday(), 5);
    expectOk(await member.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: event } } }));
    const rows = reminders();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, memberId);
    assert.equal(rows[0]!.event_date, event);
    assert.equal(rows[0]!.remind_date, addDays(event, -1));
    assert.equal(rows[0]!.remind_minutes, 480);
    assert.equal((await runCollabJobs(ctx, parisMs(addDays(event, -2), 12))).reminders, 0);
    assert.equal((await runCollabJobs(ctx, parisMs(addDays(event, -1), 7, 59))).reminders, 0);
    assert.equal((await runCollabJobs(ctx, parisMs(addDays(event, -1), 8, 0))).reminders, 1);
    assert.equal((await runCollabJobs(ctx, parisMs(addDays(event, -1), 9))).reminders, 0, 'once');
    const list = expectOk(await member.get<NotificationsResponse>(`/workspaces/${wid}/notifications`)).notifications.filter((n) => n.type === 'reminder');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.date, event);
  });

  test('changing or clearing the date replaces the reminder', async () => {
    const first = addDays(parisToday(), 8);
    const second = addDays(parisToday(), 12);
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: first } } }));
    assert.deepEqual(reminders().map((r) => [r.user_id !== memberId, r.event_date, r.fired_at]), [[true, first, null]]);
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: second } } }));
    assert.deepEqual(reminders().map((r) => r.event_date), [second]);
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: null } }));
    assert.equal(reminders().length, 0);
  });

  test('past dates and properties without a setting create nothing', async () => {
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: addDays(parisToday(), -3) } } }));
    assert.equal(reminders().length, 0);
    expectOk(await admin.patch<DatabaseSchema>(`/databases/${dbId}/properties/${dateProp}`, { dateReminder: null }));
    const schema = expectOk(await admin.get<DatabaseResponse>(`/databases/${dbId}`)).schema;
    assert.equal(schema.properties.find((p) => p.id === dateProp)!.dateReminder, undefined);
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: addDays(parisToday(), 9) } } }));
    assert.equal(reminders().length, 0);
  });

  test('an unrelated edit leaves the reminders alone', async () => {
    expectOk(await admin.patch<DatabaseSchema>(`/databases/${dbId}/properties/${dateProp}`, { dateReminder: { mode: 'same_day', time: '10:00' } }));
    const day = addDays(parisToday(), 3);
    expectOk(await admin.patch(`/pages/${rowId}`, { properties: { [dateProp]: { start: day } } }));
    assert.equal(reminders().length, 1);
    expectOk(await admin.patch(`/pages/${rowId}`, { title: 'Nouveau titre' }));
    assert.equal(reminders().length, 1);
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbId}/rows`)).rows;
    assert.equal(rows.find((r) => r.id === rowId)!.title, 'Nouveau titre');
  });
});

describe('default reminders on every creation path', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let adminId: string;
  let wid: string;
  let dbId: string;
  let dateProp: string;

  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    adminId = s.session.user.id;
    ctx = [...collabContexts.values()].find((c) => c.config.dataDir === srv.dataDir)!;
    const page = await createPage(admin, wid, { kind: 'database', title: 'Dates', emptyDatabase: true });
    dbId = page.id;
    const schema = expectOk(
      await admin.post<DatabaseSchema>(`/databases/${dbId}/properties`, { property: { name: 'Échéance', type: 'date', dateReminder: { mode: 'same_day', time: '10:00' } } }),
    );
    dateProp = schema.properties.find((p) => p.type === 'date')!.id;
  });
  after(async () => {
    await srv.stop();
  });

  const all = () =>
    ctx.db.all<{ page_id: string; user_id: string; event_date: string }>('SELECT page_id, user_id, event_date FROM collab_property_reminders ORDER BY event_date');

  test('a row created with an initial date', async () => {
    const day = addDays(parisToday(), 4);
    const row = expectOk(await admin.post<{ id: string }>(`/databases/${dbId}/rows`, { title: 'Initiale', properties: { [dateProp]: { start: day } } }));
    const mine = all().filter((r) => r.page_id === row.id);
    assert.deepEqual(mine.map((r) => [r.user_id, r.event_date]), [[adminId, day]]);
  });

  test('CSV import: created rows and rows updated by title', async () => {
    const d1 = addDays(parisToday(), 6);
    const d2 = addDays(parisToday(), 7);
    const first = expectOk(await admin.post<{ created: number }>(`/databases/${dbId}/import`, { rows: [{ title: 'Importée', properties: { [dateProp]: { start: d1 } } }] }));
    assert.equal(first.created, 1);
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbId}/rows`)).rows;
    const imported = rows.find((r) => r.title === 'Importée')!;
    assert.deepEqual(all().filter((r) => r.page_id === imported.id).map((r) => r.event_date), [d1]);
    const second = expectOk(
      await admin.post<{ updated: number }>(`/databases/${dbId}/import`, { rows: [{ title: 'Importée', properties: { [dateProp]: { start: d2 } } }], updateByTitle: true }),
    );
    assert.equal(second.updated, 1);
    assert.deepEqual(all().filter((r) => r.page_id === imported.id).map((r) => r.event_date), [d2]);
  });

  test('a form response (member and public): the reminder goes to the one who owns the response row', async () => {
    const day = addDays(parisToday(), 9);
    const view = expectOk(
      await admin.post<{ id: string }>(`/databases/${dbId}/views`, {
        name: 'Formulaire',
        type: 'form',
        config: { form: { title: 'Demande', questions: [{ id: 'nom', propertyId: 'title', required: true }, { id: 'quand', propertyId: dateProp }], acceptResponses: true, isPublic: true } },
      }),
    );
    expectOk(await admin.post(`/forms/${view.id}/submit`, { answers: { nom: 'Membre', quand: { start: day } } }));
    const anon = new Client(srv.base);
    const res = await anon.post(`/public/forms/${view.id}/submit`, { answers: { nom: 'Anonyme', quand: { start: addDays(day, 1) } } });
    assert.equal(res.status, 200);
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbId}/rows`)).rows;
    for (const [title, date] of [['Membre', day], ['Anonyme', addDays(day, 1)]] as const) {
      const row = rows.find((r) => r.title === title)!;
      assert.deepEqual(all().filter((r) => r.page_id === row.id).map((r) => [r.user_id, r.event_date]), [[adminId, date]], title);
    }
  });

  test('duplicating a row gives the copy its own reminders', async () => {
    const rows = expectOk(await admin.get<RowsResponse>(`/databases/${dbId}/rows`)).rows;
    const source = rows.find((r) => r.title === 'Initiale')!;
    const copy = expectOk(await admin.post<{ page: { id: string } } | { id: string }>(`/pages/${source.id}/duplicate`, {}));
    const id = 'page' in copy ? copy.page.id : copy.id;
    assert.equal(all().filter((r) => r.page_id === id).length, 1);
  });
});

describe('number settings and filter operators (API)', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  before(async () => {
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
  });
  after(async () => {
    await srv.stop();
  });

  test('currency, precision, bar / ring settings are validated, kept and cleared', async () => {
    const page = await createPage(admin, wid, { kind: 'database', title: 'Budget', emptyDatabase: true });
    let schema = expectOk(await admin.post<DatabaseSchema>(`/databases/${page.id}/properties`, { property: { name: 'Montant', type: 'number', numberFormat: 'gbp', numberPrecision: 3 } }));
    const id = schema.properties.find((p) => p.type === 'number')!.id;
    let def = schema.properties.find((p) => p.id === id)!;
    assert.equal(def.numberFormat, 'gbp');
    assert.equal(def.numberPrecision, 3);
    assert.equal((await admin.patch(`/databases/${page.id}/properties/${id}`, { numberFormat: 'bitcoin' })).status, 400);
    assert.equal((await admin.patch(`/databases/${page.id}/properties/${id}`, { numberPrecision: 11 })).status, 400);
    assert.equal((await admin.patch(`/databases/${page.id}/properties/${id}`, { numberPrecision: 1.5 })).status, 400);
    assert.equal((await admin.patch(`/databases/${page.id}/properties/${id}`, { numberMax: 0 })).status, 400);
    schema = expectOk(await admin.patch<DatabaseSchema>(`/databases/${page.id}/properties/${id}`, { numberDisplay: 'ring', numberMax: 250, numberColor: 'green' }));
    def = schema.properties.find((p) => p.id === id)!;
    assert.deepEqual([def.numberDisplay, def.numberMax, def.numberColor, def.numberPrecision], ['ring', 250, 'green', 3]);
    schema = expectOk(await admin.patch<DatabaseSchema>(`/databases/${page.id}/properties/${id}`, { numberPrecision: null, numberDisplay: null }));
    def = schema.properties.find((p) => p.id === id)!;
    assert.equal(def.numberPrecision, undefined);
    assert.equal(def.numberDisplay, undefined);
    assert.equal(def.numberMax, undefined, 'bar settings go away with the display mode');
    assert.equal(def.numberFormat, 'gbp');
  });

  test('view filters keep the new operators and the quantifier', async () => {
    const page = await createPage(admin, wid, { kind: 'database', title: 'Filtres', emptyDatabase: true });
    const info = expectOk(await admin.get<DatabaseResponse>(`/databases/${page.id}`));
    const view = info.views[0]!;
    const filter = {
      conjunction: 'and',
      rules: [
        { id: 'r1', propertyId: 'title', operator: 'contains_all', value: ['a', 'b'] },
        { id: 'r2', propertyId: 'title', operator: 'within_last', value: { amount: 7, unit: 'day' } },
        { id: 'r3', propertyId: 'title', operator: 'contains', value: '@me', quantifier: 'every' },
      ],
    };
    const res = await admin.patch<{ config: { filter: typeof filter } }>(`/views/${view.id}`, { config: { filter } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.config.filter, filter);
    const bad = await admin.patch(`/views/${view.id}`, { config: { filter: { conjunction: 'and', rules: [{ id: 'x', propertyId: 'title', operator: 'matches_regex', value: 'a' }] } } });
    assert.equal(bad.status, 400);
    const badQ = await admin.patch(`/views/${view.id}`, { config: { filter: { conjunction: 'and', rules: [{ id: 'x', propertyId: 'title', operator: 'contains', quantifier: 'most' }] } } });
    assert.equal(badQ.status, 400);
  });
});
