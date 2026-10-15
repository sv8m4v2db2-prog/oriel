// Runs an import plan against the API in passes: (1) create every page, database and row so that
// all ids are known, (2) convert each Markdown file to blocks (links rewritten to Oriel pages,
// attachments uploaded) and write it through the page content API, (3) attach unreferenced files.
import { PAGE_CONTENT_MAX_BYTES, newId, type UploadedFile, type Visibility } from '@oriel/shared';
import { api } from '../lib/api';
import { contentApi } from './contentApi';
import { blocksToUpdate, markdownToBlocks, resolveBlocks, type Blk, type ResolvedLink } from './blocks';
import type { MemberRef } from './csv';
import { importDatabase, type DbImportEnv, type ParentRef } from './importDatabase';
import { errorText, fileBlockType, findDuplicates, mimeOf, type ImportOptions, type ImportProgress, type ImportReport } from './importTypes';
import { extractPropertyHeader, extractTitle, resolveHref } from './markdown';
import type { ImportPlan, PlanDatabase, PlanItem, PlanNode, PlanPage, PlanRow } from './plan';
import { bytesToBase64, Cancelled, decodeText, looseKey, pool, throwIfAborted } from './text';
import { basename, dirname, extname, type Vfs } from './vfs';

const MAX_MESSAGES = 300;
const isDocument = (path: string) => ['md', 'markdown', 'csv'].includes(extname(path));
const isCancel = (e: unknown, signal: AbortSignal) => e instanceof Cancelled || (e as Error)?.name === 'AbortError' || signal.aborted;

