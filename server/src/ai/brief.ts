// The `publier_brief` payload: strict JSON schema sent to the model, server-side validation
// (zod, lenient on sizes) and sanitization against the workspace (unknown page ids dropped).
import { z } from 'zod';
import type { BriefContent, BriefItem, BriefLink, BriefProject, BriefRisk } from '@oriel/shared';
import type { WorkspaceReader } from './reader.js';

const nullableString = <D extends string>(description: D) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description }) as const;

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titre', 'pageId', 'projetId', 'echeance', 'responsables', 'note'],
  properties: {
    titre: { type: 'string', description: 'Intitulé court de la tâche.' },
    pageId: { type: 'string', description: 'Identifiant de la page de la tâche (renvoyé par un outil).' },
    projetId: nullableString('Identifiant de la page du projet concerné, ou null.'),
    echeance: nullableString('Échéance AAAA-MM-JJ, ou null.'),
    responsables: { type: 'array', items: { type: 'string' }, description: 'Noms des personnes assignées.' },
    note: { type: 'string', description: 'Précision utile en une phrase, ou chaîne vide.' },
  },
} as const;

/** Input schema of `publier_brief` (strict tool use: every property required, no extra keys). */
export const PUBLISH_BRIEF_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resume', 'priorites', 'en_retard', 'a_venir', 'risques', 'projets'],
  properties: {
    resume: { type: 'string', description: 'Synthèse de 3 à 5 phrases.' },
    priorites: { type: 'array', items: ITEM_SCHEMA, description: 'Actions prioritaires du jour, les plus importantes d’abord.' },
    en_retard: { type: 'array', items: ITEM_SCHEMA, description: 'Tâches non terminées dont l’échéance est passée.' },
    a_venir: { type: 'array', items: ITEM_SCHEMA, description: 'Tâches non terminées à échéance dans les 7 prochains jours.' },
    risques: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'gravite', 'pages'],
        properties: {
          description: { type: 'string' },
          gravite: { type: 'string', enum: ['haute', 'moyenne', 'basse'] },
          pages: { type: 'array', items: { type: 'string' }, description: 'Identifiants des pages concernées.' },
        },
      },
    },
    projets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pageId', 'titre', 'etat', 'commentaire'],
        properties: {
          pageId: { type: 'string', description: 'Identifiant de la page du projet.' },
          titre: { type: 'string' },
          etat: { type: 'string', enum: ['en_bonne_voie', 'a_surveiller', 'en_retard'] },
          commentaire: { type: 'string' },
        },
      },
    },
  },
} as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
const id = z.string().max(128);
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((a) => a.slice(0, max));

const itemSchema = z.object({
  titre: text(300),
  pageId: id,
  projetId: id.nullable(),
  echeance: z
    .string()
    .nullable()
    .transform((v) => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null)),
  responsables: list(text(120), 20),
  note: text(1000),
});

export const publishBriefSchema = z.object({
  resume: text(4000),
  priorites: list(itemSchema, 30),
  en_retard: list(itemSchema, 60),
  a_venir: list(itemSchema, 60),
  risques: list(
    z.object({ description: text(1000), gravite: z.enum(['haute', 'moyenne', 'basse']), pages: list(id, 20) }),
    30,
  ),
  projets: list(z.object({ pageId: id, titre: text(300), etat: z.enum(['en_bonne_voie', 'a_surveiller', 'en_retard']), commentaire: text(1000) }), 60),
});

export type PublishBriefInput = z.output<typeof publishBriefSchema>;

/** Keeps only references to pages the agent may see, and adds how each link opens. */
export function sanitizeBrief(input: PublishBriefInput, reader: WorkspaceReader): { content: BriefContent; dropped: number } {
  let dropped = 0;
  const items = (list: PublishBriefInput['priorites']): BriefItem[] =>
    list.flatMap((item) => {
      const page = reader.page(item.pageId);
      if (!page) {
        dropped++;
        return [];
      }
      // A project row listed as an item of its own project would just link to itself.
      const project = item.projetId && item.projetId !== page.id ? reader.page(item.projetId) : null;
      return [
        {
          titre: item.titre || page.title || 'Sans titre',
          pageId: page.id,
          cible: reader.target(page),
          projetId: project?.id ?? null,
          projetTitre: project ? project.title || 'Sans titre' : null,
          echeance: item.echeance,
          responsables: item.responsables.filter(Boolean),
          note: item.note,
        },
      ];
    });
  const risks: BriefRisk[] = input.risques.map((r) => ({
    description: r.description,
    gravite: r.gravite,
    pages: [...new Set(r.pages)].flatMap((pid): BriefLink[] => {
      const page = reader.page(pid);
      if (!page) {
        dropped++;
        return [];
      }
      return [{ id: page.id, titre: page.title || 'Sans titre', cible: reader.target(page) }];
    }),
  }));
  const projects: BriefProject[] = input.projets.flatMap((p) => {
    const page = reader.page(p.pageId);
    if (!page) {
      dropped++;
      return [];
    }
    return [{ pageId: page.id, cible: reader.target(page), titre: p.titre || page.title || 'Sans titre', etat: p.etat, commentaire: p.commentaire }];
  });
  return {
    content: {
      resume: input.resume,
      priorites: items(input.priorites),
      en_retard: items(input.en_retard),
      a_venir: items(input.a_venir),
      risques: risks.filter((r) => r.description),
      projets: projects,
    },
    dropped,
  };
}

const listOf = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);

/**
 * Briefs are stored snapshots, read long after they were generated (QA-AGT-05): a page listed then may
 * since have been made private, trashed or moved to another workspace. On every read, references are
 * checked again with the agent's own rules (`reader.page`: same workspace, visible to every member, not
 * trashed): items and project points of a page that is no longer visible are dropped (their title and
 * note are about that page), risk links are pruned and an item's project is cleared. Links follow the
 * current page title. The free-text summary and risk descriptions are kept as written: they cannot be
 * filtered.
 */
export function visibleBriefContent(content: BriefContent, reader: WorkspaceReader): BriefContent {
  const items = (list: BriefItem[] | undefined): BriefItem[] =>
    listOf(list).flatMap((item) => {
      const page = reader.page(item.pageId);
      if (!page) return [];
      const project = item.projetId ? reader.page(item.projetId) : null;
      return [{ ...item, cible: reader.target(page), projetId: project?.id ?? null, projetTitre: project ? project.title || 'Sans titre' : null }];
    });
  return {
    resume: content.resume,
    priorites: items(content.priorites),
    en_retard: items(content.en_retard),
    a_venir: items(content.a_venir),
    risques: listOf(content.risques).map((r) => ({
      ...r,
      pages: listOf(r.pages).flatMap((link): BriefLink[] => {
        const page = reader.page(link.id);
        return page ? [{ id: page.id, titre: page.title || 'Sans titre', cible: reader.target(page) }] : [];
      }),
    })),
    projets: listOf(content.projets).flatMap((p): BriefProject[] => {
      const page = reader.page(p.pageId);
      return page ? [{ ...p, cible: reader.target(page) }] : [];
    }),
  };
}
