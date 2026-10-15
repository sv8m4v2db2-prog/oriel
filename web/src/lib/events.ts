// Real-time invalidation client for /api/events ("push invalidation, pull data").
// The server pushes `Change`s; we invalidate the matching TanStack queries (keys from qk only).
import type { QueryClient } from '@tanstack/react-query';
import type { Change, ClientMessage, ServerMessage } from '@oriel/shared';
import { qk } from './queryKeys';
import { ck } from '../collab/keys';
import { nk } from '../shell/nav/api';
import { createStore } from './store';

export type EventsStatus = 'idle' | 'connecting' | 'open' | 'closed';
export const eventsStatusStore = createStore<EventsStatus>('idle');

/**
 * Applies the invalidation table of ARCHITECTURE §4 for one change. `seen`: keys already invalidated
 * for the same message (a batch of row writes must not refetch the rows once per row).
 */
export function applyChange(queryClient: QueryClient, workspaceId: string, change: Change, seen?: Set<string>) {
  const inv = (queryKey: readonly unknown[]) => {
    if (seen) {
      const k = JSON.stringify(queryKey);
      if (seen.has(k)) return;
      seen.add(k);
    }
    void queryClient.invalidateQueries({ queryKey });
  };
  switch (change.entity) {
    case 'page':
      inv(qk.page(change.id));
      inv(qk.backlinks(change.id));
      if (change.affectsTree) {
        inv(qk.tree(workspaceId));
        inv(qk.recent(workspaceId));
        inv(qk.favorites(workspaceId));
        inv(nk.sidebar(workspaceId));
        inv(nk.folders(workspaceId));
        // Organize module: « Toutes les pages », tag counts, journal calendar.
        inv(['org', 'list']);
        inv(['org', 'tags', workspaceId]);
        inv(['org', 'journal']);
      }
      if (change.databaseId) inv(qk.rows(change.databaseId));
      if (change.kind === 'database') inv(qk.database(change.id));
      break;
    case 'database':
      inv(qk.database(change.id));
      inv(qk.rows(change.id));
      break;
    case 'view':
      inv(qk.database(change.databaseId));
      break;
    case 'workspace':
      inv(qk.workspace(change.id));
      inv(qk.workspaces);
      inv(qk.session);
      break;
    case 'members':
      inv(qk.members(change.workspaceId));
      inv(qk.invites(change.workspaceId));
      break;
    case 'favorites':
      inv(qk.favorites(change.workspaceId));
      break;
    case 'trash':
      inv(qk.trash(change.workspaceId));
      break;
    case 'comments':
      inv(ck.threads(change.pageId));
      break;
    case 'notifications':
      inv(ck.notificationsAll(change.workspaceId));
      inv(ck.unread(change.workspaceId));
      break;
    case 'navigation':
      // Navigation module (teamspaces, personal sidebar, folders).
      if (change.scope === 'teamspaces') {
        inv(nk.teamspaces(change.workspaceId));
        void queryClient.invalidateQueries({ queryKey: ['nav-teamspaces-members'] });
        inv(qk.tree(workspaceId));
      }
      if (change.scope === 'sidebar') inv(nk.sidebar(change.workspaceId));
      if (change.scope === 'folders') inv(nk.folders(change.workspaceId));
      break;
    case 'organize': {
      // Organize module: journal, tags, workspace properties, collections, views, folder items.
      const org = (kind: string) => void queryClient.invalidateQueries({ queryKey: ['org', kind] });
      const kinds: Record<typeof change.scope, string[]> = {
        journal: ['journal'],
        tags: ['tags', 'page-org', 'list', 'preview'],
        props: ['props', 'page-org', 'list', 'preview'],
        collections: ['collections', 'list', 'preview'],
        views: ['views'],
        'folder-items': ['folder-items'],
      };
      kinds[change.scope].forEach(org);
      break;
    }
  }
}

interface EventsOptions {
  onRevoked?: (workspaceId: string) => void;
}

class EventsClient {
  private ws: WebSocket | null = null;
  private queryClient: QueryClient | null = null;
  private workspaceId: string | null = null;
  private subscribedTo: string | null = null;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private hadConnection = false;
  private running = false;
  private options: EventsOptions = {};

  start(queryClient: QueryClient, options: EventsOptions = {}) {
    this.queryClient = queryClient;
    this.options = options;
    if (this.running) return;
    this.running = true;
    this.connect();
    window.addEventListener('online', this.handleOnline);
  }

  stop() {
    this.running = false;
    window.removeEventListener('online', this.handleOnline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    this.subscribedTo = null;
    this.hadConnection = false;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    eventsStatusStore.set('idle');
  }

  setWorkspace(workspaceId: string | null) {
    if (this.workspaceId === workspaceId) return;
    const previous = this.subscribedTo;
    this.workspaceId = workspaceId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (previous) this.send({ type: 'unsubscribe', workspaceId: previous });
      this.subscribedTo = null;
      if (workspaceId) {
        this.send({ type: 'subscribe', workspaceId });
        this.subscribedTo = workspaceId;
      }
    }
  }

  private handleOnline = () => {
    if (!this.running) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.backoff = 1000;
      this.connect();
    }
  };

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private connect() {
    if (!this.running) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    eventsStatusStore.set('connecting');
    ws.onopen = () => {
      this.backoff = 1000;
      eventsStatusStore.set('open');
      if (this.workspaceId) {
        this.send({ type: 'subscribe', workspaceId: this.workspaceId });
        this.subscribedTo = this.workspaceId;
      }
      // Anything may have changed while we were away.
      if (this.hadConnection) void this.queryClient?.invalidateQueries();
      this.hadConnection = true;
      this.clearPing();
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 30_000);
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      this.clearPing();
      this.subscribedTo = null;
      if (this.ws === ws) this.ws = null;
      eventsStatusStore.set('closed');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(msg: ServerMessage) {
    const qc = this.queryClient;
    if (!qc) return;
    switch (msg.type) {
      case 'changes':
        {
          const seen = new Set<string>();
          for (const change of msg.changes) applyChange(qc, msg.workspaceId, change, seen);
        }
        break;
      case 'revoked':
        void qc.invalidateQueries({ queryKey: qk.workspaces });
        void qc.invalidateQueries({ queryKey: qk.session });
        this.options.onRevoked?.(msg.workspaceId);
        break;
      default:
        break;
    }
  }
}

export const events = new EventsClient();
