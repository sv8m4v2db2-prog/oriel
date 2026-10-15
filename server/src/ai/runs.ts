// Brief runs (table ai_briefs): start (budget, instance cap, manual quota and concurrency checks),
// background execution, history, monthly usage and the daily schedule.
//
// Spending limits, checked when a run starts (`planRun`):
// - workspace budget (`monthlyBudgetUsd`, workspace owners/admins): month = calendar month of the
//   workspace time zone (brief_date);
// - instance-wide cap (instance admins, `meta`, default AI_INSTANCE_DEFAULT_CAP_USD, QA-AGT-02): month =
//   UTC calendar month of started_at, all workspaces together. A running brief holds its maximum cost
//   (`max_cost_usd`) against it until it finishes, so concurrent runs cannot each spend the same remainder;
//   a run may still overshoot its maximum by one model turn (the cost is checked after each turn);
// - members' manual runs (QA-AGT-03): AI_MANUAL_RUNS_PER_DAY per workspace and local day, and none once
//   the month spend reaches AI_MANUAL_BUDGET_SHARE of the workspace budget (the rest is kept for the
//   scheduled briefs). Owners and admins set the budget and the schedule: they are not limited.
import {
  AI_MANUAL_BUDGET_SHARE,
  AI_MANUAL_RUNS_PER_DAY,
  newId,
  type AiBrief,
  type AiBriefStatus,
  type AiBriefSummary,
  type AiBriefTrigger,
  type AiInstanceCapState,
  type AiInstanceStatus,
  type AiManualRunState,
  type AiSettings,
  type AiUsageResponse,
  type BriefContent,
  type WorkspaceRole,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/rows.js';
import { HttpError, badRequest, conflict } from '../errors.js';
import { createAiClient } from './client.js';
import { describeRunError, runBriefAgent } from './agent.js';
import { visibleBriefContent } from './brief.js';
import { RunAccounting, roundUsd } from './pricing.js';
import { WorkspaceReader } from './reader.js';
import { configurationBlocker, enabledWorkspaceIds, keyStatus, loadInstanceCap, loadSettings, resolveApiKey } from './settings.js';
import { localParts, parseClock, utcMonthRange, type LocalParts } from './time.js';

const frUsd = (n: number) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/** Error code of a run refused because running briefs hold the rest of the instance cap (temporary). */
const INSTANCE_BUSY = 'ai_instance_busy';

/** A scheduled brief may still start this long after its time (server restarted, busy…). */
const SCHEDULE_GRACE_MINUTES = 120;

interface BriefRow {
  id: string;
  workspace_id: string;
  brief_date: string;
  status: AiBriefStatus;
  trigger: AiBriefTrigger;
  model: string;
  content: string | null;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  turns: number;
  started_at: number;
  finished_at: number | null;
  created_by: string | null;
  creator_name: string | null;
}

const BRIEF_SELECT = `SELECT b.*, u.name AS creator_name FROM ai_briefs b LEFT JOIN users u ON u.id = b.created_by`;

function toSummary(r: BriefRow): AiBriefSummary {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    briefDate: r.brief_date,
    status: r.status,
    trigger: r.trigger,
    model: r.model,
    error: r.error,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
    },
    costUsd: r.cost_usd,
    turns: r.turns,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? '' } : null,
  };
}

/** A stored brief, its page references re-checked against the current visibility (QA-AGT-05). */
function toBrief(db: Db, r: BriefRow): AiBrief {
  const content = parseJson<BriefContent | null>(r.content, null);
  return {
    ...toSummary(r),
    content: content && visibleBriefContent(content, new WorkspaceReader(db, r.workspace_id, r.brief_date)),
  };
}

export function getBrief(ctx: AppContext, id: string): AiBrief | null {
  const row = ctx.db.get<BriefRow>(`${BRIEF_SELECT} WHERE b.id = ?`, id);
  return row ? toBrief(ctx.db, row) : null;
}

export function listBriefs(ctx: AppContext, workspaceId: string, limit: number): AiBriefSummary[] {
  return ctx.db
    .all<BriefRow>(`${BRIEF_SELECT} WHERE b.workspace_id = ? ORDER BY b.started_at DESC, b.id LIMIT ?`, workspaceId, limit)
    .map(toSummary);
}

