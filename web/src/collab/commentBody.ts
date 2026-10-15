// Comment bodies come from the server as stored JSON: the server only checks their size and shape,
// any client (or API token) can post them. BlockNote throws while building a comment editor from a
// body holding an unknown block / inline content / style, or a link without content — and that error
// takes down the page editor around the comments (page discussion, comments panel) for every reader.
// Bodies are therefore rebuilt here with what the comment schema (comments.tsx) accepts.
import { COLLAB_TYPES } from '@oriel/shared';

type Styles = Record<string, true>;
interface TextItem {
  type: 'text';
  text: string;
  styles: Styles;
}
interface LinkItem {
  type: 'link';
  href: string;
  content: TextItem[];
}
interface MentionItem {
  type: string;
  props: Record<string, string | boolean>;
}
type InlineItem = TextItem | LinkItem | MentionItem;

export interface SafeCommentBlock {
  id?: string;
  type: 'paragraph';
  props: Record<string, string>;
  content: InlineItem[];
  children: SafeCommentBlock[];
}

/** Styles of the comment schema (BlockNote's defaults without colors). */
const STYLES = new Set(['bold', 'italic', 'underline', 'strike', 'code']);
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);
/** Inline contents of the comment schema besides text and links, with the type of each prop. */
const MENTIONS: Record<string, Record<string, 'string' | 'boolean'>> = {
  [COLLAB_TYPES.userMention]: { userId: 'string' },
  [COLLAB_TYPES.dateMention]: { date: 'string', reminder: 'boolean', userId: 'string' },
};
const MAX_DEPTH = 12;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function text(value: string, styles: unknown = {}): TextItem {
  const out: Styles = {};
  if (isObject(styles)) for (const [k, v] of Object.entries(styles)) if (STYLES.has(k) && v === true) out[k] = true;
  return { type: 'text', text: value, styles: out };
}

/** Plain text of anything (unknown items keep their words). */
function plainText(v: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => plainText(x, depth + 1)).join('');
  if (isObject(v)) {
    if (typeof v.text === 'string') return v.text;
    return plainText(v.content, depth + 1);
  }
  return '';
}

function inline(content: unknown): InlineItem[] {
  if (typeof content === 'string') return content ? [text(content)] : [];
  if (!Array.isArray(content)) return [];
  const out: InlineItem[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) out.push(text(item));
      continue;
    }
    if (!isObject(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push(text(item.text, item.styles));
    } else if (item.type === 'link' && typeof item.href === 'string') {
      const label = inline(item.content).filter((c): c is TextItem => c.type === 'text');
      if (label.length) out.push({ type: 'link', href: item.href, content: label });
      else if (item.href) out.push(text(item.href));
    } else if (typeof item.type === 'string' && Object.hasOwn(MENTIONS, item.type)) {
      const schema = MENTIONS[item.type]!;
      const raw = isObject(item.props) ? item.props : {};
      const props: Record<string, string | boolean> = {};
      for (const [k, kind] of Object.entries(schema)) props[k] = kind === 'boolean' ? raw[k] === true : typeof raw[k] === 'string' ? (raw[k] as string) : '';
      out.push({ type: item.type, props });
    } else {
      const words = plainText(item);
      if (words) out.push(text(words));
    }
  }
  return out;
}

function block(b: unknown, depth: number): SafeCommentBlock | null {
  if (!isObject(b)) return typeof b === 'string' && b ? { type: 'paragraph', props: {}, content: [text(b)], children: [] } : null;
  const props: Record<string, string> = {};
  const raw = isObject(b.props) ? b.props : {};
  for (const k of ['textColor', 'backgroundColor'] as const) if (typeof raw[k] === 'string') props[k] = raw[k] as string;
  if (typeof raw.textAlignment === 'string' && ALIGNMENTS.has(raw.textAlignment)) props.textAlignment = raw.textAlignment;
  // Other block types (none in the comment schema) keep their text as a paragraph.
  const out: SafeCommentBlock = { type: 'paragraph', props, content: inline(b.content), children: [] };
  if (typeof b.id === 'string' && b.id) out.id = b.id;
  if (Array.isArray(b.children) && depth < MAX_DEPTH) {
    for (const c of b.children) {
      const child = block(c, depth + 1);
      if (child) out.children.push(child);
    }
  }
  return out;
}

/** Body that the comment editor can always display (same content for bodies written by Oriel). */
export function safeCommentBody(body: unknown): SafeCommentBlock[] {
  const blocks = (Array.isArray(body) ? body : [body]).map((b) => block(b, 0)).filter((b): b is SafeCommentBlock => !!b);
  return blocks.length ? blocks : [{ type: 'paragraph', props: {}, content: [], children: [] }];
}
