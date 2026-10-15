// Personal API tokens (mcp module): lifecycle, Bearer authentication, read-only scope, workspace
// restriction, revoked/expired tokens, cookie-only routes and no CSRF regression for cookie sessions.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { ApiTokenInfo, ApiTokensResponse, CreatedApiToken, Page, SessionResponse, WorkspaceSummary } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, startTestServer, type Res, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { apiTokenTestHooks } from '../src/auth/apiTokens.js';
import type { AppContext } from '../src/context.js';

/** HTTP client authenticated by `Authorization: Bearer …` (optionally with a cookie as well). */
async function bearer<T = any>(
  base: string,
  token: string,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const h: Record<string, string> = { authorization: `Bearer ${token}`, ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

async function createToken(client: Client, body: Record<string, unknown>): Promise<CreatedApiToken> {
  return expectOk(await client.post<CreatedApiToken>('/me/tokens', body));
}

describe('api tokens', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let wid2: string;
  let page2: Page;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    ({ admin, wid } = await setupAdmin(srv.base));
    wid2 = expectOk(await admin.post<WorkspaceSummary>('/workspaces', { name: 'Deuxième espace' })).id;
    page2 = await createPage(admin, wid2, { title: 'Secret du deuxième espace' });
  });
  after(async () => {
    await srv.stop();
  });

  test('lifecycle: create (shown once), list, use, introspect, revoke', async () => {
    const created = await createToken(admin, { name: 'Claude Desktop', scope: 'write' });
    assert.match(created.token, /^or_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.prefix, created.token.slice(0, 9));
    assert.equal(created.scope, 'write');
    assert.equal(created.workspaceId, null);
    assert.equal(created.expiresAt, null);
    assert.equal(created.lastUsedAt, null);

    const list = expectOk(await admin.get<ApiTokensResponse>('/me/tokens'));
    const listed = list.tokens.find((t) => t.id === created.id)!;
    assert.ok(listed);
    assert.equal((listed as Partial<CreatedApiToken>).token, undefined, 'the raw token is never listed');
    // Only the hash is stored.
    const row = ctx.db.get<{ token_hash: string }>('SELECT token_hash FROM api_tokens WHERE id = ?', created.id)!;
    assert.notEqual(row.token_hash, created.token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    const me = await bearer<SessionResponse>(srv.base, created.token, 'GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'admin@oriel.test');
    assert.equal(me.body.workspaces.length, 2);
    assert.equal(me.headers.getSetCookie().length, 0, 'no session cookie for bearer requests');

    const current = await bearer<ApiTokenInfo>(srv.base, created.token, 'GET', '/me/current-token');
    assert.equal(current.status, 200);
    assert.equal(current.body.id, created.id);
    assert.ok(current.body.lastUsedAt, 'last_used_at is recorded');
    assert.equal((await admin.get('/me/current-token')).status, 404, 'cookie sessions have no current token');

    expectOk(await admin.del(`/me/tokens/${created.id}`));
    assert.equal((await bearer(srv.base, created.token, 'GET', '/auth/me')).status, 401);
    assert.ok(!expectOk(await admin.get<ApiTokensResponse>('/me/tokens')).tokens.some((t) => t.id === created.id));
    assert.equal((await admin.del(`/me/tokens/${created.id}`)).status, 404);
  });

  test('validation: scope, name, expiry, workspace membership', async () => {
    assert.equal((await admin.post('/me/tokens', { name: 'x', scope: 'admin' })).status, 400);
    assert.equal((await admin.post('/me/tokens', { name: '  ', scope: 'read' })).status, 400);
    assert.equal((await admin.post('/me/tokens', { name: 'x', scope: 'read', expiresInDays: 0 })).status, 400);
    assert.equal((await admin.post('/me/tokens', { name: 'x', scope: 'read', workspaceId: 'inconnu' })).status, 404);
    const { client: other } = await addMember(admin, wid, 'autre@oriel.test', 'Autre', 'member');
    // A member of wid only cannot restrict a token to wid2.
    assert.equal((await other.post('/me/tokens', { name: 'x', scope: 'read', workspaceId: wid2 })).status, 404);
    // Tokens are personal: another user cannot revoke them.
    const mine = await createToken(admin, { name: 'perso', scope: 'read', expiresInDays: 30 });
    assert.ok(mine.expiresAt && mine.expiresAt > Date.now() + 29 * 86_400_000);
    assert.equal((await other.del(`/me/tokens/${mine.id}`)).status, 404);
    assert.ok(!expectOk(await other.get<ApiTokensResponse>('/me/tokens')).tokens.some((t) => t.id === mine.id));
  });

  test('token management, password, login and admin routes refuse bearer authentication', async () => {
    const t = await createToken(admin, { name: 'tout', scope: 'write' });
    for (const [method, url, body] of [
      ['GET', '/me/tokens', undefined],
      ['POST', '/me/tokens', { name: 'pirate', scope: 'write' }],
      ['DELETE', `/me/tokens/${t.id}`, undefined],
      ['GET', '/%6De/tokens', undefined],
      ['POST', '/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-mot-de-passe' }],
      ['POST', '/auth/logout', undefined],
      ['POST', '/auth/login', { email: 'admin@oriel.test', password: 'motdepasse-solide' }],
      ['GET', '/admin/users', undefined],
      ['PATCH', '/admin/settings', { signupMode: 'open' }],
      ['DELETE', `/workspaces/${wid2}`, undefined],
    ] as const) {
      const res = await bearer(srv.base, t.token, method, url, body);
      assert.equal(res.status, 403, `${method} ${url} → ${res.status}`);
    }
    // Nothing happened.
    assert.ok(expectOk(await admin.get<ApiTokensResponse>('/me/tokens')).tokens.some((x) => x.id === t.id));
    assert.equal((await admin.get(`/workspaces/${wid2}`)).status, 200);
    expectOk(await admin.del(`/me/tokens/${t.id}`));
  });

  test('read-only tokens: reads succeed, every mutating method gets 403', async () => {
    const page = await createPage(admin, wid, { title: 'Lecture' });
    const t = await createToken(admin, { name: 'lecture', scope: 'read' });
    assert.equal((await bearer(srv.base, t.token, 'GET', `/pages/${page.id}`)).status, 200);
    assert.equal((await bearer(srv.base, t.token, 'GET', `/workspaces/${wid}/tree`)).status, 200);
    assert.equal((await bearer(srv.base, t.token, 'GET', `/pages/${page.id}/content`)).status, 200);
    const writes: Array<[string, string, unknown]> = [
      ['POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'Non' }],
      ['PATCH', `/pages/${page.id}`, { title: 'Modifié' }],
      ['PUT', `/pages/${page.id}/content`, { update: 'AAA=', mode: 'append' }],
      ['POST', `/pages/${page.id}/trash`, undefined],
      ['DELETE', `/pages/${page.id}`, undefined],
      ['POST', `/pages/${page.id}/duplicate`, undefined],
    ];
    // PATCH /api/me is cookie-only for every token (QA-TOK-02, qa-mcp.test.ts).
    for (const [method, url, body] of writes) {
      const res = await bearer<{ error: { code: string; message: string } }>(srv.base, t.token, method, url, body);
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.match(res.body.error.message, /lecture seule/);
    }
    const detail = expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`));
    assert.equal(detail.page.title, 'Lecture');
    assert.equal(detail.page.trashedAt, null);
  });

  test('write tokens are exempt from the cookie CSRF rules (no cookie involved)', async () => {
    const t = await createToken(admin, { name: 'écriture', scope: 'write' });
    const res = await bearer<Page>(srv.base, t.token, 'POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'Depuis Claude' }, {
      origin: 'https://claude.example',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Depuis Claude');
    assert.equal(res.body.createdBy, (await admin.get<SessionResponse>('/auth/me')).body.user.id);
  });

  test('cookie sessions keep the CSRF rules, also when an unrelated Authorization header is present', async () => {
    const page = await createPage(admin, wid, { title: 'CSRF' });
    const foreign = await admin.req('PATCH', `/pages/${page.id}`, { title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    const textPlain = await admin.req('PATCH', `/pages/${page.id}`, undefined, { contentType: 'text/plain', rawBody: '{"title":"x"}' });
    assert.equal(textPlain.status, 403);
    // A reverse proxy's Basic auth (or a non-Oriel bearer) does not bypass the cookie pipeline.
    for (const authorization of ['Basic YWxpY2U6c2VjcmV0', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x']) {
      const res = await fetch(`${srv.base}/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: { authorization, cookie: `oriel_session=${admin.cookie}`, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      });
      assert.equal(res.status, 403, authorization);
      const ok = await fetch(`${srv.base}/api/auth/me`, { headers: { authorization, cookie: `oriel_session=${admin.cookie}` } });
      assert.equal(ok.status, 200, `cookie still authenticates with ${authorization.split(' ')[0]}`);
    }
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`)).page.title, 'CSRF');
  });

  test('an invalid bearer token never falls back to the session cookie', async () => {
    const bogus = `or_${'A'.repeat(43)}`;
    const res = await fetch(`${srv.base}/api/auth/me`, { headers: { authorization: `Bearer ${bogus}`, cookie: `oriel_session=${admin.cookie}` } });
    assert.equal(res.status, 401);
    assert.equal((await bearer(srv.base, 'or_court', 'GET', '/auth/me')).status, 401);
  });

  test('tokens are never accepted in the query string', async () => {
    const t = await createToken(admin, { name: 'query', scope: 'read' });
    for (const q of ['access_token', 'token', 'bearer']) {
      const res = await fetch(`${srv.base}/api/auth/me?${q}=${encodeURIComponent(t.token)}`);
      assert.equal(res.status, 401, q);
    }
  });

  test('expired tokens are refused', async () => {
    const t = await createToken(admin, { name: 'expire', scope: 'read', expiresInDays: 1 });
    assert.equal((await bearer(srv.base, t.token, 'GET', '/auth/me')).status, 200);
    ctx.db.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', Date.now() - 1000, t.id);
    assert.equal((await bearer(srv.base, t.token, 'GET', '/auth/me')).status, 401);
    const listed = expectOk(await admin.get<ApiTokensResponse>('/me/tokens')).tokens.find((x) => x.id === t.id)!;
    assert.equal(listed.expired, true);
  });

  test('workspace-restricted tokens only see their workspace (404 elsewhere)', async () => {
    const t = await createToken(admin, { name: 'espace 1', scope: 'write', workspaceId: wid });
    assert.equal(t.workspaceId, wid);
    assert.ok(t.workspaceName);
    const call = (method: string, url: string, body?: unknown) => bearer(srv.base, t.token, method, url, body);

    const list = await call('GET', '/workspaces');
    assert.deepEqual((list.body as WorkspaceSummary[]).map((w) => w.id), [wid]);
    assert.deepEqual((await call('GET', '/auth/me')).body.workspaces.map((w: WorkspaceSummary) => w.id), [wid]);
    assert.equal((await call('GET', `/workspaces/${wid}`)).status, 200);
    assert.equal((await call('GET', `/workspaces/${wid}/tree`)).status, 200);

    // Other workspace: everything is invisible.
    for (const url of [
      `/workspaces/${wid2}`,
      `/workspaces/${wid2}/tree`,
      `/workspaces/${wid2}/search?q=secret`,
      `/workspaces/${wid2}/members`,
      `/workspaces/${wid2}/notifications`,
      `/pages/${page2.id}`,
      `/pages/${page2.id}/content`,
      `/pages/${page2.id}/backlinks`,
      `/pages/${page2.id}/threads`,
    ]) {
      assert.equal((await call('GET', url)).status, 404, url);
    }
    assert.equal((await call('PATCH', `/pages/${page2.id}`, { title: 'piraté' })).status, 404);
    assert.equal((await call('POST', `/workspaces/${wid2}/pages`, { parentType: 'workspace', parentId: wid2, title: 'x' })).status, 404);
    // Moving a page of the allowed workspace under a page of the other one.
    const own = expectOk(await call('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'À moi' })) as Page;
    assert.notEqual((await call('POST', `/pages/${own.id}/move`, { parentType: 'page', parentId: page2.id })).status, 200);
    // Cannot create new workspaces either.
    assert.equal((await call('POST', '/workspaces', { name: 'Nouveau' })).status, 403);
    // Notifications are checked by owner only on the server: the parameter guard covers them.
    const nid = 'notif-autre-espace';
    const me = expectOk(await admin.get<SessionResponse>('/auth/me')).user.id;
    ctx.db.run(
      "INSERT INTO collab_notifications (id, user_id, workspace_id, type, data, created_at) VALUES (?, ?, ?, 'mention', '{}', ?)",
      nid,
      me,
      wid2,
      Date.now(),
    );
    assert.equal((await call('PATCH', `/notifications/${nid}`, { read: true })).status, 404);
    assert.equal(ctx.db.get<{ read_at: number | null }>('SELECT read_at FROM collab_notifications WHERE id = ?', nid)!.read_at, null);
    // The page of the other workspace is untouched; the cookie session still sees both.
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${page2.id}`)).page.title, 'Secret du deuxième espace');
    assert.equal(expectOk(await admin.get<WorkspaceSummary[]>('/workspaces')).length, 2);
  });

  test('WebSocket endpoints keep cookie authentication only', async () => {
    const t = await createToken(admin, { name: 'ws', scope: 'write' });
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${srv.wsBase}/api/events`, { headers: { authorization: `Bearer ${t.token}` } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', () => resolve(-1));
    });
    assert.equal(status, 401);
  });

  test('tokens restricted to a workspace are revoked when their owner leaves it; other tokens survive', async () => {
    const { client: member } = await addMember(admin, wid, 'depart@oriel.test', 'Départ', 'member');
    const restricted = await createToken(member, { name: 'temp', scope: 'read', workspaceId: wid });
    const global = await createToken(member, { name: 'global', scope: 'read' });
    assert.equal((await bearer(srv.base, restricted.token, 'GET', `/workspaces/${wid}/tree`)).status, 200);
    const uid = expectOk(await member.get<SessionResponse>('/auth/me')).user.id;
    expectOk(await admin.del(`/workspaces/${wid}/members/${uid}`));
    assert.equal((await bearer(srv.base, restricted.token, 'GET', '/auth/me')).status, 401, 'revoked');
    assert.equal((await bearer(srv.base, global.token, 'GET', '/auth/me')).status, 200);
    assert.equal((await bearer(srv.base, global.token, 'GET', `/workspaces/${wid}/tree`)).status, 404, 'no longer a member');
    const ids = expectOk(await member.get<ApiTokensResponse>('/me/tokens')).tokens.map((x) => x.id);
    assert.deepEqual(ids, [global.id]);
  });

  test('invitations, roles, publication and AI settings stay cookie-only', async () => {
    const t = await createToken(admin, { name: 'admin', scope: 'write' });
    const { user: target } = await addMember(admin, wid, 'cible@oriel.test', 'Cible', 'viewer');
    const invite = expectOk(await admin.post<{ token: string }>(`/workspaces/${wid}/invites`, { role: 'member' }));
    const page = await createPage(admin, wid, { title: 'À publier' });
    for (const [method, url, body] of [
      ['GET', `/workspaces/${wid}/invites`, undefined],
      ['POST', `/workspaces/${wid}/invites`, { role: 'admin' }],
      ['DELETE', `/workspaces/${wid}/invites/${invite.token}`, undefined],
      ['POST', `/workspaces/${wid}/invites/email`, { email: 'x@oriel.test', role: 'admin' }],
      ['PATCH', `/workspaces/${wid}/members/${target.id}`, { role: 'admin' }],
      ['DELETE', `/workspaces/${wid}/members/${target.id}`, undefined],
      ['POST', `/invites/${invite.token}/accept`, undefined],
      ['POST', `/pages/${page.id}/publish`, { isPublic: true }],
      ['PUT', `/workspaces/${wid}/ai/settings`, { enabled: true }],
    ] as const) {
      const res = await bearer(srv.base, t.token, method, url, body);
      assert.equal(res.status, 403, `${method} ${url} → ${res.status}`);
    }
    // Reading members (person properties) and AI settings stays possible.
    assert.equal((await bearer(srv.base, t.token, 'GET', `/workspaces/${wid}/members`)).status, 200);
    assert.equal((await bearer(srv.base, t.token, 'GET', `/workspaces/${wid}/ai/settings`)).status, 200);
    // Nothing changed.
    const members = expectOk(await admin.get<Array<{ user: { id: string }; role: string }>>(`/workspaces/${wid}/members`));
    assert.equal(members.find((m) => m.user.id === target.id)?.role, 'viewer');
    assert.equal(expectOk(await admin.get<{ page: Page }>(`/pages/${page.id}`)).page.isPublic, false);
    assert.ok(expectOk(await admin.get<Array<{ token: string }>>(`/workspaces/${wid}/invites`)).some((i) => i.token === invite.token));
  });

  test('CSRF rules still apply when a valid token comes with a session cookie; the cookie never authenticates', async () => {
    const t = await createToken(admin, { name: 'mixte', scope: 'write' });
    const { client: other } = await addMember(admin, wid, 'mixte@oriel.test', 'Mixte', 'member');
    const page = await createPage(admin, wid, { title: 'Mixte' });
    const send = (origin?: string) =>
      fetch(`${srv.base}/api/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${t.token}`,
          cookie: `oriel_session=${other.cookie}`,
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ title: 'Mixte modifié' }),
      });
    assert.equal((await send('https://evil.example')).status, 403, 'foreign Origin with a cookie');
    const res = await send();
    assert.equal(res.status, 200);
    const updated = (await res.json()) as Page;
    const adminId = expectOk(await admin.get<SessionResponse>('/auth/me')).user.id;
    assert.equal(updated.updatedBy, adminId, 'the token user acts, not the cookie user');
    const me = await fetch(`${srv.base}/api/auth/me`, { headers: { authorization: `Bearer ${t.token}`, cookie: `oriel_session=${other.cookie}` } });
    assert.equal(((await me.json()) as SessionResponse).user.id, adminId);
  });

  test('body ids cannot reach another workspace with a restricted token', async () => {
    const t = await createToken(admin, { name: 'corps', scope: 'write', workspaceId: wid });
    const call = (method: string, url: string, body?: unknown) => bearer(srv.base, t.token, method, url, body);
    // Relation to a database of the other workspace.
    const otherDb = await createPage(admin, wid2, { kind: 'database', title: 'Base cachée' });
    const ownDb = expectOk(await call('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, kind: 'database', title: 'Base' })) as Page;
    const rel = await call('POST', `/databases/${ownDb.id}/properties`, { property: { type: 'relation', name: 'R', relation: { databaseId: otherDb.id } } });
    assert.notEqual(rel.status, 200);
    // Template instantiated into the other workspace.
    const tpl = expectOk(await call('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'Modèle' })) as Page;
    expectOk(await call('PUT', `/pages/${tpl.id}/template`, { isTemplate: true }));
    const inst = await call('POST', `/pages/${tpl.id}/instantiate`, { parentType: 'workspace', parentId: wid2 });
    assert.notEqual(inst.status, 200);
    const inst2 = await call('POST', `/pages/${tpl.id}/instantiate`, { parentType: 'page', parentId: page2.id });
    assert.notEqual(inst2.status, 200);
    const tree2 = expectOk(await admin.get<{ nodes: Array<{ title: string }> }>(`/workspaces/${wid2}/tree`));
    assert.ok(!tree2.nodes.some((n) => n.title === 'Modèle'));
  });
});

describe('api tokens: password changes revoke every token', () => {
  test('password change and password reset', async () => {
    const srv = await startTestServer();
    try {
      const { admin } = await setupAdmin(srv.base);
      const a = await createToken(admin, { name: 'a', scope: 'write' });
      expectOk(await admin.post('/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-mot-de-passe' }));
      assert.equal((await bearer(srv.base, a.token, 'GET', '/auth/me')).status, 401);
      assert.equal(expectOk(await admin.get<ApiTokensResponse>('/me/tokens')).tokens.length, 0);
      // Changing the name does not revoke anything.
      const b = await createToken(admin, { name: 'b', scope: 'write' });
      expectOk(await admin.patch('/me', { name: 'Alice' }));
      assert.equal((await bearer(srv.base, b.token, 'GET', '/auth/me')).status, 200);
      // Reset link (admin-generated here; same code path as the e-mailed one).
      const link = expectOk(await admin.post<{ url: string }>(`/admin/users/${expectOk(await admin.get<SessionResponse>('/auth/me')).user.id}/password-reset`, {}));
      expectOk(await new Client(srv.base).post('/auth/password/reset', { token: link.url.split('/').pop(), password: 'encore-un-autre-mdp' }));
      assert.equal((await bearer(srv.base, b.token, 'GET', '/auth/me')).status, 401);
    } finally {
      await srv.stop();
    }
  });
});

describe('api tokens: rate limiting', () => {
  test('each token is limited per minute', async () => {
    apiTokenTestHooks.requestsPerMinute = 5;
    const srv = await startTestServer();
    try {
      const { admin } = await setupAdmin(srv.base);
      const a = await createToken(admin, { name: 'a', scope: 'read' });
      const b = await createToken(admin, { name: 'b', scope: 'read' });
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await bearer(srv.base, a.token, 'GET', '/auth/me')).status);
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
      assert.equal((await bearer(srv.base, b.token, 'GET', '/auth/me')).status, 200, 'quota is per token');
      assert.equal((await admin.get('/auth/me')).status, 200, 'cookie sessions are not affected');
    } finally {
      delete apiTokenTestHooks.requestsPerMinute;
      await srv.stop();
    }
  });
});
