// Read-only access to published pages (no session). Unpublished/trashed → 404.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PublicPageResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { PAGE_COLUMNS, toCrumb, toTreeNode, type DatabaseRow, type PageRow } from '../db/rows.js';
import { pageNotFound } from '../errors.js';
import { idParam, parse } from '../http.js';
import { publicChain } from '../access.js';
import { recordAnonymousView } from '../services/navigation.js';
import { databaseResponse, rowsResponse } from './databases.js';
import { linkQuerySchema } from '../schemas.js';
import { pageFor, schemaFor } from '../services/propertyAccess.js';

const pidParams = z.object({ pid: idParam });
const didParams = z.object({ did: idParam });

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // publicChain (access.ts): self-first chain when publicly visible (same rule as /collab), else null.
  app.get('/api/public/pages/:pid', async (req): Promise<PublicPageResponse> => {
    const { pid } = parse(pidParams, req.params);
    const chain = publicChain(db, pid);
    if (!chain) throw pageNotFound();
    const page = chain[0]!;
    let rootIdx = 0;
    chain.forEach((p, i) => {
      if (p.is_public === 1) rootIdx = i;
    });
    const ancestors = chain.slice(1, rootIdx + 1).reverse().map(toCrumb);
    const children =
      page.kind === 'page'
        ? db
            .all<PageRow>(
              `SELECT ${PAGE_COLUMNS} FROM pages WHERE parent_type = 'page' AND parent_id = ? AND trashed_at IS NULL ORDER BY position, id`,
              page.id,
            )
            .map(toTreeNode)
        : [];
    let parentDatabase = null;
    if (page.parent_type === 'database') {
      const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', page.parent_id);
      if (row) parentDatabase = schemaFor(db, row, page.workspace_id, null); // anonymous: unrestricted properties (D30)
    }
    // Navigation module: anonymous visitors only increment a daily counter (no personal data).
    if (!req.auth) recordAnonymousView(db, page.id);
    return { page: pageFor(db, null, page), ancestors, children, parentDatabase };
  });

  app.get('/api/public/databases/:did', async (req) => {
    const { did } = parse(didParams, req.params);
    const chain = publicChain(db, did);
    if (!chain || chain[0]!.kind !== 'database') throw pageNotFound();
    // Linked database blocks show their own views (read-only: never created here).
    const { linkId } = parse(linkQuerySchema, req.query ?? {});
    return databaseResponse(db, chain[0]!, false, { linkId });
  });

  app.get('/api/public/databases/:did/rows', async (req) => {
    const { did } = parse(didParams, req.params);
    const chain = publicChain(db, did);
    if (!chain || chain[0]!.kind !== 'database') throw pageNotFound();
    return rowsResponse(db, chain[0]!, { hideEmails: true });
  });
}
