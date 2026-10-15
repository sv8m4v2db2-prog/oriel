// Oriel for macOS — Electron main process.
//
// Two modes (ARCHITECTURE §5, SPEC §10):
//   • remote — windows load the configured Oriel server (https://notes.example.org)
//   • local  — an embedded Oriel server runs in a utility process on 127.0.0.1 and the windows
//              load it; data lives in ~/Library/Application Support/Oriel/data
// The first launch (no mode yet) shows the setup window.
//
// Window model (DESKTOP.md §4.1): an app window is a BrowserWindow whose own page is the native tab
// bar (tabs.html); every tab is a WebContentsView stacked below it. All the guards that used to
// protect the single window (navigation, window.open, outage detection, permissions) are applied to
// each tab. Tabs are tracked by webContents id (never BrowserWindow.fromWebContents).
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  session,
  shell,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_QUICK_ACCELERATOR } from './accelerator';
import { fitOnScreen, initialBounds, MIN_WINDOW_SIZE, trackBounds } from './bounds';
import { getConfig, rememberServer, updateConfig } from './config';
import { attachContextMenu } from './contextMenu';
import { Downloads } from './downloads';
import { checkHealth } from './health';
import {
  IPC,
  TAB_COLORS,
  type ActionResult,
  type DesktopMode,
  type DesktopPrefs,
  type PrefsResult,
  type RetryResult,
  type SetupState,
  type StatusInfo,
  type TabColor,
  type TabsState,
  type TestResult,
} from './ipc';
import { LocalServer, LocalServerError } from './localServer';
import { buildAppMenu, buildDockMenu, type MenuActions } from './menu';
import { paths, tildify } from './paths';
import { QuickSearch } from './quickSearch';
import {
  ClosedTabs,
  MAX_SAVED_WINDOWS,
  restorablePathOf,
  sessionKey,
  sessionToRestore,
  type SavedSession,
  type SavedWindow,
} from './session';
import { indexAfterClose, indexForShortcut, moveItem, neighbourIndex, tabLabel } from './tabsLogic';
import {
  describeHttpStatus,
  describeNetError,
  isExternalScheme,
  isTrustedAppFrame,
  normalizeServerUrl,
  sameOrigin,
  windowOpenAction,
} from './urls';
import {
  badgeLabel,
  parseBadgeCount,
  parseColor,
  parseCoordinate,
  parseId,
  parseIndex,
  parsePrefsPatch,
  type PrefsPatch,
} from './validate';

/** Opened by Aide › Documentation. Update if the project moves. */
const DOCS_URL = 'https://github.com/oriel-app/oriel/tree/main/docs';
/** Position of the macOS "traffic lights" on the setup window. */
const TRAFFIC_LIGHTS = { x: 16, y: 16 } as const;
/** In app windows the lights sit in the tab bar (TAB_BAR_HEIGHT, assets/tabs.css). */
const TAB_BAR_LIGHTS = { x: 16, y: 13 } as const;
const TAB_BAR_HEIGHT = 40;
const AUTO_RESTARTS_PER_MINUTE = 2;
const SESSION_SAVE_DELAY_MS = 600;

// Development runs (`npm run desktop:dev`) get their own profile: they never touch the data or the
// settings of an installed Oriel.app. Must happen before the single-instance lock.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Oriel (dev)'));
}

interface Tab {
  id: string;
  view: WebContentsView;
  /** Oriel URL this tab should display (restored after an outage). */
  target: string | null;
  /** Path to open once the local server is ready. */
  pendingPath: string;
  /** Non-null while the local status page (starting / offline) is displayed. */
  status: StatusInfo | null;
  /** Drop the status page from the back/forward history once the app is back. */
  clearHistory: boolean;
  title: string;
  color: TabColor | null;
  loading: boolean;
}

interface AppWindowState {
  tabs: Tab[];
  activeId: string | null;
  /** Set when the window is closed on purpose by the app (mode change, last tab closed). */
  discardTabs: boolean;
}

const localServer = new LocalServer();
const appWindows = new Map<BrowserWindow, AppWindowState>();
/** webContents.id → owning window and tab. */
const tabsByContents = new Map<number, { win: BrowserWindow; tab: Tab }>();
const closedTabs = new ClosedTabs();
/** Origin of the Oriel server shown in the app windows (null while the local server starts). */
let serverOrigin: string | null = null;
let setupWindow: BrowserWindow | null = null;
let lastFocusedAppWindow: BrowserWindow | null = null;
let localStart: Promise<void> | null = null;
let localDialogOpen = false;
let quitting = false;
let readyToQuit = false;
let sessionFrozen = false;
let sessionTimer: NodeJS.Timeout | null = null;
let quick: QuickSearch | null = null;
let downloads: Downloads | null = null;
const badgeCounts = new Map<number, number>();
const recentCrashes: number[] = [];

const statusPageUrl = pathToFileURL(paths.statusPage).href;
const setupPageUrl = pathToFileURL(paths.setupPage).href;
const tabsPageUrl = pathToFileURL(paths.tabsPage).href;

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

function bootstrap(): void {
  app.setAboutPanelOptions({
    applicationName: 'Oriel',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: '© 2026 Contributeurs d’Oriel · Licence AGPL-3.0',
    credits: 'Espace de travail collaboratif, libre et auto-hébergeable.',
  });

  app.on('second-instance', () => {
    if (!app.isReady()) return;
    const win = focusedAppWindow() ?? setupWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      openDefaultWindow();
    }
  });

  // macOS convention: closing the last window keeps the app in the Dock.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // The open windows are what the next launch restores: save them before they start closing.
    saveSessionNow();
    quitting = true;
  });

  // Stop the embedded server after every window has closed (so pages can flush), then quit.
  app.on('will-quit', (event) => {
    globalShortcut.unregisterAll();
    if (readyToQuit || !localServer.isAlive) return;
    event.preventDefault();
    void localServer.stop().finally(() => {
      readyToQuit = true;
      app.quit();
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(win === setupWindow ? setupBackground() : appBackground());
    }
    for (const { tab } of tabsByContents.values()) tab.view.setBackgroundColor(appBackground());
  });

  localServer.on('crash', (code) => {
    if (quitting) return;
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length > 0 && now - recentCrashes[0]! > 60_000) recentCrashes.shift();
    if (recentCrashes.length <= AUTO_RESTARTS_PER_MINUTE) {
      void startLocalServer();
    } else {
      void localServerDialog(
        'Le serveur local s’est arrêté de façon inattendue.',
        `Il s’est arrêté plusieurs fois en moins d’une minute (dernier code : ${code}).`,
        localServer.logExcerpt(),
      );
    }
  });

  void app.whenReady().then(() => {
    if (!app.isPackaged) {
      const devIcon = path.resolve(__dirname, '../build/icon.png');
      if (fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
    }
    configureSession();
    setupIntegrations();
    registerIpc();
    refreshMenu();
    app.dock?.setMenu(buildDockMenu(menuActions));
    openDefaultWindow();
    // Dock icon clicked with no window open (registered after the first window to avoid a duplicate).
    // The hidden quick search window is not an app window: count only the real ones.
    app.on('activate', () => {
      if (appWindows.size === 0 && !setupWindow) openDefaultWindow();
    });
  });
}

