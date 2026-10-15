// Comment threads: storage, access rules, DTOs and the notifications they trigger.
//  - read: anyone who can read the page (never through the public API);
//  - write (create, reply, react, resolve): workspace members who can edit (not viewers);
//  - edit a comment: its author; delete a comment: its author or a workspace owner/admin;
//  - delete a thread: its creator or a workspace owner/admin.
import type { CommentItem, CommentReaction, CommentThread, PublicUser } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson, toPublicUser, type PageRow, type UserRow } from '../db/rows.js';
import { canManageRole, pageAccess, pageAudience, type PageAccess } from '../access.js';
import { cannotEdit, notFound } from '../errors.js';
import { bodyMentions, bodyText, truncate } from './body.js';
import { notify } from './notify.js';

export interface ThreadRow {
  id: string;
  page_id: string;
  workspace_id: string;
  anchored: number;
  quote: string;
  resolved_at: number | null;
  resolved_by: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  id: string;
  thread_id: string;
  user_id: string;
  body: string;
  text: string;
  mentions: string;
  created_at: number;
  updated_at: number;
}

export interface ThreadAccess extends PageAccess {
  thread: ThreadRow;
  canComment: boolean;
  canModerate: boolean;
}

export const threadNotFound = () => notFound('Discussion introuvable.');
export const commentNotFound = () => notFound('Commentaire introuvable.');

export function commentAccess(access: PageAccess): { canComment: boolean; canModerate: boolean } {
  const writable = access.canEdit && access.page.trashed_at === null;
  return { canComment: writable, canModerate: writable && canManageRole(access.role) };
}

/** Thread + page access for a user; invisible → 404; `write` requires comment rights. */
export function requireThread(db: Db, userId: string, threadId: string, mode: 'read' | 'write' = 'read'): ThreadAccess {
  const thread = db.get<ThreadRow>('SELECT * FROM collab_threads WHERE id = ?', threadId);
  if (!thread) throw threadNotFound();
  const access = pageAccess(db, userId, thread.page_id);
  if (!access) throw threadNotFound();
  const rights = commentAccess(access);
  if (mode === 'write' && !rights.canComment) throw cannotEdit();
  return { ...access, thread, ...rights };
}

export function requireComment(db: Db, userId: string, commentId: string, mode: 'read' | 'write' = 'read'): ThreadAccess & { comment: CommentRow } {
  const comment = db.get<CommentRow>('SELECT * FROM collab_comments WHERE id = ?', commentId);
  if (!comment) throw commentNotFound();
  try {
    return { ...requireThread(db, userId, comment.thread_id, mode), comment };
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw commentNotFound();
    throw err;
  }
}

/** Publishes `comments` for a page (private pages: owner only). */
export function emitComments(ctx: AppContext, page: Pick<PageRow, 'id' | 'workspace_id' | 'visibility' | 'owner_id'>): void {
  ctx.bus.publish(page.workspace_id, { entity: 'comments', pageId: page.id }, pageAudience(ctx.db, page));
}

// --- DTO -------------------------------------------------------------------------------------

function reactionsOf(db: Db, commentIds: string[]): Map<string, CommentReaction[]> {
  const out = new Map<string, CommentReaction[]>();
  if (commentIds.length === 0) return out;
  const rows = db.all<{ comment_id: string; user_id: string; emoji: string; created_at: number }>(
    `SELECT comment_id, user_id, emoji, created_at FROM collab_reactions WHERE comment_id IN (${commentIds.map(() => '?').join(',')})
     ORDER BY created_at`,
    ...commentIds,
  );
  for (const r of rows) {
    const list = out.get(r.comment_id) ?? [];
    let reaction = list.find((x) => x.emoji === r.emoji);
    if (!reaction) {
      reaction = { emoji: r.emoji, userIds: [], createdAt: r.created_at };
      list.push(reaction);
    }
    reaction.userIds.push(r.user_id);
    out.set(r.comment_id, list);
  }
  return out;
}

export function toComment(row: CommentRow, reactions: CommentReaction[] = []): CommentItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    userId: row.user_id,
    body: parseJson<unknown[]>(row.body, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reactions,
  };
}

