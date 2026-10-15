// Invitation side effects of the collab module: "invitation accepted" notification to the inviter,
// daily cap of invitation e-mails.
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import type { InviteRow } from '../db/rows.js';
import { notify } from './notify.js';

/**
 * Invitation e-mails one account may send per rolling 24 hours. Any account can create a workspace
 * and invite arbitrary addresses (the per-minute rate limit alone leaves the instance usable as a
 * spam relay); beyond the cap, invitation links can still be created and shared by hand.
 */
export const INVITE_MAILS_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Invitation e-mails sent by `userId` over the last 24 hours. */
export function inviteMailsSent(db: Db, userId: string, now = Date.now()): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM collab_invite_mails WHERE user_id = ? AND sent_at > ?', userId, now - DAY_MS)!.n;
}

export function recordInviteMail(db: Db, userId: string, now = Date.now()): void {
  db.run('INSERT INTO collab_invite_mails (user_id, sent_at) VALUES (?, ?)', userId, now);
}

export function cleanupInviteMails(db: Db, now = Date.now()): number {
  return db.run('DELETE FROM collab_invite_mails WHERE sent_at <= ?', now - DAY_MS);
}

/** Notifies the creator of `invite` that `userId` joined the workspace with it (inside the caller's transaction). */
export function notifyInviteAccepted(ctx: AppContext, invite: Pick<InviteRow, 'workspace_id' | 'created_by' | 'role'>, userId: string): void {
  try {
    notify(ctx, { userId: invite.created_by, workspaceId: invite.workspace_id, type: 'invite_accepted', actorId: userId, role: invite.role });
  } catch {
    /* never block a signup / acceptance on a notification */
  }
}
