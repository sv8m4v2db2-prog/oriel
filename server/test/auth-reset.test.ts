// Password reset: forgot (no enumeration, rate limit, e-mail), single-use tokens with expiry,
// session revocation, admin reset links (without SMTP).
process.env.SMTP_URL = 'json:quiet';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminResetLinkResponse, PasswordResetConfig, ResetTokenInfo, SessionResponse } from '@oriel/shared';
import { Client, addMember, expectOk, setupAdmin, sleep, startTestServer, waitFor, type TestServer } from './helpers.js';
import { collabContexts } from '../src/routes/collab.js';
import { Mailer, mailOutbox, setMailer } from '../src/collab/mailer.js';
import { createResetToken } from '../src/auth/passwordReset.js';
import type { AppContext } from '../src/context.js';

const tokenFromMail = (text: string) => /\/reset-password\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;

describe('password reset', () => {
  let srv: TestServer;
  let ctx: AppContext;
  let admin: Client;
  let wid: string;
  let member: Client;
  let memberId: string;

  before(async () => {
    srv = await startTestServer();
    ctx = collabContexts.get(srv.dataDir)!;
    const a = await setupAdmin(srv.base);
    admin = a.admin;
    wid = a.wid;
    const m = await addMember(admin, wid, 'marie@oriel.test', 'Marie Curie', 'member');
    member = m.client;
    memberId = m.user.id;
  });
  after(async () => {
    await srv.stop();
  });

  test('config is public', async () => {
    assert.deepEqual(expectOk(await new Client(srv.base).get<PasswordResetConfig>('/auth/password/config')), { emailEnabled: true });
  });

  test('forgot: same answer for known and unknown addresses, e-mail only for real accounts', async () => {
    const anon = new Client(srv.base);
    const start = mailOutbox.length;
    const unknown = await anon.post('/auth/password/forgot', { email: 'personne@oriel.test' });
    const known = await anon.post('/auth/password/forgot', { email: 'MARIE@oriel.test' });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.body, known.body);
    assert.deepEqual(known.body, { ok: true });
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'marie@oriel.test'), 3000, 'reset mail');
    assert.equal(mail.subject, 'Réinitialisation de votre mot de passe Oriel');
    assert.match(mail.text, /valable 1 heure/);
    assert.ok(tokenFromMail(mail.text));
    await sleep(100);
    assert.equal(mailOutbox.slice(start).length, 1, 'no mail for unknown addresses');
    assert.equal((await anon.post('/auth/password/forgot', {})).status, 400, 'malformed body');
  });

  test('reset: token info, validation, single use, revokes sessions', async () => {
    const anon = new Client(srv.base);
    const start = mailOutbox.length;
    expectOk(await anon.post('/auth/password/forgot', { email: 'marie@oriel.test' }));
    const mail = await waitFor(() => mailOutbox.slice(start).find((m) => m.to === 'marie@oriel.test'), 3000, 'reset mail');
    const token = tokenFromMail(mail.text)!;

    const info = expectOk(await anon.get<ResetTokenInfo>(`/auth/password/reset/${token}`));
    assert.deepEqual(info, { valid: true, email: 'ma***@oriel.test' });
    assert.deepEqual(expectOk(await anon.get<ResetTokenInfo>('/auth/password/reset/nimporte-quoi')), { valid: false, email: null });

    assert.equal((await anon.post('/auth/password/reset', { token, password: 'court' })).status, 400);
    assert.equal((await anon.post('/auth/password/reset', { token: 'faux', password: 'nouveau-mot-de-passe' })).status, 400);

    // The member's current session works before the reset…
    assert.equal((await member.get('/auth/me')).status, 200);
    const fresh = new Client(srv.base);
    const session = expectOk(await fresh.post<SessionResponse>('/auth/password/reset', { token, password: 'nouveau-mot-de-passe' }));
    assert.equal(session.user.id, memberId);
    assert.ok(fresh.cookie, 'logged in after reset');
    assert.equal((await fresh.get('/auth/me')).status, 200);
    // …and is revoked after it.
    assert.equal((await member.get('/auth/me')).status, 401);
    // Single use.
    assert.equal((await anon.post('/auth/password/reset', { token, password: 'encore-un-autre' })).status, 400);
    assert.equal(expectOk(await anon.get<ResetTokenInfo>(`/auth/password/reset/${token}`)).valid, false);
    // Old password refused, new one accepted.
    assert.equal((await new Client(srv.base).post('/auth/login', { email: 'marie@oriel.test', password: 'motdepasse-solide' })).status, 401);
    member = new Client(srv.base);
    expectOk(await member.post('/auth/login', { email: 'marie@oriel.test', password: 'nouveau-mot-de-passe' }));
  });

  test('tokens expire and a new request invalidates the previous link', async () => {
    const expired = createResetToken(ctx.db, memberId, null, 60 * 60 * 1000, Date.now() - 2 * 60 * 60 * 1000);
    assert.equal(expectOk(await new Client(srv.base).get<ResetTokenInfo>(`/auth/password/reset/${expired.token}`)).valid, false);
    assert.equal((await new Client(srv.base).post('/auth/password/reset', { token: expired.token, password: 'nouveau-mot-de-passe-2' })).status, 400);

    const first = createResetToken(ctx.db, memberId, null);
    const second = createResetToken(ctx.db, memberId, null);
    assert.equal(expectOk(await new Client(srv.base).get<ResetTokenInfo>(`/auth/password/reset/${first.token}`)).valid, false);
    assert.equal(expectOk(await new Client(srv.base).get<ResetTokenInfo>(`/auth/password/reset/${second.token}`)).valid, true);
    // Tokens are stored hashed.
    assert.equal(ctx.db.get('SELECT 1 AS x FROM collab_password_resets WHERE id = ?', second.token), undefined);
  });

  test('admin reset link works without SMTP and is admin-only', async () => {
    setMailer(ctx, new Mailer({ transport: null, from: 'x', capture: false }));
    assert.equal(expectOk(await new Client(srv.base).get<PasswordResetConfig>('/auth/password/config')).emailEnabled, false);
    assert.equal((await member.post(`/admin/users/${memberId}/password-reset`, {})).status, 403);
    assert.equal((await admin.post('/admin/users/inconnu/password-reset', {})).status, 404);
    const link = expectOk(await admin.post<AdminResetLinkResponse>(`/admin/users/${memberId}/password-reset`, { sendEmail: true }));
    assert.equal(link.emailed, false);
    assert.match(link.url, /^\/reset-password\/[A-Za-z0-9_-]+$/);
    assert.ok(link.expiresAt > Date.now() + 23 * 60 * 60 * 1000);
    const token = link.url.split('/').pop()!;
    expectOk(await new Client(srv.base).post('/auth/password/reset', { token, password: 'choisi-par-admin' }));
    expectOk(await new Client(srv.base).post('/auth/login', { email: 'marie@oriel.test', password: 'choisi-par-admin' }));
    // Without SMTP, "forgot" still answers 200 and sends nothing.
    const start = mailOutbox.length;
    expectOk(await new Client(srv.base).post('/auth/password/forgot', { email: 'marie@oriel.test' }));
    await sleep(100);
    assert.equal(mailOutbox.length, start);
  });
});

describe('password reset rate limiting', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ authRateLimit: 3 });
  });
  after(async () => {
    await srv.stop();
  });

  test('forgot is rate-limited per IP', async () => {
    const anon = new Client(srv.base);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await anon.post('/auth/password/forgot', { email: `x${i}@oriel.test` })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
});
