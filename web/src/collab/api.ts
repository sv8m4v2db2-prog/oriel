// HTTP client of the collab module (contract: shared/src/collab.ts).
import type {
  AddCommentRequest,
  AdminResetLinkResponse,
  ApiErrorBody,
  CommentItem,
  CommentThread,
  CreateThreadRequest,
  EmailInviteRequest,
  EmailInviteResponse,
  NotificationItem,
  NotificationSettings,
  NotificationsResponse,
  PasswordResetConfig,
  ResetTokenInfo,
  SessionResponse,
  TestMailResponse,
  ThreadsResponse,
  UnreadCountResponse,
  UpdateNotificationRequest,
} from '@oriel/shared';
import { ApiError, assertApiPath, recoverApiError } from '../lib/api';
import { apiPath, queryString } from '../lib/apiPath';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, retried = false): Promise<T> {
  assertApiPath(path);
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    const error = new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Erreur ${res.status}`);
    // Re-authentication of sensitive actions (admin reset link, admin invitations): replayed once (lib/api.ts).
    if (!retried && (await recoverApiError(error))) return request<T>(method, path, body, true);
    throw error;
  }
  return data as T;
}

export const collabApi = {
  // comments
  threads: (pageId: string) => request<ThreadsResponse>('GET', apiPath`/pages/${pageId}/threads`),
  createThread: (pageId: string, body: CreateThreadRequest) => request<CommentThread>('POST', apiPath`/pages/${pageId}/threads`, body),
  addComment: (threadId: string, body: AddCommentRequest) => request<CommentItem>('POST', apiPath`/threads/${threadId}/comments`, body),
  updateComment: (commentId: string, body: unknown[]) => request<CommentItem>('PATCH', apiPath`/comments/${commentId}`, { body }),
  deleteComment: (commentId: string) => request<{ ok: true; threadDeleted: boolean }>('DELETE', apiPath`/comments/${commentId}`),
  deleteThread: (threadId: string) => request<{ ok: true }>('DELETE', apiPath`/threads/${threadId}`),
  resolveThread: (threadId: string, resolved: boolean) => request<CommentThread>('POST', apiPath`/threads/${threadId}/resolve`, { resolved }),
  react: (commentId: string, emoji: string, active: boolean) => request<CommentItem>('PUT', apiPath`/comments/${commentId}/reactions`, { emoji, active }),

  // notifications
  notifications: (wid: string, filter: 'inbox' | 'archived') =>
    request<NotificationsResponse>('GET', apiPath`/workspaces/${wid}/notifications` + queryString({ filter })),
  unread: (wid: string) => request<UnreadCountResponse>('GET', apiPath`/workspaces/${wid}/notifications/unread`),
  readAll: (wid: string) => request<UnreadCountResponse>('POST', apiPath`/workspaces/${wid}/notifications/read-all`),
  updateNotification: (nid: string, body: UpdateNotificationRequest) => request<NotificationItem>('PATCH', apiPath`/notifications/${nid}`, body),
  settings: () => request<NotificationSettings>('GET', '/me/notification-settings'),
  updateSettings: (body: Pick<NotificationSettings, 'emailFrequency'>) => request<NotificationSettings>('PATCH', '/me/notification-settings', body),

  // e-mail
  testMail: () => request<TestMailResponse>('POST', '/admin/mail/test'),
  emailInvite: (wid: string, body: EmailInviteRequest) => request<EmailInviteResponse>('POST', apiPath`/workspaces/${wid}/invites/email`, body),

  // password reset
  passwordConfig: () => request<PasswordResetConfig>('GET', '/auth/password/config'),
  forgotPassword: (email: string) => request<{ ok: true }>('POST', '/auth/password/forgot', { email }),
  resetInfo: (token: string) => request<ResetTokenInfo>('GET', apiPath`/auth/password/reset/${token}`),
  resetPassword: (token: string, password: string) => request<SessionResponse>('POST', '/auth/password/reset', { token, password }),
  adminResetLink: (userId: string, sendEmail: boolean) =>
    request<AdminResetLinkResponse>('POST', apiPath`/admin/users/${userId}/password-reset`, { sendEmail }),
};
