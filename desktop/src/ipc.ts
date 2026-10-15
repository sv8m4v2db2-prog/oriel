// IPC contract between the main process, the preloads and the local pages (setup / status).
// Only plain constants and types live here so that the sandboxed preloads can bundle it.

export type DesktopMode = 'remote' | 'local';

export const IPC = {
  /** App window → main (send): open the server/mode chooser. */
  openSetup: 'oriel:open-setup',

  /** Status page → main (invoke): what to display. */
  statusGet: 'oriel:status:get',
  /** Status page → main (invoke): try to reach the server again. */
  statusRetry: 'oriel:status:retry',
  /** Status page → main (send): open the server/mode chooser. */
  statusChangeServer: 'oriel:status:change-server',

  /** Setup page → main (invoke). */
  setupState: 'oriel:setup:state',
  setupTest: 'oriel:setup:test',
  setupConnect: 'oriel:setup:connect',
  setupUseLocal: 'oriel:setup:use-local',
  /** Setup page → main (send): close the chooser without changing anything. */
  setupCancel: 'oriel:setup:cancel',

  /** App page → main (send): unread notification count for the Dock badge. */
  badgeSet: 'oriel:badge:set',
  /** App page → main (invoke): desktop-only preferences. */
  prefsGet: 'oriel:prefs:get',
  prefsSet: 'oriel:prefs:set',

  /** Tab bar page → main. */
  tabsGet: 'oriel:tabs:get',
  tabsSelect: 'oriel:tabs:select',
  tabsClose: 'oriel:tabs:close',
  tabsNew: 'oriel:tabs:new',
  tabsMove: 'oriel:tabs:move',
  tabsDetach: 'oriel:tabs:detach',
  tabsMenu: 'oriel:tabs:menu',
  /** Main → tab bar page: the tab list changed. */
  tabsState: 'oriel:tabs:state',

  /** Quick search page → main. */
  quickSearch: 'oriel:quick:search',
  quickOpen: 'oriel:quick:open',
  quickCreate: 'oriel:quick:create',
  quickClose: 'oriel:quick:close',
  /** Main → quick search page: the window was (re)shown, start from scratch. */
  quickReset: 'oriel:quick:reset',
} as const;

export type TabColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'gray';
export const TAB_COLORS: readonly TabColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/** What the tab bar page displays. */
export interface TabsState {
  tabs: Array<{ id: string; title: string; color: TabColor | null; active: boolean; loading: boolean }>;
  fullScreen: boolean;
}

/** Desktop-only preferences (Réglages › Application of the web app). */
export interface DesktopPrefs {
  quickSearchEnabled: boolean;
  /** Electron accelerator, e.g. "Control+Alt+Space". */
  quickSearchShortcut: string;
  dockBadge: boolean;
  spellcheck: boolean;
  restoreSession: boolean;
  /** Dictionaries (Windows/Linux only). `null` on macOS, where the system detects the language. */
  spellLanguages: string[] | null;
  availableSpellLanguages: string[];
  platform: string;
}

export interface PrefsResult {
  ok: boolean;
  prefs: DesktopPrefs;
  error?: string;
}

export interface QuickResult {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  /** Ancestors, joined with " / ". */
  path: string;
  snippet: string;
}

export interface QuickSearchReply {
  ok: boolean;
  /** Human readable French message when `ok` is false (signed out, offline…). */
  error?: string;
  results: QuickResult[];
  /** True when the query was empty and the list shows recent pages. */
  recent: boolean;
  workspaceId: string | null;
}

export interface QuickOpenReply {
  ok: boolean;
  error?: string;
}

/** Content of the local status page shown in an app window instead of the web app. */
export interface StatusInfo {
  kind: 'starting' | 'offline';
  mode: DesktopMode;
  /** Host shown to the user (e.g. "notes.mondomaine.fr" or "ce Mac"). */
  serverLabel: string;
  /** Human readable French explanation of the failure. */
  error: string | null;
  /** Technical code (ERR_NAME_NOT_RESOLVED, HTTP 502…). */
  errorCode: string | null;
}

export interface RetryResult {
  ok: boolean;
  error?: string;
  errorCode?: string;
}

export interface SetupState {
  /** No mode chosen yet (first launch). */
  firstRun: boolean;
  mode: DesktopMode | null;
  serverUrl: string | null;
  recentServers: string[];
  /** Where local-mode data lives, with the home folder abbreviated as "~". */
  localDataDir: string;
  /** False when the embedded server is missing from this build. */
  localAvailable: boolean;
  version: string;
}

export interface TestResult {
  ok: boolean;
  /** Normalised server origin (after redirects). */
  url?: string;
  /** Oriel version reported by /api/health. */
  version?: string;
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}
