// Notifications (inbox): creation, access checks, DTOs and notification e-mails
// (immediate or daily digest, per user preference).
import { newId, ROLE_LABELS, type EmailFrequency, type NotificationItem, type NotificationType, type WorkspaceRole } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson, toPublicUser, type UserRow } from '../db/rows.js';
import { canSeePage, getPageRow, roleOf } from '../access.js';
import { formatFrenchDate, truncate } from './body.js';
import { baseUrl, getMailer } from './mailer.js';
import { digestMail, notificationMail, type NotificationMailItem } from './templates.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  workspace_id: string;
  type: NotificationType;
  actor_id: string | null;
  page_id: string | null;
  thread_id: string | null;
  comment_id: string | null;
  data: string;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
  emailed_at: number | null;
}

interface NotificationData {
  excerpt?: string;
  date?: string;
  role?: WorkspaceRole;
}

export interface NotifyInput {
  userId: string;
  workspaceId: string;
  type: NotificationType;
  actorId: string | null;
  pageId?: string | null;
  threadId?: string | null;
  commentId?: string | null;
  excerpt?: string;
  date?: string;
  role?: WorkspaceRole;
}

/** Recipient must be a member who can see the page (when any). Never notifies the actor. */
function canReceive(db: Db, input: NotifyInput): boolean {
  if (input.actorId && input.actorId === input.userId) return false;
  const role = roleOf(db, input.userId, input.workspaceId);
  if (!role) return false;
  if (input.pageId) {
    const page = getPageRow(db, input.pageId);
    if (!page || page.workspace_id !== input.workspaceId || page.trashed_at !== null) return false;
    if (!canSeePage(input.userId, role, page, db)) return false;
  }
  return true;
}

/**
 * Creates a notification (inside the caller's transaction when there is one), pushes a
 * `notifications` change to the recipient only and sends the immediate e-mail after commit.
 * Returns the id, or null when the recipient cannot receive it.
 */
