// Chart colors: option colors (entity) or the categorical palette in fixed order (CSS variables of
// database.css, stepped separately for the light and dark themes).
import type { Color } from '@oriel/shared';

/** Number of slots of the categorical palette (more series are folded into « Autres »). */
export const PALETTE_SIZE = 8;

/** Fill of a mark: the option's color when it has one, else palette slot `index`. */
export function markFill(color: Color | null | undefined, index: number): string {
  if (color) return `var(--chart-opt-${color})`;
  return `var(--chart-${(Math.max(0, index) % PALETTE_SIZE) + 1})`;
}
