import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AdminSettings, AdminUsersResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { toUser, type UserRow } from '../db/rows.js';
import { forbidden } from '../errors.js';
import { parse, requireAuth } from '../http.js';
import { adminSettingsSchema } from '../schemas.js';
import { currentSignupMode } from './auth.js';

function requireAdmin(req: FastifyRequest) {
  const auth = requireAuth(req);
  if (auth.user.is_admin !== 1) throw forbidden("Réservé aux administrateurs de l'instance.");
  return auth;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/admin/settings', async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    return { signupMode: currentSignupMode(ctx) };
  });

  app.patch('/api/admin/settings', async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    const body = parse(adminSettingsSchema, req.body);
    if (body.signupMode) db.setMeta('signup_mode', body.signupMode);
    return { signupMode: currentSignupMode(ctx) };
  });

  app.get('/api/admin/users', async (req): Promise<AdminUsersResponse> => {
    requireAdmin(req);
    const rows = db.all<UserRow & { workspace_count: number }>(
      `SELECT u.*, (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id) AS workspace_count FROM users u ORDER BY u.created_at, u.email`,
    );
    return { users: rows.map((r) => ({ ...toUser(r), workspaceCount: r.workspace_count })) };
  });
}
