// HTTP routes and background jobs of the "editor" feature module:
//  - GET  /api/link-preview?url=          metadata of a web page for the bookmark block (SSRF-guarded)
//  - PUT  /api/pages/:pid/template        mark / unmark a page as a template
//  - POST /api/pages/:pid/instantiate     new page from a template (deep copy)
//  - GET  /api/workspaces/:wid/templates  templates visible to the user
//  - GET  /api/editor/html-frame           static bootstrap page of HTML blocks (own sandbox CSP)
//  - POST /api/pages/:pid/synced-blocks    new synced block owned by the page
//  - GET  /api/pages/:pid/synced-blocks/:sid[/content]  synced block shown by the page (info, state)
//  - GET  /api/public/pages/:pid/synced-blocks/:sid    same, for a published page (anonymous visitors)
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HTML_FRAME_MAX_HEIGHT, HTML_FRAME_PATH, isSyncedId, newId, type LinkPreview, type Page, type SyncedBlockInfo, type TreeNode } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, notFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { canSeePage, getPageRow, isPubliclyVisible, pageAccess, requirePage, requireWorkspace, roleOf, visiblePageClause, visiblePageParams } from '../access.js';
import { readSyncedState } from '../io/content.js';
import { PAGE_COLUMNS, toPage, toTreeNode, type PageRow } from '../db/rows.js';
import { RateLimiter } from '../auth/rateLimit.js';
import { duplicatePage, emitPage } from '../services/pages.js';

// ===========================================================================
// SSRF guard: which IP addresses may be contacted
// ===========================================================================

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata endpoints)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function v4Blocked(n: number): boolean {
  for (const [base, bits] of V4_BLOCKED) {
    const b = ipv4ToInt(base)!;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return true;
  }
  return false;
}

