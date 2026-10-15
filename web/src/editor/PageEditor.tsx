// Collaborative block editor for one page (BlockNote + Yjs via Hocuspocus).
import { ExtraEditorControllers, getExtraMentionItems, useExtraEditorOptions } from './extensions';
import type { ExtraEditorContext } from '../collab/editor';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import {
  FormattingToolbarController,
  SideMenuController,
  SuggestionMenuController,
  useCreateBlockNote,
} from '@blocknote/react';
import { createExtension } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { withCollaboration } from '@blocknote/core/yjs';
import { syntaxHighlighter } from '@blocknote/code-block';
import { multiColumnDropCursor } from '@blocknote/xl-multi-column';
import { CloudOff, Lock } from 'lucide-react';
import type { TreeNode } from '@oriel/shared';
import { api } from '../lib/api';
import { collabEditorGate, useCollab, useCollabState, type CollabEntry } from '../lib/collab';
import { hasPendingImport, takePendingImport } from '../lib/pages';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { appNavigate, userColor } from '../lib/util';
import { EditorSkeleton, EmptyState } from '../components/common';
import { EditorEnvContext, type EditorEnv } from './env';
import { OrielFormattingToolbar, getMentionItems, getSlashMenuItems, slashMenuShouldOpen } from './menus';
import { registerEditor } from './registry';
import { dictionary, normalizeCodeBlocks, normalizeCodeLanguage, schema, type OrielEditor } from './schema';
import { duplicateBlocks, selectedBlocks } from './blockActions';
import { useEditorContextMenu } from './contextMenu';
import { offerLinkPasteMenu, pastedLoneUrl } from './linkPaste';
import { useBlockAnchor } from './blockLinks';
import { useBlockSelection } from './blockSelection';
import { fillWelcomePage } from './seed';
import { registerMathInputRule } from './math';
import { DictationButton } from './dictation';
import { FootnoteSection, insertFootnote } from './footnotes';
import { OrielSideMenu } from './blockMeta';
import { OFFICE_PASTE_CHUNK, OFFICE_PASTE_MAX_BLOCKS, chunkHtmlBlocks, cleanOfficeHtml, isOfficeHtml } from './officePaste';
import { toast } from '../lib/ui';
import { pastedMarkdownMath, parseMarkdownWithMath } from './mathMarkdown';
import './editor.css';

export interface PageEditorProps {
  pageId: string;
  workspaceId: string | null;
  canEdit: boolean;
  mode: 'app' | 'public';
  publicChildren?: Map<string, TreeNode>;
  /** Seed content to generate once the (empty) document is synced (PageFormat.seed). */
  seed?: 'welcome';
}

/** Identity broadcast to collaborators (cursor label, presence avatars). */
function useCollabUser() {
  const session = useSession();
  const user = session.data?.user ?? null;
  return useMemo(
    () => ({
      id: user?.id ?? '',
      name: user?.name ?? 'Visiteur',
      color: user ? userColor(user.id) : '#868e96',
      avatarUrl: user?.avatarUrl ?? '',
    }),
    [user],
  );
}

