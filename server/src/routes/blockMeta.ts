// Block metadata route (H5, SPEC « Métadonnées par bloc »):
//  - GET /api/pages/:pid/blocks/:bid/meta   who created / last modified a block, and when
// Authenticated readers of the page only (requirePage: 404 when the page is not visible). Public
// visitors have no session and no route here: published pages expose no identity.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BLOCK_ID_PATTERN, type BlockMeta } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { idParam, parse, requireAuth } from '../http.js';
import { rateLimited } from '../errors.js';
import { requirePage } from '../access.js';
import { RateLimiter } from '../auth/rateLimit.js';
import { readBlockMeta } from '../services/blockMeta.js';

const params = z.object({ pid: idParam, bid: z.string().regex(BLOCK_ID_PATTERN) });

export function registerBlockMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  // One request per hovered handle: generous, but bounded per user.
  const limiter = new RateLimiter(600, 60_000);
  app.get('/api/pages/:pid/blocks/:bid/meta', async (req): Promise<BlockMeta> => {
    const { user } = requireAuth(req);
    const { pid, bid } = parse(params, req.params);
    requirePage(ctx.db, user.id, pid, 'read');
    if (!limiter.hit(`block-meta:${user.id}`)) throw rateLimited('Trop de demandes. Réessayez dans une minute.');
    return readBlockMeta(ctx.db, pid, bid);
  });
}
