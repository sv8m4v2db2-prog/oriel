// "Brief du jour" (AI module): settings & permissions, API key handling, agent loop with a fake
// Anthropic backend (no network), read-only tools access rules, budget, cost accounting, schedule.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import * as Y from 'yjs';
import type {
  AiBrief,
  AiKeyStatus,
  AiLatestBriefResponse,
  AiSettingsResponse,
  AiUsageResponse,
  DatabaseSchema,
  Page,
  StartBriefResponse,
} from '@oriel/shared';
import { Db } from '../src/db/index.js';
import { indexPage } from '../src/services/search.js';
import { setAiClientFactory } from '../src/ai/client.js';
import { createFakeFetch, toolExchanges, type FakeBrain, type FakeRequest } from '../src/ai/fake.js';
import { messageCost, usageCost } from '../src/ai/pricing.js';
import { scheduleSlot } from '../src/ai/runs.js';
import { addDays, localParts } from '../src/ai/time.js';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor, type TestServer } from './helpers.js';

const FAKE_KEY = 'sk-ant-test-0123456789abcdefWXYZ';
const OPUS = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

describe('ai: brief du jour', () => {
  let srv: TestServer;
  let owner: Client; // instance admin + workspace owner
  let wsAdmin: Client; // workspace admin, not instance admin
  let member: Client;
  let viewer: Client;
  let outsider: Client;
  let wid: string;
  let today: string;

  // Fake Anthropic backend
  let brain: FakeBrain = () => ({ content: [{ type: 'text', text: 'non configuré' }], stop_reason: 'end_turn' });
  const requests: FakeRequest[] = [];
  /** Assertion failures inside the fake backend (they would otherwise surface as a network error). */
  const brainErrors: unknown[] = [];
  const factoryKeys: string[] = [];
  const savedEnv = { key: process.env.ANTHROPIC_API_KEY, fake: process.env.ORIEL_AI_FAKE };

  // Workspace data
  let projectsDb: Page;
  let projet: Page;
  let campaign: Page;
  let planning: Page;
  let dessin: Page;
  let recette: Page;
  let trashedTask: Page;
  let privateDb: Page;
  let privatePage: Page;
  let notePage: Page;

  const settingsUrl = () => `/workspaces/${wid}/ai/settings`;
  const startRun = async (c: Client = owner) => c.post<StartBriefResponse>(`/workspaces/${wid}/ai/briefs`);
  const waitRun = async (id: string) => {
    const brief = await waitFor(
      async () => {
        const b = expectOk(await owner.get<AiBrief>(`/ai/briefs/${id}`));
        return b.status === 'running' ? null : b;
      },
      10_000,
      'brief run',
    );
    if (brainErrors.length) throw brainErrors.splice(0)[0];
    return brief;
  };
  const resultOf = (req: FakeRequest, name: string) => toolExchanges(req.body).filter((c) => c.name === name);

  before(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ORIEL_AI_FAKE;
    setAiClientFactory((apiKey) => {
      factoryKeys.push(apiKey);
      return new Anthropic({
        apiKey,
        maxRetries: 0,
        fetch: createFakeFetch(async (req) => {
          requests.push(req);
          try {
            return await brain(req);
          } catch (err) {
            brainErrors.push(err);
            throw err;
          }
        }),
      });
    });
    srv = await startTestServer();
    ({ admin: owner, wid } = await setupAdmin(srv.base));
    ({ client: wsAdmin } = await addMember(owner, wid, 'admin2@oriel.test', 'Adrien', 'admin'));
    const m = await addMember(owner, wid, 'membre@oriel.test', 'Marc Martin', 'member');
    member = m.client;
    ({ client: viewer } = await addMember(owner, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await owner.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    today = localParts(Date.now(), 'Europe/Paris').date;

    const addProp = async (did: string, property: Record<string, unknown>) =>
      expectOk(await owner.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties.at(-1)!.id;
    const addRow = async (did: string, title: string, properties: Record<string, unknown>) =>
      expectOk(await owner.post<Page>(`/databases/${did}/rows`, { title, properties }));

    // "Projets" database: status, delivery date, project lead.
    projectsDb = await createPage(owner, wid, { kind: 'database', title: 'Projets', emptyDatabase: true });
    const pStatus = await addProp(projectsDb.id, { name: 'Statut', type: 'status' });
    const pDelivery = await addProp(projectsDb.id, { name: 'Date de livraison', type: 'date' });
    const pLead = await addProp(projectsDb.id, { name: 'Chef de projet', type: 'person' });
    projet = await addRow(projectsDb.id, 'Projet Alpha', { [pStatus]: 'in_progress', [pDelivery]: { start: addDays(today, 10) }, [pLead]: [m.user.id] });
    campaign = await addRow(projectsDb.id, 'Campagne climat', { [pStatus]: 'not_started', [pDelivery]: { start: addDays(today, 3) } });
    await addRow(projectsDb.id, 'Archive 2025', { [pStatus]: 'done' });

    // Retro-planning inline in the "Projet Alpha" row page.
    planning = await createPage(owner, wid, { parentType: 'page', parentId: projet.id, kind: 'database', title: 'Rétro-planning', isInline: true, emptyDatabase: true });
    const tStatus = await addProp(planning.id, { name: 'Statut', type: 'status' });
    const tDue = await addProp(planning.id, { name: 'Échéance', type: 'date' });
    const tOwner = await addProp(planning.id, { name: 'Responsable', type: 'person' });
    await addRow(planning.id, 'Collecte', { [tStatus]: 'done', [tDue]: { start: addDays(today, -8) } });
    dessin = await addRow(planning.id, 'Dessin V1', { [tStatus]: 'in_progress', [tDue]: { start: addDays(today, -3) }, [tOwner]: [m.user.id] });
    recette = await addRow(planning.id, 'Recette', { [tStatus]: 'not_started', [tDue]: { start: addDays(today, 2) } });
    trashedTask = await addRow(planning.id, 'Bilan annulé', { [tStatus]: 'not_started', [tDue]: { start: addDays(today, -1) } });
    expectOk(await owner.post(`/pages/${trashedTask.id}/trash`));

    // Private content of the owner: never visible to the agent.
    privateDb = await createPage(owner, wid, { kind: 'database', title: 'Projets secrets', visibility: 'private', emptyDatabase: true });
    await addRow(privateDb.id, 'Tâche secrète', {});
    privatePage = await createPage(owner, wid, { title: 'Notes privées', visibility: 'private' });
    notePage = await createPage(owner, wid, { title: 'Note de cadrage' });

    // Page texts (normally written by the collaboration server).
    const db = new Db(path.join(srv.dataDir, 'oriel.db'));
    const state = Y.encodeStateAsUpdate(new Y.Doc());
    const writeText = (page: Page, text: string) => {
      db.run('INSERT OR REPLACE INTO documents (page_id, state, text, updated_at) VALUES (?, ?, ?, ?)', page.id, state, text, Date.now());
      indexPage(db, { id: page.id, workspace_id: wid, title: page.title }, text);
    };
    writeText(projet, 'Livraison au salon le 24. Jalon : validation client du dessin.');
    writeText(privatePage, 'Budget confidentiel du salon.');
    writeText(notePage, 'Le cadrage du salon est validé.');
    db.close();
  });

  after(async () => {
    setAiClientFactory(null);
    if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.key;
    if (savedEnv.fake === undefined) delete process.env.ORIEL_AI_FAKE;
    else process.env.ORIEL_AI_FAKE = savedEnv.fake;
    await srv.stop();
  });

  test('settings: defaults, read for members, write for workspace admins only, validation', async () => {
    const res = expectOk(await member.get<AiSettingsResponse>(settingsUrl()));
    assert.deepEqual(
      { ...res.settings, updatedAt: null },
      {
        enabled: false,
        model: 'claude-opus-5-5',
        sourceDatabaseIds: [],
        scheduleTime: '07:30',
        scheduleDays: [1, 2, 3, 4, 5],
        timezone: 'Europe/Paris',
        monthlyBudgetUsd: 15,
        updatedAt: null,
        updatedBy: null,
      },
    );
    assert.equal(res.configured, false);
    assert.match(res.blocker ?? '', /désactivé/);
    assert.equal(res.canManage, false);
    assert.equal(res.canManageKey, false);
    assert.equal(res.canRun, true);
    assert.deepEqual(res.databases, []);
    assert.equal(expectOk(await viewer.get<AiSettingsResponse>(settingsUrl())).canRun, false);
    assert.equal((await outsider.get(settingsUrl())).status, 404);

    assert.equal((await member.put(settingsUrl(), { enabled: true })).status, 403);
    assert.equal((await viewer.put(settingsUrl(), { enabled: true })).status, 403);
    assert.equal((await outsider.put(settingsUrl(), { enabled: true })).status, 404);
    for (const bad of [
      { scheduleTime: '25:00' },
      { timezone: 'Mars/Olympus' },
      { model: 'gpt-x' },
      { monthlyBudgetUsd: -1 },
      { scheduleDays: [0] },
      { unknown: true },
      { sourceDatabaseIds: [privateDb.id] },
      { sourceDatabaseIds: [projet.id] },
    ]) {
      assert.equal((await owner.put(settingsUrl(), bad)).status, 400, JSON.stringify(bad));
    }

    const saved = expectOk(
      await wsAdmin.put<AiSettingsResponse>(settingsUrl(), {
        enabled: true,
        sourceDatabaseIds: [projectsDb.id],
        scheduleTime: '08:15',
        scheduleDays: [5, 1, 1],
        timezone: 'Europe/Paris',
        monthlyBudgetUsd: 20,
      }),
    );
    assert.equal(saved.settings.enabled, true);
    assert.deepEqual(saved.settings.scheduleDays, [1, 5]);
    assert.equal(saved.settings.scheduleTime, '08:15');
    assert.deepEqual(saved.sources, [{ id: projectsDb.id, title: 'Projets', icon: null, available: true }]);
    assert.equal(saved.canManage, true);
    const options = new Map(saved.databases.map((d) => [d.id, d.path]));
    assert.equal(options.get(projectsDb.id), '');
    assert.equal(options.get(planning.id), 'Projets / Projet Alpha');
    assert.ok(!options.has(privateDb.id), 'private database offered as a source');
    // Still blocked: no API key on the instance.
    assert.equal(saved.configured, false);
    assert.match(saved.blocker ?? '', /clé API/);
    assert.equal((await owner.post(`/workspaces/${wid}/ai/briefs`)).status, 400);
  });

  test('instance API key: admin only, never returned to clients, env var preferred', async () => {
    assert.equal((await member.put('/admin/ai/key', { apiKey: FAKE_KEY })).status, 403);
    assert.equal((await wsAdmin.put('/admin/ai/key', { apiKey: FAKE_KEY })).status, 403);
    assert.equal((await wsAdmin.del('/admin/ai/key')).status, 403);
    assert.equal((await owner.put('/admin/ai/key', { apiKey: 'court' })).status, 400);

    const status = expectOk(await owner.put<AiKeyStatus>('/admin/ai/key', { apiKey: FAKE_KEY }));
    assert.deepEqual(status, { source: 'saved', hint: '…WXYZ' });
    const asOwner = await owner.get<AiSettingsResponse>(settingsUrl());
    assert.deepEqual(asOwner.body.key, { source: 'saved', hint: '…WXYZ' });
    assert.equal(asOwner.body.configured, true);
    assert.equal(asOwner.body.canManageKey, true);
    const asMember = await member.get<AiSettingsResponse>(settingsUrl());
    assert.deepEqual(asMember.body.key, { source: 'saved', hint: null });
    for (const res of [asOwner, asMember, await owner.get('/admin/settings'), await owner.get(`/workspaces/${wid}/ai/usage`)]) {
      assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY.slice(0, 20)), 'key leaked');
    }

    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key-000000000000000ENVK';
    try {
      assert.deepEqual(expectOk(await owner.get<AiSettingsResponse>(settingsUrl())).key, { source: 'env', hint: '…ENVK' });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    assert.deepEqual(expectOk(await owner.del<AiKeyStatus>('/admin/ai/key')), { source: 'none', hint: null });
    expectOk(await owner.put('/admin/ai/key', { apiKey: FAKE_KEY }));
  });

  test('manual run: 3-turn tool loop ending with publier_brief, request shape, cost accounting', async () => {
    requests.length = 0;
    factoryKeys.length = 0;
    const usage = [
      { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 },
      { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 400, cache_read_input_tokens: 3000 },
      { input_tokens: 200, output_tokens: 1500, cache_creation_input_tokens: 300, cache_read_input_tokens: 3400 },
    ];
    brain = (req) => {
      const turn = requests.length;
      if (turn === 1) {
        return { content: [{ type: 'text', text: 'Je regarde les sources.' }, { type: 'tool_use', name: 'lister_sources', input: {} }], stop_reason: 'tool_use', usage: usage[0] };
      }
      if (turn === 2) {
        const listing = JSON.parse(resultOf(req, 'lister_sources')[0]!.result!);
        const source = listing.sources[0];
        assert.equal(source.id, projectsDb.id);
        assert.equal(source.proprieteDate, 'Date de livraison');
        assert.equal(source.proprieteStatut, 'Statut');
        assert.equal(source.nonTerminees, 2);
        assert.deepEqual(source.basesDansLesLignes.map((b: { id: string }) => b.id), [planning.id]);
        return {
          content: [
            { type: 'tool_use', name: 'interroger_base', input: { baseId: planning.id, statut: 'non_termine' } },
            { type: 'tool_use', name: 'lire_page', input: { pageId: projet.id } },
            { type: 'tool_use', name: 'rechercher', input: { requete: 'salon' } },
          ],
          stop_reason: 'tool_use',
          usage: usage[1],
        };
      }
      const rows = JSON.parse(resultOf(req, 'interroger_base')[0]!.result!);
      assert.deepEqual(rows.lignes.map((l: { titre: string }) => l.titre), ['Dessin V1', 'Recette']);
      assert.equal(rows.lignes[0].enRetard, true);
      assert.equal(rows.lignes[0].props.Responsable, 'Marc Martin');
      const page = JSON.parse(resultOf(req, 'lire_page')[0]!.result!);
      assert.equal(page.type, 'ligne');
      assert.match(page.contenu, /salon le 24/);
      assert.deepEqual(page.bases.map((b: { id: string }) => b.id), [planning.id]);
      assert.equal(page.props['Chef de projet'], 'Marc Martin');
      const search = JSON.parse(resultOf(req, 'rechercher')[0]!.result!);
      const found = search.resultats.map((r: { id: string }) => r.id);
      assert.ok(found.includes(notePage.id) && found.includes(projet.id));
      assert.ok(!found.includes(privatePage.id), 'private page in search results');
      const item = (p: Page, note: string) => ({ titre: p.title, pageId: p.id, projetId: projet.id, echeance: null, responsables: ['Marc Martin'], note });
      return {
        content: [
          {
            type: 'tool_use',
            name: 'publier_brief',
            input: {
              resume: 'Le dessin du projet Alpha a 3 jours de retard.',
              priorites: [item(dessin, 'Débloquer la V1.'), { ...item(recette, ''), pageId: 'page-inventee' }],
              en_retard: [{ ...item(dessin, '3 jours'), echeance: addDays(today, -3) }],
              a_venir: [{ ...item(recette, ''), echeance: 'demain' }],
              risques: [{ description: 'La livraison au salon est menacée.', gravite: 'haute', pages: [dessin.id, 'inconnue', projet.id] }],
              projets: [
                { pageId: projet.id, titre: 'Projet Alpha', etat: 'a_surveiller', commentaire: 'Dessin en retard.' },
                { pageId: campaign.id, titre: 'Campagne climat', etat: 'en_bonne_voie', commentaire: '' },
                { pageId: privateDb.id, titre: 'Secret', etat: 'en_retard', commentaire: '' },
              ],
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: usage[2],
      };
    };

    const res = await startRun(member);
    assert.equal(res.status, 202);
    assert.equal(res.body.brief.status, 'running');
    assert.equal(res.body.brief.trigger, 'manual');
    assert.equal(res.body.brief.briefDate, today);
    const done = await waitRun(res.body.brief.id);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(requests.length, 3);
    assert.deepEqual(factoryKeys, [FAKE_KEY]);

    // Request shape (every turn).
    for (const req of requests) {
      const b = req.body;
      assert.equal(b.model, 'claude-opus-5-5');
      assert.equal(b.stream, true);
      assert.equal(b.max_tokens, 16000);
      assert.deepEqual(b.output_config, { effort: 'medium' });
      assert.equal(b.thinking, undefined);
      assert.deepEqual(b.tool_choice, { type: 'auto' });
      assert.equal(b.fallbacks, 'default');
      assert.match(req.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
      assert.deepEqual(b.cache_control, { type: 'ephemeral' });
      assert.equal(b.system.length, 1);
      assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
      assert.ok(!b.system[0].text.includes(today), 'volatile data in the system prompt');
      assert.deepEqual(
        b.tools.map((t: { name: string }) => t.name),
        ['lister_sources', 'interroger_base', 'lire_page', 'rechercher', 'publier_brief'],
      );
      const publish = b.tools.at(-1);
      assert.equal(publish.strict, true);
      assert.equal(publish.input_schema.additionalProperties, false);
      assert.match(b.messages[0].content, new RegExp(`Date du jour : ${today}`));
      assert.equal(req.headers.get('x-api-key'), FAKE_KEY);
    }
    // Append-only history: each request extends the previous one.
    assert.equal(requests[1]!.body.messages.length, 3);
    assert.equal(requests[2]!.body.messages.length, 5);

    // Content: validated and sanitized.
    const c = done.content!;
    assert.equal(c.resume, 'Le dessin du projet Alpha a 3 jours de retard.');
    assert.deepEqual(c.priorites.map((i) => i.pageId), [dessin.id]);
    assert.equal(c.priorites[0]!.cible, 'ligne');
    assert.equal(c.priorites[0]!.projetTitre, 'Projet Alpha');
    assert.equal(c.en_retard[0]!.echeance, addDays(today, -3));
    assert.equal(c.a_venir[0]!.echeance, null);
    assert.deepEqual(c.risques[0]!.pages.map((p) => p.id), [dessin.id, projet.id]);
    assert.deepEqual(c.projets.map((p) => p.pageId), [projet.id, campaign.id]);

    // Tokens and cost (Opus 5.5 rates).
    const sum = (k: keyof (typeof usage)[0]) => usage.reduce((s, u) => s + u[k], 0);
    assert.deepEqual(done.usage, {
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      cacheCreationTokens: sum('cache_creation_input_tokens'),
      cacheReadTokens: sum('cache_read_input_tokens'),
    });
    const expected = usage.reduce((s, u) => s + usageCost(u, OPUS), 0);
    assert.ok(Math.abs(done.costUsd - expected) < 1e-6, `${done.costUsd} vs ${expected}`);
    assert.equal(done.turns, 3);
    assert.ok(done.finishedAt! >= done.startedAt);

    const latest = expectOk(await viewer.get<AiLatestBriefResponse>(`/workspaces/${wid}/ai/briefs/latest`));
    assert.equal(latest.latest?.id, done.id);
    assert.equal(latest.running, null);
    const history = expectOk(await viewer.get<{ briefs: AiBrief[] }>(`/workspaces/${wid}/ai/briefs?limit=5`));
    assert.equal(history.briefs[0]!.id, done.id);
    assert.equal((history.briefs[0] as Partial<AiBrief>).content, undefined);
    assert.equal((await outsider.get(`/ai/briefs/${done.id}`)).status, 404);
    assert.equal((await outsider.get(`/workspaces/${wid}/ai/briefs`)).status, 404);
  });

  test('tools never expose private or trashed pages, nor other workspaces', async () => {
    requests.length = 0;
    const otherWs = expectOk(await outsider.get<{ workspaces: Array<{ id: string }> }>('/auth/me')).workspaces[0]!.id;
    const foreign = await createPage(outsider, otherWs, { title: 'Page étrangère' });
    brain = (req) => {
      if (requests.length === 1) {
        return {
          content: [
            { type: 'tool_use', name: 'lire_page', input: { pageId: privatePage.id } },
            { type: 'tool_use', name: 'lire_page', input: { pageId: foreign.id } },
            { type: 'tool_use', name: 'lire_page', input: { pageId: trashedTask.id } },
            { type: 'tool_use', name: 'interroger_base', input: { baseId: privateDb.id } },
            { type: 'tool_use', name: 'interroger_base', input: { baseId: planning.id } },
            { type: 'tool_use', name: 'interroger_base', input: { baseId: 42 } },
            { type: 'tool_use', name: 'rechercher', input: { requete: 'secrète' } },
            { type: 'tool_use', name: 'rechercher', input: { requete: 'confidentiel' } },
          ],
          stop_reason: 'tool_use',
        };
      }
      const calls = toolExchanges(req.body);
      const reads = calls.filter((c) => c.name === 'lire_page');
      assert.ok(reads.every((r) => r.isError && /introuvable/.test(r.result ?? '')), JSON.stringify(reads));
      const queries = calls.filter((c) => c.name === 'interroger_base');
      assert.ok(queries[0]!.isError);
      const titles = JSON.parse(queries[1]!.result!).lignes.map((l: { titre: string }) => l.titre);
      assert.deepEqual(titles, ['Collecte', 'Dessin V1', 'Recette']);
      assert.ok(queries[2]!.isError, 'invalid input must be rejected');
      for (const s of calls.filter((c) => c.name === 'rechercher')) {
        assert.deepEqual(JSON.parse(s.result!).resultats, [], s.result!);
      }
      return {
        content: [
          {
            type: 'tool_use',
            name: 'publier_brief',
            input: {
              resume: 'Rien.',
              priorites: [],
              en_retard: [{ titre: 'x', pageId: privatePage.id, projetId: null, echeance: null, responsables: [], note: '' }],
              a_venir: [{ titre: 'y', pageId: trashedTask.id, projetId: null, echeance: null, responsables: [], note: '' }],
              risques: [],
              projets: [],
            },
          },
        ],
        stop_reason: 'tool_use',
      };
    };
    const res = expectOk(await startRun(), 202);
    const done = await waitRun(res.brief.id);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.deepEqual(done.content!.en_retard, []);
    assert.deepEqual(done.content!.a_venir, []);
  });

  test('one running brief per workspace (409), invalid payload retried, viewer cannot run', async () => {
    requests.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    brain = async (req) => {
      if (requests.length === 1) {
        await gate;
        // Invalid payload first (missing sections): the error goes back to the model.
        return { content: [{ type: 'tool_use', name: 'publier_brief', input: { resume: 'incomplet' } }], stop_reason: 'tool_use' };
      }
      const failed = toolExchanges(req.body).find((c) => c.name === 'publier_brief');
      assert.ok(failed?.isError && /Brief invalide/.test(failed.result ?? ''));
      return {
        content: [{ type: 'tool_use', name: 'publier_brief', input: { resume: 'OK', priorites: [], en_retard: [], a_venir: [], risques: [], projets: [] } }],
        stop_reason: 'tool_use',
      };
    };
    const first = expectOk(await startRun(), 202);
    await waitFor(() => requests.length === 1, 5000, 'first request');
    assert.equal((await startRun(member)).status, 409);
    assert.equal((await startRun(viewer)).status, 403);
    assert.equal((await startRun(outsider)).status, 404);
    const latest = expectOk(await member.get<AiLatestBriefResponse>(`/workspaces/${wid}/ai/briefs/latest`));
    assert.equal(latest.running?.id, first.brief.id);
    release();
    const done = await waitRun(first.brief.id);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(done.content!.resume, 'OK');
    assert.equal(done.turns, 2);
  });

  test('errors: typed API errors and refusals become French messages; Haiku has no fallback', async () => {
    brain = () => ({ httpStatus: 401, errorType: 'authentication_error', message: 'invalid x-api-key' });
    let done = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'Clé API Anthropic invalide ou révoquée.');

    brain = () => ({ httpStatus: 429, errorType: 'rate_limit_error', message: 'slow down' });
    done = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.match(done.error ?? '', /Limite de débit/);

    brain = () => ({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    done = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /refusé/);
    assert.equal(done.turns, 1);
    assert.ok(done.costUsd > 0);

    // The model stops without publishing: one reminder, then failure.
    requests.length = 0;
    brain = () => ({ content: [{ type: 'text', text: 'Voici le brief en texte.' }], stop_reason: 'end_turn' });
    done = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.equal(done.status, 'failed');
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]!.body.messages.at(-1)), /publier_brief/);

    expectOk(await owner.put(settingsUrl(), { model: 'claude-haiku-5-5' }));
    requests.length = 0;
    brain = () => ({
      content: [{ type: 'tool_use', name: 'publier_brief', input: { resume: 'Haiku', priorites: [], en_retard: [], a_venir: [], risques: [], projets: [] } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    done = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(done.model, 'claude-haiku-5-5');
    assert.ok(Math.abs(done.costUsd - 0.6) < 1e-9, String(done.costUsd));
    assert.equal(requests[0]!.body.fallbacks, undefined);
    assert.doesNotMatch(requests[0]!.headers.get('anthropic-beta') ?? '', /server-side-fallback/);
    expectOk(await owner.put(settingsUrl(), { model: 'claude-opus-5-5' }));
  });

  test('budget: skipped once the month spend reaches the cap, stopped mid-run otherwise; usage report', async () => {
    const before = expectOk(await member.get<AiUsageResponse>(`/workspaces/${wid}/ai/usage`));
    assert.equal(before.month, today.slice(0, 7));
    assert.ok(before.spentUsd > 0);
    assert.equal(before.budgetUsd, 20);

    // Cap below the spend: the run is recorded as skipped, without any API call.
    expectOk(await owner.put(settingsUrl(), { monthlyBudgetUsd: Math.floor(before.spentUsd * 100) / 100 }));
    requests.length = 0;
    const skipped = await startRun();
    assert.equal(skipped.status, 202);
    assert.equal(skipped.body.brief.status, 'skipped');
    assert.match(skipped.body.brief.error ?? '', /Plafond mensuel atteint/);
    assert.equal(requests.length, 0);

    // Small headroom: the first turn exhausts it and the run stops.
    expectOk(await owner.put(settingsUrl(), { monthlyBudgetUsd: Math.ceil(before.spentUsd * 100) / 100 + 0.01 }));
    brain = () => ({
      content: [{ type: 'tool_use', name: 'lister_sources', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10_000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const stopped = await waitRun(expectOk(await startRun(), 202).brief.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /Plafond mensuel atteint pendant/);
    assert.equal(stopped.turns, 1);

    const after = expectOk(await member.get<AiUsageResponse>(`/workspaces/${wid}/ai/usage`));
    assert.equal(after.skipped, 1);
    assert.ok(after.succeeded >= 3);
    assert.ok(Math.abs(after.spentUsd - (before.spentUsd + stopped.costUsd)) < 1e-5);
    assert.ok(after.averageCostUsd !== null && after.averageCostUsd > 0);
    expectOk(await owner.put(settingsUrl(), { monthlyBudgetUsd: 20 }));
  });

  test('demo mode (ORIEL_AI_FAKE=1) builds a brief from real tool calls', async () => {
    setAiClientFactory(null);
    process.env.ORIEL_AI_FAKE = '1';
    process.env.ORIEL_AI_FAKE_DELAY_MS = '0';
    try {
      expectOk(await owner.del('/admin/ai/key'));
      const settings = expectOk(await owner.get<AiSettingsResponse>(settingsUrl()));
      assert.equal(settings.fakeMode, true);
      assert.equal(settings.configured, true);
      const done = await waitRun(expectOk(await startRun(), 202).brief.id);
      assert.equal(done.status, 'succeeded', done.error ?? '');
      const c = done.content!;
      assert.deepEqual(c.en_retard.map((i) => i.pageId), [dessin.id]);
      assert.equal(c.en_retard[0]!.projetId, projet.id);
      assert.deepEqual(c.en_retard[0]!.responsables, ['Marc Martin']);
      assert.ok(c.a_venir.some((i) => i.pageId === recette.id));
      assert.ok(c.projets.some((p) => p.pageId === projet.id && p.etat === 'a_surveiller'));
      assert.ok(done.turns >= 3 && done.costUsd > 0);
    } finally {
      delete process.env.ORIEL_AI_FAKE;
      delete process.env.ORIEL_AI_FAKE_DELAY_MS;
      expectOk(await owner.put('/admin/ai/key', { apiKey: FAKE_KEY }));
    }
  });
});

describe('ai: schedule and pricing', () => {
  const settings = { scheduleTime: '07:30', scheduleDays: [1, 2, 3, 4, 5] as Array<1 | 2 | 3 | 4 | 5 | 6 | 7>, timezone: 'Europe/Paris' };

  test('scheduleSlot follows the local time, weekdays and a 2-hour catch-up window', () => {
    // Wednesday 14 October 2026; Paris is UTC+2 (CEST).
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 9, 14, 5, 29)), null);
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 9, 14, 5, 30)), '2026-10-14');
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 9, 14, 7, 29)), '2026-10-14');
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 9, 14, 7, 30)), null);
    // Saturday
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 9, 17, 5, 45)), null);
    assert.equal(scheduleSlot({ ...settings, scheduleDays: [6] }, Date.UTC(2026, 9, 17, 5, 45)), '2026-10-17');
    // Winter time (UTC+1) and another zone
    assert.equal(scheduleSlot(settings, Date.UTC(2026, 11, 1, 6, 30)), '2026-12-01');
    assert.equal(scheduleSlot({ ...settings, timezone: 'America/New_York' }, Date.UTC(2026, 9, 14, 11, 30)), '2026-10-14');
    // Late evening UTC is already the next local day in Tokyo
    assert.equal(localParts(Date.UTC(2026, 9, 14, 23, 0), 'Asia/Tokyo').date, '2026-10-15');
  });

  test('cost: per-model rates, cache writes/reads, refusal fallback iterations', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    assert.equal(messageCost({ model: 'claude-opus-5-5', usage: u }, 'claude-opus-5-5'), 4 + 20 + 5 + 0.2);
    assert.equal(messageCost({ model: 'claude-sonnet-5-5', usage: u }, 'claude-sonnet-5-5'), 2 + 10 + 2.5 + 0.2);
    assert.ok(Math.abs(messageCost({ model: 'claude-haiku-5-5', usage: u }, 'claude-haiku-5-5') - (0.1 + 0.5 + 0.125 + 0.01)) < 1e-12);
    // Fallback: each iteration at its own model's rates.
    const cost = messageCost(
      {
        model: 'claude-opus-4-8',
        usage: {
          ...u,
          iterations: [
            { type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          ],
        },
      },
      'claude-opus-5-5',
    );
    assert.equal(cost, 4 + 5 + 25);
    // Unknown model: priced at the requested model's rates.
    assert.equal(messageCost({ model: 'claude-future', usage: { input_tokens: 1_000_000, output_tokens: 0 } }, 'claude-sonnet-5-5'), 2);
  });
});
