// QA (wave G9): two-factor authentication, passkeys, re-authentication of sensitive actions, workspace
// two-factor policy, admin reset and workspace transfer — one test per bypass attempt we could think of.
// TOTP codes are computed from the test secret; passkeys use a software authenticator
// (webauthnFixture.ts); session ages are changed directly in the database file.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { REAUTH_WINDOW_MS } from '@oriel/shared';
import { addMember, Client, expectOk, setupAdmin, startTestServer, type TestServer } from './helpers.js';
import { totpCode, totpStep, TOTP_PERIOD_S } from '../src/auth/totp.js';
import { assertionResponse, newSoftKey, registrationResponse } from './webauthnFixture.js';

const ORIGIN = 'https://oriel.test';
const RP_ID = 'oriel.test';
const PASSWORD = 'motdepasse-solide';

/** Avoids a step boundary between computing a code and the server checking it. */
async function safeStep() {
  const into = (Date.now() / 1000) % TOTP_PERIOD_S;
  if (into > TOTP_PERIOD_S - 3) await new Promise((r) => setTimeout(r, (TOTP_PERIOD_S - into + 0.2) * 1000));
}
const codeAt = (secret: string, stepOffset: number) => totpCode(secret, Date.now() + stepOffset * TOTP_PERIOD_S * 1000);

