// Read-only, non-collaborative rendering of a history snapshot (base64 Yjs update).
import { useEffect, useMemo, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { yXmlFragmentToBlocks } from '@blocknote/core/yjs';
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { useTheme } from '../lib/theme';
import { EmptyState } from '../components/common';
import { EditorEnvContext, type EditorEnv } from './env';
import { dictionary, schema } from './schema';
import './editor.css';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function SnapshotPreview({ update, workspaceId, pageId }: { update: string; workspaceId: string; pageId: string }) {
  const theme = useTheme();
  const editor = useCreateBlockNote({ schema, dictionary }, [update]);
  const [error, setError] = useState(false);
  const [empty, setEmpty] = useState(false);
  const env: EditorEnv = useMemo(() => ({ mode: 'preview', workspaceId, pageId, canEdit: false }), [workspaceId, pageId]);

  useEffect(() => {
    setError(false);
    setEmpty(false);
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, base64ToBytes(update));
      const blocks = yXmlFragmentToBlocks(editor, doc.getXmlFragment(COLLAB_FRAGMENT));
      doc.destroy();
      if (blocks.length === 0) setEmpty(true);
      else editor.replaceBlocks(editor.document, blocks);
    } catch (e) {
      console.error('[Oriel] snapshot preview', e);
      setError(true);
    }
  }, [editor, update]);

  if (error) return <EmptyState title="Aperçu indisponible">Cette version n’a pas pu être lue.</EmptyState>;
  if (empty) return <EmptyState title="Version vide">Cette version ne contient aucun bloc.</EmptyState>;
  return (
    <EditorEnvContext.Provider value={env}>
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={theme.resolved}
        className="or-editor or-editor--preview"
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
        linkToolbar={false}
        filePanel={false}
        tableHandles={false}
        emojiPicker={false}
      />
    </EditorEnvContext.Provider>
  );
}
