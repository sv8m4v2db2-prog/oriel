// Pure helpers (no Electron import) for server addresses and network error messages.

const LOCAL_HOST_RE =
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^.]+\.(?:local|lan|home|internal|localhost|test))(?::\d+)?(?:[/?#]|$)/i;

/**
 * Turns what the user typed into a server origin:
 *  "notes.exemple.fr"              → "https://notes.exemple.fr"
 *  "192.168.1.20:3000"             → "http://192.168.1.20:3000"
 *  "https://notes.exemple.fr/w/x"  → "https://notes.exemple.fr" (the SPA lives at the root)
 * Returns null when the input cannot be a web address.
 */
export function normalizeServerUrl(input: string): string | null {
  let text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hadScheme) {
    // LAN names, private addresses and single-label hosts ("nas:3000") rarely have a certificate.
    const local = LOCAL_HOST_RE.test(text) || /^[^.:/?#]+:\d+(?:[/?#]|$)/.test(text);
    text = `${local ? 'http' : 'https'}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !url.hostname) return null;
  const singleLabel = !url.hostname.includes('.') && url.hostname !== 'localhost' && !url.hostname.startsWith('[');
  if (!hadScheme && singleLabel && !url.port) return null;
  return url.origin;
}

/** Origin of a URL, or null (blob: URLs resolve to their inner origin). */
export function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function sameOrigin(url: string, origin: string | null): boolean {
  return !!origin && originOf(url) === origin;
}

/** Schemes we hand over to the operating system. */
export function isExternalScheme(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Main-process check of an IPC sender frame (QA-G10-03): its URL *and* its real origin must be the
 * Oriel server. A document served by the instance with a `sandbox` CSP (opaque origin "null",
 * e.g. the HTML block frame) has the server URL but must not reach the bridge.
 */
export function isTrustedAppFrame(frameUrl: string, frameOrigin: string, serverOrigin: string | null): boolean {
  return !!serverOrigin && frameOrigin === serverOrigin && sameOrigin(frameUrl, serverOrigin);
}

export type WindowOpenAction = { kind: 'tab'; activate: boolean } | { kind: 'window' } | { kind: 'external' } | { kind: 'deny' };

/**
 * Policy of `setWindowOpenHandler` for the tabs (QA-G10-01). No child window is ever created:
 * Oriel URLs become tabs or app windows, http(s)/mailto/tel go to the system, everything else
 * (about:blank written by a third-party embed, javascript:, file:, data:, custom schemes) is refused.
 */
export function windowOpenAction(url: string, disposition: string, serverOrigin: string | null): WindowOpenAction {
  if (sameOrigin(url, serverOrigin)) {
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      return { kind: 'tab', activate: disposition === 'foreground-tab' };
    }
    return { kind: 'window' };
  }
  return isExternalScheme(url) ? { kind: 'external' } : { kind: 'deny' };
}

const NET_ERRORS: Array<[RegExp, string]> = [
  [/ERR_INTERNET_DISCONNECTED/, 'Ce Mac n’est pas connecté à internet.'],
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, 'Adresse introuvable : vérifiez le nom de domaine (DNS).'],
  [/ERR_CONNECTION_REFUSED/, 'Le serveur refuse la connexion : Oriel est-il bien démarré ?'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|TimeoutError|AbortError/, 'Le serveur ne répond pas (délai dépassé).'],
  [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_ABORTED/, 'La connexion avec le serveur a été interrompue.'],
  [/ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_ACCESS_DENIED/, 'Le serveur est inaccessible depuis ce réseau.'],
  [/ERR_NETWORK_CHANGED/, 'Le réseau a changé pendant la connexion.'],
  [/ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED/, 'Le proxy réseau ne répond pas.'],
  [/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/, 'Le certificat HTTPS du serveur n’est pas valide.'],
  [/ERR_TOO_MANY_REDIRECTS/, 'Le serveur redirige en boucle.'],
];

/** French message for a Chromium network error name (e.g. "ERR_NAME_NOT_RESOLVED") or an Error. */
export function describeNetError(error: unknown): { message: string; code: string | null } {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
        : String(error);
  const code = /(ERR_[A-Z_]+)/.exec(text)?.[1] ?? (/TimeoutError|AbortError/.test(text) ? 'ERR_TIMED_OUT' : null);
  for (const [re, message] of NET_ERRORS) if (re.test(text)) return { message, code };
  return { message: 'Le serveur est injoignable.', code };
}

export function describeHttpStatus(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `Le serveur Oriel ne répond pas derrière le proxy (HTTP ${status}).`;
  }
  return `Le serveur a répondu avec une erreur (HTTP ${status}).`;
}

/**
 * Downloads are limited to the configured Oriel instance: every URL of the chain (redirects
 * included) must share the server origin. `blob:` URLs created by its pages resolve to that origin.
 */
export function isDownloadAllowed(urlChain: readonly string[], serverOrigin: string | null): boolean {
  if (!serverOrigin || urlChain.length === 0) return false;
  return urlChain.every((url) => sameOrigin(url, serverOrigin));
}

/** File name proposed in the save dialog: base name only, no control or path characters. */
export function safeFileName(name: string): string {
  // Control, format (bidi overrides, zero-width…) and line/paragraph separators (QA-G10-05).
  const base = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim().slice(0, 180);
  return cleaned || 'téléchargement';
}