/** App windows for the configured mode (restoring the last session), or the setup window. */
function openDefaultWindow(): void {
  const config = getConfig();
  if (config.mode === 'remote' && config.serverUrl) {
    serverOrigin = config.serverUrl;
  } else if (config.mode !== 'local') {
    showSetup();
    return;
  }
  const saved =
    config.restoreSession === false
      ? null
      : sessionToRestore(config.session, sessionKey(config.mode, config.serverUrl));
  if (saved && saved.length > 0) {
    for (const win of saved) createAppWindow({ saved: win, cascade: false });
  } else {
    createAppWindow();
  }
}

const currentMode = (): DesktopMode | null => getConfig().mode ?? null;
const appBackground = () => (nativeTheme.shouldUseDarkColors ? '#191a1e' : '#ffffff');
const setupBackground = () => (nativeTheme.shouldUseDarkColors ? '#14171c' : '#f3f6fa');
const isAppUrl = (url: string) => sameOrigin(url, serverOrigin);

function openExternal(url: string): void {
  if (isExternalScheme(url)) void shell.openExternal(url).catch(() => undefined);
}

function serverLabel(): string {
  if (currentMode() === 'local') return 'ce Mac';
  try {
    return new URL(getConfig().serverUrl ?? '').host;
  } catch {
    return 'le serveur';
  }
}

function focusedAppWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && appWindows.has(focused)) return focused;
  if (lastFocusedAppWindow && !lastFocusedAppWindow.isDestroyed() && appWindows.has(lastFocusedAppWindow)) {
    return lastFocusedAppWindow;
  }
  for (const win of appWindows.keys()) if (!win.isDestroyed()) return win;
  return null;
}

function activeTabOf(win: BrowserWindow | null | undefined): Tab | null {
  const state = win ? appWindows.get(win) : undefined;
  return state?.tabs.find((t) => t.id === state.activeId) ?? null;
}

/** Active tab of the window the user is working in. */
function focusedTab(): Tab | null {
  return activeTabOf(focusedAppWindow());
}

const contentsOf = (tab: Tab) => tab.view.webContents;
const workspaceOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return /^\/w\/([^/]+)/.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// App windows
// ---------------------------------------------------------------------------------------------

interface WindowOptions {
  url?: string;
  path?: string;
  cascade?: boolean;
  /** Reopen a saved window (tabs, active tab, geometry). */
  saved?: SavedWindow;
  /** Tab moved here from another window (detach). */
  adopt?: Tab;
  /** Screen position (top-left) for a detached window. */
  at?: { x: number; y: number };
}

function createAppWindow(options: WindowOptions = {}): BrowserWindow | null {
  const mode = currentMode();
  if (!mode) {
    showSetup();
    return null;
  }
  let bounds = initialBounds(options.cascade === false ? null : focusedAppWindow());
  if (options.saved?.bounds) bounds = fitOnScreen(options.saved.bounds, false);
  if (options.at) bounds = { ...bounds, ...clampOrigin(options.at, bounds.width, bounds.height), maximized: false };
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'Oriel',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TAB_BAR_LIGHTS,
    backgroundColor: appBackground(),
    // The window's own page is the tab bar; the tabs are views stacked on top of the rest.
    webPreferences: {
      preload: paths.tabsPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  const state: AppWindowState = { tabs: [], activeId: null, discardTabs: false };
  appWindows.set(win, state);

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (bounds.maximized && !options.adopt) win.maximize();
    win.show();
  };
  win.once('ready-to-show', show);
  setTimeout(show, 2500); // never stay invisible behind a slow first paint

  const relayout = () => layoutWindow(win);
  win.on('resize', relayout);
  win.on('enter-full-screen', () => {
    relayout();
    pushTabsState(win);
  });
  win.on('leave-full-screen', () => {
    relayout();
    pushTabsState(win);
  });
  win.on('focus', () => {
    lastFocusedAppWindow = win;
  });
  win.on('close', () => {
    // Remember what was open (⇧⌘T), unless the app is quitting or discarded the window itself.
    if (quitting || state.discardTabs) return;
    for (const tab of state.tabs) rememberClosed(tab, state.tabs.indexOf(tab));
  });
  win.on('closed', () => {
    appWindows.delete(win);
    if (lastFocusedAppWindow === win) lastFocusedAppWindow = null;
    for (const tab of state.tabs) {
      tabsByContents.delete(contentsOf(tab).id);
      badgeCounts.delete(contentsOf(tab).id);
      if (!contentsOf(tab).isDestroyed()) contentsOf(tab).close();
    }
    applyBadge();
    scheduleSessionSave();
  });
  trackBounds(win);
  win.loadFile(paths.tabsPage).catch(() => undefined);

  if (options.adopt) {
    adoptTab(win, options.adopt);
  } else if (options.saved) {
    options.saved.tabs.forEach((saved, index) => {
      createTab(win, {
        path: saved.path,
        color: saved.color ?? null,
        activate: index === options.saved!.active,
      });
    });
    if (!state.activeId && state.tabs[0]) activateTab(win, state.tabs[0]);
  } else {
    createTab(win, { url: options.url, path: options.path, activate: true });
  }
  return win;
}

/** Keeps a detached window's top-left corner on a display. */
function clampOrigin(at: { x: number; y: number }, width: number, height: number): { x: number; y: number } {
  const probe = fitOnScreen({ x: at.x, y: at.y, width, height }, false);
  return { x: probe.x ?? at.x, y: probe.y ?? at.y };
}

function layoutWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const state = appWindows.get(win);
  if (!state) return;
  const [width, height] = win.getContentSize();
  const rect = { x: 0, y: TAB_BAR_HEIGHT, width: Math.max(0, width!), height: Math.max(0, height! - TAB_BAR_HEIGHT) };
  for (const tab of state.tabs) tab.view.setBounds(rect);
}

