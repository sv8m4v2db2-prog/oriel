// Person and date mentions inside page documents (Yjs). Called when a document is stored:
// notifies newly mentioned people (diff against the mentions known for the page) and keeps the
// date reminders table in sync with the `dateMention` items whose reminder is on.
import * as Y from 'yjs';
import { COLLAB_FRAGMENT, COLLAB_TYPES } from '@oriel/shared';
import type { AppContext } from '../context.js';
import { getPageRow } from '../access.js';
import { memberNameLookup } from './comments.js';
import { notify } from './notify.js';
import { parisToday } from './time.js';

export interface DocMention {
  userId: string;
  /** Text of the block containing the mention (mentions rendered as @{userId}). */
  context: string;
}

export interface DocReminder {
  userId: string;
  date: string;
  /** Yjs items holding the `userId` attribute of the dateMention nodes (when and through whom it was written). */
  sources: Y.ID[];
}

export interface CollabRefs {
  mentions: DocMention[];
  reminders: DocReminder[];
}

/**
 * Who may own the reminders that appeared since the last store (QA-COL-07). Yjs does not record
 * who inserted a node, so the `userId` of a dateMention is whatever an editor wrote. A new reminder
 * is only scheduled for a user whose own connection changed the document during the save window
 * (the actor included; concurrent editors keep their own reminders), and only when that `userId`
 * attribute was written during the window: a reminder planted for someone is not adopted later,
 * when that person edits the page. The web client only writes reminders for the current user
 * ("Me rappeler").
 */
export interface ReminderAuthors {
  writers: ReadonlySet<string>;
  isRecent(id: Y.ID): boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function attr(el: Y.XmlElement, name: string): unknown {
  return el.getAttribute(name) as unknown;
}

const isTrue = (v: unknown) => v === true || v === 'true';

/** Children pushed in reverse so that popping the stack visits them in document order. */
function pushReversed<T>(stack: T[], items: T[]): void {
  for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]!);
}

// The walkers below are iterative (explicit stack): /collab documents may nest arbitrarily deep.
function inlineText(el: Y.XmlElement): string {
  let out = '';
  const stack: unknown[] = [];
  pushReversed(stack, el.toArray() as unknown[]);
  while (stack.length > 0) {
    const child = stack.pop();
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown }>) if (typeof op.insert === 'string') out += op.insert;
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === COLLAB_TYPES.userMention) out += `@{${String(attr(child, 'userId') ?? '')}}`;
      else if (child.nodeName === COLLAB_TYPES.dateMention) out += String(attr(child, 'date') ?? '');
      else if (child.nodeName !== 'blockGroup') pushReversed(stack, child.toArray() as unknown[]);
    }
  }
  return out;
}

/** Person mentions and active date reminders of a page document. */
export function extractCollabRefs(doc: Y.Doc): CollabRefs {
  const mentions = new Map<string, DocMention>();
  const reminders = new Map<string, DocReminder>();
  const stack: Array<[unknown, Y.XmlElement | null]> = [];
  const pushChildren = (nodes: unknown[], parent: Y.XmlElement | null) => pushReversed(stack, nodes.map((n): [unknown, Y.XmlElement | null] => [n, parent]));
  pushChildren(doc.getXmlFragment(COLLAB_FRAGMENT).toArray(), null);
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === COLLAB_TYPES.userMention) {
      const userId = attr(node, 'userId');
      if (typeof userId === 'string' && userId && !mentions.has(userId)) {
        mentions.set(userId, { userId, context: parent ? inlineText(parent).replace(/\s+/g, ' ').trim() : '' });
      }
    } else if (node.nodeName === COLLAB_TYPES.dateMention) {
      const date = attr(node, 'date');
      const userId = attr(node, 'userId');
      if (isTrue(attr(node, 'reminder')) && typeof date === 'string' && DATE_RE.test(date) && typeof userId === 'string' && userId) {
        const key = `${userId}|${date}`;
        const source = node._map.get('userId')?.id;
        const reminder = reminders.get(key) ?? { userId, date, sources: [] };
        if (source) reminder.sources.push(source);
        reminders.set(key, reminder);
      }
    }
    pushChildren(node.toArray(), node);
  }
  return { mentions: [...mentions.values()], reminders: [...reminders.values()] };
}

