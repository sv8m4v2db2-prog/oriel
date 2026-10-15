// Workspace export (client-side): every visible page as Markdown, every database as CSV + a folder
// of row pages, uploaded files under fichiers/, a read-me and a manifest. The archive is zipped
// incrementally (fflate streaming) and accumulated as Blob parts to keep memory reasonable.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import {
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  sortByPosition,
  type DatabaseSchema,
  type ExportManifest,
  type ExportManifestEntry,
  type Page,
  type PublicUser,
  type TreeNode,
  type View,
} from '@oriel/shared';
import { api } from '../lib/api';
import { ancestorsOf, buildTreeIndex, childrenOf, rootNodes } from '../lib/tree';
import { contentApi, fetchBytes } from './contentApi';
import { syncedIdsInUpdate, updateToBlocks, updateToMarkdown, type Blk, type ExportContext } from './blocks';
import { syncedApi } from '../editor/syncedApi';
import { formatCell, toCsv, type CellContext } from './csv';
import { errorText } from './importTypes';
import { relativeHref } from './markdown';
import { base64ToBytes, Cancelled, pool, safeName, throwIfAborted } from './text';

export interface ExportProgress {
  phase: 'scan' | 'pages' | 'files' | 'finish';
  done: number;
  total: number;
  label: string;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  counts: { pages: number; databases: number; rows: number; files: number };
  errors: string[];
  warnings: string[];
}

export interface ExportOptions {
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  format: 'zip' | 'json';
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}

interface DbData {
  schema: DatabaseSchema;
  views: View[];
  rows: Page[];
  users: PublicUser[];
}

interface Item {
  id: string;
  kind: 'page' | 'database' | 'row';
  title: string;
  icon: string | null;
  /** .md (pages, rows) or .csv (databases) path in the archive. */
  path: string;
  node?: TreeNode;
  row?: Page;
  db?: DbData;
  /** Rows: their database. */
  parentDb?: Item;
  children: Item[];
}

const FILES_DIR = 'fichiers';
const RESERVED_ROOT = new Set(['fichiers', 'lisezmoi', 'oriel']);
const STORED = /\.(png|jpe?g|gif|webp|avif|heic|mp4|mov|webm|m4v|mp3|m4a|ogg|zip|gz|7z|rar|pdf|docx|xlsx|pptx)$/i;
const MAX_MESSAGES = 300;

const today = () => new Date().toISOString().slice(0, 10);

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export const saveBlob = download;

/** Streaming zip writer collecting its output as Blob parts. */
class ZipSink {
  private readonly zip: Zip;
  private parts: BlobPart[] = [];
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private error: Error | null = null;
  private finished!: () => void;
  readonly done = new Promise<void>((resolve) => (this.finished = resolve));

  constructor() {
    this.zip = new Zip((err, data, final) => {
      if (err) {
        this.error = err;
        this.finished();
        return;
      }
      this.pending.push(data);
      this.pendingSize += data.length;
      if (this.pendingSize > 8 * 1024 * 1024 || final) this.flush();
      if (final) this.finished();
    });
  }

  private flush() {
    if (this.pending.length === 0) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingSize = 0;
  }

