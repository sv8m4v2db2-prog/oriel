// Address search for `place` properties, through a Nominatim-compatible endpoint chosen by the
// administrator (GEOCODER_URL). Off by default: queries leave the server for a third party.
//
// Policy: fixed endpoint validated at startup (never a user-supplied URL), SSRF guard of the link
// previews on the resolved addresses (opt-out GEOCODER_ALLOW_PRIVATE=1 for a self-hosted instance on
// the local network), identifying User-Agent, no client header or cookie forwarded, ≤ 1 request per
// second globally, 5 s timeout, 256 KB response cap, results reduced to { address, lat, lng }.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { VERSION } from '../version.js';
import { isBlockedEndpoint, type ResolvedAddress } from '../routes/editor.js';

export interface GeocodeResult {
  address: string;
  lat: number;
  lng: number;
}

export interface GeocoderOptions {
  /** Base URL of the Nominatim API (…/search is appended). Null: geocoding disabled. */
  url: URL | null;
  /** Allow private / loopback addresses (self-hosted geocoder on the local network). */
  allowPrivate?: boolean;
  /** DNS resolution (injectable for tests). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address policy (injectable for tests). Default: isBlockedEndpoint unless allowPrivate. */
  isBlocked?: (ip: string, port: number) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
}

export class GeocodeError extends Error {
  constructor(
    readonly code: 'unavailable' | 'blocked',
    message: string,
  ) {
    super(message);
    this.name = 'GeocodeError';
  }
}

/** Parses GEOCODER_URL: http(s), no credentials, no query or fragment. Throws (at startup) when invalid. */
export function parseGeocoderUrl(raw: string | undefined): URL | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GEOCODER_URL invalide : ${value}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error('GEOCODER_URL doit être une adresse http(s) sans identifiants, paramètres ni fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

const defaultResolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Addresses to connect to (pinned: no second DNS lookup), after the endpoint policy. */
async function vet(url: URL, opts: GeocoderOptions): Promise<ResolvedAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const blocked = opts.isBlocked ?? ((ip: string, p: number) => !opts.allowPrivate && isBlockedEndpoint(ip, p));
  let addresses: ResolvedAddress[];
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(host);
    } catch {
      throw new GeocodeError('unavailable', 'Service de géocodage injoignable.');
    }
  }
  if (addresses.length === 0) throw new GeocodeError('unavailable', 'Service de géocodage injoignable.');
  if (addresses.some((a) => blocked(a.address, port))) throw new GeocodeError('blocked', 'Adresse du service de géocodage refusée.');
  return addresses;
}

function getJson(url: URL, addresses: ResolvedAddress[], opts: GeocoderOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const lookup = (_h: string, o: { all?: boolean } | number | undefined, cb: (e: Error | null, a: unknown, f?: number) => void) => {
      if (typeof o === 'object' && o?.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, addresses[0]!.address, addresses[0]!.family);
    };
    const lib = url.protocol === 'https:' ? https : http;
    // Only our own headers: nothing from the client request is forwarded.
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': opts.userAgent ?? `Oriel/${VERSION} (self-hosted workspace; place search)`,
          Accept: 'application/json',
          'Accept-Language': 'fr,en;q=0.8',
        },
        lookup: lookup as unknown as net.LookupFunction,
        timeout: timeoutMs,
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          return done(new GeocodeError('unavailable', 'Le service de géocodage a refusé la demande.'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            done(new GeocodeError('unavailable', 'Réponse du service de géocodage trop volumineuse.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            done(new GeocodeError('unavailable', 'Réponse du service de géocodage illisible.'));
          }
        });
        res.on('error', () => done(new GeocodeError('unavailable', 'Service de géocodage injoignable.')));
      },
    );
    const timer = setTimeout(() => {
      done(new GeocodeError('unavailable', 'Le service de géocodage met trop de temps à répondre.'));
      req.destroy();
    }, timeoutMs);
    req.on('error', () => done(new GeocodeError('unavailable', 'Service de géocodage injoignable.')));
    req.end();
  });
}

/** Reduces a Nominatim answer to a few { address, lat, lng } (text only). */
export function reduceResults(data: unknown, max = 5): GeocodeResult[] {
  if (!Array.isArray(data)) return [];
  const out: GeocodeResult[] = [];
  for (const item of data) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as { display_name?: unknown; lat?: unknown; lon?: unknown };
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (typeof r.display_name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push({ address: r.display_name.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300), lat, lng });
  }
  return out;
}

/** One search request (no cache, no throttling: see the route). */
export async function geocodeSearch(query: string, opts: GeocoderOptions): Promise<GeocodeResult[]> {
  if (!opts.url) throw new GeocodeError('unavailable', 'Géocodage désactivé.');
  const url = new URL(`${opts.url.href.replace(/\/+$/, '')}/search`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('q', query);
  const addresses = await vet(url, opts);
  return reduceResults(await getJson(url, addresses, opts));
}
