// Editor integration of the collaboration module: person/date mentions and comments.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CommentsExtension } from '@blocknote/core/comments';
import { useExtension, useExtensionState, useThreads, type DefaultReactSuggestionItem } from '@blocknote/react';
import { CommentsPanel, commentSchema, mentionScope, PageDiscussion, publishCommentsBar, scrollToDiscussion, withdrawCommentsBar } from './comments';
import { DateMention, UserMention } from './mentions';
import { peopleAndDateItems } from './mentionItems';
import { createWorkspaceUserStore, RestThreadStore, threadMeta } from './threadStore';
import './collab.css';

/** Extra inline content specs merged into the editor schema (userMention, dateMention). */
export const collabInlineContentSpecs = {
  userMention: UserMention,
  dateMention: DateMention,
};

export interface ExtraEditorContext {
  pageId: string;
  workspaceId: string | null;
  mode: 'app' | 'public' | 'preview';
  canEdit: boolean;
  user: { id: string; name: string; avatarUrl: string | null } | null;
}

/**
 * Extra options merged into `useCreateBlockNote`: the comments extension (app mode, signed-in
 * member). Referentially stable for a given page / user / write access.
 */
export function useCollabEditorOptions(ctx: ExtraEditorContext): { extensions?: unknown[] } {
  const { pageId, workspaceId, mode, canEdit } = ctx;
  const userId = ctx.user?.id ?? null;
  const setup = useMemo(() => {
    if (mode !== 'app' || !workspaceId || !userId) return null;
    const store = new RestThreadStore(pageId, userId, createWorkspaceUserStore(workspaceId), { canComment: canEdit, canModerate: false });
    return { store, options: { extensions: [CommentsExtension({ threadStore: store, resolveUsers: store.userStore, schema: commentSchema })] } };
  }, [pageId, workspaceId, mode, canEdit, userId]);
  useEffect(() => {
    if (!setup) return;
    setup.store.start();
    return () => setup.store.stop();
  }, [setup]);
  return setup ? setup.options : EMPTY;
}
const EMPTY = {};

/** Items for the `@` / `[[` suggestion menu (people, dates), appended after pages. */
export async function getCollabMentionItems(editor: unknown, ctx: ExtraEditorContext, query: string): Promise<DefaultReactSuggestionItem[]> {
  if (ctx.mode !== 'app' || !ctx.workspaceId) return [];
  return peopleAndDateItems(editor as { insertInlineContent: (c: unknown) => void }, ctx.workspaceId, query, {
    currentUserId: ctx.user?.id ?? null,
    reminders: true,
  });
}

// --- controllers ----------------------------------------------------------------------------

