// Pure wording of the block metadata (H5): « Créé par Sam, le 12 oct. 2026 à 14:03 · modifié par Léa, il y a 5 min ».
import type { BlockMeta } from '@oriel/shared';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Absolute date in French, with the year only when it is not the current one. */
export function formatAbsolute(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
  const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(date);
  return `${day} à ${time}`;
}

/** « à l'instant », « il y a 5 min », « il y a 3 h », « hier », then the absolute date. */
export function formatRelative(ms: number, now = Date.now()): string {
  const delta = now - ms;
  if (delta < 45_000) return 'à l’instant';
  if (delta < HOUR) return `il y a ${Math.max(1, Math.round(delta / MINUTE))} min`;
  if (delta < DAY) return `il y a ${Math.round(delta / HOUR)} h`;
  if (delta < 2 * DAY) return 'hier';
  if (delta < 7 * DAY) return `il y a ${Math.round(delta / DAY)} j`;
  return `le ${formatAbsolute(ms, now)}`;
}

export interface BlockMetaLines {
  created: string;
  modified: string | null;
}

/**
 * The two lines shown on hover. An unknown author or date (a block that predates the tracking, an
 * import) never shows a name: « Origine inconnue ».
 */
export function describeBlockMeta(meta: BlockMeta | null | undefined, now = Date.now()): BlockMetaLines {
  if (!meta || (!meta.createdAt && !meta.modifiedAt)) return { created: 'Origine inconnue', modified: null };
  const who = (u: BlockMeta['createdBy']) => (u?.name?.trim() ? u.name.trim().slice(0, 80) : 'un ancien membre');
  const created = meta.createdAt
    ? `Créé par ${who(meta.createdBy)}, ${formatAbsolute(meta.createdAt, now)}`
    : 'Création : origine inconnue';
  const sameAsCreation = !!meta.createdAt && meta.modifiedAt === meta.createdAt && meta.modifiedBy?.id === meta.createdBy?.id;
  const modified = meta.modifiedAt && !sameAsCreation ? `Modifié par ${who(meta.modifiedBy)}, ${formatRelative(meta.modifiedAt, now)}` : null;
  return { created, modified };
}
