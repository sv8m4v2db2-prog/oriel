// QA (HTTP layer): authentication, sessions, CSRF, rate limiting, password reset, uploads, public
// routes, static serving and local mode. Each test reproduces a suspected flaw against an in-process
// server (127.0.0.1, throwaway DATA_DIR). Fixed issues stay as non-regression tests; confirmed but
// unfixed ones are kept with `todo` (see the QA-HTTP-xx ids).
process.env.SMTP_URL = 'json:quiet';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { Invite, SessionResponse, UploadedFile } from '@oriel/shared';
import { Client, addMember, createPage, expectOk, setupAdmin, signup, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { mailOutbox } from '../src/collab/mailer.js';
import { hashToken } from '../src/auth/sessions.js';
import { requestOrigin } from '../src/auth/resetRoutes.js';
import { clientKey } from '../src/auth/rateLimit.js';
import { parseTrustProxy, proxyTrust } from '../src/util/proxyTrust.js';
import type { AppContext } from '../src/context.js';

/** Raw HTTP request: lets the test choose the Host header and send paths fetch() would normalize. */
function raw(
  base: string,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
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

const ctxOf = (srv: TestServer): AppContext => collabContexts.get(srv.dataDir)!;
const linkIn = (text: string, route: string) => new RegExp(`(\\S+)/${route}/[A-Za-z0-9_-]+`).exec(text)?.[1] ?? null;

async function loginStatus(base: string, email: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email, password: 'mauvais-mot-de-passe' }),
  });
  await res.text();
  return res.status;
}

