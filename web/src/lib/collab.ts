// Real-time collaboration plumbing: ONE shared websocket to /collab, one HocuspocusProvider per
// open page (ref-counted, so the main view and the peek panel can share or differ), local
// persistence in IndexedDB (y-indexeddb) for offline editing.
import { useEffect, useState } from 'react';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, collabDocumentName } from '@oriel/shared';
import { createStore, type Store } from './store';

/** Name prefix of the IndexedDB offline copies of pages (y-indexeddb). */
export const OFFLINE_DB_PREFIX = 'oriel:page:';

export interface PeerUser {
  clientId: number;
  id?: string;
  name: string;
  color: string;
  avatarUrl?: string | null;
}

export interface CollabState {
  /** Local IndexedDB copy loaded (or persistence disabled). */
  localLoaded: boolean;
  /** First handshake with the server done. */
  synced: boolean;
  /** Content changes not yet acknowledged by the server. */
  unsynced: number;
  /** Server granted read-only access. */
  readOnly: boolean;
  /** Server refused the document. */
  denied: boolean;
  peers: PeerUser[];
}

/**
 * What the page editor may show (QA-CORE-08):
 * - `denied`: the server refused the document (never show the local copy then);
 * - `loading`: local copy not loaded yet, or first handshake still awaited within the grace period;
 * - `ready`: synced with the server, or offline after the grace period WITH a local copy;
 * - `unavailable`: offline after the grace period and nothing local. Mounting an editable editor on
 *   an empty document that the server has not described yet would let the first keystroke create a
 *   second root block group, merged later with the server's content (corrupted page).
 */
export type CollabEditorGate = 'loading' | 'denied' | 'unavailable' | 'ready';

export function collabEditorGate(state: Pick<CollabState, 'denied' | 'localLoaded' | 'synced'>, opts: { isEmpty: boolean; waited: boolean }): CollabEditorGate {
  if (state.denied) return 'denied';
  if (!state.localLoaded) return 'loading';
  if (state.synced) return 'ready';
  if (!opts.waited) return 'loading';
  return opts.isEmpty ? 'unavailable' : 'ready';
}

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';
export const collabSocketStatus = createStore<SocketStatus>('connecting');
/** Total number of unsynced changes across all open documents. */
export const collabUnsyncedStore = createStore(0);

let socket: HocuspocusProviderWebsocket | null = null;

function getSocket(): HocuspocusProviderWebsocket {
  if (!socket) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new HocuspocusProviderWebsocket({ url: `${proto}://${location.host}/collab` });
    socket.on('status', ({ status }: { status: SocketStatus }) => collabSocketStatus.set(status));
  }
  return socket;
}

export class CollabEntry {
  /** Key of the entry: a page id, or the document name of a synced block (`synced:<id>`). */
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly fragment: Y.XmlFragment;
  private idb: IndexeddbPersistence | null = null;
  refs = 0;
  destroyTimer: ReturnType<typeof setTimeout> | null = null;
  readonly store: Store<CollabState>;
  private destroyed = false;

  constructor(pageId: string, persist: boolean, documentName = collabDocumentName(pageId)) {
    this.pageId = pageId;
    this.doc = new Y.Doc();
    this.fragment = this.doc.getXmlFragment(COLLAB_FRAGMENT);
    this.store = createStore<CollabState>({
      localLoaded: !persist,
      synced: false,
      unsynced: 0,
      readOnly: false,
      denied: false,
      peers: [],
    });
    if (persist) {
      try {
        this.idb = new IndexeddbPersistence(`${OFFLINE_DB_PREFIX}${pageId}`, this.doc);
        void this.idb.whenSynced
          .then(() => this.patch({ localLoaded: true }))
          .catch(() => this.patch({ localLoaded: true }));
        // Never block on a broken IndexedDB.
        setTimeout(() => this.patch({ localLoaded: true }), 1500);
      } catch {
        this.patch({ localLoaded: true });
      }
    }
    this.provider = new HocuspocusProvider({
      websocketProvider: getSocket(),
      name: documentName,
      document: this.doc,
      token: 'session',
      onSynced: ({ state }) => this.patch({ synced: state }),
      onAuthenticated: ({ scope }) => this.patch({ readOnly: scope === 'readonly', denied: false }),
      onAuthenticationFailed: () => this.patch({ denied: true }),
      onUnsyncedChanges: ({ number }) => {
        this.patch({ unsynced: number });
        recomputeUnsynced();
      },
      onAwarenessChange: () => this.updatePeers(),
    });
    this.provider.attach();
  }

  private patch(p: Partial<CollabState>) {
    if (this.destroyed) return;
    this.store.set((s) => ({ ...s, ...p }));
  }

