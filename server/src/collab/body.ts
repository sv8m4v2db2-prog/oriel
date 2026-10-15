// Comment bodies are BlockNote documents (JSON). The server validates their size/shape and reads
// plain text and mentions from them; it never renders them.
import { COLLAB_TYPES, type CommentBody } from '@oriel/shared';
import { badRequest } from '../errors.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DEPTH = 12;

function depthOk(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((v) => depthOk(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).every((v) => depthOk(v, depth + 1));
  return true;
}

/** Throws 400 unless `body` is a non-empty, reasonably sized array of blocks. */
export function validateBody(body: unknown): CommentBody {
  if (!Array.isArray(body) || body.length === 0) throw badRequest('Le commentaire est vide.');
  if (JSON.stringify(body).length > MAX_BODY_BYTES) throw badRequest('Commentaire trop long.');
  if (!depthOk(body, 0)) throw badRequest('Commentaire invalide.');
  if (!body.every((b) => b && typeof b === 'object' && !Array.isArray(b))) throw badRequest('Commentaire invalide.');
  return body;
}

interface InlineItem {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  props?: Record<string, unknown>;
}

function walkInline(items: unknown, onText: (t: string) => void, onMention: (userId: string) => void, onDate: (date: string) => void): void {
  if (typeof items === 'string') {
    onText(items);
    return;
  }
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (typeof raw === 'string') {
      onText(raw);
      continue;
    }
    const item = raw as InlineItem;
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') onText(item.text);
    else if (item.type === 'link') walkInline(item.content, onText, onMention, onDate);
    else if (item.type === COLLAB_TYPES.userMention && typeof item.props?.userId === 'string') onMention(item.props.userId);
    else if (item.type === COLLAB_TYPES.dateMention && typeof item.props?.date === 'string') onDate(item.props.date);
  }
}

function walkBlocks(blocks: unknown, visit: (block: { content?: unknown }) => void): void {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    visit(b as { content?: unknown });
    walkBlocks((b as { children?: unknown }).children, visit);
  }
}

/** User ids mentioned in a comment body. */
export function bodyMentions(body: unknown): string[] {
  const ids = new Set<string>();
  walkBlocks(body, (b) =>
    walkInline(
      b.content,
      () => {},
      (id) => ids.add(id),
      () => {},
    ),
  );
  return [...ids];
}

export function formatFrenchDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** Plain text of a comment body (mentions rendered with `names`). */
export function bodyText(body: unknown, names: (userId: string) => string = () => 'quelqu’un'): string {
  const lines: string[] = [];
  walkBlocks(body, (b) => {
    let line = '';
    walkInline(
      b.content,
      (t) => (line += t),
      (id) => (line += `@${names(id)}`),
      (date) => (line += formatFrenchDate(date)),
    );
    lines.push(line);
  });
  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export const truncate = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
