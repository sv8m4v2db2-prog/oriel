// Tools: workspace tags and collections (read only), and a listing of pages by tag or collection.
// Everything goes through the API with the token's rights: a page the token cannot read never shows.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Collection, CollectionsResponse, PageListResponse, TagsResponse } from '@oriel/shared';
import { READ, ref, tool, workspaceField, type ToolContext } from './common.js';

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function registerOrganizeTools(server: McpServer, ctx: ToolContext): void {
  tool(server, ctx, 'oriel_list_tags', {
    title: 'Tags',
    description: "Tags colorés de l'espace, avec le nombre de pages visibles pour le jeton qui les portent.",
    input: z.object({ workspace: workspaceField }).strict(),
    annotations: READ,
    run: async ({ workspace }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const res = await oriel.client.get<TagsResponse>(`/workspaces/${encodeURIComponent(ws.id)}/tags`);
      return { espace: ws.name, tags: res.tags.map((t) => ({ id: t.id, nom: t.name, couleur: t.color, pages: t.pageCount })) };
    },
  });

  tool(server, ctx, 'oriel_list_collections', {
    title: 'Collections',
    description:
      "Collections intelligentes de l'espace : règles (tag, personne, date, propriété, espace, type, titre) plus pages ajoutées ou exclues à la main. Utilisez oriel_query_pages pour lister leurs pages.",
    input: z.object({ workspace: workspaceField }).strict(),
    annotations: READ,
    run: async ({ workspace }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const res = await oriel.client.get<CollectionsResponse>(`/workspaces/${encodeURIComponent(ws.id)}/collections`);
      return {
        espace: ws.name,
        collections: res.collections.map((c) => ({
          id: c.id,
          nom: c.name,
          regles: c.rules.conditions.length === 0 ? undefined : { combinaison: c.rules.match === 'any' ? 'au moins une' : 'toutes', conditions: c.rules.conditions },
          ajoutees: c.included.length || undefined,
          exclues: c.excluded.length || undefined,
        })),
      };
    },
  });

  tool(server, ctx, 'oriel_query_pages', {
    title: 'Pages par tag ou collection',
    description:
      "Liste paginée des pages d'un tag ou d'une collection (par nom ou id), éventuellement filtrées par titre. Sans tag ni collection : toutes les pages de l'espace. Les pages invisibles pour le jeton n'apparaissent jamais.",
    input: z
      .object({
        workspace: workspaceField,
        tag: z.string().max(200).optional().describe('Nom ou id du tag.'),
        collection: z.string().max(200).optional().describe('Nom ou id de la collection.'),
        titleContains: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Défaut 50.'),
        offset: z.number().int().min(0).max(100000).optional(),
      })
      .strict(),
    annotations: READ,
    run: async ({ workspace, tag, collection, titleContains, limit, offset }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const wid = encodeURIComponent(ws.id);
      const tagList = (await oriel.client.get<TagsResponse>(`/workspaces/${wid}/tags`)).tags;
      const params = new URLSearchParams();
      if (tag) {
        const found = tagList.find((t) => t.id === tag) ?? tagList.find((t) => norm(t.name) === norm(tag));
        if (!found) throw new Error(`Tag introuvable : « ${tag} ». Voir oriel_list_tags.`);
        params.set('tagId', found.id);
      }
      if (collection) {
        const list = (await oriel.client.get<CollectionsResponse>(`/workspaces/${wid}/collections`)).collections as Collection[];
        const found = list.find((c) => c.id === collection) ?? list.find((c) => norm(c.name) === norm(collection));
        if (!found) throw new Error(`Collection introuvable : « ${collection} ». Voir oriel_list_collections.`);
        params.set('collectionId', found.id);
      }
      if (titleContains) params.set('title', titleContains);
      params.set('limit', String(limit ?? 50));
      params.set('offset', String(offset ?? 0));
      // GET: works with read-only tokens.
      const res = await oriel.client.get<PageListResponse>(`/workspaces/${wid}/pages?${params.toString()}`);
      const tagName = new Map(tagList.map((t) => [t.id, t.name] as const));
      return {
        espace: ws.name,
        total: res.total,
        suite: res.hasMore ? `offset=${res.offset + res.items.length}` : undefined,
        pages: res.items.map((p) => ({
          id: p.id,
          titre: p.title || 'Sans titre',
          lien: ref(p.id),
          type: p.kind === 'database' ? 'base' : p.parentType === 'database' ? 'ligne' : 'page',
          modifiee: new Date(p.updatedAt).toISOString(),
          tags: p.tagIds.map((id) => tagName.get(id)).filter(Boolean),
          dans: p.parentTitle ?? undefined,
        })),
      };
    },
  });
}
