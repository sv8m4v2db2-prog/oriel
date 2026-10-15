// HTTP routes and background jobs of the "io" feature module (workspace import / export).
// Imports and exports run in the client; the server only exposes the page content API.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAGE_CONTENT_MAX_BYTES, type PageContentResponse, type PutPageContentResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { idParam, parse, requireAuth } from '../http.js';
import { getPageContent, putPageContent } from '../io/content.js';

const pidParams = z.object({ pid: idParam });

/** Base64 of PAGE_CONTENT_MAX_BYTES (+ JSON envelope). */
const CONTENT_BODY_LIMIT = Math.ceil((PAGE_CONTENT_MAX_BYTES * 4) / 3) + 64 * 1024;

const putContentSchema = z.object({
  update: z.string().max(CONTENT_BODY_LIMIT),
  mode: z.enum(['replace', 'append', 'merge']),
});

export function registerIoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/pages/:pid/content', async (req): Promise<PageContentResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    return getPageContent(ctx, user.id, pid);
  });

  app.put('/api/pages/:pid/content', { bodyLimit: CONTENT_BODY_LIMIT }, async (req): Promise<PutPageContentResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(putContentSchema, req.body);
    return putPageContent(ctx, user.id, pid, body);
  });
}

/** Starts periodic jobs; returns a stop function. */
export function startIoJobs(_ctx: AppContext, _log: (msg: string, err?: unknown) => void): () => void {
  return () => {};
}
