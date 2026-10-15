// Shell-wide UI state: sidebar, modals, toasts, confirmations.
import { createStore, storage, useStore } from './store';

// --- Sidebar -------------------------------------------------------------------

const SIDEBAR_KEY = 'oriel:sidebar';
const savedSidebar = storage.getJSON<{ width?: number; collapsed?: boolean }>(SIDEBAR_KEY, {});

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;

export const sidebarStore = createStore({
  width: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, savedSidebar.width ?? 260)),
  collapsed: savedSidebar.collapsed ?? false,
  /** Overlay mode (small screens): whether the overlay is shown. */
  mobileOpen: false,
});

sidebarStore.subscribe(() => {
  const { width, collapsed } = sidebarStore.get();
  storage.setJSON(SIDEBAR_KEY, { width, collapsed });
});

export function isNarrowScreen() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

export function toggleSidebar() {
  if (isNarrowScreen()) sidebarStore.set((s) => ({ ...s, mobileOpen: !s.mobileOpen }));
  else sidebarStore.set((s) => ({ ...s, collapsed: !s.collapsed }));
}

export function closeMobileSidebar() {
  if (sidebarStore.get().mobileOpen) sidebarStore.set((s) => ({ ...s, mobileOpen: false }));
}

// --- Global modals ------------------------------------------------------------

export const searchStore = createStore({ open: false });
export const openSearch = () => searchStore.set({ open: true });
export const closeSearch = () => searchStore.set({ open: false });

export interface PagePickerRequest {
  title: string;
  /** Page ids that cannot be picked. */
  exclude?: Set<string>;
  /** Show the two workspace roots as targets ("Espace de travail", "Privé"). */
  allowRoots?: boolean;
  /** Include database rows found by the search API. */
  includeRows?: boolean;
  onPick: (target: { kind: 'page'; id: string } | { kind: 'root'; visibility: 'workspace' | 'private' }) => void;
}
export const pagePickerStore = createStore<PagePickerRequest | null>(null);
export const openPagePicker = (req: PagePickerRequest) => pagePickerStore.set(req);
export const closePagePicker = () => pagePickerStore.set(null);

export const historyStore = createStore<{ pageId: string | null }>({ pageId: null });

// --- Toasts -------------------------------------------------------------------

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
}
export const toastStore = createStore<Toast[]>([]);
let toastSeq = 1;

export function toast(message: string, opts: { tone?: Toast['tone']; action?: Toast['action']; duration?: number } = {}) {
  const id = toastSeq++;
  const t: Toast = { id, message, tone: opts.tone ?? 'info', action: opts.action };
  toastStore.set((list) => [...list.slice(-3), t]);
  setTimeout(() => dismissToast(id), opts.duration ?? (t.tone === 'error' ? 6000 : 3500));
  return id;
}
toast.success = (message: string, action?: Toast['action']) => toast(message, { tone: 'success', action });
toast.error = (message: string) => toast(message, { tone: 'error' });

export function dismissToast(id: number) {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

// --- Confirmation dialog --------------------------------------------------------

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
export const confirmStore = createStore<ConfirmRequest | null>(null);

export function confirmDialog(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = confirmStore.get();
    prev?.resolve(false);
    confirmStore.set({ ...opts, resolve });
  });
}

export interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}
export const promptStore = createStore<PromptRequest | null>(null);

export function promptDialog(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    promptStore.get()?.resolve(null);
    promptStore.set({ ...opts, resolve });
  });
}

export function useSidebar() {
  return useStore(sidebarStore);
}