describe('qa-account-security', () => {
  let t: TestServer;
  let sql: DatabaseSync;
  let admin: Client;
  let wid: string;
  let adminId: string;

  /** The session's last strong authentication becomes older than the window. */
  const age = (c: Client) => {
    const hash = createHash('sha256').update(c.cookie!).digest('hex');
    sql.prepare('UPDATE sessions SET auth_at = ? WHERE id = ?').run(Date.now() - REAUTH_WINDOW_MS - 1000, hash);
  };

  const login = async (email: string, password = PASSWORD) => {
    const c = new Client(t.base);
    const res = await c.post('/auth/login', { email, password });
    return { c, res };
  };

  /** Enrols the authenticator app for a fresh session; returns the secret and the recovery codes. */
  const enrolTotp = async (c: Client) => {
    await safeStep();
    const setup = expectOk(await c.post('/me/security/totp/setup', {}));
    const confirm = expectOk(await c.post('/me/security/totp/confirm', { code: codeAt(setup.secret, -1) }));
    return { secret: setup.secret as string, recovery: confirm.recoveryCodes as string[] };
  };

  before(async () => {
    t = await startTestServer({ publicUrl: ORIGIN });
    sql = new DatabaseSync(path.join(t.dataDir, 'oriel.db'));
    sql.exec('PRAGMA busy_timeout = 5000');
    const s = await setupAdmin(t.base);
    admin = s.admin;
    wid = s.wid;
    adminId = s.session.user.id;
  });
  after(async () => {
    sql.close();
    await t.stop();
  });

  test('A05: authenticator app enrolment, encryption at rest, second step at login', async () => {
    const { client: bob, user } = await addMember(admin, wid, 'bob@oriel.test', 'Bob', 'member');
    // Enrolment needs a recent authentication.
    age(bob);
    const refused = await bob.post('/me/security/totp/setup', {});
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'reauth_required');
    const methods = expectOk(await bob.get('/auth/reauth'));
    assert.deepEqual(methods.methods, ['password']);
    assert.equal((await bob.post('/auth/reauth', { password: 'faux' })).status, 400);
    expectOk(await bob.post('/auth/reauth', { password: PASSWORD }));

    await safeStep();
    const setup = expectOk(await bob.post('/me/security/totp/setup', {}));
    assert.match(setup.uri, /^otpauth:\/\/totp\/.+secret=/);
    assert.equal((await bob.post('/me/security/totp/confirm', { code: '000000' })).status, 400);
    // Pending secret: no second step yet.
    const before2fa = await login('bob@oriel.test');
    assert.ok(before2fa.res.body.user, 'no second step before confirmation');
    const confirm = expectOk(await bob.post('/me/security/totp/confirm', { code: codeAt(setup.secret, -1) }));
    assert.equal(confirm.recoveryCodes.length, 10);

    // Encrypted at rest, key file 0600.
    const row = sql.prepare('SELECT secret_enc FROM auth_totp WHERE user_id = ?').get(user.id) as { secret_enc: string };
    assert.ok(!row.secret_enc.includes(setup.secret));
    assert.match(row.secret_enc, /^v1\./);
    assert.equal(statSync(path.join(t.dataDir, 'secret.key')).mode & 0o777, 0o600);
    // Recovery codes stored hashed.
    const hashes = sql.prepare('SELECT code_hash FROM auth_recovery_codes WHERE user_id = ?').all(user.id) as Array<{ code_hash: string }>;
    assert.equal(hashes.length, 10);
    assert.ok(hashes.every((h) => !confirm.recoveryCodes.includes(h.code_hash)));

    // Password alone: a challenge, no session.
    const { c, res } = await login('bob@oriel.test');
    assert.ok(res.body.mfa?.ticket);
    assert.deepEqual(res.body.mfa.methods, ['totp', 'recovery']);
    assert.equal(c.cookie, null);
    assert.equal((await c.get('/auth/me')).status, 401);
    // The code used for the confirmation cannot be replayed, nor an older one.
    assert.equal((await c.post('/auth/login/mfa', { ticket: res.body.mfa.ticket, code: codeAt(setup.secret, -1) })).status, 400);
    const ok = expectOk(await c.post('/auth/login/mfa', { ticket: res.body.mfa.ticket, code: codeAt(setup.secret, 0) }));
    assert.equal(ok.user.id, user.id);
    assert.ok(c.cookie);
    // The ticket is single use.
    assert.equal((await new Client(t.base).post('/auth/login/mfa', { ticket: res.body.mfa.ticket, code: codeAt(setup.secret, 1) })).status, 400);
    // Same code again on a new login: refused (replay).
    const again = await login('bob@oriel.test');
    assert.equal((await again.c.post('/auth/login/mfa', { ticket: again.res.body.mfa.ticket, code: codeAt(setup.secret, 0) })).status, 400);

    // Recovery code: once.
    const r1 = await login('bob@oriel.test');
    expectOk(await r1.c.post('/auth/login/mfa', { ticket: r1.res.body.mfa.ticket, recoveryCode: confirm.recoveryCodes[0].toLowerCase() }));
    const r2 = await login('bob@oriel.test');
    assert.equal((await r2.c.post('/auth/login/mfa', { ticket: r2.res.body.mfa.ticket, recoveryCode: confirm.recoveryCodes[0] })).status, 400);
    assert.equal(expectOk(await r1.c.get('/me/security')).recoveryCodesRemaining, 9);


    // Re-authentication: the password alone no longer confirms the identity of a protected account.
    const s = r1.c;
    age(s);
    assert.deepEqual(expectOk(await s.get('/auth/reauth')).methods, ['totp']);
    assert.equal((await s.post('/auth/reauth', { password: PASSWORD })).status, 400);

    // Per-account limit: 10 second-factor checks per 5 minutes, whatever the ticket.
    let limited = false;
    for (let i = 0; i < 6 && !limited; i++) {
      const x = await login('bob@oriel.test');
      limited = (await x.c.post('/auth/login/mfa', { ticket: x.res.body.mfa.ticket, code: '123456' })).status === 429;
    }
    assert.ok(limited, 'per-account rate limit');
  });

  test('A05: a password reset link never skips the second step', async () => {
    const { client: carol } = await addMember(admin, wid, 'carol@oriel.test', 'Carol', 'member');
    const { secret } = await enrolTotp(carol);
    const uid = expectOk(await carol.get('/auth/me')).user.id;
    const link = expectOk(await admin.post(`/admin/users/${uid}/password-reset`, {}));
    const token = link.url.split('/').pop();
    const anon = new Client(t.base);
    const res = expectOk(await anon.post('/auth/password/reset', { token, password: 'nouveau-mot-de-passe' }));
    assert.ok(res.mfa?.ticket);
    assert.equal(anon.cookie, null);
    assert.equal((await anon.get('/auth/me')).status, 401);
    // Brute force: the pending login dies after 5 wrong answers, even with the right code afterwards.
    for (let i = 0; i < 5; i++) assert.equal((await anon.post('/auth/login/mfa', { ticket: res.mfa.ticket, code: '123456' })).status, 400);
    await safeStep();
    assert.equal((await anon.post('/auth/login/mfa', { ticket: res.mfa.ticket, code: codeAt(secret, 1) })).status, 400);
    assert.equal(anon.cookie, null);
  });

  test('A06: sensitive actions require a recent authentication (server side)', async () => {
    const { client: dan, user } = await addMember(admin, wid, 'dan@oriel.test', 'Dan', 'member');
    // Fresh login: allowed.
    const tok = expectOk(await dan.post('/me/tokens', { name: 'cli', scope: 'read' }));
    age(dan);
    let r = await dan.post('/me/tokens', { name: 'cli2', scope: 'read' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'reauth_required');
    r = await dan.del(`/me/tokens/${tok.id}`);
    assert.equal(r.body.error?.code, 'reauth_required');
    r = await dan.req('DELETE', `/me/tokens/${encodeURIComponent(tok.id)}`.replace('/me/', '/%6De/'));
    assert.equal(r.status, 403, 'percent-encoded path');
    r = await dan.post('/me/email', { email: 'dan2@oriel.test' });
    assert.equal(r.body.error?.code, 'reauth_required');

    // Workspace deletion and promotions (routes of another module).
    const own = expectOk(await dan.post('/workspaces', { name: 'Perso' }));
    assert.equal((await dan.del(`/workspaces/${own.id}`)).body.error?.code, 'reauth_required');
    age(admin);
    assert.equal((await admin.patch(`/workspaces/${wid}/members/${user.id}`, { role: 'admin' })).body.error?.code, 'reauth_required');
    assert.equal((await admin.post(`/workspaces/${wid}/invites`, { role: 'admin' })).body.error?.code, 'reauth_required');
    // Not sensitive: demotion, member invitation.
    expectOk(await admin.patch(`/workspaces/${wid}/members/${user.id}`, { role: 'viewer' }));
    expectOk(await admin.post(`/workspaces/${wid}/invites`, { role: 'member' }));
    expectOk(await admin.post('/auth/reauth', { password: PASSWORD }));
    expectOk(await admin.patch(`/workspaces/${wid}/members/${user.id}`, { role: 'member' }));

    // After re-authentication.
    expectOk(await dan.post('/auth/reauth', { password: PASSWORD }));
    expectOk(await dan.del(`/me/tokens/${tok.id}`));
    expectOk(await dan.post('/me/email', { email: 'dan2@oriel.test' }));
    assert.equal((await dan.post('/me/email', { email: 'admin@oriel.test' })).status, 409);
    expectOk(await dan.del(`/workspaces/${own.id}`));
    assert.ok(expectOk(await dan.get('/me/security/log')).entries.some((e: { event: string }) => e.event === 'email_changed'));

    // API tokens: no account security, no re-authentication.
    const w = expectOk(await dan.post('/me/tokens', { name: 'w', scope: 'write' }));
    const bearer = async (method: string, url: string, body?: unknown) =>
      fetch(`${t.base}/api${url}`, {
        method,
        headers: { authorization: `Bearer ${w.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    for (const [m, u, b] of [
      ['GET', '/me/security'],
      ['POST', '/me/security/totp/setup', {}],
      ['POST', '/auth/reauth', { password: PASSWORD }],
      ['GET', '/auth/reauth'],
      ['POST', '/me/email', { email: 'x@oriel.test' }],
      ['GET', '/me/transfers'],
      ['GET', `/workspaces/${wid}/security`],
    ] as Array<[string, string, unknown?]>) {
      assert.equal((await bearer(m, u, b)).status, 403, `${m} ${u}`);
    }
  });

  test('A05: passkeys — registration, sign-in without password, second step, replays', async () => {
    const { client: eve, user } = await addMember(admin, wid, 'eve@oriel.test', 'Eve', 'member');
    const key = newSoftKey();
    const opts = expectOk(await eve.post('/me/security/passkeys/options', {}));
    assert.equal(opts.options.rp.id, RP_ID);
    // Wrong origin (phishing proxy): refused.
    const bad = registrationResponse(key, { challenge: opts.options.challenge, origin: 'https://evil.test', rpId: RP_ID });
    assert.equal((await eve.post('/me/security/passkeys', { ticket: opts.ticket, response: bad, name: 'x' })).status, 400);
    // The ticket was consumed by the failed attempt.
    const good = registrationResponse(key, { challenge: opts.options.challenge, origin: ORIGIN, rpId: RP_ID });
    assert.equal((await eve.post('/me/security/passkeys', { ticket: opts.ticket, response: good, name: 'x' })).status, 400);
    const opts2 = expectOk(await eve.post('/me/security/passkeys/options', {}));
    const reg = registrationResponse(key, { challenge: opts2.options.challenge, origin: ORIGIN, rpId: RP_ID });
    expectOk(await eve.post('/me/security/passkeys', { ticket: opts2.ticket, response: reg, name: 'Mac <b>' }));
    const status = expectOk(await eve.get('/me/security'));
    assert.equal(status.passkeys.length, 1);
    // Another account cannot register the same credential.
    const { client: fay } = await addMember(admin, wid, 'fay@oriel.test', 'Fay', 'member');
    const o3 = expectOk(await fay.post('/me/security/passkeys/options', {}));
    assert.equal((await fay.post('/me/security/passkeys', { ticket: o3.ticket, response: registrationResponse(key, { challenge: o3.options.challenge, origin: ORIGIN, rpId: RP_ID }) })).status, 409);

    // Sign-in without password: user verification required.
    const anon = new Client(t.base);
    let o = expectOk(await anon.post('/auth/passkey/options', {}));
    let a = assertionResponse(key, { challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID, uv: false, userHandle: user.id });
    assert.equal((await anon.post('/auth/passkey/login', { ticket: o.ticket, response: a })).status, 401);
    o = expectOk(await anon.post('/auth/passkey/options', {}));
    // Wrong user handle (another account's id): refused.
    a = assertionResponse(key, { challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID, userHandle: adminId });
    assert.equal((await anon.post('/auth/passkey/login', { ticket: o.ticket, response: a })).status, 401);
    o = expectOk(await anon.post('/auth/passkey/options', {}));
    a = assertionResponse(key, { challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID, userHandle: user.id });
    assert.equal(expectOk(await anon.post('/auth/passkey/login', { ticket: o.ticket, response: a })).user.id, user.id);
    // Replay of the same assertion: the ticket is gone.
    assert.equal((await new Client(t.base).post('/auth/passkey/login', { ticket: o.ticket, response: a })).status, 401);
    // Counter regression (cloned authenticator): refused.
    o = expectOk(await anon.post('/auth/passkey/options', {}));
    a = assertionResponse(key, { challenge: o.options.challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 });
    assert.equal((await anon.post('/auth/passkey/login', { ticket: o.ticket, response: a })).status, 401);
    key.counter = 10;

    // Second step after the password.
    const { c, res } = await login('eve@oriel.test');
    assert.deepEqual(res.body.mfa.methods, ['passkey']);
    const po = expectOk(await c.post('/auth/login/mfa/passkey-options', { ticket: res.body.mfa.ticket }));
    assert.equal(po.options.allowCredentials.length, 1);
    a = assertionResponse(key, { challenge: po.options.challenge, origin: ORIGIN, rpId: RP_ID, uv: false });
    expectOk(await c.post('/auth/login/mfa', { ticket: res.body.mfa.ticket, passkey: a }));

    // Re-authentication with the passkey, bound to the session.
    age(c);
    const ro = expectOk(await c.post('/auth/reauth/passkey-options', {}));
    a = assertionResponse(key, { challenge: ro.options.challenge, origin: ORIGIN, rpId: RP_ID });
    assert.equal((await eve.post('/auth/reauth', { ticket: ro.ticket, passkey: a })).status, 400, 'ticket of another session');
    const ro2 = expectOk(await c.post('/auth/reauth/passkey-options', {}));
    a = assertionResponse(key, { challenge: ro2.options.challenge, origin: ORIGIN, rpId: RP_ID });
    expectOk(await c.post('/auth/reauth', { ticket: ro2.ticket, passkey: a }));
    // Removal of the only method while no workspace requires it: allowed.
    expectOk(await c.del(`/me/security/passkeys/${status.passkeys[0].id}`));
  });

  test('A05: workspace policy, enrolment gate, admin reset', async () => {
    const { client: gus, user } = await addMember(admin, wid, 'gus@oriel.test', 'Gus', 'member');
    // The admin must be protected to impose it.
    assert.equal((await admin.put(`/workspaces/${wid}/security`, { require2fa: true, graceDays: 0 })).status, 400);
    const adminFresh = (await login('admin@oriel.test')).c;
    await enrolTotp(adminFresh);
    // Members cannot change the policy.
    assert.equal((await gus.put(`/workspaces/${wid}/security`, { require2fa: true })).status, 403);
    // Grace period: nothing blocked yet.
    expectOk(await adminFresh.put(`/workspaces/${wid}/security`, { require2fa: true, graceDays: 7 }));
    expectOk(await gus.get('/workspaces'));
    assert.ok(expectOk(await gus.get('/me/security')).requiredBy[0].graceUntil > Date.now());

    // Grace over.
    const policy = expectOk(await adminFresh.put(`/workspaces/${wid}/security`, { require2fa: true, graceDays: 0 }));
    assert.ok(policy.nonCompliant.some((u: { id: string }) => u.id === user.id));
    const blocked = await gus.get('/workspaces');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'mfa_enrollment_required');
    assert.equal((await gus.req('GET', '/%77orkspaces')).status, 403, 'percent-encoded path');
    expectOk(await gus.get('/auth/me'));
    assert.equal(expectOk(await gus.get('/me/security')).enrollmentRequired, true);
    // No live connection either.
    const ws = new WebSocket(`${t.wsBase}/api/events`, { headers: { cookie: `oriel_session=${gus.cookie}` } });
    ws.on('error', () => {});
    const code = await new Promise<number>((resolve) => ws.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0)).on('open', () => resolve(101)));
    assert.equal(code, 403);
    ws.terminate();

    // Enrolment lifts the gate; removing the only method is refused.
    await enrolTotp(gus);
    expectOk(await gus.get('/workspaces'));
    assert.equal((await gus.del('/me/security/totp')).status, 409);

    // Admin reset (recovery): instance admin only, logged, sessions closed.
    assert.equal((await gus.post(`/admin/users/${adminId}/security/reset`, {})).status, 403);
    expectOk(await adminFresh.post(`/admin/users/${user.id}/security/reset`, {}));
    assert.equal((await gus.get('/auth/me')).status, 401);
    const back = await login('gus@oriel.test');
    assert.ok(back.res.body.user, 'no second step any more');
    const log = expectOk(await back.c.get('/me/security/log')).entries;
    assert.ok(log.some((e: { event: string; actor: { id: string } }) => e.event === 'mfa_reset_by_admin' && e.actor.id === adminId));
    assert.equal((await back.c.get('/workspaces')).status, 403, 'still blocked until enrolment');
    expectOk(await adminFresh.put(`/workspaces/${wid}/security`, { require2fa: false }));
    expectOk(await back.c.get('/workspaces'));
  });

  test('A08: workspace transfer, confirmed on both sides', async () => {
    const hal = new Client(t.base);
    expectOk(await admin.patch('/admin/settings', { signupMode: 'open' }));
    const halSession = expectOk(await hal.post('/auth/signup', { email: 'hal@oriel.test', name: 'Hal', password: PASSWORD }));
    const hw = halSession.workspaces[0].id;
    const halId = halSession.user.id;
    const { client: ivy, user: ivyUser } = await addMember(hal, hw, 'ivy@oriel.test', 'Ivy', 'viewer');
    const { client: joe, user: joeUser } = await addMember(hal, hw, 'joe@oriel.test', 'Joe', 'admin');

    // Only an owner proposes; only to a member; the proposal needs a recent authentication.
    assert.equal((await joe.post(`/workspaces/${hw}/transfer`, { toUserId: ivyUser.id })).status, 403);
    assert.equal((await hal.post(`/workspaces/${hw}/transfer`, { toUserId: adminId })).status, 404);
    assert.equal((await hal.post(`/workspaces/${hw}/transfer`, { toUserId: halId })).status, 400);
    age(hal);
    assert.equal((await hal.post(`/workspaces/${hw}/transfer`, { toUserId: ivyUser.id })).body.error?.code, 'reauth_required');
    expectOk(await hal.post('/auth/reauth', { password: PASSWORD }));
    const tr = expectOk(await hal.post(`/workspaces/${hw}/transfer`, { toUserId: ivyUser.id }));
    assert.equal(expectOk(await hal.get('/me/transfers')).outgoing.length, 1);
    assert.equal(expectOk(await ivy.get('/me/transfers')).incoming[0].id, tr.id);

    // Nobody else can accept it, not even another member or an instance admin.
    assert.equal((await joe.post(`/transfers/${tr.id}/accept`, {})).status, 404);
    assert.equal((await admin.post(`/transfers/${tr.id}/accept`, {})).status, 404);
    // The recipient confirms its identity too.
    age(ivy);
    assert.equal((await ivy.post(`/transfers/${tr.id}/accept`, {})).body.error?.code, 'reauth_required');
    expectOk(await ivy.post('/auth/reauth', { password: PASSWORD }));
    expectOk(await ivy.post(`/transfers/${tr.id}/accept`, {}));
    const roles = Object.fromEntries(expectOk(await ivy.get(`/workspaces/${hw}/members`)).map((m: { user: { id: string }; role: string }) => [m.user.id, m.role]));
    assert.equal(roles[ivyUser.id], 'owner');
    assert.equal(roles[halId], 'admin');
    assert.equal((await ivy.post(`/transfers/${tr.id}/accept`, {})).status, 404, 'single use');
    assert.ok(expectOk(await hal.get('/me/security/log')).entries.some((e: { event: string }) => e.event === 'transfer_accepted'));

    // Declined, and a proposal whose author lost ownership is void.
    const t2 = expectOk(await ivy.post(`/workspaces/${hw}/transfer`, { toUserId: joeUser.id }));
    expectOk(await joe.post(`/transfers/${t2.id}/decline`, {}));
    assert.equal(expectOk(await joe.get('/me/transfers')).incoming.length, 0);
    const t3 = expectOk(await ivy.post(`/workspaces/${hw}/transfer`, { toUserId: joeUser.id }));
    expectOk(await ivy.patch(`/workspaces/${hw}/members/${halId}`, { role: 'owner' }));
    expectOk(await hal.patch(`/workspaces/${hw}/members/${ivyUser.id}`, { role: 'member' }));
    assert.equal((await joe.post(`/transfers/${t3.id}/accept`, {})).status, 409);
  });
});