function pushTabsState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const state = appWindows.get(win);
  if (!state) return;
  const payload: TabsState = {
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: tabLabel(t.title),
      color: t.color,
      active: t.id === state.activeId,
      loading: t.loading,
    })),
    fullScreen: win.isFullScreen(),
  };
  if (!win.webContents.isDestroyed()) win.webContents.send(IPC.tabsState, payload);
  const active = activeTabOf(win);
  if (active) win.setTitle(tabLabel(active.title));
  scheduleSessionSave();
}

interface TabOptions {
  url?: string;
  path?: string;
  color?: TabColor | null;
  index?: number;
  activate?: boolean;
}

function createTab(win: BrowserWindow, options: TabOptions = {}): Tab | null {
  const state = appWindows.get(win);
  const mode = currentMode();
  if (!state || !mode || win.isDestroyed()) return null;
  const view = new WebContentsView({
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      safeDialogs: true,
      additionalArguments: [`--oriel-mode=${mode}`],
    },
  });
  view.setBackgroundColor(appBackground());
  const tab: Tab = {
    id: randomUUID(),
    view,
    target: null,
    pendingPath: options.path ?? pathOf(options.url) ?? '/',
    status: null,
    clearHistory: false,
    title: '',
    color: options.color ?? null,
    loading: true,
  };
  const index = options.index === undefined ? state.tabs.length : Math.max(0, Math.min(state.tabs.length, options.index));
  state.tabs.splice(index, 0, tab);
  tabsByContents.set(contentsOf(tab).id, { win, tab });
  win.contentView.addChildView(view);
  layoutWindow(win);
  view.setVisible(false);

  guardTab(tab);
  attachContextMenu(contentsOf(tab), () => ownerOf(tab), tabContextHooks(tab));

  if (serverOrigin && (mode === 'remote' || localServer.isRunning)) {
    loadApp(tab, options.url && isAppUrl(options.url) ? options.url : serverOrigin + tab.pendingPath);
  } else {
    showStatus(tab, { kind: 'starting', error: null, errorCode: null });
    void startLocalServer();
  }
  if (options.activate !== false) activateTab(win, tab);
  else pushTabsState(win);
  return tab;
}

/** Moves a tab view (already removed from its previous window) into `win`. */
function adoptTab(win: BrowserWindow, tab: Tab): void {
  const state = appWindows.get(win);
  if (!state) return;
  state.tabs.push(tab);
  tabsByContents.set(contentsOf(tab).id, { win, tab });
  win.contentView.addChildView(tab.view);
  layoutWindow(win);
  activateTab(win, tab);
}

const ownerOf = (tab: Tab): BrowserWindow | null => tabsByContents.get(contentsOf(tab).id)?.win ?? null;

function activateTab(win: BrowserWindow, tab: Tab): void {
  const state = appWindows.get(win);
  if (!state || win.isDestroyed()) return;
  state.activeId = tab.id;
  for (const t of state.tabs) t.view.setVisible(t === tab);
  layoutWindow(win);
  pushTabsState(win);
  if (!win.isDestroyed() && win.isFocused()) contentsOf(tab).focus();
}

function closeTab(win: BrowserWindow, tab: Tab, options: { remember?: boolean } = {}): void {
  const state = appWindows.get(win);
  if (!state) return;
  const index = state.tabs.indexOf(tab);
  if (index < 0) return;
  if (state.tabs.length === 1) {
    win.close(); // remembered by the window's 'close' handler
    return;
  }
  if (options.remember !== false) rememberClosed(tab, index);
  const wasActive = state.activeId === tab.id;
  state.tabs.splice(index, 1);
  tabsByContents.delete(contentsOf(tab).id);
  badgeCounts.delete(contentsOf(tab).id);
  applyBadge();
  win.contentView.removeChildView(tab.view);
  if (!contentsOf(tab).isDestroyed()) contentsOf(tab).close();
  if (wasActive) {
    const next = state.tabs[indexAfterClose(index, state.tabs.length + 1)];
    if (next) activateTab(win, next);
  } else {
    pushTabsState(win);
  }
}

function rememberClosed(tab: Tab, index: number): void {
  const p = restorablePathOf(currentUrlOf(tab), serverOrigin);
  if (p) closedTabs.push({ path: p, color: tab.color ?? undefined, index });
}

/** Where the tab really is (the status page hides the address it will come back to). */
function currentUrlOf(tab: Tab): string | null {
  if (tab.status) return tab.target;
  const url = contentsOf(tab).isDestroyed() ? '' : contentsOf(tab).getURL();
  return url || tab.target;
}

function reopenClosedTab(): void {
  const closed = closedTabs.pop();
  if (!closed) return;
  const win = focusedAppWindow();
  if (!win) {
    createAppWindow({ path: closed.path });
    return;
  }
  createTab(win, { path: closed.path, color: closed.color ?? null, index: closed.index, activate: true });
  win.show();
}

/** Opens a link in a new tab of `win` (⌘-click, context menu). */
function openInTab(win: BrowserWindow | null, url: string, activate: boolean): void {
  if (!win || !isAppUrl(url)) return;
  createTab(win, { url, activate });
}

function detachTab(win: BrowserWindow, tab: Tab, at?: { x: number; y: number }): void {
  const state = appWindows.get(win);
  if (!state || state.tabs.length < 2) return;
  const index = state.tabs.indexOf(tab);
  if (index < 0) return;
  const wasActive = state.activeId === tab.id;
  state.tabs.splice(index, 1);
  tabsByContents.delete(contentsOf(tab).id);
  win.contentView.removeChildView(tab.view);
  if (wasActive) {
    const next = state.tabs[indexAfterClose(index, state.tabs.length + 1)];
    if (next) activateTab(win, next);
  } else {
    pushTabsState(win);
  }
  createAppWindow({ adopt: tab, cascade: !at, at });
}

function loadApp(tab: Tab, url: string): void {
  const wc = contentsOf(tab);
  if (wc.isDestroyed()) return;
  if (tab.status) tab.clearHistory = true;
  tab.status = null;
  tab.target = url;
  // Failures are reported through 'did-fail-load'.
  wc.loadURL(url).catch(() => undefined);
}

function showStatus(tab: Tab, info: Pick<StatusInfo, 'kind' | 'error' | 'errorCode'>): void {
  const wc = contentsOf(tab);
  if (wc.isDestroyed()) return;
  tab.status = { ...info, mode: currentMode() ?? 'remote', serverLabel: serverLabel() };
  wc.loadFile(paths.statusPage).catch(() => undefined);
}

