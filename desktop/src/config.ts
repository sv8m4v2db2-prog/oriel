// Persistent desktop settings: <userData>/config.json
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { validateAccelerator } from './accelerator';
import type { DesktopMode } from './ipc';
import { sanitizeSession, type SavedSession } from './session';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface DesktopConfig {
  mode?: DesktopMode;
  /** Origin of the remote server, e.g. "https://notes.mondomaine.fr". */
  serverUrl?: string;
  /** Last servers used (most recent first), offered in the setup screen. */
  recentServers?: string[];
  /**
   * Port used by the embedded server last time. Reused when free so that the local origin
   * (and therefore the browser storage: offline cache, preferences) stays the same across launches.
   */
  localPort?: number;
  windowBounds?: WindowBounds;
  /** Quick search window (global shortcut). Absent = enabled with the default shortcut. */
  quickSearch?: { enabled: boolean; accelerator: string };
  /** Spell checking in text fields. Absent = enabled. */
  spellcheck?: boolean;
  /** Dictionaries for Windows/Linux (macOS detects the language itself). */
  spellLanguages?: string[];
  /** Unread count on the Dock icon. Absent = enabled. */
  dockBadge?: boolean;
  /** Reopen the windows and tabs of the last session at launch. Absent = enabled. */
  restoreSession?: boolean;
  /** Windows and tabs open when the app last ran. */
  session?: SavedSession;
}

const MAX_RECENT = 5;

let current: DesktopConfig | null = null;

export const configPath = () => path.join(app.getPath('userData'), 'config.json');

export function getConfig(): DesktopConfig {
  if (!current) current = load();
  return current;
}

export function updateConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  current = sanitize({ ...getConfig(), ...patch });
  save(current);
  return current;
}

/** Puts `url` first in the recent servers list. */
export function rememberServer(url: string): void {
  const recent = [url, ...(getConfig().recentServers ?? []).filter((u) => u !== url)].slice(0, MAX_RECENT);
  updateConfig({ recentServers: recent });
}

function load(): DesktopConfig {
  try {
    return sanitize(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] configuration illisible (${configPath()}), valeurs par défaut utilisées :`, err);
    }
    return {};
  }
}

function save(config: DesktopConfig): void {
  const file = configPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[config] écriture impossible :', err);
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitize(raw: unknown): DesktopConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: DesktopConfig = {};
  if (input.mode === 'remote' || input.mode === 'local') out.mode = input.mode;
  if (isHttpUrl(input.serverUrl)) out.serverUrl = new URL(input.serverUrl).origin;
  if (out.mode === 'remote' && !out.serverUrl) delete out.mode;
  if (Array.isArray(input.recentServers)) {
    out.recentServers = input.recentServers.filter(isHttpUrl).slice(0, MAX_RECENT);
  }
  if (Number.isInteger(input.localPort) && (input.localPort as number) >= 1024 && (input.localPort as number) <= 65535) {
    out.localPort = input.localPort as number;
  }
  const q = input.quickSearch as Record<string, unknown> | undefined;
  if (q && typeof q.enabled === 'boolean') {
    const checked = validateAccelerator(q.accelerator);
    if (checked.ok) out.quickSearch = { enabled: q.enabled, accelerator: checked.accelerator };
  }
  if (typeof input.spellcheck === 'boolean') out.spellcheck = input.spellcheck;
  if (typeof input.dockBadge === 'boolean') out.dockBadge = input.dockBadge;
  if (typeof input.restoreSession === 'boolean') out.restoreSession = input.restoreSession;
  if (
    Array.isArray(input.spellLanguages) &&
    input.spellLanguages.length <= 8 &&
    input.spellLanguages.every((l) => typeof l === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(l))
  ) {
    out.spellLanguages = input.spellLanguages as string[];
  }
  const session = sanitizeSession(input.session);
  if (session) out.session = session;
  const b = input.windowBounds as Record<string, unknown> | undefined;
  if (b && isFiniteNumber(b.width) && isFiniteNumber(b.height) && b.width >= 200 && b.height >= 200) {
    out.windowBounds = { width: Math.round(b.width), height: Math.round(b.height) };
    if (isFiniteNumber(b.x) && isFiniteNumber(b.y)) {
      out.windowBounds.x = Math.round(b.x);
      out.windowBounds.y = Math.round(b.y);
    }
    if (b.maximized === true) out.windowBounds.maximized = true;
  }
  return out;
}
