// Embed providers: recognise a pasted URL and compute the iframe source to display.
// The iframe `src` is always recomputed from the stored URL (never stored), so a crafted block
// cannot frame an arbitrary page under a known provider's name.
import type { EmbedProvider } from '@oriel/shared';
import { appOrigin, isAppOrigin } from './frameGuards';

export interface ProviderInfo {
  provider: EmbedProvider;
  label: string;
  /** Default height in px; 0 = 16:9 ratio of the width. */
  defaultHeight: number;
}

export const PROVIDER_LABELS: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
  figma: 'Figma',
  'google-maps': 'Google Maps',
  'google-docs': 'Google Docs',
  'google-sheets': 'Google Sheets',
  'google-slides': 'Google Slides',
  'google-drive': 'Google Drive',
  spotify: 'Spotify',
  frameio: 'Frame.io',
  generic: 'Page web',
};

function parseHttps(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

/** "1h2m3s", "90", "1:30" → seconds */
function parseStart(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return 0;
}

const ID = /^[\w-]{6,}$/;

function youtube(u: URL): string | null {
  const h = host(u);
  let id: string | null = null;
  if (h === 'youtu.be') id = u.pathname.split('/')[1] ?? null;
  else if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([\w-]+)/.exec(u.pathname);
      if (m) id = m[1]!;
      else if (u.pathname === '/playlist' && u.searchParams.get('list')) {
        return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(u.searchParams.get('list')!)}`;
      }
    }
  }
  if (!id || !ID.test(id)) return null;
  const params = new URLSearchParams();
  const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start'));
  if (start) params.set('start', String(start));
  const list = u.searchParams.get('list');
  if (list && /^[\w-]+$/.test(list)) params.set('list', list);
  const qs = params.toString();
  return `https://www.youtube-nocookie.com/embed/${id}${qs ? `?${qs}` : ''}`;
}

function vimeo(u: URL): string | null {
  const h = host(u);
  if (h === 'player.vimeo.com') {
    const m = /^\/video\/(\d+)/.exec(u.pathname);
    if (!m) return null;
    const hash = u.searchParams.get('h');
    return `https://player.vimeo.com/video/${m[1]}${hash && /^\w+$/.test(hash) ? `?h=${hash}` : ''}`;
  }
  if (h !== 'vimeo.com') return null;
  // vimeo.com/123456789, vimeo.com/123456789/abcdef (unlisted), vimeo.com/channels/x/123, vimeo.com/showcase/x/video/123
  const parts = u.pathname.split('/').filter(Boolean);
  const idIndex = parts.findIndex((p) => /^\d{5,}$/.test(p));
  if (idIndex === -1) return null;
  const id = parts[idIndex]!;
  const hash = parts[idIndex + 1] && /^[0-9a-f]{6,}$/i.test(parts[idIndex + 1]!) ? parts[idIndex + 1] : u.searchParams.get('h');
  return `https://player.vimeo.com/video/${id}${hash && /^\w+$/.test(hash) ? `?h=${hash}` : ''}`;
}

function loom(u: URL): string | null {
  if (host(u) !== 'loom.com') return null;
  const m = /^\/(?:share|embed)\/([0-9a-f]{16,})/i.exec(u.pathname);
  return m ? `https://www.loom.com/embed/${m[1]}` : null;
}

function figma(u: URL): string | null {
  const h = host(u);
  if (h !== 'figma.com' && h !== 'embed.figma.com') return null;
  if (!/^\/(file|design|proto|board|slides|deck|make)\//.test(u.pathname)) return null;
  const clean = new URL(u.href);
  clean.hostname = 'www.figma.com';
  return `https://www.figma.com/embed?embed_host=oriel&url=${encodeURIComponent(clean.href)}`;
}

function googleMaps(u: URL): string | null {
  const h = host(u);
  const isMaps = (h === 'google.com' || /^google\.[a-z.]+$/.test(h) || h === 'maps.google.com') && (u.pathname.startsWith('/maps') || h === 'maps.google.com');
  if (!isMaps) return null;
  if (u.pathname.startsWith('/maps/embed')) {
    // Already an embed URL (from "Partager › Intégrer une carte").
    const pb = u.searchParams.get('pb');
    return pb ? `https://www.google.com/maps/embed?pb=${encodeURIComponent(pb)}` : null;
  }
  let query = u.searchParams.get('q') ?? u.searchParams.get('query') ?? '';
  let zoom = '';
  const place = /\/maps\/(?:place|search)\/([^/]+)/.exec(u.pathname);
  if (place) query = decodeURIComponent(place[1]!.replace(/\+/g, ' '));
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/.exec(u.pathname);
  if (at) {
    if (!query) query = `${at[1]},${at[2]}`;
    zoom = String(Math.round(Number(at[3])));
  }
  if (!query) return null;
  return `https://maps.google.com/maps?q=${encodeURIComponent(query)}${zoom ? `&z=${zoom}` : ''}&output=embed`;
}

function google(u: URL): { provider: EmbedProvider; src: string } | null {
  const h = host(u);
  if (h === 'docs.google.com') {
    const m = /^\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]+)/.exec(u.pathname);
    if (!m) return null;
    const [, kind, published, id] = m;
    const base = `https://docs.google.com/${kind}/d/${published ?? ''}${id}`;
    if (kind === 'document') return { provider: 'google-docs', src: published ? `${base}/pub?embedded=true` : `${base}/preview` };
    if (kind === 'spreadsheets') return { provider: 'google-sheets', src: published ? `${base}/pubhtml?widget=true&headers=false` : `${base}/preview` };
    if (kind === 'presentation') return { provider: 'google-slides', src: published ? `${base}/embed` : `${base}/preview` };
    return { provider: 'google-docs', src: `${base}/viewform?embedded=true` };
  }
  if (h === 'drive.google.com') {
    const m = /^\/file\/d\/([\w-]+)/.exec(u.pathname) ?? (u.pathname === '/open' ? [null, u.searchParams.get('id')] : null);
    if (!m || !m[1] || !/^[\w-]+$/.test(m[1])) return null;
    return { provider: 'google-drive', src: `https://drive.google.com/file/d/${m[1]}/preview` };
  }
  return null;
}

