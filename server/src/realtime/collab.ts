// Real-time collaboration on page content (ARCHITECTURE §3.6): Hocuspocus without its HTTP server,
// fed by `ws` sockets upgraded on Fastify's HTTP server at /collab.
import type { IncomingMessage } from 'node:http';
import {
  Hocuspocus,
  type Connection,
  type Document as HocusDocument,
  type WebSocketLike,
  type beforeHandleAwarenessPayload,
  type beforeSyncPayload,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import type { RawData, WebSocket } from 'ws';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, collabDocumentName, newId, parseCollabDocumentName, parseSyncedDocumentName } from '@oriel/shared';
import type { AppContext, CollabControl } from '../context.js';
import { parseJson } from '../db/rows.js';
import { canEditRole, canSeePage, getPageRow, isPubliclyVisible, roleOf } from '../access.js';
import { extractContent, replaceFragmentWithState, sameBytes } from '../content/ydoc.js';
import { recordSyncedRefs } from '../content/synced.js';
import { indexPage } from '../services/search.js';
import { emitPage } from '../services/pages.js';
import { processStoredDocument } from '../collab/mentions.js';
import { checkCollabUpdate, dropPendingStructs } from './updateGuard.js';
import { BlockTouches, flushBlockMeta } from '../services/blockMeta.js';
import { checkCanvasUpdate, prepareCanvasDocument } from '../canvas/guard.js';
import { extractCanvasContent, isCanvasRow, replaceCanvasWithState } from '../canvas/content.js';

export interface CollabContext {
  userId: string | null;
  /** Hashed session id of the upgrade request (re-checked when a document is opened). */
  sessionId?: string | null;
  /** Display identity stamped on awareness states (set by onAuthenticate). */
  userName?: string;
  avatarUrl?: string | null;
  /** Page whose access rules apply: the page itself, or the owner page of a synced block. */
  pageId?: string;
  workspaceId?: string;
  /** Synced block document (`synced:<id>`): its id. */
  syncedId?: string;
  /** Public read-only viewer (not a member). */
  anonymous?: boolean;
  /**
   * Documents this socket reads as a public (anonymous) viewer. One set per socket, shared by the
   * per-document contexts (Hocuspocus copies the default context shallowly).
   */
  anonymousDocs?: Set<string>;
}

const MESSAGE_AWARENESS = 1;
const utf8 = new TextDecoder();

/** Document name and message type of a Hocuspocus frame (lib0 varString address + varUint type). */
function frameHeader(data: Uint8Array): { documentName: string; type: number } | null {
  let pos = 0;
  const readVarUint = (): number | null => {
    let num = 0;
    let mult = 1;
    while (pos < data.length && mult <= 2 ** 35) {
      const byte = data[pos++]!;
      num += (byte & 0x7f) * mult;
      if (byte < 0x80) return num;
      mult *= 128;
    }
    return null;
  };
  const length = readVarUint();
  if (length === null || pos + length > data.length) return null;
  const address = utf8.decode(data.subarray(pos, pos + length));
  pos += length;
  const type = readVarUint();
  if (type === null) return null;
  const sep = address.indexOf('\0');
  return { documentName: sep === -1 ? address : address.slice(0, sep), type };
}

const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
const DAILY_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
const PING_MS = 30_000;

const denied = () => ({ reason: 'permission-denied' });

/** What a document is: a page (`page:<id>`) or a synced block (`synced:<id>`) and its owner page. */
interface DocumentTarget {
  /** Page whose access rules apply. */
  pageId: string;
  syncedId: string | null;
}

/** Refused editor update: Hocuspocus logs it and closes that document's connection (not the socket). */
class RefusedUpdate extends Error {
  readonly code = 4400;
  readonly reason = 'invalid-content';
}

/** Changes of a loaded document since its last store (QA-COL-07: who may own its new date reminders). */
interface SaveWindow {
  /** Users whose own connections (or direct connections on their behalf) changed the document. */
  writers: Set<string>;
  /** State vector when the window opened: items at or beyond it were integrated during the window. */
  since: Map<number, number>;
  /** Blocks touched by authenticated editors during the window (block metadata, H5). */
  blocks: BlockTouches;
}

const stateVectorOf = (doc: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(doc));

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