  private updatePeers() {
    const awareness = this.provider.awareness;
    if (!awareness) return;
    const peers: PeerUser[] = [];
    const seen = new Set<string>();
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      const user = state.user as { id?: string; name?: string; color?: string; avatarUrl?: string | null } | undefined;
      if (!user || !user.name) return;
      const key = user.id ?? `c${clientId}`;
      if (seen.has(key)) return;
      seen.add(key);
      peers.push({ clientId, id: user.id, name: user.name, color: user.color ?? '#888', avatarUrl: user.avatarUrl ?? null });
    });
    this.patch({ peers });
  }

  get isEmpty(): boolean {
    return this.fragment.length === 0;
  }

  destroy() {
    this.destroyed = true;
    try {
      this.provider.destroy();
    } catch {
      /* ignore */
    }
    void this.idb?.destroy();
    this.doc.destroy();
  }
}

const entries = new Map<string, CollabEntry>();
/** Bumped whenever an entry is created or destroyed. */
const entriesVersion = createStore(0);

function recomputeUnsynced() {
  let total = 0;
  for (const e of entries.values()) total += e.store.get().unsynced;
  collabUnsyncedStore.set(total);
}

/** `documentName`: another collaborative document than the page's (synced blocks), keyed by `pageId`. */
export function acquireCollab(pageId: string, persist = true, documentName?: string): CollabEntry {
  let entry = entries.get(pageId);
  if (!entry) {
    entry = new CollabEntry(pageId, persist, documentName);
    entries.set(pageId, entry);
    entriesVersion.set((v) => v + 1);
  }
  if (entry.destroyTimer) {
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = null;
  }
  entry.refs += 1;
  return entry;
}

export function releaseCollab(entry: CollabEntry) {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  // Short grace period: quick back-and-forth navigation reuses the connection.
  const destroyLater = (delay: number) => {
    entry.destroyTimer = setTimeout(() => {
      if (entry.refs > 0) return;
      // Edits not acknowledged yet (offline): stay connected until the server has them, so that they
      // keep counting as unsynced (logout warning) and are sent as soon as the connection is back.
      const state = entry.store.get();
      if (state.unsynced > 0 && !state.denied && !state.readOnly) {
        destroyLater(5000);
        return;
      }
      entries.delete(entry.pageId);
      entry.destroy();
      recomputeUnsynced();
      entriesVersion.set((v) => v + 1);
    }, delay);
  };
  destroyLater(1500);
}

/** Close every document and the socket (logout / session change). */
export function resetCollab() {
  for (const e of entries.values()) {
    if (e.destroyTimer) clearTimeout(e.destroyTimer);
    e.destroy();
  }
  entries.clear();
  recomputeUnsynced();
  entriesVersion.set((v) => v + 1);
  if (socket) {
    socket.destroy();
    socket = null;
  }
}

export function getCollabEntry(pageId: string): CollabEntry | undefined {
  return entries.get(pageId);
}

/** Ref-counted access to a page's collaborative document. */
export function useCollab(pageId: string | null, persist = true, documentName?: string): CollabEntry | null {
  const [entry, setEntry] = useState<CollabEntry | null>(null);
  useEffect(() => {
    if (!pageId) {
      setEntry(null);
      return;
    }
    const e = acquireCollab(pageId, persist, documentName);
    setEntry(e);
    return () => {
      setEntry(null);
      releaseCollab(e);
    };
  }, [pageId, persist, documentName]);
  return entry && entry.pageId === pageId ? entry : null;
}

/** Subscribe to an entry's state (works with a null entry). */
export function useCollabState(entry: CollabEntry | null): CollabState | null {
  const [state, setState] = useState<CollabState | null>(entry ? entry.store.get() : null);
  useEffect(() => {
    if (!entry) {
      setState(null);
      return;
    }
    setState(entry.store.get());
    return entry.store.subscribe(() => setState(entry.store.get()));
  }, [entry]);
  return state;
}

/** Peers currently on a page (by page id, without opening the document). */
export function usePagePeers(pageId: string | null): PeerUser[] {
  const [peers, setPeers] = useState<PeerUser[]>([]);
  useEffect(() => {
    if (!pageId) {
      setPeers([]);
      return;
    }
    let unsub: (() => void) | null = null;
    const attach = () => {
      unsub?.();
      unsub = null;
      const entry = entries.get(pageId);
      if (!entry) {
        setPeers([]);
        return;
      }
      setPeers(entry.store.get().peers);
      unsub = entry.store.subscribe(() => setPeers(entry.store.get().peers));
    };
    attach();
    const unsubVersion = entriesVersion.subscribe(attach);
    return () => {
      unsub?.();
      unsubVersion();
    };
  }, [pageId]);
  return peers;
}
