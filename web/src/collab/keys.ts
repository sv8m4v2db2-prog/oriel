// TanStack Query keys of the collab module (comments, notifications). Kept here (rather than in
// lib/queryKeys.ts, owned by the core) and used by lib/events.ts for real-time invalidation.
export const ck = {
  /** ThreadsResponse of a page. */
  threads: (pageId: string) => ['collab-threads', pageId] as const,
  /** NotificationsResponse (all filters) of a workspace. */
  notificationsAll: (wid: string) => ['collab-notifications', wid] as const,
  notifications: (wid: string, filter: 'inbox' | 'archived') => ['collab-notifications', wid, filter] as const,
  /** UnreadCountResponse of a workspace. */
  unread: (wid: string) => ['collab-unread', wid] as const,
  /** NotificationSettings of the current user. */
  settings: ['collab-notification-settings'] as const,
  /** PasswordResetConfig (public: is e-mail sending configured?). */
  passwordConfig: ['collab-password-config'] as const,
};
