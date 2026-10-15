import fs from 'node:fs';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { resolveConfig, type ResolvedConfig, type ServerOptions } from './config.js';
import { openDatabase } from './db/index.js';
import type { AppContext } from './context.js';
import { noopCollab } from './context.js';
import { EventBus } from './realtime/events.js';
import { CollabService } from './realtime/collab.js';
import { RateLimiter } from './auth/rateLimit.js';
import { parseCookieHeader, resolveSession, SESSION_COOKIE } from './auth/sessions.js';
import { HttpError, forbidden } from './errors.js';
import { setSessionCookie } from './http.js';
import { roleOf } from './access.js';
import { setupApiTokenAuth } from './auth/apiTokens.js';
import { setupAccountSecurity } from './auth/stepUp.js';
import { enrollmentRequired } from './auth/security.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerDatabaseRoutes } from './routes/databases.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFileRoutes } from './routes/files.js';
import { ensureLocalUser, isLoopbackHost } from './local.js';
import { startJobs } from './jobs.js';
import { registerFeatureRoutes, startFeatureJobs } from './features.js';
import { EMBED_FRAME_ORIGINS } from '@oriel/shared';

export type { ServerOptions } from './config.js';

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const JSON_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * TRUST_PROXY means "one reverse proxy (Caddy/Nginx) in front": trust the X-Forwarded-* values set by
 * the immediate peer only, and only when that peer is an allowed proxy address (loopback / private
 * network by default, see util/proxyTrust.ts). With `trustProxy: true` Fastify would trust every hop
 * and take the *leftmost* X-Forwarded-For entry as the client IP — a value the client chooses whenever
 * the proxy appends to the header (Nginx `$proxy_add_x_forwarded_for`); trusting any immediate peer
 * would let a client of a server exposed without proxy choose its IP (QA-HTTP-03). Both defeat per-IP
 * rate limiting.
 */
const trustImmediateProxy =
  (isTrustedProxy: (address: string | undefined) => boolean) =>
  (address: string, hop: number): boolean =>
    hop === 0 && isTrustedProxy(address);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Frames allowed in the SPA (editor embeds): the supported providers (https only), plus optional extra
 * https origins for generic iframe embeds, set by the administrator with ORIEL_EMBED_ORIGINS
 * (comma-separated, e.g. "https://app.frame.io,https://player.example.com").
 */