export function PageEditor(props: PageEditorProps) {
  const entry = useCollab(props.pageId, props.mode === 'app');
  const state = useCollabState(entry);
  const collabUser = useCollabUser();
  const [waitedLongEnough, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(t);
  }, [props.pageId]);

  // Publish our identity on the shared awareness *before* the editor is created: BlockNote's cursor
  // extension sets it while the editor is built (i.e. during render), and a change at that moment
  // would update the presence avatars of the top bar while CollabEditor renders (React warning).
  // Setting the identical value again is not a change, so nothing is emitted then.
  const [primed, setPrimed] = useState<CollabEntry | null>(null);
  useLayoutEffect(() => {
    if (!entry) return;
    if (props.mode === 'app') entry.provider.awareness?.setLocalStateField('user', collabUser);
    setPrimed(entry);
  }, [entry, collabUser, props.mode]);

  if (!entry || !state || primed !== entry) return <EditorSkeleton />;
  // First reconcile the offline copy with the server. Mounting on stale local content
  // before the first handshake can make the editor normalize it back into a restored
  // document. Offline editing remains available after the bounded wait, from a local copy
  // only: an empty, never-synced document is not editable (collabEditorGate, QA-CORE-08).
  const gate = collabEditorGate(state, { isEmpty: entry.isEmpty, waited: waitedLongEnough });
  if (gate === 'denied') {
    return (
      <EmptyState icon={<Lock size={24} />} title="Contenu inaccessible">
        Le serveur a refusé l’accès au contenu de cette page.
      </EmptyState>
    );
  }
  if (gate === 'unavailable') {
    return (
      <EmptyState icon={<CloudOff size={24} />} title="Contenu indisponible hors ligne">
        Cette page n’a pas encore été ouverte sur cet appareil. Elle s’affichera dès le retour de la connexion.
      </EmptyState>
    );
  }
  if (gate !== 'ready') return <EditorSkeleton />;
  return <CollabEditor key={entry.pageId} entry={entry} {...props} readOnly={!props.canEdit || state.readOnly} />;
}

function isDocEmpty(editor: OrielEditor) {
  const doc = editor.document;
  if (doc.length === 0) return true;
  if (doc.length > 1) return false;
  const b = doc[0]!;
  return b.type === 'paragraph' && Array.isArray(b.content) && b.content.length === 0 && b.children.length === 0;
}

function handleLinkClick(event: MouseEvent): boolean {
  const anchor = (event.target as HTMLElement | null)?.closest('a');
  const href = anchor?.getAttribute('href');
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href, location.href);
  } catch {
    return false;
  }
  event.preventDefault();
  if (url.origin === location.origin && /^\/(w|share)\//.test(url.pathname) && !(event.metaKey || event.ctrlKey)) {
    appNavigate(url.pathname + url.search + url.hash);
    return true;
  }
  window.open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Keeps code block languages canonical whatever their origin (the "```foo " input rule stores what was
 * typed, documents written by older clients may hold aliases): unknown → 'text', alias → key. Only
 * block-level nodes are visited (never inline content), so the cost stays proportional to the number
 * of blocks. Returns an unsubscribe function.
 */
function guardCodeLanguages(editor: OrielEditor): () => void {
  const fix = () => {
    const fixes: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') {
        const language = normalizeCodeLanguage(node.attrs.language);
        if (language !== node.attrs.language) fixes.push({ pos, attrs: { ...node.attrs, language } });
        return false;
      }
      return !node.isTextblock && !node.isLeaf;
    });
    if (fixes.length === 0) return;
    editor.transact((tr) => {
      for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, f.attrs);
    });
  };
  // Deferred: never dispatch from inside another dispatch (remote Yjs updates are applied in one).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        if (editor.isEditable) fix();
      }, 0);
    }
  };
  schedule();
  const off = editor.onChange(schedule);
  return () => {
    if (timer !== null) clearTimeout(timer);
    if (typeof off === 'function') off();
  };
}

/** Editor keyboard shortcuts of Oriel (⌘D / Ctrl+D: duplicate the current or selected blocks). */
const orielShortcuts = createExtension({
  key: 'orielShortcuts',
  keyboardShortcuts: {
    'Mod-d': ({ editor }) => {
      if (!editor.isEditable) return false;
      duplicateBlocks(editor, selectedBlocks(editor));
      return true;
    },
    // Footnote at the cursor (⌘⌥F, as in word processors).
    'Mod-Alt-f': ({ editor }) => {
      if (!editor.isEditable) return false;
      insertFootnote(editor as never);
      return true;
    },
  },
});

