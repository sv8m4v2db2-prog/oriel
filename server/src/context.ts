import type { ResolvedConfig } from './config.js';
import type { Db } from './db/index.js';
import type { EventBus } from './realtime/events.js';
import type { RateLimiter } from './auth/rateLimit.js';

/** What the REST services need from the collaboration layer (implemented by realtime/collab.ts). */
export interface CollabControl {
  /** Current in-memory state of a loaded page document (fresher than the database), or null. */
  liveState(pageId: string): Uint8Array | null;
  /** Close every collab connection of a user on pages of a workspace (membership removed). */
  closeForUser(userId: string, workspaceId: string): void;
  /** Close every collab connection opened with a session (logout, password change). */
  closeForSession(sessionId: string): void;
  /** Change the write permission of a user's open connections in a workspace (role change). */
  setReadOnlyForUser(userId: string, workspaceId: string, readOnly: boolean): void;
  /** Recompute the write permission of open connections to these pages (moved to or out of the trash). */
  refreshReadOnly(pageIds: string[]): void;
  /**
   * Close connections to the given pages. `keepUserId`: connections of that user stay open
   * (e.g. the owner when a page becomes private). `onlyAnonymous`: close public read-only viewers only.
   */
  closeDocuments(pageIds: string[], opts?: { keepUserId?: string; onlyAnonymous?: boolean }): void;
  /**
   * Navigation module: close the connections to these pages whose user can no longer read them
   * (left a teamspace, teamspace restricted, page moved into a restricted teamspace).
   */
  closeUnauthorized?(pageIds: string[]): void;
  /** Replace a page's content by a snapshot (creates a `before-restore` snapshot first). */
  restoreSnapshot(pageId: string, snapshotState: Uint8Array, actorId: string): Promise<void>;
}

export interface AppContext {
  db: Db;
  config: ResolvedConfig;
  bus: EventBus;
  collab: CollabControl;
  authLimiter: RateLimiter;
}

export const noopCollab: CollabControl = {
  liveState: () => null,
  closeForUser: () => {},
  closeForSession: () => {},
  setReadOnlyForUser: () => {},
  refreshReadOnly: () => {},
  closeDocuments: () => {},
  restoreSnapshot: async () => {},
};
