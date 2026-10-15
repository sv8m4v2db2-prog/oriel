// Comment UI built on BlockNote's comment components (threads, reactions, edit/delete,
// resolve): comment editor schema with mentions, the "Commentaires" panel, the page-level
// discussion shown at the top of the page and the top-bar button.
import { useMemo, useState, type ReactNode } from 'react';
import { BlockNoteSchema, createParagraphBlockSpec, defaultInlineContentSpecs, defaultStyleSpecs } from '@blocknote/core';
import { CommentEditorSubmitExtension, CommentsExtension, type ThreadData } from '@blocknote/core/comments';
import { BlockNoteView, components } from '@blocknote/mantine';
import {
  FloatingComposer,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  SuggestionMenuController,
  Thread,
  useBlockNoteContext,
  useCreateBlockNote,
  useDictionary,
  useExtension,
  useExtensionState,
  useThreads,
  type ComponentProps,
} from '@blocknote/react';
import { MessageSquare, MessageSquarePlus, X } from 'lucide-react';
import { createStore, useStore } from '../lib/store';
import { DateMention, UserMention } from './mentions';
import { peopleAndDateItems } from './mentionItems';
import { threadMeta, type RestThreadStore } from './threadStore';

// --- comment editor schema (paragraphs + mentions, no colors) -----------------------------

const { textColor: _textColor, backgroundColor: _backgroundColor, ...commentStyleSpecs } = defaultStyleSpecs;

export const commentSchema = BlockNoteSchema.create({
  blockSpecs: { paragraph: createParagraphBlockSpec() },
  inlineContentSpecs: { ...defaultInlineContentSpecs, userMention: UserMention, dateMention: DateMention },
  styleSpecs: commentStyleSpecs,
});

/** Workspace / user whose members are proposed after "@" in comment editors. */
export const mentionScope = createStore<{ workspaceId: string | null; userId: string | null }>({ workspaceId: null, userId: null });

function CommentFormattingToolbar() {
  const items = getFormattingToolbarItems([]).filter((el) => el.key !== 'nestBlockButton' && el.key !== 'unnestBlockButton');
  return <FormattingToolbar blockTypeSelectItems={[]}>{items}</FormattingToolbar>;
}

/**
 * Same as BlockNote's Mantine comment editor, plus "@" suggestions (people and dates).
 * Installed globally on BlockNote's Mantine component set (comment editors are created by
 * BlockNote's own UI, so this is the only place to add a suggestion menu to them).
 */
function MentionCommentEditor(props: ComponentProps['Comments']['Editor']) {
  const { className, autoFocus, onFocus, onBlur, editor, editable } = props;
  const blockNoteContext = useBlockNoteContext();
  const scope = useStore(mentionScope);
  return (
    <BlockNoteView
      autoFocus={autoFocus}
      className={className}
      editor={editor}
      sideMenu={false}
      slashMenu={false}
      tableHandles={false}
      filePanel={false}
      formattingToolbar={false}
      editable={editable}
      theme={blockNoteContext?.colorSchemePreference}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <FormattingToolbarController formattingToolbar={CommentFormattingToolbar} />
      {editable && scope.workspaceId && (
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={(query) => peopleAndDateItems(editor, scope.workspaceId!, query, { currentUserId: scope.userId })}
        />
      )}
    </BlockNoteView>
  );
}
(components.Comments as { Editor: unknown }).Editor = MentionCommentEditor;

// --- helpers ------------------------------------------------------------------------------------

export function useThemedRootProps() {
  const ctx = useBlockNoteContext();
  const scheme = ctx?.colorSchemePreference === 'dark' ? 'dark' : 'light';
  return { className: `bn-root bn-mantine ${scheme}`, 'data-color-scheme': scheme, 'data-mantine-color-scheme': scheme };
}

