// HTTP routes and background jobs of the "collab" feature module: comments, notifications
// (inbox), notification settings, e-mail invitations and test e-mails.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LIMITS,
  newId,
  ROLE_LABELS,
  type CommentItem,
  type CommentThread,
  type EmailInviteResponse,
  type NotificationSettings,
  type NotificationsResponse,
  type TestMailResponse,
  type ThreadsResponse,
  type UnreadCountResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { toInvite, type InviteRow, type UserRow } from '../db/rows.js';
import { badRequest, conflict, forbidden, HttpError, notFound, pageNotFound, rateLimited } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import { pageAccess, requireWorkspace } from '../access.js';
import { bodyMentions, bodyText, validateBody } from '../collab/body.js';
import {
  commentAccess,
  commentDto,
  emitComments,
  insertComment,
  loadThreads,
  memberNameLookup,
  notifyForComment,
  previousMentions,
  requireComment,
  requireThread,
  threadDto,
  type ThreadRow,
} from '../collab/comments.js';
import { emailFrequency, notify, toNotificationItem, unreadCount, type NotificationRow } from '../collab/notify.js';
import { INVITE_MAILS_PER_DAY, inviteMailsSent, notifyInviteAccepted, recordInviteMail } from '../collab/invites.js';
import { baseUrl, getMailer, rememberOrigin } from '../collab/mailer.js';
import { inviteMail, testMail } from '../collab/templates.js';
import { startCollabJobTimers } from '../collab/jobs.js';
import { requestOrigin } from '../auth/resetRoutes.js';

/** Server instances by data directory (lets tests reach the context to run jobs). */
export const collabContexts = new Map<string, AppContext>();

