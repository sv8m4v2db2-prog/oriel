import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Invite, Page, SessionResponse, WorkspaceRole } from '@oriel/shared';
import { startServer, type RunningServer, type ServerOptions } from '../src/app.js';

export interface TestServer {
  server: RunningServer;
  base: string;
  wsBase: string;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startTestServer(opts: Partial<ServerOptions> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'oriel-test-'));
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    logLevel: 'silent',
    authRateLimit: 10_000,
    collabDebounceMs: 50,
    collabMaxDebounceMs: 200,
    eventBatchMs: 20,
    jobs: false,
    ...opts,
  });
  return {
    server,
    base: server.url,
    wsBase: server.url.replace(/^http/, 'ws'),
    dataDir,
    async stop() {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Minimal HTTP client with a cookie jar holding the session cookie. */
export class Client {
  cookie: string | null = null;
  constructor(readonly base: string) {}

  async req<T = any>(
    method: string,
    url: string,
    body?: unknown,
    opts: { origin?: string; contentType?: string | null; rawBody?: BodyInit } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = `oriel_session=${this.cookie}`;
    if (opts.origin) headers.origin = opts.origin;
    let payload: BodyInit | undefined = opts.rawBody;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    if (opts.contentType === null) delete headers['content-type'];
    else if (opts.contentType) headers['content-type'] = opts.contentType;
    const res = await fetch(`${this.base}/api${url}`, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie()) {
      const m = /^oriel_session=([^;]*)/.exec(c);
      if (!m) continue;
      this.cookie = m[1] && !/max-age=0/i.test(c) && !/expires=Thu, 01 Jan 1970/i.test(c) ? m[1] : null;
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep text */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(url: string) {
    return this.req<T>('GET', url);
  }
  post<T = any>(url: string, body?: unknown) {
    return this.req<T>('POST', url, body);
  }
  patch<T = any>(url: string, body?: unknown) {
    return this.req<T>('PATCH', url, body);
  }
  put<T = any>(url: string, body?: unknown) {
    return this.req<T>('PUT', url, body);
  }
  del<T = any>(url: string) {
    return this.req<T>('DELETE', url);
  }
}

export function expectOk<T>(res: Res<T>, status = 200): T {
  if (res.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export async function signup(base: string, email: string, name: string, inviteToken?: string): Promise<{ client: Client; session: SessionResponse }> {
  const client = new Client(base);
  const session = expectOk(await client.post<SessionResponse>('/auth/signup', { email, name, password: 'motdepasse-solide', inviteToken }));
  return { client, session };
}

/** First account (admin) with its workspace id. */
export async function setupAdmin(base: string) {
  const { client, session } = await signup(base, 'admin@oriel.test', 'Alice Admin');
  return { admin: client, session, wid: session.workspaces[0]!.id };
}

/** Invites a new user into a workspace with the given role. */
export async function addMember(admin: Client, wid: string, email: string, name: string, role: Exclude<WorkspaceRole, 'owner'>) {
  const invite = expectOk(await admin.post<Invite>(`/workspaces/${wid}/invites`, { role }));
  const { client, session } = await signup(admin.base, email, name, invite.token);
  return { client, user: session.user };
}

export async function createPage(client: Client, wid: string, body: Record<string, unknown>): Promise<Page> {
  return expectOk(await client.post<Page>(`/workspaces/${wid}/pages`, { parentType: 'workspace', parentId: wid, ...body }));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
