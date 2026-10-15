// Advanced database properties (vague G, session G3 — SPEC §5.9): per-property permissions (D30) and
// relation schema (D29).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PAGE_METADATA_PROPERTY_TYPES, type DatabaseSchema, type PropertyAccess, type PropertyDef, type RelationGraphResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { parseJson, type DatabaseRow, type PageRow } from '../db/rows.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { canManageRole, pageAccess, requireDatabasePage } from '../access.js';
import { loadSchema, publishDatabase, saveSchema } from '../services/databases.js';
import { schemaFor, visibleProperties } from '../services/propertyAccess.js';

const propParams = z.object({ did: idParam, propId: z.string().min(1).max(64) });
const didParams = z.object({ did: idParam });

/** Databases shown around the requested one at most (the diagram stays readable). */
const MAX_GRAPH_DATABASES = 40;

const accessBody = z
  .object({
    readRoles: z.array(z.enum(['member', 'viewer'])).max(2).nullable().optional(),
    editRoles: z.array(z.enum(['member'])).max(1).nullable().optional(),
  })
  .strict();

export function registerPropertyExtraRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** Sets who sees / edits a property. Owners and admins of the workspace only (they always keep both rights). */
  app.put('/api/databases/:did/properties/:propId/access', async (req): Promise<DatabaseSchema> => {
    const { user } = requireAuth(req);
    const { did, propId } = parse(propParams, req.params);
    const body = parse(accessBody, req.body);
    return db.tx(() => {
      const access = requireDatabasePage(db, user.id, did, 'edit');
      if (!canManageRole(access.role)) throw forbidden("Seuls les propriétaires et administrateurs de l'espace règlent les droits d'une propriété.");
      if (access.page.trashed_at !== null) throw badRequest('La base de données est dans la corbeille.');
      const { properties } = loadSchema(db, did);
      const def = properties.find((p) => p.id === propId);
      if (!def) throw notFound('Propriété introuvable.');
      if (def.type === 'title') throw badRequest('La propriété titre est toujours visible et modifiable.');
      // QA-G3-04: creator, last editor and their dates are part of every page; a restriction would hide nothing.
      const restricts = (body.readRoles !== undefined && body.readRoles !== null) || (body.editRoles !== undefined && body.editRoles !== null);
      if (restricts && PAGE_METADATA_PROPERTY_TYPES.includes(def.type)) {
        throw badRequest('Les droits ne s’appliquent pas à cette propriété : son information figure sur chaque page.');
      }
      const next: PropertyAccess = { ...def.access };
      if (body.readRoles !== undefined) {
        if (body.readRoles === null) delete next.readRoles;
        else next.readRoles = [...new Set(body.readRoles)];
      }
      if (body.editRoles !== undefined) {
        if (body.editRoles === null) delete next.editRoles;
        else next.editRoles = [...new Set(body.editRoles)];
      }
      const updated = { ...def };
      if (next.readRoles || next.editRoles) updated.access = next;
      else delete updated.access;
      saveSchema(
        db,
        did,
        properties.map((p) => (p.id === propId ? updated : p)),
      );
      // Rows change for some viewers too: a database invalidation refetches schema and rows.
      publishDatabase(ctx, did);
      const row = db.get<DatabaseRow>('SELECT * FROM databases WHERE page_id = ?', did)!;
      return schemaFor(db, row, access.page.workspace_id, access.role);
    });
  });

  /**
   * Relation schema (D29): the database, the databases it links to and those linking to it, with their
   * relation properties. Only databases the viewer can read and properties it can see (D30).
   */
  app.get('/api/databases/:did/relation-graph', async (req): Promise<RelationGraphResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const access = requireDatabasePage(db, user.id, did);
    const role = access.role;
    const databases = new Map<string, RelationGraphResponse['databases'][number]>();
    const add = (page: PageRow) => databases.set(page.id, { id: page.id, title: page.title, icon: page.icon });
    add(access.page);
    const readable = (id: string): PageRow | null => {
      if (databases.has(id)) return getLive(id);
      if (databases.size >= MAX_GRAPH_DATABASES) return null;
      const a = pageAccess(db, user.id, id);
      return a && a.page.kind === 'database' && a.page.trashed_at === null ? a.page : null;
    };
    const getLive = (id: string): PageRow | null => pageAccess(db, user.id, id)?.page ?? null;
    const propsOf = (id: string): PropertyDef[] => visibleProperties(db, loadSchema(db, id).properties, role);
    const links: RelationGraphResponse['links'] = [];
    const mirrors = new Set<string>();

    for (const p of propsOf(did)) {
      const target = p.type === 'relation' ? p.relation?.databaseId : undefined;
      if (!target) continue;
      const page = readable(target);
      if (!page) continue;
      add(page);
      const synced = p.relation?.syncedPropertyId;
      const mirror = synced ? propsOf(target).find((x) => x.id === synced) : undefined;
      if (synced) mirrors.add(`${target}:${synced}`);
      links.push({ fromId: did, toId: target, propertyId: p.id, propertyName: p.name, mirrorName: mirror?.name ?? null, twoWay: !!synced });
    }
    // Databases of the workspace relating to this one (their schema mentions its id).
    const candidates = db.all<{ page_id: string; properties: string }>(
      `SELECT d.page_id, d.properties FROM databases d JOIN pages p ON p.id = d.page_id
       WHERE p.workspace_id = ? AND p.trashed_at IS NULL AND d.page_id != ? AND instr(d.properties, ?) > 0`,
      access.page.workspace_id,
      did,
      did,
    );
    for (const c of candidates) {
      const incoming = visibleProperties(db, parseJson<PropertyDef[]>(c.properties, []), role).filter(
        (p) => p.type === 'relation' && p.relation?.databaseId === did && !mirrors.has(`${c.page_id}:${p.id}`),
      );
      if (incoming.length === 0) continue;
      const page = readable(c.page_id);
      if (!page) continue;
      add(page);
      for (const p of incoming) {
        links.push({ fromId: c.page_id, toId: did, propertyId: p.id, propertyName: p.name, mirrorName: null, twoWay: !!p.relation?.syncedPropertyId });
      }
    }
    return { databases: [...databases.values()], links };
  });
}
