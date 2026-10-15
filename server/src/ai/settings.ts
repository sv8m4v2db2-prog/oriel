// Workspace AI settings (table ai_settings), the instance-level Anthropic API key and the
// instance-wide monthly spending cap.
import {
  AI_DEFAULT_MODEL,
  AI_INSTANCE_DEFAULT_CAP_USD,
  AI_INSTANCE_MAX_CAP_USD,
  AI_MODEL_IDS,
  type AiDatabaseOption,
  type AiKeyStatus,
  type AiModelId,
  type AiSettings,
  type AiSourceInfo,
  type IsoWeekday,
  type UpdateAiSettingsRequest,
} from '@oriel/shared';
import type { Db } from '../db/index.js';
import { parseJson, type PageRow } from '../db/rows.js';
import { badRequest } from '../errors.js';
import { ancestorsCrumbs } from '../services/search.js';
import { isValidTimeZone, parseClock } from './time.js';

/** `meta` key of the API key saved from the interface (the ANTHROPIC_API_KEY env var wins). */
export const API_KEY_META = 'ai_api_key';
/**
 * `meta` key of the instance-wide monthly cap in USD, set by an instance admin (QA-AGT-02). Unset (or
 * unreadable): AI_INSTANCE_DEFAULT_CAP_USD. 0 disables AI briefs on the whole instance.
 */
export const INSTANCE_CAP_META = 'ai_instance_monthly_cap_usd';

interface AiSettingsRow {
  workspace_id: string;
  enabled: number;
  model: string;
  source_database_ids: string;
  schedule_time: string;
  schedule_days: string;
  timezone: string;
  monthly_budget_usd: number;
  updated_at: number;
  updated_by: string | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  model: AI_DEFAULT_MODEL,
  sourceDatabaseIds: [],
  scheduleTime: '07:30',
  scheduleDays: [1, 2, 3, 4, 5],
  timezone: 'Europe/Paris',
  monthlyBudgetUsd: 15,
  updatedAt: null,
  updatedBy: null,
};

const MAX_SOURCES = 20;

/** Demo mode: a deterministic fake agent replaces the Anthropic API (no key, no cost). */
export const isFakeMode = (): boolean => process.env.ORIEL_AI_FAKE === '1';

