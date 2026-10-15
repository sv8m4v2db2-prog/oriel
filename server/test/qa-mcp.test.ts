// QA (security review, 2nd pass): personal API tokens wired into the real server (app.ts) — the
// checklist of docs/QA-REPORT.md §5, end to end against an in-process server (127.0.0.1, throwaway
// DATA_DIR). Each QA-TOK-xx test first reproduced the suspected flaw on the code under review; fixed
// issues stay as non-regression tests. The unit tests of the module itself are in qa-tokens.test.ts.
process.env.SMTP_URL = 'json:quiet';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { CreatedApiToken, Page, SessionResponse, View, WorkspaceSummary } from '@oriel/shared';
import { REAUTH_WINDOW_MS } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, sleep, startTestServer, waitFor, type Res, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { mailOutbox } from '../src/collab/mailer.js';
import type { AppContext } from '../src/context.js';

/** Raw HTTP request: the test chooses the Host header and sends paths fetch() would normalize. */
function raw(
  base: string,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = request({ hostname: url.hostname, port: url.port, method, path: pathname, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** HTTP client authenticated by `Authorization: Bearer …`. */
async function bearer<T = any>(base: string, token: string, method: string, url: string, body?: unknown): Promise<Res<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

const createToken = async (client: Client, body: Record<string, unknown>) => expectOk(await client.post<CreatedApiToken>('/me/tokens', body));
const linkIn = (text: string, route: string) => new RegExp(`(\\S+)/${route}/[A-Za-z0-9_-]+`).exec(text)?.[1] ?? null;

/** Status of a WebSocket upgrade (101 → 'open'). */
function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', () => resolve(0));
  });
}

// ---------------------------------------------------------------------------------------------
// QA-TOK-01 — e-mail links poisoned through the Host header of an admin's API token request
// ---------------------------------------------------------------------------------------------