export function notify(ctx: AppContext, input: NotifyInput): string | null {
  const { db } = ctx;
  if (!canReceive(db, input)) return null;
  const id = newId();
  const data: NotificationData = {};
  if (input.excerpt) data.excerpt = truncate(input.excerpt, 300);
  if (input.date) data.date = input.date;
  if (input.role) data.role = input.role;
  db.run(
    `INSERT INTO collab_notifications (id, user_id, workspace_id, type, actor_id, page_id, thread_id, comment_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.userId,
    input.workspaceId,
    input.type,
    input.actorId,
    input.pageId ?? null,
    input.threadId ?? null,
    input.commentId ?? null,
    JSON.stringify(data),
    Date.now(),
  );
  ctx.bus.publish(input.workspaceId, { entity: 'notifications', workspaceId: input.workspaceId }, input.userId);
  db.afterCommit(() => {
    void sendImmediate(ctx, id).catch(() => undefined);
  });
  return id;
}

export function emailFrequency(db: Db, userId: string): EmailFrequency {
  const row = db.get<{ email_frequency: EmailFrequency }>('SELECT email_frequency FROM collab_user_prefs WHERE user_id = ?', userId);
  const f = row?.email_frequency;
  return f === 'immediate' || f === 'never' || f === 'daily' ? f : 'daily';
}

export function unreadCount(db: Db, userId: string, workspaceId: string): number {
  return (
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM collab_notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL AND archived_at IS NULL',
      userId,
      workspaceId,
    )?.n ?? 0
  );
}

// --- DTO ------------------------------------------------------------------------------

export function toNotificationItem(db: Db, row: NotificationRow, viewerId: string): NotificationItem {
  const data = parseJson<NotificationData>(row.data, {});
  const actor = row.actor_id ? db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.actor_id) : undefined;
  let page: NotificationItem['page'] = null;
  if (row.page_id) {
    const p = getPageRow(db, row.page_id);
    const role = p ? roleOf(db, viewerId, p.workspace_id) : null;
    if (p && p.trashed_at === null && role && canSeePage(viewerId, role, p, db)) page = { id: p.id, title: p.title, icon: p.icon, kind: p.kind };
  }
  // The excerpt is page content (comment, block text, title): hidden once the page is no longer
  // readable by the recipient (made private, trashed, deleted, recipient removed).
  const hidden = row.page_id !== null && page === null;
  return {
    id: row.id,
    type: row.type,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    archivedAt: row.archived_at,
    actor: actor ? toPublicUser(actor) : null,
    page,
    threadId: row.thread_id,
    commentId: row.comment_id,
    excerpt: hidden ? '' : (data.excerpt ?? ''),
    date: data.date ?? null,
    role: data.role ?? null,
  };
}

// --- e-mails ----------------------------------------------------------------------------

const pageTitle = (t: string | null | undefined) => (t && t.trim() ? t : 'Sans titre');

/** French one-line summary of a notification (e-mails; the web client has its own rendering). */
export function notificationTitle(item: NotificationItem, workspaceName: string): string {
  const who = item.actor?.name ?? 'Quelqu’un';
  const page = item.page ? `« ${pageTitle(item.page.title)} »` : 'une page';
  switch (item.type) {
    case 'mention':
      return `${who} vous a mentionné dans ${page}`;
    case 'comment_mention':
      return `${who} vous a mentionné dans un commentaire sur ${page}`;
    case 'comment':
      return `${who} a commenté ${page}`;
    case 'reply':
      return `${who} a répondu dans une discussion sur ${page}`;
    case 'reminder':
      return `Rappel du ${item.date ? formatFrenchDate(item.date) : 'jour'} : ${page}`;
    case 'invite_accepted':
      return `${who} a rejoint « ${workspaceName} »${item.role ? ` (${ROLE_LABELS[item.role].toLowerCase()})` : ''}`;
    case 'form_response':
      return `Nouvelle réponse à un formulaire : ${page}`;
    case 'teamspace_request':
      return `${who} demande à rejoindre l’espace d’équipe ${page}`;
    case 'teamspace_request_granted':
      return `${who} vous a ajouté à l’espace d’équipe ${page}`;
    default:
      return 'Nouvelle notification';
  }
}

export function notificationUrl(ctx: AppContext, item: NotificationItem): string {
  const base = baseUrl(ctx);
  // Navigation module: requests are answered from the teamspaces directory.
  if (item.type === 'teamspace_request' && item.page) return `${base}/w/${item.workspaceId}/teamspaces?manage=${encodeURIComponent(item.page.id)}`;
  if (item.page) {
    const thread = item.threadId ? `?thread=${encodeURIComponent(item.threadId)}` : '';
    return `${base}/w/${item.workspaceId}/p/${item.page.id}${thread}`;
  }
  if (item.type === 'invite_accepted') return `${base}/w/${item.workspaceId}/settings/members`;
  return `${base}/w/${item.workspaceId}/inbox`;
}

/** E-mail line of a notification; null when its page is no longer readable by the recipient. */
function mailItem(ctx: AppContext, row: NotificationRow, workspaceName: string): NotificationMailItem | null {
  const item = toNotificationItem(ctx.db, row, row.user_id);
  if (row.page_id !== null && item.page === null) return null;
  return { title: notificationTitle(item, workspaceName), excerpt: item.excerpt, url: notificationUrl(ctx, item) };
}

async function sendImmediate(ctx: AppContext, notificationId: string): Promise<void> {
  const { db } = ctx;
  const mailer = getMailer(ctx);
  if (!mailer.enabled) return;
  const row = db.get<NotificationRow>('SELECT * FROM collab_notifications WHERE id = ?', notificationId);
  if (!row || row.emailed_at !== null) return;
  if (emailFrequency(db, row.user_id) !== 'immediate') return;
  const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
  const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', row.workspace_id);
  if (!user || !ws) return;
  db.run('UPDATE collab_notifications SET emailed_at = ? WHERE id = ?', Date.now(), row.id);
  const item = mailItem(ctx, row, ws.name);
  if (item) await mailer.send(notificationMail({ to: user.email, workspace: ws.name, item }));
}

const DAY = 24 * 60 * 60 * 1000;

/** Sends one digest per user with the "daily" preference and pending (unread, not e-mailed) notifications. */
export async function sendDigests(ctx: AppContext, now = Date.now()): Promise<number> {
  const { db } = ctx;
  const mailer = getMailer(ctx);
  if (!mailer.enabled) return 0;
  const pending = db.all<NotificationRow>(
    `SELECT n.* FROM collab_notifications n
     LEFT JOIN collab_user_prefs p ON p.user_id = n.user_id
     WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND n.archived_at IS NULL AND n.created_at > ?
       AND COALESCE(p.email_frequency, 'daily') = 'daily'
     ORDER BY n.user_id, n.workspace_id, n.created_at`,
    now - 7 * DAY,
  );
  const byUser = new Map<string, NotificationRow[]>();
  for (const row of pending) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  let sent = 0;
  for (const [userId, rows] of byUser) {
    const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
    if (!user) continue;
    const groups = new Map<string, { workspace: string; items: NotificationMailItem[] }>();
    for (const row of rows) {
      if (!roleOf(db, userId, row.workspace_id)) continue;
      let g = groups.get(row.workspace_id);
      if (!g) {
        const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', row.workspace_id);
        g = { workspace: ws?.name ?? 'Espace', items: [] };
        groups.set(row.workspace_id, g);
      }
      const item = g.items.length < 30 ? mailItem(ctx, row, g.workspace) : null;
      if (item) g.items.push(item);
    }
    db.tx(() => {
      for (const row of rows) db.run('UPDATE collab_notifications SET emailed_at = ? WHERE id = ?', now, row.id);
    });
    const list = [...groups.values()].filter((g) => g.items.length > 0);
    if (list.length === 0) continue;
    const firstWs = rows.find((r) => groups.has(r.workspace_id))?.workspace_id;
    const inboxUrl = firstWs ? `${baseUrl(ctx)}/w/${firstWs}/inbox` : baseUrl(ctx);
    if (await mailer.send(digestMail({ to: user.email, name: user.name, groups: list, inboxUrl }))) sent++;
  }
  return sent;
}