/**
 * Hook called by the collaboration layer right before a page document is persisted.
 * `actorId`: last editor (null for anonymous/system stores). `authors`: who may own new
 * reminders (without it, only the actor). Never throws.
 */
export function processStoredDocument(
  ctx: AppContext,
  pageId: string,
  doc: Y.Doc,
  actorId: string | null,
  authors?: ReminderAuthors,
  log?: (msg: string, err?: unknown) => void,
): void {
  try {
    const refs = extractCollabRefs(doc);
    applyCollabRefs(ctx, pageId, refs, actorId, authors);
  } catch (err) {
    log?.('collab: traitement des mentions impossible', err);
  }
}

export function applyCollabRefs(ctx: AppContext, pageId: string, refs: CollabRefs, actorId: string | null, authors?: ReminderAuthors): void {
  const { db } = ctx;
  db.tx(() => {
    const page = getPageRow(db, pageId);
    if (!page) return;
    const initialized = !!db.get('SELECT 1 AS x FROM collab_doc_state WHERE page_id = ?', pageId);
    // Documents that existed before this module knew about them (older pages, duplicates,
    // imports) are indexed silently the first time: only later additions notify.
    const silent = !initialized && !!db.get('SELECT 1 AS x FROM documents WHERE page_id = ?', pageId);
    if (!initialized) db.run('INSERT OR IGNORE INTO collab_doc_state (page_id, initialized_at) VALUES (?, ?)', pageId, Date.now());

    // --- person mentions -----------------------------------------------------------
    const previous = new Set(db.all<{ user_id: string }>('SELECT user_id FROM collab_page_mentions WHERE page_id = ?', pageId).map((r) => r.user_id));
    const current = new Map(refs.mentions.map((m) => [m.userId, m]));
    for (const uid of previous) if (!current.has(uid)) db.run('DELETE FROM collab_page_mentions WHERE page_id = ? AND user_id = ?', pageId, uid);
    const added = [...current.values()].filter((m) => !previous.has(m.userId));
    for (const m of added) db.run('INSERT OR IGNORE INTO collab_page_mentions (page_id, user_id) VALUES (?, ?)', pageId, m.userId);
    if (!silent && actorId && page.trashed_at === null) {
      const nameOf = memberNameLookup(db, page.workspace_id);
      for (const m of added) {
        if (m.userId === actorId) continue;
        notify(ctx, {
          userId: m.userId,
          workspaceId: page.workspace_id,
          type: 'mention',
          actorId,
          pageId,
          excerpt: m.context.replace(/@\{([^}]*)\}/g, (_s, id: string) => `@${nameOf(id)}`),
        });
      }
    }

    // --- date reminders --------------------------------------------------------------
    const today = parisToday();
    const wanted = new Map(refs.reminders.map((r) => [`${r.userId}|${r.date}`, r]));
    const existing = db.all<{ user_id: string; date: string; fired_at: number | null }>(
      'SELECT user_id, date, fired_at FROM collab_reminders WHERE page_id = ?',
      pageId,
    );
    const have = new Set(existing.map((r) => `${r.user_id}|${r.date}`));
    for (const r of existing) {
      if (r.fired_at === null && !wanted.has(`${r.user_id}|${r.date}`)) {
        db.run('DELETE FROM collab_reminders WHERE page_id = ? AND user_id = ? AND date = ?', pageId, r.user_id, r.date);
      }
    }
    // New reminders written for someone else are ignored (QA-COL-07, see ReminderAuthors).
    const mayOwn = (r: DocReminder) =>
      (r.userId === actorId || !!authors?.writers.has(r.userId)) && (!authors || r.sources.some((id) => authors.isRecent(id)));
    for (const [key, r] of wanted) {
      if (have.has(key) || r.date < today) continue;
      if (!mayOwn(r)) continue;
      if (!db.get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', page.workspace_id, r.userId)) continue;
      db.run(
        'INSERT OR IGNORE INTO collab_reminders (page_id, user_id, date, workspace_id, created_at, fired_at) VALUES (?, ?, ?, ?, ?, NULL)',
        pageId,
        r.userId,
        r.date,
        page.workspace_id,
        Date.now(),
      );
    }
  });
}