export function latestBriefs(ctx: AppContext, workspaceId: string) {
  const latest = ctx.db.get<BriefRow>(
    `${BRIEF_SELECT} WHERE b.workspace_id = ? AND b.status = 'succeeded' ORDER BY b.started_at DESC LIMIT 1`,
    workspaceId,
  );
  const running = ctx.db.get<BriefRow>(`${BRIEF_SELECT} WHERE b.workspace_id = ? AND b.status = 'running' LIMIT 1`, workspaceId);
  const last = ctx.db.get<BriefRow>(`${BRIEF_SELECT} WHERE b.workspace_id = ? ORDER BY b.started_at DESC LIMIT 1`, workspaceId);
  return {
    latest: latest ? toBrief(ctx.db, latest) : null,
    running: running ? toSummary(running) : null,
    lastRun: last ? toSummary(last) : null,
  };
}

/** Spend of a calendar month ('YYYY-MM', settings time zone) — every run counts, failed ones included. */
export function monthSpend(ctx: AppContext, workspaceId: string, month: string): number {
  return workspaceSpend(ctx.db, workspaceId, month);
}

function workspaceSpend(db: Db, workspaceId: string, month: string): number {
  return (
    db.get<{ total: number | null }>(
      `SELECT SUM(cost_usd) AS total FROM ai_briefs WHERE workspace_id = ? AND substr(brief_date, 1, 7) = ?`,
      workspaceId,
      month,
    )?.total ?? 0
  );
}

interface InstanceBudget {
  capUsd: number;
  isDefault: boolean;
  /** 'YYYY-MM' (UTC). */
  month: string;
  /** Cost of the month's finished runs, all workspaces. */
  spentUsd: number;
  /** Maximum cost of the month's runs in progress. */
  reservedUsd: number;
  runs: number;
}

function instanceBudget(db: Db, now: number): InstanceBudget {
  const { capUsd, isDefault } = loadInstanceCap(db);
  const { month, start, end } = utcMonthRange(now);
  const row = db.get<{ spent: number | null; reserved: number | null; runs: number }>(
    `SELECT SUM(CASE WHEN status = 'running' THEN 0 ELSE cost_usd END) AS spent,
            SUM(CASE WHEN status = 'running' THEN max_cost_usd ELSE 0 END) AS reserved, COUNT(*) AS runs
     FROM ai_briefs WHERE started_at >= ? AND started_at < ?`,
    start,
    end,
  );
  return { capUsd, isDefault, month, spentUsd: row?.spent ?? 0, reservedUsd: row?.reserved ?? 0, runs: row?.runs ?? 0 };
}

/** What the instance cap leaves for a new run: cap − spent − budget held by the runs in progress. */
const instanceAvailable = (b: InstanceBudget) => b.capUsd - b.spentUsd - b.reservedUsd;

function instanceCapState(b: InstanceBudget, workspaceLeftUsd: number): AiInstanceCapState {
  if (b.spentUsd >= b.capUsd) return 'reached';
  return instanceAvailable(b) < workspaceLeftUsd ? 'limiting' : 'ok';
}

/** GET /api/admin/ai (instance admins). */
export function instanceStatus(ctx: AppContext, now = Date.now()): AiInstanceStatus {
  const b = instanceBudget(ctx.db, now);
  return {
    key: keyStatus(ctx.db, true),
    monthlyCapUsd: b.capUsd,
    capIsDefault: b.isDefault,
    month: b.month,
    spentUsd: roundUsd(b.spentUsd),
    reservedUsd: roundUsd(b.reservedUsd),
    runs: b.runs,
    enabledWorkspaces: enabledWorkspaceIds(ctx.db).length,
  };
}

/** The instance cap as seen from a workspace (no amounts: they cover other workspaces). */
export function workspaceInstanceCap(ctx: AppContext, workspaceId: string, now = Date.now()): AiInstanceCapState {
  const settings = loadSettings(ctx.db, workspaceId);
  const spent = monthSpend(ctx, workspaceId, localParts(now, settings.timezone).month);
  return instanceCapState(instanceBudget(ctx.db, now), settings.monthlyBudgetUsd - spent);
}

