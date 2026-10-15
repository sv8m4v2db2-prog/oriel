// Page content API (import/export): read the full Yjs state of a page, and write blocks into it
// through a Hocuspocus direct connection so that connected editors receive the change live.
import * as Y from 'yjs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  COLLAB_FRAGMENT,
  PAGE_CONTENT_MAX_BYTES,
  collabDocumentName,
  newId,
  syncedDocumentName,
  type PageContentMode,
  type PutPageContentResponse,
} from '@oriel/shared';
import type { AppContext } from '../context.js';
import { requirePage } from '../access.js';
import { checkCollabUpdate } from '../realtime/updateGuard.js';
import { MAX_CONTENT_CHILDREN, MAX_CONTENT_DEPTH } from '../content/ydoc.js';
import { parseJson } from '../db/rows.js';
import { badRequest, HttpError, payloadTooLarge } from '../errors.js';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Hocuspocus instance of the running server (absent when collaboration is stubbed out). */
function hocuspocusOf(ctx: AppContext): Hocuspocus | null {
  const candidate = (ctx.collab as unknown as { hocuspocus?: unknown }).hocuspocus;
  return candidate && typeof (candidate as Hocuspocus).openDirectConnection === 'function' ? (candidate as Hocuspocus) : null;
}

/** Full current state of a page document: live in-memory state first, else the saved one. */
export function readPageState(ctx: AppContext, pageId: string): Uint8Array {
  const live = ctx.collab.liveState(pageId);
  if (live) return live;
  const row = ctx.db.get<{ state: Uint8Array }>('SELECT state FROM documents WHERE page_id = ?', pageId);
  if (row?.state && row.state.byteLength > 0) return row.state;
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/**
 * Full current state of a synced block (live document first, else the saved one). The caller has
 * checked the access (owner page) and the workspace (routes/editor.ts).
 */
export function readSyncedState(ctx: AppContext, syncedId: string): Uint8Array {
  const doc = hocuspocusOf(ctx)?.documents.get(syncedDocumentName(syncedId));
  if (doc && !doc.isLoading) return Y.encodeStateAsUpdate(doc);
  const row = ctx.db.get<{ state: Uint8Array | null }>('SELECT state FROM editor_synced_blocks WHERE id = ?', syncedId);
  if (row?.state && row.state.byteLength > 0) return row.state;
  return Y.encodeStateAsUpdate(new Y.Doc());
}

export function getPageContent(ctx: AppContext, userId: string, pageId: string): { update: string } {
  requirePage(ctx.db, userId, pageId, 'read');
  return { update: Buffer.from(readPageState(ctx, pageId)).toString('base64') };
}

/** Decodes and validates an incoming update; returns a standalone document holding it. */
export function decodeContentUpdate(base64: string): Y.Doc {
  const compact = base64.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) throw badRequest('Contenu invalide : base64 attendu.');
  // 4 base64 chars → 3 bytes: refuse before decoding anything too big.
  if (Math.floor((compact.length * 3) / 4) > PAGE_CONTENT_MAX_BYTES + 2) throw payloadTooLarge('Contenu trop volumineux (10 Mo maximum).');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.byteLength > PAGE_CONTENT_MAX_BYTES) throw payloadTooLarge('Contenu trop volumineux (10 Mo maximum).');
  if (bytes.byteLength === 0) throw badRequest('Contenu invalide : mise à jour Yjs vide.');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    doc.destroy();
    throw badRequest('Contenu invalide : mise à jour Yjs illisible.');
  }
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    doc.destroy();
    throw badRequest('Contenu invalide : la mise à jour doit décrire un document complet.');
  }
  const foreign = [...doc.share.keys()].filter((k) => k !== COLLAB_FRAGMENT);
  if (foreign.length > 0) {
    doc.destroy();
    throw badRequest(`Contenu invalide : seul le fragment « ${COLLAB_FRAGMENT} » peut être modifié.`);
  }
  try {
    assertXmlTree(doc.getXmlFragment(COLLAB_FRAGMENT));
  } catch (err) {
    doc.destroy();
    throw err;
  }
  return doc;
}

/**
 * The fragment must hold only XML elements and texts (what the editor binding can render): a Y.Map,
 * Y.Text, Y.XmlHook or raw value in it breaks the editor for everyone, and raw values cannot be cloned.
 * Iterative, so absurd nesting is refused instead of overflowing the stack.
 */
