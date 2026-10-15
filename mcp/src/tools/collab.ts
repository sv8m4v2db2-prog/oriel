// Tools: comments, notifications (inbox) and the AI « Brief du jour ».
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BRIEF_PROJECT_STATE_LABELS,
  BRIEF_SEVERITY_LABELS,
  type AiLatestBriefResponse,
  type BriefItem,
  type BriefLink,
  type CommentItem,
  type CommentThread,
  type NotificationType,
  type NotificationsResponse,
  type ThreadsResponse,
} from '@oriel/shared';
import { pageIdFrom } from '../content/links.js';
import { markdownForPage } from '../content/pageContent.js';
import type { Blk } from '../content/editor.js';
import { READ, WRITE, pageIdField, ref, tool, workspaceField, type ToolContext } from './common.js';

const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  mention: 'mention dans une page',
  comment_mention: 'mention dans un commentaire',
  comment: 'commentaire sur votre page',
  reply: 'réponse dans une discussion',
  reminder: 'rappel',
  invite_accepted: 'invitation acceptée',
  form_response: 'réponse à un formulaire',
  teamspace_request: 'demande d’accès à un espace d’équipe',
  teamspace_request_granted: 'accès à un espace d’équipe accordé',
};

/** Plain text of a comment body (BlockNote blocks; mentions rendered as @Nom / dates). */
function bodyText(body: unknown, userName: (id: string) => string): string {
  const inline = (items: unknown): string => {
    if (typeof items === 'string') return items;
    if (!Array.isArray(items)) return '';
    return items
      .map((raw) => {
        const item = raw as { type?: string; text?: string; content?: unknown; props?: Record<string, unknown> };
        if (item?.type === 'text') return item.text ?? '';
        if (item?.type === 'link') return inline(item.content);
        if (item?.type === 'userMention') return `@${userName(String(item.props?.userId ?? ''))}`;
        if (item?.type === 'dateMention') return `📅 ${String(item.props?.date ?? '')}`;
        if (item?.type === 'pageMention') return `[page ${String(item.props?.pageId ?? '')}]`;
        return '';
      })
      .join('');
  };
  const lines: string[] = [];
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as Array<{ content?: unknown; children?: unknown }>) {
      const t = inline(b?.content);
      if (t) lines.push(t);
      walk(b?.children);
    }
  };
  walk(body);
  return lines.join('\n');
}

/** Comment text (Markdown subset, mentions `[@Nom](oriel://user/<id>)`) → comment body blocks. */
async function commentBody(ctx: ToolContext, workspaceId: string, pageId: string, input: string): Promise<{ body: Blk[]; warnings: string[] }> {
  const { blocks, warnings } = await markdownForPage(ctx.oriel, workspaceId, pageId, input);
  const paragraphs: Blk[] = [];
  const walk = (list: Blk[]) => {
    for (const b of list) {
      if (Array.isArray(b.content) && b.content.length) paragraphs.push({ type: 'paragraph', content: b.content });
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  if (paragraphs.length === 0) paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: input.trim(), styles: {} }] });
  return { body: paragraphs.slice(0, 200), warnings };
}

function threadSummary(t: CommentThread, userName: (id: string) => string) {
  return {
    id: t.id,
    surLaPage: !t.anchored,
    citation: t.quote || undefined,
    resolue: t.resolved,
    commentaires: t.comments.map((c: CommentItem) => ({
      id: c.id,
      auteur: userName(c.userId),
      date: new Date(c.createdAt).toISOString(),
      texte: bodyText(c.body, userName),
      reactions: c.reactions.map((r) => `${r.emoji}×${r.userIds.length}`),
    })),
  };
}

function briefMarkdown(res: AiLatestBriefResponse): string {
  const b = res.latest;
  const lines: string[] = [];
  if (res.running) lines.push('_Un brief est en cours de génération._', '');
  if (!b?.content) {
    lines.push('Aucun brief disponible pour cet espace.');
    if (res.lastRun?.error) lines.push('', `Dernière tentative (${res.lastRun.briefDate}) : ${res.lastRun.error}`);
    return lines.join('\n');
  }
  const c = b.content;
  const link = (l: { titre: string; pageId?: string; id?: string }) => `[${l.titre}](${ref(l.pageId ?? l.id ?? '')})`;
  const item = (i: BriefItem) => {
    const extra = [i.echeance ? `échéance ${i.echeance}` : '', i.responsables.length ? i.responsables.join(', ') : '', i.projetTitre ? `projet ${i.projetTitre}` : '']
      .filter(Boolean)
      .join(' · ');
    return `- ${link(i)}${extra ? ` — ${extra}` : ''}${i.note ? ` : ${i.note}` : ''}`;
  };
  lines.push(`# Brief du ${b.briefDate}`, '', c.resume);
  const section = (title: string, items: BriefItem[]) => {
    if (items.length) lines.push('', `## ${title}`, '', ...items.map(item));
  };
  section('Priorités du jour', c.priorites);
  section('En retard', c.en_retard);
  section('À venir (7 jours)', c.a_venir);
  if (c.risques.length) {
    lines.push('', '## Risques', '');
    for (const r of c.risques) lines.push(`- **${BRIEF_SEVERITY_LABELS[r.gravite]}** — ${r.description}${r.pages.length ? ` (${r.pages.map((p: BriefLink) => link(p)).join(', ')})` : ''}`);
  }
  if (c.projets.length) {
    lines.push('', '## Projets', '');
    for (const p of c.projets) lines.push(`- ${link(p)} — ${BRIEF_PROJECT_STATE_LABELS[p.etat]} : ${p.commentaire}`);
  }
  lines.push('', `_Généré le ${new Date(b.finishedAt ?? b.startedAt).toISOString()} (${b.model})._`);
  return lines.join('\n');
}

