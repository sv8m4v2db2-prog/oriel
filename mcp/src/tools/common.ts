// Shared helpers of the MCP tools: registration with error handling, compact results, parents.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Page, ParentType, TreeNode } from '@oriel/shared';
import type { Oriel } from '../oriel.js';
import { looseKey } from '../oriel.js';
import { explainError } from '../client.js';
import { formatRef, pageIdFrom } from '../content/links.js';

export interface ToolContext {
  oriel: Oriel;
}

type Shape = z.ZodObject<z.ZodRawShape>;

export interface ToolDef<S extends Shape> {
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<CallToolResult | string | object>;
}

/** Registers a tool: strict input, French error messages for API errors, compact JSON results. */
export function tool<S extends Shape>(server: McpServer, ctx: ToolContext, name: string, def: ToolDef<S>): void {
  server.registerTool(
    name,
    { title: def.title, description: def.description, inputSchema: def.input, annotations: def.annotations },
    (async (args: z.output<S>) => {
      try {
        const out = await def.run(args, ctx);
        if (typeof out === 'string') return bounded(text(out));
        if (out && typeof out === 'object' && 'content' in out && Array.isArray((out as CallToolResult).content)) return bounded(out as CallToolResult);
        return bounded(json(out));
      } catch (err) {
        return { content: [{ type: 'text', text: explainError(err) }], isError: true };
      }
    }) as never,
  );
}

/** Characters of text returned by one tool call (QA-MCP-02; same order of size as QA-AGT-04). */
export const MAX_RESULT_CHARS = 200_000;

/**
 * Caps the text of a result: a huge page or table would otherwise flood the conversation (and the
 * client). The note says what was cut and warns against rewriting a page from a truncated read.
 */
export function bounded(result: CallToolResult, max = MAX_RESULT_CHARS): CallToolResult {
  let budget = max;
  let cut = 0;
  const content = result.content.map((part) => {
    if (part.type !== 'text') return part;
    if (part.text.length <= budget) {
      budget -= part.text.length;
      return part;
    }
    cut += part.text.length - budget;
    const kept = part.text.slice(0, budget);
    budget = 0;
    return { ...part, text: kept };
  });
  if (cut === 0) return result;
  content.push({
    type: 'text',
    text: `[Résultat tronqué : ${cut} caractères au-delà de la limite de ${max}. Le contenu ci-dessus est incomplet : ne l'utilisez pas pour réécrire la page en mode 'replace'. Réduisez la demande (limit / offset, properties, includeContent: false).]`,
  });
  return { ...result, content };
}

export const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
export const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, dropEmpty) }] });

/** JSON replacer: omit null / undefined / empty arrays (compact results). */
function dropEmpty(_key: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// --- shared input fields ------------------------------------------------------------

export const workspaceField = z
  .string()
  .max(200)
  .optional()
  .describe("Espace de travail (id ou nom). Par défaut : ORIEL_WORKSPACE, sinon l'espace du jeton ou le premier.");
export const pageIdField = z
  .string()
  .min(1)
  .max(500)
  .describe('Id de la page (ou lien oriel://page/<id>, ou URL de la page dans Oriel).');

export const parentField = z
  .object({
    type: z.enum(['workspace', 'page', 'database']).describe("'workspace' = racine de l'espace, 'page' = sous-page, 'database' = ligne d'une base."),
    id: z.string().max(500).optional().describe("Id de la page / de la base parente, ou de l'espace pour 'workspace' (facultatif)."),
  })
  .strict();

export type ParentInput = z.output<typeof parentField>;

export interface ResolvedParent {
  workspaceId: string;
  parentType: ParentType;
  parentId: string;
  /** Detail of the parent page / database (absent for the workspace root). */
  page: Page | null;
}

export async function resolveParent(oriel: Oriel, parent: ParentInput): Promise<ResolvedParent> {
  if (parent.type === 'workspace') {
    const ws = await oriel.workspace(parent.id);
    return { workspaceId: ws.id, parentType: 'workspace', parentId: ws.id, page: null };
  }
  if (!parent.id) throw new Error(`Indiquez l'id de la ${parent.type === 'page' ? 'page' : 'base'} parente.`);
  const { page } = await oriel.page(pageIdFrom(parent.id));
  if (parent.type === 'database' && page.kind !== 'database') throw new Error(`« ${page.title || 'Sans titre'} » n'est pas une base de données.`);
  if (parent.type === 'page' && page.kind !== 'page') {
    throw new Error(`« ${page.title || 'Sans titre'} » est une base de données : utilisez parent.type = 'database' pour y créer une ligne.`);
  }
  return { workspaceId: page.workspaceId, parentType: parent.type, parentId: page.id, page };
}

export const ref = (id: string) => formatRef({ kind: 'page', id });

export function kindLabel(node: Pick<TreeNode, 'kind' | 'parentType'>): 'page' | 'base' | 'ligne' {
  if (node.kind === 'database') return 'base';
  return node.parentType === 'database' ? 'ligne' : 'page';
}

/** Database (tree node) by id, link or title (unique). */
export async function findDatabase(oriel: Oriel, workspaceId: string, input: string): Promise<string> {
  const id = pageIdFrom(input);
  const tree = await oriel.tree(workspaceId);
  const byId = tree.find((n) => n.id === id && n.kind === 'database');
  if (byId) return byId.id;
  const matches = tree.filter((n) => n.kind === 'database' && looseKey(n.title) === looseKey(input));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`Plusieurs bases s'appellent « ${input} » : utilisez leur id (${matches.map((m) => m.id).join(', ')}).`);
  // Not in the tree (e.g. trashed parent): let the API decide.
  return id;
}
