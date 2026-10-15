// Extension points of the block editor. Feature modules plug in here so that the core editor
// files (schema.ts, PageEditor.tsx) stay owned by the editor module.
//  - collaboration module (web/src/collab/editor.tsx): person/date mentions, comments
//  - database module (web/src/database/editorBlocks.tsx): linked database view block
//  - canvas module (web/src/canvas/editorBlocks.tsx): « Cadre de canevas » block, canvas slash items
export {
  collabInlineContentSpecs as extraInlineContentSpecs,
  useCollabEditorOptions as useExtraEditorOptions,
  getCollabMentionItems as getExtraMentionItems,
  CollabEditorControllers as ExtraEditorControllers,
  /** Starts a comment on a block's text; returns false when comments are unavailable. */
  commentBlock as commentExtraBlock,
} from '../collab/editor';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import * as databaseEditor from '../database/editorBlocks';
import { databaseBlockSpecs } from '../database/editorBlocks';
import { canvasBlockSpecs, canvasSlashItems } from '../canvas/editorBlocks';

export const extraBlockSpecs = { ...databaseBlockSpecs, ...canvasBlockSpecs };

type SlashItemsProvider = (editor: unknown, ctx: { workspaceId: string | null; canEdit?: boolean }) => DefaultReactSuggestionItem[];

/** Slash-menu items contributed by feature modules (database: "Vue liée d'une base"), appended to the editor's own. */
export function getExtraSlashItems(editor: unknown, ctx: { workspaceId: string | null; canEdit?: boolean }): DefaultReactSuggestionItem[] {
  const provider = (databaseEditor as { databaseSlashItems?: SlashItemsProvider }).databaseSlashItems;
  const items: DefaultReactSuggestionItem[] = [];
  if (typeof provider === 'function') {
    try {
      items.push(...provider(editor, ctx));
    } catch (e) {
      console.error('[Oriel] menu « / » (module bases de données)', e);
    }
  }
  try {
    items.push(...canvasSlashItems(editor, ctx));
  } catch (e) {
    console.error('[Oriel] menu « / » (module canevas)', e);
  }
  return items;
}
