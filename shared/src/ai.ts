// Contract of the "ai" feature module — « Brief du jour » (types shared by server and web).
// Routes (all under /api, session cookie auth):
//   GET    /workspaces/:wid/ai/settings        → AiSettingsResponse          (members)
//   PUT    /workspaces/:wid/ai/settings        → AiSettingsResponse          (workspace owner/admin)
//   GET    /admin/ai                           → AiInstanceStatus            (instance admin)
//   PUT    /admin/ai                           → AiInstanceStatus            (instance admin; UpdateAiInstanceRequest)
//   PUT    /admin/ai/key                       → AiKeyStatus                 (instance admin)
//   DELETE /admin/ai/key                       → AiKeyStatus                 (instance admin)
//   POST   /workspaces/:wid/ai/briefs          → 202 StartBriefResponse      (members who can edit;
//                                                 429 when the manual-run quota or budget reserve applies)
//   GET    /workspaces/:wid/ai/briefs?limit=   → AiBriefsResponse            (members)
//   GET    /workspaces/:wid/ai/briefs/latest   → AiLatestBriefResponse       (members)
//   GET    /ai/briefs/:id                      → AiBrief                     (members of its workspace)
//   GET    /workspaces/:wid/ai/usage           → AiUsageResponse             (members)

export type AiModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export const AI_DEFAULT_MODEL: AiModelId = 'claude-opus-5-5';

/** USD per million tokens. */
export interface AiModelPricing {
  input: number;
  output: number;
  /** 5-minute cache write. */
  cacheWrite: number;
  cacheRead: number;
}

export interface AiModelInfo {
  id: AiModelId;
  label: string;
  description: string;
  recommended: boolean;
  pricing: AiModelPricing;
  /** Indicative cost of one brief (USD), for ~15 active projects. Real cost is measured per run. */
  estimatePerBriefUsd: [number, number];
}

export const AI_MODELS: AiModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Qualité maximale : analyse fine des retards et des risques.',
    recommended: true,
    pricing: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    estimatePerBriefUsd: [0.4, 0.7],
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    description: 'Bon équilibre entre qualité et coût.',
    recommended: false,
    pricing: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    estimatePerBriefUsd: [0.2, 0.35],
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    description: 'Très économique, analyse plus sommaire.',
    recommended: false,
    pricing: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    estimatePerBriefUsd: [0.02, 0.04],
  },
];

export const AI_MODEL_IDS = AI_MODELS.map((m) => m.id);

export function aiModelInfo(id: string): AiModelInfo | undefined {
  return AI_MODELS.find((m) => m.id === id);
}

/** ISO weekday numbers: 1 = lundi … 7 = dimanche. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const AI_WEEKDAY_LABELS: Record<IsoWeekday, string> = {
  1: 'Lundi',
  2: 'Mardi',
  3: 'Mercredi',
  4: 'Jeudi',
  5: 'Vendredi',
  6: 'Samedi',
  7: 'Dimanche',
};

export interface AiSettings {
  /** Scheduled briefs + feature visible to members. */
  enabled: boolean;
  model: AiModelId;
  /** "Projets" databases analysed by the agent (workspace-visible databases only). */
  sourceDatabaseIds: string[];
  /** Local time 'HH:MM' of the scheduled brief. */
  scheduleTime: string;
  scheduleDays: IsoWeekday[];
  /** IANA time zone, e.g. 'Europe/Paris'. */
  timezone: string;
  /** Monthly spending cap in USD: briefs are skipped once reached. */
  monthlyBudgetUsd: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

export type UpdateAiSettingsRequest = Partial<Omit<AiSettings, 'updatedAt' | 'updatedBy'>>;

/** Where the instance API key comes from. The key itself is never sent to clients. */
export interface AiKeyStatus {
  source: 'env' | 'saved' | 'none';
  /** Last characters, e.g. '…a1b2' (instance admins only, null otherwise). */
  hint: string | null;
}

