// Editor of a synced block's content: a BlockNote editor bound to the collaborative document
// `synced:<id>`, mounted inside the block of the page showing it (lazy chunk: see syncedBlock.tsx).
//
// The block is a content-less node of the page editor: its node view stops the events coming from
// this nested editor and ignores its DOM mutations, so the two editors stay independent. The
// document is never kept in IndexedDB: its access rules (the owner page's) can be revoked at any time.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { FormattingToolbarController, SideMenu, SideMenuController, SuggestionMenuController, useCreateBlockNote } from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { withCollaboration } from '@blocknote/core/yjs';
import { syntaxHighlighter } from '@blocknote/code-block';
import { syncedDocumentName } from '@oriel/shared';
import { api } from '../lib/api';
import { useCollab, useCollabState, type CollabEntry } from '../lib/collab';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { userColor } from '../lib/util';
import { Spinner } from '../components/common';
import { useEditorEnv } from './env';
import { OrielFormattingToolbar, getMentionItems, getSlashMenuItems, slashMenuShouldOpen } from './menus';
import { dictionary, schema, type OrielEditor } from './schema';
import { SYNCED_SLASH_TITLE, SyncedNestingContext, isBlankDocument, registerSyncedEditor, takeSyncedSeed, type LooseBlock } from './syncedLogic';

interface Props {
  syncedId: string;
  /** Block of the host page showing this content. */
  hostBlockId: string;
  canEdit: boolean;
  isPublic: boolean;
  /** The server refused or revoked the document. */
  onDenied: () => void;
}

function useCollabUser() {
  const session = useSession();
  const user = session.data?.user ?? null;
  return useMemo(
    () => ({ id: user?.id ?? '', name: user?.name ?? 'Visiteur', color: user ? userColor(user.id) : '#868e96', avatarUrl: user?.avatarUrl ?? '' }),
    [user],
  );
}

export default function SyncedContent({ syncedId, hostBlockId, canEdit, isPublic, onDenied }: Props) {
  const name = syncedDocumentName(syncedId);
  const entry = useCollab(name, false, name);
  const state = useCollabState(entry);
  const collabUser = useCollabUser();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(t);
  }, [name]);
  const [primed, setPrimed] = useState<CollabEntry | null>(null);
  useLayoutEffect(() => {
    if (!entry) return;
    if (!isPublic) entry.provider.awareness?.setLocalStateField('user', collabUser);
    setPrimed(entry);
  }, [entry, collabUser, isPublic]);
  // The server closes the document when the owner page's rules change (made private, trashed, member
  // removed…). The provider only stops syncing then: authenticate again so that the server decides
  // with the current rules (refused → "Contenu indisponible", still allowed → synced again).
  useEffect(() => {
    if (!entry) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onClose = ({ event }: { event?: { reason?: unknown } }) => {
      if (event?.reason !== 'forbidden' && event?.reason !== 'session-ended') return;
      timer ??= setTimeout(() => {
        timer = null;
        try {
          entry.provider.detach();
          entry.provider.attach();
        } catch {
          /* destroyed meanwhile */
        }
      }, 0);
    };
    entry.provider.on('close', onClose);
    return () => {
      entry.provider.off('close', onClose);
      if (timer) clearTimeout(timer);
    };
  }, [entry]);
  const denied = !!state?.denied;
  useEffect(() => {
    if (denied) onDenied();
  }, [denied, onDenied]);

  if (denied) return null;
  if (!entry || !state || primed !== entry || !(state.synced || waited)) {
    return (
      <div className="or-synced__loading" contentEditable={false}>
        <Spinner size={14} />
      </div>
    );
  }
  return (
    <SyncedEditor
      key={entry.pageId}
      entry={entry}
      syncedId={syncedId}
      hostBlockId={hostBlockId}
      readOnly={!canEdit || state.readOnly}
      isPublic={isPublic}
      collabUser={collabUser}
    />
  );
}

function SyncedEditor({
  entry,
  syncedId,
  hostBlockId,
  readOnly,
  isPublic,
  collabUser,
}: {
  entry: CollabEntry;
  syncedId: string;
  hostBlockId: string;
  readOnly: boolean;
  isPublic: boolean;
  collabUser: { id: string; name: string; color: string; avatarUrl: string };
}) {
  const env = useEditorEnv();
  const theme = useTheme();
  const workspaceId = env.workspaceId;
  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      dictionary,
      extensions: [syntaxHighlighter],
      uploadFile:
        workspaceId && env.mode === 'app'
          ? async (file: File) => {
              const res = await api.workspaces.upload(workspaceId, file);
              return res.url;
            }
          : undefined,
      collaboration: {
        fragment: entry.fragment,
        user: collabUser,
        provider: isPublic ? undefined : { awareness: entry.provider.awareness ?? undefined },
        showCursorLabels: 'activity' as const,
      },
    }),
    [entry],
  ) as unknown as OrielEditor;

  useEffect(
    () => registerSyncedEditor(hostBlockId, { syncedId, blocks: () => editor.document as unknown as LooseBlock[] }),
    [editor, hostBlockId, syncedId],
  );

  // A block converted into a synced block: write its blocks once the (new, empty) document is synced.
  useEffect(() => {
    if (readOnly) return;
    const seed = takeSyncedSeed(syncedId);
    if (!seed) return;
    const timer = setTimeout(() => {
      try {
        if (isBlankDocument(editor.document as unknown as LooseBlock[]) && seed.blocks.length) {
          editor.replaceBlocks(editor.document, seed.blocks as never);
        }
        seed.onSeeded?.();
      } catch (e) {
        console.error('[Oriel] bloc synchronisé : contenu initial', e);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [editor, syncedId, readOnly]);

  const nestedEnv = useMemo(() => ({ ...env, canEdit: !readOnly }), [env, readOnly]);
  const slashItems = async (query: string) =>
    filterSuggestionItems(
      getSlashMenuItems(editor, nestedEnv).filter((item) => item.title !== SYNCED_SLASH_TITLE),
      query,
    );
  const mentionItems = async (query: string) => getMentionItems(editor, nestedEnv, query);
  const allowMentions = !readOnly && env.mode === 'app' && !!workspaceId;

  return (
    <SyncedNestingContext.Provider value={syncedId}>
      <div
        className="or-synced__content"
        // Keys typed here belong to this editor (page shortcuts, block selection of the host).
        onKeyDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onCopy={(e) => e.stopPropagation()}
        onCut={(e) => e.stopPropagation()}
      >
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme={theme.resolved}
          className="or-editor or-synced__editor"
          slashMenu={false}
          sideMenu={false}
          formattingToolbar={false}
        >
          {!readOnly && env.mode === 'app' && <SuggestionMenuController triggerCharacter="/" getItems={slashItems} shouldOpen={slashMenuShouldOpen} />}
          {allowMentions && <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />}
          {!readOnly && <SideMenuController sideMenu={(p) => <SideMenu {...p} />} />}
          {!readOnly && <FormattingToolbarController formattingToolbar={OrielFormattingToolbar} />}
        </BlockNoteView>
      </div>
    </SyncedNestingContext.Provider>
  );
}
