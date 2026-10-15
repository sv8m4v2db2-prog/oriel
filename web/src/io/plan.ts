// Import planning (DOM-free): turns the dropped files into a tree of pages, databases and rows.
//
// Accepted layout (export format of the previous notes tool, Oriel exports, plain folders):
//   Page <32-hex id>.md            a page (first line "# Title")
//   Page <32-hex id>/              its sub-pages, databases and attachments
//   Base <id>.csv | Base <id>_all.csv   a database (the _all variant wins: it has every row)
//   Base <id>/Row <id>.md          row pages ("# Title", then "Property: value" lines, then content)
// Ids are optional; folders without a page file become pages; nested zips are already mounted.
import {
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  type ExportManifest,
  type ExportManifestEntry,
  type Visibility,
} from '@oriel/shared';
import type { Blk } from './blocks';
import { parseCsv, type ColumnHint } from './csv';
import { extractPropertyHeader, extractTitle, findLinks, resolveHref } from './markdown';
import { decodeText, looseKey, naturalCompare } from './text';
import { basename, extname, joinPath, type Vfs } from './vfs';

export interface PlanPage {
  kind: 'page';
  uid: string;
  title: string;
  icon: string | null;
  mdPath: string | null;
  dirPath: string | null;
  sourceId: string | null;
  children: PlanNode[];
  meta?: ExportManifestEntry;
  /** Pre-built content (file importers): blocks whose links/images are paths of the virtual file system. */
  blocks?: Blk[];
}

export interface PlanRow {
  kind: 'row';
  uid: string;
  title: string;
  icon: string | null;
  mdPath: string | null;
  dirPath: string | null;
  /** Raw CSV cells, aligned with the database headers. */
  cells: string[];
  children: PlanNode[];
  meta?: ExportManifestEntry;
  /** Pre-built content (file importers), see PlanPage.blocks. */
  blocks?: Blk[];
}

export interface PlanDatabase {
  kind: 'database';
  uid: string;
  title: string;
  icon: string | null;
  csvPath: string | null;
  dirPath: string | null;
  sourceId: string | null;
  headers: string[];
  titleIndex: number;
  rows: PlanRow[];
  /** Linked on its own line from the parent page: shown inline in the parent's content. */
  inline: boolean;
  meta?: ExportManifestEntry;
  /** File importers: column type chosen before the import (by column index), see applyColumnHint. */
  columnHints?: Record<number, ColumnHint>;
  /** File importers: left out of the import by the user (preview). */
  excluded?: boolean;
  /** File importers: notes shown in the preview (e.g. formulas without cached value). */
  notes?: string[];
}

export type PlanNode = PlanPage | PlanDatabase;
/** Formats read by the file importers (web/src/io/importers). */
export type ImporterFormat = 'docx' | 'gdocs-html' | 'xlsx' | 'confluence' | 'evernote' | 'trello' | 'asana';
export type PlanItem = PlanPage | PlanDatabase | PlanRow;

