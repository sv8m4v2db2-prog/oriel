// HTTP client of the Oriel API authenticated by a personal API token (`Authorization: Bearer or_…`).
// The token is never logged nor included in error messages.
import type { ApiErrorBody } from '@oriel/shared';

export const MCP_VERSION = '0.1.0';

export class OrielApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OrielApiError';
  }
}

export type Fetch = typeof fetch;

/**
 * Path of an API call that stays on the route it names (QA-MCP-01): ids come from the model or from
 * page content, and `fetch` resolves `.` / `..` segments (percent-encoded too) before sending, so
 * `/pages/../pages/<id>/trash` would trash a page from the « restore » tool. Refused: dot segments,
 * backslashes, fragments, whitespace and control characters. Ids are also percent-encoded by the tools.
 */
export function isSafeApiPath(path: string): boolean {
  if (!path.startsWith('/') || /[\\#\s\u0000-\u001f\u007f]/.test(path)) return false;
  const pathname = path.split('?')[0]!;
  return pathname.split('/').every((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    return decoded !== '.' && decoded !== '..' && !/^(\.|%2e){1,2}$/i.test(seg);
  });
}

export interface ClientOptions {
  fetch?: Fetch;
  /** Request timeout (ms). Default 30 s. */
  timeoutMs?: number;
}

export class OrielClient {
  readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    private readonly token: string,
    opts: ClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      'user-agent': `oriel-mcp/${MCP_VERSION}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!isSafeApiPath(path)) throw new OrielApiError(400, 'invalid_path', 'Identifiant invalide (caractères interdits dans un id Oriel).');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timeout = (err as Error)?.name === 'TimeoutError';
      throw new OrielApiError(
        0,
        'network',
        timeout ? `Oriel (${this.baseUrl}) n'a pas répondu à temps.` : `Impossible de joindre Oriel à ${this.baseUrl} : vérifiez ORIEL_URL et la connexion.`,
      );
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as ApiErrorBody | undefined)?.error;
      throw new OrielApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur HTTP ${res.status}`);
    }
    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body);
  }
  del<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

/** French explanation of an API error for Claude (with what to do next). */
export function explainError(err: unknown): string {
  if (err instanceof OrielApiError) {
    if (err.status === 401) return "Jeton d'API refusé (invalide, expiré ou révoqué). Créez-en un nouveau dans Oriel › Réglages › API et MCP, puis mettez à jour ORIEL_TOKEN.";
    if (err.status === 403 && /lecture seule/i.test(err.message)) {
      return `${err.message} (Ce serveur MCP ne peut que lire : demandez à l'utilisateur un jeton « Lecture et écriture » s'il souhaite des modifications.)`;
    }
    if (err.status === 404) return `${err.message} (Introuvable, ou hors de l'espace autorisé pour ce jeton.)`;
    if (err.status === 429) return `${err.message}`;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
