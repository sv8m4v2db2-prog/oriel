// Contract of the "collab" feature module (types shared by server and web):
// comments, person/date mentions, notifications (inbox), e-mail, password reset.
import type { Crumb, Invite, PageKind, PublicUser, WorkspaceRole } from './types.js';

/** Inline content type names added to the editor schema by the collab module. */
export const COLLAB_TYPES = {
  /** Inline content: person mention. props: { userId } */
  userMention: 'userMention',
  /** Inline content: date mention. props: { date: 'YYYY-MM-DD', reminder: boolean, userId: who set the reminder } */
  dateMention: 'dateMention',
} as const;

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * A comment body is a BlockNote document (array of paragraph blocks whose inline content may
 * contain `userMention` / `dateMention` items). The server only reads text and mentions from it.
 */
export type CommentBody = unknown[];

export interface CommentReaction {
  emoji: string;
  userIds: string[];
  createdAt: number;
}

export interface CommentItem {
  id: string;
  threadId: string;
  userId: string;
  body: CommentBody;
  createdAt: number;
  updatedAt: number;
  reactions: CommentReaction[];
}

export interface CommentThread {
  id: string;
  pageId: string;
  /** false = page-level discussion (not anchored to a text selection). */
  anchored: boolean;
  /** Text the thread was created on (anchored threads), for lists and notifications. */
  quote: string;
  resolved: boolean;
  resolvedAt: number | null;
  resolvedBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  comments: CommentItem[];
}

/** GET /api/pages/:pid/threads */
export interface ThreadsResponse {
  threads: CommentThread[];
  /** Authors, resolvers and reacting users. */
  users: PublicUser[];
  /** The current user may create threads, reply, react and resolve (not a viewer). */
  canComment: boolean;
  /** The current user may delete any comment / thread (workspace owner or admin). */
  canModerate: boolean;
}

/** POST /api/pages/:pid/threads → CommentThread */
export interface CreateThreadRequest {
  id?: string;
  anchored: boolean;
  quote?: string;
  body: CommentBody;
}

/** POST /api/threads/:tid/comments → CommentItem */
export interface AddCommentRequest {
  id?: string;
  body: CommentBody;
}

/** PATCH /api/comments/:cid → CommentItem */
export interface UpdateCommentRequest {
  body: CommentBody;
}

/** POST /api/threads/:tid/resolve → CommentThread */
export interface ResolveThreadRequest {
  resolved: boolean;
}

/** PUT /api/comments/:cid/reactions → CommentItem */
export interface ReactionRequest {
  emoji: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Notifications (inbox)
// ---------------------------------------------------------------------------

export type NotificationType =
  /** Mentioned in a page's content. */
  | 'mention'
  /** Mentioned in a comment. */
  | 'comment_mention'
  /** Someone commented on a page you created. */
  | 'comment'
  /** Reply in a thread you participate in. */
  | 'reply'
  /** Date reminder you set. */
  | 'reminder'
  /** Someone joined the workspace with an invitation you created. */
  | 'invite_accepted'
  /** A form of a database you own received a response (database module). */
  | 'form_response'
  /** Someone asked to join a closed teamspace you manage (navigation module; page = teamspace root). */
  | 'teamspace_request'
  /** Your request to join a teamspace was accepted (navigation module). */
  | 'teamspace_request_granted';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  workspaceId: string;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
  actor: PublicUser | null;
  /** null when the page was deleted or became invisible. */
  page: (Crumb & { kind: PageKind }) | null;
  threadId: string | null;
  commentId: string | null;
  /** Short plain-text excerpt (comment text, quote, …). */
  excerpt: string;
  /** Reminder date (YYYY-MM-DD) for 'reminder'. */
  date: string | null;
  /** Role given by the invitation for 'invite_accepted'. */
  role: WorkspaceRole | null;
}

/** GET /api/workspaces/:wid/notifications?filter=inbox|archived */
export interface NotificationsResponse {
  notifications: NotificationItem[];
  unread: number;
}

/** GET /api/workspaces/:wid/notifications/unread */
export interface UnreadCountResponse {
  unread: number;
}

/** PATCH /api/notifications/:nid */
export interface UpdateNotificationRequest {
  read?: boolean;
  archived?: boolean;
}

export type EmailFrequency = 'immediate' | 'daily' | 'never';

/** GET/PATCH /api/me/notification-settings */
export interface NotificationSettings {
  emailFrequency: EmailFrequency;
  /** Whether the instance can send e-mails (SMTP configured). */
  emailEnabled: boolean;
}

// ---------------------------------------------------------------------------
// E-mail, invitations by e-mail, password reset
// ---------------------------------------------------------------------------

/** GET /api/auth/password/config (public) */
export interface PasswordResetConfig {
  emailEnabled: boolean;
}

/** POST /api/auth/password/forgot → { ok: true } (always, to prevent account enumeration) */
export interface ForgotPasswordRequest {
  email: string;
}

/** GET /api/auth/password/reset/:token (public) */
export interface ResetTokenInfo {
  valid: boolean;
  /** Masked address of the account, e.g. "al***@example.com". */
  email: string | null;
}

/** POST /api/auth/password/reset → SessionResponse (logged in, every other session revoked) */
export interface ResetPasswordRequest {
  token: string;
  password: string;
}

/** POST /api/admin/users/:uid/password-reset */
export interface AdminResetLinkRequest {
  /** Also send the link by e-mail to the user (when SMTP is configured). */
  sendEmail?: boolean;
}
export interface AdminResetLinkResponse {
  /** Absolute when PUBLIC_URL is set, else a path to prefix with the current origin. */
  url: string;
  expiresAt: number;
  emailed: boolean;
}

/** POST /api/workspaces/:wid/invites/email */
export interface EmailInviteRequest {
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  expiresInDays?: number;
}
export interface EmailInviteResponse {
  invite: Invite;
  emailed: boolean;
}

/** POST /api/admin/mail/test */
export interface TestMailResponse {
  ok: true;
  to: string;
}