describe('QA-TOK-01: an API token of an instance admin never sets the origin of e-mail links (no PUBLIC_URL)', () => {
  let srv: TestServer;
  let admin: Client;

  before(async () => {
    srv = await startTestServer();
    ({ admin } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  test('QA-TOK-01: Host header of a Bearer request of an admin does not end up in reset links', async () => {
    const t = await createToken(admin, { name: 'script', scope: 'read' });
    // A browser request of the admin first (legitimate origin).
    expectOk(await admin.get('/auth/me'));
    const res = await raw(srv.base, 'GET', '/api/auth/me', { host: 'evil.example', authorization: `Bearer ${t.token}` });
    assert.equal(res.status, 200);
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'admin@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'admin@oriel.test'), 3000, 'reset mail');
    const link = linkIn(mail.text, 'reset-password');
    assert.ok(link, mail.text);
    assert.doesNotMatch(link!, /evil\.example/, `reset link points to the token holder's host: ${link}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Server-side checklist (QA-REPORT §5) and QA-TOK-02
// ---------------------------------------------------------------------------------------------

describe('qa-mcp: API tokens in the real pipeline', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let wid2: string;
  let page2: Page;
  let adminId: string;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    ({ admin, wid } = await setupAdmin(srv.base));
    adminId = expectOk(await admin.get<SessionResponse>('/auth/me')).user.id;
    wid2 = expectOk(await admin.post<WorkspaceSummary>('/workspaces', { name: 'Deuxième espace' })).id;
    page2 = await createPage(admin, wid2, { title: 'Secret du deuxième espace' });
  });
  after(async () => {
    await srv.stop();
  });

  test('qa-mcp §5.1: Bearer requests never set or refresh the session cookie; a bad token with a valid cookie is 401', async () => {
    const t = await createToken(admin, { name: 'pipeline', scope: 'write' });
    // Session old enough to be refreshed on its next cookie request.
    ctx.db.run('UPDATE sessions SET expires_at = ? WHERE user_id = ?', Date.now() + 60_000, adminId);
    const cookie = `oriel_session=${admin.cookie}`;
    const withToken = await raw(srv.base, 'GET', '/api/auth/me', { authorization: `Bearer ${t.token}`, cookie });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers['set-cookie'], undefined, 'no Set-Cookie with a token');
    const flipped = `${t.token.slice(0, -1)}${t.token.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [flipped, 'or_court', `or_${'x'.repeat(43)}`]) {
      const res = await raw(srv.base, 'GET', '/api/auth/me', { authorization: `Bearer ${bad}`, cookie });
      assert.equal(res.status, 401, bad);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    expectOk(await admin.del(`/me/tokens/${t.id}`));
    const revoked = await raw(srv.base, 'GET', '/api/auth/me', { authorization: `Bearer ${t.token}`, cookie });
    assert.equal(revoked.status, 401, 'revoked token, valid cookie');
    assert.equal(revoked.headers['set-cookie'], undefined);
    // The cookie alone still works (and is refreshed).
    const plain = await raw(srv.base, 'GET', '/api/auth/me', { cookie });
    assert.equal(plain.status, 200);
  });

  test('qa-mcp §5.1: tokens in the URL are ignored (query string, any parameter name)', async () => {
    const t = await createToken(admin, { name: 'url', scope: 'read' });
    for (const q of ['token', 'access_token', 'api_key', 'bearer', 'authorization']) {
      const res = await fetch(`${srv.base}/api/auth/me?${q}=${t.token}`);
      assert.equal(res.status, 401, q);
    }
  });

  test('qa-mcp §5.3: cookie-only routes refuse tokens whatever the spelling of the path', async () => {
    const t = await createToken(admin, { name: 'chemins', scope: 'write' });
    const page = await createPage(admin, wid, { title: 'Publication' });
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/%61pi/me/tokens'],
      ['GET', '/api/me/%74okens'],
      ['GET', '/api/me/tokens/'],
      ['GET', '/api//me/tokens'],
      ['GET', '/api/me/tokens?x=1'],
      ['POST', '/api/me/%74okens', { name: 'x', scope: 'write' }],
      ['POST', `/api/pages/${page.id}/%70ublish`, { isPublic: true }],
      ['POST', `/api/pages/${page.id}/publish/`, { isPublic: true }],
      ['POST', `/%61pi/pages/${page.id}/publish`, { isPublic: true }],
      ['POST', '/api/me/%70assword', { currentPassword: 'x', newPassword: 'y'.repeat(12) }],
      ['PATCH', '/%61pi/admin/settings', { signupMode: 'open' }],
      ['POST', `/api/workspaces/${wid}/%69nvites`, { role: 'admin' }],
    ];
    for (const [method, url, body] of cases) {
      const res = await raw(
        srv.base,
        method,
        url,
        { authorization: `Bearer ${t.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body ? JSON.stringify(body) : undefined,
      );
      assert.ok(res.status === 403 || res.status === 404, `${method} ${url} → ${res.status}`);
    }
    // Other casings are not API routes (the router is case-sensitive): the SPA answers, never the API.
    const upper = await raw(srv.base, 'GET', '/API/me/tokens', { authorization: `Bearer ${t.token}` });
    assert.doesNotMatch(String(upper.headers['content-type'] ?? ''), /json/);
    assert.ok(!upper.body.includes('"tokens"'));
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`)).page.isPublic, false);
    assert.equal(expectOk(await admin.get<{ signupMode: string }>('/admin/settings')).signupMode !== 'open', true);
  });

  test('QA-TOK-02: account settings (profile, notification settings) stay cookie-only', async () => {
    const restricted = await createToken(admin, { name: 'profil', scope: 'write', workspaceId: wid });
    const global = await createToken(admin, { name: 'profil global', scope: 'write' });
    for (const t of [restricted, global]) {
      const name = await bearer(srv.base, t.token, 'PATCH', '/me', { name: 'Renommé par un jeton', avatarUrl: 'https://tracker.example/pixel.png' });
      assert.equal(name.status, 403, 'PATCH /api/me');
      const prefs = await bearer(srv.base, t.token, 'PATCH', '/me/notification-settings', { emailFrequency: 'never' });
      assert.equal(prefs.status, 403, 'PATCH /api/me/notification-settings');
      // Reading stays possible.
      assert.equal((await bearer(srv.base, t.token, 'GET', '/me/notification-settings')).status, 200);
    }
    const me = expectOk(await admin.get<SessionResponse>('/auth/me')).user;
    assert.notEqual(me.name, 'Renommé par un jeton');
    assert.equal(me.avatarUrl, null);
  });

  test('QA-VIEW-01 (token side, cross-check): a token cannot open a form to anonymous submissions (create or update a view)', async () => {
    const t = await createToken(admin, { name: 'formulaire', scope: 'write' });
    const dbPage = await createPage(admin, wid, { kind: 'database', title: 'Candidatures' });
    // The database is published by the browser session (cookie-only): anonymous visitors can read it.
    expectOk(await admin.post(`/pages/${dbPage.id}/publish`, { isPublic: true }));
    const form = expectOk(await admin.post<View>(`/databases/${dbPage.id}/views`, { name: 'Formulaire', type: 'form' }));
    const publicForm = { questions: [], acceptResponses: true, isPublic: true };
    const isPublic = (vid: string) => {
      const row = ctx.db.get<{ type: string; config: string }>('SELECT type, config FROM views WHERE id = ?', vid)!;
      return row.type === 'form' && JSON.parse(row.config).form?.isPublic === true;
    };

    const patched = await bearer(srv.base, t.token, 'PATCH', `/views/${form.id}`, { config: { form: publicForm } });
    assert.equal(patched.status, 403, `PATCH form.isPublic → ${patched.status}`);
    assert.equal(isPublic(form.id), false);
    const created = await bearer<View>(srv.base, t.token, 'POST', `/databases/${dbPage.id}/views`, { name: 'Public', type: 'form', config: { form: publicForm } });
    assert.equal(created.status, 403, `POST view with form.isPublic → ${created.status}`);
    // Through a type change: a table view whose stored config says isPublic, turned into a form.
    const table = await bearer<View>(srv.base, t.token, 'POST', `/databases/${dbPage.id}/views`, { name: 'Tableau', type: 'table', config: { form: publicForm } });
    if (table.status === 200) {
      const switched = await bearer(srv.base, t.token, 'PATCH', `/views/${table.body.id}`, { type: 'form' });
      assert.equal(switched.status, 403, `PATCH type form → ${switched.status}`);
      assert.equal(isPublic(table.body.id), false);
    }

    // Editing a form without touching its publication stays possible, on a public form too.
    expectOk(await bearer(srv.base, t.token, 'PATCH', `/views/${form.id}`, { name: 'Formulaire (modifié)', config: { form: { questions: [], acceptResponses: true } } }));
    expectOk(await admin.patch(`/views/${form.id}`, { config: { form: publicForm } }));
    assert.equal(isPublic(form.id), true, 'the browser session publishes the form');
    expectOk(await bearer(srv.base, t.token, 'PATCH', `/views/${form.id}`, { config: { form: { ...publicForm, title: 'Candidater' } } }));
    expectOk(await bearer(srv.base, t.token, 'PATCH', `/views/${form.id}`, { name: 'Renommé' }));
    assert.equal(isPublic(form.id), true);
    // Duplicating a public form with a token gives a copy that is not public.
    const dup = await bearer<View>(srv.base, t.token, 'POST', `/views/${form.id}/duplicate`);
    if (dup.status === 200) assert.equal(isPublic(dup.body.id), false, 'duplicate of a public form opened by a token');
    // Closing it is allowed (it reduces what is public).
    expectOk(await bearer(srv.base, t.token, 'PATCH', `/views/${form.id}`, { config: { form: { ...publicForm, isPublic: false } } }));
    assert.equal(isPublic(form.id), false);
  });

  test('qa-mcp §5.2: a workspace-restricted token sees nothing of another workspace (lists, search, synced blocks)', async () => {
    const t = await createToken(admin, { name: 'espace 1', scope: 'write', workspaceId: wid });
    const call = (method: string, url: string, body?: unknown) => bearer(srv.base, t.token, method, url, body);
    for (const url of [
      `/workspaces/${wid2}/favorites`,
      `/workspaces/${wid2}/recent`,
      `/workspaces/${wid2}/trash`,
      `/workspaces/${wid2}/search?q=secret`,
      `/workspaces/${wid2}/notifications`,
      `/workspaces/${wid2}/notifications/unread`,
      `/workspaces/${wid2}/ai/settings`,
      `/workspaces/${wid2}/ai/briefs/latest`,
      `/workspaces/${wid2}/templates`,
    ]) {
      const res = await call('GET', url);
      assert.equal(res.status, 404, `${url} → ${res.status}`);
    }
    // Synced block owned by a page of the other workspace, shown through a page of the allowed one.
    const own = expectOk(await call('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'À moi' })) as Page;
    const synced = await admin.post<{ id: string }>(`/pages/${page2.id}/synced-blocks`, {});
    if (synced.status === 200) {
      const res = await call('GET', `/pages/${own.id}/synced-blocks/${synced.body.id}`);
      assert.equal(res.status, 404, `synced block of another workspace → ${res.status}`);
    }
    // Duplicating / moving into the other workspace.
    assert.notEqual((await call('POST', `/pages/${own.id}/move`, { parentType: 'workspace', parentId: wid2 })).status, 200);
    assert.equal((await call('POST', `/pages/${page2.id}/duplicate`)).status, 404);
    // Search in the allowed workspace never returns pages of the other one.
    const found = expectOk(await call('GET', `/workspaces/${wid}/search?q=Secret`)) as { results: Array<{ page: { id: string } }> };
    assert.ok(!found.results.some((r) => r.page.id === page2.id));
  });

  test('qa-mcp §5.5: WebSockets refuse tokens (Bearer at the upgrade, query string, Hocuspocus Auth message)', async () => {
    const t = await createToken(admin, { name: 'ws', scope: 'write' });
    const page = await createPage(admin, wid, { title: 'Privée au websocket' });
    assert.equal(await wsStatus(`${srv.wsBase}/api/events?token=${t.token}`), 401);
    assert.equal(await wsStatus(`${srv.wsBase}/api/events`, { authorization: `Bearer ${t.token}` }), 401);
    // /collab: the upgrade is anonymous (no cookie); neither the Bearer header nor the token of the
    // Hocuspocus Auth message authenticate.
    class BearerWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { authorization: `Bearer ${t.token}` } });
      }
    }
    const socket = new HocuspocusProviderWebsocket({ url: `${srv.wsBase}/collab?token=${t.token}`, WebSocketPolyfill: BearerWebSocket });
    const doc = new Y.Doc();
    let failed = false;
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: `page:${page.id}`,
      document: doc,
      token: t.token,
      onAuthenticationFailed: () => {
        failed = true;
      },
    });
    provider.attach();
    try {
      await waitFor(() => failed || provider.isSynced, 5000, 'collab answer');
      assert.equal(failed, true, 'authentication must fail');
      assert.equal(provider.isSynced, false);
    } finally {
      provider.destroy();
      socket.destroy();
    }
    await sleep(10);
  });

  // Decision (G9, A06): no password at each creation, but a recent authentication — less than 10 minutes
  // since the sign-in or the last confirmation of identity (auth/stepUp.ts). An old stolen session
  // cannot turn itself into durable access.
  test('QA-TOK-03: creating or revoking a token needs a recent authentication (session theft → durable access)', async () => {
    const { client: member } = await addMember(admin, wid, 'tok03@oriel.test', 'Tok03', 'member');
    const fresh = await createToken(member, { name: 'juste après la connexion', scope: 'write' });
    const sql = new DatabaseSync(path.join(srv.dataDir, 'oriel.db'));
    try {
      sql.exec('PRAGMA busy_timeout = 5000');
      const sid = createHash('sha256').update(member.cookie!).digest('hex');
      sql.prepare('UPDATE sessions SET auth_at = ? WHERE id = ?').run(Date.now() - REAUTH_WINDOW_MS - 1000, sid);
    } finally {
      sql.close();
    }
    const res = await member.post('/me/tokens', { name: 'session ancienne', scope: 'write' });
    assert.equal(res.status, 403, 'a token is created from an old cookie session');
    assert.equal((res.body as { error: { code: string } }).error.code, 'reauth_required');
    assert.equal((await member.del(`/me/tokens/${fresh.id}`)).status, 403);
    expectOk(await member.post('/auth/reauth', { password: 'motdepasse-solide' }));
    expectOk(await member.post('/me/tokens', { name: 'après confirmation', scope: 'write' }));
  });

  test('qa-mcp §5.4: token lifecycle — 50 active tokens at most, raw token returned once, hash never', async () => {
    const { client: member } = await addMember(admin, wid, 'cycle@oriel.test', 'Cycle', 'member');
    const first = await createToken(member, { name: 'jeton 0', scope: 'read' });
    for (let i = 1; i < 50; i++) await createToken(member, { name: `jeton ${i}`, scope: 'read' });
    assert.equal((await member.post('/me/tokens', { name: 'jeton 50', scope: 'read' })).status, 400);
    const listed = expectOk(await member.get<{ tokens: Array<Record<string, unknown>> }>('/me/tokens')).tokens;
    assert.equal(listed.length, 50);
    const json = JSON.stringify(listed);
    assert.doesNotMatch(json, /token_?hash|"token"/i);
    assert.ok(!json.includes(first.token));
    const self = expectOk(await bearer(srv.base, first.token, 'GET', '/me/current-token'));
    assert.ok(!JSON.stringify(self).includes(first.token));
    assert.doesNotMatch(JSON.stringify(self), /hash/i);
    // Validation of the creation body.
    for (const body of [
      { name: '', scope: 'read' },
      { name: 'x'.repeat(101), scope: 'read' },
      { name: 'a\u0000b', scope: 'read' },
      { name: 'a\nb', scope: 'read' },
      { name: 'ok', scope: 'admin' },
      { name: 'ok', scope: 'read', expiresInDays: 0 },
      { name: 'ok', scope: 'read', expiresInDays: 3651 },
      { name: 'ok', scope: 'read', workspaceId: wid2 },
    ]) {
      expectOk(await member.del(`/me/tokens/${first.id}`)).ok;
      const res = await member.post('/me/tokens', body);
      assert.ok(res.status === 400 || res.status === 404, `${JSON.stringify(body)} → ${res.status}`);
      // Make room again for the next case.
      const again = await createToken(member, { name: 'remplaçant', scope: 'read' });
      first.id = again.id;
    }
  });
});