function toSettings(r: AiSettingsRow): AiSettings {
  const model = (AI_MODEL_IDS as string[]).includes(r.model) ? (r.model as AiModelId) : AI_DEFAULT_MODEL;
  return {
    enabled: r.enabled === 1,
    model,
    sourceDatabaseIds: parseJson<string[]>(r.source_database_ids, []).filter((id) => typeof id === 'string'),
    scheduleTime: parseClock(r.schedule_time) === null ? DEFAULT_AI_SETTINGS.scheduleTime : r.schedule_time,
    scheduleDays: parseJson<number[]>(r.schedule_days, []).filter((d): d is IsoWeekday => Number.isInteger(d) && d >= 1 && d <= 7),
    timezone: isValidTimeZone(r.timezone) ? r.timezone : DEFAULT_AI_SETTINGS.timezone,
    monthlyBudgetUsd: Number.isFinite(r.monthly_budget_usd) ? r.monthly_budget_usd : DEFAULT_AI_SETTINGS.monthlyBudgetUsd,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function loadSettings(db: Db, workspaceId: string): AiSettings {
  const row = db.get<AiSettingsRow>('SELECT * FROM ai_settings WHERE workspace_id = ?', workspaceId);
  return row ? toSettings(row) : { ...DEFAULT_AI_SETTINGS, scheduleDays: [...DEFAULT_AI_SETTINGS.scheduleDays] };
}

/** Workspace ids whose AI settings are enabled (scheduler). */
export function enabledWorkspaceIds(db: Db): string[] {
  return db.all<{ workspace_id: string }>('SELECT workspace_id FROM ai_settings WHERE enabled = 1').map((r) => r.workspace_id);
}

/** A database the agent may read: same workspace, visible to every member, not in the trash. */
export function analysableDatabase(db: Db, workspaceId: string, id: string): PageRow | null {
  const row = db.get<PageRow>(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND kind = 'database' AND visibility = 'workspace' AND trashed_at IS NULL`,
    id,
    workspaceId,
  );
  return row ?? null;
}

/** Databases selectable as sources: visible to every member, not trashed (root ones first). */
export function analysableDatabases(db: Db, workspaceId: string, limit = 300): AiDatabaseOption[] {
  return db
    .all<Pick<PageRow, 'id' | 'title' | 'icon' | 'parent_type'>>(
      `SELECT id, title, icon, parent_type FROM pages WHERE workspace_id = ? AND kind = 'database' AND visibility = 'workspace'
         AND trashed_at IS NULL ORDER BY parent_type = 'workspace' DESC, title COLLATE NOCASE, id LIMIT ?`,
      workspaceId,
      limit,
    )
    .map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      path: r.parent_type === 'workspace' ? '' : ancestorsCrumbs(db, r.id).map((c) => c.title || 'Sans titre').join(' / '),
    }));
}

export function sourceInfos(db: Db, workspaceId: string, ids: string[]): AiSourceInfo[] {
  return ids.map((id) => {
    const row = analysableDatabase(db, workspaceId, id);
    if (row) return { id, title: row.title, icon: row.icon, available: true };
    // Settings are readable by every member: a source that became private (moved to someone's private
    // pages) must not reveal its current title or icon. Trashed shared sources keep theirs (as in the trash).
    const any = db.get<Pick<PageRow, 'title' | 'icon'>>(
      `SELECT title, icon FROM pages WHERE id = ? AND workspace_id = ? AND visibility = 'workspace'`,
      id,
      workspaceId,
    );
    return { id, title: any?.title ?? '', icon: any?.icon ?? null, available: false };
  });
}

export function saveSettings(db: Db, workspaceId: string, patch: UpdateAiSettingsRequest, actorId: string): AiSettings {
  const current = loadSettings(db, workspaceId);
  const next: AiSettings = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.scheduleTime !== undefined) {
    if (parseClock(patch.scheduleTime) === null) throw badRequest('Heure invalide (format attendu : HH:MM).');
    next.scheduleTime = patch.scheduleTime;
  }
  if (patch.scheduleDays !== undefined) next.scheduleDays = [...new Set(patch.scheduleDays)].sort((a, b) => a - b);
  if (patch.timezone !== undefined) {
    if (!isValidTimeZone(patch.timezone)) throw badRequest('Fuseau horaire inconnu.');
    next.timezone = patch.timezone;
  }
  if (patch.monthlyBudgetUsd !== undefined) next.monthlyBudgetUsd = Math.round(patch.monthlyBudgetUsd * 100) / 100;
  if (patch.sourceDatabaseIds !== undefined) {
    const ids = [...new Set(patch.sourceDatabaseIds)];
    if (ids.length > MAX_SOURCES) throw badRequest(`${MAX_SOURCES} bases au maximum.`);
    for (const id of ids) {
      // Keep sources that were already configured even if they became unavailable (shown as such);
      // new ones must be analysable now.
      if (current.sourceDatabaseIds.includes(id)) continue;
      if (!analysableDatabase(db, workspaceId, id)) {
        throw badRequest('Base introuvable, supprimée ou privée : seules les bases visibles par tout l’espace peuvent être analysées.');
      }
    }
    next.sourceDatabaseIds = ids;
  }
  const now = Date.now();
  db.run(
    `INSERT INTO ai_settings (workspace_id, enabled, model, source_database_ids, schedule_time, schedule_days, timezone,
       monthly_budget_usd, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled, model = excluded.model,
       source_database_ids = excluded.source_database_ids, schedule_time = excluded.schedule_time,
       schedule_days = excluded.schedule_days, timezone = excluded.timezone,
       monthly_budget_usd = excluded.monthly_budget_usd, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    workspaceId,
    next.enabled,
    next.model,
    JSON.stringify(next.sourceDatabaseIds),
    next.scheduleTime,
    JSON.stringify(next.scheduleDays),
    next.timezone,
    next.monthlyBudgetUsd,
    now,
    actorId,
  );
  return loadSettings(db, workspaceId);
}

// ---------------------------------------------------------------------------
// Instance API key — never returned to clients.
// ---------------------------------------------------------------------------

export function resolveApiKey(db: Db): { key: string | null; source: AiKeyStatus['source'] } {
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return { key: env, source: 'env' };
  const saved = db.getMeta(API_KEY_META)?.trim();
  if (saved) return { key: saved, source: 'saved' };
  return { key: null, source: 'none' };
}

export function keyStatus(db: Db, withHint: boolean): AiKeyStatus {
  const { key, source } = resolveApiKey(db);
  return { source, hint: withHint && key ? `…${key.slice(-4)}` : null };
}

export function saveApiKey(db: Db, apiKey: string): void {
  db.setMeta(API_KEY_META, apiKey.trim());
}

export function deleteApiKey(db: Db): void {
  db.run('DELETE FROM meta WHERE key = ?', API_KEY_META);
}

// ---------------------------------------------------------------------------
// Instance-wide monthly cap (instance admins) — see runs.ts for its enforcement.
// ---------------------------------------------------------------------------

export function loadInstanceCap(db: Db): { capUsd: number; isDefault: boolean } {
  const raw = db.getMeta(INSTANCE_CAP_META);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) return { capUsd: AI_INSTANCE_DEFAULT_CAP_USD, isDefault: true };
  return { capUsd: Math.min(value, AI_INSTANCE_MAX_CAP_USD), isDefault: false };
}

export function saveInstanceCap(db: Db, capUsd: number): void {
  db.setMeta(INSTANCE_CAP_META, String(Math.round(capUsd * 100) / 100));
}

/** Why a brief cannot run right now (French), or null when everything is configured. */
export function configurationBlocker(db: Db, workspaceId: string, settings: AiSettings): string | null {
  if (!settings.enabled) return 'Le brief IA est désactivé pour cet espace (Réglages › IA).';
  if (loadInstanceCap(db).capUsd <= 0) return 'Le brief IA est désactivé sur ce serveur par son administrateur.';
  if (!isFakeMode() && !resolveApiKey(db).key) return 'Aucune clé API Anthropic n’est configurée sur ce serveur.';
  if (!settings.sourceDatabaseIds.some((id) => analysableDatabase(db, workspaceId, id))) {
    return 'Choisissez au moins une base « Projets » à analyser (Réglages › IA).';
  }
  return null;
}
