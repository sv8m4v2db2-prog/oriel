// New database views (feed, charts, dashboard, map, form), the place property, form submissions
// (members and public) and the geocoding proxy. Nothing reaches a real geocoder: a local fixture
// server stands for it, reached through mocked DNS.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  DatabaseResponse,
  DatabaseSchema,
  GeocodeResponse,
  NotificationsResponse,
  Page,
  PropertyDef,
  RowPreviewsResponse,
  RowsResponse,
  View,
  ViewConfig,
} from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { formTestHooks } from '../src/routes/forms.js';
import { geocodeTestHooks } from '../src/routes/databaseExtras.js';
import { isBlockedAddress } from '../src/routes/editor.js';

describe('databases: new views, forms, places, geocoding', () => {
  let srv: TestServer;
  let admin: Client;
  let viewer: Client;
  let outsider: Client;
  let wid: string;
  let geo: http.Server;
  let geoPort = 0;
  const geoHits: string[] = [];

  before(async () => {
    formTestHooks.ipLimit = 1000;
    formTestHooks.hourlyCap = 4;
    geo = http.createServer((req, res) => {
      geoHits.push(req.url ?? '');
      // No client header or cookie may reach the geocoder.
      assert.equal(req.headers.cookie, undefined);
      assert.match(String(req.headers['user-agent']), /^Oriel\//);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { display_name: '1 rue de la Oriel, Paris', lat: '48.85', lon: '2.35', extra: 'ignored' },
          { display_name: 'Bad', lat: 'x', lon: '2' },
        ]),
      );
    });
    await new Promise<void>((r) => geo.listen(0, '127.0.0.1', () => r()));
    geoPort = (geo.address() as AddressInfo).port;
    srv = await startTestServer();
    const s = await setupAdmin(srv.base);
    admin = s.admin;
    wid = s.wid;
    ({ client: viewer } = await addMember(admin, wid, 'lecteur-form@oriel.test', 'Lou', 'viewer'));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post('/auth/signup', { email: 'dehors@oriel.test', name: 'Dehors', password: 'motdepasse-solide' }));
  });
  after(async () => {
    for (const k of Object.keys(formTestHooks)) delete (formTestHooks as Record<string, unknown>)[k];
    for (const k of Object.keys(geocodeTestHooks)) delete (geocodeTestHooks as Record<string, unknown>)[k];
    await srv.stop();
    geo.closeAllConnections();
    await new Promise<void>((r) => geo.close(() => r()));
  });

  const newDb = async (title: string) => (await createPage(admin, wid, { kind: 'database', title, emptyDatabase: true })).id;
  const schemaOf = async (did: string) => expectOk(await admin.get<DatabaseResponse>(`/databases/${did}`)).schema.properties;
  const addProp = async (did: string, property: Record<string, unknown>) => {
    const s = expectOk(await admin.post<DatabaseSchema>(`/databases/${did}/properties`, { property }));
    return s.properties.find((p) => p.name === property.name)!;
  };
  const rowsOf = async (did: string) => expectOk(await admin.get<RowsResponse>(`/databases/${did}/rows`)).rows;

  test('view configs of the new view types are stored, validated and cleaned', async () => {
    const d = await newDb('Vues');
    const statut = await addProp(d, { name: 'Statut', type: 'status' });
    const budget = await addProp(d, { name: 'Budget', type: 'number' });
    const lieu = await addProp(d, { name: 'Lieu', type: 'place' });
    for (const type of ['feed', 'chart_bar', 'chart_hbar', 'chart_line', 'chart_donut', 'chart_number', 'dashboard', 'map', 'form'] as const) {
      const v = expectOk(await admin.post<View>(`/databases/${d}/views`, { name: type, type }));
      assert.equal(v.type, type);
    }
    const views = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views;
    const by = (t: string) => views.find((v) => v.type === t)!;
    assert.equal(by('map').config.placeProperty, lieu.id, 'map defaults to the first place property');
    assert.equal(by('chart_bar').config.chart?.xProperty, statut.id);
    assert.equal(by('chart_number').config.chart?.xProperty, null);
    assert.ok(by('dashboard').config.widgets!.length > 0);
    assert.ok(by('form').config.form!.questions.some((q) => q.propertyId === 'title'));
    assert.equal(by('feed').config.feedPreviewLines, 3);

    const chart: ViewConfig['chart'] = { xProperty: statut.id, aggregate: 'sum', valueProperty: budget.id, seriesProperty: null, sort: 'value_desc', showLabels: true };
    expectOk(await admin.patch(`/views/${by('chart_bar').id}`, { config: { chart } }));
    const widgets: ViewConfig['widgets'] = [
      { id: 'a', type: 'chart_donut', chart, w: 2, h: 2 },
      { id: 'b', type: 'list', filter: { conjunction: 'and', rules: [{ id: 'r', propertyId: budget.id, operator: 'gt', value: 3 }] }, limit: 5, w: 1, h: 1 },
    ];
    expectOk(await admin.patch(`/views/${by('dashboard').id}`, { config: { widgets } }));
    // Invalid shapes are refused.
    assert.equal((await admin.patch(`/views/${by('dashboard').id}`, { config: { widgets: [{ id: 'x', type: 'list', w: 9, h: 1 }] } })).status, 400);
    assert.equal((await admin.patch(`/views/${by('chart_bar').id}`, { config: { chart: { ...chart, aggregate: 'median' } } })).status, 400);
    assert.equal((await admin.patch(`/views/${by('form').id}`, { config: { form: { questions: [{ id: 'bad id!', propertyId: 'title' }], acceptResponses: true } } })).status, 400);
    assert.equal((await admin.post(`/databases/${d}/views`, { name: 'x', type: 'pie' })).status, 400);

    // Deleting a property removes it from charts, widgets, maps and forms.
    const form = { questions: [{ id: 'q1', propertyId: budget.id }, { id: 'q2', propertyId: 'title', showIf: { questionId: 'q1', value: '3' } }], acceptResponses: true };
    expectOk(await admin.patch(`/views/${by('form').id}`, { config: { form } }));
    expectOk(await admin.del(`/databases/${d}/properties/${budget.id}`));
    expectOk(await admin.del(`/databases/${d}/properties/${lieu.id}`));
    const after = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views;
    const a = (t: string) => after.find((v) => v.type === t)!.config;
    assert.equal(a('chart_bar').chart!.valueProperty, null);
    assert.equal(a('chart_bar').chart!.aggregate, 'count');
    assert.equal(a('dashboard').widgets![0]!.chart!.valueProperty, null);
    assert.deepEqual(a('dashboard').widgets![1]!.filter!.rules, []);
    assert.equal(a('map').placeProperty, null);
    assert.deepEqual(a('form').form!.questions, [{ id: 'q2', propertyId: 'title', showIf: null }]);
  });

  test('place values: address with optional coordinates', async () => {
    const d = await newDb('Lieux');
    const lieu = await addProp(d, { name: 'Lieu', type: 'place' });
    const ok = expectOk(await admin.post<Page>(`/databases/${d}/rows`, { title: 'A', properties: { [lieu.id]: { address: 'Paris', lat: 48.85, lng: 2.35 } } }));
    assert.deepEqual(ok.properties[lieu.id], { address: 'Paris', lat: 48.85, lng: 2.35 });
    expectOk(await admin.post(`/databases/${d}/rows`, { title: 'B', properties: { [lieu.id]: { address: 'Lyon' } } }));
    for (const bad of [{ address: 'x', lat: 91, lng: 0 }, { address: 'x', lat: 1 }, { address: 3 }, 'Paris', { address: '' }]) {
      assert.equal((await admin.post(`/databases/${d}/rows`, { title: 'C', properties: { [lieu.id]: bad } })).status, 400, JSON.stringify(bad));
    }
    // Text ↔ place conversions keep the address.
    const t = await addProp(d, { name: 'Adresse', type: 'text' });
    const row = expectOk(await admin.post<Page>(`/databases/${d}/rows`, { title: 'D', properties: { [t.id]: '3 quai Branly' } }));
    expectOk(await admin.patch(`/databases/${d}/properties/${t.id}`, { type: 'place' }));
    assert.deepEqual((await rowsOf(d)).find((r) => r.id === row.id)!.properties[t.id], { address: '3 quai Branly' });
    expectOk(await admin.patch(`/databases/${d}/properties/${lieu.id}`, { type: 'text' }));
    assert.equal((await rowsOf(d)).find((r) => r.id === ok.id)!.properties[lieu.id], 'Paris');
  });

  test('feed previews: first lines of content and open comments; public only when published', async () => {
    const d = await newDb('Fil');
    const r = expectOk(await admin.post<Page>(`/databases/${d}/rows`, { title: 'Post' }));
    const res = expectOk(await admin.get<RowPreviewsResponse>(`/databases/${d}/previews?ids=${r.id},${crypto.randomUUID()}`));
    assert.deepEqual(Object.keys(res.previews), [r.id]);
    assert.deepEqual(res.previews[r.id], { text: '', comments: 0 });
    assert.equal((await outsider.get(`/databases/${d}/previews?ids=${r.id}`)).status, 404);
    const anon = new Client(srv.base);
    assert.equal((await anon.get(`/public/databases/${d}/previews?ids=${r.id}`)).status, 404);
    expectOk(await admin.post(`/pages/${d}/publish`, { isPublic: true }));
    assert.ok(expectOk(await anon.get<RowPreviewsResponse>(`/public/databases/${d}/previews?ids=${r.id}`)).previews[r.id]);
  });

  describe('forms', () => {
    let d: string;
    let formView: View;
    let statut: PropertyDef;
    let budget: PropertyDef;
    let personne: PropertyDef;
    let lieu: PropertyDef;
    const anon = () => new Client(srv.base);
    const setForm = async (patch: Partial<NonNullable<ViewConfig['form']>>) => {
      const current = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views.find((v) => v.id === formView.id)!.config.form!;
      expectOk(await admin.patch(`/views/${formView.id}`, { config: { form: { ...current, ...patch } } }));
    };

    before(async () => {
      d = await newDb('Demandes');
      statut = await addProp(d, { name: 'Type', type: 'select', options: [{ name: 'Projet', color: 'red' }, { name: 'Photo', color: 'blue' }] });
      budget = await addProp(d, { name: 'Budget', type: 'number' });
      personne = await addProp(d, { name: 'Responsable', type: 'person' });
      lieu = await addProp(d, { name: 'Adresse', type: 'place' });
      await addProp(d, { name: 'Courriel', type: 'email' });
      const props = await schemaOf(d);
      const email = props.find((p) => p.name === 'Courriel')!;
      formView = expectOk(
        await admin.post<View>(`/databases/${d}/views`, {
          name: 'Brief',
          type: 'form',
          config: {
            form: {
              title: 'Nouveau brief',
              questions: [
                { id: 'nom', propertyId: 'title', required: true },
                { id: 'type', propertyId: statut.id, required: true },
                { id: 'budget', propertyId: budget.id, showIf: { questionId: 'type', value: statut.options![0]!.id }, required: true },
                { id: 'mail', propertyId: email.id },
                { id: 'resp', propertyId: personne.id },
                { id: 'lieu', propertyId: lieu.id },
              ],
              acceptResponses: true,
              isPublic: true,
            },
          },
        }),
      );
    });

    const submit = (c: Client, answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      c.post(`/public/forms/${formView.id}/submit`, { answers, ...extra });

    test('public submissions: shared, open, validated; bare confirmation; owner notified', async () => {
      const projet = statut.options![0]!.id;
      const photo = statut.options![1]!.id;
      // The database is not published (QA-VIEW-04): the form is answered, its rows stay private.
      assert.equal((await anon().get(`/public/databases/${d}/rows`)).status, 404);
      // Validation: required, unknown option, wrong types, unexpected keys, people refused from anonymous.
      assert.equal((await submit(anon(), { type: photo })).status, 400);
      assert.equal((await submit(anon(), { nom: 'X', type: 'nope' })).status, 400);
      assert.equal((await submit(anon(), { nom: 'X', type: projet })).status, 400, 'conditional required question');
      assert.equal((await submit(anon(), { nom: 'X', type: projet, budget: '12' })).status, 400);
      assert.equal((await submit(anon(), { nom: 'X', type: photo, mail: 'pas-un-mail' })).status, 400);
      assert.equal((await submit(anon(), { nom: 'X', type: photo, resp: ['x'] })).status, 400);
      // Places are asked to members only (the public page never shows them).
      assert.equal((await submit(anon(), { nom: 'X', type: photo, lieu: { address: 'Paris', lat: 48.85, lng: 2.35 } })).status, 400);
      assert.equal((await submit(anon(), { nom: 'X', type: photo, autre: 1 })).status, 400);
      const before = (await rowsOf(d)).length;
      const ok = await submit(anon(), { nom: 'Projet Beta', type: projet, budget: 1500, mail: 'a@b.fr' });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { ok: true }, 'bare confirmation, no row data');
      const rows = await rowsOf(d);
      assert.equal(rows.length, before + 1);
      const row = rows.find((r) => r.title === 'Projet Beta')!;
      assert.equal(row.properties[statut.id], projet);
      assert.equal(row.properties[budget.id], 1500);
      // Hidden conditional answers are ignored.
      expectOk(await submit(anon(), { nom: 'Photo', type: photo, budget: 99 }));
      assert.equal((await rowsOf(d)).find((r) => r.title === 'Photo')!.properties[budget.id], undefined);
      // The session cookie of a logged-in visitor is ignored: the row is not attributed to them.
      expectOk(await submit(viewer, { nom: 'Par Lou', type: photo }));
      const lou = (await rowsOf(d)).find((r) => r.title === 'Par Lou')!;
      const adminId = row.createdBy;
      assert.equal(lou.createdBy, adminId);
      // The owner is notified.
      const notes = expectOk(await admin.get<NotificationsResponse>(`/workspaces/${wid}/notifications`)).notifications;
      assert.ok(notes.some((n) => n.type === 'form_response' && n.page?.id === row.id));
    });

    test('public submissions: honeypot, closed and private forms, size cap, rate limits', async () => {
      const photo = statut.options![1]!.id;
      const count = async () => (await rowsOf(d)).length;
      const n0 = await count();
      // Honeypot: same answer, nothing stored.
      const trap = await submit(anon(), { nom: 'Bot', type: photo }, { website: 'http://spam.example' });
      assert.deepEqual(trap.body, { ok: true });
      assert.equal(await count(), n0);
      // Size cap.
      assert.equal((await submit(anon(), { nom: 'x'.repeat(70_000), type: photo })).status, 413);
      // Closed form.
      await setForm({ acceptResponses: false });
      assert.equal((await submit(anon(), { nom: 'Fermé', type: photo })).status, 403);
      // Not shared publicly (members only).
      await setForm({ acceptResponses: true, isPublic: false });
      assert.equal((await submit(anon(), { nom: 'Privé', type: photo })).status, 404);
      await setForm({ isPublic: true });
      // Per-form hourly cap (4 in tests; 3 public rows were created above).
      assert.equal((await submit(anon(), { nom: 'Quatre', type: photo })).status, 200);
      assert.equal((await submit(anon(), { nom: 'Cinq', type: photo })).status, 429);
      // Per-address limit (3 per window here): every request counts, accepted or not.
      formTestHooks.ipLimit = 3;
      const bot = { website: 'x' }; // honeypot answers 200 before the per-form caps
      for (let i = 0; i < 3; i++) assert.equal((await submit(anon(), { nom: 'x', type: photo }, bot)).status, 200);
      assert.equal((await submit(anon(), { nom: 'x', type: photo }, bot)).status, 429);
      formTestHooks.ipLimit = 1000;
    });

    test('member submissions: readers may answer, people and relations allowed, invisible forms are 404', async () => {
      const projet = statut.options![0]!.id;
      const me = expectOk(await viewer.get<{ user: { id: string } }>('/auth/me')).user.id;
      const place = { address: '1 rue de la Oriel, Paris', lat: 48.85, lng: 2.35 };
      const res = await viewer.post(`/forms/${formView.id}/submit`, { answers: { nom: 'Depuis Lou', type: projet, budget: 10, resp: [me], lieu: place } });
      assert.deepEqual(res.body, { ok: true });
      const row = (await rowsOf(d)).find((r) => r.title === 'Depuis Lou')!;
      assert.deepEqual(row.properties[personne.id], [me]);
      assert.deepEqual(row.properties[lieu.id], place);
      assert.equal((await outsider.post(`/forms/${formView.id}/submit`, { answers: { nom: 'x', type: projet } })).status, 404);
      assert.equal((await anon().post(`/forms/${formView.id}/submit`, { answers: {} })).status, 401);
      // A table view is not a form.
      const table = expectOk(await admin.get<DatabaseResponse>(`/databases/${d}`)).views.find((v) => v.type === 'table')!;
      assert.equal((await viewer.post(`/forms/${table.id}/submit`, { answers: {} })).status, 404);
    });
  });

  describe('geocoding proxy', () => {
    const site = () => `http://geocoder.test:${geoPort}`;
    const resolve = async (host: string) => {
      if (host === 'geocoder.test') return [{ address: '127.0.0.1', family: 4 as const }];
      if (host === 'internal.test') return [{ address: '10.0.0.5', family: 4 as const }];
      throw new Error('ENOTFOUND');
    };

    test('disabled by default, members only', async () => {
      geocodeTestHooks.url = null;
      const res = expectOk(await admin.get<GeocodeResponse>(`/workspaces/${wid}/geocode?q=Paris`));
      assert.deepEqual(res, { enabled: false, results: [] });
      assert.equal((await outsider.get(`/workspaces/${wid}/geocode?q=Paris`)).status, 404);
      assert.equal((await new Client(srv.base).get(`/workspaces/${wid}/geocode?q=Paris`)).status, 401);
    });

    test('results reduced to text and coordinates, cached, rate limited, length capped', async () => {
      Object.assign(geocodeTestHooks, {
        url: site(),
        resolve,
        isBlocked: (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip),
        minIntervalMs: 0,
        userLimit: 2,
      });
      const r1 = expectOk(await admin.get<GeocodeResponse>(`/workspaces/${wid}/geocode?q=${encodeURIComponent('Rue de la Oriel')}`));
      assert.deepEqual(r1, { enabled: true, results: [{ address: '1 rue de la Oriel, Paris', lat: 48.85, lng: 2.35 }] });
      assert.equal(geoHits.length, 1);
      assert.match(geoHits[0]!, /^\/search\?format=jsonv2&limit=5&q=Rue\+de\+la\+Oriel$/);
      // Cache hit (case and spaces normalised): no new request, not rate limited.
      for (let i = 0; i < 3; i++) expectOk(await admin.get(`/workspaces/${wid}/geocode?q=${encodeURIComponent(' rue  de la oriel ')}`));
      assert.equal(geoHits.length, 1);
      expectOk(await admin.get(`/workspaces/${wid}/geocode?q=Lyon`));
      assert.equal((await admin.get(`/workspaces/${wid}/geocode?q=Marseille`)).status, 429);
      assert.equal(geoHits.length, 2);
      assert.equal((await admin.get(`/workspaces/${wid}/geocode?q=${'a'.repeat(201)}`)).status, 400);
    });

    test('SSRF: an endpoint resolving to an internal address is refused', async () => {
      Object.assign(geocodeTestHooks, { url: `http://internal.test:${geoPort}`, resolve, isBlocked: undefined, userLimit: 50 });
      const before = geoHits.length;
      const res = await admin.get(`/workspaces/${wid}/geocode?q=Nantes`);
      assert.equal(res.status, 502);
      // Loopback literal and non-standard ports are refused too by the default policy.
      geocodeTestHooks.url = `http://127.0.0.1:${geoPort}`;
      assert.equal((await admin.get(`/workspaces/${wid}/geocode?q=Rennes`)).status, 502);
      assert.equal(geoHits.length, before);
    });
  });
});