export interface ImportPlan {
  roots: PlanNode[];
  format: 'oriel' | 'notion' | 'markdown' | ImporterFormat;
  manifest: ExportManifest | null;
  rootPath: string;
  counts: { pages: number; databases: number; rows: number; attachments: number };
  warnings: string[];
  items: Map<string, PlanItem>;
  parentOf: Map<string, string | null>;
  /** looseKey(path of a .md / .csv) → item uid. */
  pathIndex: Map<string, string>;
  /** Attachment paths (anything that is not a page, a database or the manifest). */
  attachments: string[];
  /** Folder path → uid of the page/row owning it (attachments living there belong to it). */
  dirOwner: Map<string, string>;
  /** Visibility of top-level items from an Oriel manifest. */
  rootVisibility: Map<string, Visibility>;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const ID_SUFFIX = /^(.*?)[\s_-]*([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface ParsedName {
  title: string;
  id: string | null;
  ext: string;
  /** `Name <id>_all.csv` */
  all: boolean;
}

export function parseEntryName(name: string, isDir = false): ParsedName {
  let stem = name;
  let ext = '';
  if (!isDir) {
    ext = extname(name);
    if (ext) stem = name.slice(0, -(ext.length + 1));
  }
  let all = false;
  if (ext === 'csv' && /_all$/i.test(stem)) {
    all = true;
    stem = stem.slice(0, -4);
  }
  const m = ID_SUFFIX.exec(stem);
  let id: string | null = null;
  if (m) {
    id = m[2]!.replace(/-/g, '').toLowerCase();
    stem = m[1]!;
  }
  const title = stem.replace(/\s+/g, ' ').trim();
  return { title, id, ext, all };
}

const isMarkdown = (p: string) => ['md', 'markdown'].includes(extname(p));
const isCsv = (p: string) => extname(p) === 'csv';

// ---------------------------------------------------------------------------
// Directory tree
// ---------------------------------------------------------------------------

interface Dir {
  path: string;
  name: string;
  dirs: Map<string, Dir>;
  files: string[];
}

function buildTree(paths: string[]): Dir {
  const root: Dir = { path: '', name: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const segs = p.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { path: cur.path ? `${cur.path}/${seg}` : seg, name: seg, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(p);
  }
  return root;
}

function hasContent(dir: Dir): boolean {
  return dir.files.some((f) => isMarkdown(f) || isCsv(f)) || [...dir.dirs.values()].some(hasContent);
}

function allFiles(dir: Dir, out: string[] = []): string[] {
  out.push(...dir.files);
  for (const d of dir.dirs.values()) allFiles(d, out);
  return out;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

interface MdInfo {
  path: string;
  parsed: ParsedName;
  title: string;
  links: ReturnType<typeof findLinks>;
}

class Planner {
  private seq = 0;
  readonly items = new Map<string, PlanItem>();
  readonly parentOf = new Map<string, string | null>();
  readonly pathIndex = new Map<string, string>();
  readonly attachments: string[] = [];
  readonly dirOwner = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly counts = { pages: 0, databases: 0, rows: 0, attachments: 0 };
  manifestByPath = new Map<string, ExportManifestEntry>();
  sawIds = false;

  constructor(private readonly vfs: Vfs) {}

  private uid(): string {
    return `n${++this.seq}`;
  }

  private register(item: PlanItem, parent: string | null, ...paths: Array<string | null>) {
    this.items.set(item.uid, item);
    this.parentOf.set(item.uid, parent);
    for (const p of paths) if (p) this.pathIndex.set(looseKey(p), item.uid);
    if (item.kind === 'page') this.counts.pages++;
    else if (item.kind === 'database') this.counts.databases++;
    else this.counts.rows++;
  }

  async readText(path: string): Promise<string | null> {
    const f = this.vfs.resolve(path);
    if (!f) return null;
    try {
      return decodeText(await f.read());
    } catch (e) {
      this.warnings.push(`Lecture impossible : ${path} (${(e as Error).message})`);
      return null;
    }
  }

  private async readMd(path: string): Promise<MdInfo & { text: string }> {
    const parsed = parseEntryName(basename(path));
    if (parsed.id) this.sawIds = true;
    const text = (await this.readText(path)) ?? '';
    const { title } = extractTitle(text);
    return { path, parsed, title: title || parsed.title || 'Sans titre', links: findLinks(text), text };
  }

  private addAttachments(paths: string[]) {
    for (const p of paths) {
      if (isMarkdown(p) || isCsv(p)) continue;
      this.attachments.push(p);
      this.counts.attachments++;
    }
  }

  /** Children of a folder. `parentMd` orders them like the parent page links them. */
  async processDir(dir: Dir, parentUid: string | null, parentMd: MdInfo | null): Promise<PlanNode[]> {
    if (parentUid) this.dirOwner.set(dir.path, parentUid);
    const mdPaths = dir.files.filter(isMarkdown);
    const csvPaths = dir.files.filter(isCsv);
    this.addAttachments(dir.files);

    // Databases: one per id/title; the `_all` export wins over the filtered one.
    const dbs = new Map<string, { csvPath: string; others: string[]; parsed: ParsedName }>();
    for (const csvPath of csvPaths.sort(naturalCompare)) {
      const parsed = parseEntryName(basename(csvPath));
      if (parsed.id) this.sawIds = true;
      const key = parsed.id ? `id:${parsed.id}` : `t:${looseKey(parsed.title)}`;
      const existing = dbs.get(key);
      if (!existing) dbs.set(key, { csvPath, others: [], parsed });
      else if (parsed.all && !existing.parsed.all) dbs.set(key, { csvPath, others: [existing.csvPath, ...existing.others], parsed });
      else existing.others.push(csvPath);
    }

    const mds: Array<MdInfo & { text: string }> = [];
    for (const p of mdPaths.sort(naturalCompare)) mds.push(await this.readMd(p));

    // Folders → page / database they belong to.
    const pageFolder = new Map<string, Dir>();
    const dbFolder = new Map<string, Dir>();
    const looseFolders: Dir[] = [];
    const subdirs = [...dir.dirs.values()].sort((a, b) => naturalCompare(a.name, b.name));
    for (const sub of subdirs) {
      const p = parseEntryName(sub.name, true);
      if (p.id) this.sawIds = true;
      const tk = looseKey(p.title);
      // Same id, else same title when at most one side carries an id.
      const fits = (other: ParsedName) =>
        p.id && other.id ? p.id === other.id : looseKey(other.title) === tk;
      const page = mds.find((m) => !pageFolder.has(m.path) && p.id && m.parsed.id === p.id) ?? mds.find((m) => !pageFolder.has(m.path) && fits(m.parsed));
      const db = page
        ? undefined
        : ([...dbs.values()].find((d) => !dbFolder.has(d.csvPath) && p.id && d.parsed.id === p.id) ??
          [...dbs.values()].find((d) => !dbFolder.has(d.csvPath) && fits(d.parsed)));
      if (page) pageFolder.set(page.path, sub);
      else if (db) dbFolder.set(db.csvPath, sub);
      else looseFolders.push(sub);
    }

    const nodes: Array<{ node: PlanNode; sortPath: string }> = [];

    for (const md of mds) {
      const page: PlanPage = {
        kind: 'page',
        uid: this.uid(),
        title: md.title,
        icon: null,
        mdPath: md.path,
        dirPath: pageFolder.get(md.path)?.path ?? null,
        sourceId: md.parsed.id,
        children: [],
        meta: this.manifestByPath.get(md.path),
      };
      if (page.meta) page.icon = page.meta.icon;
      this.register(page, parentUid, md.path);
      const folder = pageFolder.get(md.path);
      if (folder) page.children = await this.processDir(folder, page.uid, md);
      nodes.push({ node: page, sortPath: md.path });
    }

    for (const d of dbs.values()) {
      const db = await this.buildDatabase(d.csvPath, d.others, d.parsed, dbFolder.get(d.csvPath) ?? null, parentUid);
      if (!db) continue;
      if (parentMd && parentUid && this.items.get(parentUid)?.kind === 'page') {
        const targets = [d.csvPath, ...d.others].map(looseKey);
        db.inline = parentMd.links.some((l) => {
          if (!l.alone || l.image) return false;
          const t = resolveHref(l.href, parentMd.path);
          return t.kind === 'path' && targets.includes(looseKey(t.path));
        });
      }
      if (db.meta?.isInline !== undefined) db.inline = db.meta.isInline && !!parentUid;
      nodes.push({ node: db, sortPath: d.csvPath });
    }

    for (const sub of looseFolders) {
      if (!hasContent(sub)) {
        // Attachment folder of a page exported elsewhere (or images only).
        this.addAttachments(allFiles(sub));
        if (parentUid) this.dirOwner.set(sub.path, parentUid);
        continue;
      }
      const p = parseEntryName(sub.name, true);
      const page: PlanPage = {
        kind: 'page',
        uid: this.uid(),
        title: p.title || 'Sans titre',
        icon: null,
        mdPath: null,
        dirPath: sub.path,
        sourceId: p.id,
        children: [],
      };
      this.register(page, parentUid);
      page.children = await this.processDir(sub, page.uid, null);
      nodes.push({ node: page, sortPath: sub.path });
    }

    // Order: as linked from the parent page, then by name.
    const order = new Map<string, number>();
    if (parentMd) {
      parentMd.links.forEach((l, i) => {
        const t = resolveHref(l.href, parentMd.path);
        if (t.kind === 'path' && !order.has(looseKey(t.path))) order.set(looseKey(t.path), i);
      });
    }
    nodes.sort((a, b) => {
      const ia = order.get(looseKey(a.sortPath));
      const ib = order.get(looseKey(b.sortPath));
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1;
      if (ib !== undefined) return 1;
      return naturalCompare(basename(a.sortPath), basename(b.sortPath));
    });
    return nodes.map((n) => n.node);
  }

  private async buildDatabase(
    csvPath: string,
    otherCsv: string[],
    parsed: ParsedName,
    folder: Dir | null,
    parentUid: string | null,
  ): Promise<PlanDatabase | null> {
    const text = await this.readText(csvPath);
    if (text === null) return null;
    let table: string[][];
    try {
      table = parseCsv(text);
    } catch (e) {
      this.warnings.push(`CSV illisible : ${csvPath} (${(e as Error).message})`);
      return null;
    }
    const meta = this.manifestByPath.get(csvPath);
    const headers = (table[0] ?? []).map((h, i) => h.trim() || `Colonne ${i + 1}`);
    if (headers.length === 0) headers.push('Nom');
    const titleName = meta?.properties?.find((p) => p.type === 'title')?.name;
    const titleIndex = Math.max(0, titleName ? headers.findIndex((h) => h === titleName) : 0);
    const db: PlanDatabase = {
      kind: 'database',
      uid: this.uid(),
      title: parsed.title || 'Base sans titre',
      icon: meta?.icon ?? null,
      csvPath,
      dirPath: folder?.path ?? null,
      sourceId: parsed.id,
      headers,
      titleIndex,
      rows: [],
      inline: false,
      meta,
    };
    if (meta?.title) db.title = meta.title;
    this.register(db, parentUid, csvPath, ...otherCsv);

    const headerKeys = new Set(headers.map(looseKey));
    // Row pages of the database folder.
    const rowMds: Array<MdInfo & { text: string; props: Array<[string, string]>; used: boolean }> = [];
    if (folder) {
      for (const p of folder.files.filter(isMarkdown).sort(naturalCompare)) {
        const md = await this.readMd(p);
        const { body } = extractTitle(md.text);
        const { props } = extractPropertyHeader(body, (k) => headerKeys.has(looseKey(k)));
        rowMds.push({ ...md, props, used: false });
      }
    }
    const byTitle = new Map<string, typeof rowMds>();
    for (const md of rowMds) {
      for (const key of new Set([looseKey(md.title), looseKey(md.parsed.title)])) {
        const list = byTitle.get(key) ?? [];
        list.push(md);
        byTitle.set(key, list);
      }
    }
    const takeMd = (title: string) => {
      const list = byTitle.get(looseKey(title));
      const md = list?.find((m) => !m.used);
      if (md) md.used = true;
      return md;
    };

    const rowFolders = new Map<string, Dir>();
    const foldersLeft: Dir[] = [];
    if (folder) {
      for (const sub of folder.dirs.values()) {
        const p = parseEntryName(sub.name, true);
        const md =
          (p.id ? rowMds.find((m) => m.parsed.id === p.id) : undefined) ??
          rowMds.find((m) => looseKey(m.parsed.title) === looseKey(p.title) && !rowFolders.has(m.path));
        if (md && !rowFolders.has(md.path)) rowFolders.set(md.path, sub);
        else foldersLeft.push(sub);
      }
    }

    const makeRow = async (title: string, cells: string[], md: (MdInfo & { text: string }) | undefined): Promise<PlanRow> => {
      const row: PlanRow = {
        kind: 'row',
        uid: this.uid(),
        title: title || md?.title || 'Sans titre',
        icon: null,
        mdPath: md?.path ?? null,
        dirPath: null,
        cells,
        children: [],
        meta: md ? this.manifestByPath.get(md.path) : undefined,
      };
      if (row.meta) row.icon = row.meta.icon;
      this.register(row, db.uid, md?.path ?? null);
      const sub = md ? rowFolders.get(md.path) : undefined;
      if (sub) {
        row.dirPath = sub.path;
        row.children = await this.processDir(sub, row.uid, md ?? null);
      }
      return row;
    };

    for (const record of table.slice(1)) {
      if (record.every((c) => c.trim() === '')) continue;
      const cells = headers.map((_, i) => record[i] ?? '');
      const title = (cells[titleIndex] ?? '').trim();
      db.rows.push(await makeRow(title, cells, takeMd(title)));
    }
    // Row pages missing from the CSV: their header lines give the values.
    for (const md of rowMds.filter((m) => !m.used)) {
      md.used = true;
      const cells = headers.map(() => '');
      for (const [k, v] of md.props) {
        const i = headers.findIndex((h) => looseKey(h) === looseKey(k));
        if (i >= 0) cells[i] = v;
      }
      cells[titleIndex] = md.title;
      db.rows.push(await makeRow(md.title, cells, md));
    }
    for (const sub of foldersLeft) {
      if (!hasContent(sub)) {
        this.addAttachments(allFiles(sub));
        continue;
      }
      const row = await makeRow(parseEntryName(sub.name, true).title, headers.map(() => ''), undefined);
      row.cells[titleIndex] = row.title;
      row.dirPath = sub.path;
      row.children = await this.processDir(sub, row.uid, null);
      db.rows.push(row);
    }
    if (folder) this.dirOwner.set(folder.path, db.uid);
    return db;
  }
}

/** Analyses the virtual file system and returns what an import would create. */
export async function planImport(vfs: Vfs): Promise<ImportPlan> {
  const planner = new Planner(vfs);
  let root = buildTree(vfs.list().map((f) => f.path));
  // Unwrap single top-level folders (zip of a folder, "Export-…" wrappers).
  while (root.files.length === 0 && root.dirs.size === 1) root = [...root.dirs.values()][0]!;

  let manifest: ExportManifest | null = null;
  const manifestPath = joinPath(root.path, EXPORT_MANIFEST_FILE);
  if (root.files.includes(manifestPath)) {
    const text = await planner.readText(manifestPath);
    try {
      const parsed = text ? (JSON.parse(text) as ExportManifest) : null;
      if (parsed && parsed.format === EXPORT_MANIFEST_FORMAT && Array.isArray(parsed.entries)) manifest = parsed;
    } catch {
      planner.warnings.push(`Manifeste ${EXPORT_MANIFEST_FILE} illisible : types de propriétés déduits des valeurs.`);
    }
    root.files = root.files.filter((f) => f !== manifestPath);
  }
  if (manifest) {
    for (const e of manifest.entries) planner.manifestByPath.set(joinPath(root.path, e.path), e);
    // Our own read-me.
    root.files = root.files.filter((f) => !/^(lisezmoi|readme)\.txt$/i.test(basename(f)));
  }

  const roots = await planner.processDir(root, null, null);
  const rootVisibility = new Map<string, Visibility>();
  for (const node of roots) if (node.meta?.visibility) rootVisibility.set(node.uid, node.meta.visibility);

  return {
    roots,
    format: manifest ? 'oriel' : planner.sawIds ? 'notion' : 'markdown',
    manifest,
    rootPath: root.path,
    counts: planner.counts,
    warnings: [...vfs.warnings, ...planner.warnings],
    items: planner.items,
    parentOf: planner.parentOf,
    pathIndex: planner.pathIndex,
    attachments: planner.attachments,
    dirOwner: planner.dirOwner,
    rootVisibility,
  };
}