export function loadThreads(db: Db, threadRows: ThreadRow[]): { threads: CommentThread[]; users: PublicUser[] } {
  if (threadRows.length === 0) return { threads: [], users: [] };
  const ids = threadRows.map((t) => t.id);
  const comments = db.all<CommentRow>(
    `SELECT * FROM collab_comments WHERE thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`,
    ...ids,
  );
  const reactions = reactionsOf(
    db,
    comments.map((c) => c.id),
  );
  const userIds = new Set<string>();
  const byThread = new Map<string, CommentItem[]>();
  for (const c of comments) {
    const item = toComment(c, reactions.get(c.id));
    userIds.add(c.user_id);
    for (const r of item.reactions) r.userIds.forEach((u) => userIds.add(u));
    const list = byThread.get(c.thread_id) ?? [];
    list.push(item);
    byThread.set(c.thread_id, list);
  }
  const threads: CommentThread[] = [];
  for (const t of threadRows) {
    const list = byThread.get(t.id) ?? [];
    if (list.length === 0) continue;
    userIds.add(t.created_by);
    if (t.resolved_by) userIds.add(t.resolved_by);
    threads.push({
      id: t.id,
      pageId: t.page_id,
      anchored: t.anchored === 1,
      quote: t.quote,
      resolved: t.resolved_at !== null,
      resolvedAt: t.resolved_at,
      resolvedBy: t.resolved_by,
      createdBy: t.created_by,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      comments: list,
    });
  }
  const users = userIds.size
    ? db.all<UserRow>(`SELECT * FROM users WHERE id IN (${[...userIds].map(() => '?').join(',')})`, ...userIds).map(toPublicUser)
    : [];
  return { threads, users };
}

export function threadDto(db: Db, threadId: string): CommentThread {
  const row = db.get<ThreadRow>('SELECT * FROM collab_threads WHERE id = ?', threadId);
  const t = row ? loadThreads(db, [row]).threads[0] : undefined;
  if (!t) throw threadNotFound();
  return t;
}

export function commentDto(db: Db, commentId: string): CommentItem {
  const row = db.get<CommentRow>('SELECT * FROM collab_comments WHERE id = ?', commentId);
  if (!row) throw commentNotFound();
  return toComment(row, reactionsOf(db, [row.id]).get(row.id));
}

// --- writes --------------------------------------------------------------------------------

/**
 * Display names for mentions, members of `workspaceId` only: a mention carries an arbitrary user id,
 * resolving it globally would reveal the name of anyone on the instance through excerpts.
 */
export function memberNameLookup(db: Db, workspaceId: string): (id: string) => string {
  const cache = new Map<string, string>();
  return (id) => {
    if (!cache.has(id)) {
      const row = db.get<{ name: string }>(
        'SELECT u.name AS name FROM users u JOIN members m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.id = ?',
        workspaceId,
        id,
      );
      cache.set(id, row?.name ?? 'quelqu’un');
    }
    return cache.get(id)!;
  };
}

export function insertComment(db: Db, threadId: string, userId: string, body: unknown[], id: string, now: number): CommentRow {
  const workspaceId = db.get<{ workspace_id: string }>('SELECT workspace_id FROM collab_threads WHERE id = ?', threadId)?.workspace_id ?? '';
  const text = bodyText(body, memberNameLookup(db, workspaceId));
  db.run(
    'INSERT INTO collab_comments (id, thread_id, user_id, body, text, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    threadId,
    userId,
    JSON.stringify(body),
    text,
    JSON.stringify(bodyMentions(body)),
    now,
    now,
  );
  return db.get<CommentRow>('SELECT * FROM collab_comments WHERE id = ?', id)!;
}

/**
 * Notifications for a new comment: people newly mentioned in it, then (replies) the other
 * participants of the thread, then the creator of the page. Each person is notified once.
 */
export function notifyForComment(
  ctx: AppContext,
  opts: { page: PageRow; thread: ThreadRow; comment: CommentRow; actorId: string; isNewThread: boolean; mentioned: string[] },
): void {
  const { db } = ctx;
  const { page, thread, comment, actorId } = opts;
  const done = new Set<string>([actorId]);
  const base = { workspaceId: page.workspace_id, actorId, pageId: page.id, threadId: thread.id, commentId: comment.id, excerpt: truncate(comment.text, 280) };
  for (const uid of opts.mentioned) {
    if (done.has(uid)) continue;
    if (notify(ctx, { ...base, userId: uid, type: 'comment_mention' })) done.add(uid);
  }
  if (!opts.isNewThread) {
    const participants = new Set(db.all<{ user_id: string }>('SELECT DISTINCT user_id FROM collab_comments WHERE thread_id = ?', thread.id).map((r) => r.user_id));
    participants.add(thread.created_by);
    for (const uid of participants) {
      if (done.has(uid)) continue;
      if (notify(ctx, { ...base, userId: uid, type: 'reply' })) done.add(uid);
    }
  }
  const creator = db.get<{ created_by: string }>('SELECT created_by FROM pages WHERE id = ?', page.id)?.created_by;
  if (creator && !done.has(creator)) notify(ctx, { ...base, userId: creator, type: 'comment' });
}

export function previousMentions(row: CommentRow): string[] {
  return parseJson<string[]>(row.mentions, []);
}