/** 16 bytes of an IPv6 address (accepts embedded IPv4 and zone ids), or null. */
export function parseIpv6(input: string): number[] | null {
  let ip = input.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!net.isIPv6(ip)) return null;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const last = ip.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    ip = ip.slice(0, lastColon + 1) + '0:0';
  }
  const [head, rest] = ip.includes('::') ? ip.split('::') : [ip, null];
  const parseGroups = (s: string | undefined | null) => (s ? s.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const h = parseGroups(head);
  const r = rest === null ? [] : parseGroups(rest);
  const missing = 8 - h.length - r.length;
  if (missing < 0 || (rest === null && missing !== 0)) return null;
  const groups = [...h, ...new Array(missing).fill(0), ...r];
  if (tail.length) groups.splice(6, 2, ...tail);
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

const bytesToV4 = (b: number[], at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

/**
 * True for every address the server must never contact on behalf of a user: private, loopback,
 * link-local, multicast, unspecified, documentation/reserved ranges, for IPv4 and IPv6 (including
 * IPv4-mapped, NAT64 and 6to4 forms). Anything unparsable is blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return v4Blocked(v4);
  const b = parseIpv6(ip);
  if (!b) return true;
  const zeroUntil = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible, includes :: and ::1)
  if (zeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(bytesToV4(b, 12));
  if (zeroUntil(12)) return true;
  // 64:ff9b::/96 (NAT64, well-known prefix) → embedded IPv4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return v4Blocked(bytesToV4(b, 12));
  }
  // Only global unicast (2000::/3) may be contacted.
  if ((b[0]! & 0xe0) !== 0x20) return true;
  // 2002::/16 (6to4) → embedded IPv4
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(bytesToV4(b, 2));
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
    if (b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
    if (b[2] === 0x00 && (b[3]! & 0xf0) === 0x10) return true; // 2001:10::/28 ORCHID
    if (b[2] === 0x00 && (b[3]! & 0xf0) === 0x20) return true; // 2001:20::/28 ORCHIDv2
  }
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0x00) return true; // 3fff::/20 documentation
  return false;
}

/** Ports of web servers: the only ones the preview fetcher contacts by default. */
const PREVIEW_PORTS = new Set([80, 443]);

/**
 * Default endpoint policy: a blocked address (see isBlockedAddress), or a port other than 80/443. Public
 * addresses include the server's own public IP, which reaches services that listen on every interface but
 * are firewalled from the outside; other ports would also turn the preview into a port scanner.
 */
export function isBlockedEndpoint(ip: string, port: number): boolean {
  return !PREVIEW_PORTS.has(port) || isBlockedAddress(ip);
}

// ===========================================================================
// Fetching a page safely
// ===========================================================================

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchOptions {
  /** DNS resolution (injectable for tests). Default: dns.lookup(all). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Endpoint policy (injectable for tests). Default: isBlockedEndpoint (blocked addresses, ports other than 80/443). */
  isBlocked?: (ip: string, port: number) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export class PreviewError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'blocked' | 'unreachable' | 'not_html' | 'too_many_redirects' | 'timeout' | 'http_status',
    message: string,
    /** Whether the route may cache this failure: blocked / invalid addresses are not (cheap to recompute, and policy may change). */
    readonly cacheable: boolean = code !== 'blocked' && code !== 'invalid_url',
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

const defaultResolve = async (hostname: string): Promise<ResolvedAddress[]> => {
  const list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Parses and normalises a user-supplied URL: http/https only, no credentials, default ports allowed. */
export function normalizePreviewUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new PreviewError('invalid_url', 'Adresse invalide.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PreviewError('invalid_url', 'Seules les adresses http et https sont acceptées.');
  if (url.username || url.password) throw new PreviewError('invalid_url', 'Les adresses avec identifiants ne sont pas acceptées.');
  if (!url.hostname) throw new PreviewError('invalid_url', 'Adresse invalide.');
  url.hash = '';
  return url;
}

type VetOptions = Required<Pick<FetchOptions, 'resolve' | 'isBlocked'>> & { isBlockedPort: (port: number) => boolean };

/**
 * Resolves the host of `url` and checks every resulting address. Returns the addresses to connect to;
 * the request then connects to exactly those (no second DNS lookup → no DNS rebinding window).
 *
 * Only what the URL itself says (literal IP, internal suffix, port) is refused as "blocked". A host name
 * that resolves to a blocked address fails exactly like an unknown name: a distinct answer would let any
 * member enumerate the server's internal DNS names (QA-INJ-05). The port is checked before the lookup
 * for the same reason.
 */
async function vetHost(url: URL, opts: VetOptions): Promise<ResolvedAddress[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (net.isIP(host)) {
    if (opts.isBlocked(host, port)) throw new PreviewError('blocked', 'Cette adresse n’est pas autorisée.');
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new PreviewError('blocked', 'Cette adresse n’est pas autorisée.');
  }
  if (opts.isBlockedPort(port)) throw new PreviewError('blocked', 'Cette adresse n’est pas autorisée.');
  let addresses: ResolvedAddress[];
  try {
    addresses = await opts.resolve(host);
  } catch {
    throw new PreviewError('unreachable', 'Site introuvable.');
  }
  if (addresses.length === 0) throw new PreviewError('unreachable', 'Site introuvable.');
  // Every address must be public: a name that also resolves to an internal address is refused as if it
  // did not exist — same code, message and caching (a cache hit vs a fresh lookup would tell them apart).
  if (addresses.some((a) => opts.isBlocked(a.address, port))) throw new PreviewError('unreachable', 'Site introuvable.');
  return addresses;
}

interface RawResponse {
  url: URL;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestOnce(url: URL, addresses: ResolvedAddress[], deadline: number, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new PreviewError('timeout', 'Le site met trop de temps à répondre.'));
    // Settles exactly once. The overall timer settles too: a response cut mid-body only destroys `res`
    // (no 'error' when nobody listens on it), which would otherwise leave a decompressed body pending forever.
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let decoder: Readable | null = null;
    const settle = (err: PreviewError | null, value?: RawResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Stop decompressing whatever is still buffered.
      decoder?.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const pinnedLookup = (
      _hostname: string,
      options: { all?: boolean } | number | undefined,
      callback: (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) => {
      const all = typeof options === 'object' && options?.all;
      if (all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OrielLinkPreview/1.0)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Language': 'fr,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        lookup: pinnedLookup as unknown as net.LookupFunction,
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          settle(null, { url, status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        let stream: Readable = res;
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = decoder = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = decoder = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = decoder = res.pipe(zlib.createBrotliDecompress());
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        if (status >= 200 && status < 300 && !/^(text\/html|application\/xhtml\+xml)\b/.test(type)) {
          res.destroy();
          settle(new PreviewError('not_html', 'Ce lien ne pointe pas vers une page web.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => settle(null, { url, status, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes) });
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          // Size cap: keep the first maxBytes (metadata lives in <head>) and stop downloading.
          if (size >= maxBytes) {
            finish();
            res.destroy();
          }
        });
        stream.on('end', finish);
        stream.on('error', (err) => {
          settle(err instanceof PreviewError ? err : new PreviewError('unreachable', 'Impossible de lire la réponse du site.'));
        });
        // Connection dropped before the whole message arrived (the decoder above never ends then).
        res.on('close', () => {
          if (!res.complete) settle(new PreviewError('unreachable', 'Impossible de lire la réponse du site.'));
        });
      },
    );
    timer = setTimeout(() => {
      const err = new PreviewError('timeout', 'Le site met trop de temps à répondre.');
      settle(err);
      req.destroy(err);
    }, remaining);
    req.on('timeout', () => req.destroy(new PreviewError('timeout', 'Le site met trop de temps à répondre.')));
    req.on('error', (err) => {
      settle(err instanceof PreviewError ? err : new PreviewError('unreachable', 'Impossible de joindre le site.'));
    });
    req.end();
  });
}

/** GETs an HTML page with SSRF protection on every hop: vetted DNS and port, ≤ 3 redirects, 5 s overall, 1 MB. */
export async function fetchHtml(input: string, options: FetchOptions = {}): Promise<{ url: URL; html: string }> {
  const opts: VetOptions = {
    resolve: options.resolve ?? defaultResolve,
    isBlocked: options.isBlocked ?? isBlockedEndpoint,
    // Port part of the default policy, checked before resolving a name (an injected policy decides alone).
    isBlockedPort: options.isBlocked ? () => false : (port) => !PREVIEW_PORTS.has(port),
  };
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;
  let url = normalizePreviewUrl(input);
  for (let hop = 0; ; hop++) {
    const addresses = await vetHost(url, opts);
    const res = await requestOnce(url, addresses, deadline, maxBytes);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.location;
      if (!location) throw new PreviewError('http_status', 'Redirection invalide.');
      if (hop >= maxRedirects) throw new PreviewError('too_many_redirects', 'Trop de redirections.');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new PreviewError('invalid_url', 'Redirection invalide.');
      }
      url = normalizePreviewUrl(next.href);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new PreviewError('http_status', `Le site a répondu ${res.status}.`);
    return { url, html: decodeBody(res.body, String(res.headers['content-type'] ?? '')) };
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase(), { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ===========================================================================
// HTML metadata extraction
// ===========================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù',
  ucirc: 'û', uuml: 'ü', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', oelig: 'œ', laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®',
  trade: '™', middot: '·', bull: '•', euro: '€',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/<>"']+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  // Skip the tag name.
  const body = tag.replace(/^<\s*[a-z]+/i, '');
  while ((m = re.exec(body))) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function absoluteHttps(raw: string | undefined, base: URL): string {
  if (!raw) return '';
  try {
    const u = new URL(raw.trim(), base);
    // Only https resources are displayed (mixed content + CSP img-src https:).
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.href.slice(0, 2000);
  } catch {
    return '';
  }
}

/**
 * Opening tags `<name …>` of an HTML document, in order. Linear scan: a regex like `/<meta\b[^>]*>/g` is
 * quadratic on hostile input (many `<meta` and no `>`: every attempt scans to the end of the page).
 */
function* openingTags(html: string, name: 'meta' | 'link' | 'title'): Generator<{ tag: string; end: number }> {
  const start = new RegExp(`<${name}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = start.exec(html))) {
    const close = html.indexOf('>', m.index + 1);
    // No ">" left: no later tag can be closed either.
    if (close === -1) return;
    yield { tag: html.slice(m.index, close + 1), end: close + 1 };
    start.lastIndex = close + 1;
  }
}

/** Content of the first <title> element (up to the first </title> after it), linear time. */
function firstTitle(html: string): string | undefined {
  for (const { end } of openingTags(html, 'title')) {
    const closing = /<\/title>/gi;
    closing.lastIndex = end;
    const m = closing.exec(html);
    return m ? html.slice(end, m.index) : undefined;
  }
  return undefined;
}

/** Extracts Open Graph / Twitter card / <title> / favicon metadata from an HTML document. */
export function extractMetadata(html: string, pageUrl: URL): LinkPreview {
  const meta: Record<string, string> = {};
  for (const { tag } of openingTags(html, 'meta')) {
    const a = parseAttributes(tag);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const titleTag = firstTitle(html);
  let favicon = '';
  let touchIcon = '';
  for (const { tag } of openingTags(html, 'link')) {
    const a = parseAttributes(tag);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (!a.href) continue;
    if (!favicon && rel.includes('icon')) favicon = a.href;
    if (!touchIcon && rel.includes('apple-touch-icon')) touchIcon = a.href;
  }
  const title = clean(meta['og:title'] ?? meta['twitter:title'] ?? (titleTag ? decodeEntities(titleTag) : ''), 300);
  const description = clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 500);
  const image = absoluteHttps(
    meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? meta['twitter:image:src'],
    pageUrl,
  );
  let icon = absoluteHttps(favicon || touchIcon, pageUrl);
  if (!icon && pageUrl.protocol === 'https:') icon = `${pageUrl.origin}/favicon.ico`;
  return {
    url: pageUrl.href.slice(0, 2000),
    title: title || pageUrl.hostname,
    description,
    image,
    favicon: icon,
    siteName: clean(meta['og:site_name'] ?? meta['application-name'], 120) || pageUrl.hostname.replace(/^www\./, ''),
  };
}

export async function fetchLinkPreview(input: string, options: FetchOptions = {}): Promise<LinkPreview> {
  const { url, html } = await fetchHtml(input, options);
  return extractMetadata(html, url);
}

// ===========================================================================
// HTML block frame
// ===========================================================================

/**
 * CSP of the HTML block frame (imposed by the security audit): an opaque origin (`sandbox` without
 * allow-same-origin: no cookies, storage or access to the app), inline scripts and styles of the
 * block only, images and fonts from data: / https:, no network requests, no form submission, framed
 * by the app only.
 */
export const HTML_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

/**
 * Static bootstrap document: announces itself (`ready`), writes the HTML sent once by the parent
 * (`render`, from the parent window only), then reports its height (`resize`, 0–max).
 */
export const HTML_FRAME_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HTML</title></head>
<body><script>
(function () {
  var parentWindow = window.parent;
  var rendered = false;
  function post(message) {
    try { parentWindow.postMessage(message, '*'); } catch (e) {}
  }
  function report() {
    var root = document.documentElement;
    var body = document.body;
    // Content height: the root's box (standards mode, see below); scrollHeight is at least the
    // frame's height, so the frame could never shrink.
    var height = root ? root.getBoundingClientRect().height : body ? body.scrollHeight : 0;
    post({ type: 'resize', height: Math.max(0, Math.min(${HTML_FRAME_MAX_HEIGHT}, Math.ceil(height))) });
  }
  function onMessage(event) {
    if (rendered || event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'render' || typeof data.html !== 'string') return;
    rendered = true;
    window.removeEventListener('message', onMessage);
    document.open();
    // Standards mode unless the block chose otherwise (in quirks mode the body fills the frame).
    document.write(/^\\s*<!doctype/i.test(data.html) ? data.html : '<!doctype html>' + data.html);
    document.close();
    if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);
    window.addEventListener('load', report);
    setTimeout(report, 60);
    setTimeout(report, 600);
    report();
  }
  window.addEventListener('message', onMessage);
  post({ type: 'ready' });
})();
</script></body></html>
`;

// ===========================================================================
// Synced blocks
// ===========================================================================

interface SyncedRow {
  id: string;
  workspace_id: string;
  owner_page_id: string;
}

/** Most pages listed by SyncedBlockInfo.pages. */
const SYNCED_PAGES_LISTED = 100;

/**
 * Synced block `sid` as shown by page `hostId` for `userId`, or 404: the host page is visible, the
 * block belongs to the host's workspace (never resolved across workspaces) and the caller can see
 * its owner page (the block's access rules are the owner page's).
 */
function resolveSynced(ctx: AppContext, userId: string, hostId: string, sid: string): { row: SyncedRow; ownerCanEdit: boolean; owner: PageRow } {
  const { db } = ctx;
  const { page: host } = requirePage(db, userId, hostId, 'read');
  if (!isSyncedId(sid)) throw notFound('Bloc synchronisé introuvable.');
  const row = db.get<SyncedRow>('SELECT id, workspace_id, owner_page_id FROM editor_synced_blocks WHERE id = ?', sid);
  if (!row || row.workspace_id !== host.workspace_id) throw notFound('Bloc synchronisé introuvable.');
  const owner = pageAccess(db, userId, row.owner_page_id);
  if (!owner || owner.page.workspace_id !== row.workspace_id) throw notFound('Bloc synchronisé introuvable.');
  return { row, owner: owner.page, ownerCanEdit: owner.canEdit && owner.page.trashed_at === null };
}

function syncedInfo(ctx: AppContext, userId: string, resolved: ReturnType<typeof resolveSynced>): SyncedBlockInfo {
  const { db } = ctx;
  const { row, owner, ownerCanEdit } = resolved;
  const role = roleOf(db, userId, row.workspace_id);
  const shown = db.all<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM pages
     WHERE id IN (SELECT page_id FROM editor_synced_refs WHERE synced_id = ?) AND workspace_id = ? AND trashed_at IS NULL
     ORDER BY title COLLATE NOCASE, id LIMIT ?`,
    row.id,
    row.workspace_id,
    SYNCED_PAGES_LISTED * 4,
  );
  const visible = shown.filter((p) => p.id !== owner.id && canSeePage(userId, role, p, db)).slice(0, SYNCED_PAGES_LISTED - 1);
  const ref = (p: PageRow) => ({ id: p.id, title: p.title, icon: p.icon });
  return {
    id: row.id,
    ownerPageId: owner.id,
    ownerTitle: owner.title,
    ownerIcon: owner.icon,
    canEdit: ownerCanEdit,
    pages: [ref(owner), ...visible.map(ref)],
  };
}

// ===========================================================================
// Routes
// ===========================================================================

const previewQuery = z.object({ url: z.string().min(1).max(2000) });
const pidParams = z.object({ pid: idParam });
const syncedParams = z.object({ pid: idParam, sid: z.string().min(1).max(64) });
const widParams = z.object({ wid: idParam });
const templateBody = z.object({ isTemplate: z.boolean() });
const instantiateBody = z.object({
  parentType: z.enum(['workspace', 'page']),
  parentId: z.string().min(1).max(128),
  visibility: z.enum(['workspace', 'private']).optional(),
  after: z.string().max(128).nullable().optional(),
});

const CACHE_OK_MS = 24 * 60 * 60 * 1000;
const CACHE_FAIL_MS = 30 * 60 * 1000;
const CACHE_PURGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheRow {
  url: string;
  ok: number;
  data: string;
  fetched_at: number;
}

export interface EditorRouteOptions {
  /** Injected in tests (mocked DNS / address policy / timeouts). */
  fetchOptions?: FetchOptions;
  /** Network fetches per user per minute (cache hits are free). Default 20. */
  previewRateLimit?: number;
  /** Synced blocks created per user per minute. Default 60. */
  syncedRateLimit?: number;
}

/**
 * Test hook: the server is started in-process by the test suite, which sets mocked DNS / address policy
 * here before issuing requests. Never set in production code.
 */
export const editorTestHooks: EditorRouteOptions = {};

const previewHttpError = (e: PreviewError): HttpError => {
  if (e.code === 'invalid_url') return badRequest(e.message);
  if (e.code === 'blocked') return new HttpError(400, 'blocked_url', e.message);
  return new HttpError(422, 'preview_unavailable', e.message);
};

export function registerEditorRoutes(app: FastifyInstance, ctx: AppContext, options: EditorRouteOptions = {}): void {
  const { db } = ctx;
  const limiter = new RateLimiter(options.previewRateLimit ?? editorTestHooks.previewRateLimit ?? 20, 60_000);
  /** Concurrent fetches of the same URL share one request. */
  const inflight = new Map<string, Promise<LinkPreview>>();
  const syncedLimiter = new RateLimiter(options.syncedRateLimit ?? editorTestHooks.syncedRateLimit ?? 60, 60_000);

  // --- HTML block frame (static: no input, no session needed) --------------------

  app.get(HTML_FRAME_PATH, async (_req, reply) => {
    reply
      .header('Content-Security-Policy', HTML_FRAME_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .type('text/html; charset=utf-8');
    return HTML_FRAME_DOCUMENT;
  });

  // --- synced blocks ---------------------------------------------------------------

  app.post('/api/pages/:pid/synced-blocks', async (req): Promise<SyncedBlockInfo> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const { page } = requirePage(db, user.id, pid, 'edit');
    if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de la modifier.');
    if (!syncedLimiter.hit(`synced:${user.id}`)) throw rateLimited('Trop de blocs synchronisés créés. Réessayez dans une minute.');
    const id = newId();
    const now = Date.now();
    db.tx(() => {
      db.run(
        'INSERT INTO editor_synced_blocks (id, workspace_id, owner_page_id, state, text, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, \'\', ?, ?, ?)',
        id,
        page.workspace_id,
        page.id,
        user.id,
        now,
        now,
      );
      db.run('INSERT OR IGNORE INTO editor_synced_refs (synced_id, page_id) VALUES (?, ?)', id, page.id);
    });
    return syncedInfo(ctx, user.id, resolveSynced(ctx, user.id, page.id, id));
  });

  app.get('/api/pages/:pid/synced-blocks/:sid', async (req): Promise<SyncedBlockInfo> => {
    const { user } = requireAuth(req);
    const { pid, sid } = parse(syncedParams, req.params);
    return syncedInfo(ctx, user.id, resolveSynced(ctx, user.id, pid, sid));
  });

  app.get('/api/pages/:pid/synced-blocks/:sid/content', async (req): Promise<{ update: string }> => {
    const { user } = requireAuth(req);
    const { pid, sid } = parse(syncedParams, req.params);
    const { row } = resolveSynced(ctx, user.id, pid, sid);
    return { update: Buffer.from(readSyncedState(ctx, row.id)).toString('base64') };
  });

  // Published pages (no session): a synced block of the page's own workspace whose owner page is
  // published too (the same rule as anonymous `synced:` connections, plus the workspace check that a
  // document name alone cannot carry). No list of pages, never editable.
  app.get('/api/public/pages/:pid/synced-blocks/:sid', async (req): Promise<SyncedBlockInfo> => {
    const { pid, sid } = parse(syncedParams, req.params);
    const missing = () => notFound('Bloc synchronisé introuvable.');
    if (!isSyncedId(sid) || !isPubliclyVisible(db, pid)) throw missing();
    const host = getPageRow(db, pid);
    const row = db.get<SyncedRow>('SELECT id, workspace_id, owner_page_id FROM editor_synced_blocks WHERE id = ?', sid);
    if (!host || !row || row.workspace_id !== host.workspace_id || !isPubliclyVisible(db, row.owner_page_id)) throw missing();
    const owner = getPageRow(db, row.owner_page_id);
    if (!owner || owner.workspace_id !== row.workspace_id) throw missing();
    return { id: row.id, ownerPageId: owner.id, ownerTitle: owner.title, ownerIcon: owner.icon, canEdit: false, pages: [] };
  });

  app.get('/api/link-preview', async (req): Promise<LinkPreview> => {
    const { user } = requireAuth(req);
    // Members of at least one workspace only (the preview service is for page content).
    if (!db.get('SELECT 1 AS x FROM members WHERE user_id = ? LIMIT 1', user.id)) throw new HttpError(403, 'forbidden', 'Accès refusé.');
    const { url: raw } = parse(previewQuery, req.query);
    let url: URL;
    try {
      url = normalizePreviewUrl(raw);
    } catch (e) {
      throw previewHttpError(e as PreviewError);
    }
    const key = url.href;
    const cached = db.get<CacheRow>('SELECT * FROM editor_link_previews WHERE url = ?', key);
    const now = Date.now();
    if (cached && now - cached.fetched_at < (cached.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) {
      if (cached.ok) return JSON.parse(cached.data) as LinkPreview;
      const err = JSON.parse(cached.data) as { code: PreviewError['code']; message: string };
      throw previewHttpError(new PreviewError(err.code, err.message));
    }
    if (!limiter.hit(`preview:${user.id}`)) throw rateLimited('Trop d’aperçus demandés. Réessayez dans une minute.');
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchLinkPreview(key, options.fetchOptions ?? editorTestHooks.fetchOptions).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const preview = await pending;
      db.run(
        `INSERT INTO editor_link_previews (url, ok, data, fetched_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(url) DO UPDATE SET ok = 1, data = excluded.data, fetched_at = excluded.fetched_at`,
        key,
        JSON.stringify(preview),
        Date.now(),
      );
      return preview;
    } catch (e) {
      const err = e instanceof PreviewError ? e : new PreviewError('unreachable', 'Impossible de joindre le site.');
      // Blocked / invalid addresses are not cached (cheap to recompute, and policy may change). Names
      // resolving to a blocked address are cached like unknown names, so that neither the answer nor its
      // timing / rate-limit cost reveals internal DNS names (see vetHost).
      if (err.cacheable) {
        db.run(
          `INSERT INTO editor_link_previews (url, ok, data, fetched_at) VALUES (?, 0, ?, ?)
           ON CONFLICT(url) DO UPDATE SET ok = 0, data = excluded.data, fetched_at = excluded.fetched_at`,
          key,
          JSON.stringify({ code: err.code, message: err.message }),
          Date.now(),
        );
      }
      throw previewHttpError(err);
    }
  });

  // --- templates ---------------------------------------------------------------

  app.put('/api/pages/:pid/template', async (req): Promise<Page> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(templateBody, req.body);
    return db.tx(() => {
      const { page } = requirePage(db, user.id, pid, 'edit');
      if (page.kind !== 'page' || page.parent_type === 'database') throw badRequest('Seules les pages peuvent servir de modèle.');
      if (page.trashed_at !== null) throw badRequest('La page est dans la corbeille.');
      db.run(
        'UPDATE pages SET is_template = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?',
        body.isTemplate ? 1 : 0,
        Date.now(),
        user.id,
        page.id,
      );
      const updated = getPageRow(db, page.id)!;
      emitPage(ctx, updated, true);
      return toPage(updated);
    });
  });

  app.post('/api/pages/:pid/instantiate', async (req): Promise<Page> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pidParams, req.params);
    const body = parse(instantiateBody, req.body);
    const { page } = requirePage(db, user.id, pid, 'read');
    const flag = db.get<{ is_template: number }>('SELECT is_template FROM pages WHERE id = ?', page.id);
    if (!flag?.is_template) throw badRequest('Cette page n’est pas un modèle.');
    const copy = duplicatePage(ctx, user.id, page.id, {
      target: { parentType: body.parentType, parentId: body.parentId, visibility: body.visibility, after: body.after },
      title: page.title,
    });
    return toPage(copy);
  });

  app.get('/api/workspaces/:wid/templates', async (req): Promise<{ templates: TreeNode[] }> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    const rows = db.all<PageRow & { is_template: number }>(
      `SELECT ${PAGE_COLUMNS}, is_template FROM pages p
       WHERE workspace_id = ? AND is_template = 1 AND trashed_at IS NULL AND ${visiblePageClause('p')}
       ORDER BY title COLLATE NOCASE, id`,
      wid,
      ...visiblePageParams(user.id),
    );
    return { templates: rows.map(toTreeNode) };
  });
}

/** Starts periodic jobs; returns a stop function. */
export function startEditorJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  const purge = () => {
    try {
      ctx.db.run('DELETE FROM editor_link_previews WHERE fetched_at < ?', Date.now() - CACHE_PURGE_MS);
    } catch (err) {
      log('purge des aperçus de liens impossible', err);
    }
  };
  const timer = setInterval(purge, 60 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
