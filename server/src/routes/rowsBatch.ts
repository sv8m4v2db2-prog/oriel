// Batched row updates of the table grid (vague G, session G2 — SPEC §5.10): paste, fill down, clear.
// One transaction (all or nothing), the same checks as PATCH /api/pages/:pid for every row.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, type BatchUpdateRowsResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { assertButtonTarget, getPageRow, requireDatabasePage } from '../access.js';
import { loadSchema } from '../services/databases.js';
import { updatePage } from '../services/pages.js';
import { assertPropertyWrites } from '../services/propertyAccess.js';
import { uuidLike } from '../schemas.js';

/** Rows per request (the client splits larger operations). */
export const MAX_BATCH_ROWS = 500;

const didParams = z.object({ did: idParam });

const batchSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            id: uuidLike,
            title: z.string().max(LIMITS.titleLength).optional(),
            properties: z.record(z.string().max(64), z.unknown()).optional(),
          })
          .strict()
          .refine((u) => !u.properties || Object.keys(u.properties).length <= 200, 'trop de propriétés'),
      )
      .min(1)
      .max(MAX_BATCH_ROWS),
    /** QA-EDT-05: the rows are changed by a button of this page (assertButtonTarget). */
    viaButtonOn: uuidLike.optional(),
  })
  .strict();

export function registerRowBatchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.post('/api/databases/:did/rows/batch', async (req): Promise<BatchUpdateRowsResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const body = parse(batchSchema, req.body);
    return db.tx(() => {
      const access = requireDatabasePage(db, user.id, did, 'edit');
      if (access.page.trashed_at !== null) throw badRequest('Restaurez la base de données avant de la modifier.');
      if (body.viaButtonOn) assertButtonTarget(db, user.id, body.viaButtonOn, access.page);
      const schema = loadSchema(db, did).properties;
      for (const u of body.updates) {
        const row = getPageRow(db, u.id);
        // Another database's row, a trashed or unknown page: invisible here.
        if (!row || row.parent_type !== 'database' || row.parent_id !== did || row.trashed_at !== null) {
          throw notFound('Ligne introuvable.');
        }
        assertPropertyWrites(schema, access.role, u.properties, db);
        updatePage(ctx, user.id, u.id, { title: u.title, properties: u.properties });
      }
      return { updated: body.updates.length };
    });
  });
}