function allTabs(): Tab[] {
  return [...tabsByContents.values()].map((v) => v.tab);
}

function tabContextHooks(tab: Tab) {
  const ses = session.defaultSession;
  const mac = process.platform === 'darwin';
  return {
    isAppUrl,
    openInNewWindow: (url: string) => void createAppWindow({ url }),
    openInNewTab: (url: string) => openInTab(ownerOf(tab), url, true),
    openExternal,
    spell: {
      isEnabled: () => ses.isSpellCheckerEnabled(),
      setEnabled: (enabled: boolean) => setSpellcheck(enabled),
      // macOS: system checker, language detected automatically → no language choice offered.
      languages: mac
        ? undefined
        : {
            current: () => ses.getSpellCheckerLanguages(),
            available: () => ses.availableSpellCheckerLanguages,
            set: (languages: string[]) => setSpellLanguages(languages),
          },
    },
  };
}

/** Navigation policy + outage detection of a tab. */
function guardTab(tab: Tab): void {
  const wc = contentsOf(tab);

  // Links leaving the Oriel server open in the default browser.
  wc.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    openExternal(event.url);
  });

  // HTTP redirects (3xx of a proxy, a gateway…) are not seen by will-navigate (QA-G10-02).
  wc.on('will-redirect', (event) => {
    if (!event.isMainFrame || isAppUrl(event.url)) return;
    event.preventDefault();
    openExternal(event.url);
  });

  // window.open / target=_blank / ⌘-click: same server → new tab (or window); http(s)/mailto/tel →
  // browser. No child window is ever created (QA-G10-01): a third-party embed could otherwise open
  // about:blank and write a fake Oriel screen into a window without an address bar.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const action = windowOpenAction(url, disposition, serverOrigin);
    if (action.kind === 'tab') openInTab(ownerOf(tab), url, action.activate);
    else if (action.kind === 'window') createAppWindow({ url });
    else if (action.kind === 'external') openExternal(url);
    return { action: 'deny' };
  });

  wc.on('page-title-updated', (_event, title) => {
    tab.title = title;
    const win = ownerOf(tab);
    if (win) pushTabsState(win);
  });
  const loading = (value: boolean) => () => {
    tab.loading = value;
    const win = ownerOf(tab);
    if (win) pushTabsState(win);
  };
  wc.on('did-start-loading', loading(true));
  wc.on('did-stop-loading', loading(false));
  wc.on('did-navigate-in-page', () => scheduleSessionSave());

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED: a newer navigation or a download replaced this one; not an outage.
    if (!isMainFrame || errorCode === -3) return;
    if (tab.status) return;
    if (isAppUrl(validatedURL)) tab.target = validatedURL;
    const { message, code } = describeNetError(errorDescription);
    showStatus(tab, { kind: 'offline', error: message, errorCode: code ?? errorDescription });
  });

  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    scheduleSessionSave();
    if (!isAppUrl(url)) return;
    // The reverse proxy answers but Oriel behind it does not.
    if (httpResponseCode === 502 || httpResponseCode === 503 || httpResponseCode === 504) {
      tab.target = url;
      showStatus(tab, { kind: 'offline', error: describeHttpStatus(httpResponseCode), errorCode: `HTTP ${httpResponseCode}` });
      return;
    }
    if (tab.clearHistory) {
      tab.clearHistory = false;
      wc.navigationHistory.clear();
    }
  });

  wc.on('render-process-gone', (_event, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    const win = ownerOf(tab);
    const box: MessageBoxOptions = {
      type: 'warning',
      message: 'Cet onglet a cessé de fonctionner.',
      detail: `Raison : ${details.reason}`,
      buttons: ['Recharger', 'Fermer l’onglet'],
      defaultId: 0,
      cancelId: 1,
    };
    void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box)).then(({ response }) => {
      const owner = ownerOf(tab);
      if (!owner || owner.isDestroyed() || wc.isDestroyed()) return;
      if (response === 1) closeTab(owner, tab, { remember: false });
      else wc.reload();
    });
  });
}

