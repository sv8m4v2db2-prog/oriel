// Database module extras:
//  - GET /api/databases/:did/previews?ids=        feed view: first lines of rows' content + open comments
//  - GET /api/public/databases/:did/previews?ids= same for a published database (no comment counts)
//  - GET /api/workspaces/:wid/geocode?q=          address search for place properties (members; off
//                                                 unless GEOCODER_URL is set — see services/geocode.ts)
//  - GET /api/public/map-config                   tile layer of the map views (static administrator
//                                                 setting MAP_TILE_URL; no data, so no session needed)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GeocodeResponse, MapConfigResponse, RowPreviewsResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { PageRow } from '../db/rows.js';
import { HttpError, notFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { publicChain, requireDatabasePage, requireWorkspace } from '../access.js';
import { RateLimiter } from '../auth/rateLimit.js';
import { GeocodeError, geocodeSearch, parseGeocoderUrl, type GeocoderOptions, type GeocodeResult } from '../services/geocode.js';

const didParams = z.object({ did: idParam });
const widParams = z.object({ wid: idParam });
const previewsQuery = z.object({
  ids: z.string().max(100 * 40),
  lines: z.coerce.number().int().min(1).max(20).optional(),
});
const geocodeQuery = z.object({ q: z.string().trim().min(2).max(200) });

export interface GeocodeRouteOptions extends Partial<GeocoderOptions> {
  /** Searches per user per minute (cache hits are free). Default 20. */
  userLimit?: number;
  /** Minimum delay between two requests to the geocoder (all users). Default 1000 ms. */
  minIntervalMs?: number;
}

/** Test hook (set by the in-process test suite). `url: null` disables; a string overrides GEOCODER_URL. */
export const geocodeTestHooks: Omit<GeocodeRouteOptions, 'url'> & { url?: string | null } = {};

const CACHE_MS = 30 * 24 * 3600_000;

/**
 * First `lines` non-empty lines of the content of `ids`: rows of `database` only, templates excluded,
 * live rows only (plus, for a database in the trash, the rows trashed with it, like rowsResponse) —
 * QA-VIEW-03: a trashed row's content was served, to anonymous visitors too.
 */
function previews(
  db: Db,
  database: Pick<PageRow, 'id' | 'trashed_at'>,
  ids: string[],
  lines: number,
  withComments: boolean,
): RowPreviewsResponse {
  const out: RowPreviewsResponse = { previews: {} };
  if (ids.length === 0) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = db.all<{ id: string; text: string | null }>(
    `SELECT p.id, d.text FROM pages p LEFT JOIN documents d ON d.page_id = p.id
     WHERE p.parent_type = 'database' AND p.parent_id = ? AND p.id IN (${marks})
       AND (p.trashed_at IS NULL OR p.trashed_at = ?)
       AND p.id NOT IN (SELECT page_id FROM database_templates WHERE database_id = ?)`,
    database.id,
    ...ids,
    database.trashed_at ?? -1,
    database.id,
  );
  const comments = new Map<string, number>();
  if (withComments && rows.length > 0) {
    try {
      for (const c of db.all<{ page_id: string; n: number }>(
        `SELECT t.page_id, COUNT(c.id) AS n FROM collab_threads t JOIN collab_comments c ON c.thread_id = t.id
         WHERE t.resolved_at IS NULL AND t.page_id IN (${rows.map(() => '?').join(',')}) GROUP BY t.page_id`,
        ...rows.map((r) => r.id),
      )) {
        comments.set(c.page_id, c.n);
      }
    } catch {
      /* collaboration module absent */
    }
  }
  for (const r of rows) {
    const text = (r.text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, lines)
      .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
      .join('\n');
    out.previews[r.id] = { text, comments: comments.get(r.id) ?? 0 };
  }
  return out;
}

/** Default tiles: the OpenStreetMap standard layer (its usage policy requires the attribution). */
export const OSM_TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© les contributeurs d’OpenStreetMap', maxZoom: 19 };

/**
 * Tile layer of the map views from MAP_TILE_URL / MAP_TILE_ATTRIBUTION / MAP_TILE_MAX_ZOOM. Empty →
 * OpenStreetMap; `off` → no background map. The template is an https:// URL or a path of this
 * instance (CSP `img-src 'self' https:`), with {z} {x} {y} (and optionally {s} {r}). Throws at startup
 * when invalid, like GEOCODER_URL.
 */
export function parseMapTiles(env: { url?: string; attribution?: string; maxZoom?: string }): MapConfigResponse['tiles'] {
  const raw = (env.url ?? '').trim();
  if (/^(off|none|0|false)$/i.test(raw)) return null;
  const clean = (s: string | undefined) => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
  const zoom = env.maxZoom?.trim() ? Number(env.maxZoom) : NaN;
  const maxZoom = Number.isInteger(zoom) && zoom >= 1 && zoom <= 22 ? zoom : OSM_TILES.maxZoom;
  if (env.maxZoom?.trim() && maxZoom !== zoom) throw new Error('MAP_TILE_MAX_ZOOM doit être un entier entre 1 et 22.');
  if (!raw) return { ...OSM_TILES, attribution: clean(env.attribution) || OSM_TILES.attribution, maxZoom };
  const invalid = () => new Error('MAP_TILE_URL doit être une adresse https:// (ou un chemin /…) contenant {z}, {x} et {y}, ou « off ».');
  if (raw.length > 500 || /[\s"'<>\\`]/.test(raw) || !raw.includes('{z}') || !raw.includes('{x}') || !raw.includes('{y}')) throw invalid();
  const leftover = raw.replace(/\{(z|x|y|s|r)\}/g, '');
  if (/[{}]/.test(leftover)) throw invalid();
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) throw invalid();
  } else {
    let url: URL;
    try {
      url = new URL(raw.replace(/\{(z|x|y|s|r)\}/g, '0'));
    } catch {
      throw invalid();
    }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw invalid();
  }
  return { url: raw, attribution: clean(env.attribution), maxZoom };
}

const parseIds = (raw: string): string[] => [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9-]{8,64}$/.test(s)))].slice(0, 100);

