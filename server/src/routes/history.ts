// Version history routes (G6, SPEC « Historique des versions »). The list, read and whole-page
// restore of versions stay in routes/pages.ts; access goes through requirePageHistory (access.ts).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeletedBlocksResponse, HistoryPropertiesResponse, RestoreBlocksResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { idParam, parse, requireAuth } from '../http.js';
import { rateLimited } from '../errors.js';
import { RateLimiter } from '../auth/rateLimit.js';
import { deletedBlocks, propertiesAt, restoreBlocks } from '../services/history.js';

const pidParams = z.object({ pid: idParam });
const snapParams = z.object({ pid: idParam, sid: idParam });
const restoreBlocksSchema = z.object({
  items: z
    .array(
      z.object({
        blockId: z.string().regex(/^[\w.:-]{1,128}$/),
        action: z.enum(['reinsert', 'revert']),
      }),
    )
    .min(1)
    .max(200),
});
const propertiesQuery = z.object({ at: z.coerce.number().int().min(0).max(8.64e15).optional() });

export function registerHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Both decode whole versions synchronously (bounded per request, QA-G6-02/03): per user quota.
  const heavy = new RateLimiter(30, 60_000);
  const quota = (userId: string) => {
    if (!heavy.hit(`history:${userId}`)) throw rateLimited('Trop de demandes sur l’historique. Réessayez dans une minute.');
  };

  app.post('/api/pages/:pid/snapshots/:sid/restore-blocks', async (req): Promise<RestoreBlocksResponse> => {
    const { user } = requireAuth(req);
    const { pid, sid } = parse(snapParams, req.params);
    const body = parse(restoreBlocksSchema, req.body);
    quota(user.id);
    return restoreBlocks(ctx, user.id, pid, sid, body.items);
  });

  app.get('/api/pages/:pid/history/deleted', async (req): Promise<DeletedBlocksResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    quota(user.id);
    return deletedBlocks(ctx, user.id, pid);
  });

  app.get('/api/pages/:pid/history/properties', async (req): Promise<HistoryPropertiesResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { at } = parse(propertiesQuery, req.query);
    return propertiesAt(ctx, user.id, pid, at);
  });
}