/** "Réessayer" on the status page (and the automatic retries it schedules). */
async function retryTab(tab: Tab): Promise<RetryResult> {
  if (currentMode() === 'local') {
    try {
      await ensureLocalServer(); // reloads the waiting tabs itself
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (!serverOrigin) return { ok: false, error: 'Aucun serveur n’est configuré.' };
  const health = await checkHealth(serverOrigin);
  if (!health.ok) return { ok: false, error: health.error, errorCode: health.code ?? undefined };
  if (!contentsOf(tab).isDestroyed()) loadApp(tab, tab.target && isAppUrl(tab.target) ? tab.target : `${serverOrigin}/`);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Session (windows and tabs restored at launch)
// ---------------------------------------------------------------------------------------------

function snapshotSession(): SavedSession | null {
  const config = getConfig();
  const key = sessionKey(config.mode, config.serverUrl);
  if (!key) return null;
  const windows: SavedWindow[] = [];
  for (const [win, state] of appWindows) {
    if (win.isDestroyed() || windows.length >= MAX_SAVED_WINDOWS) continue;
    const tabs: SavedWindow['tabs'] = [];
    let active = 0;
    for (const tab of state.tabs) {
      const p = restorablePathOf(currentUrlOf(tab), serverOrigin);
      if (!p) continue;
      if (tab.id === state.activeId) active = tabs.length;
      tabs.push(tab.color ? { path: p, color: tab.color } : { path: p });
    }
    if (tabs.length === 0) continue;
    const b = win.getNormalBounds();
    windows.push({ tabs, active, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
  }
  return { origin: key, windows };
}

function saveSessionNow(): void {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  if (sessionFrozen || quitting) return;
  if (getConfig().restoreSession === false) {
    if (getConfig().session) updateConfig({ session: undefined });
    return;
  }
  const snapshot = snapshotSession();
  if (snapshot) updateConfig({ session: snapshot });
}

function scheduleSessionSave(): void {
  if (sessionFrozen || quitting || sessionTimer) return;
  sessionTimer = setTimeout(saveSessionNow, SESSION_SAVE_DELAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------------------------

/** Starts the embedded server once (concurrent callers share the same attempt). */
function ensureLocalServer(): Promise<void> {
  if (localServer.isRunning) return Promise.resolve();
  localStart ??= (async () => {
    try {
      const port = await localServer.start(getConfig().localPort);
      if (getConfig().localPort !== port) updateConfig({ localPort: port });
      const previous = serverOrigin;
      const origin = `http://127.0.0.1:${port}`;
      serverOrigin = origin;
      for (const tab of allTabs()) {
        if (contentsOf(tab).isDestroyed()) continue;
        if (tab.status) {
          loadApp(tab, rebase(tab.target, origin) ?? origin + tab.pendingPath);
        } else if (previous && previous !== origin && sameOrigin(contentsOf(tab).getURL(), previous)) {
          loadApp(tab, rebase(contentsOf(tab).getURL(), origin) ?? `${origin}/`);
        }
      }
    } finally {
      localStart = null;
    }
  })();
  return localStart;
}

/** ensureLocalServer() + error dialog with the end of the server log. */
async function startLocalServer(): Promise<void> {
  if (localDialogOpen || currentMode() !== 'local') return;
  try {
    await ensureLocalServer();
  } catch (err) {
    if (quitting || currentMode() !== 'local') return;
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof LocalServerError ? err.kind : 'exit';
    for (const tab of allTabs()) {
      showStatus(tab, { kind: 'offline', error: message, errorCode: `SERVER_${kind.toUpperCase()}` });
    }
    await localServerDialog(
      'Le serveur local n’a pas pu démarrer.',
      message,
      err instanceof LocalServerError ? err.logExcerpt : localServer.logExcerpt(),
    );
  }
}

async function localServerDialog(message: string, reason: string, excerpt: string): Promise<void> {
  if (localDialogOpen || quitting) return;
  localDialogOpen = true;
  const options: MessageBoxOptions = {
    type: 'error',
    message,
    detail: [reason, excerpt && `Dernières lignes du journal :\n${excerpt}`, `Journal complet : ${tildify(paths.serverLog)}`]
      .filter(Boolean)
      .join('\n\n'),
    buttons: ['Réessayer', 'Changer de mode…', 'Quitter'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const parent = focusedAppWindow();
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  localDialogOpen = false;
  if (response === 0) {
    recentCrashes.length = 0;
    for (const tab of allTabs()) showStatus(tab, { kind: 'starting', error: null, errorCode: null });
    await startLocalServer();
  } else if (response === 1) {
    showSetup();
  } else {
    app.quit();
  }
}

function pathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

function rebase(url: string | null, origin: string): string | null {
  const p = pathOf(url ?? undefined);
  return p === null ? null : origin + p;
}

// ---------------------------------------------------------------------------------------------
// Setup window (first launch, "Changer de serveur…")
// ---------------------------------------------------------------------------------------------

function showSetup(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 880,
    height: 680,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: 'Bienvenue dans Oriel',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHTS,
    backgroundColor: setupBackground(),
    webPreferences: {
      preload: paths.setupPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  setupWindow = win;
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
    openExternal(event.url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  attachContextMenu(win.webContents, () => win, { isAppUrl: () => false, openInNewWindow: () => undefined, openExternal });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (setupWindow === win) setupWindow = null;
  });
  win.loadFile(paths.setupPage).catch(() => undefined);
}

function setupState(): SetupState {
  const config = getConfig();
  return {
    firstRun: !config.mode,
    mode: config.mode ?? null,
    serverUrl: config.serverUrl ?? null,
    recentServers: config.recentServers ?? [],
    localDataDir: tildify(paths.dataDir),
    localAvailable: fs.existsSync(paths.serverEntry),
    version: app.getVersion(),
  };
}

async function testServer(input: unknown): Promise<TestResult> {
  const origin = typeof input === 'string' ? normalizeServerUrl(input) : null;
  if (!origin) return { ok: false, error: 'Adresse invalide. Exemple : https://notes.mondomaine.fr' };
  const health = await checkHealth(origin);
  return health.ok
    ? { ok: true, url: health.origin, version: health.version ?? undefined }
    : { ok: false, url: origin, error: health.error };
}

async function applyChoice(next: { mode: 'remote'; serverUrl: string } | { mode: 'local' }): Promise<void> {
  try {
    const before = getConfig();
    const unchanged = before.mode === next.mode && (next.mode === 'local' || before.serverUrl === next.serverUrl);
    if (next.mode === 'remote') {
      updateConfig({ mode: 'remote', serverUrl: next.serverUrl });
      rememberServer(next.serverUrl);
    } else {
      updateConfig({ mode: 'local' });
    }
    refreshMenu();

    if (unchanged && appWindows.size > 0) {
      for (const tab of allTabs()) if (tab.status?.kind === 'offline') void retryTab(tab);
      focusedAppWindow()?.focus();
      return;
    }

    // The open windows belong to the previous server: close them and start over. Their tabs must
    // neither be remembered (⇧⌘T) nor overwrite the saved session while they close.
    sessionFrozen = true;
    closedTabs.clear();
    badgeCounts.clear();
    applyBadge();
    for (const [win, state] of [...appWindows]) {
      state.discardTabs = true;
      win.close();
    }
    if (before.mode === 'local' && next.mode !== 'local') await localServer.stop();
    serverOrigin =
      next.mode === 'remote' ? next.serverUrl : localServer.isRunning ? `http://127.0.0.1:${localServer.port}` : null;
    updateConfig({ session: undefined });
    createAppWindow({ cascade: false });
    sessionFrozen = false;
    scheduleSessionSave();
  } finally {
    // After the IPC reply has been delivered to the setup page.
    setTimeout(() => setupWindow?.close(), 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Desktop integrations: quick search, Dock badge, spell checking, downloads
// ---------------------------------------------------------------------------------------------

function quickSettings(): { enabled: boolean; accelerator: string } {
  return getConfig().quickSearch ?? { enabled: true, accelerator: DEFAULT_QUICK_ACCELERATOR };
}

function setupIntegrations(): void {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(getConfig().spellcheck !== false);
  applySpellLanguages(getConfig().spellLanguages);

  quick = new QuickSearch({
    session: ses,
    serverOrigin: () => serverOrigin,
    workspaceHint: () => workspaceOf(focusedTab() ? contentsOf(focusedTab()!).getURL() : undefined),
    openPath: openPathInMainWindow,
    appIsFocused: () => {
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && appWindows.has(focused);
    },
  });
  const settings = quickSettings();
  const registered = quick.configure(settings.enabled, settings.accelerator);
  if (!registered.ok) console.warn(`[quick-search] ${registered.error}`);

  downloads = new Downloads({
    serverOrigin: () => serverOrigin,
    windowFor: (contents) => tabsByContents.get(contents.id)?.win ?? null,
    refused: () => {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Téléchargement refusé',
          body: 'Seuls les fichiers de votre instance Oriel peuvent être téléchargés.',
        }).show();
      }
    },
    finished: () => refreshMenu(),
  });
  downloads.attach(ses);
}

/** Shows an internal path in the main window (a new window when none is open). */
function openPathInMainWindow(p: string): void {
  if (!serverOrigin || !p.startsWith('/') || p.startsWith('//')) return;
  app.focus({ steal: true });
  const win = focusedAppWindow();
  if (!win) {
    createAppWindow({ path: p });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const tab = activeTabOf(win);
  if (!tab || tab.status || !isAppUrl(contentsOf(tab).getURL())) {
    createTab(win, { path: p, activate: true });
  } else {
    navigateInPage(tab, p);
  }
}

function applyBadge(): void {
  const enabled = getConfig().dockBadge !== false;
  const count = enabled ? Math.max(0, ...badgeCounts.values()) : 0;
  if (process.platform === 'darwin') app.dock?.setBadge(badgeLabel(count));
  else app.setBadgeCount(count);
}

function setSpellcheck(enabled: boolean): void {
  updateConfig({ spellcheck: enabled });
  session.defaultSession.setSpellCheckerEnabled(enabled);
  refreshMenu();
}

/** Dictionaries only exist as a choice off macOS (the system checker detects the language there). */
function applySpellLanguages(languages: string[] | undefined): void {
  if (process.platform === 'darwin' || !languages || languages.length === 0) return;
  const ses = session.defaultSession;
  const available = new Set(ses.availableSpellCheckerLanguages);
  const valid = languages.filter((l) => available.has(l));
  if (valid.length > 0) ses.setSpellCheckerLanguages(valid);
}

function setSpellLanguages(languages: string[]): void {
  if (process.platform === 'darwin') return;
  updateConfig({ spellLanguages: languages });
  applySpellLanguages(languages);
}

function currentPrefs(): DesktopPrefs {
  const config = getConfig();
  const ses = session.defaultSession;
  const mac = process.platform === 'darwin';
  const quickConfig = quickSettings();
  return {
    quickSearchEnabled: quickConfig.enabled,
    quickSearchShortcut: quickConfig.accelerator,
    dockBadge: config.dockBadge !== false,
    spellcheck: config.spellcheck !== false,
    restoreSession: config.restoreSession !== false,
    spellLanguages: mac ? null : ses.getSpellCheckerLanguages(),
    availableSpellLanguages: mac ? [] : [...ses.availableSpellCheckerLanguages],
    platform: process.platform,
  };
}

function applyPrefs(patch: PrefsPatch): PrefsResult {
  let error: string | undefined;
  if (patch.quickSearchEnabled !== undefined || patch.quickSearchShortcut !== undefined) {
    const before = quickSettings();
    const next = {
      enabled: patch.quickSearchEnabled ?? before.enabled,
      accelerator: patch.quickSearchShortcut ?? before.accelerator,
    };
    const result = quick?.configure(next.enabled, next.accelerator) ?? { ok: true };
    if (result.ok) {
      updateConfig({ quickSearch: next });
    } else {
      error = result.error;
      quick?.configure(before.enabled, before.accelerator); // keep the previous shortcut working
    }
  }
  if (patch.dockBadge !== undefined) {
    updateConfig({ dockBadge: patch.dockBadge });
    applyBadge();
  }
  if (patch.spellcheck !== undefined) setSpellcheck(patch.spellcheck);
  if (patch.spellLanguages !== undefined) setSpellLanguages(patch.spellLanguages);
  if (patch.restoreSession !== undefined) {
    updateConfig({ restoreSession: patch.restoreSession });
    if (patch.restoreSession) scheduleSessionSave();
    else saveSessionNow();
  }
  return { ok: error === undefined, prefs: currentPrefs(), error };
}

// ---------------------------------------------------------------------------------------------
// IPC (every channel checks which page is calling)
// ---------------------------------------------------------------------------------------------

const withoutQuery = (url: string) => url.replace(/[?#].*$/, '');
const frameUrl = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame?.url ?? '';
/** URL and real origin of the sender frame are the Oriel server (QA-G10-03: no opaque origin). */
const isAppFrame = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  !!event.senderFrame && isTrustedAppFrame(event.senderFrame.url, event.senderFrame.origin, serverOrigin);
/** Top-level frame only: sub-frames of a page never get to call the main process. */
const isMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent) => !!event.senderFrame && event.senderFrame.parent === null;

function isSetupSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    !!setupWindow &&
    !setupWindow.isDestroyed() &&
    event.sender === setupWindow.webContents &&
    withoutQuery(frameUrl(event)) === setupPageUrl
  );
}

function statusSenderTab(event: IpcMainEvent | IpcMainInvokeEvent): Tab | null {
  const entry = tabsByContents.get(event.sender.id);
  if (!entry || !isMainFrame(event)) return null;
  return withoutQuery(frameUrl(event)) === statusPageUrl ? entry.tab : null;
}

/** Tab showing the Oriel server (or its own status page). */
function isAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const entry = tabsByContents.get(event.sender.id);
  return !!entry && isMainFrame(event) && (isAppFrame(event) || withoutQuery(frameUrl(event)) === statusPageUrl);
}

/** Tab showing the Oriel server only (data channels: badge, preferences). */
function appSenderTab(event: IpcMainEvent | IpcMainInvokeEvent): Tab | null {
  const entry = tabsByContents.get(event.sender.id);
  return entry && isMainFrame(event) && isAppFrame(event) ? entry.tab : null;
}

/** The window whose tab bar page sent the message. */
function tabBarWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  if (!isMainFrame(event) || withoutQuery(frameUrl(event)) !== tabsPageUrl) return null;
  for (const win of appWindows.keys()) {
    if (!win.isDestroyed() && win.webContents === event.sender) return win;
  }
  return null;
}

function tabFor(win: BrowserWindow, rawId: unknown): Tab | null {
  const id = parseId(rawId);
  return (id && appWindows.get(win)?.tabs.find((t) => t.id === id)) || null;
}

function registerIpc(): void {
  const denied = (): never => {
    throw new Error('Appel IPC refusé.');
  };

  ipcMain.on(IPC.openSetup, (event) => {
    if (isAppSender(event)) showSetup();
  });

  ipcMain.handle(IPC.statusGet, (event): StatusInfo | null => statusSenderTab(event)?.status ?? null);
  ipcMain.handle(IPC.statusRetry, async (event): Promise<RetryResult> => {
    const tab = statusSenderTab(event);
    return tab ? retryTab(tab) : { ok: false };
  });
  ipcMain.on(IPC.statusChangeServer, (event) => {
    if (statusSenderTab(event)) showSetup();
  });

  ipcMain.handle(IPC.setupState, (event): SetupState => (isSetupSender(event) ? setupState() : denied()));
  ipcMain.handle(IPC.setupTest, (event, url: unknown): Promise<TestResult> =>
    isSetupSender(event) ? testServer(url) : denied(),
  );
  ipcMain.handle(IPC.setupConnect, async (event, url: unknown): Promise<ActionResult> => {
    if (!isSetupSender(event)) denied();
    const result = await testServer(url);
    if (!result.ok || !result.url) return { ok: false, error: result.error };
    await applyChoice({ mode: 'remote', serverUrl: result.url });
    return { ok: true };
  });
  ipcMain.handle(IPC.setupUseLocal, async (event): Promise<ActionResult> => {
    if (!isSetupSender(event)) denied();
    if (!fs.existsSync(paths.serverEntry)) {
      return { ok: false, error: 'Le serveur intégré est absent de cette version de l’application.' };
    }
    await applyChoice({ mode: 'local' });
    return { ok: true };
  });
  ipcMain.on(IPC.setupCancel, (event) => {
    if (isSetupSender(event)) setupWindow?.close();
  });

  // --- Dock badge and preferences (pages of the Oriel server only) ---------------------------
  ipcMain.on(IPC.badgeSet, (event, value: unknown) => {
    if (!appSenderTab(event)) return;
    const count = parseBadgeCount(value);
    if (count === null) return;
    badgeCounts.set(event.sender.id, count);
    applyBadge();
  });
  ipcMain.handle(IPC.prefsGet, (event): DesktopPrefs => (appSenderTab(event) ? currentPrefs() : denied()));
  ipcMain.handle(IPC.prefsSet, (event, value: unknown): PrefsResult => {
    if (!appSenderTab(event)) denied();
    const parsed = parsePrefsPatch(value);
    if (!parsed.ok) return { ok: false, prefs: currentPrefs(), error: parsed.error };
    return applyPrefs(parsed.patch);
  });

  // --- Tab bar (its own window only) -------------------------------------------------------------
  ipcMain.handle(IPC.tabsGet, (event): TabsState => {
    const win = tabBarWindow(event);
    if (!win) return denied();
    const state = appWindows.get(win)!;
    return {
      tabs: state.tabs.map((t) => ({
        id: t.id,
        title: tabLabel(t.title),
        color: t.color,
        active: t.id === state.activeId,
        loading: t.loading,
      })),
      fullScreen: win.isFullScreen(),
    };
  });
  ipcMain.on(IPC.tabsSelect, (event, rawId: unknown) => {
    const win = tabBarWindow(event);
    const tab = win && tabFor(win, rawId);
    if (win && tab) activateTab(win, tab);
  });
  ipcMain.on(IPC.tabsClose, (event, rawId: unknown) => {
    const win = tabBarWindow(event);
    const tab = win && tabFor(win, rawId);
    if (win && tab) closeTab(win, tab);
  });
  ipcMain.on(IPC.tabsNew, (event) => {
    const win = tabBarWindow(event);
    if (win) newTab(win);
  });
  ipcMain.on(IPC.tabsMove, (event, rawId: unknown, rawIndex: unknown) => {
    const win = tabBarWindow(event);
    const tab = win && tabFor(win, rawId);
    if (!win || !tab) return;
    const state = appWindows.get(win)!;
    const to = parseIndex(rawIndex, state.tabs.length - 1);
    if (to === null) return;
    state.tabs = moveItem(state.tabs, state.tabs.indexOf(tab), to);
    pushTabsState(win);
  });
  ipcMain.on(IPC.tabsDetach, (event, rawId: unknown, rawX: unknown, rawY: unknown) => {
    const win = tabBarWindow(event);
    const tab = win && tabFor(win, rawId);
    const x = parseCoordinate(rawX);
    const y = parseCoordinate(rawY);
    if (!win || !tab || x === null || y === null) return;
    detachTab(win, tab, { x: x - 120, y: y - 20 });
  });
  ipcMain.on(IPC.tabsMenu, (event, rawId: unknown) => {
    const win = tabBarWindow(event);
    const tab = win && tabFor(win, rawId);
    if (win && tab) popupTabMenu(win, tab);
  });

  // --- Quick search (its own window only) --------------------------------------------------------
  ipcMain.handle(IPC.quickSearch, async (event, query: unknown) => {
    if (!quick?.isSender(event)) denied();
    return quick!.search(query);
  });
  ipcMain.handle(IPC.quickOpen, (event, workspaceId: unknown, pageId: unknown) => {
    if (!quick?.isSender(event)) denied();
    return quick!.open(workspaceId, pageId);
  });
  ipcMain.handle(IPC.quickCreate, async (event, workspaceId: unknown, title: unknown) => {
    if (!quick?.isSender(event)) denied();
    return quick!.create(workspaceId, title);
  });
  ipcMain.on(IPC.quickClose, (event) => {
    if (quick?.isSender(event)) quick.hide();
  });
}

/** A new tab opens on the home of the workspace of the current tab (or on "/"). */
function newTab(win: BrowserWindow): void {
  const current = activeTabOf(win);
  const workspace = current ? workspaceOf(contentsOf(current).getURL()) : null;
  createTab(win, { path: workspace ? `/w/${workspace}` : '/', activate: true });
}

function popupTabMenu(win: BrowserWindow, tab: Tab): void {
  const state = appWindows.get(win);
  if (!state) return;
  const index = state.tabs.indexOf(tab);
  const colorNames: Record<TabColor, string> = {
    red: 'Rouge',
    orange: 'Orange',
    yellow: 'Jaune',
    green: 'Vert',
    teal: 'Turquoise',
    blue: 'Bleu',
    purple: 'Violet',
    pink: 'Rose',
    gray: 'Gris',
  };
  const setColor = (color: TabColor | null) => {
    tab.color = color;
    pushTabsState(win);
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Couleur',
      submenu: [
        { label: 'Aucune', type: 'radio', checked: tab.color === null, click: () => setColor(null) },
        { type: 'separator' },
        ...TAB_COLORS.map((color): MenuItemConstructorOptions => ({
          label: colorNames[color],
          type: 'radio',
          checked: tab.color === color,
          click: () => setColor(parseColor(color)),
        })),
      ],
    },
    { type: 'separator' },
    {
      label: 'Dupliquer',
      click: () => {
        const url = currentUrlOf(tab);
        if (url && isAppUrl(url)) createTab(win, { url, color: tab.color, index: index + 1, activate: true });
      },
    },
    {
      label: 'Déplacer dans une nouvelle fenêtre',
      enabled: state.tabs.length > 1,
      click: () => detachTab(win, tab),
    },
    { type: 'separator' },
    { label: 'Fermer l’onglet', click: () => closeTab(win, tab) },
    {
      label: 'Fermer les autres onglets',
      enabled: state.tabs.length > 1,
      click: () => {
        for (const other of [...state.tabs]) if (other !== tab) closeTab(win, other);
      },
    },
    {
      label: 'Fermer les onglets à droite',
      enabled: index < state.tabs.length - 1,
      click: () => {
        for (const other of state.tabs.slice(index + 1)) closeTab(win, other);
      },
    },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

// ---------------------------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------------------------

function configureSession(): void {
  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return allowed.has(permission) && isAppUrl(requestingOrigin);
  });
}

// ---------------------------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------------------------

/** ⌘W / ⇧⌘W act on the focused window, whichever it is (app, setup, quick search). */
function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}

const menuActions: MenuActions = {
  openSettings: () => void openSettings(),
  changeServer: () => showSetup(),
  newWindow: () => {
    if (currentMode()) createAppWindow();
    else showSetup();
  },
  reload: () => {
    const tab = focusedTab();
    if (!tab) return;
    const status = tab.status;
    if (!status) {
      contentsOf(tab).reload();
    } else if (status.kind === 'offline') {
      void retryTab(tab).then((r) => {
        if (!r.ok && !contentsOf(tab).isDestroyed() && tab.status) {
          showStatus(tab, { kind: 'offline', error: r.error ?? status.error, errorCode: r.errorCode ?? status.errorCode });
        }
      });
    }
  },
  forceReload: () => {
    const tab = focusedTab();
    if (tab && !tab.status) contentsOf(tab).reloadIgnoringCache();
  },
  goBack: () => {
    const tab = focusedTab();
    const nav = tab && contentsOf(tab).navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
  },
  goForward: () => {
    const tab = focusedTab();
    const nav = tab && contentsOf(tab).navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  },
  search: () => {
    const tab = focusedTab();
    if (tab && !tab.status) forwardShortcut(tab, 'k');
  },
  openDocumentation: () => openExternal(DOCS_URL),
  revealData: () => {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    void shell.openPath(paths.dataDir);
  },
  revealLogs: () => {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    void shell.openPath(paths.logsDir);
  },
  newTab: () => {
    const win = focusedAppWindow();
    if (win) newTab(win);
    else if (currentMode()) createAppWindow();
    else showSetup();
  },
  closeTab: () => {
    const win = focusedWindow();
    if (win && appWindows.has(win)) {
      const tab = activeTabOf(win);
      if (tab) closeTab(win, tab);
    } else {
      win?.close();
    }
  },
  closeWindow: () => focusedWindow()?.close(),
  reopenTab: () => reopenClosedTab(),
  selectTab: (digit) => {
    const win = focusedAppWindow();
    const state = win && appWindows.get(win);
    if (!win || !state) return;
    const index = indexForShortcut(digit, state.tabs.length);
    if (index !== null) activateTab(win, state.tabs[index]!);
  },
  previousTab: () => stepTab(-1),
  nextTab: () => stepTab(1),
  moveTabToNewWindow: () => {
    const win = focusedAppWindow();
    const tab = activeTabOf(win);
    if (win && tab) detachTab(win, tab);
  },
  showDefinition: () => {
    const tab = focusedTab();
    if (tab && process.platform === 'darwin') contentsOf(tab).showDefinitionForSelection();
  },
  toggleSpellcheck: () => setSpellcheck(!session.defaultSession.isSpellCheckerEnabled()),
  revealLastDownload: () => downloads?.revealLast(),
  quickSearch: () => quick?.toggle(),
};

function stepTab(step: 1 | -1): void {
  const win = focusedAppWindow();
  const state = win && appWindows.get(win);
  if (!win || !state || state.tabs.length < 2) return;
  const current = state.tabs.findIndex((t) => t.id === state.activeId);
  activateTab(win, state.tabs[neighbourIndex(current, state.tabs.length, step)]!);
}

function refreshMenu(): void {
  Menu.setApplicationMenu(
    buildAppMenu(menuActions, {
      mode: currentMode(),
      spellcheck: getConfig().spellcheck !== false,
      hasDownload: !!downloads?.lastFile,
    }),
  );
}

/** Delivers ⌘+key to the page as if typed (used by Navigation › Rechercher). */
function forwardShortcut(tab: Tab, key: string): void {
  const init = { key, code: `Key${key.toUpperCase()}`, metaKey: true, bubbles: true, cancelable: true, composed: true };
  const script = `(() => {
    const init = ${JSON.stringify(init)};
    const target = document.activeElement || document.body || document;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  })()`;
  ownerOf(tab)?.focus();
  contentsOf(tab).focus();
  contentsOf(tab).executeJavaScript(script, true).catch(() => undefined);
}

/** Oriel › Réglages… : the web settings route of the current workspace, else the setup window. */
async function openSettings(): Promise<void> {
  const tab = focusedTab();
  if (!tab || tab.status || !isAppUrl(contentsOf(tab).getURL())) {
    showSetup();
    return;
  }
  const wc = contentsOf(tab);
  const current = new URL(wc.getURL());
  let workspace: string | null = /^\/w\/([^/]+)/.exec(current.pathname)?.[1] ?? null;
  if (!workspace) {
    const id: unknown = await wc
      .executeJavaScript(
        `fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((s) => (s && Array.isArray(s.workspaces) && s.workspaces[0] ? String(s.workspaces[0].id) : null))
          .catch(() => null)`,
        true,
      )
      .catch(() => null);
    workspace = typeof id === 'string' && id ? encodeURIComponent(id) : null;
  }
  if (!workspace) {
    showSetup();
    return;
  }
  navigateInPage(tab, `/w/${workspace}/settings`);
}

/** Client-side navigation (History API + popstate, understood by the SPA router). */
function navigateInPage(tab: Tab, pathname: string): void {
  const script = `(() => {
    const target = ${JSON.stringify(pathname)};
    if (location.pathname === target) return;
    history.pushState(null, '', target);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  })()`;
  const win = ownerOf(tab);
  if (win) activateTab(win, tab);
  contentsOf(tab)
    .executeJavaScript(script, true)
    .catch(() => {
      if (serverOrigin) loadApp(tab, serverOrigin + pathname);
    });
}

// ---------------------------------------------------------------------------------------------
// Entry point (last, once every declaration above is initialised)
// ---------------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}
