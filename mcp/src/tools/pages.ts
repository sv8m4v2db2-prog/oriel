// Tools: account & workspaces, search, page tree, reading and writing pages.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  COVER_COLORS,
  COVER_GRADIENTS,
  isCanvasFormat,
  type BacklinksResponse,
  type Cover,
  type Page,
  type PageDetailResponse,
  type SearchResponse,
  type TemplatesResponse,
  type TreeNode,
  type UpdatePageRequest,
} from '@oriel/shared';
import { looseKey } from '../oriel.js';
import { pageIdFrom } from '../content/links.js';
import { readPageBlocks, readPageMarkdown, writePageContent } from '../content/pageContent.js';
import { loadDatabase, readableProperties, rowContext, ValueConverter } from '../databases.js';
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  kindLabel,
  pageIdField,
  parentField,
  ref,
  resolveParent,
  tool,
  workspaceField,
  type ToolContext,
} from './common.js';

const propertiesField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Propriétés d'une ligne de base, par NOM de propriété. Valeurs lisibles : texte ; nombre ; true/false ; nom d'option (sélection, statut) ou liste de noms (multi-sélection, options manquantes créées) ; date 'AAAA-MM-JJ' (ou 'AAAA-MM-JJTHH:MM', ou { start, end }) ; personnes par nom, e-mail ou 'moi' ; relations par titre de ligne ou id ; null pour effacer.",
  );

const markdownHelp =
  "Markdown (GFM) avec les conventions Oriel : `[Titre](oriel://page/<id>)` seul sur sa ligne = carte de sous-page / lien vers une page, dans une phrase = mention ; `[@Nom](oriel://user/<id>)` = mention de personne ; `[📅 15 oct.](oriel://date/2026-10-15)` = date (`?reminder=1` pour un rappel) ; `> 💡 texte` = encadré ; `<details><summary>Titre</summary>…</details>` = bloc dépliable ; `[🗃 Base](oriel://database/<id>)` = base intégrée ; `[Table des matières](oriel://toc)` ; `oriel://embed?url=…`, `oriel://bookmark?url=…` ; colonnes : `<!-- oriel:columns -->`, `<!-- oriel:column -->`…`<!-- /oriel:columns -->`.";

function crumbPath(detail: PageDetailResponse): string {
  return detail.ancestors.map((a) => a.title || 'Sans titre').join(' / ');
}

function flatten(nodes: TreeNode[], rootId: string | null, maxDepth: number, includeTemplates: boolean) {
  const children = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (n.isTemplate && !includeTemplates) continue;
    const key = n.parentType === 'workspace' ? '' : n.parentId;
    const list = children.get(key) ?? [];
    list.push(n);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  const out: Array<Record<string, unknown>> = [];
  const walk = (key: string, depth: number) => {
    for (const n of children.get(key) ?? []) {
      const count = children.get(n.id)?.length ?? 0;
      out.push({
        id: n.id,
        titre: n.title || 'Sans titre',
        icone: n.icon,
        type: kindLabel(n),
        niveau: depth,
        ...(n.visibility === 'private' ? { prive: true } : {}),
        ...(n.isInline ? { integree: true } : {}),
        ...(n.isTemplate ? { modele: true } : {}),
        ...(count && depth >= maxDepth ? { sousPagesNonAffichees: count } : {}),
      });
      if (depth < maxDepth) walk(n.id, depth + 1);
    }
  };
  walk(rootId ?? '', 1);
  return out;
}