function sortThreads(threads: ThreadData[], positions: Map<string, { from: number; to: number }>): ThreadData[] {
  return [...threads].sort((a, b) => {
    const pa = positions.get(a.id)?.from ?? (threadMeta(a).anchored ? Number.MAX_SAFE_INTEGER - 1 : -1);
    const pb = positions.get(b.id)?.from ?? (threadMeta(b).anchored ? Number.MAX_SAFE_INTEGER - 1 : -1);
    return pa - pb || a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export function scrollToDiscussion(threadId: string): boolean {
  const el = document.getElementById(`or-thread-${threadId}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1600);
  return true;
}

// --- new page-level comment --------------------------------------------------------------------

function PageCommentComposer({ store, onDone }: { store: RestThreadStore; onDone: () => void }) {
  const dict = useDictionary();
  const editor = useCreateBlockNote({
    trailingBlock: false,
    dictionary: { ...dict, placeholders: { ...dict.placeholders, emptyDocument: 'Commenter la page… (@ pour mentionner)' } },
    schema: commentSchema,
    extensions: [
      CommentEditorSubmitExtension({
        submitOnEnter: true,
        onSubmit: async (ed) => {
          await store.createThread({ initialComment: { body: ed.document }, metadata: { anchored: false } });
          ed.removeBlocks(ed.document);
          onDone();
        },
      }),
    ],
  });
  return (
    <div className="or-page-composer" onKeyDown={(e) => e.key === 'Escape' && editor.isEmpty && onDone()}>
      <FloatingComposer newCommentEditor={editor} />
    </div>
  );
}

// --- one thread inside the panel / discussion ------------------------------------------------------

function ThreadCard({
  thread,
  selected,
  onSelect,
  header,
}: {
  thread: ThreadData;
  selected: boolean;
  onSelect: () => void;
  header?: ReactNode;
}) {
  return (
    <div className={`or-thread-card${thread.resolved ? ' is-resolved' : ''}`} id={`or-thread-${thread.id}`}>
      {header}
      <div
        onFocusCapture={(e) => {
          if (!(e.target as HTMLElement).closest('.bn-action-toolbar')) onSelect();
        }}
      >
        <Thread thread={thread} selected={selected} tabIndex={0} maxCommentsBeforeCollapse={selected ? undefined : 4} />
      </div>
    </div>
  );
}

// --- page-level discussion (top of the page) --------------------------------------------------------

export function PageDiscussion() {
  const threads = useThreads();
  const [selected, setSelected] = useState<string | null>(null);
  const root = useThemedRootProps();
  const open = useMemo(
    () => [...threads.values()].filter((t) => !threadMeta(t).anchored && !t.resolved).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    [threads],
  );
  if (open.length === 0) return null;
  return (
    <section className="or-discussion" aria-label="Discussion de la page">
      <div className="or-discussion__title">
        <MessageSquare size={14} /> Discussion · {open.length}
      </div>
      <div {...root} className={`${root.className} or-discussion__list`}>
        {open.map((t) => (
          <ThreadCard key={t.id} thread={t} selected={selected === t.id} onSelect={() => setSelected(t.id)} />
        ))}
      </div>
    </section>
  );
}

// --- "Commentaires" panel -------------------------------------------------------------------------

export function CommentsPanel({ store, onClose, initialTab = 'open' }: { store: RestThreadStore; onClose: () => void; initialTab?: 'open' | 'resolved' }) {
  const comments = useExtension(CommentsExtension);
  const positions = useExtensionState(CommentsExtension, { selector: (s) => s.threadPositions });
  const threads = useThreads();
  const [tab, setTab] = useState<'open' | 'resolved'>(initialTab);
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const root = useThemedRootProps();
  const all = [...threads.values()];
  const openCount = all.filter((t) => !t.resolved).length;
  const resolvedCount = all.length - openCount;
  const list = sortThreads(
    all.filter((t) => (tab === 'open' ? !t.resolved : t.resolved)),
    positions,
  );

  const goTo = (t: ThreadData) => {
    const meta = threadMeta(t);
    if (meta.anchored && positions.has(t.id)) comments.selectThread(t.id, true);
    else if (!meta.anchored) scrollToDiscussion(t.id);
  };

  return (
    <aside className="or-comments-panel" aria-label="Commentaires">
      <header className="or-comments-panel__header">
        <span className="or-comments-panel__title">Commentaires</span>
        <button type="button" className="icon-btn" aria-label="Fermer les commentaires" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="segmented or-comments-panel__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'is-active' : ''} onClick={() => setTab('open')}>
          Ouverts · {openCount}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'resolved'}
          className={tab === 'resolved' ? 'is-active' : ''}
          onClick={() => setTab('resolved')}
        >
          Résolus · {resolvedCount}
        </button>
      </div>
      <div {...root} className={`${root.className} or-comments-panel__body`}>
        {tab === 'open' &&
          store.rights.canComment &&
          (composing ? (
            <PageCommentComposer store={store} onDone={() => setComposing(false)} />
          ) : (
            <button type="button" className="or-comments-panel__new" onClick={() => setComposing(true)}>
              <MessageSquarePlus size={15} /> Commenter la page
            </button>
          ))}
        {list.length === 0 && (
          <p className="or-comments-panel__empty">
            {tab === 'open'
              ? store.loaded
                ? 'Aucun commentaire ouvert. Sélectionnez du texte puis « Ajouter un commentaire » pour en créer un.'
                : 'Chargement…'
              : 'Aucune discussion résolue.'}
          </p>
        )}
        {list.map((t) => {
          const meta = threadMeta(t);
          const orphan = meta.anchored && !positions.has(t.id);
          return (
            <ThreadCard
              key={t.id}
              thread={t}
              selected={selected === t.id}
              onSelect={() => setSelected(t.id)}
              header={
                <button
                  type="button"
                  className={`or-thread-card__anchor${orphan ? ' is-orphan' : ''}`}
                  onClick={() => goTo(t)}
                  title={meta.anchored ? (orphan ? 'Le texte commenté a été supprimé' : 'Aller au passage commenté') : 'Aller à la discussion'}
                >
                  {meta.anchored ? (orphan ? `« ${meta.quote || '…'} » (supprimé)` : `« ${meta.quote || '…'} »`) : 'Discussion de la page'}
                </button>
              }
            />
          );
        })}
      </div>
    </aside>
  );
}

// --- top bar button -----------------------------------------------------------------------------

/** State of a page's comments UI, published by the editor's controllers for the page top bar. */
export interface CommentsBarState {
  count: number;
  active: boolean;
  toggle: () => void;
}

const commentsBar = createStore<Record<string, { owner: object; state: CommentsBarState }>>({});

/** Publishes (or updates) the top-bar state of `pageId`; `owner` identifies the publishing editor. */
export function publishCommentsBar(owner: object, pageId: string, state: CommentsBarState): void {
  commentsBar.set((all) => ({ ...all, [pageId]: { owner, state } }));
}

/** Withdraws the top-bar state of `pageId` if `owner` still holds it. */
export function withdrawCommentsBar(owner: object, pageId: string): void {
  commentsBar.set((all) => {
    if (all[pageId]?.owner !== owner) return all;
    const { [pageId]: _gone, ...rest } = all;
    return rest;
  });
}

/** "Commentaires" button of a page's top bar (rendered through features/registry → PageTopBarExtras). */
export function CommentsTopBarButton({ pageId }: { pageId: string }) {
  const entry = useStore(commentsBar)[pageId];
  if (!entry) return null;
  return <CommentsButton count={entry.state.count} active={entry.state.active} onClick={entry.state.toggle} />;
}

export function CommentsButton({ count, active, onClick }: { count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`icon-btn or-comments-btn${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={`Commentaires${count ? ` (${count} ouverts)` : ''}`}
      title="Commentaires"
      onClick={onClick}
    >
      <MessageSquare size={17} />
      {count > 0 && <span className="or-comments-btn__count">{count}</span>}
    </button>
  );
}
