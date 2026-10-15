// Security regression tests: authentication, sessions, CSRF, rate limiting, invites and uploads.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { Invite, InviteInfoResponse, SessionResponse, UploadedFile } from '@oriel/shared';
import { Client, addMember, expectOk, setupAdmin, signup, startTestServer, type TestServer } from './helpers.js';

async function login(base: string, email: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ email, password: 'mauvais-mot-de-passe' }),
  });
  await res.text();
  return res.status;
}

/** Raw HTTP request (lets the test send a path that fetch() would normalize). */
function rawRequest(base: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(base);
    const req = request({ hostname: url.hostname, port: url.port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('security: rate limiting behind a reverse proxy', () => {
  test('a spoofed X-Forwarded-For prefix (nginx appends the real client) does not reset the login quota', async () => {
    const srv = await startTestServer({ authRateLimit: 3, trustProxy: true });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        // What nginx forwards with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
        // when the client itself sent "X-Forwarded-For: 10.66.<i>.1".
        statuses.push(await login(srv.base, 'cible@oriel.test', { 'x-forwarded-for': `10.66.${i}.1, 203.0.113.7` }));
      }
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.deepEqual(statuses.slice(3), [429, 429, 429]);
      // Distinct real clients (as forwarded by the proxy) still have their own quota.
      assert.equal(await login(srv.base, 'cible@oriel.test', { 'x-forwarded-for': '198.51.100.20' }), 401);
    } finally {
      await srv.stop();
    }
  });

  test('X-Forwarded-Proto from the proxy still yields Secure cookies', async () => {
    const srv = await startTestServer({ trustProxy: true });
    try {
      const res = await fetch(`${srv.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ email: 'proxy@oriel.test', name: 'Proxy', password: 'motdepasse-solide' }),
      });
      assert.equal(res.status, 200);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('oriel_session='))!;
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
    } finally {
      await srv.stop();
    }
  });

  test('the current-password check of a password change is rate limited', async () => {
    const srv = await startTestServer({ authRateLimit: 3 });
    try {
      const { client } = await signup(srv.base, 'victime@oriel.test', 'Victor');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await client.post('/me/password', { currentPassword: `essai-${i}`, newPassword: 'nouveau-mot-de-passe' })).status);
      }
      assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
    } finally {
      await srv.stop();
    }
  });
});

describe('security: sessions and CSRF', () => {
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

  test('login issues a fresh session token (no fixation) and logout invalidates it server-side', async () => {
    const c = new Client(srv.base);
    c.cookie = 'jeton-choisi-par-l-attaquant';
    expectOk(await c.post<SessionResponse>('/auth/login', { email: 'admin@oriel.test', password: 'motdepasse-solide' }));
    assert.notEqual(c.cookie, 'jeton-choisi-par-l-attaquant');
    const token = c.cookie;
    expectOk(await c.post('/auth/logout'));
    const replay = new Client(srv.base);
    replay.cookie = token;
    assert.equal((await replay.get('/auth/me')).status, 401);
  });

  test('cross-site and non-JSON mutations are refused, including on percent-encoded API paths', async () => {
    const cookie = `oriel_session=${admin.cookie}`;
    const body = JSON.stringify({ name: 'Piraté' });
    // Foreign origin, "null" origin, form content types.
    for (const headers of <Array<Record<string, string>>>[
      { origin: 'https://evil.example', 'content-type': 'application/json' },
      { origin: 'null', 'content-type': 'application/json' },
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      const res = await rawRequest(srv.base, 'PATCH', `/api/workspaces/${wid}`, { cookie, ...headers }, body);
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    // An encoded "/api" prefix must not route to an API handler with the session but without the CSRF checks.
    const encoded = await rawRequest(srv.base, 'PATCH', `/%61pi/workspaces/${wid}`, { cookie, 'content-type': 'text/plain' }, body);
    assert.equal(encoded.status, 403);
    const encodedCrossSite = await rawRequest(
      srv.base,
      'PATCH',
      `/%61pi/workspaces/${wid}`,
      { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body,
    );
    assert.equal(encodedCrossSite.status, 403);
    const ws = expectOk(await admin.get(`/workspaces/${wid}`));
    assert.notEqual(ws.name, 'Piraté');
  });

  test('security headers on the SPA and the API', async () => {
    const spa = await fetch(`${srv.base}/une/route`);
    const csp = spa.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(spa.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(spa.headers.get('x-content-type-options'), 'nosniff');
    const api = await fetch(`${srv.base}/api/auth/me`);
    assert.equal(api.headers.get('cache-control'), 'no-store');
  });
});

describe('security: input handling', () => {
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

  test('__proto__ / constructor keys in JSON bodies do not pollute prototypes', async () => {
    const db = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, kind: 'database' }));
    const view = expectOk(await admin.get<{ views: Array<{ id: string }> }>(`/databases/${db.id}`)).views[0]!;
    const payloads = [
      `{"properties":{"__proto__":{"polluted":"yes"}}}`,
      `{"title":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}`,
    ];
    for (const body of payloads) await admin.req('POST', `/databases/${db.id}/rows`, undefined, { rawBody: body, contentType: 'application/json' });
    await admin.req('PATCH', `/views/${view.id}`, undefined, {
      rawBody: `{"config":{"propertyWidths":{"__proto__":{"polluted":1}},"calculations":{"constructor":"sum"}}}`,
      contentType: 'application/json',
    });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  test('file property values only accept upload or http(s) URLs', async () => {
    const db = expectOk(await admin.post<{ id: string }>(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, kind: 'database' }));
    const schema = expectOk(await admin.post<{ properties: Array<{ id: string; type: string }> }>(`/databases/${db.id}/properties`, { property: { type: 'files' } }));
    const prop = schema.properties.find((p) => p.type === 'files')!.id;
    for (const url of ['javascript:alert(document.domain)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const res = await admin.post(`/databases/${db.id}/rows`, { properties: { [prop]: [{ name: 'x', url }] } });
      assert.equal(res.status, 400, url);
    }
    for (const url of ['/api/files/0123456789abcdef0123456789abcdef/a.png', 'https://example.com/a.pdf']) {
      expectOk(await admin.post(`/databases/${db.id}/rows`, { properties: { [prop]: [{ name: 'x', url }] } }));
    }
  });

  test('FTS5 syntax in search queries is neutralized', async () => {
    for (const q of ['"', 'title:secret', 'a OR b NOT c', 'NEAR(a b, 1)', '*', '^début', 'body:*', "x' OR 1=1 --"]) {
      const res = await admin.get(`/workspaces/${wid}/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
    }
  });

  test('deeply nested JSON is rejected without crashing the server', async () => {
    const depth = 500_000;
    const body = `{"properties":{"x":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    const res = await admin.req('PATCH', `/workspaces/${wid}`, undefined, { rawBody: body, contentType: 'application/json' });
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    expectOk(await admin.get('/auth/me'));
  });

  test('oversized bodies are refused', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(3 * 1024 * 1024) });
    // The server answers 413 as soon as Content-Length exceeds the limit and may reset the
    // connection before the client finished uploading: both outcomes are a refusal.
    let status: number | 'reset';
    try {
      status = (await admin.req('POST', `/workspaces/${wid}/pages`, undefined, { rawBody: big, contentType: 'application/json' })).status;
    } catch {
      status = 'reset';
    }
    assert.ok(status === 413 || status === 'reset', String(status));
    expectOk(await admin.get('/auth/me'));
  });
});

describe('security: invites', () => {
  let srv: TestServer;
  let owner: Client;
  let wid: string;

  before(async () => {
    srv = await startTestServer();
    ({ admin: owner, wid } = await setupAdmin(srv.base));
  });
  after(async () => {
    await srv.stop();
  });

  const inviteInfo = async (token: string) => expectOk(await new Client(srv.base).get<InviteInfoResponse>(`/invites/${token}`));

  test('invites cannot grant the owner role', async () => {
    const { client: adm } = await addMember(owner, wid, 'adm0@oriel.test', 'Adam', 'admin');
    assert.equal((await adm.post(`/workspaces/${wid}/invites`, { role: 'owner' })).status, 400);
  });

  test('invite links created by an admin stop working once that admin is removed', async () => {
    const { client: adm, user } = await addMember(owner, wid, 'adm1@oriel.test', 'Ada', 'admin');
    const backdoor = expectOk(await adm.post<Invite>(`/workspaces/${wid}/invites`, { role: 'admin', expiresInDays: 365 }));
    expectOk(await owner.del(`/workspaces/${wid}/members/${user.id}`));
    assert.equal((await inviteInfo(backdoor.token)).valid, false);
    const res = await new Client(srv.base).post('/auth/signup', {
      email: 'adm1-bis@oriel.test',
      name: 'Ada bis',
      password: 'motdepasse-solide',
      inviteToken: backdoor.token,
    });
    assert.notEqual(res.status, 200, 'a removed admin must not rejoin through their own invite link');
  });

  test('invite links created by an admin stop working once that admin is demoted', async () => {
    const { client: adm, user } = await addMember(owner, wid, 'adm2@oriel.test', 'Adèle', 'admin');
    const link = expectOk(await adm.post<Invite>(`/workspaces/${wid}/invites`, { role: 'member' }));
    expectOk(await owner.patch(`/workspaces/${wid}/members/${user.id}`, { role: 'member' }));
    assert.equal((await inviteInfo(link.token)).valid, false);
    // Invites of the remaining managers are untouched.
    const ownerLink = expectOk(await owner.post<Invite>(`/workspaces/${wid}/invites`, { role: 'viewer' }));
    assert.equal((await inviteInfo(ownerLink.token)).valid, true);
  });
});

describe('security: uploads', () => {
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

  async function upload(name: string, type: string, content: string): Promise<UploadedFile> {
    const form = new FormData();
    form.append('file', new Blob([content], { type }), name);
    const res = await fetch(`${srv.base}/api/workspaces/${wid}/files`, { method: 'POST', headers: { cookie: `oriel_session=${admin.cookie}` }, body: form });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as UploadedFile;
  }

  test('path traversal and header injection in file names are neutralized', async () => {
    const f = await upload('../../etc/passwd\r\nSet-Cookie: x=1".html', 'text/html', '<script>alert(1)</script>');
    assert.ok(!f.name.includes('/') && !f.name.includes('\r') && !f.name.includes('\n') && !f.name.includes('"'));
    const res = await fetch(`${srv.base}${f.url}`);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('active content declared with an image-like or odd MIME type is never rendered inline as a document', async () => {
    for (const type of ['image/svg+xml', 'IMAGE/SVG+XML', 'application/xhtml+xml', 'text/xml', 'text/html; charset=utf-8']) {
      const f = await upload('x', type, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const res = await fetch(`${srv.base}${f.url}`);
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/, type);
      assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/, type);
    }
    // Inline images still get the sandboxing CSP.
    const png = await upload('a.png', 'image/png', 'not really a png');
    const res = await fetch(`${srv.base}${png.url}`);
    assert.match(res.headers.get('content-disposition') ?? '', /^inline;/);
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  test('invalid file ids cannot escape the uploads directory', async () => {
    for (const path of ['/api/files/..%2f..%2foriel.db/x', '/api/files/../oriel.db/x', '/api/files/%2e%2e/x']) {
      const res = await rawRequest(srv.base, 'GET', path, {});
      assert.ok([400, 403, 404].includes(res.status), `${path} → ${res.status}`);
      assert.doesNotMatch(res.body, /SQLite format/);
    }
  });
});
