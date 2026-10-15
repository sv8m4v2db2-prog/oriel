// Builds an ImportPlan in memory (file importers). Content is given as editor blocks; attachments
// are files of the virtual file system referenced by their (encoded) path.
import type { Blk } from '../blocks';
import type { ColumnHint } from '../csv';
import type { ImporterFormat, ImportPlan, PlanDatabase, PlanItem, PlanNode, PlanPage, PlanRow } from '../plan';
import { looseKey } from '../text';
import { IMPORT_LIMITS, ImportError } from './limits';

let seq = 0;
const nextUid = () => `g8-${++seq}`;

/** Encoded relative reference to a virtual-file path (resolved with an empty document folder). */
export const pathHref = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export class PlanBuilder {
  readonly items = new Map<string, PlanItem>();
  readonly parentOf = new Map<string, string | null>();
  readonly pathIndex = new Map<string, string>();
  readonly attachments: string[] = [];
  readonly dirOwner = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly roots: PlanNode[] = [];
  readonly counts = { pages: 0, databases: 0, rows: 0, attachments: 0 };

  private take(kind: 'pages' | 'databases' | 'rows'): void {
    this.counts[kind]++;
    const total = this.counts.pages + this.counts.databases + this.counts.rows;
    if (total > IMPORT_LIMITS.maxPages) throw new ImportError(`Import refusé : plus de ${IMPORT_LIMITS.maxPages} pages et lignes.`);
  }

  page(o: { title: string; icon?: string | null; blocks?: Blk[]; parent?: PlanPage | PlanRow | null; sourcePath?: string; dirPath?: string }): PlanPage {
    this.take('pages');
    const page: PlanPage = {
      kind: 'page',
      uid: nextUid(),
      title: (o.title || 'Sans titre').trim().slice(0, 2000) || 'Sans titre',
      icon: o.icon ?? null,
      mdPath: null,
      dirPath: o.dirPath ?? null,
      sourceId: null,
      children: [],
      blocks: o.blocks,
    };
    this.items.set(page.uid, page);
    this.parentOf.set(page.uid, o.parent?.uid ?? null);
    if (o.sourcePath) this.pathIndex.set(looseKey(o.sourcePath), page.uid);
    if (o.dirPath) this.dirOwner.set(o.dirPath, page.uid);
    if (o.parent) o.parent.children.push(page);
    else this.roots.push(page);
    return page;
  }

  database(o: {
    title: string;
    icon?: string | null;
    headers: string[];
    titleIndex?: number;
    parent?: PlanPage | PlanRow | null;
    columnHints?: Record<number, ColumnHint>;
    notes?: string[];
  }): PlanDatabase {
    this.take('databases');
    const db: PlanDatabase = {
      kind: 'database',
      uid: nextUid(),
      title: (o.title || 'Sans titre').trim().slice(0, 2000) || 'Sans titre',
      icon: o.icon ?? null,
      csvPath: null,
      dirPath: null,
      sourceId: null,
      headers: o.headers.slice(0, IMPORT_LIMITS.maxColumns),
      titleIndex: o.titleIndex ?? 0,
      rows: [],
      inline: false,
      columnHints: o.columnHints,
      notes: o.notes,
    };
    this.items.set(db.uid, db);
    this.parentOf.set(db.uid, o.parent?.uid ?? null);
    if (o.parent) o.parent.children.push(db);
    else this.roots.push(db);
    return db;
  }

  row(db: PlanDatabase, o: { title: string; cells: string[]; blocks?: Blk[]; icon?: string | null }): PlanRow {
    this.take('rows');
    const row: PlanRow = {
      kind: 'row',
      uid: nextUid(),
      title: (o.title || 'Sans titre').trim().slice(0, 2000) || 'Sans titre',
      icon: o.icon ?? null,
      mdPath: null,
      dirPath: null,
      cells: o.cells.slice(0, IMPORT_LIMITS.maxColumns).map((c) => c.slice(0, IMPORT_LIMITS.maxCellChars)),
      children: [],
      blocks: o.blocks,
    };
    this.items.set(row.uid, row);
    this.parentOf.set(row.uid, db.uid);
    db.rows.push(row);
    return row;
  }

  attach(path: string): void {
    this.attachments.push(path);
    this.counts.attachments++;
  }

  build(format: ImporterFormat, extraWarnings: string[] = []): ImportPlan {
    return {
      roots: this.roots,
      format,
      manifest: null,
      rootPath: '',
      counts: this.counts,
      warnings: [...extraWarnings, ...this.warnings],
      items: this.items,
      parentOf: this.parentOf,
      pathIndex: this.pathIndex,
      attachments: this.attachments,
      dirOwner: this.dirOwner,
      rootVisibility: new Map(),
    };
  }
}

/** Union of plans (their uids are globally unique). */
/**
 * Plans merged into one. QA-G8-03: the page limit applies to the whole import (each file has its own
 * builder, so 100 workbooks of 50 000 rows passed); `maxPages` = Infinity for the legacy Markdown part.
 */
export function mergePlans(plans: ImportPlan[], maxPages: number = IMPORT_LIMITS.maxPages): ImportPlan {
  const [first, ...rest] = plans;
  if (!first) throw new ImportError('Aucun contenu à importer.');
  const out: ImportPlan = { ...first, roots: [...first.roots], warnings: [...first.warnings], items: new Map(first.items), parentOf: new Map(first.parentOf), pathIndex: new Map(first.pathIndex), attachments: [...first.attachments], dirOwner: new Map(first.dirOwner), rootVisibility: new Map(first.rootVisibility), counts: { ...first.counts } };
  for (const p of rest) {
    out.roots.push(...p.roots);
    out.warnings.push(...p.warnings);
    p.items.forEach((v, k) => out.items.set(k, v));
    p.parentOf.forEach((v, k) => out.parentOf.set(k, v));
    p.pathIndex.forEach((v, k) => out.pathIndex.set(k, v));
    out.attachments.push(...p.attachments);
    p.dirOwner.forEach((v, k) => out.dirOwner.set(k, v));
    p.rootVisibility.forEach((v, k) => out.rootVisibility.set(k, v));
    out.counts.pages += p.counts.pages;
    out.counts.databases += p.counts.databases;
    out.counts.rows += p.counts.rows;
    out.counts.attachments += p.counts.attachments;
  }
  if (out.counts.pages + out.counts.databases + out.counts.rows > maxPages) {
    throw new ImportError(`Import refusé : plus de ${maxPages} pages et lignes au total.`);
  }
  return out;
}

/** Counts of an plan after the user excluded some databases (preview). */
export function activePlan(plan: ImportPlan): ImportPlan {
  const roots = plan.roots.filter((n) => !(n.kind === 'database' && n.excluded));
  if (roots.length === plan.roots.length) return plan;
  const counts = { pages: 0, databases: 0, rows: 0, attachments: plan.counts.attachments };
  const walk = (n: PlanNode) => {
    if (n.kind === 'database') {
      counts.databases++;
      counts.rows += n.rows.length;
    } else {
      counts.pages++;
      n.children.forEach(walk);
    }
  };
  roots.forEach(walk);
  return { ...plan, roots, counts };
}