const uuidLike = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const pageParams = z.object({ pid: idParam });
const threadParams = z.object({ tid: idParam });
const commentParams = z.object({ cid: idParam });
const widParams = z.object({ wid: idParam });
const notifParams = z.object({ nid: idParam });
const body = z.array(z.unknown()).min(1).max(200);
const createThreadSchema = z.object({ id: uuidLike.optional(), anchored: z.boolean(), quote: z.string().max(1000).optional(), body });
const addCommentSchema = z.object({ id: uuidLike.optional(), body });
const updateCommentSchema = z.object({ body });
const resolveSchema = z.object({ resolved: z.boolean() });
const reactionSchema = z.object({ emoji: z.string().trim().min(1).max(32), active: z.boolean() });
const listQuery = z.object({ filter: z.enum(['inbox', 'archived']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const updateNotifSchema = z.object({ read: z.boolean().optional(), archived: z.boolean().optional() });
const settingsSchema = z.object({ emailFrequency: z.enum(['immediate', 'daily', 'never']) });
const emailInviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  role: z.enum(['admin', 'member', 'viewer']),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const acceptState = new WeakMap<FastifyRequest, { userId: string; wasMember: boolean; token: string }>();

export function registerCollabRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const log = (msg: string, err?: unknown) => (err ? app.log.error({ err }, msg) : app.log.info(msg));
  collabContexts.set(ctx.config.dataDir, ctx);
  app.addHook('onClose', async () => {
    if (collabContexts.get(ctx.config.dataDir) === ctx) collabContexts.delete(ctx.config.dataDir);
    getMailer(ctx).close();
  });

  // Absolute links in e-mails (when PUBLIC_URL is not set) come from requests of instance
  // administrators only: the remembered origin is shared by every e-mail (password resets of other
  // users included), so an ordinary account must not be able to set it with a forged Host or
  // X-Forwarded-Host header.
  app.addHook('preHandler', async (req) => {
    // Browser requests only (QA-TOK-01): a script holding an admin's API token chooses its Host header.
    if (req.auth?.user.is_admin === 1 && !req.apiToken && !ctx.config.publicUrl) rememberOrigin(ctx, requestOrigin(req));
    // "Invitation accepted" notification for the existing-user flow (route owned by the core).
    if (req.auth && req.method === 'POST' && req.routeOptions.url === '/api/invites/:token/accept') {
      const token = (req.params as { token?: string }).token ?? '';
      const invite = db.get<InviteRow>('SELECT * FROM invites WHERE token = ?', token);
      const wasMember = !invite || !!db.get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', invite.workspace_id, req.auth.user.id);
      acceptState.set(req, { userId: req.auth.user.id, wasMember, token });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const state = acceptState.get(req);
    if (!state || state.wasMember || reply.statusCode !== 200) return payload;
    acceptState.delete(req);
    const invite = db.get<InviteRow>('SELECT * FROM invites WHERE token = ?', state.token);
    if (invite && db.get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', invite.workspace_id, state.userId)) {
      db.tx(() => notifyInviteAccepted(ctx, invite, state.userId));
    }
    return payload;
  });

  // --- comments --------------------------------------------------------------------------

  app.get('/api/pages/:pid/threads', async (req): Promise<ThreadsResponse> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pageParams, req.params);
    const access = pageAccess(db, user.id, pid);
    if (!access) throw pageNotFound();
    const rows = db.all<ThreadRow>('SELECT * FROM collab_threads WHERE page_id = ? ORDER BY created_at, id', pid);
    return { ...loadThreads(db, rows), ...commentAccess(access) };
  });

  app.post('/api/pages/:pid/threads', async (req): Promise<CommentThread> => {
    const { user } = requireAuth(req);
    const { pid } = parse(pageParams, req.params);
    const input = parse(createThreadSchema, req.body);
    const content = validateBody(input.body);
    const threadId = input.id ?? newId();
    db.tx(() => {
      const access = pageAccess(db, user.id, pid);
      if (!access) throw pageNotFound();
      if (!commentAccess(access).canComment) throw forbidden("Vous n'avez pas les droits pour commenter cette page.");
      if (access.page.kind !== 'page') throw badRequest('Les commentaires ne sont possibles que sur les pages.');
      if (db.get('SELECT 1 AS x FROM collab_threads WHERE id = ?', threadId)) throw conflict('Cette discussion existe déjà.');
      const now = Date.now();
      db.run(
        `INSERT INTO collab_threads (id, page_id, workspace_id, anchored, quote, resolved_at, resolved_by, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        threadId,
        pid,
        access.page.workspace_id,
        input.anchored ? 1 : 0,
        (input.quote ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
        user.id,
        now,
        now,
      );
      const thread = db.get<ThreadRow>('SELECT * FROM collab_threads WHERE id = ?', threadId)!;
      const comment = insertComment(db, threadId, user.id, content, newId(), now);
      notifyForComment(ctx, { page: access.page, thread, comment, actorId: user.id, isNewThread: true, mentioned: bodyMentions(content) });
      emitComments(ctx, access.page);
    });
    return threadDto(db, threadId);
  });

  app.post('/api/threads/:tid/comments', async (req): Promise<CommentItem> => {
    const { user } = requireAuth(req);
    const { tid } = parse(threadParams, req.params);
    const input = parse(addCommentSchema, req.body);
    const content = validateBody(input.body);
    const commentId = input.id ?? newId();
    db.tx(() => {
      const { thread, page } = requireThread(db, user.id, tid, 'write');
      if (db.get('SELECT 1 AS x FROM collab_comments WHERE id = ?', commentId)) throw conflict('Ce commentaire existe déjà.');
      const now = Date.now();
      const comment = insertComment(db, tid, user.id, content, commentId, now);
      db.run('UPDATE collab_threads SET updated_at = ? WHERE id = ?', now, tid);
      notifyForComment(ctx, { page, thread, comment, actorId: user.id, isNewThread: false, mentioned: bodyMentions(content) });
      emitComments(ctx, page);
    });
    return commentDto(db, commentId);
  });

  app.patch('/api/comments/:cid', async (req): Promise<CommentItem> => {
    const { user } = requireAuth(req);
    const { cid } = parse(commentParams, req.params);
    const input = parse(updateCommentSchema, req.body);
    const content = validateBody(input.body);
    db.tx(() => {
      const { comment, thread, page } = requireComment(db, user.id, cid, 'write');
      if (comment.user_id !== user.id) throw forbidden('Vous ne pouvez modifier que vos propres commentaires.');
      const before = new Set(previousMentions(comment));
      const mentions = bodyMentions(content);
      const names = memberNameLookup(db, page.workspace_id);
      const now = Date.now();
      db.run(
        'UPDATE collab_comments SET body = ?, text = ?, mentions = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(content),
        bodyText(content, names),
        JSON.stringify(mentions),
        now,
        cid,
      );
      db.run('UPDATE collab_threads SET updated_at = ? WHERE id = ?', now, thread.id);
      const updated = db.get<typeof comment>('SELECT * FROM collab_comments WHERE id = ?', cid)!;
      for (const uid of mentions.filter((m) => !before.has(m))) {
        notify(ctx, {
          userId: uid,
          workspaceId: page.workspace_id,
          type: 'comment_mention',
          actorId: user.id,
          pageId: page.id,
          threadId: thread.id,
          commentId: cid,
          excerpt: updated.text,
        });
      }
      emitComments(ctx, page);
    });
    return commentDto(db, cid);
  });

  app.delete('/api/comments/:cid', async (req) => {
    const { user } = requireAuth(req);
    const { cid } = parse(commentParams, req.params);
    let threadDeleted = false;
    db.tx(() => {
      const { comment, thread, page, canModerate } = requireComment(db, user.id, cid, 'write');
      if (comment.user_id !== user.id && !canModerate) throw forbidden('Vous ne pouvez supprimer que vos propres commentaires.');
      db.run('DELETE FROM collab_comments WHERE id = ?', cid);
      db.run("UPDATE collab_notifications SET archived_at = COALESCE(archived_at, ?) WHERE comment_id = ?", Date.now(), cid);
      if (!db.get('SELECT 1 AS x FROM collab_comments WHERE thread_id = ?', thread.id)) {
        db.run('DELETE FROM collab_threads WHERE id = ?', thread.id);
        threadDeleted = true;
      }
      emitComments(ctx, page);
    });
    return { ok: true as const, threadDeleted };
  });

  app.delete('/api/threads/:tid', async (req) => {
    const { user } = requireAuth(req);
    const { tid } = parse(threadParams, req.params);
    db.tx(() => {
      const { thread, page, canModerate } = requireThread(db, user.id, tid, 'write');
      if (thread.created_by !== user.id && !canModerate) throw forbidden('Seuls l’auteur de la discussion et les administrateurs peuvent la supprimer.');
      db.run('DELETE FROM collab_threads WHERE id = ?', tid);
      // Like a deleted comment: its notifications (and their excerpts) leave the inboxes.
      const recipients = db.all<{ user_id: string }>(
        'SELECT DISTINCT user_id FROM collab_notifications WHERE thread_id = ? AND archived_at IS NULL',
        tid,
      );
      db.run('UPDATE collab_notifications SET archived_at = ? WHERE thread_id = ? AND archived_at IS NULL', Date.now(), tid);
      for (const r of recipients) ctx.bus.publish(page.workspace_id, { entity: 'notifications', workspaceId: page.workspace_id }, r.user_id);
      emitComments(ctx, page);
    });
    return { ok: true as const };
  });

  app.post('/api/threads/:tid/resolve', async (req): Promise<CommentThread> => {
    const { user } = requireAuth(req);
    const { tid } = parse(threadParams, req.params);
    const input = parse(resolveSchema, req.body);
    db.tx(() => {
      const { thread, page } = requireThread(db, user.id, tid, 'write');
      const now = Date.now();
      if (input.resolved && thread.resolved_at === null) {
        db.run('UPDATE collab_threads SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?', now, user.id, now, tid);
      } else if (!input.resolved && thread.resolved_at !== null) {
        db.run('UPDATE collab_threads SET resolved_at = NULL, resolved_by = NULL, updated_at = ? WHERE id = ?', now, tid);
      }
      emitComments(ctx, page);
    });
    return threadDto(db, tid);
  });

  app.put('/api/comments/:cid/reactions', async (req): Promise<CommentItem> => {
    const { user } = requireAuth(req);
    const { cid } = parse(commentParams, req.params);
    const input = parse(reactionSchema, req.body);
    db.tx(() => {
      const { page } = requireComment(db, user.id, cid, 'write');
      if (input.active) {
        const count = db.get<{ n: number }>('SELECT COUNT(DISTINCT emoji) AS n FROM collab_reactions WHERE comment_id = ?', cid)!.n;
        if (count >= 20 && !db.get('SELECT 1 AS x FROM collab_reactions WHERE comment_id = ? AND emoji = ?', cid, input.emoji)) {
          throw badRequest('Trop de réactions différentes sur ce commentaire.');
        }
        db.run('INSERT OR IGNORE INTO collab_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', cid, user.id, input.emoji, Date.now());
      } else {
        db.run('DELETE FROM collab_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?', cid, user.id, input.emoji);
      }
      emitComments(ctx, page);
    });
    return commentDto(db, cid);
  });

  // --- notifications ---------------------------------------------------------------------

  app.get('/api/workspaces/:wid/notifications', async (req): Promise<NotificationsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const q = parse(listQuery, req.query);
    requireWorkspace(db, user.id, wid);
    const archived = q.filter === 'archived';
    const rows = db.all<NotificationRow>(
      `SELECT * FROM collab_notifications WHERE user_id = ? AND workspace_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
       ORDER BY created_at DESC, id LIMIT ?`,
      user.id,
      wid,
      q.limit ?? 100,
    );
    return { notifications: rows.map((r) => toNotificationItem(db, r, user.id)), unread: unreadCount(db, user.id, wid) };
  });

  app.get('/api/workspaces/:wid/notifications/unread', async (req): Promise<UnreadCountResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid);
    return { unread: unreadCount(db, user.id, wid) };
  });

  app.post('/api/workspaces/:wid/notifications/read-all', async (req): Promise<UnreadCountResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    db.tx(() => {
      requireWorkspace(db, user.id, wid);
      db.run('UPDATE collab_notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL', Date.now(), user.id, wid);
      ctx.bus.publish(wid, { entity: 'notifications', workspaceId: wid }, user.id);
    });
    return { unread: unreadCount(db, user.id, wid) };
  });

  app.patch('/api/notifications/:nid', async (req) => {
    const { user } = requireAuth(req);
    const { nid } = parse(notifParams, req.params);
    const input = parse(updateNotifSchema, req.body);
    const row = db.tx(() => {
      const n = db.get<NotificationRow>('SELECT * FROM collab_notifications WHERE id = ? AND user_id = ?', nid, user.id);
      if (!n) throw notFound('Notification introuvable.');
      const now = Date.now();
      if (input.read !== undefined) db.run('UPDATE collab_notifications SET read_at = ? WHERE id = ?', input.read ? (n.read_at ?? now) : null, nid);
      if (input.archived !== undefined) {
        db.run('UPDATE collab_notifications SET archived_at = ? WHERE id = ?', input.archived ? (n.archived_at ?? now) : null, nid);
        if (input.archived && input.read === undefined) db.run('UPDATE collab_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?', now, nid);
      }
      ctx.bus.publish(n.workspace_id, { entity: 'notifications', workspaceId: n.workspace_id }, user.id);
      return db.get<NotificationRow>('SELECT * FROM collab_notifications WHERE id = ?', nid)!;
    });
    return toNotificationItem(db, row, user.id);
  });

  // --- settings, e-mail ------------------------------------------------------------------

  app.get('/api/me/notification-settings', async (req): Promise<NotificationSettings> => {
    const { user } = requireAuth(req);
    return { emailFrequency: emailFrequency(db, user.id), emailEnabled: getMailer(ctx).enabled };
  });

  app.patch('/api/me/notification-settings', async (req): Promise<NotificationSettings> => {
    const { user } = requireAuth(req);
    const input = parse(settingsSchema, req.body);
    db.run(
      `INSERT INTO collab_user_prefs (user_id, email_frequency, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email_frequency = excluded.email_frequency, updated_at = excluded.updated_at`,
      user.id,
      input.emailFrequency,
      Date.now(),
    );
    return { emailFrequency: emailFrequency(db, user.id), emailEnabled: getMailer(ctx).enabled };
  });

  app.post('/api/admin/mail/test', async (req): Promise<TestMailResponse> => {
    const { user } = requireAuth(req);
    if (user.is_admin !== 1) throw forbidden("Réservé aux administrateurs de l'instance.");
    if (!ctx.authLimiter.hit(`mail-test:${user.id}`)) throw rateLimited();
    const mailer = getMailer(ctx);
    if (!mailer.enabled) throw badRequest("L'envoi d'e-mails n'est pas configuré (variables SMTP_*).");
    const ok = await mailer.send(testMail({ to: user.email, name: user.name, from: mailer.config.from }), log);
    if (!ok) throw new HttpError(502, 'mail_failed', "L'e-mail n'a pas pu être envoyé : vérifiez la configuration SMTP et les journaux du serveur.");
    return { ok: true, to: user.email };
  });

  app.post('/api/workspaces/:wid/invites/email', async (req): Promise<EmailInviteResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    const input = parse(emailInviteSchema, req.body);
    if (!ctx.authLimiter.hit(`invite-mail:${user.id}`)) throw rateLimited();
    const mailer = getMailer(ctx);
    const { invite, workspaceName } = db.tx(() => {
      const { workspace } = requireWorkspace(db, user.id, wid, 'manage');
      const existing = db.get<{ x: number }>(
        'SELECT 1 AS x FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?',
        wid,
        input.email,
      );
      if (existing) throw conflict('Cette personne est déjà membre de l’espace.');
      const now = Date.now();
      // Daily cap of the e-mails (counted when one is about to be sent, failed sends included).
      if (mailer.enabled) {
        if (inviteMailsSent(db, user.id, now) >= INVITE_MAILS_PER_DAY) {
          throw rateLimited(
            `Vous avez envoyé ${INVITE_MAILS_PER_DAY} invitations par e-mail ces dernières 24 heures. Créez un lien d’invitation et transmettez-le vous-même, ou réessayez plus tard.`,
          );
        }
        recordInviteMail(db, user.id, now);
      }
      const token = randomBytes(32).toString('base64url');
      const days = input.expiresInDays ?? LIMITS.inviteDefaultDays;
      db.run(
        'INSERT INTO invites (token, workspace_id, role, created_by, created_at, expires_at, uses, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
        token,
        wid,
        input.role,
        user.id,
        now,
        now + days * 24 * 60 * 60 * 1000,
      );
      ctx.bus.publish(wid, { entity: 'members', workspaceId: wid });
      return { invite: db.get<InviteRow>('SELECT * FROM invites WHERE token = ?', token)!, workspaceName: workspace.name };
    });
    const dto = toInvite(invite, ctx.config.publicUrl);
    let emailed = false;
    if (mailer.enabled) {
      const url = `${baseUrl(ctx)}/invite/${invite.token}`;
      const inviter = db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!;
      emailed = await mailer.send(
        inviteMail({ to: input.email, inviter: inviter.name, workspace: workspaceName, role: ROLE_LABELS[invite.role], url, expiresAt: invite.expires_at }),
        log,
      );
    }
    return { invite: dto, emailed };
  });
}

/** Starts periodic jobs; returns a stop function. */
export function startCollabJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  return startCollabJobTimers(ctx, log);
}
