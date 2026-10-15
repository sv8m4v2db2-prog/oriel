// Quick search: a global shortcut opens a small frameless window that searches pages and opens (or
// creates) one in the main window. The search itself runs here, in the main process, against the
// configured server only, with the app session; the window's page is a local file with no network.
import {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import { pathToFileURL } from 'node:url';
import type { QuickOpenReply, QuickResult, QuickSearchReply } from './ipc';
import { paths } from './paths';
import { MAX_QUERY_LENGTH, parseId, parseQuery, parseTitle } from './validate';

export interface QuickSearchHooks {
  session: Session;
  /** Origin of the configured server, null while it is not known (setup, local server starting). */
  serverOrigin(): string | null;
  /** Workspace of the active tab of the most recent window, if any. */
  workspaceHint(): string | null;
  /** Shows `path` (internal) in the main window, creating one when none is open. */
  openPath(path: string): void;
  /** True when one of the app windows has the focus. */
  appIsFocused(): boolean;
}

const WINDOW_SIZE = { width: 640, height: 440 };
const RESULT_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_JSON_BYTES = 1_000_000;

const NOT_READY = 'Oriel n’est pas encore prêt : ouvrez d’abord une fenêtre de l’application.';
const SIGNED_OUT = 'Connectez-vous dans la fenêtre principale pour utiliser la recherche rapide.';

interface SearchApiResult {
  page?: { id?: unknown; title?: unknown; icon?: unknown; workspaceId?: unknown };
  path?: unknown;
  snippet?: unknown;
}

export class QuickSearch {
  private win: BrowserWindow | null = null;
  private registered: string | null = null;
  private lastWorkspace: string | null = null;
  private restoreFocusOnHide = false;
  private readonly pageUrl = pathToFileURL(paths.quickPage).href;

  constructor(private readonly hooks: QuickSearchHooks) {}

  // --- shortcut ---------------------------------------------------------------------------------

  /** (Un)registers the global shortcut. Returns an error message when the system refuses it. */
  configure(enabled: boolean, accelerator: string): { ok: boolean; error?: string } {
    this.unregister();
    if (!enabled) {
      this.destroy();
      return { ok: true };
    }
    try {
      const ok = globalShortcut.register(accelerator, () => this.toggle());
      if (!ok) return { ok: false, error: 'Ce raccourci est déjà utilisé par une autre application.' };
      this.registered = accelerator;
      return { ok: true };
    } catch {
      return { ok: false, error: 'Raccourci invalide.' };
    }
  }

  unregister(): void {
    if (this.registered) {
      globalShortcut.unregister(this.registered);
      this.registered = null;
    }
  }

  // --- window ----------------------------------------------------------------------------------

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.hide();
    else this.show();
  }

  show(): void {
    if (!this.hooks.serverOrigin()) return;
    const win = this.ensureWindow();
    this.restoreFocusOnHide = !this.hooks.appIsFocused();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({
      x: Math.round(display.x + (display.width - WINDOW_SIZE.width) / 2),
      y: Math.round(display.y + display.height * 0.18),
      ...WINDOW_SIZE,
    });
    win.webContents.send('oriel:quick:reset');
    app.focus({ steal: true });
    win.show();
    win.focus();
  }

  /** Hides the window; when the shortcut summoned the app from the background, gives focus back. */
  hide(options: { keepAppFocus?: boolean } = {}): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    if (this.restoreFocusOnHide && !options.keepAppFocus && process.platform === 'darwin') app.hide();
    this.restoreFocusOnHide = false;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...WINDOW_SIZE,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      title: 'Recherche rapide',
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        preload: paths.quickPreload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    let focused = false;
    win.on('focus', () => (focused = true));
    // Closing on blur, but only once the window has actually had the focus (activation can lag).
    win.on('blur', () => {
      if (focused) {
        focused = false;
        this.hide({ keepAppFocus: true });
      }
    });
    win.on('hide', () => (focused = false));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(paths.quickPage).catch(() => undefined);
    this.win = win;
    return win;
  }

  /** Only the quick search page of its own window may use the quick:* channels. */
  isSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return (
      !!this.win &&
      !this.win.isDestroyed() &&
      event.sender === this.win.webContents &&
      (event.senderFrame?.url ?? '').replace(/[?#].*$/, '') === this.pageUrl
    );
  }

  // --- requests (main process → configured server, session cookies) -----------------------------

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
    const origin = this.hooks.serverOrigin();
    if (!origin) throw new Error(NOT_READY);
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      // The server's CSRF check compares Origin with its own address (same value the web app sends).
      headers.origin = origin;
      body = JSON.stringify(init.body);
    }
    const response = await this.hooks.session.fetch(origin + path, {
      method: init.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let json: unknown = null;
    if (text.length <= MAX_JSON_BYTES) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  private async resolveWorkspace(): Promise<string | null> {
    const hint = this.hooks.workspaceHint();
    if (hint && parseId(hint)) {
      this.lastWorkspace = hint;
      return hint;
    }
    if (this.lastWorkspace) return this.lastWorkspace;
    const { status, json } = await this.request('/api/auth/me');
    if (status === 401) return null;
    const first = (json as { workspaces?: Array<{ id?: unknown }> } | null)?.workspaces?.[0]?.id;
    const id = parseId(first);
    if (id) this.lastWorkspace = id;
    return id;
  }

  async search(rawQuery: unknown): Promise<QuickSearchReply> {
    const empty = (error: string): QuickSearchReply => ({ ok: false, error, results: [], recent: false, workspaceId: null });
    const query = parseQuery(rawQuery);
    if (query === null) return empty('Recherche invalide.');
    try {
      const workspaceId = await this.resolveWorkspace();
      if (!workspaceId) return empty(SIGNED_OUT);
      const path = query
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/search?q=${encodeURIComponent(query.slice(0, MAX_QUERY_LENGTH))}&limit=${RESULT_LIMIT}`
        : `/api/workspaces/${encodeURIComponent(workspaceId)}/recent`;
      const { status, json } = await this.request(path);
      if (status === 401) return empty(SIGNED_OUT);
      if (status === 403 || status === 404) {
        this.lastWorkspace = null;
        return empty('Espace de travail introuvable.');
      }
      if (status !== 200 || !json || typeof json !== 'object') return empty('Le serveur a répondu avec une erreur.');
      const results = query ? this.fromSearch(json, workspaceId) : this.fromRecent(json, workspaceId);
      return { ok: true, results: results.slice(0, RESULT_LIMIT), recent: !query, workspaceId };
    } catch (err) {
      return empty(err instanceof Error && err.message === NOT_READY ? NOT_READY : 'Le serveur est injoignable.');
    }
  }

  private fromSearch(json: object, workspaceId: string): QuickResult[] {
    const list = (json as { results?: unknown }).results;
    if (!Array.isArray(list)) return [];
    const out: QuickResult[] = [];
    for (const item of list as SearchApiResult[]) {
      const id = parseId(item?.page?.id);
      if (!id) continue;
      out.push({
        id,
        workspaceId: parseId(item.page?.workspaceId) ?? workspaceId,
        title: text(item.page?.title, 200),
        icon: item.page?.icon === null || item.page?.icon === undefined ? null : text(item.page.icon, 16) || null,
        path: Array.isArray(item.path)
          ? item.path
              .map((c) => text((c as { title?: unknown })?.title, 80))
              .filter(Boolean)
              .join(' / ')
          : '',
        snippet: text(item.snippet, 200),
      });
    }
    return out;
  }

  private fromRecent(json: object, workspaceId: string): QuickResult[] {
    const list = (json as { pages?: unknown }).pages;
    if (!Array.isArray(list)) return [];
    const out: QuickResult[] = [];
    for (const item of list as Array<{ id?: unknown; title?: unknown; icon?: unknown; path?: unknown }>) {
      const id = parseId(item?.id);
      if (!id) continue;
      out.push({
        id,
        workspaceId,
        title: text(item.title, 200),
        icon: item.icon === null || item.icon === undefined ? null : text(item.icon, 16) || null,
        path: Array.isArray(item.path)
          ? item.path
              .map((c) => text((c as { title?: unknown })?.title, 80))
              .filter(Boolean)
              .join(' / ')
          : '',
        snippet: '',
      });
    }
    return out;
  }

  open(rawWorkspace: unknown, rawPage: unknown): QuickOpenReply {
    const workspaceId = parseId(rawWorkspace);
    const pageId = parseId(rawPage);
    if (!workspaceId || !pageId) return { ok: false, error: 'Page invalide.' };
    this.hooks.openPath(`/w/${encodeURIComponent(workspaceId)}/p/${encodeURIComponent(pageId)}`);
    this.hide({ keepAppFocus: true });
    return { ok: true };
  }

  async create(rawWorkspace: unknown, rawTitle: unknown): Promise<QuickOpenReply> {
    const workspaceId = parseId(rawWorkspace);
    const title = parseTitle(rawTitle);
    if (!workspaceId || !title) return { ok: false, error: 'Titre invalide.' };
    try {
      const { status, json } = await this.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/pages`, {
        method: 'POST',
        body: { parentType: 'workspace', parentId: workspaceId, title, visibility: 'private' },
      });
      if (status === 401) return { ok: false, error: SIGNED_OUT };
      const id = parseId((json as { id?: unknown } | null)?.id);
      if (status >= 400 || !id) return { ok: false, error: 'Impossible de créer la page (droits insuffisants ?).' };
      return this.open(workspaceId, id);
    } catch {
      return { ok: false, error: 'Le serveur est injoignable.' };
    }
  }
}

function text(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}
