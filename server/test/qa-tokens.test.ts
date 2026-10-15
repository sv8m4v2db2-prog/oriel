// QA (security review): unit tests of the personal API token module (server/src/auth/apiTokens.ts),
// which is not wired into app.ts yet. A minimal Fastify app reproduces the pipeline the module expects
// (authenticate() in onRequest, the restriction hook installed by setupApiTokenAuth) on a throwaway
// database: token format and storage, Bearer parsing, expiry / revocation, scopes, cookie-only routes,
// workspace restriction (AsyncLocalStorage scope + route parameter guard), rate limits, FK cascades.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_TOKEN_PREFIX } from '@oriel/shared';
import type { AppContext } from '../src/context.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { HttpError } from '../src/errors.js';
import {
  apiTokenTestHooks,
  bearerApiToken,
  generateApiToken,
  runWithWorkspaceRestriction,
  setupApiTokenAuth,
  workspaceAllowed,
} from '../src/auth/apiTokens.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('qa-tokens: personal API tokens (unit)', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;
  const now = Date.now();
  const tokens: Record<string, string> = {};

  const addUser = (id: string, admin = 0) =>
    db.run(
      'INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      `${id}@oriel.test`,
      id,
      'x',
      admin,
      now,
      now,
    );
  const addWorkspace = (id: string, owner: string) => {
    db.run('INSERT INTO workspaces (id, name, icon, created_by, created_at, updated_at, version) VALUES (?, ?, NULL, ?, ?, ?, 1)', id, id, owner, now, now);
    db.run("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", id, owner, now);
  };
  const addPage = (id: string, wid: string, owner: string) =>
    db.run(
      `INSERT INTO pages (id, workspace_id, parent_type, parent_id, kind, title, position, owner_id, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, 'workspace', ?, 'page', ?, 'a0', ?, ?, ?, ?, ?)`,
      id,
      wid,
      wid,
      id,
      owner,
      now,
      owner,
      now,
      owner,
    );
  const addToken = (
    key: string,
    userId: string,
    opts: { scope?: 'read' | 'write'; workspaceId?: string | null; expiresAt?: number | null; revokedAt?: number | null } = {},
  ) => {
    const { token, hash, prefix } = generateApiToken();
    db.run(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, workspace_id, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `tok-${key}`,
      userId,
      key,
      hash,
      prefix,
      opts.scope ?? 'write',
      opts.workspaceId ?? null,
      now,
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
    );
    tokens[key] = token;
    return token;
  };

  /** The pipeline the module documents: authenticate() in onRequest, then the routes. */
  async function buildApp(): Promise<FastifyInstance> {
    const a = Fastify({ logger: false });
    a.decorateRequest('auth', null);
    const auth = setupApiTokenAuth(a, { db } as unknown as AppContext);
    a.addHook('onRequest', async (req) => {
      auth.authenticate(req);
    });
    a.setErrorHandler((err, _req, reply) => {
      const e = err as HttpError;
      return reply.code(e instanceof HttpError ? e.status : 500).send({ code: e instanceof HttpError ? e.code : 'internal' });
    });
    const echo = async (req: import('fastify').FastifyRequest) => {
      await sleep(1); // the restriction scope must survive async continuations
      const params = req.params as Record<string, string>;
      const uid = req.auth?.user.id ?? null;
      return {
        user: uid,
        scope: req.apiToken?.scope ?? null,
        sessionId: req.auth?.sessionId ?? null,
        isAdmin: req.auth?.user.is_admin ?? null,
        allowed: uid ? { a: workspaceAllowed(uid, 'ws-a'), b: workspaceAllowed(uid, 'ws-b'), otherUserInB: workspaceAllowed('someone-else', 'ws-b') } : null,
        params,
      };
    };
    for (const url of ['/api/workspaces/:wid', '/api/pages/:pid', '/api/ai/briefs/:id', '/api/auth/me', '/api/me/tokens', '/api/admin/settings', '/api/health']) {
      a.get(url, echo);
    }
    a.post('/api/workspaces', echo);
    a.post('/api/pages/:pid/move', echo);
    a.post('/api/me/tokens', echo);
    a.delete('/api/me/tokens/:id', echo);
    a.post('/api/me/password', echo);
    a.post('/api/auth/logout', echo);
    a.delete('/api/workspaces/:wid', echo);
    a.patch('/api/workspaces/:wid', echo);
    await a.ready();
    return a;
  }

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token?: string, remoteAddress = '127.0.0.1', target = app) =>
    target.inject({ method, url, remoteAddress, headers: token ? { authorization: `Bearer ${token}` } : {} });

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'oriel-qa-tokens-'));
    db = openDatabase(path.join(dir, 'oriel.db'));
    addUser('alice', 1);
    addUser('bob');
    addWorkspace('ws-a', 'alice');
    addWorkspace('ws-b', 'alice');
    addPage('page-a', 'ws-a', 'alice');
    addPage('page-b', 'ws-b', 'alice');
    db.run(
      `INSERT INTO ai_briefs (id, workspace_id, brief_date, status, trigger, model, started_at) VALUES ('brief-b', 'ws-b', '2026-10-14', 'succeeded', 'manual', 'claude-opus-5-5', ?)`,
      now,
    );
    addToken('write', 'alice');
    addToken('read', 'alice', { scope: 'read' });
    addToken('restricted', 'alice', { workspaceId: 'ws-a' });
    addToken('revoked', 'alice', { revokedAt: now - 1000 });
    addToken('expired', 'alice', { expiresAt: now - 1 });
    addToken('future', 'alice', { expiresAt: now + 86_400_000 });
    addToken('bob', 'bob');
    app = await buildApp();
  });

  after(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('generation: or_ + 43 base64url chars (256 bits), unique, only the SHA-256 is stored, short display prefix', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { token, hash, prefix } = generateApiToken();
      assert.match(token, /^or_[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(token.slice(API_TOKEN_PREFIX.length), 'base64url').length, 32);
      assert.equal(hash, createHash('sha256').update(token).digest('hex'));
      assert.equal(prefix, token.slice(0, 9));
      assert.ok(!seen.has(token));
      seen.add(token);
    }
    // Nothing in the table allows rebuilding a token: the stored prefix is 6 random chars out of 43.
    const row = db.get<Record<string, unknown>>("SELECT * FROM api_tokens WHERE id = 'tok-write'")!;
    assert.ok(!Object.values(row).some((v) => v === tokens.write), 'raw token stored');
    assert.equal(row.token_hash, createHash('sha256').update(tokens.write!).digest('hex'));
  });

  test('Bearer parsing: only "Bearer or_…" is an API token; other schemes go to the cookie pipeline', () => {
    const t = tokens.write!;
    assert.equal(bearerApiToken(undefined), null);
    assert.equal(bearerApiToken(''), null);
    assert.equal(bearerApiToken(`Bearer ${t}`), t);
    assert.equal(bearerApiToken(`bearer\t${t} `), t);
    assert.equal(bearerApiToken('Basic YWxpY2U6c2VjcmV0'), null);
    assert.equal(bearerApiToken('Bearer eyJhbGciOi'), null);
    assert.equal(bearerApiToken(`Bearer ${t} extra`), null);
    assert.equal(bearerApiToken(`Token ${t}`), null);
  });

  test('authentication: valid / unknown / malformed / revoked / expired tokens; no token = anonymous', async () => {
    let res = await call('GET', '/api/health');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user, null);

    res = await call('GET', '/api/health', tokens.write);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user, 'alice');
    assert.equal(res.json().scope, 'write');
    assert.equal(res.json().sessionId, 'api-token:tok-write');

    assert.equal((await call('GET', '/api/health', tokens.future)).statusCode, 200);
    for (const bad of [tokens.revoked, tokens.expired, 'or_' + 'A'.repeat(43), 'or_short', `${tokens.write}x`]) {
      const r = await call('GET', '/api/health', bad, '10.0.0.1');
      assert.equal(r.statusCode, 401, bad);
    }
    // Another Authorization scheme is not an API token (left to the cookie session).
    const basic = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Basic YWxpY2U6c2VjcmV0' } });
    assert.equal(basic.statusCode, 200);
    assert.equal(basic.json().user, null);
  });

  test('scopes: read tokens get 403 on every mutating method, write tokens pass', async () => {
    for (const [method, url] of [
      ['POST', '/api/pages/page-a/move'],
      ['PATCH', '/api/workspaces/ws-a'],
      ['POST', '/api/workspaces'],
    ] as const) {
      assert.equal((await call(method, url, tokens.read)).statusCode, 403, `${method} ${url}`);
      assert.equal((await call(method, url, tokens.write)).statusCode, 200, `${method} ${url}`);
    }
    assert.equal((await call('GET', '/api/workspaces/ws-a', tokens.read)).statusCode, 200);
  });

  test('cookie-only routes (token management, password, auth mutations, admin, workspace deletion) refuse tokens', async () => {
    for (const [method, url] of [
      ['GET', '/api/me/tokens'],
      ['POST', '/api/me/tokens'],
      ['DELETE', '/api/me/tokens/tok-read'],
      ['POST', '/api/me/password'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/admin/settings'],
      ['GET', '/api/%61dmin/settings'], // percent-encoded: routed to /api/admin/settings
      ['GET', '/api/me/%74okens'],
      ['DELETE', '/api/workspaces/ws-a'],
    ] as const) {
      assert.equal((await call(method, url, tokens.write)).statusCode, 403, `${method} ${url}`);
    }
    // Reads of the session endpoint stay possible.
    assert.equal((await call('GET', '/api/auth/me', tokens.write)).statusCode, 200);
  });

  test('workspace restriction: other workspace ids in route params → 404; scope visible to access helpers across awaits', async () => {
    const own = await call('GET', '/api/workspaces/ws-a', tokens.restricted);
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.json().allowed, { a: true, b: false, otherUserInB: true });
    for (const url of ['/api/workspaces/ws-b', '/api/pages/page-b', '/api/ai/briefs/brief-b']) {
      assert.equal((await call('GET', url, tokens.restricted)).statusCode, 404, url);
    }
    assert.equal((await call('POST', '/api/pages/page-b/move', tokens.restricted)).statusCode, 404);
    // Unknown ids are left to the handler (which answers 404 itself).
    assert.equal((await call('GET', '/api/pages/unknown', tokens.restricted)).statusCode, 200);
    // A restricted token cannot create workspaces.
    assert.equal((await call('POST', '/api/workspaces', tokens.restricted)).statusCode, 403);
    // Unrestricted tokens and anonymous requests: no scope.
    assert.deepEqual((await call('GET', '/api/workspaces/ws-b', tokens.write)).json().allowed, { a: true, b: true, otherUserInB: true });
    assert.equal(workspaceAllowed('alice', 'ws-b'), true);
    assert.equal(runWithWorkspaceRestriction({ userId: 'alice', workspaceId: 'ws-a' }, () => workspaceAllowed('alice', 'ws-b')), false);
  });

  test('last_used_at is written at most once per minute', async () => {
    db.run("UPDATE api_tokens SET last_used_at = NULL WHERE id = 'tok-bob'");
    await call('GET', '/api/health', tokens.bob);
    const first = db.get<{ last_used_at: number }>("SELECT last_used_at FROM api_tokens WHERE id = 'tok-bob'")!.last_used_at;
    assert.ok(first >= now);
    await sleep(5);
    await call('GET', '/api/health', tokens.bob);
    assert.equal(db.get<{ last_used_at: number }>("SELECT last_used_at FROM api_tokens WHERE id = 'tok-bob'")!.last_used_at, first);
    db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = 'tok-bob'", first - 61_000);
    await call('GET', '/api/health', tokens.bob);
    assert.ok(db.get<{ last_used_at: number }>("SELECT last_used_at FROM api_tokens WHERE id = 'tok-bob'")!.last_used_at > first - 61_000);
  });

  test('rate limits: invalid tokens per IP (429 after 60), requests per token (test hook)', async () => {
    const ip = '10.9.9.9';
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call('GET', '/api/health', 'or_' + 'Z'.repeat(43), ip)).statusCode;
    assert.equal(last, 429);
    // A valid token from the same IP still works (the failure quota only applies to failures).
    assert.equal((await call('GET', '/api/health', tokens.write, ip)).statusCode, 200);

    apiTokenTestHooks.requestsPerMinute = 2;
    const limited = await buildApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await call('GET', '/api/health', tokens.bob, '127.0.0.1', limited)).statusCode);
      assert.deepEqual(codes, [200, 200, 429]);
    } finally {
      delete apiTokenTestHooks.requestsPerMinute;
      await limited.close();
    }
  });

  test('QA-AGT-06: the invalid-token quota cannot be bypassed by rotating IPv6 addresses of one /64 or IPv4-mapped forms', async () => {
    const bad = 'or_' + 'Y'.repeat(43);
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await call('GET', '/api/health', bad, `2001:db8:aa:bb::${(i + 1).toString(16)}`)).statusCode);
    assert.equal(codes.at(-1), 429, 'one host rotating addresses inside its /64 got a fresh quota every time');
    codes.length = 0;
    for (let i = 0; i < 61; i++) codes.push((await call('GET', '/api/health', bad, i % 2 ? '10.7.7.7' : '::ffff:10.7.7.7')).statusCode);
    assert.equal(codes.at(-1), 429, 'IPv4 and its IPv4-mapped IPv6 form have separate quotas');
  });

  test('schema: unique hash index, cascades on user / workspace deletion', async () => {
    const indexes = db.all<{ name: string; unique: number }>("PRAGMA index_list('api_tokens')");
    assert.ok(indexes.some((i) => i.unique === 1), 'token_hash must be unique (lookup index)');
    assert.throws(() =>
      db.run(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES ('dup', 'bob', 'dup', ?, 'or_', 'read', 0)`,
        createHash('sha256').update(tokens.bob!).digest('hex'),
      ),
    );
    assert.throws(() =>
      db.run(`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES ('adm', 'bob', 'x', 'h', 'or_', 'admin', 0)`),
    );
    // Restricted token of a deleted workspace: gone.
    addWorkspace('ws-tmp', 'bob');
    const tmp = addToken('tmp', 'bob', { workspaceId: 'ws-tmp' });
    db.run("DELETE FROM workspaces WHERE id = 'ws-tmp'");
    assert.equal(db.get("SELECT 1 AS x FROM api_tokens WHERE id = 'tok-tmp'"), undefined);
    assert.equal((await call('GET', '/api/health', tmp, '10.1.1.1')).statusCode, 401);
    // Deleted user: every token gone.
    addUser('carol');
    const carol = addToken('carol', 'carol');
    assert.equal((await call('GET', '/api/health', carol)).statusCode, 200);
    db.run("DELETE FROM users WHERE id = 'carol'");
    assert.equal(db.get("SELECT 1 AS x FROM api_tokens WHERE user_id = 'carol'"), undefined);
    assert.equal((await call('GET', '/api/health', carol, '10.1.1.2')).statusCode, 401);
  });

  test('demoted instance admin: the user row is re-read on every request', async () => {
    assert.equal((await call('GET', '/api/health', tokens.write)).json().isAdmin, 1);
    db.run("UPDATE users SET is_admin = 0 WHERE id = 'alice'");
    try {
      const res = await call('GET', '/api/health', tokens.write);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().isAdmin, 0);
      // Admin routes are cookie-only anyway; the demotion is visible immediately on req.auth.
      assert.equal((await call('GET', '/api/admin/settings', tokens.write)).statusCode, 403);
    } finally {
      db.run("UPDATE users SET is_admin = 1 WHERE id = 'alice'");
    }
  });
});
