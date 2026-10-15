// Validation of everything that crosses the IPC boundary. Pure (no Electron import) so that it can
// be unit-tested. Every parser returns `null` (or an error) instead of throwing: the caller refuses.
import { validateAccelerator } from './accelerator';
import { TAB_COLORS, type DesktopPrefs, type TabColor } from './ipc';

export const MAX_BADGE = 99_999;
export const MAX_QUERY_LENGTH = 200;
export const MAX_TITLE_LENGTH = 200;

/** Unread count for the Dock badge: a safe integer in [0, MAX_BADGE], otherwise rejected. */
export function parseBadgeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  return value >= 0 && value <= MAX_BADGE ? value : null;
}

/** Text shown on the Dock icon ("" clears it). */
export function badgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Page / workspace / tab identifier (opaque). */
export function parseId(value: unknown): string | null {
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

/** Tab position: integer in [0, max]. */
export function parseIndex(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 0 && value <= max ? value : null;
}

export function parseColor(value: unknown): TabColor | null {
  return typeof value === 'string' && (TAB_COLORS as readonly string[]).includes(value) ? (value as TabColor) : null;
}

/** Screen coordinate (finite number within a sane range). */
export function parseCoordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 100_000 ? Math.round(value) : null;
}

/** Search text typed in the quick search window: string, control characters removed, trimmed. */
export function parseQuery(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH * 2) return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length <= MAX_QUERY_LENGTH ? text : null;
}

/** Title of a page created from the quick search window. */
export function parseTitle(value: unknown): string | null {
  const text = parseQuery(value);
  return text !== null && text.length > 0 && text.length <= MAX_TITLE_LENGTH ? text : null;
}

const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

export type PrefsPatch = Partial<
  Pick<DesktopPrefs, 'quickSearchEnabled' | 'quickSearchShortcut' | 'dockBadge' | 'spellcheck' | 'restoreSession'>
> & { spellLanguages?: string[] };

/**
 * `setPrefs` argument: only known keys, strict types. Unknown keys, wrong types or an invalid
 * accelerator reject the whole patch (never a partial application).
 */
export function parsePrefsPatch(value: unknown): { ok: true; patch: PrefsPatch } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Réglages invalides.' };
  const input = value as Record<string, unknown>;
  const patch: PrefsPatch = {};
  for (const [key, v] of Object.entries(input)) {
    switch (key) {
      case 'quickSearchEnabled':
      case 'dockBadge':
      case 'spellcheck':
      case 'restoreSession':
        if (typeof v !== 'boolean') return { ok: false, error: 'Réglages invalides.' };
        patch[key] = v;
        break;
      case 'quickSearchShortcut': {
        const checked = validateAccelerator(v);
        if (!checked.ok) return { ok: false, error: checked.error };
        patch.quickSearchShortcut = checked.accelerator;
        break;
      }
      case 'spellLanguages':
        if (!Array.isArray(v) || v.length > 8 || !v.every((l) => typeof l === 'string' && LANGUAGE_RE.test(l))) {
          return { ok: false, error: 'Langues invalides.' };
        }
        patch.spellLanguages = [...new Set(v as string[])];
        break;
      default:
        return { ok: false, error: 'Réglage inconnu.' };
    }
  }
  return { ok: true, patch };
}
