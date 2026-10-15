// Theme preference (clair / sombre / système), persisted in localStorage `oriel:theme`
// and applied as <html data-theme="light|dark">. index.html applies it before first paint.
import { createStore, storage, useStore } from './store';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'oriel:theme';

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readPreference(): ThemePreference {
  const v = storage.get(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

const initialPref = readPreference();
export const themeStore = createStore({ preference: initialPref, resolved: resolve(initialPref) });

function apply() {
  const { resolved } = themeStore.get();
  document.documentElement.setAttribute('data-theme', resolved);
}

export function setThemePreference(preference: ThemePreference) {
  storage.set(KEY, preference);
  themeStore.set({ preference, resolved: resolve(preference) });
  apply();
}

export function toggleTheme() {
  setThemePreference(themeStore.get().resolved === 'dark' ? 'light' : 'dark');
}

export function initTheme() {
  apply();
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => {
      const { preference } = themeStore.get();
      if (preference === 'system') {
        themeStore.set({ preference, resolved: resolve(preference) });
        apply();
      }
    });
  } catch {
    /* old browsers */
  }
  // Another tab changed the preference.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      const pref = readPreference();
      themeStore.set({ preference: pref, resolved: resolve(pref) });
      apply();
    }
  });
}

export function useTheme() {
  return useStore(themeStore);
}
