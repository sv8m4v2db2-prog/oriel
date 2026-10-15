// Tools of the brief agent, in a fixed order (stable prompt-cache prefix). The four reading tools
// are read-only and scoped to one workspace through WorkspaceReader; `publier_brief` delivers the
// final answer (strict schema), which the agent loop detects to stop.
import { z } from 'zod';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BriefContent } from '@oriel/shared';
import { DEFAULT_PAGE_CHARS, DEFAULT_ROWS, MAX_PAGE_CHARS, MAX_ROWS, type WorkspaceReader } from './reader.js';
import { PUBLISH_BRIEF_INPUT_SCHEMA, publishBriefSchema, sanitizeBrief } from './brief.js';

export const PUBLISH_TOOL = 'publier_brief';

/** Hard upper bound of one tool result (characters, ~40k tokens): bounds the cost of a turn whatever the data. */
export const MAX_TOOL_RESULT_CHARS = 150_000;

const json = (value: unknown) => {
  const out = JSON.stringify(value);
  if (out.length > MAX_TOOL_RESULT_CHARS) {
    throw new ToolError('Résultat trop volumineux : précise la demande (période, statut, limite ou maxCaracteres plus petits).');
  }
  return out;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pageIdSchema = z.string().min(1).max(128);

export interface BriefTools {
  tools: BetaRunnableTool[];
  /** Set once `publier_brief` received a valid payload. */
  published(): { content: BriefContent; dropped: number } | null;
}

export function buildBriefTools(reader: WorkspaceReader, sourceIds: string[]): BriefTools {
  let published: { content: BriefContent; dropped: number } | null = null;

  const listSources = betaZodTool({
    name: 'lister_sources',
    description:
      'Liste les bases « Projets » à analyser : propriétés (dates, statuts avec leur groupe, personnes, relations), ' +
      'nombre de lignes, de tâches non terminées et en retard, et les bases insérées dans les pages de leurs lignes ' +
      '(rétro-plannings par projet).',
    inputSchema: z.object({}),
    run: () => json(reader.listSources(sourceIds)),
  });

  const queryDatabase = betaZodTool({
    name: 'interroger_base',
    description:
      'Renvoie les lignes d’une base (titre, identifiant, propriétés lisibles, groupe de statut, retard), triées par date. ' +
      'Filtre facultatif sur la période de la propriété date principale et sur le groupe de statut.',
    inputSchema: z.object({
      baseId: pageIdSchema.describe('Identifiant de la base.'),
      depuis: z.string().regex(DATE).optional().describe('Début de période AAAA-MM-JJ (inclus).'),
      jusqu_a: z.string().regex(DATE).optional().describe('Fin de période AAAA-MM-JJ (incluse).'),
      statut: z
        .enum(['todo', 'in_progress', 'done', 'non_termine'])
        .optional()
        .describe('Groupe de statut ; « non_termine » = à faire ou en cours.'),
      limite: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Nombre maximal de lignes (défaut ${DEFAULT_ROWS}).`),
    }),
    run: (input) => {
      const result = reader.queryDatabase(input);
      if (!result) throw new ToolError('Base introuvable ou inaccessible. Utilise un identifiant renvoyé par lister_sources ou lire_page.');
      return json(result);
    },
  });

  const readPage = betaZodTool({
    name: 'lire_page',
    description:
      'Lit une page : titre, chemin, propriétés (si c’est une ligne de base), contenu texte, sous-pages et bases ' +
      '(dont les bases insérées dans la page).',
    inputSchema: z.object({
      pageId: pageIdSchema.describe('Identifiant de la page.'),
      maxCaracteres: z
        .number()
        .int()
        .min(200)
        .max(MAX_PAGE_CHARS)
        .optional()
        .describe(`Longueur maximale du contenu renvoyé (défaut ${DEFAULT_PAGE_CHARS}).`),
    }),
    run: (input) => {
      const result = reader.readPage(input);
      if (!result) throw new ToolError('Page introuvable ou inaccessible.');
      return json(result);
    },
  });

  const search = betaZodTool({
    name: 'rechercher',
    description: 'Recherche plein texte dans les titres et contenus des pages de l’espace (15 résultats au plus).',
    inputSchema: z.object({ requete: z.string().min(1).max(200).describe('Mots à rechercher.') }),
    run: (input) => json(reader.search(input.requete)),
  });

  const publish: BetaRunnableTool = {
    ...betaTool({
      name: PUBLISH_TOOL,
      description:
        'Publie le brief du jour et termine l’analyse. À appeler une seule fois, avec toutes les sections ' +
        '(listes vides si rien à signaler). Les identifiants doivent provenir des outils.',
      inputSchema: PUBLISH_BRIEF_INPUT_SCHEMA,
      run: (input: unknown) => {
        const parsed = publishBriefSchema.safeParse(input);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new ToolError(`Brief invalide${issue?.path.length ? ` (${issue.path.join('.')})` : ''} : ${issue?.message ?? 'format incorrect'}. Corrige et rappelle publier_brief.`);
        }
        published = sanitizeBrief(parsed.data, reader);
        return 'Brief publié.';
      },
    }),
    strict: true,
  };

  return {
    tools: [listSources, queryDatabase, readPage, search, publish],
    published: () => published,
  };
}
