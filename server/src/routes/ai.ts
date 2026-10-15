// HTTP routes and background jobs of the "ai" feature module — « Brief du jour » (see shared/src/ai.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AI_INSTANCE_MAX_CAP_USD,
  AI_MODEL_IDS,
  type AiBrief,
  type AiBriefsResponse,
  type AiInstanceStatus,
  type AiKeyStatus,
  type AiLatestBriefResponse,
  type AiModelId,
  type AiSettingsResponse,
  type AiUsageResponse,
  type IsoWeekday,
  type StartBriefResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/rows.js';
import { canEditRole, canManageRole, requireWorkspace, roleOf } from '../access.js';
import { forbidden, notFound } from '../errors.js';
import { idParam, parse, requireAuth } from '../http.js';
import {
  analysableDatabases,
  configurationBlocker,
  deleteApiKey,
  isFakeMode,
  keyStatus,
  loadSettings,
  saveApiKey,
  saveInstanceCap,
  saveSettings,
  sourceInfos,
} from '../ai/settings.js';
import {
  abortRuns,
  failInterruptedRuns,
  getBrief,
  instanceStatus,
  latestBriefs,
  listBriefs,
  manualRunState,
  runScheduledBriefs,
  startBrief,
  usageReport,
  workspaceInstanceCap,
} from '../ai/runs.js';

const widParams = z.object({ wid: idParam });
const briefParams = z.object({ id: idParam });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

const updateSettingsSchema = z
  .object({
    enabled: z.boolean(),
    model: z.enum(AI_MODEL_IDS as [AiModelId, ...AiModelId[]]),
    sourceDatabaseIds: z.array(idParam).max(50),
    scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'format HH:MM attendu'),
    scheduleDays: z.array(z.number().int().min(1).max(7)).max(7),
    timezone: z.string().min(1).max(64),
    monthlyBudgetUsd: z.number().min(0).max(10_000),
  })
  .partial()
  .strict();

const saveKeySchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20, 'clé trop courte')
      .max(300)
      .regex(/^[A-Za-z0-9_\-]+$/, 'caractères inattendus'),
  })
  .strict();

/** Instance-wide settings (instance admins): the monthly cap of all workspaces together, 0 = AI disabled. */
const updateInstanceSchema = z.object({ monthlyCapUsd: z.number().min(0).max(AI_INSTANCE_MAX_CAP_USD) }).strict();

function requireInstanceAdmin(req: FastifyRequest): UserRow {
  const { user } = requireAuth(req);
  if (user.is_admin !== 1) throw forbidden("Réservé aux administrateurs de l'instance.");
  return user;
}

function settingsResponse(ctx: AppContext, user: UserRow, workspaceId: string): AiSettingsResponse {
  const { db } = ctx;
  const role = roleOf(db, user.id, workspaceId);
  const settings = loadSettings(db, workspaceId);
  const sources = sourceInfos(db, workspaceId, settings.sourceDatabaseIds);
  const blocker = configurationBlocker(db, workspaceId, settings);
  const canManage = canManageRole(role);
  const canRun = canEditRole(role);
  return {
    settings,
    key: keyStatus(db, user.is_admin === 1),
    fakeMode: isFakeMode(),
    configured: blocker === null,
    blocker,
    sources,
    databases: canManage ? analysableDatabases(db, workspaceId) : [],
    canManage,
    canManageKey: user.is_admin === 1,
    canRun,
    manualRun: manualRunState(ctx, workspaceId, user.id, canRun),
    instanceCap: workspaceInstanceCap(ctx, workspaceId),
  };
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  failInterruptedRuns(ctx);
  app.addHook('onClose', async () => {
    await abortRuns(ctx);
  });

  app.get('/api/workspaces/:wid/ai/settings', async (req): Promise<AiSettingsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'read');
    return settingsResponse(ctx, user, wid);
  });

  app.put('/api/workspaces/:wid/ai/settings', async (req): Promise<AiSettingsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'manage');
    const body = parse(updateSettingsSchema, req.body);
    saveSettings(db, wid, { ...body, scheduleDays: body.scheduleDays as IsoWeekday[] | undefined }, user.id);
    return settingsResponse(ctx, user, wid);
  });

  app.get('/api/admin/ai', async (req): Promise<AiInstanceStatus> => {
    requireInstanceAdmin(req);
    return instanceStatus(ctx);
  });

  app.put('/api/admin/ai', async (req): Promise<AiInstanceStatus> => {
    requireInstanceAdmin(req);
    const { monthlyCapUsd } = parse(updateInstanceSchema, req.body);
    saveInstanceCap(db, monthlyCapUsd);
    return instanceStatus(ctx);
  });

  app.put('/api/admin/ai/key', async (req): Promise<AiKeyStatus> => {
    requireInstanceAdmin(req);
    const { apiKey } = parse(saveKeySchema, req.body);
    saveApiKey(db, apiKey);
    return keyStatus(db, true);
  });

  app.delete('/api/admin/ai/key', async (req): Promise<AiKeyStatus> => {
    requireInstanceAdmin(req);
    deleteApiKey(db);
    return keyStatus(db, true);
  });

  app.post('/api/workspaces/:wid/ai/briefs', async (req, reply): Promise<StartBriefResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'edit');
    const brief = startBrief(ctx, wid, 'manual', user.id);
    reply.code(202);
    return { brief };
  });

  app.get('/api/workspaces/:wid/ai/briefs', async (req): Promise<AiBriefsResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'read');
    const { limit } = parse(limitQuery, req.query);
    return { briefs: listBriefs(ctx, wid, limit ?? 30) };
  });

  app.get('/api/workspaces/:wid/ai/briefs/latest', async (req): Promise<AiLatestBriefResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'read');
    return latestBriefs(ctx, wid);
  });

  app.get('/api/ai/briefs/:id', async (req): Promise<AiBrief> => {
    const { user } = requireAuth(req);
    const { id } = parse(briefParams, req.params);
    const brief = getBrief(ctx, id);
    if (!brief || !roleOf(db, user.id, brief.workspaceId)) throw notFound('Brief introuvable.');
    return brief;
  });

  app.get('/api/workspaces/:wid/ai/usage', async (req): Promise<AiUsageResponse> => {
    const { user } = requireAuth(req);
    const { wid } = parse(widParams, req.params);
    requireWorkspace(db, user.id, wid, 'read');
    return usageReport(ctx, wid);
  });
}

/** Starts periodic jobs; returns a stop function. Checks every minute which scheduled briefs are due. */
export function startAiJobs(ctx: AppContext, log: (msg: string, err?: unknown) => void): () => void {
  const tick = () => {
    try {
      runScheduledBriefs(ctx, log);
    } catch (err) {
      log('planification des briefs IA impossible', err);
    }
  };
  const first = setTimeout(tick, 15_000);
  const interval = setInterval(tick, 60_000);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