function spotify(u: URL): { src: string; height: number } | null {
  if (host(u) !== 'open.spotify.com') return null;
  const m = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/(\w+)/i.exec(u.pathname);
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  return { src: `https://open.spotify.com/embed/${kind}/${m[2]}`, height: kind === 'track' || kind === 'episode' ? 152 : 352 };
}

const isFrameIo = (u: URL) => {
  const h = host(u);
  return h === 'f.io' || h === 'frame.io' || h.endsWith('.frame.io');
};

/** Recognised provider of a URL (frameio = not embeddable → bookmark; generic = any other https page). */
export function detectProvider(raw: string): ProviderInfo | null {
  const u = parseHttps(raw);
  if (!u) return null;
  if (youtube(u)) return { provider: 'youtube', label: PROVIDER_LABELS.youtube, defaultHeight: 0 };
  if (vimeo(u)) return { provider: 'vimeo', label: PROVIDER_LABELS.vimeo, defaultHeight: 0 };
  if (loom(u)) return { provider: 'loom', label: PROVIDER_LABELS.loom, defaultHeight: 0 };
  if (figma(u)) return { provider: 'figma', label: PROVIDER_LABELS.figma, defaultHeight: 480 };
  if (googleMaps(u)) return { provider: 'google-maps', label: PROVIDER_LABELS['google-maps'], defaultHeight: 400 };
  const g = google(u);
  if (g) return { provider: g.provider, label: PROVIDER_LABELS[g.provider], defaultHeight: g.provider === 'google-slides' ? 0 : 520 };
  const s = spotify(u);
  if (s) return { provider: 'spotify', label: PROVIDER_LABELS.spotify, defaultHeight: s.height };
  if (isFrameIo(u)) return { provider: 'frameio', label: PROVIDER_LABELS.frameio, defaultHeight: 0 };
  if (u.protocol === 'https:') return { provider: 'generic', label: PROVIDER_LABELS.generic, defaultHeight: 400 };
  return null;
}

/** True when a known provider (not the generic iframe, not Frame.io) can display the URL. */
export const isKnownEmbeddable = (raw: string) => {
  const p = detectProvider(raw)?.provider;
  return !!p && p !== 'generic' && p !== 'frameio';
};

/**
 * iframe source for a stored embed, or null if it cannot be framed (→ link card). `origin`: the
 * app's own origin, never framed as a generic page (QA-WEB-14, see frameGuards.ts).
 */
export function embedSource(raw: string, provider: string, origin = appOrigin()): string | null {
  const u = parseHttps(raw);
  if (!u) return null;
  switch (provider as EmbedProvider) {
    case 'youtube':
      return youtube(u);
    case 'vimeo':
      return vimeo(u);
    case 'loom':
      return loom(u);
    case 'figma':
      return figma(u);
    case 'google-maps':
      return googleMaps(u);
    case 'google-docs':
    case 'google-sheets':
    case 'google-slides':
    case 'google-drive':
      return google(u)?.src ?? null;
    case 'spotify':
      return spotify(u)?.src ?? null;
    case 'generic':
      return u.protocol === 'https:' && !isAppOrigin(u.href, origin) ? u.href : null;
    default:
      return null;
  }
}

/** Lone URL (pasted text) or null. */
export function asLoneUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t) || t.length > 2000) return null;
  const u = parseHttps(t);
  return u && u.hostname.includes('.') ? u.href : null;
}

export function hostLabel(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}
