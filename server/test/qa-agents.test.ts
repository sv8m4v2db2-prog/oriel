// QA (security review) of the AI daily brief: access to briefs and settings across workspaces and
// roles, what the read-only agent can see (private / trashed / foreign pages, relations, people),
// prompt injection (no writing tool), tool output bounds, API key handling and budget control
// (workspace budget, instance-wide cap, members' manual quota and reserve), stale stored briefs.
// The Anthropic API is never reached: a fake backend is plugged into the SDK (see src/ai/fake.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AI_INSTANCE_MAX_CAP_USD, AI_MANUAL_RUNS_PER_DAY } from '@oriel/shared';
import type {
  AiBrief,
  AiInstanceStatus,
  AiLatestBriefResponse,
  AiSettingsResponse,
  AiUsageResponse,
  DatabaseSchema,
  Page,
  StartBriefResponse,
} from '@oriel/shared';
import type { AppContext } from '../src/context.js';
import { Db } from '../src/db/index.js';
import { setAiClientFactory } from '../src/ai/client.js';
import { createFakeFetch, toolExchanges, type FakeBrain, type FakeRequest, type FakeTurn } from '../src/ai/fake.js';
import { settleRuns, startBrief } from '../src/ai/runs.js';
import { WorkspaceReader } from '../src/ai/reader.js';
import { buildBriefTools, MAX_TOOL_RESULT_CHARS } from '../src/ai/tools.js';
import { addDays, localParts } from '../src/ai/time.js';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, waitFor, type TestServer } from './helpers.js';