export function registerCollabTools(server: McpServer, ctx: ToolContext): void {
  tool(server, ctx, 'oriel_list_comments', {
    title: 'Commentaires d’une page',
    description: "Discussions d'une page : commentaires de page et commentaires ancrés sur un passage (citation), auteurs, dates, réactions. Les discussions résolues sont masquées sauf includeResolved.",
    input: z.object({ pageId: pageIdField, includeResolved: z.boolean().optional() }).strict(),
    annotations: READ,
    run: async ({ pageId, includeResolved }, { oriel }) => {
      const id = pageIdFrom(pageId);
      const [res, { page }] = await Promise.all([oriel.client.get<ThreadsResponse>(`/pages/${encodeURIComponent(id)}/threads`), oriel.page(id)]);
      const names = new Map(res.users.map((u) => [u.id, u.name]));
      // Mentioned people are not in `users` (authors, resolvers, reactions only).
      if (JSON.stringify(res.threads).includes('userMention')) {
        for (const m of await oriel.members(page.workspaceId).catch(() => [])) if (!names.has(m.user.id)) names.set(m.user.id, m.user.name);
      }
      const userName = (uid: string) => names.get(uid) ?? 'membre';
      const threads = res.threads.filter((t) => includeResolved || !t.resolved);
      return {
        pageId: id,
        peutCommenter: res.canComment,
        discussions: threads.map((t) => threadSummary(t, userName)),
        resoluesMasquees: includeResolved ? 0 : res.threads.length - threads.length,
      };
    },
  });

  tool(server, ctx, 'oriel_add_comment', {
    title: 'Commenter une page',
    description:
      "Ajoute un commentaire au niveau de la page (nouvelle discussion), ou répond à une discussion existante (threadId). Texte simple ou Markdown léger ; mentionnez quelqu'un avec `[@Nom](oriel://user/<id>)` (il est notifié).",
    input: z
      .object({
        pageId: pageIdField,
        text: z.string().min(1).max(20_000),
        threadId: z.string().max(200).optional().describe('Répondre à cette discussion (id renvoyé par oriel_list_comments).'),
      })
      .strict(),
    annotations: WRITE,
    run: async ({ pageId, text, threadId }, c) => {
      const id = pageIdFrom(pageId);
      const { page } = await c.oriel.page(id);
      const { body, warnings } = await commentBody(c, page.workspaceId, id, text);
      if (threadId) {
        const comment = await c.oriel.client.post<CommentItem>(`/threads/${encodeURIComponent(threadId)}/comments`, { body });
        return { discussionId: threadId, commentaireId: comment.id, avertissements: warnings };
      }
      const thread = await c.oriel.client.post<CommentThread>(`/pages/${encodeURIComponent(id)}/threads`, { anchored: false, body });
      return { discussionId: thread.id, commentaireId: thread.comments[0]?.id, avertissements: warnings };
    },
  });

  tool(server, ctx, 'oriel_list_notifications', {
    title: 'Notifications',
    description: "Boîte de réception de l'utilisateur dans un espace : mentions, commentaires, réponses, rappels, invitations acceptées (les plus récentes d'abord).",
    input: z
      .object({
        workspace: workspaceField,
        filter: z.enum(['inbox', 'archived']).optional().describe("'inbox' (défaut) ou 'archived'."),
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Défaut 30.'),
      })
      .strict(),
    annotations: READ,
    run: async ({ workspace, filter, unreadOnly, limit }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const res = await oriel.client.get<NotificationsResponse>(`/workspaces/${encodeURIComponent(ws.id)}/notifications?filter=${filter ?? 'inbox'}&limit=${unreadOnly ? 200 : (limit ?? 30)}`);
      const list = (unreadOnly ? res.notifications.filter((n) => n.readAt === null) : res.notifications).slice(0, limit ?? 30);
      return {
        espace: ws.name,
        nonLues: res.unread,
        notifications: list.map((n) => ({
          id: n.id,
          type: NOTIFICATION_LABELS[n.type] ?? n.type,
          date: new Date(n.createdAt).toISOString(),
          lue: n.readAt !== null,
          par: n.actor?.name,
          page: n.page ? { id: n.page.id, titre: n.page.title || 'Sans titre' } : undefined,
          extrait: n.excerpt || undefined,
          rappel: n.date ?? undefined,
        })),
      };
    },
  });

  tool(server, ctx, 'oriel_get_latest_brief', {
    title: 'Brief du jour',
    description: "Dernier « Brief du jour » généré par l'IA d’Oriel pour un espace (priorités, retards, échéances à 7 jours, risques, point par projet), en Markdown avec liens oriel://.",
    input: z.object({ workspace: workspaceField }).strict(),
    annotations: READ,
    run: async ({ workspace }, { oriel }) => {
      const ws = await oriel.workspace(workspace);
      const res = await oriel.client.get<AiLatestBriefResponse>(`/workspaces/${encodeURIComponent(ws.id)}/ai/briefs/latest`);
      return briefMarkdown(res);
    },
  });
}
