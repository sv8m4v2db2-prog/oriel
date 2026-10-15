// Page reading helpers (SPEC §13): hover preview and recent activity of a page.
import type { PageKind, PublicUser } from './types.js';

/** GET /api/pages/:pid/preview — small card for the hover preview of links and mentions. */
export interface PagePreviewResponse {
  id: string;
  workspaceId: string;
  kind: PageKind;
  title: string;
  icon: string | null;
  /** First lines of the page text (plain text, at most PAGE_PREVIEW_EXCERPT_CHARS characters). */
  excerpt: string;
  updatedAt: number;
  trashed: boolean;
}

/** Longest excerpt of a page preview (characters). */
export const PAGE_PREVIEW_EXCERPT_CHARS = 280;

export type PageActivityKind = 'created' | 'edited' | 'version' | 'comment' | 'resolved';

export interface PageActivityEvent {
  kind: PageActivityKind;
  at: number;
  /** Absent when the user no longer exists (or the event has no known author). */
  user: PublicUser | null;
}

/** GET /api/pages/:pid/activity — most recent first. */
export interface PageActivityResponse {
  events: PageActivityEvent[];
}

/** Largest number of events returned by the activity route. */
export const PAGE_ACTIVITY_LIMIT = 30;
