// QA (wave G9, A07): OIDC single sign-on against a fake local provider started by the test, and
// verified domains (DNS lookup replaced by a test hook). One test per bypass attempt: login CSRF,
// state replay, nonce / audience / issuer / algorithm / expiry, linking on e-mail, open redirect,
// auto-join with an unverified address, domain claimed twice.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Client, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { domainTestHooks, resetDomainCache } from '../src/auth/domains.js';
import { resetOidcCaches } from '../src/auth/oidc.js';
import { totpCode, TOTP_PERIOD_S } from '../src/auth/totp.js';

const CLIENT_ID = 'oriel-test';
const CLIENT_SECRET = 'secret-de-test-oidc';

interface CodeEntry {
  claims: Record<string, unknown>;
  nonce: string;
  challenge: string;
  redirectUri: string;
  /** Token tweaks to simulate a malicious or broken provider. */
  tweak?: 'aud' | 'iss' | 'nonce' | 'expired' | 'hs256' | 'otherKey';
}

describe('qa-account-sso', () => {
  let idp: http.Server;
  let issuer: string;
  let t: TestServer;
  let admin: Client;
  let wid: string;
  const codes = new Map<string, CodeEntry>();
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let other: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: JWK;
  let dns: Record<string, string[][]> = {};

  before(async () => {
    keys = await generateKeyPair('RS256');
    other = await generateKeyPair('RS256');
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
          const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
          if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}`) return send(401, { error: 'invalid_client' });
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          if (!entry) return send(400, { error: 'invalid_grant' });
          // PKCE: the verifier must match the challenge sent to /authorize.
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return send(400, { error: 'invalid_grant' });
          if (form.get('redirect_uri') !== entry.redirectUri) return send(400, { error: 'invalid_grant' });
          const now = Math.floor(Date.now() / 1000);
          const claims = { nonce: entry.tweak === 'nonce' ? 'autre' : entry.nonce, ...entry.claims };
          let jwt = new SignJWT(claims)
            .setIssuedAt(entry.tweak === 'expired' ? now - 7200 : now)
            .setExpirationTime(entry.tweak === 'expired' ? now - 3600 : now + 300)
            .setIssuer(entry.tweak === 'iss' ? 'https://faux.test' : issuer)
            .setAudience(entry.tweak === 'aud' ? 'autre-client' : CLIENT_ID);
          let token: string;
          if (entry.tweak === 'hs256') token = await jwt.setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new TextEncoder().encode(CLIENT_SECRET));
          else token = await (jwt = jwt.setProtectedHeader({ alg: 'RS256', kid: 'k1' })).sign(entry.tweak === 'otherKey' ? other.privateKey : keys.privateKey);
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
    process.env.OIDC_LABEL = 'Studio SSO';
    resetOidcCaches();
    domainTestHooks.resolveTxt = async (name) => dns[name] ?? [];
    t = await startTestServer({ publicUrl: 'https://oriel.test' });
    const s = await setupAdmin(t.base);
    admin = s.admin;
    wid = s.wid;
  });

  after(async () => {
    await t.stop();
    idp.close();
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_LABEL;
    delete domainTestHooks.resolveTxt;
  });

  /** Starts a flow; returns the provider parameters and the browser-binding cookie. */
  const start = async (c: Client | null, body: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (c?.cookie) headers.cookie = `oriel_session=${c.cookie}`;
    const res = await fetch(`${t.base}/api/auth/oidc/start`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = (await res.json()) as { url?: string; error?: { code: string } };
    if (!json.url) return { status: res.status, error: json.error, params: null as never, binding: '' };
    const binding = /oriel_oidc=([^;]+)/.exec(res.headers.getSetCookie().join('\n'))![1]!;
    return { status: res.status, params: new URL(json.url).searchParams, binding, error: undefined };
  };

  /** The provider redirects back with a code (claims of our choice). */
  const callback = async (
    flow: Awaited<ReturnType<typeof start>>,
    claims: Record<string, unknown>,
    opts: { tweak?: CodeEntry['tweak']; binding?: string | null; session?: string | null; state?: string } = {},
  ) => {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, {
      claims,
      nonce: flow.params.get('nonce')!,
      challenge: flow.params.get('code_challenge')!,
      redirectUri: flow.params.get('redirect_uri')!,
      tweak: opts.tweak,
    });
    const cookies: string[] = [];
    const binding = opts.binding === undefined ? flow.binding : opts.binding;
    if (binding) cookies.push(`oriel_oidc=${binding}`);
    if (opts.session) cookies.push(`oriel_session=${opts.session}`);
    const q = new URLSearchParams({ code, state: opts.state ?? flow.params.get('state')! });
    const res = await fetch(`${t.base}/api/auth/oidc/callback?${q}`, { redirect: 'manual', headers: cookies.length ? { cookie: cookies.join('; ') } : {} });
    const set = res.headers.getSetCookie().join('\n');
    return {
      status: res.status,
      location: res.headers.get('location') ?? '',
      session: /oriel_session=([^;]+)/.exec(set)?.[1] ?? null,
      mfa: /oriel_mfa=([^;]+)/.exec(set)?.[1] ?? null,
    };
  };

  test('configuration, PKCE parameters, signup closed without a verified domain', async () => {
    const cfg = expectOk(await new Client(t.base).get('/auth/config'));
    assert.deepEqual(cfg.sso, { label: 'Studio SSO' });
    const flow = await start(null, { next: '/w/x' });
    assert.equal(flow.params.get('code_challenge_method'), 'S256');
    assert.equal(flow.params.get('redirect_uri'), 'https://oriel.test/api/auth/oidc/callback');
    assert.match(flow.params.get('scope')!, /openid/);
    const r = await callback(flow, { sub: 'u-1', email: 'new@ailleurs.test', email_verified: true });
    assert.equal(r.status, 303);
    assert.match(r.location, /sso_error=signup_closed/);
    assert.equal(r.session, null);
  });

  test('bypass attempts on the callback are refused', async () => {
    const claims = { sub: 'u-2', email: 'x@ailleurs.test', email_verified: true };
    // Login CSRF: callback without (or with another) browser-binding cookie.
    let flow = await start(null);
    assert.match((await callback(flow, claims, { binding: null })).location, /sso_error=expired/);
    flow = await start(null);
    const other = await start(null);
    assert.match((await callback(flow, claims, { binding: other.binding })).location, /sso_error=expired/);
    // State replay.
    flow = await start(null);
    await callback(flow, claims);
    assert.match((await callback(flow, claims)).location, /sso_error=expired/);
    // Forged tokens.
    for (const tweak of ['nonce', 'aud', 'iss', 'expired', 'hs256', 'otherKey'] as const) {
      flow = await start(null);
      const r = await callback(flow, claims, { tweak });
      assert.match(r.location, /sso_error=invalid/, tweak);
      assert.equal(r.session, null, tweak);
    }
    // Unknown state.
    flow = await start(null);
    assert.match((await callback(flow, claims, { state: 'inconnu' })).location, /sso_error=expired/);
  });

  test('never linked on the e-mail alone; explicit linking, then sign-in; open redirect', async () => {
    // An identity carrying the admin's (verified) address does not open the admin's account.
    let flow = await start(null);
    let r = await callback(flow, { sub: 'evil', email: 'admin@oriel.test', email_verified: true });
    assert.match(r.location, /sso_error=link_required/);
    assert.equal(r.session, null);

    // Linking: signed in and re-authenticated, from the same session.
    const flowLink = await start(admin, { mode: 'link', next: '/w/abc/settings/security' });
    assert.equal(flowLink.status, 200);
    const stranger = new Client(t.base);
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    expectOk(await stranger.post('/auth/signup', { email: 'z@oriel.test', name: 'Z', password: 'motdepasse-solide' }));
    r = await callback(flowLink, { sub: 'admin-sub', email: 'alice@idp.test' }, { session: stranger.cookie });
    assert.match(r.location, /sso_error=expired/, 'callback in another session');
    const flowLink2 = await start(admin, { mode: 'link', next: '/w/abc/settings/security' });
    r = await callback(flowLink2, { sub: 'admin-sub', email: 'alice@idp.test' }, { session: admin.cookie });
    assert.equal(r.location, '/w/abc/settings/security?sso=linked');
    // The same identity cannot be linked to a second account.
    const flowLink3 = await start(stranger, { mode: 'link' });
    assert.match((await callback(flowLink3, { sub: 'admin-sub' }, { session: stranger.cookie })).location, /sso_error=already_linked/);
    expectOk(await admin.patch('/admin/settings', { signupMode: 'first-user' }));

    // Sign-in with the linked identity; `next` cannot leave the site.
    flow = await start(null, { next: '//evil.test/x' });
    r = await callback(flow, { sub: 'admin-sub', email: 'alice@idp.test' });
    assert.equal(r.location, '/');
    assert.ok(r.session);
    const me = new Client(t.base);
    me.cookie = r.session;
    assert.equal(expectOk(await me.get('/auth/me')).user.email, 'admin@oriel.test');
    assert.ok(expectOk(await me.get('/me/security')).identities.length === 1);
  });

  test('second factor after the provider; re-authentication by SSO', async () => {
    // The admin (linked above) enables the authenticator app.
    const into = (Date.now() / 1000) % TOTP_PERIOD_S;
    if (into > TOTP_PERIOD_S - 3) await new Promise((res) => setTimeout(res, (TOTP_PERIOD_S - into + 0.2) * 1000));
    const setup = expectOk(await admin.post('/me/security/totp/setup', {}));
    expectOk(await admin.post('/me/security/totp/confirm', { code: totpCode(setup.secret, Date.now() - TOTP_PERIOD_S * 1000) }));
    const flow = await start(null);
    const r = await callback(flow, { sub: 'admin-sub', email: 'alice@idp.test' });
    assert.match(r.location, /^\/login\?mfa=/);
    assert.equal(r.session, null);
    assert.ok(r.mfa);
    const res = await fetch(`${t.base}/api/auth/login/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `oriel_mfa=${r.mfa}` },
      body: JSON.stringify({ code: totpCode(setup.secret) }),
    });
    assert.equal(res.status, 200);
    // Re-authentication through the provider: never for a protected account, which uses its second
    // factor (QA-G9-02; the SSO re-authentication of an unprotected account: qa-g-accounts.test.ts).
    assert.equal((await start(admin, { mode: 'reauth', next: '/w/abc' })).status, 400);
  });

  test('verified domains: DNS proof, one workspace per domain, auto-join with verified addresses only', async () => {
    const add = expectOk(await admin.post(`/workspaces/${wid}/domains`, { domain: 'Studio.Test.' }));
    assert.equal(add.domain, 'studio.test');
    assert.equal(add.record.name, '_oriel.studio.test');
    assert.equal((await admin.post(`/workspaces/${wid}/domains`, { domain: 'http://x' })).status, 400);
    assert.equal((await admin.post(`/workspaces/${wid}/domains`, { domain: '127.0.0.1' })).status, 400);
    // Auto-join needs a verified domain.
    assert.equal((await admin.patch(`/workspaces/${wid}/domains/studio.test`, { autoJoin: true })).status, 400);
    dns['_oriel.studio.test'] = [['oriel-verification=mauvais']];
    assert.equal((await admin.post(`/workspaces/${wid}/domains/studio.test/verify`, {})).status, 400);
    // Cached negative answer for 60 s: a fresh name is used to check the success path.
    const add2 = expectOk(await admin.post(`/workspaces/${wid}/domains`, { domain: 'equipe.test' }));
    dns['_oriel.equipe.test'] = [['autre'], [add2.record.value.slice(0, 10), add2.record.value.slice(10)]];
    const v = expectOk(await admin.post(`/workspaces/${wid}/domains/equipe.test/verify`, {}));
    assert.equal(v.verified, true);
    expectOk(await admin.patch(`/workspaces/${wid}/domains/equipe.test`, { autoJoin: true, joinRole: 'viewer' }));
    assert.equal((await admin.patch(`/workspaces/${wid}/domains/equipe.test`, { joinRole: 'admin' })).status, 400);

    // Another workspace cannot verify the same domain.
    const own = expectOk(await admin.post('/workspaces', { name: 'Autre' }));
    const dup = expectOk(await admin.post(`/workspaces/${own.id}/domains`, { domain: 'equipe.test' }));
    dns['_oriel.equipe.test'] = [[dup.record.value]];
    resetDomainCache();
    assert.equal((await admin.post(`/workspaces/${own.id}/domains/equipe.test/verify`, {})).status, 409);

    // Address not verified by the provider: no account, no auto-join.
    let flow = await start(null);
    let r = await callback(flow, { sub: 'p-1', email: 'paul@equipe.test', email_verified: false });
    assert.match(r.location, /sso_error=signup_closed/);
    // Verified address: account created, joined as viewer, no personal workspace.
    flow = await start(null);
    r = await callback(flow, { sub: 'p-2', email: 'pia@equipe.test', email_verified: true, name: 'Pia' });
    assert.equal(r.location, '/');
    const pia = new Client(t.base);
    pia.cookie = r.session;
    const session = expectOk(await pia.get('/auth/me'));
    assert.deepEqual(session.workspaces.map((w: { id: string; role: string }) => [w.id, w.role]), [[wid, 'viewer']]);
    // No password: the account cannot be opened with an empty or guessed one.
    assert.equal((await new Client(t.base).post('/auth/login', { email: 'pia@equipe.test', password: 'disabled' })).status, 401);
    // Members cannot manage domains; API tokens neither.
    assert.equal((await pia.get(`/workspaces/${wid}/domains`)).status, 403);
  });
});
