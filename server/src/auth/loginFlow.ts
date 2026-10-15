// End of a first-factor sign-in (password, password reset link, OIDC): either a session, or — for an
// account with a second factor — a pending challenge answered on POST /api/auth/login/mfa.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MfaChallengeResponse, SessionResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/rows.js';
import { setSessionCookie } from '../http.js';
import { sessionResponse } from '../services/workspaces.js';
import { createChallenge, isProtected, secondFactorMethods } from './security.js';
import { createSession } from './sessions.js';

/** Cookie carrying the pending-login ticket after a redirect (OIDC); the JSON flows return it in the body. */
export const MFA_COOKIE = 'oriel_mfa';

/** `resetHash`: new password of a reset link, applied only once the second step succeeds (QA-G9-06). */
export function mfaChallenge(ctx: AppContext, user: UserRow, amr: string, extra: { resetHash?: string } = {}): MfaChallengeResponse {
  const ticket = createChallenge(ctx.db, 'mfa-login', { userId: user.id, data: { amr, ...extra } });
  return { mfa: { ticket, methods: secondFactorMethods(ctx.db, user.id) } };
}

export function openSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, user: UserRow, amr: string): SessionResponse {
  const session = createSession(ctx.db, user.id, req.headers['user-agent'], amr);
  setSessionCookie(req, reply, session.token);
  return sessionResponse(ctx.db, user);
}

/** First factor verified: session, or second step when the account is protected. */
export function completeFirstFactor(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  amr: string,
): SessionResponse | MfaChallengeResponse {
  if (!ctx.config.localMode && isProtected(ctx.db, user.id)) return mfaChallenge(ctx, user, amr);
  return openSession(ctx, req, reply, user, amr);
}