export class CollabService implements CollabControl {
  readonly hocuspocus: Hocuspocus<CollabContext>;
  private readonly sockets = new Set<WebSocket>();
  private readonly pinger: NodeJS.Timeout;
  /** By document instance (a reloaded document gets a new one). */
  private readonly windows = new WeakMap<Y.Doc, SaveWindow>();
  /** Documents of canvas pages (H1): their own ingest guard and content extraction. */
  private readonly canvasDocs = new WeakSet<Y.Doc>();

  constructor(private readonly ctx: AppContext) {
    this.hocuspocus = new Hocuspocus<CollabContext>({
      name: 'oriel',
      quiet: true,
      debounce: ctx.config.collabDebounceMs,
      maxDebounce: ctx.config.collabMaxDebounceMs,
      unloadImmediately: true,
      onAuthenticate: async (data) => this.onAuthenticate(data),
      beforeHandleAwareness: async (data) => this.beforeHandleAwareness(data),
      beforeSync: async (data) => this.beforeSync(data),
      onLoadDocument: async (data) => this.onLoadDocument(data),
      onStoreDocument: async (data) => this.onStoreDocument(data),
    });
    this.pinger = setInterval(() => {
      for (const ws of this.sockets) {
        try {
          ws.ping();
        } catch {
          /* closing */
        }
      }
    }, PING_MS);
    this.pinger.unref();
  }

  // --- connection wiring ------------------------------------------------------

