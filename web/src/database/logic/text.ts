// Text helpers shared by the logic modules.
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** French, case-insensitive, numeric-aware comparison. */
export const collatorCompare = (a: string, b: string) => collator.compare(a, b);

/** Normalizes text for case- and accent-insensitive comparisons. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('fr');
}
