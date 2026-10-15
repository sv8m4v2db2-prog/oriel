// Streamable HTTP transport (`--http`): MCP on POST/GET/DELETE /mcp, one MCP session per client.
//
// Every request must carry `Authorization: Bearer or_…`:
//  - when ORIEL_TOKEN is configured, the presented token must be that one (single-user server);
//  - otherwise the presented token is the caller's own Oriel token (multi-user server): it is
//    checked against Oriel when the session starts and used for that session's API calls.
// A session is bound to the token that opened it. No CORS: browsers cannot send this header
// cross-origin, so pages cannot drive the server. On a loopback address (default), a request carrying
// a non-loopback Origin is refused (a DNS-rebound page, QA-MCP-06; MCP clients send no Origin, and the
// Host header is left free for a reverse proxy in front). Sessions are capped per token (the oldest is
// closed) and in total.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hasApiTokenPrefix } from '@oriel/shared';
import { OrielApiError } from './client.js';
import { createOrielMcpServer } from './server.js';

export interface HttpOptions {
  url: string;
  /** Configured token (single-user) or null (pass-through of the caller's token). */
  token: string | null;
  workspace: string | null;
  host: string;
  port: number;
  /** Idle sessions are closed after this delay (ms). Default 30 min. */
  idleMs?: number;
  log?: (msg: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  tokenHash: Buffer;
  lastSeen: number;
  close(): Promise<void>;
}

const MAX_BODY = 4 * 1024 * 1024;
/** Open sessions per token (the least recently used one is closed beyond) and in total (503 beyond). */
const MAX_SESSIONS_PER_TOKEN = 10;
const MAX_SESSIONS = 200;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLoopbackBind = (host: string) => LOOPBACK_HOSTNAMES.has(host.toLowerCase()) || /^127\./.test(host);

/** Hostname of a Host header value (`name[:port]`, `[v6][:port]`), lower-cased. */
function hostnameOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.split(':')[0]!;
}
const isLoopbackName = (name: string) => LOOPBACK_HOSTNAMES.has(name) || /^127\.\d+\.\d+\.\d+$/.test(name) || name.endsWith('.localhost');

/**
 * DNS rebinding: a page of another site rebound to the loopback address sends its own Origin (always
 * present on a browser POST). Non-browser MCP clients send none.
 */
function rebindingRefused(req: IncomingMessage, loopback: boolean): boolean {
  if (!loopback) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return !isLoopbackName(hostnameOf(new URL(origin).host));
  } catch {
    return true;
  }
}
const sha256 = (s: string) => createHash('sha256').update(s).digest();

function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.authorization ?? '');
  return m && hasApiTokenPrefix(m[1]!) ? m[1]! : null;
}

function sendJson(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Requête trop volumineuse.'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('JSON invalide.'), { status: 400 });
  }
}

export async function startHttpServer(opts: HttpOptions): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, Session>();
  const configured = opts.token ? sha256(opts.token) : null;
  const idleMs = opts.idleMs ?? 30 * 60_000;
  const loopback = isLoopbackBind(opts.host);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (path !== '/mcp') return sendJson(res, 404, 'Introuvable : utilisez /mcp.');
    if (rebindingRefused(req, loopback)) return sendJson(res, 403, 'Hôte ou origine non autorisé.');
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) return sendJson(res, 405, 'Méthode non autorisée.', { allow: 'GET, POST, DELETE' });

    const token = bearer(req);
    if (!token) return sendJson(res, 401, "En-tête « Authorization: Bearer or_… » requis.", { 'www-authenticate': 'Bearer' });
    const tokenHash = sha256(token);
    if (configured && !timingSafeEqual(tokenHash, configured)) return sendJson(res, 401, 'Jeton refusé.', { 'www-authenticate': 'Bearer' });

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string' && sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return sendJson(res, 404, 'Session MCP inconnue ou expirée.');
      if (!timingSafeEqual(session.tokenHash, tokenHash)) return sendJson(res, 403, "Cette session appartient à un autre jeton.");
      session.lastSeen = Date.now();
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== 'POST') return sendJson(res, 400, 'En-tête mcp-session-id manquant.');
    const body = await readBody(req);
    if (!isInitializeRequest(body)) return sendJson(res, 400, 'Une session doit commencer par une requête « initialize ».');

    const own = [...sessions.values()].filter((s) => timingSafeEqual(s.tokenHash, tokenHash)).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const s of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_TOKEN + 1))) await s.close();
    if (sessions.size >= MAX_SESSIONS) return sendJson(res, 503, 'Trop de sessions MCP ouvertes : réessayez plus tard.');
    const { server, oriel } = createOrielMcpServer({ url: opts.url, token, defaultWorkspace: opts.workspace });
    if (!configured) {
      // Pass-through: check the caller's token before opening a session.
      try {
        await oriel.me();
      } catch (err) {
        const status = err instanceof OrielApiError && err.status === 401 ? 401 : 502;
        return sendJson(res, status, status === 401 ? 'Jeton Oriel refusé.' : `Oriel injoignable : ${(err as Error).message}`);
      }
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          tokenHash,
          lastSeen: Date.now(),
          close: async () => {
            sessions.delete(id);
            await transport.close().catch(() => {});
            await server.close().catch(() => {});
          },
        });
        log(`session MCP ouverte (${sessions.size} active${sessions.size > 1 ? 's' : ''})`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: Error & { status?: number }) => {
      if (!err.status) log(`erreur HTTP : ${err.message}`);
      sendJson(res, err.status ?? 500, err.status ? err.message : 'Erreur interne du serveur MCP.');
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) if (now - s.lastSeen > idleMs) void s.close();
  }, 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return {
    port,
    url: `http://${host}:${port}/mcp`,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => s.close()));
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}
