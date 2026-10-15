// Pasting a lone URL: keep the link, or turn it into a bookmark card / an embed (known providers).
import type { BlockNoteEditor } from '@blocknote/core';
import { Bookmark, Globe, Link2 } from 'lucide-react';
import { EDITOR_BLOCK_TYPES } from '@oriel/shared';
import { closeContextMenu, openContextMenuAt } from '../components/ContextMenu';
import { asLoneUrl, detectProvider, isKnownEmbeddable } from './embeds';

type AnyEditor = BlockNoteEditor<any, any, any>;

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'text' ? (c.text ?? '') : c?.type === 'link' ? inlineText(c.content) : ''))
    .join('');
}

/** URL pasted on its own (plain text, or HTML that is just that link), or null. */
export function pastedLoneUrl(event: ClipboardEvent): { url: string; text: string } | null {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const url = asLoneUrl(text);
  if (!url) return null;
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if ((doc.body.textContent ?? '').trim() !== text.trim()) return null;
    } catch {
      return null;
    }
  }
  return { url, text: text.trim() };
}

function convert(editor: AnyEditor, url: string, pastedText: string, as: 'bookmark' | 'embed') {
  let block;
  try {
    block = editor.getTextCursorPosition().block;
  } catch {
    return;
  }
  const info = detectProvider(url);
  const next =
    as === 'bookmark' || !info
      ? { type: EDITOR_BLOCK_TYPES.bookmark, props: { url } }
      : { type: EDITOR_BLOCK_TYPES.embed, props: { url, provider: info.provider, height: info.defaultHeight } };
  if (inlineText(block.content).trim() === pastedText) {
    editor.replaceBlocks([block], [next as never]);
    return;
  }
  // The link sits right before the cursor inside a longer paragraph: remove it, add the card below.
  const { from } = editor.prosemirrorState.selection;
  const start = from - pastedText.length;
  if (start >= 0 && editor.prosemirrorState.doc.textBetween(start, from) === pastedText) {
    editor.transact((tr) => tr.delete(start, from));
  }
  editor.insertBlocks([next as never], block, 'after');
}

/** Opens the "Coller comme" menu at the caret after the default paste handled the URL. */
export function offerLinkPasteMenu(editor: AnyEditor, url: string, pastedText: string): void {
  let coords: { left: number; bottom: number };
  try {
    coords = editor.prosemirrorView.coordsAtPos(editor.prosemirrorState.selection.from);
  } catch {
    return;
  }
  const done = () => {
    closeContextMenu();
    editor.focus();
  };
  openContextMenuAt(coords.left, coords.bottom + 4, [
    { header: 'Coller comme' },
    { label: 'Lien', icon: <Link2 size={15} />, checked: true, onClick: done },
    {
      label: 'Signet',
      icon: <Bookmark size={15} />,
      onClick: () => {
        convert(editor, url, pastedText, 'bookmark');
        editor.focus();
      },
    },
    isKnownEmbeddable(url) && {
      label: `Intégrer (${detectProvider(url)!.label})`,
      icon: <Globe size={15} />,
      onClick: () => {
        convert(editor, url, pastedText, 'embed');
        editor.focus();
      },
    },
  ]);
}
