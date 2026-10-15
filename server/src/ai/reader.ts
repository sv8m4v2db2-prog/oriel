// Read-only view of ONE workspace for the brief agent, with the rights of a restricted service
// account: only pages visible to every member (never private pages) and never trashed content.
// Results are compact plain objects (serialized as JSON for the model).
import type { BriefTarget, DateValue, FileValue, PropertyDef, PropertyValue, StatusGroup } from '@oriel/shared';
import type { Db } from '../db/index.js';
import { parseJson, type PageRow } from '../db/rows.js';
import { ancestorsCrumbs, searchPages } from '../services/search.js';
import { visibleProperties } from '../services/propertyAccess.js';

export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 100;
export const DEFAULT_PAGE_CHARS = 4000;
export const MAX_PAGE_CHARS = 20000;
const MAX_TEXT_VALUE = 300;
const MAX_CHILDREN = 50;
const MAX_INLINE_PLANNINGS = 60;
/** Bounds of what one tool result may hold, whatever the data (cost and context size of a turn). */
export const MAX_ROWS_CHARS = 80_000;
const MAX_TITLE = 300;
const MAX_ROW_PROPERTIES = 60;
const MAX_LISTED_OPTIONS = 50;
/** Never matches a page owner: searches only return pages visible to the whole workspace. */
const SERVICE_ACCOUNT_ID = '\u0000oriel-ai';

export type StatusFilter = 'todo' | 'in_progress' | 'done' | 'non_termine';

const DUE_NAME = /(é|e)ch(é|e)ance|deadline|livraison|rendu|limite|due|\bfin\b/i;
const DONE_NAME = /termin|fait|done|fini|livr|clos/i;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const dayOf = (s: string | null | undefined): string | null => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

interface StatusInfo {
  status: PropertyDef | null;
  doneCheckbox: PropertyDef | null;
}

export class WorkspaceReader {
  private readonly pageCache = new Map<string, PageRow | null>();
  private readonly userCache = new Map<string, string | null>();
  private readonly schemaCache = new Map<string, PropertyDef[]>();

  constructor(
    private readonly db: Db,
    readonly workspaceId: string,
    /** Local 'YYYY-MM-DD' of the run. */
    readonly today: string,
  ) {}

  // --- access ---------------------------------------------------------------------------

  /** A page the agent may see, or null (other workspace, private, trashed, unknown). */
  page(id: unknown): PageRow | null {
    if (typeof id !== 'string' || !id || id.length > 128) return null;
    if (!this.pageCache.has(id)) {
      const row = this.db.get<PageRow>(
        `SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND visibility = 'workspace' AND trashed_at IS NULL`,
        id,
        this.workspaceId,
      );
      this.pageCache.set(id, row ?? null);
    }
    return this.pageCache.get(id) ?? null;
  }

  database(id: unknown): PageRow | null {
    const page = this.page(id);
    return page && page.kind === 'database' ? page : null;
  }

  target(page: PageRow): BriefTarget {
    if (page.kind === 'database') return 'base';
    return page.parent_type === 'database' ? 'ligne' : 'page';
  }

  private userName(id: string): string | null {
    if (!this.userCache.has(id)) {
      this.userCache.set(id, this.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? null);
    }
    return this.userCache.get(id) ?? null;
  }

  schema(databaseId: string): PropertyDef[] {
    let schema = this.schemaCache.get(databaseId);
    if (!schema) {
      const row = this.db.get<{ properties: string }>('SELECT properties FROM databases WHERE page_id = ?', databaseId);
      // Service account: properties restricted to some roles (D30) are never read (briefs reach every member).
      schema = visibleProperties(this.db, parseJson<PropertyDef[]>(row?.properties, []), null);
      this.schemaCache.set(databaseId, schema);
    }
    return schema;
  }

  private path(id: string): string {
    return ancestorsCrumbs(this.db, id)
      .map((c) => c.title || 'Sans titre')
      .join(' / ');
  }

