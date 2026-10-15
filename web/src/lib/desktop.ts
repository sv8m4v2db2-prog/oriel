// Integration with the macOS shell (Electron preload exposes `window.orielDesktop`).

export interface OrielDesktopBridge {
  platform: 'darwin';
  isDesktop: true;
  mode: 'remote' | 'local';
  /** Re-open the first-launch screen (server URL / local mode). */
  openSetup(): void;
  /** App with the native tab bar (absent from older builds: feature-detect the members below). */
  hasTabs?: true;
  /** Unread notifications for the Dock icon (integer 0…99 999; 0 clears it). */
  setBadge?(count: number): void;
  getPrefs?(): Promise<DesktopPrefs>;
  setPrefs?(patch: Partial<DesktopPrefs>): Promise<{ ok: boolean; prefs: DesktopPrefs; error?: string }>;
}

/** Preferences owned by the app (desktop/src/ipc.ts is the source of truth). */
export interface DesktopPrefs {
  quickSearchEnabled: boolean;
  quickSearchShortcut: string;
  dockBadge: boolean;
  spellcheck: boolean;
  restoreSession: boolean;
  /** `null` on macOS: the system checker detects the language. */
  spellLanguages: string[] | null;
  availableSpellLanguages: string[];
  platform: string;
}

declare global {
  interface Window {
    orielDesktop?: OrielDesktopBridge;
  }
}

export const desktop: OrielDesktopBridge | null =
  typeof window !== 'undefined' && window.orielDesktop ? window.orielDesktop : null;

export const isDesktop = desktop !== null;
export const isLocalDesktop = desktop?.mode === 'local';

export function initDesktop() {
  if (desktop) document.documentElement.classList.add('is-desktop');
}