function assertXmlTree(fragment: Y.XmlFragment): void {
  const tooWide = () => badRequest('Contenu invalide : trop de blocs au même niveau.');
  if (fragment.length > MAX_CONTENT_CHILDREN) throw tooWide();
  const stack: Array<[unknown, number]> = fragment.toArray().map((n) => [n, 1]);
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    // Same rules as /collab (realtime/updateGuard.ts): characters only in texts, plain attribute
    // values (Yjs `clone()` throws half-way through the write on embedded types).
    if (node instanceof Y.XmlText) {
      if ((node.toDelta() as Array<{ insert?: unknown }>).some((op) => typeof op.insert !== 'string')) throw badRequest('Contenu invalide : texte non textuel.');
      continue;
    }
    if (!(node instanceof Y.XmlElement)) throw badRequest('Contenu invalide : le document ne doit contenir que des blocs et du texte.');
    if (Object.values(node.getAttributes() as Record<string, unknown>).some((v) => v instanceof Y.AbstractType || v instanceof Y.Doc)) {
      throw badRequest('Contenu invalide : attribut non textuel.');
    }
    if (depth > MAX_CONTENT_DEPTH) throw badRequest('Contenu invalide : imbrication des blocs trop profonde.');
    if (node.length > MAX_CONTENT_CHILDREN) throw tooWide();
    for (const child of node.toArray()) stack.push([child, depth + 1]);
  }
}

type XmlNode = Y.XmlElement | Y.XmlText;

const isEmptyParagraphContainer = (node: unknown): boolean => {
  if (!(node instanceof Y.XmlElement) || node.nodeName !== 'blockContainer' || node.length !== 1) return false;
  const inner = node.get(0);
  if (!(inner instanceof Y.XmlElement) || inner.nodeName !== 'paragraph') return false;
  return inner.toArray().every((c) => c instanceof Y.XmlText && c.length === 0);
};

/** Top-level block containers of a BlockNote fragment (children of its root `blockGroup`). */
function blockGroupOf(fragment: Y.XmlFragment): Y.XmlElement | null {
  const first = fragment.length > 0 ? fragment.get(0) : null;
  return first instanceof Y.XmlElement && first.nodeName === 'blockGroup' ? first : null;
}

/**
 * Writes the blocks of `source` into `target`'s fragment (must run inside a transaction on target).
 * Returns the number of top-level blocks written.
 */
export function applyFragment(target: Y.Doc, source: Y.Doc, mode: PageContentMode): number {
  const src = source.getXmlFragment(COLLAB_FRAGMENT);
  const dst = target.getXmlFragment(COLLAB_FRAGMENT);
  const srcGroup = blockGroupOf(src);
  if (mode === 'merge') {
    // Apply targeted edits from the same CRDT history without replacing the shared
    // types to which existing editor bindings are attached.
    const targetGroup = blockGroupOf(dst);
    const sourceId = srcGroup?._item?.id;
    const targetId = targetGroup?._item?.id;
    if (!sourceId || !targetId || sourceId.client !== targetId.client || sourceId.clock !== targetId.clock || src.length !== 1 || dst.length !== 1) {
      throw badRequest('La fusion requiert une copie du même document collaboratif.');
    }
    const update = Y.encodeStateAsUpdate(source);
    const problem = checkCollabUpdate(target, update);
    if (problem) throw badRequest(`Contenu invalide : ${problem}.`);
    Y.applyUpdate(target, update);
    return srcGroup?.length ?? src.length;
  }
  const existingGroup = blockGroupOf(dst);
  if (mode === 'replace' || dst.length === 0) {
    // An open editor binds to this root group. Replacing the group itself can make its
    // cached ProseMirror mapping send the previous content back to Yjs. Keep the root
    // shared type and replace its children, as a normal editor transaction does.
    if (srcGroup && existingGroup && src.length === 1 && dst.length === 1) {
      const clones = srcGroup.toArray().map((n) => (n as XmlNode).clone());
      if (existingGroup.length > 0) existingGroup.delete(0, existingGroup.length);
      if (clones.length > 0) existingGroup.insert(0, clones);
      return clones.length;
    }
    const clones = src.toArray().map((n) => (n as XmlNode).clone());
    if (dst.length > 0) dst.delete(0, dst.length);
    if (clones.length > 0) dst.insert(0, clones);
    return srcGroup ? srcGroup.length : clones.length;
  }
  // append
  const items = srcGroup ? srcGroup.toArray() : src.toArray();
  const clones = items.filter((n) => !isEmptyParagraphContainer(n)).map((n) => (n as XmlNode).clone());
  if (clones.length === 0) return 0;
  let dstGroup = blockGroupOf(dst);
  if (!dstGroup) {
    dstGroup = new Y.XmlElement('blockGroup');
    dst.insert(dst.length, [dstGroup]);
  }
  // BlockNote keeps an empty trailing paragraph: drop it so the new blocks follow the content.
  if (dstGroup.length > 0 && isEmptyParagraphContainer(dstGroup.get(dstGroup.length - 1))) dstGroup.delete(dstGroup.length - 1, 1);
  dstGroup.insert(dstGroup.length, clones);
  return clones.length;
}

