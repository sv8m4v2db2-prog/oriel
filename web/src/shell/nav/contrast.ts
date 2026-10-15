// High contrast preference (navigation module, N11), per device: localStorage `oriel:contrast`,
// applied as <html data-contrast="high"> on top of the light / dark theme (public/theme-init.js
// applies it before the first paint). Tokens: contrast.css, imported by App.tsx.
import { createStore, storage, useStore } from '../../lib/store';

const KEY = 'oriel:contrast';

export const contrastStore = createStore<{ high: boolean }>({ high: storage.get(KEY) === 'high' });

function apply() {
  if (typeof document === 'undefined') return;
  if (contrastStore.get().high) document.documentElement.setAttribute('data-contrast', 'high');
  else document.documentElement.removeAttribute('data-contrast');
}

export function setHighContrast(high: boolean) {
  storage.set(KEY, high ? 'high' : 'normal');
  contrastStore.set({ high });
  apply();
}

export function initContrast() {
  apply();
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      contrastStore.set({ high: e.newValue === 'high' });
      apply();
    }
  });
}

export const useHighContrast = () => useStore(contrastStore).high;

/** WCAG relative luminance of an opaque #rrggbb color. */
export function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
