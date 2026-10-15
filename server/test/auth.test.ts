import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthConfigResponse, Invite, InviteInfoResponse, SessionResponse, TreeResponse } from '@oriel/shared';
import { Client, expectOk, signup, startTestServer, type TestServer } from './helpers.js';

describe('auth, signup modes and invites', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.stop();
  });

  test('health and initial config', async () => {
    const c = new Client(srv.base);
    assert.deepEqual(expectOk(await c.get('/health')), { ok: true, version: '0.1.0' });
    const cfg = expectOk(await c.get<AuthConfigResponse>('/auth/config'));
    assert.equal(cfg.hasUsers, false);
    assert.equal(cfg.signupMode, 'first-user');
  });

  test('first signup becomes admin with a workspace and a welcome page', async () => {
    const res = await signup(srv.base, 'Alice@Example.com', 'Alice Martin');
    admin = res.client;
    const s = res.session;
    assert.equal(s.user.email, 'alice@example.com');
    assert.equal(s.user.isAdmin, true);
    assert.equal(s.workspaces.length, 1);
    assert.equal(s.workspaces[0]!.name, 'Espace de Alice');
    assert.equal(s.workspaces[0]!.role, 'owner');
    wid = s.workspaces[0]!.id;
    const tree = expectOk(await admin.get<TreeResponse>(`/workspaces/${wid}/tree`));
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.nodes[0]!.title, 'Bienvenue dans Oriel');
    assert.equal(tree.nodes[0]!.icon, '👋');
    const cfg = expectOk(await new Client(srv.base).get<AuthConfigResponse>('/auth/config'));
    assert.equal(cfg.hasUsers, true);
  });

  test('session cookie flags', async () => {
    const c = new Client(srv.base);
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'motdepasse-solide' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().find((h) => h.startsWith('oriel_session='));
    assert.ok(cookie);
    assert.match(cookie!, /HttpOnly/i);
    assert.match(cookie!, /SameSite=Lax/i);
    assert.match(cookie!, /Path=\//);
    assert.doesNotMatch(cookie!, /Secure/);
    void c;
  });

  test('signups are closed after the first account', async () => {
    const c = new Client(srv.base);
    const res = await c.post('/auth/signup', { email: 'bob@example.com', name: 'Bob', password: 'motdepasse-solide' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
    assert.ok(typeof res.body.error.message === 'string' && res.body.error.message.length > 0);
  });

  test('invite flow: create, info, signup with token, accept by existing user, revoke', async () => {
    const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'member' }));
    assert.equal(invite.role, 'member');
    assert.equal(invite.url, `/invite/${invite.token}`);
    assert.ok(Buffer.from(invite.token, 'base64url').length === 32);

    const anon = new Client(srv.base);
    const info = expectOk(await anon.get<InviteInfoResponse>(`/invites/${invite.token}`));
    assert.equal(info.valid, true);
    assert.equal(info.workspace?.id, wid);
    assert.equal(info.invitedBy?.name, 'Alice Martin');

    const bob = await signup(srv.base, 'bob@example.com', 'Bob Durand', invite.token);
    assert.equal(bob.session.workspaces.length, 1);
    assert.equal(bob.session.workspaces[0]!.id, wid);
    assert.equal(bob.session.workspaces[0]!.role, 'member');
    assert.equal(bob.session.user.isAdmin, false);

    // Existing user accepting an invite
    const viewerInvite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'viewer', expiresInDays: 2 }));
    const carolClient = new Client(srv.base);
    // Carol needs an account: open signups temporarily
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const carol = expectOk(
      await carolClient.post<SessionResponse>('/auth/signup', { email: 'carol@example.com', name: 'Carol', password: 'motdepasse-solide' }),
    );
    assert.equal(carol.workspaces.length, 1, 'open signup creates a personal workspace');
    expectOk(await admin.patch('/admin/settings', { signupMode: 'invite' }));
    const accepted = expectOk(await carolClient.post(`/invites/${viewerInvite.token}/accept`));
    assert.equal(accepted.workspace.id, wid);
    assert.equal(accepted.workspace.role, 'viewer');

    const invites = expectOk(await admin.get<Invite[]>(`/workspaces/${wid}/invites`));
    assert.ok(invites.some((i) => i.token === invite.token && i.uses === 1));

    expectOk(await admin.del(`/workspaces/${wid}/invites/${invite.token}`));
    const after = expectOk(await anon.get<InviteInfoResponse>(`/invites/${invite.token}`));
    assert.equal(after.valid, false);
    const rejected = await anon.post('/auth/signup', { email: 'dave@example.com', name: 'Dave', password: 'motdepasse-solide', inviteToken: invite.token });
    assert.equal(rejected.status, 400);

    // Members cannot manage invites
    assert.equal((await bob.client.post(`/workspaces/${wid}/invites`, { role: 'member' })).status, 403);
  });

  test('login / logout / me', async () => {
    const c = new Client(srv.base);
    const bad = await c.post('/auth/login', { email: 'bob@example.com', password: 'mauvais-mot-de-passe' });
    assert.equal(bad.status, 401);
    const unknown = await c.post('/auth/login', { email: 'nobody@example.com', password: 'mauvais-mot-de-passe' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.message, bad.body.error.message, 'generic login error');

    expectOk(await c.post('/auth/login', { email: 'BOB@example.com', password: 'motdepasse-solide' }));
    const me = expectOk(await c.get<SessionResponse>('/auth/me'));
    assert.equal(me.user.email, 'bob@example.com');
    const cookie = c.cookie;
    expectOk(await c.post('/auth/logout'));
    assert.equal(c.cookie, null);
    assert.equal((await c.get('/auth/me')).status, 401);
    // The old token is dead server-side too
    c.cookie = cookie;
    assert.equal((await c.get('/auth/me')).status, 401);
  });

  test('profile update and password change', async () => {
    const c = new Client(srv.base);
    expectOk(await c.post('/auth/login', { email: 'bob@example.com', password: 'motdepasse-solide' }));
    const upd = expectOk(await c.patch('/me', { name: 'Bob D.' }));
    assert.equal(upd.user.name, 'Bob D.');
    const wrong = await c.post('/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'nouveau-mot-de-passe' });
    assert.equal(wrong.status, 400);
    expectOk(await c.post('/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-mot-de-passe' }));
    const c2 = new Client(srv.base);
    assert.equal((await c2.post('/auth/login', { email: 'bob@example.com', password: 'motdepasse-solide' })).status, 401);
    expectOk(await c2.post('/auth/login', { email: 'bob@example.com', password: 'nouveau-mot-de-passe' }));
  });

  test('validation errors are French ApiErrorBody', async () => {
    const c = new Client(srv.base);
    const res = await c.post('/auth/signup', { email: 'pas-un-email', name: 'X', password: 'court' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation');
    assert.match(res.body.error.message, /Requête invalide/);
  });

  test('admin endpoints are restricted', async () => {
    const c = new Client(srv.base);
    expectOk(await c.post('/auth/login', { email: 'bob@example.com', password: 'nouveau-mot-de-passe' }));
    assert.equal((await c.get('/admin/settings')).status, 403);
    const users = expectOk(await admin.get('/admin/users'));
    assert.ok(users.users.length >= 3);
    assert.ok(users.users.every((u: { workspaceCount: number }) => typeof u.workspaceCount === 'number'));
  });

  test('CSRF: foreign Origin and non-JSON content types are rejected', async () => {
    const evil = await admin.req('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'forbidden');
    const nullOrigin = await admin.req('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid }, { origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    const same = await admin.req('POST', `/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, title: 'ok' }, { origin: srv.base });
    assert.equal(same.status, 200);
    const form = await admin.req('POST', `/workspaces/${wid}/pages`, undefined, {
      contentType: 'application/x-www-form-urlencoded',
      rawBody: 'parentType=workspace',
    });
    assert.equal(form.status, 403);
    const text = await admin.req('POST', '/auth/logout', undefined, { contentType: 'text/plain', rawBody: 'x' });
    assert.equal(text.status, 403);
    // Body-less POST without content type (as sent by the web client) is accepted
    const dup = await admin.req('POST', `/pages/${same.body.id}/duplicate`, undefined);
    assert.equal(dup.status, 200);
  });

  test('security headers', async () => {
    const res = await fetch(`${srv.base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    const html = await fetch(`${srv.base}/w/abc`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(html.headers.get('content-security-policy'));
    const apiMissing = await fetch(`${srv.base}/api/nope`);
    assert.equal(apiMissing.status, 404);
    assert.equal((await apiMissing.json()).error.code, 'not_found');
  });
});

describe('rate limiting', () => {
  test('login/signup limited per IP', async () => {
    const srv = await startTestServer({ authRateLimit: 3 });
    try {
      const c = new Client(srv.base);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await c.post('/auth/login', { email: 'x@example.com', password: 'whatever-123' })).status);
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.equal(statuses[3], 429);
      const res = await c.post('/auth/login', { email: 'x@example.com', password: 'whatever-123' });
      assert.equal(res.body.error.code, 'rate_limited');
    } finally {
      await srv.stop();
    }
  });
});

describe('local mode', () => {
  test('auto-login of the local user from loopback', async () => {
    const srv = await startTestServer({ localMode: true });
    try {
      const c = new Client(srv.base);
      const me = expectOk(await c.get<SessionResponse>('/auth/me'));
      assert.equal(me.user.email, 'local@oriel.app');
      assert.equal(me.user.name, 'Moi');
      assert.equal(me.workspaces.length, 1);
      assert.ok(c.cookie);
      const again = expectOk(await c.get<SessionResponse>('/auth/me'));
      assert.equal(again.user.id, me.user.id);
      const login = await c.post('/auth/login', { email: 'local@oriel.app', password: 'disabled' });
      assert.equal(login.status, 401);
    } finally {
      await srv.stop();
    }
  });

  test('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const srv = await startTestServer({ localMode: true });
    try {
      const { request } = await import('node:http');
      const statusFor = (host: string) =>
        new Promise<number>((resolve, reject) => {
          const url = new URL('/api/auth/me', srv.base);
          const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
      assert.equal(await statusFor('evil.example:80'), 403);
      assert.equal(await statusFor(`localhost:${new URL(srv.base).port}`), 200);
    } finally {
      await srv.stop();
    }
  });
});
