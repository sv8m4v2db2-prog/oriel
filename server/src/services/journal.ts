// Organize module (wave H3): personal daily journal. One private page per day and per person,
// kept under a private « Journal » page of the person. Opening a day is idempotent (the unique
// key (workspace, user, day) and BEGIN IMMEDIATE make concurrent opens return the same page).
import { isJournalDay, type JournalMonthResponse, type JournalOpenResponse } from '@oriel/shared';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { getPageRow, pageAccess, requireWorkspace, visiblePageClause, visiblePageParams } from '../access.js';
import { badRequest, notFound } from '../errors.js';
import { createPage, duplicatePage } from './pages.js';

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « jeudi 15 octobre 2026 » (computed from the calendar day, independent of any time zone). */
export function journalTitle(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const date = d.getUTCDate();
  return `${WEEKDAYS[d.getUTCDay()]} ${date === 1 ? '1er' : date} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

interface Settings {
  container_id: string | null;
  template_id: string | null;
}

function settingsOf(db: Db, workspaceId: string, userId: string): Settings {
  return db.get<Settings>('SELECT container_id, template_id FROM org_journal_settings WHERE workspace_id = ? AND user_id = ?', workspaceId, userId) ?? {
    container_id: null,
    template_id: null,
  };
}

function saveSettings(db: Db, workspaceId: string, userId: string, patch: Partial<Settings>): void {
  const current = settingsOf(db, workspaceId, userId);
  const next = { ...current, ...patch };
  db.run(
    `INSERT INTO org_journal_settings (workspace_id, user_id, container_id, template_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET container_id = excluded.container_id, template_id = excluded.template_id`,
    workspaceId,
    userId,
    next.container_id,
    next.template_id,
  );
}

/** A template the user may instantiate: a live template page they can see in this workspace. */
function usableTemplate(db: Db, userId: string, workspaceId: string, templateId: string | null): { id: string; title: string; icon: string | null } | null {
  if (!templateId) return null;
  const access = pageAccess(db, userId, templateId);
  if (!access || access.page.workspace_id !== workspaceId || access.page.trashed_at !== null) return null;
  const flag = db.get<{ is_template: number }>('SELECT is_template FROM pages WHERE id = ?', templateId);
  return flag?.is_template === 1 ? { id: access.page.id, title: access.page.title, icon: access.page.icon } : null;
}

export function journalMonth(db: Db, userId: string, workspaceId: string, month: string): JournalMonthResponse {
  requireWorkspace(db, userId, workspaceId);
  if (!/^\d{4}-\d{2}$/.test(month) || !isJournalDay(`${month}-01`)) throw badRequest('Mois invalide (AAAA-MM).');
  const days = db.all<{ day: string; page_id: string }>(
    `SELECT e.day, e.page_id FROM org_journal_entries e JOIN pages p ON p.id = e.page_id
     WHERE e.workspace_id = ? AND e.user_id = ? AND e.day >= ? AND e.day <= ? AND p.trashed_at IS NULL AND ${visiblePageClause('p')}
     ORDER BY e.day`,
    workspaceId,
    userId,
    `${month}-01`,
    `${month}-31`,
    ...visiblePageParams(userId),
  );
  const settings = settingsOf(db, workspaceId, userId);
  const container = settings.container_id ? getPageRow(db, settings.container_id) : undefined;
  return {
    month,
    days: days.map((d) => ({ day: d.day, pageId: d.page_id })),
    containerId: container && container.trashed_at === null ? container.id : null,
    template: usableTemplate(db, userId, workspaceId, settings.template_id),
  };
}

/** Opens the journal page of a day, creating it (and the « Journal » page) on first use. */
export function openJournalDay(ctx: AppContext, userId: string, workspaceId: string, day: string): JournalOpenResponse {
  const { db } = ctx;
  if (!isJournalDay(day)) throw badRequest('Jour invalide (AAAA-MM-JJ, entre 2000 et 2100).');
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId, 'edit');
    const entry = db.get<{ page_id: string }>('SELECT page_id FROM org_journal_entries WHERE workspace_id = ? AND user_id = ? AND day = ?', workspaceId, userId, day);
    if (entry) {
      const page = getPageRow(db, entry.page_id);
      if (page && page.trashed_at === null && pageAccess(db, userId, page.id)) return { day, pageId: page.id, created: false };
    }

    // The « Journal » container: a private root page owned by the user.
    const settings = settingsOf(db, workspaceId, userId);
    let container = settings.container_id ? getPageRow(db, settings.container_id) : undefined;
    const usable =
      !!container &&
      container.trashed_at === null &&
      container.workspace_id === workspaceId &&
      container.kind === 'page' &&
      container.visibility === 'private' &&
      container.owner_id === userId;
    if (!usable) {
      container = createPage(ctx, userId, workspaceId, { parentType: 'workspace', parentId: workspaceId, title: 'Journal', icon: '📓', visibility: 'private' });
      saveSettings(db, workspaceId, userId, { container_id: container.id });
    }
    const containerId = container!.id;

    // Newest day first: the new page goes right after the next more recent day, or on top.
    const newer = db.get<{ page_id: string }>(
      `SELECT e.page_id FROM org_journal_entries e JOIN pages p ON p.id = e.page_id
       WHERE e.workspace_id = ? AND e.user_id = ? AND e.day > ? AND p.parent_id = ? AND p.trashed_at IS NULL ORDER BY e.day LIMIT 1`,
      workspaceId,
      userId,
      day,
      containerId,
    );
    const after = newer ? newer.page_id : null;
    const title = journalTitle(day);
    const template = usableTemplate(db, userId, workspaceId, settings.template_id);
    const page = template
      ? duplicatePage(ctx, userId, template.id, { target: { parentType: 'page', parentId: containerId, after }, title })
      : createPage(ctx, userId, workspaceId, { parentType: 'page', parentId: containerId, title, icon: '📅', after });
    db.run(
      `INSERT INTO org_journal_entries (workspace_id, user_id, day, page_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id, day) DO UPDATE SET page_id = excluded.page_id`,
      workspaceId,
      userId,
      day,
      page.id,
    );
    ctx.bus.publish(workspaceId, { entity: 'organize', workspaceId, scope: 'journal' }, userId);
    return { day, pageId: page.id, created: true };
  });
}

/** Chooses the page template used for new days (null = empty pages). */
export function setJournalTemplate(ctx: AppContext, userId: string, workspaceId: string, templateId: string | null): JournalMonthResponse['template'] {
  const { db } = ctx;
  return db.tx(() => {
    requireWorkspace(db, userId, workspaceId);
    const template = templateId ? usableTemplate(db, userId, workspaceId, templateId) : null;
    if (templateId && !template) throw notFound('Modèle introuvable.');
    saveSettings(db, workspaceId, userId, { template_id: template ? template.id : null });
    ctx.bus.publish(workspaceId, { entity: 'organize', workspaceId, scope: 'journal' }, userId);
    return template;
  });
}