function CollabEditor({
  entry,
  pageId,
  workspaceId,
  mode,
  publicChildren,
  readOnly,
  seed,
}: PageEditorProps & { entry: CollabEntry; readOnly: boolean }) {
  const session = useSession();
  const user = session.data?.user ?? null;
  const theme = useTheme();
  const canEdit = !readOnly;
  const collabUser = useCollabUser();

  const env: EditorEnv = useMemo(
    () => ({ mode, workspaceId, pageId, canEdit, publicChildren }),
    [mode, workspaceId, pageId, canEdit, publicChildren],
  );
  const envRef = useRef(env);
  envRef.current = env;

  const extraCtx: ExtraEditorContext = useMemo(
    () => ({
      pageId,
      workspaceId: workspaceId ?? null,
      mode,
      canEdit,
      user: user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl ?? null } : null,
    }),
    [pageId, workspaceId, mode, canEdit, user],
  );
  const extraOptions = useExtraEditorOptions(extraCtx);

  const editor = useCreateBlockNote(
    withCollaboration({
      ...extraOptions,
      schema,
      dictionary,
      // Writing direction detected per block from its first strong character (E18).
      domAttributes: { blockContent: { dir: 'auto' } },
      // Side drops (left/right edge of a block) create columns.
      dropCursor: multiColumnDropCursor,
      extensions: [syntaxHighlighter, orielShortcuts, ...((extraOptions.extensions ?? []) as never[])],
      uploadFile:
        workspaceId && mode === 'app'
          ? async (file: File) => {
              const res = await api.workspaces.upload(workspaceId, file);
              return res.url;
            }
          : undefined,
      links: { onClick: (event: MouseEvent) => handleLinkClick(event) },
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
        const lone = envRef.current.canEdit && envRef.current.mode === 'app' ? pastedLoneUrl(event) : null;
        let blockType = '';
        try {
          blockType = ed.getTextCursorPosition().block.type;
        } catch {
          /* no text cursor */
        }
        // Plain text holding `$…$` / `$$…$$`: equations (the default Markdown paste would eat the TeX escapes).
        const math = blockType !== 'codeBlock' ? pastedMarkdownMath(event) : null;
        if (math !== null) {
          const blocks = normalizeCodeBlocks(parseMarkdownWithMath(math, (md) => ed.tryParseMarkdownToBlocks(md)));
          if (JSON.stringify(blocks).includes('"inlineEquation"') || blocks.some((b) => b.type === 'equation')) {
            ed.pasteHTML(ed.blocksToFullHTML(blocks as never), true);
            return true;
          }
        }
        // Word / Office HTML: cleaned, and inserted by slices when large (E19).
        const html = blockType !== 'codeBlock' ? event.clipboardData?.getData('text/html') ?? '' : '';
        if (html && isOfficeHtml(html) && envRef.current.canEdit) {
          const chunks = chunkHtmlBlocks(cleanOfficeHtml(html), OFFICE_PASTE_CHUNK);
          if (chunks.length > 0) {
            if (chunks.length * OFFICE_PASTE_CHUNK > OFFICE_PASTE_MAX_BLOCKS * 1.5 && html.length > 8_000_000) {
              toast('Ce collage est trop volumineux : collez-le en plusieurs fois, ou en texte brut.');
              return true;
            }
            ed.pasteHTML(chunks[0]!, true);
            if (chunks.length > 1) {
              toast('Collage en cours…');
              chunks.slice(1).forEach((chunk, i) =>
                setTimeout(() => {
                  try {
                    const blocks = ed.tryParseHTMLToBlocks(chunk);
                    const ref = ed.getTextCursorPosition().block;
                    if (blocks.length) ed.insertBlocks(blocks as never, ref, 'after');
                  } catch (err) {
                    console.error('[Oriel] collage Office', err);
                  }
                }, 60 * (i + 1)),
              );
            }
            return true;
          }
        }
        const handled = defaultPasteHandler();
        // A lone URL pasted in text: offer "Lien / Signet / Intégrer".
        if (lone && handled && blockType !== 'codeBlock' && blockType !== 'table') {
          setTimeout(() => offerLinkPasteMenu(ed, lone.url, lone.text), 0);
        }
        return handled;
      },
      collaboration: {
        fragment: entry.fragment,
        user: collabUser,
        // Anonymous visitors of a published page neither see nor broadcast cursors.
        provider: mode === 'app' ? { awareness: entry.provider.awareness ?? undefined } : undefined,
        showCursorLabels: 'activity' as const,
      },
    }),
    [entry, extraOptions],
  );

  // Keep the presence information up to date (name / avatar changes).
  useEffect(() => {
    const ext = editor.getExtension('yCursor') as { updateUser?: (u: Record<string, string>) => void } | undefined;
    ext?.updateUser?.(collabUser);
  }, [editor, collabUser]);

  useEffect(() => registerEditor(pageId, editor), [pageId, editor]);
  useEffect(() => (readOnly ? undefined : guardCodeLanguages(editor)), [editor, readOnly]);
  useEffect(() => (readOnly ? undefined : registerMathInputRule(editor)), [editor, readOnly]);

  useBlockAnchor(editor, pageId);
  const contextMenu = useEditorContextMenu(editor, env);
  const wrapRef = useRef<HTMLDivElement>(null);
  useBlockSelection(editor, env, wrapRef);

  // Markdown import: fill the new page once the server copy is known to be empty.
  useEffect(() => {
    if (readOnly || !hasPendingImport(pageId)) return;
    let done = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const apply = () => {
      if (done) return;
      done = true;
      const md = takePendingImport(pageId);
      if (!md) return;
      timers.push(
        setTimeout(() => {
          try {
            const blocks = normalizeCodeBlocks(parseMarkdownWithMath(md, (m) => editor.tryParseMarkdownToBlocks(m)));
            if (blocks.length && isDocEmpty(editor)) editor.replaceBlocks(editor.document, blocks);
          } catch (e) {
            console.error('[Oriel] import Markdown', e);
          }
        }, 300),
      );
    };
    if (entry.store.get().synced) apply();
    const unsub = entry.store.subscribe(() => {
      if (entry.store.get().synced) apply();
    });
    timers.push(setTimeout(apply, 6000));
    return () => {
      unsub();
      timers.forEach(clearTimeout);
    };
  }, [editor, entry, pageId, readOnly]);

  // Welcome page of a new workspace: generate the getting-started guide once synced (and still empty).
  useEffect(() => {
    if (readOnly || seed !== 'welcome' || mode !== 'app' || !workspaceId) return;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (started || !entry.store.get().synced) return;
      started = true;
      // Leave time for the first sync to be applied to the editor.
      timer = setTimeout(() => void fillWelcomePage(workspaceId, pageId), 400);
    };
    run();
    const unsub = entry.store.subscribe(run);
    return () => {
      started = true;
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [editor, entry, pageId, workspaceId, readOnly, seed, mode]);

  const slashItems = async (query: string) => filterSuggestionItems(getSlashMenuItems(editor, env), query);
  const mentionItems = async (query: string) => [
    ...(await getMentionItems(editor, env, query)),
    ...(await getExtraMentionItems(editor, extraCtx, query)),
  ];
  const allowMentions = canEdit && mode === 'app' && !!workspaceId;

  return (
    <EditorEnvContext.Provider value={env}>
      <div ref={wrapRef} className="or-editor-wrap" onPointerDownCapture={contextMenu.onPointerDownCapture} onContextMenu={contextMenu.onContextMenu}>
        <BlockNoteView
          editor={editor}
          editable={canEdit}
          theme={theme.resolved}
          className="or-editor"
          slashMenu={false}
          sideMenu={false}
          formattingToolbar={false}
        >
          {canEdit && mode === 'app' && (
            <SuggestionMenuController triggerCharacter="/" getItems={slashItems} shouldOpen={slashMenuShouldOpen} />
          )}
          {allowMentions && <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />}
          {allowMentions && <SuggestionMenuController triggerCharacter="[[" getItems={mentionItems} />}
          {canEdit && <SideMenuController sideMenu={OrielSideMenu} />}
          {canEdit && <FormattingToolbarController formattingToolbar={OrielFormattingToolbar} />}
          <ExtraEditorControllers editor={editor} ctx={extraCtx} />
        </BlockNoteView>
        <FootnoteSection editor={editor as never} canEdit={canEdit} wrapRef={wrapRef} />
        {canEdit && mode === 'app' && <DictationButton editor={editor} />}
      </div>
    </EditorEnvContext.Provider>
  );
}
