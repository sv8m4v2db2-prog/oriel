// Reachability check of a Oriel server through GET /api/health (shared HealthResponse).
import { net } from 'electron';
import { describeHttpStatus, describeNetError } from './urls';

export type HealthResult =
  | { ok: true; origin: string; version: string | null }
  | { ok: false; error: string; code: string | null };

export async function checkHealth(origin: string, timeoutMs = 8000): Promise<HealthResult> {
  let res: Response;
  try {
    res = await net.fetch(`${origin}/api/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const { message, code } = describeNetError(err);
    return { ok: false, error: message, code };
  }
  const finalOrigin = (() => {
    try {
      return new URL(res.url || origin).origin;
    } catch {
      return origin;
    }
  })();
  if (!res.ok) {
    return { ok: false, error: describeHttpStatus(res.status), code: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const health = body as { ok?: unknown; version?: unknown } | null;
  if (!health || health.ok !== true) {
    return {
      ok: false,
      error: 'Ce serveur répond, mais ce n’est pas un serveur Oriel (réponse inattendue de /api/health).',
      code: 'NOT_ORIEL',
    };
  }
  return { ok: true, origin: finalOrigin, version: typeof health.version === 'string' ? health.version : null };
}
