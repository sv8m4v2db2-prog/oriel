// Minimal dnd-kit modifiers (the @dnd-kit/modifiers package is not a dependency).
import type { Modifier } from '@dnd-kit/core';

export function restrictToAxis(axis: 'x' | 'y'): Modifier {
  return ({ transform }) => (axis === 'x' ? { ...transform, y: 0 } : { ...transform, x: 0 });
}
