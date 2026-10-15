// Saved session (windows + tabs) and the closed-tabs stack. Pure: no Electron import.
//
// Only *internal paths* are persisted ("/w/<id>/p/<id>"), never an origin: the origin of the local
// mode can change between launches, and a path cannot point at another site. Pages carrying a
// secret in the URL (invitation, password reset…) are never saved.
import { TAB_COLORS, type TabColor } from './ipc';

export const MAX_SAVED_WINDOWS = 10;
export const MAX_TABS_PER_WINDOW = 40;
export const MAX_PATH_LENGTH = 2048;
export const MAX_CLOSED_TABS = 25;

export interface SavedTab {
  /** Path + query + hash, starting with a single "/". */
  path: string;
  color?: TabColor;
}

export interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  tabs: SavedTab[];
  /** Index of the active tab in `tabs`. */
  active: number;
  bounds?: SavedBounds;
}

export interface SavedSession {
  /** Which server this session belongs to: "local" or the remote origin. */
  origin: string;
  windows: SavedWindow[];
}

/** Routes that must not be restored: they hold a token, or they are transient screens. */
const EXCLUDED_PREFIXES = ['/login', '/signup', '/invite', '/forgot-password', '/reset-password'];

export function isRestorablePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const pathname = path.replace(/[?#].*$/, '');
  return !EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Internal path of `url` if it belongs to `origin` and may be restored, otherwise null. */
export function restorablePathOf(url: string | null | undefined, origin: string | null): string | null {
  if (!url || !origin) return null;
  try {
    const u = new URL(url);
    if (u.origin !== origin) return null;
    const path = u.pathname + u.search + u.hash;
    return isRestorablePath(path) ? path : null;
  } catch {
    return null;
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Defensive parse of the `session` key of config.json (the file is user-editable). */
export function sanitizeSession(raw: unknown): SavedSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  if (typeof input.origin !== 'string' || input.origin.length === 0 || input.origin.length > 300) return undefined;
  if (!Array.isArray(input.windows)) return undefined;
  const windows: SavedWindow[] = [];
  for (const w of input.windows.slice(0, MAX_SAVED_WINDOWS)) {
    if (!w || typeof w !== 'object') continue;
    const win = w as Record<string, unknown>;
    if (!Array.isArray(win.tabs)) continue;
    const tabs: SavedTab[] = [];
    for (const t of win.tabs.slice(0, MAX_TABS_PER_WINDOW)) {
      if (!t || typeof t !== 'object') continue;
      const tab = t as Record<string, unknown>;
      if (!isRestorablePath(tab.path)) continue;
      const saved: SavedTab = { path: tab.path };
      if (typeof tab.color === 'string' && (TAB_COLORS as readonly string[]).includes(tab.color)) {
        saved.color = tab.color as TabColor;
      }
      tabs.push(saved);
    }
    if (tabs.length === 0) continue;
    const entry: SavedWindow = {
      tabs,
      active: Number.isInteger(win.active) && (win.active as number) >= 0 && (win.active as number) < tabs.length ? (win.active as number) : 0,
    };
    const b = win.bounds as Record<string, unknown> | undefined;
    if (b && isFiniteNumber(b.width) && isFiniteNumber(b.height) && b.width >= 200 && b.height >= 200) {
      entry.bounds = { width: Math.round(b.width), height: Math.round(b.height) };
      if (isFiniteNumber(b.x) && isFiniteNumber(b.y)) {
        entry.bounds.x = Math.round(b.x);
        entry.bounds.y = Math.round(b.y);
      }
    }
    windows.push(entry);
  }
  return { origin: input.origin, windows };
}

/** Key identifying the server a session belongs to (see SavedSession.origin). */
export function sessionKey(mode: 'remote' | 'local' | null | undefined, serverUrl: string | null | undefined): string | null {
  if (mode === 'local') return 'local';
  if (mode === 'remote' && serverUrl) return serverUrl;
  return null;
}

/** Windows to reopen at launch, or null when the saved session does not apply. */
export function sessionToRestore(session: SavedSession | undefined, key: string | null): SavedWindow[] | null {
  if (!session || !key || session.origin !== key || session.windows.length === 0) return null;
  return session.windows;
}

export interface ClosedTab {
  path: string;
  color?: TabColor;
  /** Position the tab had in its window (best effort when reopened). */
  index: number;
}

/** Most recently closed tabs, newest last, bounded. */
export class ClosedTabs {
  private readonly items: ClosedTab[] = [];

  constructor(private readonly max = MAX_CLOSED_TABS) {}

  get size(): number {
    return this.items.length;
  }

  push(tab: ClosedTab): void {
    this.items.push(tab);
    while (this.items.length > this.max) this.items.shift();
  }

  pop(): ClosedTab | undefined {
    return this.items.pop();
  }

  clear(): void {
    this.items.length = 0;
  }
}