function wsStatus(url: string, headers: Record<string, string>): Promise<number | 'open'> {
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
// QA-HTTP-01 — absolute links of e-mails poisoned through the Host / X-Forwarded-Host header
// ---------------------------------------------------------------------------------------------

describe('QA-HTTP-01: e-mail links cannot be poisoned by an ordinary account (no PUBLIC_URL)', () => {
  let srv: TestServer;
  let admin: Client;
  let attacker: Client;

  before(async () => {
    srv = await startTestServer({ trustProxy: true });
    ({ admin } = await setupAdmin(srv.base));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    // Any account of the instance, not even a member of the admin's workspace.
    ({ client: attacker } = await signup(srv.base, 'mallory@oriel.test', 'Mallory'));
  });
  after(async () => {
    await srv.stop();
  });

  test('Host header of a non-admin request does not end up in the reset link sent to the admin', async () => {
    const res = await raw(srv.base, 'GET', '/api/auth/me', { host: 'evil.example', cookie: `oriel_session=${attacker.cookie}` });
    assert.equal(res.status, 200);
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'admin@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'admin@oriel.test'), 3000, 'reset mail');
    const base = linkIn(mail.text, 'reset-password');
    assert.ok(base, mail.text);
    assert.doesNotMatch(base!, /evil\.example/, `reset link points to the attacker: ${base}`);
  });

  test('X-Forwarded-Host of a non-admin request (any route) does not end up in the reset link either', async () => {
    const res = await raw(srv.base, 'GET', '/api/me/notification-settings', {
      'x-forwarded-host': 'evil.example',
      cookie: `oriel_session=${attacker.cookie}`,
    });
    assert.equal(res.status, 200);
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'admin@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'admin@oriel.test'), 3000, 'reset mail');
    const base = linkIn(mail.text, 'reset-password');
    assert.ok(base, mail.text);
    assert.doesNotMatch(base!, /evil\.example/, `reset link points to the attacker: ${base}`);
  });

  test('requestOrigin() itself ignores requests of non-administrators (defense in depth)', () => {
    // `host` / `protocol` are Fastify's proxy-aware getters (X-Forwarded-* only from a trusted peer).
    const fake = (isAdmin: number) => ({ auth: { user: { is_admin: isAdmin } }, host: 'evil.example', protocol: 'http' }) as never;
    assert.equal(requestOrigin(fake(0)), '');
    assert.equal(requestOrigin({ auth: null, host: 'evil.example', protocol: 'http' } as never), '');
    assert.equal(requestOrigin(fake(1)), 'http://evil.example');
  });

  test('the origin seen by an instance administrator is still used for links', async () => {
    const res = await raw(srv.base, 'GET', '/api/auth/me', { host: 'notes.example:8080', cookie: `oriel_session=${admin.cookie}` });
    assert.equal(res.status, 200);
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'mallory@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'mallory@oriel.test'), 3000, 'reset mail');
    assert.equal(linkIn(mail.text, 'reset-password'), 'http://notes.example:8080');
  });
});

// ---------------------------------------------------------------------------------------------
// QA-HTTP-02 — per-IP rate limiting and IPv6
// ---------------------------------------------------------------------------------------------

describe('QA-HTTP-02: login rate limit cannot be bypassed by rotating IPv6 addresses of one /64', () => {
  test('clientKey(): IPv4 unchanged, IPv4-mapped unwrapped, IPv6 grouped by /64 whatever its spelling', () => {
    assert.equal(clientKey('203.0.113.5'), '203.0.113.5');
    assert.equal(clientKey('::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(clientKey('::FFFF:cb00:7105'), '203.0.113.5');
    assert.equal(clientKey('[2001:db8:1:2::1]'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:0db8:0001:0002:abcd:0:0:1'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:db8:1:2:aaaa:bbbb:1.2.3.4'), '2001:db8:1:2::/64');
    assert.equal(clientKey('fe80::1%en0'), 'fe80:0:0:0::/64');
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
    assert.notEqual(clientKey('2001:db8:1:3::1'), clientKey('2001:db8:1:2::1'));
    assert.equal(clientKey('not-an-ip'), 'not-an-ip');
    assert.equal(clientKey(undefined), '');
  });

  test('addresses of the same /64 (and IPv4-mapped forms) share one quota', async () => {
    const srv = await startTestServer({ authRateLimit: 3, trustProxy: true });
    try {
      const statuses: number[] = [];
      // As forwarded by the reverse proxy for 6 different source addresses of one /64.
      for (let i = 1; i <= 6; i++) statuses.push(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` }));
      assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429]);
      // Another /64 has its own quota; written in another form, the same /64 does not.
      assert.equal(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': '2001:db8:1:3::1' }), 401);
      assert.equal(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': '2001:0DB8:0001:0002:ffff:0:0:1' }), 429);
      // IPv4 and its IPv4-mapped IPv6 form are the same client.
      const v4: number[] = [];
      for (let i = 0; i < 2; i++) v4.push(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': '203.0.113.5' }));
      for (let i = 0; i < 2; i++) v4.push(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': '::ffff:203.0.113.5' }));
      assert.deepEqual(v4, [401, 401, 401, 429]);
    } finally {
      await srv.stop();
    }
  });
});

describe('QA-HTTP-03: TRUST_PROXY only trusts proxy addresses, not any immediate peer', () => {
  test('default (true): loopback and private networks are trusted, public peers are not', () => {
    const trusted = proxyTrust(true);
    for (const ip of ['127.0.0.1', '127.8.9.10', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.20', 'fd00::5', '::ffff:10.0.0.2', '::ffff:127.0.0.1']) {
      assert.equal(trusted(ip), true, ip);
    }
    // Public, CGNAT and link-local peers (a client reaching a server exposed without proxy).
    for (const ip of ['198.51.100.7', '8.8.8.8', '172.32.0.1', '100.64.0.1', '169.254.1.1', '::ffff:8.8.8.8', '2001:db8::1', 'fe80::1%en0', '', undefined]) {
      assert.equal(trusted(ip), false, String(ip));
    }
    assert.equal(proxyTrust(false)('127.0.0.1'), false);
  });

  test('a list trusts exactly its addresses, CIDRs and keywords', () => {
    const trusted = proxyTrust(['203.0.113.10', '198.51.100.0/24', '2001:db8:1::/48', 'loopback']);
    assert.equal(trusted('203.0.113.10'), true);
    assert.equal(trusted('203.0.113.11'), false);
    assert.equal(trusted('198.51.100.200'), true);
    assert.equal(trusted('2001:db8:1:ffff::1'), true);
    assert.equal(trusted('::1'), true);
    assert.equal(trusted('10.0.0.1'), false, 'private networks are not implied by a list');
  });

  test('TRUST_PROXY parsing: booleans, lists, and invalid entries fail fast', () => {
    assert.equal(parseTrustProxy(undefined), true);
    assert.equal(parseTrustProxy(''), true);
    assert.equal(parseTrustProxy('TRUE'), true);
    assert.equal(parseTrustProxy('off'), false);
    assert.deepEqual(parseTrustProxy(' private , 203.0.113.0/24 '), ['private', '203.0.113.0/24']);
    for (const bad of ['203.0.113.0/33', 'proxy.example', '10.0.0.0/8/1', '::1/129', '*']) {
      assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
    }
  });

  test('a client-chosen X-Forwarded-For does not reset the login quota when the peer is not a trusted proxy', async () => {
    // The test client (127.0.0.1) plays a client reaching the server directly: only 203.0.113.10 is a proxy.
    const srv = await startTestServer({ authRateLimit: 3, trustProxy: ['203.0.113.10'] });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push(await loginStatus(srv.base, 'cible@oriel.test', { 'x-forwarded-for': `198.51.100.${i + 1}` }));
      assert.deepEqual(statuses.slice(3), [429, 429, 429]);
    } finally {
      await srv.stop();
    }
  });

  test('X-Forwarded-Host from an untrusted peer neither widens the CSRF origin check nor e-mail links', async () => {
    const srv = await startTestServer({ trustProxy: ['203.0.113.10'] });
    try {
      const res = await raw(srv.base, 'POST', '/api/auth/login', {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'x-forwarded-host': 'evil.example',
      }, JSON.stringify({ email: 'x@oriel.test', password: 'mauvais-mot-de-passe' }));
      assert.equal(res.status, 403);
    } finally {
      await srv.stop();
    }
  });

  test('behind a trusted proxy, the last X-Forwarded-Host entry (set by the proxy) is the one used', async () => {
    const srv = await startTestServer({ trustProxy: true });
    try {
      const login = (xfh: string, origin: string) =>
        raw(srv.base, 'POST', '/api/auth/login', { 'content-type': 'application/json', origin, 'x-forwarded-host': xfh },
          JSON.stringify({ email: 'x@oriel.test', password: 'mauvais-mot-de-passe' }));
      // Nginx-style append: "<client value>, <real host>".
      assert.equal((await login('evil.example, notes.example', 'https://evil.example')).status, 403);
      assert.equal((await login('evil.example, notes.example', 'https://notes.example')).status, 401);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// QA-HTTP-04 — Secure cookies with an https PUBLIC_URL
// ---------------------------------------------------------------------------------------------

describe('QA-HTTP-04: session cookies are Secure when PUBLIC_URL is https', () => {
  test('even if the proxy does not forward X-Forwarded-Proto', async () => {
    const srv = await startTestServer({ publicUrl: 'https://notes.example', trustProxy: true });
    try {
      const res = await fetch(`${srv.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'secure@oriel.test', name: 'Sécurité', password: 'motdepasse-solide' }),
      });
      assert.equal(res.status, 200);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('oriel_session='))!;
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      const out = await fetch(`${srv.base}/api/auth/logout`, { method: 'POST', headers: { cookie: cookie.split(';')[0]! } });
      const cleared = out.headers.getSetCookie().find((c) => c.startsWith('oriel_session='))!;
      assert.match(cleared, /; Secure/i);
    } finally {
      await srv.stop();
    }
  });

  test('without PUBLIC_URL, plain http requests keep non-Secure cookies (local / LAN use)', async () => {
    const srv = await startTestServer();
    try {
      const res = await fetch(`${srv.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'lan@oriel.test', name: 'LAN', password: 'motdepasse-solide' }),
      });
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('oriel_session='))!;
      assert.doesNotMatch(cookie, /; Secure/i);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Sessions, passwords and accounts
// ---------------------------------------------------------------------------------------------

describe('sessions, passwords and accounts', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ctx = ctxOf(srv);
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  test('QA-HTTP-05: changing the password invalidates pending reset links', async () => {
    const { client } = await addMember(admin, wid, 'oubli@oriel.test', 'Olive', 'member');
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'oubli@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'oubli@oriel.test'), 3000, 'reset mail');
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    // The user (who did not ask for it, or whose mailbox was read) changes their password…
    expectOk(await client.post('/me/password', { currentPassword: 'motdepasse-solide', newPassword: 'nouveau-secret-1' }));
    // …the pending link must not be able to override it.
    assert.equal(expectOk(await new Client(srv.base).get(`/auth/password/reset/${token}`)).valid, false);
    assert.equal((await new Client(srv.base).post('/auth/password/reset', { token, password: 'pirate-pirate' })).status, 400);
    expectOk(await new Client(srv.base).post('/auth/login', { email: 'oubli@oriel.test', password: 'nouveau-secret-1' }));
  });

  test('expired sessions are refused and deleted; active ones slide', async () => {
    const c = new Client(srv.base);
    expectOk(await c.post('/auth/login', { email: 'admin@oriel.test', password: 'motdepasse-solide' }));
    const id = hashToken(c.cookie!);
    ctx.db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() - 1000, id);
    assert.equal((await c.get('/auth/me')).status, 401);
    assert.equal(ctx.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', id), undefined);

    const d = new Client(srv.base);
    expectOk(await d.post('/auth/login', { email: 'admin@oriel.test', password: 'motdepasse-solide' }));
    const did = hashToken(d.cookie!);
    const soon = Date.now() + 24 * 60 * 60 * 1000;
    ctx.db.run('UPDATE sessions SET expires_at = ? WHERE id = ?', soon, did);
    const res = await d.get('/auth/me');
    assert.equal(res.status, 200);
    assert.ok(res.headers.getSetCookie().some((h) => h.startsWith('oriel_session=')), 'cookie re-sent on refresh');
    assert.ok(ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE id = ?', did)!.expires_at > soon + 24 * 60 * 60 * 1000);
    // Session ids are stored hashed: the raw token is not a key.
    assert.equal(ctx.db.get('SELECT 1 AS x FROM sessions WHERE id = ?', d.cookie), undefined);
  });

  test('oversized or malformed session cookies are ignored', async () => {
    for (const value of ['x'.repeat(5000), '%E0%A4%A', '"quoted"', '']) {
      const res = await raw(srv.base, 'GET', '/api/auth/me', { cookie: `oriel_session=${value}` });
      assert.ok([401, 431].includes(res.status), String(res.status));
    }
  });

  test('e-mail addresses are case-insensitive and unique at signup and login', async () => {
    const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'member' }));
    const dup = await new Client(srv.base).post('/auth/signup', {
      email: '  ADMIN@Oriel.TEST ',
      name: 'Doublon',
      password: 'motdepasse-solide',
      inviteToken: invite.token,
    });
    assert.equal(dup.status, 409);
    expectOk(await new Client(srv.base).post('/auth/login', { email: ' Admin@ORIEL.test ', password: 'motdepasse-solide' }));
    // Non-ASCII addresses are refused (no Unicode case-folding ambiguity with SQLite NOCASE).
    const unicode = await new Client(srv.base).post('/auth/signup', { email: 'élodie@oriel.test', name: 'É', password: 'motdepasse-solide', inviteToken: invite.token });
    assert.equal(unicode.status, 400);
    // Characters that lowercase to ASCII (KELVIN SIGN → "k") cannot create a look-alike duplicate.
    expectOk(await new Client(srv.base).post('/auth/signup', { email: 'kate@oriel.test', name: 'Kate', password: 'motdepasse-solide', inviteToken: invite.token }));
    const kelvin = await new Client(srv.base).post('/auth/signup', { email: '\u212Aate@oriel.test', name: 'K', password: 'motdepasse-solide', inviteToken: invite.token });
    assert.equal(kelvin.status, 409);
  });

  test('field length limits on signup and login', async () => {
    const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'viewer' }));
    const long = await new Client(srv.base).post('/auth/signup', { email: 'long@oriel.test', name: 'n'.repeat(101), password: 'motdepasse-solide', inviteToken: invite.token });
    assert.equal(long.status, 400);
    const pw = await new Client(srv.base).post('/auth/login', { email: 'admin@oriel.test', password: 'p'.repeat(257) });
    assert.equal(pw.status, 400);
    const short = await new Client(srv.base).post('/auth/signup', { email: 'short@oriel.test', name: 'S', password: '1234567', inviteToken: invite.token });
    assert.equal(short.status, 400);
  });

  test(
    'QA-HTTP-06: signup does not reveal which e-mail addresses have an account',
    { todo: 'QA-HTTP-06: by design (UX) — signup answers 409 for an existing address; only reachable with an invite link or in open mode' },
    async () => {
      const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role: 'viewer' }));
      const res = await new Client(srv.base).post('/auth/signup', { email: 'admin@oriel.test', name: 'X', password: 'motdepasse-solide', inviteToken: invite.token });
      assert.notEqual(res.status, 409);
    },
  );
});

describe('first-user signup race', () => {
  test('concurrent first signups create exactly one instance administrator', async () => {
    const srv = await startTestServer();
    try {
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          new Client(srv.base).post<SessionResponse>('/auth/signup', { email: `premier${i}@oriel.test`, name: `P${i}`, password: 'motdepasse-solide' }),
        ),
      );
      const ok = results.filter((r) => r.status === 200);
      assert.equal(ok.length, 1, results.map((r) => r.status).join(','));
      assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 403));
      assert.equal(ok[0]!.body.user.isAdmin, true);
      const admins = ctxOf(srv).db.all('SELECT id FROM users WHERE is_admin = 1');
      assert.equal(admins.length, 1);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CSRF / CORS
// ---------------------------------------------------------------------------------------------

describe('CSRF and CORS', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer({ trustProxy: true, publicUrl: '' });
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  test('cross-site variants are refused (origin port/scheme confusion, multipart, missing content type with a body)', async () => {
    const cookie = `oriel_session=${admin.cookie}`;
    const host = new URL(srv.base).host;
    const port = new URL(srv.base).port;
    const body = JSON.stringify({ name: 'Piraté' });
    const cases: Array<Record<string, string>> = [
      { origin: `http://127.0.0.1:${Number(port) + 1}`, 'content-type': 'application/json' },
      { origin: `http://${host}.evil.example`, 'content-type': 'application/json' },
      { origin: `http://evil.example#${host}`, 'content-type': 'application/json' },
      { origin: `http://${host}@evil.example`, 'content-type': 'application/json' },
      { origin: 'null', 'content-type': 'multipart/form-data; boundary=x' },
      { origin: 'https://evil.example', 'content-type': 'multipart/form-data; boundary=x' },
      { 'content-type': 'text/plain;charset=UTF-8' },
      { 'content-type': 'application/json-patch+json' },
      { 'content-type': ' application/x-www-form-urlencoded' },
      { 'transfer-encoding': 'chunked' },
    ];
    for (const headers of cases) {
      const res = await raw(srv.base, 'PATCH', `/api/workspaces/${wid}`, { cookie, ...headers }, body);
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    assert.notEqual(expectOk(await admin.get(`/workspaces/${wid}`)).name, 'Piraté');
  });

  test('no CORS headers are ever granted to a foreign origin', async () => {
    for (const [method, url] of [
      ['GET', '/api/auth/me'],
      ['OPTIONS', '/api/auth/me'],
      ['OPTIONS', `/api/workspaces/${wid}`],
    ] as const) {
      const res = await raw(srv.base, method, url, {
        origin: 'https://evil.example',
        cookie: `oriel_session=${admin.cookie}`,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      });
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${method} ${url}`);
      assert.equal(res.headers['access-control-allow-credentials'], undefined, `${method} ${url}`);
    }
  });

  test('cross-site WebSocket upgrades are refused on /api/events and /collab', async () => {
    const cookie = `oriel_session=${admin.cookie}`;
    assert.equal(await wsStatus(`${srv.wsBase}/api/events`, { cookie, origin: 'https://evil.example' }), 403);
    assert.equal(await wsStatus(`${srv.wsBase}/collab`, { cookie, origin: 'https://evil.example' }), 403);
    assert.equal(await wsStatus(`${srv.wsBase}/collab`, { cookie, origin: 'null' }), 403);
    assert.equal(await wsStatus(`${srv.wsBase}/api/events`, { cookie, origin: srv.base }), 'open');
  });
});

// ---------------------------------------------------------------------------------------------
// Uploads and downloads
// ---------------------------------------------------------------------------------------------

describe('uploads: multipart edge cases and download headers', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;
  let otherWid: string;
  let outsider: Client;

  before(async () => {
    srv = await startTestServer({ maxUploadMb: 1 });
    ({ admin, wid } = await setupAdmin(srv.base));
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const o = await signup(srv.base, 'autre@oriel.test', 'Autre');
    outsider = o.client;
    otherWid = o.session.workspaces[0]!.id;
  });
  after(async () => {
    await srv.stop();
  });

  const uploadsCount = () => readdirSync(path.join(srv.dataDir, 'uploads')).length;
  const post = (c: Client, workspace: string, form: FormData) =>
    fetch(`${srv.base}/api/workspaces/${workspace}/files`, { method: 'POST', headers: { cookie: `oriel_session=${c.cookie}` }, body: form });

  test('several files, no file, only fields: one file at most is stored, nothing is left behind', async () => {
    const before = uploadsCount();
    const two = new FormData();
    two.append('file', new Blob(['un'], { type: 'text/plain' }), 'un.txt');
    two.append('file', new Blob(['deux'], { type: 'text/plain' }), 'deux.txt');
    const res = await post(admin, wid, two);
    assert.ok([200, 400, 413].includes(res.status), String(res.status));
    await res.text();
    assert.ok(uploadsCount() - before <= 1);

    const fields = new FormData();
    for (let i = 0; i < 5; i++) fields.append(`f${i}`, 'x');
    const none = await post(admin, wid, fields);
    assert.equal(none.status, 400);

    const many = new FormData();
    for (let i = 0; i < 30; i++) many.append(`f${i}`, 'x');
    many.append('file', new Blob(['z']), 'z.txt');
    const tooMany = await post(admin, wid, many);
    assert.ok(tooMany.status >= 400 && tooMany.status < 500, String(tooMany.status));

    const big = new FormData();
    big.append('file', new Blob([new Uint8Array(1024 * 1024 + 1)]), 'gros.bin');
    const tooBig = await post(admin, wid, big);
    assert.equal(tooBig.status, 413);
    await sleep(50);
    assert.ok(uploadsCount() - before <= 1, 'no partial file kept');
    expectOk(await admin.get('/auth/me'));
  });

  test('uploads into a foreign workspace are refused without revealing it', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    const res = await post(outsider, wid, form);
    assert.equal(res.status, 404);
    const own = new FormData();
    own.append('file', new Blob(['x']), 'x.txt');
    assert.equal((await post(admin, otherWid, own)).status, 404);
  });

  test('download headers: inline only for passive media, nosniff, sandbox, no session needed', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['image/png', 'a.png', /^inline/],
      ['video/mp4', 'a.mp4', /^inline/],
      ['application/pdf', 'a.pdf', /^inline/],
      ['text/html', 'a.html', /^attachment/],
      ['image/svg+xml', 'a.svg', /^attachment/],
      ['application/javascript', 'a.js', /^attachment/],
      ['text/xml', 'a.xml', /^attachment/],
      ['multipart/x-mixed-replace', 'a.bin', /^attachment/],
      ['', 'sans-type', /^attachment/],
    ];
    for (const [type, name, disposition] of cases) {
      const form = new FormData();
      form.append('file', new Blob(['<html><script>alert(1)</script></html>'], type ? { type } : {}), name);
      const res = await post(admin, wid, form);
      assert.equal(res.status, 200, type);
      const file = (await res.json()) as UploadedFile;
      const got = await fetch(`${srv.base}${file.url}`);
      assert.match(got.headers.get('content-disposition') ?? '', disposition, type);
      assert.equal(got.headers.get('x-content-type-options'), 'nosniff', type);
      if (type !== 'application/pdf') assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/, type);
      assert.equal(got.headers.get('set-cookie'), null);
      await got.arrayBuffer();
    }
  });

  test('QA-WEB-11: an attachment-only file loaded in a frame does not start a download for every reader', async () => {
    const upload = async (type: string, name: string) => {
      const form = new FormData();
      form.append('file', new Blob(['contenu'], { type }), name);
      return (await (await post(admin, wid, form)).json()) as UploadedFile;
    };
    const zip = await upload('application/zip', 'archive.zip');
    const pdf = await upload('application/pdf', 'doc.pdf');
    const img = await upload('image/png', 'image.png');
    const get = async (url: string, dest?: string) => {
      const res = await fetch(`${srv.base}${url}`, { headers: dest ? { 'sec-fetch-dest': dest } : {} });
      await res.arrayBuffer();
      return res.status;
    };
    for (const dest of ['iframe', 'frame', 'embed', 'object']) assert.equal(await get(zip.url, dest), 403, dest);
    // A link click / direct download still works, and displayable files can be framed.
    assert.equal(await get(zip.url), 200);
    assert.equal(await get(zip.url, 'document'), 200);
    assert.equal(await get(pdf.url, 'iframe'), 200);
    assert.equal(await get(img.url, 'image'), 200);
  });

  test('range requests: invalid or unsatisfiable ranges never read outside the file', async () => {
    const form = new FormData();
    form.append('file', new Blob(['0123456789']), 'n.txt');
    const file = (await (await post(admin, wid, form)).json()) as UploadedFile;
    const get = async (range: string) => {
      const res = await fetch(`${srv.base}${file.url}`, { headers: { range } });
      return { status: res.status, text: await res.text(), range: res.headers.get('content-range') };
    };
    assert.deepEqual(await get('bytes=-3'), { status: 206, text: '789', range: 'bytes 7-9/10' });
    assert.equal((await get('bytes=10-')).status, 416);
    assert.equal((await get('bytes=5-2')).status, 416);
    assert.deepEqual(await get('bytes=8-999999999999999999999'), { status: 206, text: '89', range: 'bytes 8-9/10' });
    assert.equal((await get('bytes=0-1,4-5')).text, '0123456789');
    assert.equal((await get('bytes=-0')).status, 416);
  });
});

// ---------------------------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------------------------

describe('static serving (QA-HTTP-07 dotfiles): traversal, dotfiles, API fallback, headers', () => {
  let srv: TestServer;
  let root: string;

  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'oriel-qa-web-'));
    const web = path.join(root, 'web');
    mkdirSync(path.join(web, 'assets'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(path.join(web, 'assets', 'a.js'), 'console.log(1)');
    writeFileSync(path.join(web, '.env'), 'SECRET=dotfile');
    writeFileSync(path.join(root, 'secret.txt'), 'SECRET=outside');
    srv = await startTestServer({ webDist: web });
  });
  after(async () => {
    await srv.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test('encoded traversal and dotfiles never expose files', async () => {
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/assets/..%5c..%5csecret.txt', '/.env', '/assets/../.env', '/%2eenv']) {
      const res = await raw(srv.base, 'GET', p);
      assert.doesNotMatch(res.body, /SECRET=/, `${p} → ${res.status}`);
    }
  });

  test('API paths never fall back to the SPA, error responses carry the security headers', async () => {
    for (const p of ['/api', '/api/', '/api/nope', '/api/files/x/y']) {
      const res = await raw(srv.base, 'GET', p);
      assert.ok(res.status === 404 || res.status === 400, `${p} → ${res.status}`);
      assert.doesNotMatch(res.body, /<title>SPA/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', p);
    }
    const bad = await raw(srv.base, 'POST', '/api/auth/login', { 'content-type': 'application/json' }, '{"email":');
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.body, /at |SyntaxError|node_modules|stack/i);
    assert.equal(bad.headers['cache-control'], 'no-store');
  });
});

// ---------------------------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------------------------

describe('public routes: what a published page exposes', () => {
  let srv: TestServer;
  let admin: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  test('no e-mail addresses or password material in public payloads; unpublished siblings stay hidden', async () => {
    const root = await createPage(admin, wid, { title: 'Racine publiée' });
    const child = expectOk(await admin.post(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: root.id, title: 'Enfant' }));
    const sibling = await createPage(admin, wid, { title: 'Voisine non publiée' });
    const dbPage = expectOk(
      await admin.post<{ id: string }>(`/workspaces/${wid}/pages`, { parentType: 'page', parentId: root.id, kind: 'database', title: 'Base' }),
    );
    expectOk(await admin.post(`/pages/${root.id}/publish`, { isPublic: true }));
    const anon = new Client(srv.base);
    const page = expectOk(await anon.get(`/public/pages/${root.id}`));
    const rows = expectOk(await anon.get(`/public/databases/${dbPage.id}/rows`));
    const schema = expectOk(await anon.get(`/public/databases/${dbPage.id}`));
    for (const payload of [page, rows, schema, expectOk(await anon.get(`/public/pages/${child.id}`))]) {
      const text = JSON.stringify(payload);
      assert.doesNotMatch(text, /admin@oriel\.test/);
      assert.doesNotMatch(text, /scrypt\$/);
    }
    assert.ok(rows.users.every((u: { email: string }) => u.email === ''));
    assert.equal((await anon.get(`/public/pages/${sibling.id}`)).status, 404);
    // Trashing the published root hides the whole tree at once.
    expectOk(await admin.post(`/pages/${root.id}/trash`));
    assert.equal((await anon.get(`/public/pages/${child.id}`)).status, 404);
    assert.equal((await anon.get(`/public/databases/${dbPage.id}/rows`)).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------
// Local mode (desktop)
// ---------------------------------------------------------------------------------------------

describe('local mode: only the desktop window, never another site', () => {
  let srv: TestServer;
  let local: Client;

  before(async () => {
    // As a user could run it by hand: TRUST_PROXY left at its default.
    srv = await startTestServer({ localMode: true, trustProxy: true });
    local = new Client(srv.base);
    expectOk(await local.get('/auth/me'));
  });
  after(async () => {
    await srv.stop();
  });

  test('a page on another local origin cannot mutate, nor open sockets, with the local session', async () => {
    const port = Number(new URL(srv.base).port);
    const cookie = `oriel_session=${local.cookie}`;
    for (const origin of [`http://localhost:${port + 1}`, `http://127.0.0.1:${port + 1}`, 'https://evil.example', 'null']) {
      const res = await raw(srv.base, 'POST', '/api/workspaces', { cookie, origin, 'content-type': 'application/json' }, JSON.stringify({ name: 'x' }));
      assert.equal(res.status, 403, origin);
      assert.equal(await wsStatus(`${srv.wsBase}/api/events`, { cookie, origin }), 403, origin);
      assert.equal(await wsStatus(`${srv.wsBase}/collab`, { cookie, origin }), 403, origin);
    }
  });

  test('DNS rebinding: non-loopback Host names are refused on HTTP and WebSocket', async () => {
    const port = new URL(srv.base).port;
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.:${port}`, `localhost.evil.example:${port}`]) {
      assert.equal((await raw(srv.base, 'GET', '/api/auth/me', { host })).status, 403, host);
      assert.equal(await wsStatus(`${srv.wsBase}/collab`, { host }), 403, host);
    }
  });

  test('the local account cannot be used with a password, and signup stays closed', async () => {
    assert.equal((await new Client(srv.base).post('/auth/login', { email: 'local@oriel.app', password: 'disabled' })).status, 401);
    const res = await new Client(srv.base).post('/auth/signup', { email: 'intrus@oriel.test', name: 'Intrus', password: 'motdepasse-solide' });
    assert.equal(res.status, 403);
  });
});
