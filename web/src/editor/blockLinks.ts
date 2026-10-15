// Block links (/w/:wid/p/:pid#bloc-<id>): scroll to the block and highlight it briefly, also when the
// content arrives after the initial render (sync with the server).
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { BLOCK_ANCHOR_PREFIX } from '@oriel/shared';
import type { OrielEditor } from './schema';

export function findBlockElement(editor: OrielEditor, blockId: string): HTMLElement | null {
  return (
    editor.domElement?.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(blockId)}"]`) ?? null
  );
}

/**
 * Scrolls to a block and flashes it. The highlight is an overlay next to the editor (ProseMirror owns
 * the block's DOM and would revert a class added to it).
 */
export function highlightBlock(el: HTMLElement): void {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const host = el.closest<HTMLElement>('.or-editor-wrap');
  if (!host) return;
  host.querySelectorAll('.or-block-flash').forEach((n) => n.remove());
  const flash = document.createElement('div');
  flash.className = 'or-block-flash';
  flash.setAttribute('aria-hidden', 'true');
  const place = () => {
    const b = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    flash.style.top = `${b.top - h.top - 2}px`;
    flash.style.left = `${b.left - h.left - 6}px`;
    flash.style.width = `${b.width + 12}px`;
    flash.style.height = `${b.height + 4}px`;
  };
  place();
  host.appendChild(flash);
  const timer = setInterval(place, 200);
  setTimeout(() => {
    clearInterval(timer);
    flash.remove();
  }, 2600);
}

/** Handles `#bloc-<id>` for the page shown by the current route (not the peek panel). */
export function useBlockAnchor(editor: OrielEditor, pageId: string): void {
  const location = useLocation();
  useEffect(() => {
    if (!location.hash.startsWith(`#${BLOCK_ANCHOR_PREFIX}`)) return;
    if (!location.pathname.endsWith(`/${pageId}`)) return;
    const blockId = decodeURIComponent(location.hash.slice(BLOCK_ANCHOR_PREFIX.length + 1));
    if (!blockId) return;
    let done = false;
    const attempt = () => {
      if (done) return;
      const el = findBlockElement(editor, blockId);
      if (!el) return;
      done = true;
      // Let layout settle (images, databases) before scrolling.
      setTimeout(() => highlightBlock(el), 120);
    };
    attempt();
    const unsubscribe = editor.onChange(() => attempt());
    let tries = 0;
    const interval = setInterval(() => {
      attempt();
      if (done || ++tries > 60) clearInterval(interval);
    }, 250);
    return () => {
      done = true;
      clearInterval(interval);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [editor, pageId, location.hash, location.pathname, location.key]);
}
