// Verification property (D21, SPEC §5.9): derived state, labels and expiry presets. DOM-free (tests
// under Node). The stored value is stamped by the server (who, when); only the expiry comes from here.
import type { VerificationValue } from '@oriel/shared';

export type VerificationState = 'verified' | 'expired' | 'none';

export const VERIFICATION_STATE_LABELS: Record<VerificationState, string> = {
  verified: 'Vérifiée',
  expired: 'À revérifier',
  none: 'Non vérifiée',
};

export type ExpiryPreset = 'none' | 'week' | 'month' | 'quarter' | 'year';

export const EXPIRY_PRESETS: Array<{ id: ExpiryPreset; label: string }> = [
  { id: 'none', label: 'Sans expiration' },
  { id: 'week', label: 'Une semaine' },
  { id: 'month', label: 'Un mois' },
  { id: 'quarter', label: 'Trois mois' },
  { id: 'year', label: 'Un an' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day 'YYYY-MM-DD'. */
export const localDay = (d: Date = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function asVerification(v: unknown): VerificationValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Partial<VerificationValue>;
  if (typeof x.verifiedBy !== 'string' || typeof x.verifiedAt !== 'string') return null;
  return { verifiedBy: x.verifiedBy, verifiedAt: x.verifiedAt, expiresAt: typeof x.expiresAt === 'string' ? x.expiresAt : null };
}

/** Verified until the end of its expiry day; past it, « À revérifier ». */
export function verificationState(v: unknown, today: string = localDay()): VerificationState {
  const x = asVerification(v);
  if (!x) return 'none';
  return x.expiresAt && x.expiresAt < today ? 'expired' : 'verified';
}

/** Option id used by filters ('verified' / 'expired'), null when not verified. */
export function verificationOptionId(v: unknown, today?: string): string | null {
  const s = verificationState(v, today);
  return s === 'none' ? null : s;
}

/** Text form (display, CSV, formulas): the state, empty when not verified. */
export function verificationText(v: unknown, today?: string): string {
  const s = verificationState(v, today);
  return s === 'none' ? '' : VERIFICATION_STATE_LABELS[s];
}

/** Sort rank: verified first, then to re-verify; unverified rows have no key (sorted last). */
export function verificationRank(v: unknown, today?: string): number | null {
  const s = verificationState(v, today);
  return s === 'verified' ? 0 : s === 'expired' ? 1 : null;
}

/** Expiry day of a preset counted from `from` (null = no expiry). Month ends are clamped (31/01 + 1 mois → 28/02). */
export function expiryFrom(preset: ExpiryPreset, from: Date = new Date()): string | null {
  if (preset === 'none') return null;
  if (preset === 'week') return localDay(new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7));
  const months = preset === 'month' ? 1 : preset === 'quarter' ? 3 : 12;
  const target = new Date(from.getFullYear(), from.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return localDay(new Date(target.getFullYear(), target.getMonth(), Math.min(from.getDate(), lastDay)));
}
