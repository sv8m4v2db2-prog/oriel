// QA (security audit, wave G, review B — account security, G9 A05–A08). Complements
// qa-account-security.test.ts and qa-account-sso.test.ts: each QA-G9-xx test first reproduced the
// suspected flaw on the code under review, and stays as a non-regression test after the fix.
// In-process server only (127.0.0.1, throwaway DATA_DIR); the OIDC provider is a local fake (jose);
// session ages are changed directly in the database file.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { REAUTH_WINDOW_MS } from '@oriel/shared';
import { addMember, Client, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { domainTestHooks, resetDomainCache } from '../src/auth/domains.js';
import { resetOidcCaches } from '../src/auth/oidc.js';
import { totpCode, TOTP_PERIOD_S } from '../src/auth/totp.js';

const CLIENT_ID = 'oriel-qa-g';
const CLIENT_SECRET = 'secret-de-test-qa-g';
const PASSWORD = 'motdepasse-solide';

/** Avoids a step boundary between computing a code and the server checking it. */
async function safeStep() {
  const into = (Date.now() / 1000) % TOTP_PERIOD_S;
  if (into > TOTP_PERIOD_S - 3) await new Promise((r) => setTimeout(r, (TOTP_PERIOD_S - into + 0.2) * 1000));
}
const codeAt = (secret: string, stepOffset: number) => totpCode(secret, Date.now() + stepOffset * TOTP_PERIOD_S * 1000);

describe('qa-g-accounts', () => {
  let idp: http.Server;
  let issuer: string;
  let t: TestServer;
  let sql: DatabaseSync;
  let admin: Client;
  let wid: string;
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; challenge: string }>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: JWK;
  const dns: Record<string, string[][]> = {};

  const age = (c: Client) => {
    const hash = createHash('sha256').update(c.cookie!).digest('hex');
    sql.prepare('UPDATE sessions SET auth_at = ? WHERE id = ?').run(Date.now() - REAUTH_WINDOW_MS - 1000, hash);
  };
  const login = async (email: string, password = PASSWORD) => {
    const c = new Client(t.base);
    return { c, res: await c.post('/auth/login', { email, password }) };
  };
  const enrolTotp = async (c: Client) => {
    await safeStep();
    const setup = expectOk(await c.post('/me/security/totp/setup', {}));
    const confirm = expectOk(await c.post('/me/security/totp/confirm', { code: codeAt(setup.secret, -1) }));
    return { secret: setup.secret as string, recovery: confirm.recoveryCodes as string[] };
  };

  /** Starts an OIDC flow (optionally from a session); returns the provider parameters and binding cookie. */
  const start = async (c: Client | null, body: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (c?.cookie) headers.cookie = `oriel_session=${c.cookie}`;
    const res = await fetch(`${t.base}/api/auth/oidc/start`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = (await res.json()) as { url?: string };
    if (!json.url) return { status: res.status, params: null as unknown as URLSearchParams, binding: '' };
    const binding = /oriel_oidc=([^;]+)/.exec(res.headers.getSetCookie().join('\n'))![1]!;
    return { status: res.status, params: new URL(json.url).searchParams, binding };
  };
  /** The provider sends the browser back with a code carrying `claims`. */
  const callback = async (flow: Awaited<ReturnType<typeof start>>, claims: Record<string, unknown>, session?: string | null) => {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { claims, nonce: flow.params.get('nonce')!, challenge: flow.params.get('code_challenge')! });
    const cookies = [`oriel_oidc=${flow.binding}`];
    if (session) cookies.push(`oriel_session=${session}`);
    const q = new URLSearchParams({ code, state: flow.params.get('state')! });
    const res = await fetch(`${t.base}/api/auth/oidc/callback?${q}`, { redirect: 'manual', headers: { cookie: cookies.join('; ') } });
    const set = res.headers.getSetCookie().join('\n');
    return { location: res.headers.get('location') ?? '', session: /oriel_session=([^;]+)/.exec(set)?.[1] ?? null };
  };

  before(async () => {
    keys = await generateKeyPair('RS256');
    jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    idp = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? '/', issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          const form = new URLSearchParams(raw);
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          if (!entry) return send(400, { error: 'invalid_grant' });
          if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) return send(400, { error: 'invalid_grant' });
          const now = Math.floor(Date.now() / 1000);
          const token = await new SignJWT({ nonce: entry.nonce, ...entry.claims })
            .setIssuedAt(now)
            .setExpirationTime(now + 300)
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .sign(keys.privateKey);
          send(200, { access_token: 'x', token_type: 'Bearer', id_token: token });
        });
        return;
      }
      send(404, {});
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_CLIENT_ID = CLIENT_ID;
    process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
    resetOidcCaches();
    domainTestHooks.resolveTxt = async (name) => dns[name] ?? [];
    t = await startTestServer({ publicUrl: 'https://oriel.test' });
    sql = new DatabaseSync(path.join(t.dataDir, 'oriel.db'));
    sql.exec('PRAGMA busy_timeout = 5000');
    const s = await setupAdmin(t.base);
    admin = s.admin;
    wid = s.wid;
  });

  after(async () => {
    sql.close();
    await t.stop();
    idp.close();
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete domainTestHooks.resolveTxt;
    resetDomainCache();
  });

  test('QA-G9-01: an instance admin creating a password reset link (account takeover) confirms their identity', async () => {
    const { user } = await addMember(admin, wid, 'g01@oriel.test', 'G01', 'member');
    // A stolen, old admin session must not hand out a reset link for another account.
    age(admin);
    const r = await admin.post(`/admin/users/${user.id}/password-reset`, {});
    assert.equal(r.status, 403, 'reset link created without a recent authentication');
    assert.equal(r.body.error.code, 'reauth_required');
    expectOk(await admin.post('/auth/reauth', { password: PASSWORD }));
    assert.ok(expectOk(await admin.post(`/admin/users/${user.id}/password-reset`, {})).url);
  });

  test('QA-G9-02: a single sign-on never replaces the second factor to confirm an identity', async () => {
    const { client: c } = await addMember(admin, wid, 'g02@oriel.test', 'G02', 'member');
    // Linked identity (fresh session), then the authenticator app.
    const link = await start(c, { mode: 'link', next: '/' });
    assert.match((await callback(link, { sub: 'g02-sub' }, c.cookie)).location, /sso=linked/);
    // A re-authentication flow opened before the second factor existed.
    const early = await start(c, { mode: 'reauth', next: '/' });
    assert.equal(early.status, 200);
    await enrolTotp(c);
    age(c);
    // Same rule as for the password: the protected account confirms with its second factor.
    assert.deepEqual(expectOk(await c.get('/auth/reauth')).methods, ['totp']);
    assert.equal((await start(c, { mode: 'reauth', next: '/' })).status, 400, 'SSO re-authentication offered to a protected account');
    await callback(early, { sub: 'g02-sub', auth_time: Math.floor(Date.now() / 1000) }, c.cookie);
    assert.equal(expectOk(await c.get('/auth/reauth')).reauthUntil, null, 'SSO re-authentication accepted for a protected account');
    assert.equal((await c.post('/me/tokens', { name: 'x', scope: 'read' })).status, 403);
  });

  test('QA-G9-03: an SSO re-authentication must be a fresh sign-in at the provider (auth_time)', async () => {
    const { client: c } = await addMember(admin, wid, 'g03@oriel.test', 'G03', 'member');
    const link = await start(c, { mode: 'link', next: '/' });
    assert.match((await callback(link, { sub: 'g03-sub' }, c.cookie)).location, /sso=linked/);
    age(c);
    const now = Math.floor(Date.now() / 1000);
    // The provider reused its session silently (no auth_time, or an old one): not a confirmation.
    for (const claims of [{ sub: 'g03-sub' }, { sub: 'g03-sub', auth_time: now - 3600 }, { sub: 'g03-sub', auth_time: 'x' }]) {
      const flow = await start(c, { mode: 'reauth', next: '/w' });
      const r = await callback(flow, claims, c.cookie);
      assert.match(r.location, /sso_error=/, JSON.stringify(claims));
      assert.equal(expectOk(await c.get('/auth/reauth')).reauthUntil, null, `re-authenticated with ${JSON.stringify(claims)}`);
    }
    // Only the identity linked to this account.
    const wrong = await start(c, { mode: 'reauth', next: '/w' });
    assert.match((await callback(wrong, { sub: 'someone-else', auth_time: now }, c.cookie)).location, /sso_error=mismatch/);
    const flow = await start(c, { mode: 'reauth', next: '/w' });
    assert.equal(flow.params.get('prompt'), 'login');
    assert.equal(flow.params.get('max_age'), '0');
    assert.equal((await callback(flow, { sub: 'g03-sub', auth_time: now }, c.cookie)).location, '/w');
    assert.ok(expectOk(await c.get('/auth/reauth')).reauthUntil);
  });

  test('QA-G9-04: removing a member of a verified domain sticks (no re-join at the next SSO sign-in)', async () => {
    const d = expectOk(await admin.post(`/workspaces/${wid}/domains`, { domain: 'g04.test' }));
    dns['_oriel.g04.test'] = [[d.record.value]];
    expectOk(await admin.post(`/workspaces/${wid}/domains/g04.test/verify`, {}));
    expectOk(await admin.patch(`/workspaces/${wid}/domains/g04.test`, { autoJoin: true, joinRole: 'member' }));
    const claims = { sub: 'g04-sub', email: 'nina@g04.test', email_verified: true, name: 'Nina' };
    const first = await callback(await start(null), claims);
    assert.ok(first.session, first.location);
    const nina = new Client(t.base);
    nina.cookie = first.session;
    const ninaId = expectOk(await nina.get('/auth/me')).user.id as string;
    assert.ok(expectOk(await nina.get('/auth/me')).workspaces.some((w: { id: string }) => w.id === wid));
    // The admin removes her; she signs in again with the provider.
    expectOk(await admin.del(`/workspaces/${wid}/members/${ninaId}`));
    const again = await callback(await start(null), claims);
    assert.ok(again.session);
    const back = new Client(t.base);
    back.cookie = again.session;
    assert.ok(!expectOk(await back.get('/auth/me')).workspaces.some((w: { id: string }) => w.id === wid), 'removed member re-joined automatically');
    // A new address of the domain still joins.
    const other = await callback(await start(null), { sub: 'g04-sub-2', email: 'olga@g04.test', email_verified: true });
    const olga = new Client(t.base);
    olga.cookie = other.session;
    assert.ok(expectOk(await olga.get('/auth/me')).workspaces.some((w: { id: string }) => w.id === wid));
  });

  test('QA-G9-05: changing the e-mail address voids the reset links sent to the previous one', async () => {
    const { client: c, user } = await addMember(admin, wid, 'g05@oriel.test', 'G05', 'member');
    expectOk(await admin.post('/auth/reauth', { password: PASSWORD }));
    // A link reached the old mailbox (an admin link here; « mot de passe oublié » works the same way).
    const link = expectOk(await admin.post(`/admin/users/${user.id}/password-reset`, {}));
    const token = link.url.split('/').pop();
    assert.equal(expectOk(await new Client(t.base).get(`/auth/password/reset/${token}`)).valid, true);
    expectOk(await c.post('/me/email', { email: 'g05-new@oriel.test' }));
    assert.equal(expectOk(await new Client(t.base).get(`/auth/password/reset/${token}`)).valid, false, 'old mailbox can still reset the password');
    assert.equal((await new Client(t.base).post('/auth/password/reset', { token, password: 'pris-par-l-ancienne-boite' })).status, 400);
  });

  test('QA-G9-06: a reset link of a protected account changes nothing before the second step', async () => {
    const { client: c, user } = await addMember(admin, wid, 'g06@oriel.test', 'G06', 'member');
    const tok = expectOk(await c.post('/me/tokens', { name: 'mcp', scope: 'read' }));
    const { secret } = await enrolTotp(c);
    expectOk(await admin.post('/auth/reauth', { password: PASSWORD }));
    const token = expectOk(await admin.post(`/admin/users/${user.id}/password-reset`, {})).url.split('/').pop();
    // Someone who only has the mailbox: no session, and the account is left as it was.
    const anon = new Client(t.base);
    const res = expectOk(await anon.post('/auth/password/reset', { token, password: 'nouveau-mot-de-passe' }));
    assert.ok(res.mfa?.ticket);
    assert.equal(anon.cookie, null);
    assert.equal((await c.get('/auth/me')).status, 200, 'sessions closed before the second step');
    const bearer = await fetch(`${t.base}/api/me/current-token`, { headers: { authorization: `Bearer ${tok.token}` } });
    assert.equal(bearer.status, 200, 'API tokens revoked before the second step');
    assert.ok((await login('g06@oriel.test')).res.body.mfa, 'password replaced before the second step');
    // The link is single use, even when the second step is not completed.
    assert.equal((await new Client(t.base).post('/auth/password/reset', { token, password: 'encore-un-autre' })).status, 400);
    // The person with the second factor completes it: the new password applies, other sessions close.
    await safeStep();
    expectOk(await anon.post('/auth/login/mfa', { ticket: res.mfa.ticket, code: codeAt(secret, 1) }));
    assert.ok(anon.cookie);
    assert.equal((await c.get('/auth/me')).status, 401);
    assert.equal((await login('g06@oriel.test')).res.status, 401);
    assert.ok((await login('g06@oriel.test', 'nouveau-mot-de-passe')).res.body.mfa);
  });

  test('QA-G9 (écartée): concurrent use of one recovery code or one TOTP code — a single success', async () => {
    const { client: c } = await addMember(admin, wid, 'g07@oriel.test', 'G07', 'member');
    const { secret, recovery } = await enrolTotp(c);
    const tickets = async () => Promise.all([login('g07@oriel.test'), login('g07@oriel.test')]);
    let [a, b] = await tickets();
    let results = await Promise.all([
      a.c.post('/auth/login/mfa', { ticket: a.res.body.mfa.ticket, recoveryCode: recovery[0] }),
      b.c.post('/auth/login/mfa', { ticket: b.res.body.mfa.ticket, recoveryCode: recovery[0] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    [a, b] = await tickets();
    await safeStep();
    const code = codeAt(secret, 0);
    results = await Promise.all([
      a.c.post('/auth/login/mfa', { ticket: a.res.body.mfa.ticket, code }),
      b.c.post('/auth/login/mfa', { ticket: b.res.body.mfa.ticket, code }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  });
});