function parseCover(input: unknown): Cover | null {
  if (input === null) return null;
  if (typeof input === 'string') {
    if (/^https?:\/\//i.test(input) || input.startsWith('/api/files/')) return { type: 'image', url: input };
    if (input in COVER_GRADIENTS) return { type: 'gradient', value: input };
    if (input in COVER_COLORS) return { type: 'color', value: input };
  }
  throw new Error(
    `Couverture invalide : URL d'image (https), dégradé (${Object.keys(COVER_GRADIENTS).join(', ')}), couleur (${Object.keys(COVER_COLORS).join(', ')}) ou null.`,
  );
}

async function rowProperties(ctx: ToolContext, page: Page, databaseId: string) {
  const db = await loadDatabase(ctx.oriel, databaseId);
  const rctx = await rowContext(ctx.oriel, db);
  const row = db.rows.find((r) => r.id === page.id) ?? page;
  return readableProperties(row, db.schema, rctx);
}

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  tool(server, ctx, 'oriel_whoami', {
    title: 'Qui suis-je ?',
    description:
      "Compte Oriel utilisé par ce serveur MCP : utilisateur, droits du jeton (lecture seule ou écriture, espace autorisé, expiration), espaces accessibles et espace par défaut. À appeler en premier en cas de doute.",
    input: z.object({}).strict(),
    annotations: READ,
    run: async (_args, { oriel }) => {
      const [me, token] = await Promise.all([oriel.me(), oriel.tokenInfo()]);
      const def = await oriel.workspace().catch(() => null);
      return {
        utilisateur: { id: me.user.id, nom: me.user.name, email: me.user.email },
        jeton: token
          ? {
              nom: token.name,
              droits: token.scope === 'write' ? 'lecture et écriture' : 'lecture seule',
              espace: token.workspaceId ? (token.workspaceName ?? token.workspaceId) : 'tous les espaces',
              expire: token.expiresAt ? new Date(token.expiresAt).toISOString() : 'jamais',
            }
          : null,
        espaces: me.workspaces.map((w) => ({ id: w.id, nom: w.name, icone: w.icon, role: w.role })),
        espaceParDefaut: def ? { id: def.id, nom: def.name } : null,
        serveur: oriel.baseUrl,
      };
    },
  });

  tool(server, ctx, 'oriel_list_workspaces', {
    title: 'Lister les espaces',
    description: 'Espaces de travail accessibles avec ce jeton (id, nom, rôle).',
    input: z.object({}).strict(),
    annotations: READ,
    run: async (_args, { oriel }) => {
      const me = await oriel.me();
      return { espaces: me.workspaces.map((w) => ({ id: w.id, nom: w.name, icone: w.icon, role: w.role })) };
    },
  });

  tool(server, ctx, 'oriel_list_members', {
    title: "Membres de l'espace",
    description: "Membres d'un espace (id, nom, e-mail, rôle) : utile pour les propriétés Personne et les mentions `[@Nom](oriel://user/<id>)`.",
    input: z.object({ workspace: workspaceField }).strict(),
    annotations: READ,
    run: async ({ workspace }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const members = await oriel.members(ws.id);
      return { espace: ws.name, membres: members.map((m) => ({ id: m.user.id, nom: m.user.name, email: m.user.email, role: m.role })) };
    },
  });

  tool(server, ctx, 'oriel_search', {
    title: 'Rechercher',
    description: "Recherche plein texte (titres et contenus) dans un espace. Renvoie les pages, bases et lignes trouvées avec leur chemin et un extrait ([[ ]] autour des termes trouvés).",
    input: z
      .object({
        query: z.string().min(1).max(500).describe('Termes recherchés.'),
        limit: z.number().int().min(1).max(50).optional().describe('Nombre maximum de résultats (défaut 10).'),
        workspace: workspaceField,
      })
      .strict(),
    annotations: READ,
    run: async ({ query, limit, workspace }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const res = await oriel.client.get<SearchResponse>(`/workspaces/${encodeURIComponent(ws.id)}/search?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`);
      return {
        espace: ws.name,
        resultats: res.results.map((r) => ({
          id: r.page.id,
          titre: r.page.title || 'Sans titre',
          icone: r.page.icon,
          type: kindLabel(r.page),
          chemin: r.path.map((c) => c.title || 'Sans titre').join(' / '),
          extrait: r.snippet,
        })),
      };
    },
  });

  tool(server, ctx, 'oriel_list_pages', {
    title: 'Arborescence des pages',
    description:
      "Arborescence des pages et bases d'un espace (ou sous une page), dans l'ordre de la barre latérale. Liste à plat avec `niveau` (1 = premier niveau sous la racine demandée). Les lignes de base n'y figurent pas : utilisez oriel_query_database. Paginée (limit / offset).",
    input: z
      .object({
        workspace: workspaceField,
        parentId: z.string().max(500).optional().describe('Afficher seulement ce qui se trouve sous cette page.'),
        depth: z.number().int().min(1).max(20).optional().describe('Profondeur maximale (défaut 3).'),
        limit: z.number().int().min(1).max(500).optional().describe('Défaut 200.'),
        offset: z.number().int().min(0).optional(),
        includeTemplates: z.boolean().optional().describe('Inclure les modèles de page.'),
      })
      .strict(),
    annotations: READ,
    run: async ({ workspace, parentId, depth, limit, offset, includeTemplates }, { oriel }) => {
      let wid: string;
      let root: string | null = null;
      if (parentId) {
        const { page } = await oriel.page(pageIdFrom(parentId));
        wid = page.workspaceId;
        root = page.id;
      } else wid = (await oriel.workspace(workspace)).id;
      const all = flatten(await oriel.tree(wid), root, depth ?? 3, includeTemplates ?? false);
      const start = offset ?? 0;
      const size = limit ?? 200;
      const pages = all.slice(start, start + size);
      return { total: all.length, offset: start, suivant: start + size < all.length ? start + size : null, pages };
    },
  });

  tool(server, ctx, 'oriel_read_page', {
    title: 'Lire une page',
    description:
      "Lit une page : titre, icône, chemin, propriétés (si c'est une ligne de base), contenu en Markdown (ou en blocs JSON BlockNote avec format 'blocks', sans perte), sous-pages et rétroliens. Les références Oriel apparaissent comme liens oriel://… (voir oriel_write_page_content).",
    input: z
      .object({
        pageId: pageIdField,
        format: z.enum(['markdown', 'blocks']).optional().describe("'markdown' (défaut) ou 'blocks' (JSON BlockNote fidèle : couleurs, ids de blocs…)."),
        includeContent: z.boolean().optional().describe('Défaut true.'),
      })
      .strict(),
    annotations: READ,
    run: async ({ pageId, format, includeContent }, c) => {
      const { oriel } = c;
      const id = pageIdFrom(pageId);
      const detail = await oriel.page(id);
      const { page } = detail;
      const wid = page.workspaceId;
      const [tree, backlinks] = await Promise.all([oriel.tree(wid), oriel.client.get<BacklinksResponse>(`/pages/${encodeURIComponent(id)}/backlinks`).catch(() => ({ pages: [] }))]);
      const children = tree
        .filter((n) => n.parentId === id && n.parentType !== 'workspace')
        .sort((a, b) => (a.position < b.position ? -1 : 1))
        .map((n) => ({ id: n.id, titre: n.title || 'Sans titre', type: kindLabel(n) }));
      const meta: Record<string, unknown> = {
        id,
        titre: page.title || 'Sans titre',
        icone: page.icon,
        type: kindLabel(page),
        chemin: crumbPath(detail),
        lien: ref(id),
        url: oriel.webUrl(wid, id),
        espaceId: wid,
        modifiable: detail.canEdit,
        ...(page.visibility === 'private' ? { prive: true } : {}),
        ...(detail.publiclyVisible ? { publiee: true } : {}),
        modifieLe: new Date(page.updatedAt).toISOString(),
      };
      if (detail.parentDatabase) {
        meta.base = { id: detail.parentDatabase.id, titre: detail.ancestors[detail.ancestors.length - 1]?.title ?? null };
        meta.proprietes = await rowProperties(c, page, detail.parentDatabase.id);
      }
      if (page.kind === 'database') meta.note = 'Base de données : oriel_get_database pour son schéma, oriel_query_database pour ses lignes.';
      const canvas = isCanvasFormat(page.format);
      if (canvas) {
        meta.type = 'canevas';
        meta.note = "Canevas (tableau blanc) : son contenu ne se lit ni ne s'écrit en Markdown ; ouvrez-le dans Oriel.";
      }
      meta.sousPages = children;
      meta.retroliens = backlinks.pages.map((p) => ({ id: p.id, titre: p.title || 'Sans titre' }));
      const content: Array<{ type: 'text'; text: string }> = [];
      if (includeContent !== false && !canvas) {
        if (format === 'blocks') {
          const { blocks, warnings } = await readPageBlocks(oriel, id);
          if (warnings.length) meta.avertissements = warnings;
          content.push({ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text: JSON.stringify(blocks) });
        } else {
          const read = await readPageMarkdown(oriel, wid, id);
          if (read.warnings.length) meta.avertissements = read.warnings;
          content.push({ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text: read.markdown || '(page vide)' });
        }
      } else content.push({ type: 'text', text: JSON.stringify(meta) });
      return { content };
    },
  });

  tool(server, ctx, 'oriel_create_page', {
    title: 'Créer une page',
    description: `Crée une page à la racine d'un espace, une sous-page, ou une ligne de base (parent.type 'database', avec ses propriétés). Contenu facultatif en Markdown. ${markdownHelp}`,
    input: z
      .object({
        parent: parentField,
        title: z.string().max(2000).describe('Titre.'),
        icon: z.string().max(50).optional().describe('Emoji.'),
        markdown: z.string().max(500_000).optional().describe('Contenu initial (Markdown).'),
        properties: propertiesField,
        template: z.string().max(500).optional().describe("Lignes de base : modèle de ligne à utiliser (nom ou id)."),
        visibility: z.enum(['workspace', 'private']).optional().describe("Racine de l'espace : section « Espace de travail » (défaut) ou « Privé »."),
        addLinkToParent: z.boolean().optional().describe("Sous-page : ajouter une carte vers elle à la fin de la page parente (défaut true)."),
        type: z.enum(['page', 'canvas']).optional().describe("'canvas' : tableau blanc (canevas), vide, sans contenu Markdown ; pas pour une ligne de base. Défaut 'page'."),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const parent = await resolveParent(oriel, args.parent);
      const canvas = args.type === 'canvas';
      if (canvas && parent.parentType === 'database') throw new Error("Un canevas ne peut pas être une ligne de base.");
      if (canvas && args.markdown?.trim()) throw new Error("Un canevas n'a pas de contenu Markdown : créez-le vide, puis ouvrez-le dans Oriel.");
      const warnings: string[] = [];
      let created: Page;
      let fromTemplate = false;
      if (parent.parentType === 'database') {
        const db = await loadDatabase(oriel, parent.parentId);
        const me = await oriel.me();
        const conv = new ValueConverter(oriel, db, me.user.id);
        const { properties, title } = await conv.convertAll(args.properties ?? {});
        const added = await conv.flushOptions();
        if (added.length) warnings.push(`options ajoutées : ${added.join(', ')}`);
        let templateId: string | undefined;
        if (args.template) {
          const tpl = await oriel.client.get<TemplatesResponse>(`/databases/${encodeURIComponent(parent.parentId)}/templates`);
          const t = tpl.rows.find((r) => r.id === pageIdFrom(args.template!)) ?? tpl.rows.find((r) => looseKey(r.title) === looseKey(args.template!));
          if (!t) throw new Error(`Modèle « ${args.template} » introuvable. Modèles : ${tpl.rows.map((r) => `« ${r.title || 'Sans titre'} »`).join(', ') || 'aucun'}.`);
          templateId = t.id;
          fromTemplate = true;
        }
        created = await oriel.client.post<Page>(`/databases/${encodeURIComponent(parent.parentId)}/rows`, {
          title: title ?? args.title,
          icon: args.icon,
          properties,
          ...(templateId ? { templateId } : {}),
        });
      } else {
        if (args.properties && Object.keys(args.properties).length) throw new Error("Les propriétés ne s'appliquent qu'aux lignes de base (parent.type 'database').");
        created = await oriel.client.post<Page>(`/workspaces/${encodeURIComponent(parent.workspaceId)}/pages`, {
          parentType: parent.parentType,
          parentId: parent.parentId,
          title: args.title,
          icon: args.icon,
          ...(parent.parentType === 'workspace' && args.visibility ? { visibility: args.visibility } : {}),
          ...(canvas ? { layout: 'canvas' } : {}),
        });
      }
      oriel.invalidate(parent.workspaceId);
      if (args.markdown?.trim()) {
        const res = await writePageContent(oriel, { workspaceId: parent.workspaceId, pageId: created.id, mode: fromTemplate ? 'append' : 'replace', markdown: args.markdown });
        warnings.push(...res.warnings);
      }
      if (parent.parentType === 'page' && args.addLinkToParent !== false) {
        try {
          await writePageContent(oriel, { workspaceId: parent.workspaceId, pageId: parent.parentId, mode: 'append', blocks: [{ type: 'subpage', props: { pageId: created.id } }] });
        } catch (err) {
          warnings.push(`carte non ajoutée dans la page parente : ${(err as Error).message}`);
        }
      }
      return { id: created.id, titre: created.title, lien: ref(created.id), url: oriel.webUrl(parent.workspaceId, created.id), avertissements: warnings };
    },
  });

  tool(server, ctx, 'oriel_update_page', {
    title: 'Modifier une page',
    description:
      "Modifie le titre, l'icône, la couverture, les options d'affichage ou les propriétés (lignes de base) d'une page. Pour le contenu, utilisez oriel_write_page_content.",
    input: z
      .object({
        pageId: pageIdField,
        title: z.string().max(2000).optional(),
        icon: z.string().max(50).nullable().optional().describe('Emoji, ou null pour retirer.'),
        cover: z.string().max(2000).nullable().optional().describe("URL d'image https, nom de dégradé, nom de couleur, ou null pour retirer."),
        properties: propertiesField,
        fullWidth: z.boolean().optional(),
        smallText: z.boolean().optional(),
        font: z.enum(['default', 'serif', 'mono']).optional(),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const id = pageIdFrom(args.pageId);
      const detail = await oriel.page(id);
      const body: UpdatePageRequest = {};
      const warnings: string[] = [];
      if (args.title !== undefined) body.title = args.title;
      if (args.icon !== undefined) body.icon = args.icon;
      if (args.cover !== undefined) body.cover = parseCover(args.cover);
      const format: Record<string, unknown> = {};
      if (args.fullWidth !== undefined) format.fullWidth = args.fullWidth;
      if (args.smallText !== undefined) format.smallText = args.smallText;
      if (args.font !== undefined) format.font = args.font;
      if (Object.keys(format).length) body.format = format;
      if (args.properties && Object.keys(args.properties).length) {
        if (!detail.parentDatabase) throw new Error("Cette page n'est pas une ligne de base : elle n'a pas de propriétés.");
        const db = await loadDatabase(oriel, detail.parentDatabase.id);
        const me = await oriel.me();
        const conv = new ValueConverter(oriel, db, me.user.id);
        const { properties, title } = await conv.convertAll(args.properties);
        const added = await conv.flushOptions();
        if (added.length) warnings.push(`options ajoutées : ${added.join(', ')}`);
        body.properties = properties;
        if (title !== undefined && body.title === undefined) body.title = title;
      }
      const page = await oriel.client.patch<Page>(`/pages/${encodeURIComponent(id)}`, body);
      oriel.invalidate(page.workspaceId);
      return { id: page.id, titre: page.title, lien: ref(page.id), avertissements: warnings };
    },
  });

  tool(server, ctx, 'oriel_write_page_content', {
    title: 'Écrire le contenu',
    description: `Écrit le contenu d'une page. mode 'append' (défaut) ajoute à la fin ; mode 'replace' REMPLACE TOUT LE CONTENU (destructif : l'ancienne version reste dans l'historique de la page ; les ancrages de commentaires et les couleurs sont perdus si le Markdown ne les contient pas — lisez d'abord la page). Fournir markdown OU blocks (JSON BlockNote, comme renvoyé par oriel_read_page format 'blocks'). ${markdownHelp}`,
    input: z
      .object({
        pageId: pageIdField,
        markdown: z.string().max(1_000_000).optional(),
        blocks: z.array(z.record(z.string(), z.unknown())).max(5000).optional().describe('Blocs BlockNote (alternative sans perte au Markdown).'),
        mode: z.enum(['append', 'replace']).optional().describe("'append' (défaut) ou 'replace' (destructif)."),
      })
      .strict(),
    annotations: DESTRUCTIVE,
    run: async (args, { oriel }) => {
      if ((args.markdown === undefined) === (args.blocks === undefined)) throw new Error('Fournissez soit markdown, soit blocks.');
      const id = pageIdFrom(args.pageId);
      const { page } = await oriel.page(id);
      const res = await writePageContent(oriel, {
        workspaceId: page.workspaceId,
        pageId: id,
        mode: args.mode ?? 'append',
        markdown: args.markdown,
        blocks: args.blocks as never,
      });
      return { id, mode: args.mode ?? 'append', blocsEcrits: res.blocks, avertissements: res.warnings };
    },
  });

  tool(server, ctx, 'oriel_move_page', {
    title: 'Déplacer une page',
    description: "Déplace une page (ou une base) sous une autre page ou à la racine de son espace. Les lignes de base ne peuvent que changer d'ordre dans leur base.",
    input: z
      .object({
        pageId: pageIdField,
        parent: parentField,
        after: z.string().max(500).nullable().optional().describe("Placer après cette page sœur (id), null = en premier, omis = en dernier."),
        visibility: z.enum(['workspace', 'private']).optional().describe('Racine : section de la barre latérale.'),
      })
      .strict(),
    annotations: WRITE,
    run: async (args, { oriel }) => {
      const id = pageIdFrom(args.pageId);
      const parent = await resolveParent(oriel, args.parent);
      const page = await oriel.client.post<Page>(`/pages/${encodeURIComponent(id)}/move`, {
        parentType: parent.parentType,
        parentId: parent.parentId,
        ...(args.after !== undefined ? { after: args.after === null ? null : pageIdFrom(args.after) } : {}),
        ...(args.visibility ? { visibility: args.visibility } : {}),
      });
      oriel.invalidate(page.workspaceId);
      return { id: page.id, titre: page.title, parent: { type: page.parentType, id: page.parentId } };
    },
  });

  tool(server, ctx, 'oriel_trash_page', {
    title: 'Mettre à la corbeille',
    description: "DESTRUCTIF : met une page à la corbeille avec toutes ses sous-pages (et, pour une base, ses lignes). Restaurable pendant 30 jours (oriel_restore_page) puis supprimé définitivement.",
    input: z.object({ pageId: pageIdField }).strict(),
    annotations: DESTRUCTIVE,
    run: async ({ pageId }, { oriel }) => {
      const id = pageIdFrom(pageId);
      const { page } = await oriel.page(id);
      await oriel.client.post(`/pages/${encodeURIComponent(id)}/trash`);
      oriel.invalidate(page.workspaceId);
      return { id, titre: page.title, corbeille: true };
    },
  });

  tool(server, ctx, 'oriel_restore_page', {
    title: 'Restaurer depuis la corbeille',
    description: 'Restaure une page mise à la corbeille (avec les sous-pages supprimées en même temps).',
    input: z.object({ pageId: pageIdField }).strict(),
    annotations: WRITE,
    run: async ({ pageId }, { oriel }) => {
      const page = await oriel.client.post<Page>(`/pages/${encodeURIComponent(pageIdFrom(pageId))}/restore`);
      oriel.invalidate(page.workspaceId);
      return { id: page.id, titre: page.title, lien: ref(page.id) };
    },
  });

  tool(server, ctx, 'oriel_duplicate_page', {
    title: 'Dupliquer une page',
    description: 'Copie profonde d’une page (sous-pages, bases avec schéma, vues et lignes, contenu) ; la copie est titrée « (copie) ».',
    input: z.object({ pageId: pageIdField }).strict(),
    annotations: WRITE,
    run: async ({ pageId }, { oriel }) => {
      const page = await oriel.client.post<Page>(`/pages/${encodeURIComponent(pageIdFrom(pageId))}/duplicate`);
      oriel.invalidate(page.workspaceId);
      return { id: page.id, titre: page.title, lien: ref(page.id), url: oriel.webUrl(page.workspaceId, page.id) };
    },
  });
}