const fragmentIsEmpty = (doc: Y.Doc): boolean => {
  const group = blockGroupOf(doc.getXmlFragment(COLLAB_FRAGMENT));
  if (!group) return doc.getXmlFragment(COLLAB_FRAGMENT).length === 0;
  return group.toArray().every(isEmptyParagraphContainer);
};

/**
 * Whether a merge deletes content that is still visible in `target` (QA-CORE-03): its delete set
 * covers at least one live item of the document. Such a merge gets the same `before-restore`
 * snapshot as a replacement, so that a stale or faulty script never loses the previous version.
 */
export function mergeDeletesContent(target: Y.Doc, source: Y.Doc): boolean {
  const { ds } = Y.decodeUpdate(Y.encodeStateAsUpdate(source));
  for (const [client, deletes] of ds.clients) {
    const structs = target.store.clients.get(client);
    if (!structs || structs.length === 0) continue;
    const state = Y.getState(target.store, client);
    for (const { clock, len } of deletes) {
      if (clock >= state) continue;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + len; i++) {
        const s = structs[i]!;
        if (s instanceof Y.Item && !s.deleted && !(s.content instanceof Y.ContentDeleted)) return true;
      }
    }
  }
  return false;
}

export async function putPageContent(
  ctx: AppContext,
  userId: string,
  pageId: string,
  input: { update: string; mode: PageContentMode },
): Promise<PutPageContentResponse> {
  const { db } = ctx;
  const { page } = requirePage(db, userId, pageId, 'edit');
  if (page.trashed_at !== null) throw badRequest('Restaurez la page avant de modifier son contenu.');
  const source = decodeContentUpdate(input.update);
  try {
    const hocuspocus = hocuspocusOf(ctx);
    if (!hocuspocus) throw new HttpError(503, 'unavailable', 'Le service de collaboration est indisponible.');
    const direct = await hocuspocus.openDirectConnection(collabDocumentName(pageId), { userId, pageId });
    let blocks = 0;
    try {
      const doc = direct.document;
      if (!doc) throw new HttpError(503, 'unavailable', 'Document indisponible.');
      if ((input.mode === 'replace' && !fragmentIsEmpty(doc)) || (input.mode === 'merge' && mergeDeletesContent(doc, source))) {
        // Keep the previous content in the history, like a snapshot restore does.
        const current = Y.encodeStateAsUpdate(doc);
        db.tx(() => {
          const existing = db.get<{ editors: string }>('SELECT editors FROM documents WHERE page_id = ?', pageId);
          db.run(
            "INSERT INTO snapshots (id, page_id, state, created_at, authors, reason) VALUES (?, ?, ?, ?, ?, 'before-restore')",
            newId(),
            pageId,
            current,
            Date.now(),
            JSON.stringify(parseJson<string[]>(existing?.editors, [])),
          );
          db.run("UPDATE documents SET editors = '[]' WHERE page_id = ?", pageId);
        });
      }
      await direct.transact((d) => {
        blocks = applyFragment(d, source, input.mode);
      });
    } finally {
      // Persists synchronously (text, search index, links, snapshots) and unloads when unused.
      await direct.disconnect();
    }
    return { ok: true, blocks };
  } finally {
    source.destroy();
  }
}