export function registerDatabaseExtraRoutes(app: FastifyInstance, ctx: AppContext, options: GeocodeRouteOptions = {}): void {
  const { db } = ctx;

  // --- map tiles -------------------------------------------------------------------------------------

  const mapConfig: MapConfigResponse = {
    tiles: parseMapTiles({ url: process.env.MAP_TILE_URL, attribution: process.env.MAP_TILE_ATTRIBUTION, maxZoom: process.env.MAP_TILE_MAX_ZOOM }),
  };
  app.get('/api/public/map-config', async (): Promise<MapConfigResponse> => mapConfig);

  app.get('/api/databases/:did/previews', async (req): Promise<RowPreviewsResponse> => {
    const { user } = requireAuth(req);
    const { did } = parse(didParams, req.params);
    const q = parse(previewsQuery, req.query);
    const { page } = requireDatabasePage(db, user.id, did);
    return previews(db, page, parseIds(q.ids), q.lines ?? 3, true);
  });

  app.get('/api/public/databases/:did/previews', async (req): Promise<RowPreviewsResponse> => {
    const { did } = parse(didParams, req.params);
    const q = parse(previewsQuery, req.query);
    const chain = publicChain(db, did);
    if (!chain || chain[0]!.kind !== 'database') throw notFound('Page introuvable.');
    return previews(db, chain[0]!, parseIds(q.ids), q.lines ?? 3, false);
  });

  // --- geocoding ---------------------------------------------------------------------------------------

  // Validated at startup: an invalid GEOCODER_URL stops the server with a clear message.
  const envUrl = parseGeocoderUrl(process.env.GEOCODER_URL);
  const geocoder = (): GeocoderOptions & { userLimit: number; minIntervalMs: number } => {
    const hookUrl = geocodeTestHooks.url;
    return {
      ...options,
      ...geocodeTestHooks,
      url: hookUrl !== undefined ? (hookUrl === null ? null : parseGeocoderUrl(hookUrl)) : (options.url ?? envUrl),
      allowPrivate: options.allowPrivate ?? geocodeTestHooks.allowPrivate ?? process.env.GEOCODER_ALLOW_PRIVATE === '1',
      userLimit: options.userLimit ?? geocodeTestHooks.userLimit ?? 20,
      minIntervalMs: options.minIntervalMs ?? geocodeTestHooks.minIntervalMs ?? 1000,
    };
  };
  const limiters = new Map<number, RateLimiter>();
  const limiterFor = (n: number) => {
    let l = limiters.get(n);
    if (!l) limiters.set(n, (l = new RateLimiter(n, 60_000)));
    return l;
  };
  /** Global spacing of the requests sent to the geocoder (usage policy: ≤ 1 per second). */
  let nextSlot = 0;
  const inflight = new Map<string, Promise<GeocodeResult[]>>();

  app.get('/api/workspaces/:wid/geocode', async (req): Promise<GeocodeResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    const { q } = parse(geocodeQuery, req.query);
    const g = geocoder();
    if (!g.url) return { enabled: false, results: [] };
    const key = q.normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('fr');
    const cached = db.get<{ results: string; fetched_at: number }>('SELECT results, fetched_at FROM databases_geocode_cache WHERE query = ?', key);
    if (cached && Date.now() - cached.fetched_at < CACHE_MS) {
      return { enabled: true, results: JSON.parse(cached.results) as GeocodeResult[] };
    }
    if (!limiterFor(g.userLimit).hit(`geocode:${user.id}`)) throw rateLimited('Trop de recherches d’adresse. Réessayez dans une minute.');
    let pending = inflight.get(key);
    if (!pending) {
      const now = Date.now();
      const slot = Math.max(now, nextSlot);
      if (slot - now > 3000) throw rateLimited('Le service de géocodage est très sollicité. Réessayez dans un instant.');
      nextSlot = slot + g.minIntervalMs;
      pending = (async () => {
        if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
        return geocodeSearch(q, g);
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const results = await pending;
      db.run(
        `INSERT INTO databases_geocode_cache (query, results, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(query) DO UPDATE SET results = excluded.results, fetched_at = excluded.fetched_at`,
        key,
        JSON.stringify(results),
        Date.now(),
      );
      return { enabled: true, results };
    } catch (e) {
      const message = e instanceof GeocodeError ? e.message : 'Service de géocodage injoignable.';
      throw new HttpError(502, 'geocoder_unavailable', message);
    }
  });
}