  private visibleRows(databaseId: string): PageRow[] {
    return this.db.all<PageRow>(
      `SELECT * FROM pages WHERE parent_type = 'database' AND parent_id = ? AND workspace_id = ?
         AND visibility = 'workspace' AND trashed_at IS NULL ORDER BY position, id`,
      databaseId,
      this.workspaceId,
    );
  }

  private countRows(databaseId: string): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pages WHERE parent_type = 'database' AND parent_id = ? AND visibility = 'workspace' AND trashed_at IS NULL`,
        databaseId,
      )?.n ?? 0
    );
  }

  // --- schema helpers ---------------------------------------------------------------------

  private statusInfo(schema: PropertyDef[]): StatusInfo {
    return {
      status: schema.find((p) => p.type === 'status') ?? null,
      doneCheckbox: schema.find((p) => p.type === 'checkbox' && DONE_NAME.test(p.name)) ?? null,
    };
  }

  /** Date property used for period filters and lateness: a due-date-like name first, else the first date. */
  dateProperty(schema: PropertyDef[]): PropertyDef | null {
    const dates = schema.filter((p) => p.type === 'date');
    return dates.find((p) => DUE_NAME.test(p.name)) ?? dates[0] ?? null;
  }

  private group(props: Record<string, PropertyValue>, info: StatusInfo): StatusGroup | null {
    if (info.status) {
      const value = props[info.status.id];
      const option = info.status.options?.find((o) => o.id === value);
      return option?.group ?? 'todo';
    }
    if (info.doneCheckbox) return props[info.doneCheckbox.id] === true ? 'done' : 'todo';
    return null;
  }

  private dateRange(props: Record<string, PropertyValue>, prop: PropertyDef | null): { start: string; end: string } | null {
    if (!prop) return null;
    const v = props[prop.id] as DateValue | null | undefined;
    const start = dayOf(v && typeof v === 'object' && !Array.isArray(v) ? v.start : null);
    if (!start) return null;
    const end = dayOf(v!.end ?? null) ?? start;
    return { start, end: end < start ? start : end };
  }

  private describeProperty(def: PropertyDef): Record<string, unknown> {
    const out: Record<string, unknown> = { nom: def.name, type: def.type };
    if (def.options?.length) {
      out.options = def.options
        .slice(0, MAX_LISTED_OPTIONS)
        .map((o) => (def.type === 'status' ? `${o.name} (${o.group ?? 'todo'})` : o.name));
      if (def.options.length > MAX_LISTED_OPTIONS) out.autresOptions = def.options.length - MAX_LISTED_OPTIONS;
    }
    if (def.type === 'relation' && def.relation?.databaseId) {
      const target = this.database(def.relation.databaseId);
      if (target) out.versBase = { id: target.id, titre: target.title };
    }
    return out;
  }

  /** Readable value of one property (null when empty or not displayable). */
  private renderValue(def: PropertyDef, row: PageRow, props: Record<string, PropertyValue>): string | number | boolean | null {
    const v = props[def.id];
    switch (def.type) {
      case 'title':
        return null;
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        return typeof v === 'string' && v.trim() ? truncate(v.trim(), MAX_TEXT_VALUE) : null;
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      case 'checkbox':
        return v === true;
      case 'select':
      case 'status': {
        const option = def.options?.find((o) => o.id === v);
        return option ? option.name : null;
      }
      case 'multi_select': {
        if (!Array.isArray(v)) return null;
        const names = v.map((id) => def.options?.find((o) => o.id === id)?.name).filter((n): n is string => !!n);
        return names.length ? names.join(', ') : null;
      }
      case 'date': {
        const d = v as DateValue | null | undefined;
        if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.start !== 'string') return null;
        const fmt = (s: string) => (d.includeTime ? s.slice(0, 16).replace('T', ' ') : s.slice(0, 10));
        return d.end ? `${fmt(d.start)} → ${fmt(d.end)}` : fmt(d.start);
      }
      case 'person': {
        if (!Array.isArray(v)) return null;
        const names = v.map((id) => (typeof id === 'string' ? this.userName(id) : null)).filter((n): n is string => !!n);
        return names.length ? names.join(', ') : null;
      }
      case 'relation': {
        if (!Array.isArray(v)) return null;
        const titles = v
          .map((id) => this.page(id))
          .filter((p): p is PageRow => !!p)
          .slice(0, 10)
          .map((p) => `${p.title || 'Sans titre'} [${p.id}]`);
        return titles.length ? titles.join(', ') : null;
      }
      case 'files': {
        if (!Array.isArray(v)) return null;
        const names = (v as FileValue[]).map((f) => (f && typeof f === 'object' ? f.name : null)).filter((n): n is string => !!n);
        return names.length ? names.join(', ') : null;
      }
      case 'unique_id':
        return typeof v === 'number' ? (def.uniqueIdPrefix ? `${def.uniqueIdPrefix}-${v}` : v) : null;
      case 'created_time':
        return isoDay(row.created_at);
      case 'last_edited_time':
        return isoDay(row.updated_at);
      case 'created_by':
        return this.userName(row.created_by);
      case 'last_edited_by':
        return this.userName(row.updated_by);
      case 'formula':
        return null; // computed client-side only
      default: {
        // Property types added later (e.g. rollups): show plain stored values only.
        if (typeof v === 'string') return v.trim() ? truncate(v, MAX_TEXT_VALUE) : null;
        if (typeof v === 'number' || typeof v === 'boolean') return v;
        return null;
      }
    }
  }

  private rowProps(row: PageRow, schema: PropertyDef[]): Record<string, string | number | boolean> {
    const props = parseJson<Record<string, PropertyValue>>(row.properties, {});
    const out: Record<string, string | number | boolean> = {};
    let count = 0;
    for (const def of schema) {
      const value = this.renderValue(def, row, props);
      if (value === null || value === false) continue;
      if (++count > MAX_ROW_PROPERTIES) break;
      out[def.name || def.id] = value;
    }
    return out;
  }

  // --- tools --------------------------------------------------------------------------------

  /** `lister_sources` */
  listSources(sourceIds: string[]): Record<string, unknown> {
    const sources: Record<string, unknown>[] = [];
    let unavailable = 0;
    for (const id of sourceIds) {
      const dbPage = this.database(id);
      if (!dbPage) {
        unavailable++;
        continue;
      }
      const schema = this.schema(dbPage.id);
      const info = this.statusInfo(schema);
      const dateProp = this.dateProperty(schema);
      const rows = this.visibleRows(dbPage.id);
      let open = 0;
      let late = 0;
      for (const row of rows) {
        const props = parseJson<Record<string, PropertyValue>>(row.properties, {});
        const group = this.group(props, info);
        if (group === 'done') continue;
        open++;
        const range = this.dateRange(props, dateProp);
        if (range && range.end < this.today) late++;
      }
      // Databases nested in the rows' pages (typically one retro-planning per project).
      const plannings = this.db
        .all<PageRow & { parent_title: string }>(
          `SELECT d.*, r.title AS parent_title FROM pages d JOIN pages r ON r.id = d.parent_id
           WHERE d.kind = 'database' AND d.parent_type = 'page' AND r.parent_type = 'database' AND r.parent_id = ?
             AND d.workspace_id = ? AND d.visibility = 'workspace' AND d.trashed_at IS NULL AND r.trashed_at IS NULL
           ORDER BY r.position, d.position LIMIT ?`,
          dbPage.id,
          this.workspaceId,
          MAX_INLINE_PLANNINGS,
        )
        .map((d) => ({ id: d.id, titre: d.title || 'Sans titre', ligne: { id: d.parent_id, titre: d.parent_title || 'Sans titre' }, lignes: this.countRows(d.id) }));
      sources.push({
        id: dbPage.id,
        titre: dbPage.title || 'Sans titre',
        chemin: this.path(dbPage.id) || null,
        lignes: rows.length,
        nonTerminees: info.status || info.doneCheckbox ? open : null,
        enRetard: dateProp && (info.status || info.doneCheckbox) ? late : null,
        proprieteDate: dateProp?.name ?? null,
        proprieteStatut: info.status?.name ?? info.doneCheckbox?.name ?? null,
        proprietes: schema.filter((p) => p.type !== 'title').map((p) => this.describeProperty(p)),
        ...(plannings.length ? { basesDansLesLignes: plannings } : {}),
      });
    }
    return {
      aujourdhui: this.today,
      sources,
      ...(unavailable ? { indisponibles: unavailable } : {}),
      ...(sources.length === 0 ? { remarque: 'Aucune base configurée n’est accessible : utilise `rechercher`.' } : {}),
    };
  }

  /** `interroger_base` */
  queryDatabase(input: { baseId: string; depuis?: string; jusqu_a?: string; statut?: StatusFilter; limite?: number }): Record<string, unknown> | null {
    const dbPage = this.database(input.baseId);
    if (!dbPage) return null;
    const schema = this.schema(dbPage.id);
    const info = this.statusInfo(schema);
    const dateProp = this.dateProperty(schema);
    const limit = Math.min(Math.max(1, input.limite ?? DEFAULT_ROWS), MAX_ROWS);
    const hasPeriod = !!(input.depuis || input.jusqu_a);
    const notes: string[] = [];
    if (hasPeriod && !dateProp) notes.push('Cette base n’a pas de propriété date : filtre de période ignoré.');
    if (input.statut && !info.status && !info.doneCheckbox) notes.push('Cette base n’a pas de statut : filtre de statut ignoré.');

    const matches: Array<{ row: PageRow; group: StatusGroup | null; range: { start: string; end: string } | null }> = [];
    for (const row of this.visibleRows(dbPage.id)) {
      const props = parseJson<Record<string, PropertyValue>>(row.properties, {});
      const group = this.group(props, info);
      const range = this.dateRange(props, dateProp);
      if (input.statut && group !== null) {
        if (input.statut === 'non_termine' ? group === 'done' : group !== input.statut) continue;
      }
      if (hasPeriod && dateProp) {
        if (!range) continue;
        if (input.depuis && range.end < input.depuis) continue;
        if (input.jusqu_a && range.start > input.jusqu_a) continue;
      }
      matches.push({ row, group, range });
    }
    matches.sort((a, b) => {
      if (a.range && b.range) return a.range.end < b.range.end ? -1 : a.range.end > b.range.end ? 1 : 0;
      return a.range ? -1 : b.range ? 1 : 0;
    });
    // Rows are added until the limit or the size budget is reached (a database may hold long values).
    const lignes: Record<string, unknown>[] = [];
    let chars = 0;
    for (const { row, group, range } of matches) {
      if (lignes.length >= limit) break;
      const ligne = {
        id: row.id,
        titre: truncate(row.title || 'Sans titre', MAX_TITLE),
        ...(group ? { groupe: group } : {}),
        ...(range && group !== 'done' && range.end < this.today ? { enRetard: true } : {}),
        props: this.rowProps(row, schema),
      };
      chars += JSON.stringify(ligne).length;
      if (chars > MAX_ROWS_CHARS && lignes.length > 0) break;
      lignes.push(ligne);
    }
    return {
      base: { id: dbPage.id, titre: dbPage.title || 'Sans titre' },
      proprieteDate: dateProp?.name ?? null,
      proprieteStatut: info.status?.name ?? info.doneCheckbox?.name ?? null,
      total: matches.length,
      ...(matches.length > lignes.length ? { tronque: `${lignes.length} premières lignes sur ${matches.length} (triées par date)` } : {}),
      ...(notes.length ? { remarques: notes } : {}),
      lignes,
    };
  }

  /** `lire_page` */
  readPage(input: { pageId: string; maxCaracteres?: number }): Record<string, unknown> | null {
    const page = this.page(input.pageId);
    if (!page) return null;
    const max = Math.min(Math.max(200, input.maxCaracteres ?? DEFAULT_PAGE_CHARS), MAX_PAGE_CHARS);
    const out: Record<string, unknown> = {
      id: page.id,
      titre: page.title || 'Sans titre',
      type: this.target(page),
      chemin: this.path(page.id) || null,
      modifieLe: isoDay(page.updated_at),
    };
    if (page.parent_type === 'database') {
      const parent = this.database(page.parent_id);
      if (parent) {
        out.base = { id: parent.id, titre: parent.title || 'Sans titre' };
        out.props = this.rowProps(page, this.schema(parent.id));
      }
    }
    if (page.kind === 'database') {
      const schema = this.schema(page.id);
      out.lignes = this.countRows(page.id);
      out.proprietes = schema.filter((p) => p.type !== 'title').map((p) => this.describeProperty(p));
      out.conseil = 'Utilise interroger_base pour lire les lignes de cette base.';
    }
    const own = this.db.get<{ text: string }>('SELECT text FROM documents WHERE page_id = ?', page.id)?.text ?? '';
    const text = [own, this.syncedText(page.id)].filter(Boolean).join('\n\n');
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    if (clean) {
      out.contenu = clean.length > max ? clean.slice(0, max) : clean;
      if (clean.length > max) out.contenuTronque = `${max} caractères sur ${clean.length}`;
    }
    const children = this.db.all<PageRow>(
      `SELECT * FROM pages WHERE parent_type = 'page' AND parent_id = ? AND workspace_id = ?
         AND visibility = 'workspace' AND trashed_at IS NULL ORDER BY position LIMIT ?`,
      page.id,
      this.workspaceId,
      MAX_CHILDREN,
    );
    const subPages = children.filter((c) => c.kind === 'page').map((c) => ({ id: c.id, titre: truncate(c.title || 'Sans titre', MAX_TITLE) }));
    const databases = children
      .filter((c) => c.kind === 'database')
      .map((c) => ({ id: c.id, titre: truncate(c.title || 'Sans titre', MAX_TITLE), enLigne: c.is_inline === 1, lignes: this.countRows(c.id) }));
    if (subPages.length) out.sousPages = subPages;
    if (databases.length) out.bases = databases;
    return out;
  }

  /**
   * Text of the synced blocks a page shows (editor module): blocks of this workspace only, whose
   * owner page the agent may see (shared, not trashed) — never a private page's content.
   */
  private syncedText(pageId: string): string {
    const rows = this.db.all<{ owner_page_id: string; text: string }>(
      `SELECT s.owner_page_id, s.text FROM editor_synced_refs r JOIN editor_synced_blocks s ON s.id = r.synced_id
       WHERE r.page_id = ? AND s.workspace_id = ? ORDER BY s.created_at, s.id LIMIT 20`,
      pageId,
      this.workspaceId,
    );
    return rows
      .filter((r) => r.text.trim() && this.page(r.owner_page_id))
      .map((r) => `[Bloc synchronisé]\n${r.text.trim()}`)
      .join('\n\n');
  }

  /** `rechercher` */
  search(query: string): Record<string, unknown> {
    const results = searchPages(this.db, SERVICE_ACCOUNT_ID, this.workspaceId, query, 15)
      .filter((r) => r.page.visibility === 'workspace' && this.page(r.page.id))
      .map((r) => {
        const page = this.page(r.page.id)!;
        return {
          id: r.page.id,
          titre: r.page.title || 'Sans titre',
          type: this.target(page),
          chemin: r.path.map((c) => c.title || 'Sans titre').join(' / ') || null,
          ...(r.snippet ? { extrait: r.snippet.replace(/\[\[|\]\]/g, '') } : {}),
        };
      });
    return { requete: query, resultats: results };
  }
}
