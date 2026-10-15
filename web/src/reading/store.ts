// UI state of the reading features (SPEC §13). Plain external stores: the pieces live in different
// parts of the shell (top bar menu, page view, overlays), and only the browser session needs them.
import { createStore, storage } from '../lib/store';

/** Find bar: `nonce` changes every time ⌘F is pressed while the bar is open (re-focus the field). */
export const findStore = createStore<{ open: boolean; pageId: string | null; nonce: number }>({ open: false, pageId: null, nonce: 0 });

export function openFind(pageId: string) {
  findStore.set((s) => ({ open: true, pageId, nonce: s.nonce + 1 }));
}
export function closeFind() {
  findStore.set((s) => (s.open ? { ...s, open: false } : s));
}

/** Presentation mode of a page. */
export const presentStore = createStore<{ pageId: string | null }>({ pageId: null });
export const startPresentation = (pageId: string) => presentStore.set({ pageId });
export const stopPresentation = () => presentStore.set({ pageId: null });

/** Focus mode (sidebar and top bar hidden). Not persisted: it is a momentary state. */
export const focusModeStore = createStore(false);
export const toggleFocusMode = () => focusModeStore.set((v) => !v);

const INFO_KEY = 'oriel.infoPanel';
const savedInfo = storage.getJSON<{ open?: boolean; docked?: boolean }>(INFO_KEY, {});

/** Right-hand information panel: `docked` pushes the page, otherwise it overlays it. */
export const infoPanelStore = createStore({ open: savedInfo.open ?? false, docked: savedInfo.docked ?? true });
infoPanelStore.subscribe(() => {
  const { open, docked } = infoPanelStore.get();
  storage.setJSON(INFO_KEY, { open, docked });
});
export const INFO_PANEL_WIDTH = 340;

/** File viewer: the page whose attachments are shown and the current one. */
export const fileViewerStore = createStore<{ pageId: string; blockId: string | null } | null>(null);
export const openFileViewer = (pageId: string, blockId: string | null = null) => fileViewerStore.set({ pageId, blockId });
export const closeFileViewer = () => fileViewerStore.set(null);