export async function runImport(plan: ImportPlan, vfs: Vfs, opts: ImportOptions): Promise<ImportReport> {
  const started = Date.now();
  const { workspaceId: wid, signal } = opts;
  const report: ImportReport = {
    created: { pages: 0, databases: 0, rows: 0, files: 0 },
    roots: [],
    skipped: [],
    warnings: [],
    errors: [],
    cancelled: false,
    durationMs: 0,
  };
  const warn = (m: string) => void (report.warnings.length < MAX_MESSAGES && report.warnings.push(m));
  const fail = (m: string) => void (report.errors.length < MAX_MESSAGES && report.errors.push(m));

  const ids = new Map<string, string>();
  const uploads = new Map<string, Promise<UploadedFile | null>>();
  const referenced = new Set<string>();
  let members: MemberRef[] = [];

  // --- progress ---------------------------------------------------------------------------
  const contentItems: Array<PlanPage | PlanRow> = [];
  for (const item of plan.items.values()) if ((item.kind === 'page' || item.kind === 'row') && (item.mdPath || item.blocks)) contentItems.push(item);
  let done = 0;
  let total = plan.counts.pages + plan.counts.databases + plan.counts.rows + contentItems.length;
  let phase: ImportProgress['phase'] = 'structure';
  const tick = (label: string) => {
    done++;
    opts.onProgress({ phase, done: Math.min(done, total), total, label });
  };

  // --- attachments ------------------------------------------------------------------------
  const attachmentPath = (raw: string, bases: string[]): string | null => {
    for (const base of bases) {
      const t = resolveHref(raw, base ? `${base}/_` : '_');
      if (t.kind !== 'path') return null;
      const f = vfs.resolve(t.path);
      if (f && !isDocument(f.path)) return f.path;
    }
    return null;
  };

  const upload = (path: string): Promise<UploadedFile | null> => {
    const key = looseKey(path);
    referenced.add(key);
    let p = uploads.get(key);
    if (!p) {
      p = (async () => {
        const f = vfs.resolve(path);
        if (!f) return null;
        throwIfAborted(signal);
        try {
          const bytes = await f.read();
          const name = basename(f.path);
          const res = await api.workspaces.upload(wid, new Blob([bytes as BlobPart], { type: mimeOf(name) }), name);
          report.created.files++;
          return res;
        } catch (e) {
          warn(`Fichier non importé : ${path} (${errorText(e)})`);
          return null;
        }
      })();
      uploads.set(key, p);
    }
    return p;
  };

  // --- pass 1: structure --------------------------------------------------------------------
  const dbEnv: DbImportEnv = {
    workspaceId: wid,
    get members() {
      return members;
    },
    signal,
    warn,
    upload,
    attachmentPath,
    created: (item, id) => {
      ids.set(item.uid, id);
      if (item.kind === 'database') report.created.databases++;
      else report.created.rows++;
      tick(item.title);
    },
  };

  const createOne = async (node: PlanNode, parent: ParentRef): Promise<string | null> => {
    throwIfAborted(signal);
    try {
      if (node.kind === 'database') return await importDatabase(node, parent, dbEnv);
      const id = newId();
      await api.pages.create(wid, {
        id,
        parentType: parent.parentType,
        parentId: parent.parentId,
        title: node.title.slice(0, 2000),
        icon: node.icon,
        visibility: parent.visibility,
      });
      ids.set(node.uid, id);
      report.created.pages++;
      tick(node.title);
      return id;
    } catch (e) {
      if (isCancel(e, signal)) throw new Cancelled();
      fail(`« ${node.title} » n’a pas pu être créé : ${errorText(e)}`);
      return ids.get(node.uid) ?? null;
    }
  };

  /** Siblings are created in order (positions follow), then their sub-trees concurrently. */
  const createLevel = async (nodes: PlanNode[], parent: ParentRef): Promise<void> => {
    const created: Array<{ node: PlanNode; id: string }> = [];
    for (const node of nodes) {
      const id = await createOne(node, parent);
      if (id) created.push({ node, id });
    }
    const jobs: Array<{ nodes: PlanNode[]; parent: ParentRef }> = [];
    for (const { node, id } of created) {
      if (node.kind === 'page' && node.children.length) jobs.push({ nodes: node.children, parent: { parentType: 'page', parentId: id } });
      if (node.kind === 'database') {
        for (const row of node.rows) {
          const rowId = ids.get(row.uid);
          if (rowId && row.children.length) jobs.push({ nodes: row.children, parent: { parentType: 'page', parentId: rowId } });
        }
      }
    }
    await pool(jobs, 3, (job) => createLevel(job.nodes, job.parent), signal);
  };

  // --- pass 2: contents ---------------------------------------------------------------------
  const resolveLink = async (href: string, docPath: string, ownerUid: string): Promise<ResolvedLink> => {
    const t = resolveHref(href, docPath);
    if (t.kind === 'external') return { kind: 'external', url: t.url };
    if (t.kind === 'anchor') return { kind: 'missing' };
    const uid = plan.pathIndex.get(looseKey(t.path));
    if (uid) {
      const item = plan.items.get(uid)!;
      const id = ids.get(uid);
      if (!id) return { kind: 'missing' };
      const isChild = plan.parentOf.get(uid) === ownerUid;
      if (item.kind === 'database') return { kind: 'database', id, title: item.title, isChild, inline: item.inline };
      return { kind: 'page', id, title: item.title, isChild };
    }
    const f = vfs.resolve(t.path);
    if (f && !isDocument(f.path)) {
      const up = await upload(f.path);
      return up ? { kind: 'file', url: up.url, name: up.name, mime: up.mime || mimeOf(up.name) } : { kind: 'missing' };
    }
    warn(`Lien introuvable dans « ${basename(docPath)} » : ${href}`);
    return { kind: 'missing' };
  };

  const writeContent = async (pageId: string, blocks: Blk[], mode: 'replace' | 'append', label: string) => {
    if (blocks.length === 0) return;
    const { update, degraded } = blocksToUpdate(blocks);
    if (degraded) warn(`« ${label} » : mise en forme simplifiée (contenu non reconnu).`);
    if (update.byteLength > PAGE_CONTENT_MAX_BYTES) {
      fail(`« ${label} » : contenu trop volumineux (plus de 10 Mo), non importé.`);
      return;
    }
    await contentApi.put(pageId, { update: bytesToBase64(update), mode }, signal);
  };

  const importContent = async (item: PlanPage | PlanRow) => {
    const pageId = ids.get(item.uid);
    if (pageId && item.blocks) {
      try {
        const placed = new Set<string>();
        const blocks = await resolveBlocks(item.blocks, { workspaceId: wid, placed, resolve: (href) => resolveLink(href, '', item.uid) });
        for (const child of item.children) {
          const childId = ids.get(child.uid);
          if (child.kind === 'database' && child.inline && childId && !placed.has(childId)) blocks.push({ type: 'database', props: { databaseId: childId } });
        }
        await writeContent(pageId, blocks, 'replace', item.title);
      } catch (e) {
        if (isCancel(e, signal)) throw new Cancelled();
        fail(`Contenu de « ${item.title} » non importé : ${errorText(e)}`);
      }
    } else if (pageId && item.mdPath) {
      try {
        const file = vfs.resolve(item.mdPath);
        let body = file ? extractTitle(decodeText(await file.read())).body : '';
        if (item.kind === 'row') {
          const db = plan.items.get(plan.parentOf.get(item.uid) ?? '') as PlanDatabase | undefined;
          const keys = new Set((db?.headers ?? []).map(looseKey));
          body = extractPropertyHeader(body, (k) => keys.has(looseKey(k))).body;
        }
        const placed = new Set<string>();
        const blocks = await markdownToBlocks(body, { workspaceId: wid, placed, resolve: (href) => resolveLink(href, item.mdPath!, item.uid) });
        // An inline database must appear in its parent's content.
        for (const child of item.children) {
          const childId = ids.get(child.uid);
          if (child.kind === 'database' && child.inline && childId && !placed.has(childId)) blocks.push({ type: 'database', props: { databaseId: childId } });
        }
        await writeContent(pageId, blocks, 'replace', item.title);
      } catch (e) {
        if (isCancel(e, signal)) throw new Cancelled();
        fail(`Contenu de « ${item.title} » non importé : ${errorText(e)}`);
      }
    }
    tick(item.title);
  };

  // --- pass 3: files nobody links to → appended to the page owning their folder -------------
  const attachOrphans = async () => {
    const orphans = plan.attachments.filter((p) => !referenced.has(looseKey(p)));
    if (orphans.length === 0) return;
    total += orphans.length;
    const byOwner = new Map<string, string[]>();
    const loose: string[] = [];
    for (const p of orphans) {
      let dir = dirname(p);
      let owner = plan.dirOwner.get(dir);
      while (!owner && dir) {
        dir = dirname(dir);
        owner = plan.dirOwner.get(dir);
      }
      const item = owner ? plan.items.get(owner) : undefined;
      if (owner && item && item.kind !== 'database' && ids.has(owner)) byOwner.set(owner, [...(byOwner.get(owner) ?? []), p]);
      else loose.push(p);
    }
    if (loose.length) {
      const holder: PlanPage = { kind: 'page', uid: 'io-loose-files', title: 'Fichiers importés', icon: '📎', mdPath: null, dirPath: null, sourceId: null, children: [] };
      const parent: ParentRef =
        opts.destination.type === 'root'
          ? { parentType: 'workspace', parentId: wid, visibility: opts.destination.visibility }
          : { parentType: 'page', parentId: opts.destination.pageId };
      const id = await createOne(holder, parent);
      if (id) {
        byOwner.set(holder.uid, loose);
        report.roots.push({ id, title: holder.title, kind: 'page' });
      }
    }
    for (const [owner, paths] of byOwner) {
      throwIfAborted(signal);
      const pageId = ids.get(owner);
      const label = plan.items.get(owner)?.title ?? 'Fichiers importés';
      if (!pageId) continue;
      const blocks: Blk[] = [];
      for (const p of paths) {
        const up = await upload(p);
        tick(basename(p));
        if (up) blocks.push({ type: fileBlockType(up.mime || mimeOf(up.name)), props: { url: up.url, name: up.name } });
      }
      try {
        await writeContent(pageId, blocks, 'append', label);
      } catch (e) {
        if (isCancel(e, signal)) throw new Cancelled();
        fail(`Pièces jointes non ajoutées à « ${label} » : ${errorText(e)}`);
      }
    }
  };

  let roots = plan.roots;
  try {
    members = (await api.workspaces.members(wid)).map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }));

    if (opts.skipExisting) {
      const dup = new Set(findDuplicates(plan, opts.existing).map((n) => n.uid));
      const skipped = new Set<string>();
      const mark = (n: PlanItem) => {
        skipped.add(n.uid);
        if (n.kind === 'database') n.rows.forEach(mark);
        else n.children.forEach(mark);
      };
      for (const n of roots) if (dup.has(n.uid)) (report.skipped.push(n.title), mark(n));
      roots = roots.filter((n) => !dup.has(n.uid));
      for (let i = contentItems.length - 1; i >= 0; i--) if (skipped.has(contentItems[i]!.uid)) (contentItems.splice(i, 1), total--);
      total -= skipped.size;
    }

    phase = 'structure';
    if (opts.destination.type === 'root') {
      // Re-imported Oriel exports keep each top-level item in its section.
      const fallback = opts.destination.visibility;
      const sectionOf = (n: PlanNode): Visibility => plan.rootVisibility.get(n.uid) ?? fallback;
      for (const vis of ['workspace', 'private'] as const) {
        const group = roots.filter((n) => sectionOf(n) === vis);
        if (group.length) await createLevel(group, { parentType: 'workspace', parentId: wid, visibility: vis });
      }
    } else {
      await createLevel(roots, { parentType: 'page', parentId: opts.destination.pageId });
    }
    phase = 'content';
    await pool(contentItems, 3, importContent, signal);
    throwIfAborted(signal);

    phase = 'files';
    await attachOrphans();
  } catch (e) {
    if (isCancel(e, signal)) report.cancelled = true;
    else fail(`Import interrompu : ${errorText(e)}`);
  }
  // Top-level items created (also after an interruption, so that the import can be undone).
  const created = roots.flatMap((n) => {
    const id = ids.get(n.uid);
    return id ? [{ id, title: n.title, kind: n.kind === 'database' ? ('database' as const) : ('page' as const) }] : [];
  });
  report.roots.unshift(...created);
  report.durationMs = Date.now() - started;
  return report;
}