/** Slot element inserted into existing DOM (top of the page body). */
function useSlot(find: () => { parent: Element; before: Node | null } | null, key: unknown, className: string): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const target = find();
    if (!target) return;
    const el = document.createElement('div');
    el.className = className;
    target.parent.insertBefore(el, target.before);
    setSlot(el);
    return () => {
      el.remove();
      setSlot(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return slot;
}

function CommentsControllers({ editor, store, pageId }: { editor: any; store: RestThreadStore; pageId: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; tab: 'open' | 'resolved'; key: number }>({ open: false, tab: 'open', key: 0 });
  const comments = useExtension(CommentsExtension);
  const positions = useExtensionState(CommentsExtension, { selector: (s) => s.threadPositions });
  const threads = useThreads();
  const openCount = useMemo(() => [...threads.values()].filter((t) => !t.resolved).length, [threads]);

  useEffect(() => {
    store.editor = editor;
    return () => {
      if (store.editor === editor) store.editor = null;
    };
  }, [store, editor]);

  useLayoutEffect(() => {
    setContainer((anchor.current?.closest('.bn-container') as HTMLElement | null) ?? null);
  }, []);

  const topSlot = useSlot(() => (container?.parentElement ? { parent: container.parentElement, before: container } : null), container, 'or-discussion-slot');

  // Deep link from the inbox / e-mails: ?thread=<id>
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !store.loaded) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('thread');
    if (!id) {
      handled.current = true;
      return;
    }
    // Not there yet: cached data may predate the thread — wait for the refetch (or the timeout below).
    const thread = threads.get(id);
    if (!thread) return;
    const meta = threadMeta(thread);
    const finish = () => {
      handled.current = true;
      params.delete('thread');
      const qs = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    };
    if (thread.resolved) {
      setPanel({ open: true, tab: 'resolved', key: Date.now() });
      finish();
    } else if (!meta.anchored) {
      setTimeout(() => scrollToDiscussion(id), 200);
      finish();
    } else if (positions.has(id)) {
      setTimeout(() => comments.selectThread(id, true), 200);
      finish();
    }
  }, [store.loaded, threads, positions, comments]);
  // The anchor never showed up (commented text deleted): open the panel instead.
  useEffect(() => {
    const t = setTimeout(() => {
      if (handled.current) return;
      handled.current = true;
      if (new URLSearchParams(window.location.search).get('thread')) setPanel({ open: true, tab: 'open', key: Date.now() });
    }, 4000);
    return () => clearTimeout(t);
  }, [pageId]);

  const toggle = useCallback(() => setPanel((p) => ({ open: !p.open, tab: 'open', key: p.open ? p.key : Date.now() })), []);

  // "Commentaires" button: rendered by the page top bar (features/registry → PageTopBarExtras).
  const owner = useRef({}).current;
  useEffect(() => publishCommentsBar(owner, pageId, { count: openCount, active: panel.open, toggle }), [owner, pageId, openCount, panel.open, toggle]);
  useEffect(() => () => withdrawCommentsBar(owner, pageId), [owner, pageId]);

  return (
    <>
      <span ref={anchor} hidden />
      {topSlot && createPortal(<PageDiscussion />, topSlot)}
      {panel.open &&
        createPortal(
          <CommentsPanel key={panel.key} store={store} initialTab={panel.tab} onClose={() => setPanel((p) => ({ ...p, open: false }))} />,
          document.body,
        )}
    </>
  );
}

/** Extra controllers rendered inside <BlockNoteView>: comments UI (panel, discussion, top-bar button). */
export function CollabEditorControllers(props: { editor: unknown; ctx: ExtraEditorContext }) {
  const { ctx } = props;
  const editor = props.editor as { getExtension?: (k: string) => unknown };
  const comments = editor.getExtension?.('comments') as { threadStore?: unknown } | undefined;
  const store = comments?.threadStore instanceof RestThreadStore ? comments.threadStore : null;

  useEffect(() => {
    if (ctx.mode !== 'app' || !ctx.workspaceId) return;
    mentionScope.set({ workspaceId: ctx.workspaceId, userId: ctx.user?.id ?? null });
  }, [ctx.mode, ctx.workspaceId, ctx.user?.id]);

  if (!store || ctx.mode !== 'app') return null;
  return <CommentsControllers editor={props.editor} store={store} pageId={ctx.pageId} />;
}

/** Starts a comment on the whole text of a block (for block menus): selects it, opens the composer. */
export function commentBlock(editor: any, blockId: string): boolean {
  const comments = editor?.getExtension?.('comments') as { startPendingComment?: () => void } | undefined;
  if (!comments?.startPendingComment) return false;
  try {
    // Text selection over the block's own inline content (BlockNote's setSelection() refuses a single
    // block: "same anchor and head blocks").
    let range: { from: number; to: number } | null = null;
    editor.prosemirrorState.doc.descendants((node: any, pos: number) => {
      if (range) return false;
      if (node.type.name === 'blockContainer' && node.attrs.id === blockId) {
        const content = node.firstChild;
        if (content?.isTextblock && content.content.size > 0) range = { from: pos + 2, to: pos + 2 + content.content.size };
        return false;
      }
      return true;
    });
    if (!range || !editor._tiptapEditor?.commands?.setTextSelection?.(range)) return false;
    comments.startPendingComment();
    return true;
  } catch {
    return false;
  }
}