const EMBED_EXTRA_ORIGINS = (process.env.ORIEL_EMBED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter((o) => /^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(o));
const FRAME_SRC = ["'self'", ...EMBED_FRAME_ORIGINS, ...EMBED_EXTRA_ORIGINS].join(' ');

const SPA_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval': WebAssembly compilation only (the Typst preview, a Web Worker), not JavaScript eval.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Bookmark previews show https images/favicons of the linked site directly (the server drops non-https
  // URLs); proxying them would turn the server into an image fetcher for arbitrary URLs.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  `frame-src ${FRAME_SRC}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const NOT_BUILT_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Oriel</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Oriel</h1><p>Interface non construite : lancez <code>npm run build</code>.</p>
<p>L'API est disponible sous <code>/api</code>.</p></body></html>`;

/**
 * Origin header absent, or same host as the request (or PUBLIC_URL). X-Forwarded-Host counts only when
 * the immediate peer (`peer`, socket address) is a trusted proxy; its last entry is the one the proxy set.
 */
export function originAllowed(
  origin: string | undefined,
  headers: IncomingHttpHeaders,
  config: ResolvedConfig,
  peer: string | undefined,
): boolean {
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  if (headers.host) allowed.add(headers.host.toLowerCase());
  const fwd = headers['x-forwarded-host'];
  if (typeof fwd === 'string' && fwd && config.isTrustedProxy(peer)) allowed.add(fwd.split(',').at(-1)!.trim().toLowerCase());
  if (config.publicUrl) {
    try {
      allowed.add(new URL(config.publicUrl).host.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return allowed.has(host);
}

/**
 * API request = raw path under /api/ OR routed to an /api/ route: the router percent-decodes paths, so
 * `/%61pi/…` reaches API handlers and must get the same CSRF checks, session and headers.
 */
function isApiRequest(req: FastifyRequest): boolean {
  return req.url.startsWith('/api/') || (req.routeOptions.url ?? '').startsWith('/api/');
}

function hasBody(req: FastifyRequest): boolean {
  const len = req.headers['content-length'];
  if (len !== undefined && Number(len) > 0) return true;
  return req.headers['transfer-encoding'] !== undefined;
}

function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  return reply.code(err.status).type('application/json; charset=utf-8').send(err.toBody());
}

function mapError(err: FastifyError | Error): HttpError | null {
  if (err instanceof HttpError) return err;
  const e = err as FastifyError & { status?: number };
  const status = e.statusCode ?? e.status;
  if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.code === 'FST_REQ_FILE_TOO_LARGE' || status === 413) {
    return new HttpError(413, 'payload_too_large', 'Contenu trop volumineux.');
  }
  if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || status === 415) {
    return new HttpError(415, 'validation', 'Type de contenu non pris en charge.');
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new HttpError(status, status === 404 ? 'not_found' : 'validation', status === 404 ? 'Ressource introuvable.' : 'Requête invalide.');
  }
  return null;
}

export async function startServer(options: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const config = resolveConfig(options);
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const db = openDatabase(config.dbFile);
  if (!db.getMeta('signup_mode')) db.setMeta('signup_mode', config.signupMode);

  // Credentials never reach the logs (API tokens travel in Authorization, sessions in Cookie).
  const logger = config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] };
  const app: FastifyInstance = Fastify({
    logger,
    trustProxy: config.trustProxy === false ? false : trustImmediateProxy(config.isTrustedProxy),
    bodyLimit: JSON_BODY_LIMIT,
    logController: new LogController({ disableRequestLogging: !['debug', 'trace'].includes(config.logLevel) }),
    forceCloseConnections: true,
  });
  const log = (msg: string, err?: unknown) => (err ? app.log.error({ err }, msg) : app.log.info(msg));
  // DEPLOY.md: an https PUBLIC_URL means Secure session cookies, whatever the proxy forwards.
  app.decorate('orielSecureCookies', /^https:\/\//i.test(config.publicUrl));

  const isMember = (userId: string, workspaceId: string) => roleOf(db, userId, workspaceId) !== null;
  const ctx: AppContext = {
    db,
    config,
    bus: new EventBus(db, config.eventBatchMs, isMember),
    collab: noopCollab,
    authLimiter: new RateLimiter(config.authRateLimit, 60_000),
  };
  const collab = new CollabService(ctx);
  ctx.collab = collab;

  // --- body parsing ----------------------------------------------------------
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: JSON_BODY_LIMIT }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text, (key, value) => (key === '__proto__' || key === 'constructor' ? undefined : value)));
    } catch {
      done(new HttpError(400, 'validation', 'Corps JSON invalide.'), undefined);
    }
  });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 10, parts: 20 },
  });

  // --- request pipeline -------------------------------------------------------
  app.decorateRequest('auth', null);
  const apiTokens = setupApiTokenAuth(app, ctx);
  app.addHook('onRequest', async (req, reply) => {
    if (config.localMode && !isLoopbackHost(req.headers.host)) throw forbidden('Hôte non autorisé.');
    if (!isApiRequest(req)) return;
    // Personal API tokens (`Authorization: Bearer or_…`, auth/apiTokens.ts): when one is present the
    // session cookie is never used. The CSRF rules are skipped only for a valid token sent without any
    // session cookie (a mere Authorization header never lifts them).
    const viaApiToken = apiTokens.authenticate(req);
    if (MUTATING.has(req.method) && (!viaApiToken || req.cookies[SESSION_COOKIE] !== undefined)) {
      if (!originAllowed(req.headers.origin, req.headers, config, req.socket.remoteAddress)) {
        throw forbidden('Origine de la requête non autorisée.');
      }
      const contentType = req.headers['content-type'];
      if (contentType) {
        const base = contentType.split(';')[0]!.trim().toLowerCase();
        if (base !== 'application/json' && base !== 'multipart/form-data') throw forbidden('Type de contenu non autorisé.');
      } else if (hasBody(req)) {
        throw forbidden('Type de contenu non autorisé.');
      }
    }
    if (viaApiToken) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const session = resolveSession(db, token);
      if (session) {
        req.auth = { user: session.user, sessionId: session.sessionId };
        if (session.refreshed) setSessionCookie(req, reply, token);
      }
    }
  });
  // Account security (auth/stepUp.ts): two-factor enrolment gate and re-authentication of sensitive
  // routes. After the authentication hook, before the routes.
  setupAccountSecurity(app, ctx);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // A route may be stricter (the HTML block frame: no-referrer).
    if (!reply.hasHeader('Referrer-Policy')) reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (isApiRequest(req)) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    } else if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', SPA_CSP);
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapError(err as FastifyError);
    if (mapped) return sendError(reply, mapped);
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, new HttpError(500, 'internal', 'Erreur interne du serveur.'));
  });

  // --- routes -------------------------------------------------------------------
  registerAuthRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerPageRoutes(app, ctx);
  registerDatabaseRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerFeatureRoutes(app, ctx);

  // --- SPA ------------------------------------------------------------------------
  const webDist = config.resolvedWebDist && fs.existsSync(path.join(config.resolvedWebDist, 'index.html')) ? config.resolvedWebDist : null;
  const sendIndex = (reply: FastifyReply) => {
    if (!webDist) return reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(NOT_BUILT_HTML);
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html', webDist);
  };
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: false,
      wildcard: true,
      // The build never needs dotfiles (.env, .DS_Store, .git… copied by mistake stay private).
      dotfiles: 'ignore',
      setHeaders: (reply, filePath) => {
        const rel = path.relative(webDist, filePath).split(path.sep).join('/');
        reply.header('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.get('/', async (_req, reply) => sendIndex(reply));
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0] ?? '/';
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return sendError(reply, new HttpError(404, 'not_found', 'Ressource introuvable.'));
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !path.posix.extname(pathname)) return sendIndex(reply);
    return reply.code(404).type('text/plain; charset=utf-8').send('Introuvable');
  });

  // --- WebSocket upgrades -------------------------------------------------------
  const eventsWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // Documents hold text only (files are uploaded separately), so 16 MiB frames are ample.
  const collabWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  let closing = false;
  app.server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (closing) return reject(503, 'Service Unavailable');
    if (config.localMode && !isLoopbackHost(req.headers.host)) return reject(403, 'Forbidden');
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (!originAllowed(req.headers.origin, req.headers, config, req.socket.remoteAddress)) return reject(403, 'Forbidden');
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? resolveSession(db, token) : null;
    // Two-factor enrolment required (auth/stepUp.ts): no live connection until the account enrols.
    if (session && enrollmentRequired(ctx, session.user.id)) return reject(403, 'Forbidden');
    if (pathname === '/api/events') {
      if (!session) return reject(401, 'Unauthorized');
      eventsWss.handleUpgrade(req, socket, head, (ws) => ctx.bus.attach(ws, session.user.id, session.sessionId));
      return;
    }
    if (pathname === '/collab' || pathname.startsWith('/collab/')) {
      collabWss.handleUpgrade(req, socket, head, (ws) =>
        collab.handleConnection(ws, req, session ? { userId: session.user.id, sessionId: session.sessionId } : null),
      );
      return;
    }
    reject(404, 'Not Found');
  });

  if (config.localMode) ensureLocalUser(ctx);

  await app.listen({ port: config.port, host: config.host });
  const address = app.server.address() as AddressInfo;
  const port = address.port;
  const displayHost =
    config.host === '0.0.0.0' || config.host === '::' || config.host === '' ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${displayHost}:${port}`;
  const stopCoreJobs = config.jobs ? startJobs(ctx, log) : () => {};
  const stopFeatureJobs = config.jobs ? startFeatureJobs(ctx, log) : () => {};
  const stopJobs = () => {
    stopCoreJobs();
    stopFeatureJobs();
  };
  log(`Oriel écoute sur ${url} (données : ${config.dataDir}${webDist ? '' : ', interface web non construite'})`);

  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= (async () => {
      closing = true;
      stopJobs();
      ctx.bus.flushAll();
      ctx.bus.close();
      await collab.shutdown();
      eventsWss.close();
      collabWss.close();
      await app.close();
      db.close();
    })();
    return closePromise;
  };

  return { port, url, close };
}
