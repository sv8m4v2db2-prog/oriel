// Verified domains of a workspace (A07). Ownership is proven by a DNS TXT record
// `_oriel.<domain>` = `oriel-verification=<token>`, looked up with the system resolver only (no
// custom servers), with a timeout, a bounded answer, a 60-second cache and a per-workspace rate limit.
// A domain is verified for one workspace at most. Auto-join applies to e-mail addresses verified by
// the SSO provider only (auth/oidc.ts) — never to a password sign-up, whose address is not verified.
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SECURITY_LIMITS, type VerifiedDomain } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { requireWorkspace } from '../access.js';
import { securityLimiters } from './security.js';

/** Test-only: replaces the DNS lookup (never set in production code). */
export const domainTestHooks: { resolveTxt?: (name: string) => Promise<string[][]> } = {};

const RECORD_PREFIX = '_oriel';
const VALUE_PREFIX = 'oriel-verification=';
const CACHE_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 6000;
const MAX_RECORDS = 50;
const MAX_RECORD_LENGTH = 2048;

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Lowercase, no trailing dot; null when not a plausible registrable host name. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_RE.test(d) ? d : null;
}

interface DomainRow {
  workspace_id: string;
  domain: string;
  token: string;
  verified_at: number | null;
  auto_join: number;
  join_role: 'member' | 'viewer';
  checked_at: number | null;
}

const toDto = (r: DomainRow): VerifiedDomain => ({
  domain: r.domain,
  verified: r.verified_at !== null,
  verifiedAt: r.verified_at,
  autoJoin: r.auto_join === 1,
  joinRole: r.join_role,
  record: { name: `${RECORD_PREFIX}.${r.domain}`, value: `${VALUE_PREFIX}${r.token}` },
  checkedAt: r.checked_at,
});

/** Workspaces an address of a verified, auto-join domain joins (with their role). */
export function autoJoinTargets(db: Db, email: string): Array<{ workspaceId: string; role: 'member' | 'viewer' }> {
  const domain = normalizeDomain(email.split('@').pop() ?? '');
  if (!domain || !email.includes('@')) return [];
  return db
    .all<{ workspace_id: string; join_role: 'member' | 'viewer' }>(
      'SELECT workspace_id, join_role FROM auth_domains WHERE domain = ? AND verified_at IS NOT NULL AND auto_join = 1',
      domain,
    )
    .map((r) => ({ workspaceId: r.workspace_id, role: r.join_role }));
}

const cache = new Map<string, { at: number; records: string[] }>();

/** Test-only: forget cached DNS answers. */
export const resetDomainCache = () => cache.clear();

async function txtRecords(name: string): Promise<string[]> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.records;
  const lookup = domainTestHooks.resolveTxt ?? ((n: string) => new Resolver({ timeout: 3000, tries: 2 }).resolveTxt(n));
  let raw: string[][] = [];
  try {
    raw = await Promise.race([
      lookup(name),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS).unref()),
    ]);
  } catch {
    raw = [];
  }
  const records = raw.slice(0, MAX_RECORDS).map((chunks) => chunks.join('').slice(0, MAX_RECORD_LENGTH));
  cache.set(name, { at: Date.now(), records });
  if (cache.size > 1000) cache.clear();
  return records;
}

const widParams = z.object({ wid: idParam });
const domainParams = z.object({ wid: idParam, domain: z.string().min(1).max(253) });
const addSchema = z.object({ domain: z.string().min(1).max(253) });
const patchSchema = z.object({ autoJoin: z.boolean().optional(), joinRole: z.enum(['member', 'viewer']).optional() });

