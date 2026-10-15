// Global keyboard shortcuts (SPEC §9).
import { useEffect, useRef } from 'react';
import type { TreeResponse, Visibility } from '@oriel/shared';
import { navigation } from '../lib/navigation';
import { createPage } from '../lib/pages';
import { qk } from '../lib/queryKeys';
import { queryClient } from '../lib/queryClient';
import { toggleTheme } from '../lib/theme';
import { buildTreeIndex, ancestorsOf } from '../lib/tree';
import {
  closeSearch,
  confirmStore,
  historyStore,
  openSearch,
  pagePickerStore,
  promptStore,
  searchStore,
  toggleSidebar,
} from '../lib/ui';
import { isMac } from '../lib/util';
import { createStore } from '../lib/store';

/** Shortcuts help dialog (? / ⌘/), rendered by shell/commands.tsx. */
export const shortcutsHelpStore = createStore(false);

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || !!el.closest?.('input, textarea, select, [contenteditable="true"]');
}

function isModalOpen() {
  return (
    searchStore.get().open ||
    !!pagePickerStore.get() ||
    !!historyStore.get().pageId ||
    !!confirmStore.get() ||
    !!promptStore.get() ||
    shortcutsHelpStore.get()
  );
}

/** Section (sidebar root) of the page currently shown, used by "Nouvelle page". */
export function currentSection(workspaceId: string, pageId: string | undefined): Visibility {
  if (!pageId) return 'workspace';
  const tree = queryClient.getQueryData<TreeResponse>(qk.tree(workspaceId));
  if (!tree) return 'workspace';
  const index = buildTreeIndex(tree.nodes);
  const node = index.byId.get(pageId);
  if (!node) return 'workspace';
  const root = ancestorsOf(index, pageId)[0] ?? node;
  return root.visibility;
}

export function useGlobalShortcuts(opts: { workspaceId: string; canEdit: boolean; pageId?: string }) {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === 'k' || key === 'p') && !e.shiftKey) {
        e.preventDefault();
        if (searchStore.get().open) closeSearch();
        else openSearch();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key === 'n') {
        if (!ref.current.canEdit) return;
        e.preventDefault();
        const { workspaceId, pageId } = ref.current;
        void createPage({
          workspaceId,
          parentType: 'workspace',
          parentId: workspaceId,
          visibility: currentSection(workspaceId, pageId),
        }).catch(() => undefined);
        return;
      }
      if ((mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) || (e.key === '?' && !mod && !e.altKey && !isTypingTarget(e.target))) {
        e.preventDefault();
        shortcutsHelpStore.set(true);
        return;
      }
      if (mod && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (mod && e.shiftKey && key === 'l') {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (mod && !e.shiftKey && (e.key === '[' || e.code === 'BracketLeft')) {
        e.preventDefault();
        window.history.back();
        return;
      }
      if (mod && !e.shiftKey && (e.key === ']' || e.code === 'BracketRight')) {
        e.preventDefault();
        window.history.forward();
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented && navigation.getState().peekPageId && !isModalOpen()) {
        const target = e.target as HTMLElement | null;
        // Let open menus / popovers handle their own Escape first.
        if (target?.closest('.mantine-Menu-dropdown, .mantine-Popover-dropdown, .bn-suggestion-menu')) return;
        navigation.closePeek();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
