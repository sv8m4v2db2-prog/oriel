// Invalidation bus behind the /api/events WebSocket (protocol: shared/src/events.ts, ARCHITECTURE §3.5).
import type { WebSocket } from 'ws';
import type { Change, ClientMessage, ServerMessage } from '@oriel/shared';
import type { Db } from '../db/index.js';

interface QueuedChange {
  change: Change;
  /** When set, only this user receives the change (private pages, favorites). */
  onlyUserId?: string;
  /** When set, only users for whom it returns true receive the change (restricted teamspace pages). */
  audience?: (userId: string) => boolean;
}

/** Recipient filter of a change: one user id, or a predicate evaluated per connected user. */
export type ChangeAudience = string | ((userId: string) => boolean) | undefined;

interface EventClient {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  subscriptions: Set<string>;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 50;

export class EventBus {
  private readonly clients = new Set<EventClient>();
  private readonly pending = new Map<string, { items: QueuedChange[]; timer: NodeJS.Timeout }>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly batchMs: number,
    /** Membership check used when a client subscribes. */
    private readonly isMember: (userId: string, workspaceId: string) => boolean,
  ) {
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Queues a change for a workspace; delivered after the current transaction commits (≤ batchMs later). */
  publish(workspaceId: string, change: Change, only?: ChangeAudience): void {
    const item: QueuedChange = typeof only === 'function' ? { change, audience: only } : { change, onlyUserId: only };
    this.db.afterCommit(() => this.enqueue(workspaceId, item));
  }

  private enqueue(workspaceId: string, item: QueuedChange): void {
    let entry = this.pending.get(workspaceId);
    if (!entry) {
      const timer = setTimeout(() => this.flush(workspaceId), this.batchMs);
      entry = { items: [], timer };
      this.pending.set(workspaceId, entry);
    }
    entry.items.push(item);
  }

  flush(workspaceId: string): void {
    const entry = this.pending.get(workspaceId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(workspaceId);
    for (const client of this.clients) {
      if (!client.subscriptions.has(workspaceId)) continue;
      const seen = new Set<string>();
      const changes: Change[] = [];
      for (const item of entry.items) {
        if (item.onlyUserId && item.onlyUserId !== client.userId) continue;
        if (item.audience && !this.inAudience(item.audience, client.userId)) continue;
        const key = JSON.stringify(item.change);
        if (seen.has(key)) continue;
        seen.add(key);
        changes.push(item.change);
      }
      if (changes.length > 0) this.send(client, { type: 'changes', workspaceId, changes });
    }
  }

  /** Fail closed: a predicate that throws (page deleted meanwhile, closed database) filters out. */
  private inAudience(audience: (userId: string) => boolean, userId: string): boolean {
    try {
      return audience(userId);
    } catch {
      return false;
    }
  }

  flushAll(): void {
    for (const wid of [...this.pending.keys()]) this.flush(wid);
  }

  /** The user lost access to a workspace: notify and unsubscribe their sockets. */
  revoke(workspaceId: string, userId: string): void {
    this.db.afterCommit(() => {
      for (const client of this.clients) {
        if (client.userId !== userId) continue;
        if (client.subscriptions.delete(workspaceId)) this.send(client, { type: 'revoked', workspaceId });
      }
    });
  }

  /** Workspace deleted: tell every socket of the former members, then revoke. */
  workspaceDeleted(workspaceId: string, memberIds: string[]): void {
    const members = new Set(memberIds);
    this.db.afterCommit(() => {
      this.flush(workspaceId);
      for (const client of this.clients) {
        if (!members.has(client.userId) && !client.subscriptions.has(workspaceId)) continue;
        this.send(client, {
          type: 'changes',
          workspaceId,
          changes: [{ entity: 'workspace', id: workspaceId, deleted: true }],
        });
        client.subscriptions.delete(workspaceId);
        this.send(client, { type: 'revoked', workspaceId });
      }
    });
  }

  /** Close the sockets opened with a session (logout). */
  closeSession(sessionId: string): void {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) client.ws.close(4001, 'session-ended');
    }
  }

  attach(ws: WebSocket, userId: string, sessionId: string): void {
    const client: EventClient = { ws, userId, sessionId, subscriptions: new Set(), alive: true };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      this.handleMessage(client, msg);
    });
    ws.on('close', () => {
      this.clients.delete(client);
    });
    ws.on('error', () => {
      this.clients.delete(client);
    });
    this.send(client, { type: 'hello', userId });
  }

  private handleMessage(client: EventClient, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
      case 'subscribe': {
        const wid = typeof msg.workspaceId === 'string' ? msg.workspaceId : '';
        if (!wid) return;
        if (!this.sessionAlive(client.sessionId)) {
          client.ws.close(4001, 'session-ended');
          return;
        }
        if (!this.isMember(client.userId, wid)) {
          this.send(client, { type: 'revoked', workspaceId: wid });
          return;
        }
        if (client.subscriptions.size >= MAX_SUBSCRIPTIONS && !client.subscriptions.has(wid)) return;
        client.subscriptions.add(wid);
        this.send(client, { type: 'subscribed', workspaceId: wid });
        return;
      }
      case 'unsubscribe':
        if (typeof msg.workspaceId === 'string') client.subscriptions.delete(msg.workspaceId);
        return;
      default:
        return;
    }
  }

  private sessionAlive(sessionId: string): boolean {
    const row = this.db.get<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE id = ?', sessionId);
    return !!row && row.expires_at > Date.now();
  }

  private send(client: EventClient, msg: ServerMessage): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private sweep(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'server-shutdown');
        client.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