export function registerDomainRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const manager = (req: FastifyRequest, wid: string) => {
    const { user } = requireAuth(req);
    if (req.apiToken) throw forbidden("Cette action n'est pas disponible avec un jeton d'API.");
    requireWorkspace(db, user.id, wid, 'manage');
    return user;
  };
  const rowOf = (wid: string, domain: string) => {
    const d = normalizeDomain(domain);
    const row = d ? db.get<DomainRow>('SELECT * FROM auth_domains WHERE workspace_id = ? AND domain = ?', wid, d) : undefined;
    if (!row) throw notFound('Domaine introuvable.');
    return row;
  };

  app.get('/api/workspaces/:wid/domains', async (req): Promise<{ domains: VerifiedDomain[] }> => {
    const { wid } = parse(widParams, req.params);
    manager(req, wid);
    return { domains: db.all<DomainRow>('SELECT * FROM auth_domains WHERE workspace_id = ? ORDER BY domain', wid).map(toDto) };
  });

  app.post('/api/workspaces/:wid/domains', async (req): Promise<VerifiedDomain> => {
    const { wid } = parse(widParams, req.params);
    const user = manager(req, wid);
    const domain = normalizeDomain(parse(addSchema, req.body).domain);
    if (!domain) throw badRequest('Nom de domaine invalide (exemple : studio.fr).');
    return db.tx(() => {
      if (db.get('SELECT 1 AS x FROM auth_domains WHERE workspace_id = ? AND domain = ?', wid, domain)) throw conflict('Ce domaine est déjà déclaré pour cet espace.');
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_domains WHERE workspace_id = ?', wid)!.n;
      if (n >= SECURITY_LIMITS.domainsPerWorkspace) throw badRequest(`Au plus ${SECURITY_LIMITS.domainsPerWorkspace} domaines par espace.`);
      db.run(
        `INSERT INTO auth_domains (workspace_id, domain, token, verified_at, auto_join, join_role, created_by, created_at, checked_at)
         VALUES (?, ?, ?, NULL, 0, 'member', ?, ?, NULL)`,
        wid,
        domain,
        randomBytes(18).toString('base64url'),
        user.id,
        Date.now(),
      );
      return toDto(db.get<DomainRow>('SELECT * FROM auth_domains WHERE workspace_id = ? AND domain = ?', wid, domain)!);
    });
  });

  app.post('/api/workspaces/:wid/domains/:domain/verify', async (req): Promise<VerifiedDomain> => {
    const { wid, domain } = parse(domainParams, req.params);
    manager(req, wid);
    const row = rowOf(wid, domain);
    if (row.verified_at !== null) return toDto(row);
    if (!securityLimiters(ctx).dns.hit(`dns:${wid}`)) throw rateLimited('Trop de vérifications : réessayez dans une minute.');
    const records = await txtRecords(`${RECORD_PREFIX}.${row.domain}`);
    const found = records.some((r) => r.trim() === `${VALUE_PREFIX}${row.token}`);
    const now = Date.now();
    if (!found) {
      db.run('UPDATE auth_domains SET checked_at = ? WHERE workspace_id = ? AND domain = ?', now, wid, row.domain);
      throw badRequest('Enregistrement DNS introuvable pour l’instant (la propagation peut prendre du temps).');
    }
    try {
      db.run('UPDATE auth_domains SET verified_at = ?, checked_at = ? WHERE workspace_id = ? AND domain = ?', now, now, wid, row.domain);
    } catch {
      // Unique index: already verified by another workspace.
      throw conflict('Ce domaine est déjà vérifié par un autre espace.');
    }
    return toDto(rowOf(wid, row.domain));
  });

  app.patch('/api/workspaces/:wid/domains/:domain', async (req): Promise<VerifiedDomain> => {
    const { wid, domain } = parse(domainParams, req.params);
    manager(req, wid);
    const body = parse(patchSchema, req.body);
    const row = rowOf(wid, domain);
    if (body.autoJoin && row.verified_at === null) throw badRequest('Vérifiez d’abord le domaine.');
    db.run(
      'UPDATE auth_domains SET auto_join = ?, join_role = ? WHERE workspace_id = ? AND domain = ?',
      body.autoJoin === undefined ? row.auto_join : body.autoJoin ? 1 : 0,
      body.joinRole ?? row.join_role,
      wid,
      row.domain,
    );
    return toDto(rowOf(wid, row.domain));
  });

  app.delete('/api/workspaces/:wid/domains/:domain', async (req) => {
    const { wid, domain } = parse(domainParams, req.params);
    manager(req, wid);
    const row = rowOf(wid, domain);
    db.run('DELETE FROM auth_domains WHERE workspace_id = ? AND domain = ?', wid, row.domain);
    return { ok: true as const };
  });
}