  add(path: string, data: Uint8Array) {
    if (this.error) throw this.error;
    const file = STORED.test(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    this.zip.add(file);
    file.push(data, true);
  }

  async finish(): Promise<Blob> {
    this.zip.end();
    await this.done;
    if (this.error) throw this.error;
    return new Blob(this.parts, { type: 'application/zip' });
  }

  abort() {
    this.zip.terminate();
  }
}

export async function exportWorkspace(opts: ExportOptions): Promise<ExportResult> {
  const { workspaceId: wid, signal } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (m: string) => void (errors.length < MAX_MESSAGES && errors.push(m));
  const warn = (m: string) => void (warnings.length < MAX_MESSAGES && warnings.push(m));
  const counts = { pages: 0, databases: 0, rows: 0, files: 0 };
  let done = 0;
  let total = 1;
  let phase: ExportProgress['phase'] = 'scan';
  const tick = (label: string, n = 1) => {
    done += n;
    opts.onProgress({ phase, done: Math.min(done, total), total, label });
  };

  // --- 1. what is visible ------------------------------------------------------------------
  opts.onProgress({ phase, done: 0, total: 1, label: 'Lecture de l’arborescence…' });
  const { nodes } = await api.workspaces.tree(wid);
  const index = buildTreeIndex(nodes);
  const databases = new Map<string, DbData>();
  const dbNodes = nodes.filter((n) => n.kind === 'database');
  total = dbNodes.length + 1;
  await pool(
    dbNodes,
    4,
    async (n) => {
      try {
        const [db, rows] = await Promise.all([api.databases.get(n.id), api.databases.rows(n.id)]);
        databases.set(n.id, { schema: db.schema, views: db.views, rows: sortByPosition(rows.rows), users: rows.users });
      } catch (e) {
        fail(`Base « ${n.title} » illisible : ${errorText(e)}`);
      }
      tick(n.title);
    },
    signal,
  );
  throwIfAborted(signal);

  // --- 2. archive layout -------------------------------------------------------------------
  const byId = new Map<string, Item>();
  const usedNames = new Map<string, Set<string>>();
  const uniqueStem = (dir: string, title: string): string => {
    const used = usedNames.get(dir) ?? new Set<string>();
    usedNames.set(dir, used);
    const base = safeName(title);
    let stem = base;
    for (let i = 2; used.has(stem.toLowerCase()) || (dir === '' && RESERVED_ROOT.has(stem.toLowerCase())); i++) stem = `${base} (${i})`;
    used.add(stem.toLowerCase());
    return stem;
  };
  const place = (n: TreeNode | Page, kind: Item['kind'], dir: string): Item => {
    const stem = uniqueStem(dir, n.title);
    const folder = dir ? `${dir}/${stem}` : stem;
    const item: Item = { id: n.id, kind, title: n.title, icon: n.icon, path: `${folder}.${kind === 'database' ? 'csv' : 'md'}`, children: [] };
    byId.set(n.id, item);
    if (kind === 'database') {
      item.node = n as TreeNode;
      item.db = databases.get(n.id);
      item.children = (item.db?.rows ?? []).map((r) => place(r, 'row', folder));
      for (const r of item.children) {
        r.parentDb = item;
        r.children = childrenOf(index, r.id).map((c) => placeNode(c, r.path.replace(/\.md$/, '')));
      }
    } else if (kind === 'row') {
      item.row = n as Page;
    } else {
      item.node = n as TreeNode;
      item.children = childrenOf(index, n.id).map((c) => placeNode(c, folder));
    }
    return item;
  };
  const placeNode = (n: TreeNode, dir: string) => place(n, n.kind === 'database' ? 'database' : 'page', dir);
  const roots = [...rootNodes(index, wid, 'workspace'), ...rootNodes(index, wid, 'private')].map((n) => placeNode(n, ''));

  const all: Item[] = [];
  const walk = (items: Item[]) => items.forEach((i) => (all.push(i), walk(i.children)));
  walk(roots);
  const documents = all.filter((i) => i.kind !== 'database');
  total = dbNodes.length + 1 + documents.length + all.filter((i) => i.kind === 'database').length;

  // --- 3. files referenced by the content --------------------------------------------------
  const files = new Map<string, string>();
  const usedFileNames = new Set<string>();
  const fileZipPath = (url: string): string | null => {
    const m = /^\/api\/files\/([^/]+)\/([^/?#]+)/.exec(url);
    if (!m) return null;
    let path = files.get(url);
    if (!path) {
      let name = m[2]!;
      try {
        name = decodeURIComponent(name);
      } catch {
        /* keep */
      }
      const dot = name.lastIndexOf('.');
      const stem = safeName(dot > 0 ? name.slice(0, dot) : name, 'fichier');
      const ext = dot > 0 ? name.slice(dot).replace(/[^.\w-]/g, '') : '';
      let candidate = `${stem}${ext}`;
      for (let i = 2; usedFileNames.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
      usedFileNames.add(candidate.toLowerCase());
      path = `${FILES_DIR}/${candidate}`;
      files.set(url, path);
    }
    return path;
  };
  const appLink = (id: string) => `${location.origin}/w/${wid}/p/${id}`;

  // Synced blocks shown by the pages (editor module): fetched once each, through a page showing
  // them, so the server checks the workspace and the owner page's access; their content is written
  // inline. A block refused through one page may still be readable through another.
  const synced = new Map<string, Blk[] | null>();
  const syncedStates: Record<string, string> = {};
  const loadSynced = async (pageId: string, bytes: Uint8Array, asBlocks: boolean) => {
    for (const sid of syncedIdsInUpdate(bytes)) {
      if (synced.get(sid) || syncedStates[sid]) continue;
      throwIfAborted(signal);
      try {
        const { update } = await syncedApi.content(pageId, sid);
        syncedStates[sid] = update;
        synced.set(sid, asBlocks ? updateToBlocks(base64ToBytes(update)) : null);
      } catch {
        if (!synced.has(sid)) synced.set(sid, null);
      }
    }
  };
  const contextFor = (from: Item): ExportContext => ({
    pageLink: (id) => {
      const target = byId.get(id);
      return target ? { href: relativeHref(from.path, target.path), title: target.title || 'Sans titre' } : null;
    },
    appLink,
    fileHref: (url) => {
      const p = fileZipPath(url);
      return p ? relativeHref(from.path, p) : url;
    },
    syncedBlocks: (id) => synced.get(id) ?? null,
    breadcrumb: () => {
      // Rows: the path of their database, then the row.
      const start = from.kind === 'row' && from.parentDb ? from.parentDb : from;
      const path = [...ancestorsOf(index, start.id).map((n) => n.title), ...(start === from ? [] : [start.title]), from.title];
      return path.map((t) => t || 'Sans titre').join(' / ');
    },
  });

  // --- JSON backup -----------------------------------------------------------------------------
  if (opts.format === 'json') {
    phase = 'pages';
    const docs: Record<string, string> = {};
    await pool(
      documents,
      4,
      async (item) => {
        try {
          docs[item.id] = (await contentApi.get(item.id, signal)).update;
          await loadSynced(item.id, base64ToBytes(docs[item.id]!), false);
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw new Cancelled();
          fail(`Contenu de « ${item.title} » illisible : ${errorText(e)}`);
        }
        tick(item.title);
      },
      signal,
    );
    throwIfAborted(signal);
    const backup = {
      format: 'oriel-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { id: wid, name: opts.workspaceName, icon: opts.workspaceIcon },
      tree: nodes,
      databases: [...databases.entries()].map(([id, d]) => ({ id, schema: d.schema, views: d.views, rows: d.rows })),
      documents: docs,
      /** Yjs states of the synced blocks shown by the documents (editor module), by synced block id. */
      synced: syncedStates,
    };
    for (const i of all) counts[i.kind === 'database' ? 'databases' : i.kind === 'row' ? 'rows' : 'pages']++;
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
    return { blob, filename: `${safeName(`Oriel - ${opts.workspaceName} - sauvegarde - ${today()}`)}.json`, counts, errors, warnings };
  }

  // --- 4. zip ----------------------------------------------------------------------------------
  const sink = new ZipSink();
  const onAbort = () => sink.abort();
  signal.addEventListener('abort', onAbort);
  try {
    phase = 'pages';
    const dropped = new Set<string>();
    const cellContext = (item: Item, db: DbData, row: Page): CellContext => {
      const users = new Map(db.users.map((u) => [u.id, u.name]));
      return {
        userName: (id) => users.get(id),
        relationTitle: (id) => byId.get(id)?.title,
        fileHref: (url) => {
          const p = fileZipPath(url);
          return p ? relativeHref(item.path, p) : url;
        },
        row: { title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt, createdBy: row.createdBy, updatedBy: row.updatedBy },
      };
    };

    await pool(
      documents,
      4,
      async (item) => {
        let body = '';
        try {
          const { update } = await contentApi.get(item.id, signal);
          const bytes = base64ToBytes(update);
          await loadSynced(item.id, bytes, true);
          const res = updateToMarkdown(bytes, contextFor(item), dropped);
          body = res.markdown;
          if (res.degraded) warn(`« ${item.title} » : contenu exporté en texte brut.`);
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw new Cancelled();
          fail(`Contenu de « ${item.title} » non exporté : ${errorText(e)}`);
        }
        let header = `# ${item.title || 'Sans titre'}\n\n`;
        if (item.kind === 'row' && item.row) {
          const db = item.parentDb?.db;
          if (db) {
            const ctx = cellContext(item, db, item.row);
            const lines = db.schema.properties
              .filter((p) => p.type !== 'title' && p.type !== 'formula')
              .map((p) => [p.name, formatCell(p, item.row!.properties[p.id], ctx)] as const)
              .filter(([, v]) => v !== '' && v !== 'Non')
              .map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`);
            if (lines.length) header += `${lines.join('\n')}\n\n`;
          }
          counts.rows++;
        } else counts.pages++;
        sink.add(item.path, strToU8(`${header}${body}\n`));
        tick(item.title);
      },
      signal,
    );
    throwIfAborted(signal);
    if (dropped.size) warn(`Blocs sans équivalent Markdown omis : ${[...dropped].join(', ')}.`);

    for (const item of all.filter((i) => i.kind === 'database')) {
      const db = item.db;
      if (!db) continue;
      const props = db.schema.properties;
      const rows = [props.map((p) => p.name)];
      item.children.forEach((child) => {
        if (child.row) rows.push(props.map((p) => formatCell(p, child.row!.properties[p.id], cellContext(item, db, child.row!))));
      });
      sink.add(item.path, strToU8(toCsv(rows)));
      counts.databases++;
      tick(item.title);
    }

    // --- files
    phase = 'files';
    const fileList = [...files.entries()];
    total += fileList.length;
    await pool(
      fileList,
      3,
      async ([url, path]) => {
        try {
          sink.add(path, await fetchBytes(url, signal));
          counts.files++;
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw new Cancelled();
          fail(`Fichier « ${path.slice(FILES_DIR.length + 1)} » non téléchargé : ${errorText(e)}`);
        }
        tick(path.slice(FILES_DIR.length + 1));
      },
      signal,
    );
    throwIfAborted(signal);

    // --- manifest + read-me
    phase = 'finish';
    const entries: ExportManifestEntry[] = all.map((i) => {
      const e: ExportManifestEntry = { path: i.path, id: i.id, kind: i.kind === 'database' ? 'database' : 'page', role: i.kind, title: i.title, icon: i.icon };
      if (i.node && i.node.parentType === 'workspace') e.visibility = i.node.visibility;
      if (i.kind === 'database') {
        e.isInline = !!i.node?.isInline;
        if (i.db) {
          e.properties = i.db.schema.properties;
          e.views = i.db.views.map((v) => ({ name: v.name, type: v.type, config: v.config }));
        }
      }
      return e;
    });
    const manifest: ExportManifest = {
      format: EXPORT_MANIFEST_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { name: opts.workspaceName, icon: opts.workspaceIcon },
      entries,
    };
    sink.add(EXPORT_MANIFEST_FILE, strToU8(JSON.stringify(manifest, null, 1)));
    sink.add('LISEZMOI.txt', strToU8(readme(opts.workspaceName, counts)));
    const blob = await sink.finish();
    tick('Archive prête');
    return { blob, filename: `${safeName(`Oriel - ${opts.workspaceName} - ${today()}`)}.zip`, counts, errors, warnings };
  } catch (e) {
    sink.abort();
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function readme(name: string, counts: ExportResult['counts']): string {
  return [
    `Export de l’espace « ${name} » — Oriel`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
    '',
    `Contenu : ${counts.pages} page(s), ${counts.databases} base(s) de données, ${counts.rows} ligne(s), ${counts.files} fichier(s).`,
    '',
    'Organisation',
    '- Chaque page est un fichier Markdown (.md) commençant par « # Titre » ; ses sous-pages',
    '  et bases de données sont dans le dossier qui porte le même nom.',
    '- Chaque base de données est un fichier CSV (.csv, UTF-8) avec toutes ses propriétés ;',
    '  ses lignes sont des pages Markdown rangées dans le dossier du même nom (les valeurs des',
    '  propriétés figurent sous le titre, une par ligne : « Propriété: valeur »).',
    '- Les fichiers envoyés dans les pages sont dans le dossier « fichiers » ; les liens entre',
    '  pages et vers les fichiers sont relatifs et fonctionnent hors ligne.',
    `- ${EXPORT_MANIFEST_FILE} décrit l’arborescence (icônes, sections, types de propriétés, vues) :`,
    '  réimportez l’archive dans Oriel (Réglages › Import / export) pour tout retrouver.',
    '',
    'Limites',
    '- Les formules ne sont pas évaluées dans les CSV ; les relations sont exportées par titre.',
    '- Les blocs sans équivalent Markdown sont simplifiés : légende → citation « > emoji texte »,',
    '  colonnes mises à plat, table des matières omise, sections dépliables en <details>.',
    '',
  ].join('\n');
}