/** PUT /api/admin/ai/key */
export interface SaveAiKeyRequest {
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Spending limits
// ---------------------------------------------------------------------------

/**
 * Instance-wide monthly cap (USD) when the instance administrator never set one (QA-AGT-02): every
 * workspace of the server spends the same API key, whatever its own monthly budget.
 */
export const AI_INSTANCE_DEFAULT_CAP_USD = 50;
/** Upper bound of the instance-wide cap; 0 disables AI briefs on the whole instance. */
export const AI_INSTANCE_MAX_CAP_USD = 10_000;
/**
 * Manual runs (« Régénérer ») allowed per workspace and local day (settings time zone), shared by the
 * members who cannot manage the workspace; owners and admins, who set the budget, are not limited (QA-AGT-03).
 */
export const AI_MANUAL_RUNS_PER_DAY = 5;
/**
 * Members' manual runs are refused once the month spend reaches this share of the workspace budget:
 * the rest is kept for the scheduled briefs (QA-AGT-03).
 */
export const AI_MANUAL_BUDGET_SHARE = 0.8;

/**
 * The instance-wide cap as seen from a workspace (no amounts: they cover every workspace).
 * - `ok`: the workspace's own budget is the limit;
 * - `limiting`: what is left of the instance cap this month is below what is left of the workspace budget;
 * - `reached`: the instance cap is reached (or set to 0): no brief until next month or until the
 *   instance administrator raises it.
 */
export type AiInstanceCapState = 'ok' | 'limiting' | 'reached';

/** GET/PUT /api/admin/ai — instance-wide AI state (instance admins only). */
export interface AiInstanceStatus {
  key: AiKeyStatus;
  /** Monthly cap of the whole instance (USD, all workspaces together); 0 = AI briefs disabled. */
  monthlyCapUsd: number;
  /** No cap was ever saved: AI_INSTANCE_DEFAULT_CAP_USD applies. */
  capIsDefault: boolean;
  /** Current month of the instance cap: 'YYYY-MM', UTC calendar month of the runs' start time. */
  month: string;
  /** Cost of the month's finished runs, all workspaces (USD). */
  spentUsd: number;
  /** Budget held by the runs in progress (their maximum cost), released when they finish. */
  reservedUsd: number;
  /** Runs started this month, all workspaces (skipped ones included). */
  runs: number;
  /** Workspaces with the brief enabled. */
  enabledWorkspaces: number;
}

/** PUT /api/admin/ai */
export interface UpdateAiInstanceRequest {
  monthlyCapUsd: number;
}

/** Whether the current user may start a manual brief right now, and why not. */
export interface AiManualRunState {
  allowed: boolean;
  /** French reason when not allowed (configuration, run in progress, quota, reserve, caps), else null. */
  reason: string | null;
  /** Daily quota of manual runs, or null when it does not apply to the current user (workspace owner/admin). */
  dailyLimit: number | null;
  /** Manual runs counted against the quota today (local day). */
  usedToday: number;
}

export interface AiSourceInfo {
  id: string;
  title: string;
  icon: string | null;
  /** false when the database was deleted, trashed or made private. */
  available: boolean;
}

/** A database that can be chosen as a source (visible to the whole workspace, not trashed). */
export interface AiDatabaseOption {
  id: string;
  title: string;
  icon: string | null;
  /** Ancestor titles, root first, joined with ' / ' (empty at the workspace root). */
  path: string;
}

export interface AiSettingsResponse {
  settings: AiSettings;
  key: AiKeyStatus;
  /** Server runs with ORIEL_AI_FAKE=1 (deterministic demo agent, no API calls). */
  fakeMode: boolean;
  /** Enabled, an API key (or demo mode) and at least one available source. */
  configured: boolean;
  /** Why a brief cannot be generated (French), or null. */
  blocker: string | null;
  sources: AiSourceInfo[];
  /** Databases selectable as sources (only for users who can manage the settings, else empty). */
  databases: AiDatabaseOption[];
  /** The current user may change the workspace settings (owner/admin). */
  canManage: boolean;
  /** The current user may change the instance API key (instance admin). */
  canManageKey: boolean;
  /** The current user may start a brief (edit rights). */
  canRun: boolean;
  /** Manual run right now: quota, budget reserve and caps included (see AiManualRunState). */
  manualRun: AiManualRunState;
  /** Instance-wide cap as seen from this workspace. */
  instanceCap: AiInstanceCapState;
}

// ---------------------------------------------------------------------------
// Brief content (produced by the agent through the `publier_brief` tool, then
// validated and enriched by the server)
// ---------------------------------------------------------------------------

/** How to open a linked page: database rows open in the side peek, others navigate. */
export type BriefTarget = 'ligne' | 'page' | 'base';

export interface BriefLink {
  id: string;
  titre: string;
  cible: BriefTarget;
}

export interface BriefItem {
  titre: string;
  pageId: string;
  cible: BriefTarget;
  projetId: string | null;
  projetTitre: string | null;
  /** 'YYYY-MM-DD' or null. */
  echeance: string | null;
  responsables: string[];
  note: string;
}

export type BriefSeverity = 'haute' | 'moyenne' | 'basse';

export interface BriefRisk {
  description: string;
  gravite: BriefSeverity;
  pages: BriefLink[];
}

export type BriefProjectState = 'en_bonne_voie' | 'a_surveiller' | 'en_retard';

export interface BriefProject {
  pageId: string;
  cible: BriefTarget;
  titre: string;
  etat: BriefProjectState;
  commentaire: string;
}

export interface BriefContent {
  resume: string;
  priorites: BriefItem[];
  en_retard: BriefItem[];
  a_venir: BriefItem[];
  risques: BriefRisk[];
  projets: BriefProject[];
}

export const BRIEF_SEVERITY_LABELS: Record<BriefSeverity, string> = { haute: 'Haute', moyenne: 'Moyenne', basse: 'Basse' };
export const BRIEF_PROJECT_STATE_LABELS: Record<BriefProjectState, string> = {
  en_bonne_voie: 'En bonne voie',
  a_surveiller: 'À surveiller',
  en_retard: 'En retard',
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type AiBriefStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type AiBriefTrigger = 'schedule' | 'manual';

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AiBriefSummary {
  id: string;
  workspaceId: string;
  /** Local date (settings time zone) 'YYYY-MM-DD'. */
  briefDate: string;
  status: AiBriefStatus;
  trigger: AiBriefTrigger;
  model: string;
  /** French message for failed/skipped runs. */
  error: string | null;
  usage: AiTokenUsage;
  costUsd: number;
  /** Number of model requests (agent turns). */
  turns: number;
  startedAt: number;
  finishedAt: number | null;
  createdBy: { id: string; name: string } | null;
}

export interface AiBrief extends AiBriefSummary {
  content: BriefContent | null;
}

/** POST /workspaces/:wid/ai/briefs (202) — the run executes in the background; poll GET /ai/briefs/:id. */
export interface StartBriefResponse {
  brief: AiBrief;
}

export interface AiBriefsResponse {
  briefs: AiBriefSummary[];
}

export interface AiLatestBriefResponse {
  /** Latest succeeded brief (with content). */
  latest: AiBrief | null;
  /** Run in progress, if any. */
  running: AiBriefSummary | null;
  /** Most recent run of any status (to show a failure newer than `latest`). */
  lastRun: AiBriefSummary | null;
}

export interface AiUsageResponse {
  /** 'YYYY-MM' in the settings time zone. */
  month: string;
  spentUsd: number;
  budgetUsd: number;
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Average cost of the month's succeeded briefs (USD), or null. */
  averageCostUsd: number | null;
  /** Spend from which members' manual runs are refused (budget × AI_MANUAL_BUDGET_SHARE). */
  manualLimitUsd: number;
  /** Instance-wide cap as seen from this workspace. */
  instanceCap: AiInstanceCapState;
}
