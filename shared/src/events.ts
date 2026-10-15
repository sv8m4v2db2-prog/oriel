// Real-time invalidation protocol over the WebSocket at /api/events.
//
// The server never pushes record contents: it pushes *what changed*; clients re-read
// through the HTTP API (which re-applies access control) — "push invalidation, pull data".

import type { PageKind, ParentType } from './types.js';

export type Change =
  /** A page/database/row was created, updated, moved, trashed, restored or deleted. */
  | {
      entity: 'page';
      id: string;
      kind: PageKind;
      parentType: ParentType;
      parentId: string;
      /** Set when the page is a database row (parentType === 'database'). */
      databaseId: string | null;
      /** True when the change can affect the sidebar tree (non-row pages: create/move/trash/title/icon). */
      affectsTree: boolean;
    }
  /** Database schema (properties) changed. Row values may have been converted too. */
  | { entity: 'database'; id: string }
  /** A view was created, updated, moved or deleted. */
  | { entity: 'view'; id: string; databaseId: string }
  /** Workspace name/icon changed or the workspace was deleted. */
  | { entity: 'workspace'; id: string; deleted?: boolean }
  /** Membership, roles or invites changed. */
  | { entity: 'members'; workspaceId: string }
  /** The receiving user's favorites changed (sent only to that user). */
  | { entity: 'favorites'; workspaceId: string }
  /** Trash contents changed. */
  | { entity: 'trash'; workspaceId: string }
  /** Comment threads of a page changed (collab module). Private pages: owner only. */
  | { entity: 'comments'; pageId: string }
  /** The receiving user's notifications changed (collab module; sent only to that user). */
  | { entity: 'notifications'; workspaceId: string }
  /**
   * Navigation module: teamspaces (directory, members), the receiving user's sidebar shortcuts, or
   * folders changed. Teamspace and sidebar changes are sent only to the users concerned.
   */
  | { entity: 'navigation'; workspaceId: string; scope: 'teamspaces' | 'sidebar' | 'folders' }
  /**
   * Organize module (journal, tags, workspace page properties, collections, saved views). Changes on a
   * page (its tags or property values) only reach the people who can see that page.
   */
  | { entity: 'organize'; workspaceId: string; scope: 'journal' | 'tags' | 'props' | 'collections' | 'views' | 'folder-items' };

/** Client → server messages. */
export type ClientMessage =
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'ping' };

/** Server → client messages. */
export type ServerMessage =
  | { type: 'hello'; userId: string }
  | { type: 'subscribed'; workspaceId: string }
  | { type: 'changes'; workspaceId: string; changes: Change[] }
  /** The user lost access to the workspace (removed / workspace deleted). */
  | { type: 'revoked'; workspaceId: string }
  | { type: 'pong' };

/** Hocuspocus document name for a page's rich content. */
export const collabDocumentName = (pageId: string) => `page:${pageId}`;
export const parseCollabDocumentName = (name: string): string | null =>
  name.startsWith('page:') ? name.slice(5) : null;

/** Name of the Y.XmlFragment holding the editor content inside each page Y.Doc. */
export const COLLAB_FRAGMENT = 'blocknote';
