// Page content through the API (GET/PUT /api/pages/:pid/content: base64 Yjs updates), as Markdown or
// BlockNote JSON blocks.
import { isSyncedId, type PageContentMode, type PageContentResponse, type PutPageContentResponse, type SyncedBlockInfo } from '@oriel/shared';
import type { Oriel } from '../oriel.js';
import { blocksToUpdate, stripIds, updateToBlocks, type Blk } from './editor.js';
import { blocksToMarkdown, collectReferences, markdownToBlocks, sanitizeBlocks, type ImportContext } from './markdown.js';

export interface ReadContent {
  blocks: Blk[];
  markdown: string;
  warnings: string[];
}

export async function readPageBlocks(oriel: Oriel, pageId: string): Promise<{ blocks: Blk[]; warnings: string[] }> {
  const { update } = await oriel.client.get<PageContentResponse>(`/pages/${encodeURIComponent(pageId)}/content`);
  const { blocks, unknown } = updateToBlocks(new Uint8Array(Buffer.from(update, 'base64')));
  const warnings = unknown.length
    ? [`contenu non reconnu par le serveur MCP (${unknown.join(', ')}) : il n'apparaît pas ici et serait perdu par une réécriture complète (mode replace)`]
    : [];
  return { blocks, warnings };
}

export async function readPageMarkdown(oriel: Oriel, workspaceId: string, pageId: string): Promise<ReadContent> {
  const { blocks, warnings } = await readPageBlocks(oriel, pageId);
  const refs = collectReferences(blocks);
  const [titles, members] = await Promise.all([
    refs.pageIds.size ? oriel.titles(workspaceId, refs.pageIds) : Promise.resolve(new Map<string, string>()),
    refs.userIds.size ? oriel.members(workspaceId).catch(() => []) : Promise.resolve([]),
  ]);
  const names = new Map(members.map((m) => [m.user.id, m.user.name]));
  const md = await blocksToMarkdown(blocks, { title: (id) => titles.get(id), userName: (id) => names.get(id) });
  return { blocks, markdown: md.markdown, warnings: [...warnings, ...md.warnings] };
}

/** Markdown → blocks for a page of `workspaceId` (references checked against the workspace). */
export async function markdownForPage(oriel: Oriel, workspaceId: string, pageId: string | null, markdown: string): Promise<{ blocks: Blk[]; warnings: string[] }> {
  return markdownToBlocks(markdown, await importContext(oriel, workspaceId, pageId));
}

/** References of written content are checked against the workspace of the page. */
async function importContext(oriel: Oriel, workspaceId: string, pageId: string | null): Promise<ImportContext> {
  const { user } = await oriel.me();
  const memberIds = new Set<string>();
  let membersLoaded = false;
  let refreshed = false;
  return {
    pageId,
    currentUserId: user.id,
    serverOrigin: oriel.baseUrl,
    resolvePage: (id) => oriel.resolvePage(workspaceId, id),
    // The server answers 404 unless the block belongs to the page's workspace and its owner page is
    // visible to the token's user (server/src/routes/editor.ts, resolveSynced).
    resolveSynced: async (syncedId) => {
      if (!pageId || !isSyncedId(syncedId)) return false;
      try {
        const info = await oriel.client.get<SyncedBlockInfo>(`/pages/${encodeURIComponent(pageId)}/synced-blocks/${encodeURIComponent(syncedId)}`);
        return info.id === syncedId;
      } catch {
        return false;
      }
    },
    isMember: async (id) => {
      if (!membersLoaded) {
        for (const m of await oriel.members(workspaceId)) memberIds.add(m.user.id);
        membersLoaded = true;
      }
      if (!memberIds.has(id) && !refreshed) {
        // Cache miss: the member may have joined since the list was cached.
        refreshed = true;
        for (const m of await oriel.members(workspaceId, { fresh: true })) memberIds.add(m.user.id);
      }
      return memberIds.has(id);
    },
  };
}

export async function writePageContent(
  oriel: Oriel,
  input: { workspaceId: string; pageId: string; mode: PageContentMode; markdown?: string; blocks?: Blk[] },
): Promise<{ blocks: number; warnings: string[] }> {
  let blocks: Blk[];
  let warnings: string[] = [];
  if (input.blocks) {
    const checked = await sanitizeBlocks(input.mode === 'append' ? stripIds(input.blocks) : input.blocks, await importContext(oriel, input.workspaceId, input.pageId));
    blocks = checked.blocks;
    warnings = checked.warnings;
  } else {
    const converted = await markdownForPage(oriel, input.workspaceId, input.pageId, input.markdown ?? '');
    blocks = converted.blocks;
    warnings = converted.warnings;
  }
  if (blocks.length === 0 && input.mode === 'append') return { blocks: 0, warnings };
  let update: Uint8Array;
  try {
    update = blocksToUpdate(blocks.length ? blocks : [{ type: 'paragraph', content: [] }]);
  } catch (err) {
    throw new Error(`Blocs invalides pour le schéma d’Oriel : ${(err as Error).message}`);
  }
  const res = await oriel.client.put<PutPageContentResponse>(`/pages/${encodeURIComponent(input.pageId)}/content`, {
    update: Buffer.from(update).toString('base64'),
    mode: input.mode,
  });
  return { blocks: res.blocks, warnings };
}