  handleConnection(ws: WebSocket, req: IncomingMessage, session: { userId: string; sessionId: string } | null): void {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, value);
    }
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/collab'}`;
    // Presence (names, ids, avatars and cursors of the members editing) is for members: it is not
    // relayed to the documents this socket reads anonymously (published pages).
    const anonymousDocs = new Set<string>();
    const socket: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send(data) {
        if (anonymousDocs.size > 0 && data instanceof Uint8Array) {
          const header = frameHeader(data);
          if (header && header.type === MESSAGE_AWARENESS && anonymousDocs.has(header.documentName)) return;
        }
        ws.send(data as Uint8Array);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    const connection = this.hocuspocus.handleConnection(socket, new Request(url, { headers }), {
      userId: session?.userId ?? null,
      sessionId: session?.sessionId ?? null,
      anonymousDocs,
    });
    this.sockets.add(ws);
    ws.on('message', (data) => connection.handleMessage(toUint8(data)));
    ws.on('pong', () => connection.touch());
    ws.on('close', (code, reason) => {
      this.sockets.delete(ws);
      connection.handleClose({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      /* followed by close */
    });
  }

  // --- hooks --------------------------------------------------------------------

  private async onAuthenticate(data: onAuthenticatePayload<CollabContext>): Promise<Partial<CollabContext>> {
    const { db } = this.ctx;
    const target = this.targetOf(data.documentName);
    if (!target) throw denied();
    const { pageId, syncedId } = target;
    const page = getPageRow(db, pageId);
    if (!page) throw denied();
    const synced = syncedId ? { syncedId } : {};
    // The socket may outlive its session (logout, password change, expiry): re-check it for every document.
    const userId = data.context.userId && this.sessionAlive(data.context.sessionId) ? data.context.userId : null;
    if (userId) {
      const role = roleOf(db, userId, page.workspace_id);
      if (role && canSeePage(userId, role, page, db)) {
        data.context.anonymousDocs?.delete(data.documentName);
        // A page in the trash is read-only, as through the REST API (QA-INT-04, QA-EDT-02).
        if (!canEditRole(role) || page.trashed_at !== null) data.connectionConfig.readOnly = true;
        const user = db.get<{ name: string; avatar_url: string | null }>('SELECT name, avatar_url FROM users WHERE id = ?', userId);
        return { pageId, workspaceId: page.workspace_id, ...synced, anonymous: false, userName: user?.name ?? '', avatarUrl: user?.avatar_url ?? null };
      }
    }
    if (isPubliclyVisible(db, pageId)) {
      data.connectionConfig.readOnly = true;
      data.context.anonymousDocs?.add(data.documentName);
      return { userId, pageId, workspaceId: page.workspace_id, ...synced, anonymous: true };
    }
    throw denied();
  }

  /**
   * Page document, or synced block document resolved to its owner page (stored server-side with
   * its workspace; the id is checked strictly). Null for any other name.
   */
  private targetOf(documentName: string): DocumentTarget | null {
    const pageId = parseCollabDocumentName(documentName);
    if (pageId) return { pageId, syncedId: null };
    const syncedId = parseSyncedDocumentName(documentName);
    if (!syncedId) return null;
    const row = this.ctx.db.get<{ owner_page_id: string; workspace_id: string }>(
      'SELECT owner_page_id, workspace_id FROM editor_synced_blocks WHERE id = ?',
      syncedId,
    );
    if (!row) return null;
    const owner = getPageRow(this.ctx.db, row.owner_page_id);
    if (!owner || owner.workspace_id !== row.workspace_id) return null;
    return { pageId: owner.id, syncedId };
  }

  private sessionAlive(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const row = this.ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE id = ?', sessionId);
    return !!row && row.expires_at > Date.now();
  }

  /**
   * Presence is relayed to every peer of a document, so it is sanitized here: public (anonymous)
   * visitors cannot publish any presence, a connection cannot overwrite or remove the presence of a
   * client id owned by another connection, and the identity shown (`user.id/name/avatarUrl`) is the
   * authenticated one.
   */
  private async beforeHandleAwareness(data: beforeHandleAwarenessPayload<CollabContext>): Promise<void> {
    const { connection, document, states, removedClients } = data;
    if (!connection) return; // server-side update
    const context = connection.context as CollabContext | undefined;
    if (!context || context.anonymous || !context.userId) {
      states.clear();
      removedClients.clear();
      return;
    }
    const own = document.getClients(connection);
    const others = document.getConnections().filter((c) => c !== connection);
    const ownedByAnother = (clientId: number) => !own.has(clientId) && others.some((c) => document.getClients(c).has(clientId));
    for (const clientId of [...states.keys()]) if (ownedByAnother(clientId)) states.delete(clientId);
    for (const clientId of [...removedClients]) if (ownedByAnother(clientId)) removedClients.delete(clientId);
    for (const state of states.values()) {
      const user = state.user;
      if (user && typeof user === 'object' && !Array.isArray(user)) {
        state.user = { ...user, id: context.userId, name: context.userName ?? '', avatarUrl: context.avatarUrl ?? null };
      }
    }
  }

  /**
   * Updates of editors are checked before Yjs applies them (updateGuard.ts). A refused one closes
   * that document's connection: nothing of it reaches the document, the other editors or the database.
   */
  private async beforeSync(data: beforeSyncPayload<CollabContext>): Promise<void> {
    // 1 = SyncStep2 and 2 = Update carry an update (0 = SyncStep1, a state vector); read-only
    // connections never apply theirs.
    if ((data.type !== 1 && data.type !== 2) || data.connection.readOnly) return;
    const problem = this.canvasDocs.has(data.document) ? checkCanvasUpdate(data.document, data.payload) : checkCollabUpdate(data.document, data.payload);
    if (problem) throw new RefusedUpdate(`collab : mise à jour refusée sur ${data.documentName} (${problem})`);
  }

  private async onLoadDocument(data: onLoadDocumentPayload<CollabContext>): Promise<void> {
    const doc = data.document;
    const syncedId = parseSyncedDocumentName(data.documentName);
    if (syncedId) {
      doc.on('afterTransaction', () => dropPendingStructs(doc));
      const row = this.ctx.db.get<{ state: Uint8Array | null }>('SELECT state FROM editor_synced_blocks WHERE id = ?', syncedId);
      if (row?.state && row.state.byteLength > 0) Y.applyUpdate(doc, row.state);
      return;
    }
    const pageId = parseCollabDocumentName(data.documentName);
    if (!pageId) return;
    // Structs left pending (missing dependencies) were not checked by beforeSync: they must never
    // be integrated by a later update.
    doc.on('afterTransaction', () => dropPendingStructs(doc));
    const row = this.ctx.db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', pageId);
    if (row?.state && row.state.byteLength > 0) Y.applyUpdate(doc, row.state);
    // Canvas page (H1): layout fixed at creation, so the guard chosen here holds for the document's life.
    if (isCanvasRow(getPageRow(this.ctx.db, pageId))) {
      this.canvasDocs.add(doc);
      prepareCanvasDocument(doc);
    }
    // The root is typed as an XML fragment before any update arrives: until `getXmlFragment` is called, Yjs
    // holds an update's root type generically and the block tracker could not read its children.
    if (!this.canvasDocs.has(doc)) doc.getXmlFragment(COLLAB_FRAGMENT);
    this.windows.set(doc, { writers: new Set(), since: stateVectorOf(doc), blocks: new BlockTouches() });
    doc.on('update', (_update: Uint8Array, origin: unknown) => this.recordWriter(doc, origin));
    // Block metadata: which blocks each authenticated editor changed (kept outside the document).
    doc.on('afterTransaction', (transaction: Y.Transaction) => this.recordBlocks(doc, transaction));
  }

  /** The authenticated, non-anonymous user behind the origin of a transaction, or null. */
  private originUser(origin: unknown): string | null {
    const o = origin as { source?: unknown; connection?: { context?: CollabContext }; context?: CollabContext } | null | undefined;
    const context = o?.source === 'connection' ? o.connection?.context : o?.source === 'local' ? o.context : undefined;
    return context?.userId && !context.anonymous ? context.userId : null;
  }

  private recordBlocks(doc: Y.Doc, transaction: Y.Transaction): void {
    try {
      // Canvas documents have no blocks of text (their objects are tracked by the canvas module).
      if (this.canvasDocs.has(doc)) return;
      const userId = this.originUser(transaction.origin);
      if (userId) this.windows.get(doc)?.blocks.record(transaction, userId);
    } catch {
      /* metadata is best effort: never disturb the editing path */
    }
  }

  /** Synchronous with the change (before any store): the user behind a connection or direct connection. */
  private recordWriter(doc: Y.Doc, origin: unknown): void {
    const o = origin as { source?: unknown; connection?: { context?: CollabContext }; context?: CollabContext } | null | undefined;
    const context = o?.source === 'connection' ? o.connection?.context : o?.source === 'local' ? o.context : undefined;
    if (!context?.userId || context.anonymous) return;
    this.windows.get(doc)?.writers.add(context.userId);
  }

  private async onStoreDocument(data: onStoreDocumentPayload<CollabContext>): Promise<void> {
    const lastContext = data.lastContext as CollabContext | undefined;
    const actorId = lastContext?.anonymous ? null : (lastContext?.userId ?? null);
    const syncedId = parseSyncedDocumentName(data.documentName);
    if (syncedId) {
      this.persistSynced(syncedId, data.document);
      return;
    }
    const pageId = parseCollabDocumentName(data.documentName);
    if (!pageId) return;
    const window = this.windows.get(data.document);
    const authors = window && { writers: window.writers, isRecent: (id: Y.ID) => id.clock >= (window.since.get(id.client) ?? 0) };
    // Collab module: person-mention notifications and date reminders (before persist: it needs to
    // know whether the document existed). Never throws.
    processStoredDocument(this.ctx, pageId, data.document, actorId, authors);
    this.persist(pageId, data.document, actorId);
    if (window && !window.blocks.isEmpty) {
      try {
        flushBlockMeta(this.ctx.db, pageId, data.document, window.blocks);
      } catch {
        /* best effort */
      }
    }
    this.windows.set(data.document, { writers: new Set(), since: stateVectorOf(data.document), blocks: new BlockTouches() });
  }

  /** Saves the state and text of a synced block (its pages are not touched: they only reference it). */
  persistSynced(syncedId: string, doc: Y.Doc): void {
    const state = Y.encodeStateAsUpdate(doc);
    const { text } = extractContent(doc);
    this.ctx.db.run('UPDATE editor_synced_blocks SET state = ?, text = ?, updated_at = ? WHERE id = ?', state, text, Date.now(), syncedId);
  }

  /** Saves the full state, text, search index, links, editors and snapshots of a page document. */
  persist(pageId: string, doc: Y.Doc, userId: string | null): void {
    const { db } = this.ctx;
    const state = Y.encodeStateAsUpdate(doc);
    const { text, links, synced } = this.canvasDocs.has(doc) ? extractCanvasContent(doc) : extractContent(doc);
    db.tx(() => {
      const page = getPageRow(db, pageId);
      if (!page) return; // deleted meanwhile
      const now = Date.now();
      const existing = db.get<{ editors: string }>('SELECT editors FROM documents WHERE page_id = ?', pageId);
      const editors = new Set(parseJson<string[]>(existing?.editors, []));
      if (userId) editors.add(userId);

      const last = db.get<{ state: Uint8Array; created_at: number }>(
        'SELECT state, created_at FROM snapshots WHERE page_id = ? ORDER BY created_at DESC LIMIT 1',
        pageId,
      );
      const lastDaily = db.get<{ created_at: number }>(
        "SELECT created_at FROM snapshots WHERE page_id = ? AND reason = 'daily' ORDER BY created_at DESC LIMIT 1",
        pageId,
      );
      const changed = !last || !sameBytes(last.state, state);
      let reason: 'auto' | 'daily' | null = null;
      if (changed && (!lastDaily || now - lastDaily.created_at >= DAILY_SNAPSHOT_MS)) reason = 'daily';
      else if (changed && (!last || now - last.created_at >= AUTO_SNAPSHOT_MS)) reason = 'auto';
      if (reason) {
        db.run(
          'INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, ?, ?)',
          newId(),
          pageId,
          state,
          now,
          JSON.stringify([...editors]),
          reason,
        );
        editors.clear();
      }

      db.run(
        `INSERT INTO documents (page_id, state, text, updated_at, editors) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, text = excluded.text, updated_at = excluded.updated_at,
           editors = excluded.editors`,
        pageId,
        state,
        text,
        now,
        JSON.stringify([...editors]),
      );
      if (userId) db.run('UPDATE pages SET updated_at = ?, updated_by = ? WHERE id = ?', now, userId, pageId);
      indexPage(db, page, text);
      recordSyncedRefs(db, pageId, page.workspace_id, synced);

      const previous = new Set(db.all<{ target_id: string }>('SELECT target_id FROM page_links WHERE source_id = ?', pageId).map((r) => r.target_id));
      const next = new Set(links.filter((id) => id !== pageId));
      db.run('DELETE FROM page_links WHERE source_id = ?', pageId);
      for (const target of next) db.run('INSERT OR IGNORE INTO page_links (source_id, target_id) VALUES (?, ?)', pageId, target);

      emitPage(this.ctx, getPageRow(db, pageId)!, false);
      // Backlinks of pages that gained or lost a reference.
      for (const target of new Set([...previous, ...next])) {
        if (previous.has(target) && next.has(target)) continue;
        const t = getPageRow(db, target);
        if (t && t.workspace_id === page.workspace_id) emitPage(this.ctx, t, false);
      }
    });
  }

  // --- CollabControl --------------------------------------------------------------

  private loadedDocument(pageId: string): HocusDocument | undefined {
    const doc = this.hocuspocus.documents.get(collabDocumentName(pageId));
    return doc && !doc.isLoading ? doc : undefined;
  }

  liveState(pageId: string): Uint8Array | null {
    const doc = this.loadedDocument(pageId);
    return doc ? Y.encodeStateAsUpdate(doc) : null;
  }

  /**
   * Every connection with the page whose access rules apply to it: the page of a `page:` document,
   * the owner page of a synced block (recorded when the connection was authenticated), so that
   * revocations and downgrades reach synced blocks like the pages that own them.
   */
  private forEachConnection(fn: (conn: Connection<CollabContext>, pageId: string) => void): void {
    for (const doc of this.hocuspocus.documents.values()) {
      const pageId = parseCollabDocumentName(doc.name);
      const synced = !pageId && parseSyncedDocumentName(doc.name) !== null;
      if (!pageId && !synced) continue;
      for (const conn of doc.getConnections() as Array<Connection<CollabContext>>) {
        const accessPage = pageId ?? conn.context?.pageId;
        if (accessPage) fn(conn, accessPage);
        else conn.close({ code: 4403, reason: 'forbidden' });
      }
    }
  }

  closeForUser(userId: string, workspaceId: string): void {
    this.forEachConnection((conn) => {
      if (conn.context?.userId === userId && conn.context?.workspaceId === workspaceId) conn.close({ code: 4403, reason: 'forbidden' });
    });
  }

  closeForSession(sessionId: string): void {
    this.forEachConnection((conn) => {
      if (conn.context?.sessionId === sessionId) conn.close({ code: 4401, reason: 'session-ended' });
    });
  }

  setReadOnlyForUser(userId: string, workspaceId: string, readOnly: boolean): void {
    this.forEachConnection((conn, pageId) => {
      if (conn.context?.userId !== userId || conn.context?.workspaceId !== workspaceId || conn.context.anonymous) return;
      conn.readOnly = readOnly || getPageRow(this.ctx.db, pageId)?.trashed_at !== null;
    });
  }

  refreshReadOnly(pageIds: string[]): void {
    const ids = new Set(pageIds);
    this.forEachConnection((conn, pageId) => {
      const c = conn.context;
      if (!ids.has(pageId) || !c?.userId || c.anonymous || !c.workspaceId) return;
      const page = getPageRow(this.ctx.db, pageId);
      conn.readOnly = !page || page.trashed_at !== null || !canEditRole(roleOf(this.ctx.db, c.userId, c.workspaceId));
    });
  }

  closeUnauthorized(pageIds: string[]): void {
    const ids = new Set(pageIds);
    const { db } = this.ctx;
    this.forEachConnection((conn, pageId) => {
      if (!ids.has(pageId)) return;
      const c = conn.context;
      if (!c || c.anonymous || !c.userId) return;
      const page = getPageRow(db, pageId);
      const role = page ? roleOf(db, c.userId, page.workspace_id) : null;
      if (!page || !role || !canSeePage(c.userId, role, page, db)) conn.close({ code: 4403, reason: 'forbidden' });
    });
  }

  closeDocuments(pageIds: string[], opts: { keepUserId?: string; onlyAnonymous?: boolean } = {}): void {
    const ids = new Set(pageIds);
    this.forEachConnection((conn, pageId) => {
      if (!ids.has(pageId)) return;
      if (opts.keepUserId && conn.context?.userId === opts.keepUserId && !conn.context.anonymous) return;
      if (opts.onlyAnonymous && !conn.context?.anonymous) return;
      conn.close({ code: 4403, reason: 'forbidden' });
    });
  }

  async restoreSnapshot(pageId: string, snapshotState: Uint8Array, actorId: string): Promise<void> {
    const { db } = this.ctx;
    const direct = await this.hocuspocus.openDirectConnection(collabDocumentName(pageId), { userId: actorId, pageId });
    try {
      const doc = direct.document;
      if (!doc) return;
      const current = Y.encodeStateAsUpdate(doc);
      db.tx(() => {
        const existing = db.get<{ editors: string }>('SELECT editors FROM documents WHERE page_id = ?', pageId);
        const authors = new Set(parseJson<string[]>(existing?.editors, []));
        db.run(
          "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, ?, 'before-restore')",
          newId(),
          pageId,
          current,
          Date.now(),
          JSON.stringify([...authors]),
        );
        db.run("UPDATE documents SET editors = '[]' WHERE page_id = ?", pageId);
      });
      const canvas = isCanvasRow(getPageRow(db, pageId));
      await direct.transact((d) => (canvas ? replaceCanvasWithState(d, snapshotState) : replaceFragmentWithState(d, snapshotState)));
    } finally {
      await direct.disconnect();
    }
  }

  // --- shutdown -------------------------------------------------------------------

  private hasPendingWork(): boolean {
    for (const doc of this.hocuspocus.documents.values()) {
      const id = `onStoreDocument-${doc.name}`;
      if (doc.saveMutex.isLocked() || this.hocuspocus.debouncer.isDebounced(id) || this.hocuspocus.debouncer.isCurrentlyExecuting(id)) {
        return true;
      }
    }
    return false;
  }

  /** Closes sockets, persists pending documents and waits (bounded) for the stores to finish. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    clearInterval(this.pinger);
    for (const ws of this.sockets) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    this.hocuspocus.flushPendingStores();
    const deadline = Date.now() + timeoutMs;
    while (this.hasPendingWork() && Date.now() < deadline) {
      this.hocuspocus.flushPendingStores();
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
