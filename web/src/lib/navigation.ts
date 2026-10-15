// Cross-module navigation contract between the app shell and the database module.
// The shell renders the peek panel and owns routing; the database module only calls these.
import { useSyncExternalStore } from 'react';

interface NavState {
  /** Page shown in the right-hand "peek" panel (database rows), or null. */
  peekPageId: string | null;
}

let state: NavState = { peekPageId: null };
const listeners = new Set<() => void>();
let navigateImpl: ((pageId: string) => void) | null = null;
/** Split view: may take over a page opened in the peek panel (⌥ held → open it beside). Returns true if handled. */
let peekInterceptor: ((pageId: string) => boolean) | null = null;

function set(next: Partial<NavState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const navigation = {
  /** Open a page (usually a database row) in the side peek panel. */
  openPeek(pageId: string) {
    if (peekInterceptor?.(pageId)) return;
    set({ peekPageId: pageId });
  },
  closePeek() {
    set({ peekPageId: null });
  },
  /** Navigate the main view to a page (full page). Provided by the shell's router. */
  openPage(pageId: string) {
    set({ peekPageId: null });
    navigateImpl?.(pageId);
  },
  /** Called once by the split view module (lot E). */
  setPeekInterceptor(fn: ((pageId: string) => boolean) | null) {
    peekInterceptor = fn;
  },
  /** Called once by the shell to plug in its router. */
  registerNavigate(fn: (pageId: string) => void) {
    navigateImpl = fn;
  },
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useNavigationState(): NavState {
  return useSyncExternalStore(navigation.subscribe, navigation.getState, navigation.getState);
}