/** Manual runs of a local day counted against the members' quota (runs started by owners/admins excluded). */
function quotaRunsOn(db: Db, workspaceId: string, date: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ai_briefs b
       LEFT JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = b.created_by
       WHERE b.workspace_id = ? AND b.brief_date = ? AND b.trigger = 'manual' AND COALESCE(m.role, '') NOT IN ('owner', 'admin')`,
      workspaceId,
      date,
    )?.n ?? 0
  );
}

function memberRole(db: Db, userId: string | null, workspaceId: string): WorkspaceRole | null {
  if (!userId) return null;
  return db.get<{ role: WorkspaceRole }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role ?? null;
}

type RunDecision = { kind: 'refuse'; error: HttpError } | { kind: 'skip'; message: string } | { kind: 'run'; maxCostUsd: number };

interface RunPlan {
  settings: AiSettings;
  local: LocalParts;
  decision: RunDecision;
  /** The members' manual quota applies to this run. */
  quota: boolean;
  usedToday: number;
}

/**
 * Whether a brief may start now, and with which maximum cost. Order: configuration (400), run in
 * progress (409), members' manual quota and budget reserve (429), workspace budget (skipped), instance
 * cap (skipped), instance cap held by runs in progress (429, temporary: the scheduler retries next tick).
 */
function planRun(db: Db, workspaceId: string, trigger: AiBriefTrigger, userId: string | null, now: number): RunPlan {
  const settings = loadSettings(db, workspaceId);
  const local = localParts(now, settings.timezone);
  const role = trigger === 'manual' ? memberRole(db, userId, workspaceId) : null;
  const quota = trigger === 'manual' && role !== 'owner' && role !== 'admin';
  const usedToday = quotaRunsOn(db, workspaceId, local.date);
  const plan = (decision: RunDecision): RunPlan => ({ settings, local, decision, quota, usedToday });
  const refuse = (error: HttpError) => plan({ kind: 'refuse', error });

  const blocker = configurationBlocker(db, workspaceId, settings);
  if (blocker) return refuse(badRequest(blocker));
  if (db.get(`SELECT 1 AS x FROM ai_briefs WHERE workspace_id = ? AND status = 'running'`, workspaceId)) {
    return refuse(conflict('Un brief est déjà en cours de génération pour cet espace.'));
  }
  const budget = settings.monthlyBudgetUsd;
  const spent = workspaceSpend(db, workspaceId, local.month);
  const raise = 'Un propriétaire ou un administrateur de l’espace peut relever le plafond dans Réglages › IA.';
  if (quota) {
    if (usedToday >= AI_MANUAL_RUNS_PER_DAY) {
      return refuse(
        new HttpError(
          429,
          'ai_manual_quota',
          `Limite de ${AI_MANUAL_RUNS_PER_DAY} générations manuelles par jour atteinte pour cet espace. ` +
            'Le brief automatique n’est pas concerné ; vous pourrez relancer un brief demain.',
        ),
      );
    }
    if (spent >= budget * AI_MANUAL_BUDGET_SHARE) {
      const reserved = Math.round((1 - AI_MANUAL_BUDGET_SHARE) * 100);
      return refuse(
        new HttpError(
          429,
          'ai_budget_reserved',
          spent >= budget
            ? `Plafond mensuel atteint (${frUsd(spent)} dépensés sur ${frUsd(budget)}) : génération manuelle impossible. ${raise}`
            : `Génération manuelle indisponible : ${frUsd(spent)} dépensés ce mois-ci sur ${frUsd(budget)}, ` +
                `et les ${reserved} % restants du plafond sont réservés aux briefs automatiques. ${raise}`,
        ),
      );
    }
  }
  if (spent >= budget) {
    return plan({
      kind: 'skip',
      message:
        `Plafond mensuel atteint (${frUsd(spent)} dépensés sur ${frUsd(budget)}) : brief non généré. ` +
        'Augmentez le plafond dans Réglages › IA ou attendez le mois prochain.',
    });
  }
  const instance = instanceBudget(db, now);
  if (instance.spentUsd >= instance.capUsd) {
    return plan({
      kind: 'skip',
      message:
        'Plafond mensuel global de l’instance atteint (tous espaces confondus) : brief non généré. ' +
        'L’administrateur du serveur peut le relever ; sinon, les briefs reprendront le mois prochain.',
    });
  }
  const available = instanceAvailable(instance);
  if (available <= 0) {
    return refuse(
      new HttpError(
        429,
        INSTANCE_BUSY,
        'Le budget IA de l’instance est momentanément réservé par d’autres briefs en cours de génération : réessayez dans quelques minutes.',
      ),
    );
  }
  // A member's manual run may only spend up to the reserve line, so that one run started just below it
  // cannot eat the share kept for the scheduled briefs.
  const workspaceLeft = (quota ? budget * AI_MANUAL_BUDGET_SHARE : budget) - spent;
  return plan({ kind: 'run', maxCostUsd: Math.min(workspaceLeft, available) });
}

/** Whether the current user may start a manual brief now (settings response). */
export function manualRunState(ctx: AppContext, workspaceId: string, userId: string, canRun: boolean, now = Date.now()): AiManualRunState {
  const p = planRun(ctx.db, workspaceId, 'manual', userId, now);
  const reason = !canRun
    ? 'Les lecteurs ne peuvent pas générer de brief.'
    : p.decision.kind === 'refuse'
      ? p.decision.error.message
      : p.decision.kind === 'skip'
        ? p.decision.message
        : null;
  return { allowed: reason === null, reason, dailyLimit: p.quota ? AI_MANUAL_RUNS_PER_DAY : null, usedToday: p.usedToday };
}

export function usageReport(ctx: AppContext, workspaceId: string, now = Date.now()): AiUsageResponse {
  const settings = loadSettings(ctx.db, workspaceId);
  const { month } = localParts(now, settings.timezone);
  const rows = ctx.db.all<{ status: AiBriefStatus; n: number; cost: number }>(
    `SELECT status, COUNT(*) AS n, SUM(cost_usd) AS cost FROM ai_briefs
     WHERE workspace_id = ? AND substr(brief_date, 1, 7) = ? GROUP BY status`,
    workspaceId,
    month,
  );
  const count = (s: AiBriefStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  const succeeded = rows.find((r) => r.status === 'succeeded');
  return {
    month,
    spentUsd: roundUsd(rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)),
    budgetUsd: settings.monthlyBudgetUsd,
    runs: rows.reduce((sum, r) => sum + r.n, 0),
    succeeded: count('succeeded'),
    failed: count('failed'),
    skipped: count('skipped'),
    averageCostUsd: succeeded && succeeded.n > 0 ? roundUsd(succeeded.cost / succeeded.n) : null,
    manualLimitUsd: roundUsd(settings.monthlyBudgetUsd * AI_MANUAL_BUDGET_SHARE),
    instanceCap: workspaceInstanceCap(ctx, workspaceId, now),
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

interface InFlight {
  controller: AbortController;
  done: Promise<void>;
}

const inFlight = new WeakMap<AppContext, Map<string, InFlight>>();

function registry(ctx: AppContext): Map<string, InFlight> {
  let map = inFlight.get(ctx);
  if (!map) {
    map = new Map();
    inFlight.set(ctx, map);
  }
  return map;
}

/** Aborts and awaits the runs in progress (server shutdown). */
export async function abortRuns(ctx: AppContext): Promise<void> {
  const runs = [...registry(ctx).values()];
  for (const run of runs) run.controller.abort();
  await Promise.allSettled(runs.map((r) => r.done));
}

/** Resolves once every run in progress has finished (tests). */
export async function settleRuns(ctx: AppContext): Promise<void> {
  await Promise.allSettled([...registry(ctx).values()].map((r) => r.done));
}

/** Runs left `running` by a previous process can never finish: mark them failed. */
export function failInterruptedRuns(ctx: AppContext): void {
  ctx.db.run(
    `UPDATE ai_briefs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`,
    'Génération interrompue par un redémarrage du serveur.',
    Date.now(),
  );
}

/**
 * Creates a run (see `planRun`). Throws 400 (not configured) / 409 (one already running) / 429 (members'
 * manual quota or budget reserve, instance cap held by runs in progress). Returns a `skipped` run when
 * the workspace budget or the instance cap is exhausted; otherwise the run executes in the background,
 * stopped at min(workspace remainder, instance remainder), which it holds against the instance cap.
 */
export function startBrief(
  ctx: AppContext,
  workspaceId: string,
  trigger: AiBriefTrigger,
  userId: string | null,
  now = Date.now(),
): AiBrief {
  const { db } = ctx;
  const id = newId();
  // One write transaction: the checks and the reservation are atomic, also across processes.
  const decision = db.tx(() => {
    const { settings, local, decision } = planRun(db, workspaceId, trigger, userId, now);
    if (decision.kind === 'refuse') throw decision.error;
    const skipped = decision.kind === 'skip';
    db.run(
      `INSERT INTO ai_briefs (id, workspace_id, brief_date, status, trigger, model, error, started_at, finished_at, created_by, max_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      local.date,
      skipped ? 'skipped' : 'running',
      trigger,
      settings.model,
      skipped ? decision.message : null,
      now,
      skipped ? now : null,
      userId,
      skipped ? 0 : decision.maxCostUsd,
    );
    return decision;
  });
  if (decision.kind === 'run') {
    const controller = new AbortController();
    const map = registry(ctx);
    const done = executeBrief(ctx, id, workspaceId, decision.maxCostUsd, controller.signal).finally(() => map.delete(id));
    map.set(id, { controller, done });
  }
  return getBrief(ctx, id)!;
}