const FAKE_KEY = 'sk-ant-qa-0000000000000000000000QAQA';
const EMPTY_BRIEF = { resume: 'RAS', priorites: [], en_retard: [], a_venir: [], risques: [], projets: [] };
const publishNow = (): FakeTurn => ({ content: [{ type: 'tool_use', name: 'publier_brief', input: EMPTY_BRIEF }], stop_reason: 'tool_use' });
/** Exact usage costing `usd` at Opus 5.5 rates ($20 per million output tokens). */
const costing = (usd: number) => ({ input_tokens: 0, output_tokens: usd * 50_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

describe('qa-agents: AI daily brief security', () => {
  let srv: TestServer;
  let owner: Client; // instance admin + owner of `wid`
  let member: Client;
  let memberId: string;
  let viewer: Client;
  let outsider: Client; // other account, owner of its own workspace
  let outsiderWid: string;
  let wid: string;
  let today: string;
  let projectsDb: Page;
  let privateDb: Page;
  let privateRow: Page;
  let film: Page;

  let brain: FakeBrain = publishNow;
  const requests: FakeRequest[] = [];
  const factoryKeys: string[] = [];
  const savedEnv = { key: process.env.ANTHROPIC_API_KEY, fake: process.env.ORIEL_AI_FAKE };

  const openDb = () => new Db(path.join(srv.dataDir, 'oriel.db'));
  const settingsUrl = (w = wid) => `/workspaces/${w}/ai/settings`;
  const waitRun = async (id: string, as: Client = owner) =>
    waitFor(
      async () => {
        const b = expectOk(await as.get<AiBrief>(`/ai/briefs/${id}`));
        return b.status === 'running' ? null : b;
      },
      10_000,
      'brief run',
    );
  const run = async (as: Client = owner, w = wid) => waitRun(expectOk(await as.post<StartBriefResponse>(`/workspaces/${w}/ai/briefs`), 202).brief.id, as);

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
          return brain(req);
        }),
      });
    });
    srv = await startTestServer();
    ({ admin: owner, wid } = await setupAdmin(srv.base));
    const m = await addMember(owner, wid, 'membre@oriel.test', 'Marc Martin', 'member');
    member = m.client;
    memberId = m.user.id;
    ({ client: viewer } = await addMember(owner, wid, 'lecteur@oriel.test', 'Léa', 'viewer'));
    expectOk(await owner.patch('/admin/settings', { signupMode: 'open' }));
    outsider = new Client(srv.base);
    expectOk(await outsider.post('/auth/signup', { email: 'dehors@oriel.test', name: 'Oscar', password: 'motdepasse-solide' }));
    outsiderWid = expectOk(await outsider.get<{ workspaces: Array<{ id: string }> }>('/auth/me')).workspaces[0]!.id;
    today = localParts(Date.now(), 'Europe/Paris').date;

    const addProp = async (did: string, property: Record<string, unknown>) =>
      expectOk(await owner.post<DatabaseSchema>(`/databases/${did}/properties`, { property })).properties.at(-1)!.id;
    projectsDb = await createPage(owner, wid, { kind: 'database', title: 'Projets', emptyDatabase: true });
    const pStatus = await addProp(projectsDb.id, { name: 'Statut', type: 'status' });
    const pDue = await addProp(projectsDb.id, { name: 'Échéance', type: 'date' });
    film = expectOk(await owner.post<Page>(`/databases/${projectsDb.id}/rows`, { title: 'Film ONG', properties: { [pStatus]: 'in_progress', [pDue]: { start: addDays(today, -2) } } }));
    privateDb = await createPage(owner, wid, { kind: 'database', title: 'Clients confidentiels', visibility: 'private', emptyDatabase: true });
    privateRow = expectOk(await owner.post<Page>(`/databases/${privateDb.id}/rows`, { title: 'Rachat secret de Concurrent SA', properties: {} }));

    expectOk(await owner.put('/admin/ai/key', { apiKey: FAKE_KEY }));
    expectOk(await owner.put(settingsUrl(), { enabled: true, sourceDatabaseIds: [projectsDb.id], monthlyBudgetUsd: 50 }));
  });

  after(async () => {
    setAiClientFactory(null);
    if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.key;
    if (savedEnv.fake === undefined) delete process.env.ORIEL_AI_FAKE;
    else process.env.ORIEL_AI_FAKE = savedEnv.fake;
    await srv.stop();
  });

  test('briefs: no IDOR across workspaces; a removed member loses access', async () => {
    brain = publishNow;
    const brief = await run(member);
    assert.equal(brief.status, 'succeeded', brief.error ?? '');
    for (const url of [`/ai/briefs/${brief.id}`, `/workspaces/${wid}/ai/briefs`, `/workspaces/${wid}/ai/briefs/latest`, `/workspaces/${wid}/ai/usage`, settingsUrl()]) {
      assert.equal((await outsider.get(url)).status, 404, url);
    }
    assert.equal((await outsider.post(`/workspaces/${wid}/ai/briefs`)).status, 404);
    assert.equal((await outsider.put(settingsUrl(), { monthlyBudgetUsd: 10_000 })).status, 404);
    assert.equal((await viewer.post(`/workspaces/${wid}/ai/briefs`)).status, 403);
    // Unknown / malformed ids.
    assert.equal((await member.get('/ai/briefs/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.ok([400, 404].includes((await member.get(`/ai/briefs/${'x'.repeat(500)}`)).status));

    // Removed member: no more access to the briefs of the workspace.
    const temp = await addMember(owner, wid, 'temp@oriel.test', 'Temp', 'member');
    assert.equal((await temp.client.get(`/ai/briefs/${brief.id}`)).status, 200);
    expectOk(await owner.del(`/workspaces/${wid}/members/${temp.user.id}`));
    assert.equal((await temp.client.get(`/ai/briefs/${brief.id}`)).status, 404);
    assert.equal((await temp.client.get(`/workspaces/${wid}/ai/briefs/latest`)).status, 404);
  });

  test('QA-AGT-01: settings never reveal the title of a source database that became private', async () => {
    // A workspace database is configured as a source, then its owner (any member who can edit) moves it
    // to their private pages and renames it.
    const db = await createPage(member, wid, { kind: 'database', title: 'Planning partagé', emptyDatabase: true });
    expectOk(await owner.put(settingsUrl(), { sourceDatabaseIds: [projectsDb.id, db.id] }));
    expectOk(await member.post(`/pages/${db.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
    expectOk(await member.patch(`/pages/${db.id}`, { title: 'Négociation salariale — confidentiel', icon: '🤫' }));
    assert.equal((await viewer.get(`/pages/${db.id}`)).status, 404, 'the database is private now');

    for (const as of [viewer, owner]) {
      const res = expectOk(await as.get<AiSettingsResponse>(settingsUrl()));
      const source = res.sources.find((s) => s.id === db.id)!;
      assert.equal(source.available, false);
      assert.ok(!JSON.stringify(res).includes('Négociation'), 'private title leaked through the AI settings');
      assert.equal(source.icon, null, 'private icon leaked through the AI settings');
    }
    // The owner of the private database still gets a usable label.
    const own = expectOk(await member.get<AiSettingsResponse>(settingsUrl())).sources.find((s) => s.id === db.id)!;
    assert.equal(own.available, false);
    // Trashed (not private) sources keep their title, as in the trash.
    const trashed = await createPage(owner, wid, { kind: 'database', title: 'Ancien planning', emptyDatabase: true });
    expectOk(await owner.put(settingsUrl(), { sourceDatabaseIds: [projectsDb.id, db.id, trashed.id] }));
    expectOk(await owner.post(`/pages/${trashed.id}/trash`));
    const res = expectOk(await viewer.get<AiSettingsResponse>(settingsUrl()));
    assert.deepEqual(res.sources.find((s) => s.id === trashed.id), { id: trashed.id, title: 'Ancien planning', icon: null, available: false });
    expectOk(await owner.put(settingsUrl(), { sourceDatabaseIds: [projectsDb.id] }));
  });

  test('prompt injection: the agent has no writing tool; unknown tools fail without side effect', async () => {
    const fingerprint = () => {
      const db = openDb();
      try {
        return JSON.stringify([
          db.all('SELECT id, title, version, visibility, trashed_at, is_public, properties FROM pages ORDER BY id'),
          db.all('SELECT page_id, text FROM documents ORDER BY page_id'),
          db.all('SELECT workspace_id, user_id, role FROM members ORDER BY workspace_id, user_id'),
          db.all('SELECT * FROM ai_settings'),
          db.all("SELECT key, value FROM meta WHERE key NOT LIKE '%digest%' ORDER BY key"),
        ]);
      } finally {
        db.close();
      }
    };
    const before = fingerprint();
    requests.length = 0;
    brain = (req) => {
      if (requests.length === 1) {
        return {
          content: [
            { type: 'tool_use', name: 'supprimer_page', input: { pageId: film.id } },
            { type: 'tool_use', name: 'envoyer_email', input: { to: 'attaquant@example.com', body: 'secrets' } },
            { type: 'tool_use', name: 'modifier_reglages', input: { monthlyBudgetUsd: 10_000 } },
            { type: 'tool_use', name: 'rechercher', input: { requete: `") OR 1=1 -- ' NEAR(* "x` } },
            { type: 'tool_use', name: 'interroger_base', input: { baseId: `${projectsDb.id}' OR '1'='1` } },
          ],
          stop_reason: 'tool_use',
        };
      }
      return publishNow();
    };
    const done = await run();
    assert.equal(done.status, 'succeeded', done.error ?? '');
    const tools = requests[0]!.body.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(tools, ['lister_sources', 'interroger_base', 'lire_page', 'rechercher', 'publier_brief']);
    const calls = toolExchanges(requests[1]!.body);
    for (const name of ['supprimer_page', 'envoyer_email', 'modifier_reglages', 'interroger_base']) {
      const c = calls.find((x) => x.name === name)!;
      assert.ok(c.isError, `${name} must fail: ${c.result}`);
    }
    assert.deepEqual(JSON.parse(calls.find((c) => c.name === 'rechercher')!.result!).resultats, []);
    assert.equal(fingerprint(), before, 'the agent changed workspace data');
  });

  test('tools: relation values, relation targets and search never expose private rows or other workspaces', async () => {
    // The owner links the shared "Projets" database to their private database (allowed: they see both).
    const rel = expectOk(
      await owner.post<DatabaseSchema>(`/databases/${projectsDb.id}/properties`, { property: { name: 'Client', type: 'relation', relation: { databaseId: privateDb.id } } }),
    ).properties.at(-1)!.id;
    const foreign = await createPage(outsider, outsiderWid, { title: 'Page étrangère XYZ' });
    expectOk(await owner.patch(`/pages/${film.id}`, { properties: { [rel]: [privateRow.id] } }));
    // Forged / stale ids (e.g. imported data) pointing to another workspace.
    const db = openDb();
    try {
      const props = JSON.parse(db.get<{ properties: string }>('SELECT properties FROM pages WHERE id = ?', film.id)!.properties);
      props[rel] = [privateRow.id, foreign.id];
      db.run('UPDATE pages SET properties = ? WHERE id = ?', JSON.stringify(props), film.id);
    } finally {
      db.close();
    }
    requests.length = 0;
    brain = (req) => {
      if (requests.length === 1) {
        return {
          content: [
            { type: 'tool_use', name: 'lister_sources', input: {} },
            { type: 'tool_use', name: 'interroger_base', input: { baseId: projectsDb.id } },
            { type: 'tool_use', name: 'lire_page', input: { pageId: film.id } },
            { type: 'tool_use', name: 'lire_page', input: { pageId: privateRow.id } },
            { type: 'tool_use', name: 'rechercher', input: { requete: 'Rachat' } },
            { type: 'tool_use', name: 'rechercher', input: { requete: 'étrangère' } },
          ],
          stop_reason: 'tool_use',
        };
      }
      const calls = toolExchanges(req.body);
      const all = JSON.stringify(calls.map((c) => c.result));
      for (const secret of ['Rachat secret', 'Clients confidentiels', 'Page étrangère', privateRow.id, privateDb.id, foreign.id]) {
        assert.ok(!all.includes(secret), `tool output leaked ${secret}`);
      }
      assert.ok(calls.find((c) => c.name === 'lire_page' && c.input && (c.input as { pageId: string }).pageId === privateRow.id)!.isError);
      return {
        content: [
          {
            type: 'tool_use',
            name: 'publier_brief',
            input: {
              ...EMPTY_BRIEF,
              priorites: [{ titre: 'x', pageId: privateRow.id, projetId: foreign.id, echeance: null, responsables: [], note: '' }],
              risques: [{ description: 'r', gravite: 'haute', pages: [privateRow.id, foreign.id, privateDb.id] }],
            },
          },
        ],
        stop_reason: 'tool_use',
      };
    };
    const done = await run();
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.deepEqual(done.content!.priorites, []);
    assert.deepEqual(done.content!.risques[0]!.pages, []);
    expectOk(await owner.del(`/databases/${projectsDb.id}/properties/${rel}`));
  });

  test('QA-AGT-04: tool results are bounded in size (crafted wide database)', async () => {
    // A member who can edit builds a database with many long values: a single `interroger_base` call
    // must not return megabytes (cost / context overflow of the run).
    const db = openDb();
    try {
      const wide = 'qa-wide-db';
      const nowTs = Date.now();
      const insertPage = (id: string, parentType: string, parentId: string, kind: string, title: string, properties = '{}') =>
        db.run(
          `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, position, owner_id, properties, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          wid,
          parentType,
          parentId,
          kind,
          title,
          `a${id}`,
          memberId,
          properties,
          nowTs,
          memberId,
          nowTs,
          memberId,
        );
      insertPage(wide, 'workspace', wid, 'database', 'Large');
      const options = Array.from({ length: 1000 }, (_, i) => ({ id: `o${i}`, name: `Option ${i} ${'o'.repeat(150)}`, color: 'gray' }));
      const schema = [
        { id: 'title', name: 'Nom', type: 'title' },
        ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `Texte ${i} ${'n'.repeat(150)}`, type: 'text' })),
        ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, name: `Choix ${i}`, type: 'select', options })),
      ];
      db.run('INSERT INTO databases (page_id, properties) VALUES (?, ?)', wide, JSON.stringify(schema));
      const props = JSON.stringify(Object.fromEntries(schema.slice(1, 41).map((p) => [p.id, 'v'.repeat(400)])));
      db.tx(() => {
        for (let i = 0; i < 200; i++) insertPage(`${wide}-r${String(i).padStart(3, '0')}`, 'database', wide, 'page', 'T'.repeat(2000), props);
        for (let i = 0; i < 50; i++) insertPage(`${wide}-c${String(i).padStart(3, '0')}`, 'page', `${wide}-r000`, 'page', 'C'.repeat(2000));
      });
      const tools = buildBriefTools(new WorkspaceReader(db, wid, today), [wide]).tools;
      const runTool = async (name: string, input: Record<string, unknown>) => {
        const out = await tools.find((t) => t.name === name)!.run(input as never);
        assert.equal(typeof out, 'string');
        return out as string;
      };
      const rows = await runTool('interroger_base', { baseId: wide, limite: 200 });
      const sources = await runTool('lister_sources', {});
      const page = await runTool('lire_page', { pageId: `${wide}-r000`, maxCaracteres: 20_000 });
      for (const [name, out] of [['interroger_base', rows], ['lister_sources', sources], ['lire_page', page]] as const) {
        assert.ok(out.length <= MAX_TOOL_RESULT_CHARS, `${name} returned ${out.length} characters`);
      }
      // Truncation is explicit for the model, and at least one row is always returned.
      const parsed = JSON.parse(rows);
      assert.equal(parsed.total, 200);
      assert.ok(parsed.lignes.length >= 1 && parsed.lignes.length < 200);
      assert.match(parsed.tronque, /premières lignes sur 200/);
      assert.equal(JSON.parse(sources).sources[0].proprietes.at(-1).autresOptions, 950);
      db.run("DELETE FROM pages WHERE id LIKE 'qa-wide-db-%'");
      db.run("DELETE FROM pages WHERE id = 'qa-wide-db'");
    } finally {
      db.close();
    }
  });

  test('budget: invalid values rejected; budget 0 = no API call; members cannot raise it', async () => {
    for (const bad of [-0.01, 10_000.01, '5', null, true, [1]]) {
      assert.equal((await owner.put(settingsUrl(), { monthlyBudgetUsd: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await member.put(settingsUrl(), { monthlyBudgetUsd: 10_000 })).status, 403);
    expectOk(await owner.put(settingsUrl(), { monthlyBudgetUsd: 0 }));
    requests.length = 0;
    try {
      // A member's manual run is refused outright (budget reserve, QA-AGT-03); the owner's is recorded as skipped.
      const refused = await member.post(`/workspaces/${wid}/ai/briefs`);
      assert.equal(refused.status, 429);
      assert.match(refused.body.error.message, /Plafond mensuel atteint/);
      const res = expectOk(await owner.post<StartBriefResponse>(`/workspaces/${wid}/ai/briefs`), 202);
      assert.equal(res.brief.status, 'skipped');
      assert.equal(requests.length, 0);
    } finally {
      expectOk(await owner.put(settingsUrl(), { monthlyBudgetUsd: 50 }));
    }
  });

  test('API key: never in responses, briefs or error messages', async () => {
    brain = () => ({ httpStatus: 401, errorType: 'authentication_error', message: 'invalid x-api-key' });
    const failed = await run();
    assert.equal(failed.status, 'failed');
    for (const res of [
      await member.get(settingsUrl()),
      await owner.get(settingsUrl()),
      await owner.get(`/ai/briefs/${failed.id}`),
      await owner.get(`/workspaces/${wid}/ai/briefs`),
      await owner.get('/admin/settings'),
      await owner.get('/auth/me'),
    ]) {
      assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY.slice(3, 24)), `key leaked: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await member.put('/admin/ai/key', { apiKey: 'sk-ant-member-attempt-00000000000' })).status, 403);
    assert.equal((await member.del('/admin/ai/key')).status, 403);
    // Header injection through the key is impossible (strict charset).
    assert.equal((await owner.put('/admin/ai/key', { apiKey: 'sk-ant-aaaaaaaaaaaaaaaaaaaa\r\nX-Evil: 1' })).status, 400);
    brain = publishNow;
  });

  test('QA-AGT-05: a stored brief stops showing pages that became private or were trashed', async () => {
    const atlas = await createPage(member, wid, { title: 'Projet Atlas' });
    const orion = await createPage(member, wid, { title: 'Tâche Orion' });
    const old = await createPage(member, wid, { title: 'Ancienne note' });
    const item = (pageId: string, projetId: string | null) => ({ titre: 'Relancer', pageId, projetId, echeance: null, responsables: [], note: '' });
    brain = () => ({
      content: [
        {
          type: 'tool_use',
          name: 'publier_brief',
          input: {
            ...EMPTY_BRIEF,
            priorites: [item(orion.id, atlas.id), item(old.id, null)],
            risques: [{ description: 'Retard possible.', gravite: 'moyenne', pages: [atlas.id, orion.id, old.id] }],
            projets: [{ pageId: atlas.id, titre: 'Projet Atlas', etat: 'a_surveiller', commentaire: 'Budget dépassé de 40 %.' }],
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    try {
      const brief = await run(member);
      assert.equal(brief.content!.projets[0]!.pageId, atlas.id);
      assert.equal(brief.content!.priorites.length, 2);
      // The project becomes private, a listed page goes to the trash, another one is renamed.
      expectOk(await member.post(`/pages/${atlas.id}/move`, { parentType: 'workspace', parentId: wid, visibility: 'private' }));
      expectOk(await member.post(`/pages/${old.id}/trash`));
      expectOk(await member.patch(`/pages/${orion.id}`, { title: 'Tâche Orion (V2)' }));
      assert.equal((await viewer.get(`/pages/${atlas.id}`)).status, 404);

      const latest = expectOk(await viewer.get<AiLatestBriefResponse>(`/workspaces/${wid}/ai/briefs/latest`)).latest!;
      assert.equal(latest.id, brief.id);
      for (const as of [viewer, member]) {
        const seen = expectOk(await as.get<AiBrief>(`/ai/briefs/${brief.id}`));
        for (const content of [seen.content!, latest.content!]) {
          assert.deepEqual(content.projets, [], 'a page made private is still listed (title + model comment) in an old brief');
          assert.deepEqual(content.priorites.map((i) => [i.pageId, i.projetId, i.projetTitre]), [[orion.id, null, null]]);
          assert.deepEqual(content.risques[0]!.pages, [{ id: orion.id, titre: 'Tâche Orion (V2)', cible: 'page' }]);
          assert.equal(content.risques[0]!.description, 'Retard possible.', 'free text is kept as written');
          assert.ok(!JSON.stringify(content).includes('Projet Atlas'));
          assert.ok(!JSON.stringify(content).includes('Budget dépassé'));
        }
      }
    } finally {
      brain = publishNow;
    }
  });

  test('QA-AGT-02: an instance-wide monthly cap, set by the instance admin only, bounds every workspace', async () => {
    // Any account (with open sign-ups: anyone) owns a workspace and may enable the brief with a $10,000
    // budget of its own: the instance cap bounds what all workspaces together spend on the instance key.
    for (const as of [member, outsider]) {
      assert.equal((await as.get('/admin/ai')).status, 403);
      assert.equal((await as.put('/admin/ai', { monthlyCapUsd: 10_000 })).status, 403);
    }
    for (const bad of [{ monthlyCapUsd: -1 }, { monthlyCapUsd: 10_000.01 }, { monthlyCapUsd: '5' }, { monthlyCapUsd: null }, {}, { monthlyCapUsd: 5, x: 1 }]) {
      assert.equal((await owner.put('/admin/ai', bad)).status, 400, JSON.stringify(bad));
    }
    const initial = expectOk(await owner.get<AiInstanceStatus>('/admin/ai'));
    assert.deepEqual(
      { cap: initial.monthlyCapUsd, isDefault: initial.capIsDefault, month: initial.month, reserved: initial.reservedUsd, key: initial.key },
      { cap: 50, isDefault: true, month: new Date().toISOString().slice(0, 7), reserved: 0, key: { source: 'saved', hint: '…QAQA' } },
    );
    assert.ok(initial.spentUsd > 0 && initial.runs > 0 && initial.enabledWorkspaces === 1);

    const did = (await createPage(outsider, outsiderWid, { kind: 'database', title: 'Mes projets', emptyDatabase: true })).id;
    expectOk(await outsider.put(settingsUrl(outsiderWid), { enabled: true, sourceDatabaseIds: [did], monthlyBudgetUsd: 10_000 }));
    const db = openDb();
    try {
      const capped = expectOk(await owner.put<AiInstanceStatus>('/admin/ai', { monthlyCapUsd: Math.ceil(initial.spentUsd) + 3 }));
      assert.equal(capped.capIsDefault, false);
      const remainder = capped.monthlyCapUsd - capped.spentUsd; // ]3, 4]
      // The workspace is told that the instance cap is what limits it (no amounts of other workspaces).
      const own = expectOk(await outsider.get<AiSettingsResponse>(settingsUrl(outsiderWid)));
      assert.equal(own.instanceCap, 'limiting');
      assert.deepEqual(own.manualRun, { allowed: true, reason: null, dailyLimit: null, usedToday: 0 });

      // Concurrent runs: a running brief holds its maximum cost (here the whole instance remainder).
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      requests.length = 0;
      brain = async () => {
        await gate;
        return { ...publishNow(), usage: costing(0) };
      };
      const held = expectOk(await owner.post<StartBriefResponse>(`/workspaces/${wid}/ai/briefs`), 202).brief;
      await waitFor(() => requests.length === 1, 5000, 'first request');
      assert.ok(Math.abs(expectOk(await owner.get<AiInstanceStatus>('/admin/ai')).reservedUsd - remainder) < 1e-6);
      const busy = await outsider.post(`/workspaces/${outsiderWid}/ai/briefs`);
      assert.equal(busy.status, 429);
      assert.equal(busy.body.error.code, 'ai_instance_busy');
      release();
      assert.equal((await waitRun(held.id)).status, 'succeeded');

      // A run of the $10,000 workspace is stopped at the instance remainder.
      brain = () => ({ content: [{ type: 'tool_use', name: 'lister_sources', input: {} }], stop_reason: 'tool_use', usage: costing(2) });
      const stopped = await run(outsider, outsiderWid);
      assert.equal(stopped.status, 'failed');
      assert.match(stopped.error ?? '', /Plafond mensuel atteint pendant/);
      assert.equal(stopped.turns, 2, '$2 < remainder after the first turn, $4 ≥ remainder after the second');
      assert.ok(Math.abs(db.get<{ m: number }>('SELECT max_cost_usd AS m FROM ai_briefs WHERE id = ?', stopped.id)!.m - remainder) < 1e-6);

      // Cap reached: briefs of every workspace are skipped without any API call.
      const reached = expectOk(await owner.get<AiInstanceStatus>('/admin/ai'));
      assert.ok(reached.spentUsd >= reached.monthlyCapUsd);
      requests.length = 0;
      factoryKeys.length = 0;
      for (const [as, w] of [[outsider, outsiderWid], [owner, wid]] as const) {
        const res = expectOk(await as.post<StartBriefResponse>(`/workspaces/${w}/ai/briefs`), 202);
        assert.equal(res.brief.status, 'skipped');
        assert.match(res.brief.error ?? '', /Plafond mensuel global de l’instance atteint/);
        assert.doesNotMatch(res.brief.error ?? '', /\$/, 'the spend of other workspaces must not be disclosed');
      }
      assert.equal(requests.length, 0);
      assert.deepEqual(factoryKeys, []);
      const seen = expectOk(await member.get<AiSettingsResponse>(settingsUrl()));
      assert.equal(seen.instanceCap, 'reached');
      assert.equal(seen.manualRun.allowed, false);
      assert.match(seen.manualRun.reason ?? '', /global de l’instance/);
      assert.equal(expectOk(await member.get<AiUsageResponse>(`/workspaces/${wid}/ai/usage`)).instanceCap, 'reached');

      // 0 disables AI briefs on the whole instance.
      expectOk(await owner.put('/admin/ai', { monthlyCapUsd: 0 }));
      const off = expectOk(await outsider.get<AiSettingsResponse>(settingsUrl(outsiderWid)));
      assert.equal(off.configured, false);
      assert.match(off.blocker ?? '', /désactivé sur ce serveur/);
      assert.equal((await outsider.post(`/workspaces/${outsiderWid}/ai/briefs`)).status, 400);
    } finally {
      db.close();
      brain = publishNow;
      expectOk(await owner.put('/admin/ai', { monthlyCapUsd: AI_INSTANCE_MAX_CAP_USD }));
    }
  });

  test('QA-AGT-03: members’ manual runs are capped per day and keep a reserve for the scheduled brief', async () => {
    // A fresh workspace: nothing spent yet, no manual run today.
    const w = expectOk(await owner.post<{ id: string }>('/workspaces', { name: 'Studio B' })).id;
    const { client: editor } = await addMember(owner, w, 'membre-b@oriel.test', 'Bruno', 'member');
    const projets = await createPage(owner, w, { kind: 'database', title: 'Projets', emptyDatabase: true });
    expectOk(await owner.put(settingsUrl(w), { enabled: true, sourceDatabaseIds: [projets.id], monthlyBudgetUsd: 20 }));
    // $8 per brief: $1 for the first turn, $7 for the turn that publishes.
    brain = (req) =>
      toolExchanges(req.body).length === 0
        ? { content: [{ type: 'tool_use', name: 'lister_sources', input: {} }], stop_reason: 'tool_use', usage: costing(1) }
        : { ...publishNow(), usage: costing(7) };
    const db = openDb();
    const maxCost = (id: string) => db.get<{ m: number }>('SELECT max_cost_usd AS m FROM ai_briefs WHERE id = ?', id)!.m;
    try {
      // A member clicks « Régénérer » again and again: manual runs may only spend up to 80 % of the budget…
      const first = await run(editor, w);
      assert.equal(first.status, 'succeeded', first.error ?? '');
      assert.equal(maxCost(first.id), 16);
      const second = await run(editor, w);
      assert.equal(second.status, 'succeeded', second.error ?? '');
      assert.equal(maxCost(second.id), 8);
      const refused = await editor.post(`/workspaces/${w}/ai/briefs`);
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'ai_budget_reserved');
      assert.match(refused.body.error.message, /20 % restants du plafond sont réservés aux briefs automatiques/);
      const state = expectOk(await editor.get<AiSettingsResponse>(settingsUrl(w))).manualRun;
      assert.deepEqual(state, { allowed: false, reason: refused.body.error.message, dailyLimit: AI_MANUAL_RUNS_PER_DAY, usedToday: 2 });
      const usage = expectOk(await editor.get<AiUsageResponse>(`/workspaces/${w}/ai/usage`));
      assert.deepEqual([usage.spentUsd, usage.manualLimitUsd, usage.instanceCap], [16, 16, 'ok']);
      // …the owner, who sets the budget, is not limited…
      assert.deepEqual(expectOk(await owner.get<AiSettingsResponse>(settingsUrl(w))).manualRun, { allowed: true, reason: null, dailyLimit: null, usedToday: 2 });
      // …and the scheduled brief still runs, on the reserve.
      const ctx = { db } as AppContext;
      const scheduled = startBrief(ctx, w, 'schedule', null);
      assert.equal(scheduled.status, 'running');
      assert.equal(maxCost(scheduled.id), 4);
      await settleRuns(ctx);
      const done = expectOk(await owner.get<AiBrief>(`/ai/briefs/${scheduled.id}`));
      assert.equal(done.status, 'succeeded', done.error ?? '');

      // Daily quota of manual runs for members (the scheduled brief and the owner's runs do not count).
      expectOk(await owner.put(settingsUrl(w), { monthlyBudgetUsd: 1000 }));
      brain = publishNow;
      assert.equal((await run(owner, w)).status, 'succeeded');
      for (let i = 2; i < AI_MANUAL_RUNS_PER_DAY; i++) assert.equal((await run(editor, w)).status, 'succeeded');
      const quota = await editor.post(`/workspaces/${w}/ai/briefs`);
      assert.equal(quota.status, 429);
      assert.equal(quota.body.error.code, 'ai_manual_quota');
      const after = expectOk(await editor.get<AiSettingsResponse>(settingsUrl(w))).manualRun;
      assert.deepEqual({ ...after, reason: null }, { allowed: false, reason: null, dailyLimit: AI_MANUAL_RUNS_PER_DAY, usedToday: AI_MANUAL_RUNS_PER_DAY });
      assert.equal(after.reason, quota.body.error.message);
      assert.equal((await run(owner, w)).status, 'succeeded', 'workspace owners and admins are not limited');
    } finally {
      db.close();
      brain = publishNow;
    }
  });
});