async function executeBrief(ctx: AppContext, runId: string, workspaceId: string, budgetLeft: number, signal: AbortSignal): Promise<void> {
  const { db } = ctx;
  const settings = loadSettings(db, workspaceId);
  const accounting = new RunAccounting(settings.model);
  let status: AiBriefStatus = 'failed';
  let content: BriefContent | null = null;
  let error: string | null = null;
  try {
    const row = db.get<{ brief_date: string }>('SELECT brief_date FROM ai_briefs WHERE id = ?', runId);
    const workspace = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', workspaceId);
    const reader = new WorkspaceReader(db, workspaceId, row?.brief_date ?? localParts(Date.now(), settings.timezone).date);
    const result = await runBriefAgent({
      client: createAiClient(resolveApiKey(db).key ?? ''),
      model: settings.model,
      reader,
      sourceIds: settings.sourceDatabaseIds,
      workspaceName: workspace?.name ?? '',
      timezone: settings.timezone,
      accounting,
      maxCostUsd: Math.max(0, budgetLeft),
      signal,
    });
    content = result.content;
    status = 'succeeded';
  } catch (err) {
    error = describeRunError(err);
    if (error.startsWith('Erreur interne')) console.error('[ai] brief run failed', err);
  }
  try {
    db.run(
      `UPDATE ai_briefs SET status = ?, content = ?, error = ?, input_tokens = ?, output_tokens = ?, cache_creation_tokens = ?,
         cache_read_tokens = ?, cost_usd = ?, turns = ?, finished_at = ? WHERE id = ?`,
      status,
      content ? JSON.stringify(content) : null,
      error,
      accounting.usage.inputTokens,
      accounting.usage.outputTokens,
      accounting.usage.cacheCreationTokens,
      accounting.usage.cacheReadTokens,
      roundUsd(accounting.costUsd),
      accounting.turns,
      Date.now(),
      runId,
    );
  } catch (err) {
    console.error('[ai] could not record the brief run', err);
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Local date of the scheduled brief that should start at `now`, or null: a scheduled weekday, from the
 * scheduled time until SCHEDULE_GRACE_MINUTES later (catch-up after a restart), in the settings time zone.
 */
export function scheduleSlot(settings: Pick<AiSettings, 'scheduleTime' | 'scheduleDays' | 'timezone'>, now: number): string | null {
  const at = parseClock(settings.scheduleTime);
  if (at === null) return null;
  const local = localParts(now, settings.timezone);
  if (!settings.scheduleDays.includes(local.weekday)) return null;
  if (local.minutes < at || local.minutes >= at + SCHEDULE_GRACE_MINUTES) return null;
  return local.date;
}

/** Workspaces whose scheduled brief is due at `now` (one scheduled run per local day at most). */
export function dueWorkspaces(ctx: AppContext, now = Date.now()): string[] {
  const due: string[] = [];
  for (const wid of enabledWorkspaceIds(ctx.db)) {
    const settings = loadSettings(ctx.db, wid);
    const date = scheduleSlot(settings, now);
    if (!date) continue;
    const exists = ctx.db.get(
      `SELECT 1 AS x FROM ai_briefs WHERE workspace_id = ? AND brief_date = ? AND trigger = 'schedule'`,
      wid,
      date,
    );
    if (exists) continue;
    if (ctx.db.get(`SELECT 1 AS x FROM ai_briefs WHERE workspace_id = ? AND status = 'running'`, wid)) continue;
    if (configurationBlocker(ctx.db, wid, settings)) continue;
    due.push(wid);
  }
  return due;
}

/** One scheduler tick: starts the due briefs. Returns the started (or skipped) run ids. */
export function runScheduledBriefs(ctx: AppContext, log: (msg: string, err?: unknown) => void, now = Date.now()): string[] {
  const started: string[] = [];
  for (const wid of dueWorkspaces(ctx, now)) {
    try {
      const brief = startBrief(ctx, wid, 'schedule', null, now);
      started.push(brief.id);
      if (brief.status === 'skipped') log(`brief IA de l'espace ${wid} non généré : ${brief.error ?? 'plafond atteint'}`);
    } catch (err) {
      // The instance cap is held by runs in progress: retried at the next tick (within the grace window).
      if (err instanceof HttpError && err.code === INSTANCE_BUSY) continue;
      log(`brief IA planifié de l'espace ${wid} impossible`, err);
    }
  }
  return started;
}
