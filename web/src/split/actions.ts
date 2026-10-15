// Split view (lot E): runtime state and actions. Light module (no page rendering) so that menus of other
// modules can import it without cycles. The URL is the source of truth; `runtime` mirrors it for callers
// outside React (global ⌥click, sidebar drag, context menus, the peek interceptor).
import { createStore, storage } from '../lib/store';
import { appNavigate, pagePath } from '../lib/util';
import { toast } from '../lib/ui';
import {
  MAX_PANES,
  SPLIT_MIN_VIEWPORT,
  applyDrop,
  closePane,
  isSplit,
  keepOnly,
  normalizeWidths,
  openBeside as openBesideState,
  paneCapacity,
  replacePane,
  setActive,
  splitHref,
  swapPanes,
  swapTarget,
  type DropTarget,
  type SplitState,
} from './splitLogic';

interface Runtime {
  workspaceId: string | null;
  /** Canonical state of the current page route (null elsewhere: home, settings…). */
  state: SplitState | null;
}

export const runtime: Runtime = { workspaceId: null, state: null };

/** Where the previous page route had a split: lets a plain page navigation be adopted by the active pane. */
export const adoption = {
  memo: null as null | { workspaceId: string; state: SplitState; locationKey: string },
};
export function forgetSplit() {
  adoption.memo = null;
}

export const isNarrowViewport = (): boolean => typeof window !== 'undefined' && window.innerWidth < SPLIT_MIN_VIEWPORT;

/** Panes that fit in the main area right now. */
export function currentCapacity(): number {
  if (isNarrowViewport()) return 1;
  const main = document.querySelector<HTMLElement>('.shell__main');
  return main ? paneCapacity(main.clientWidth) : MAX_PANES;
}

function go(state: SplitState, replace = false) {
  const ws = runtime.workspaceId;
  if (!ws) return;
  const href = splitHref(ws, state);
  // Nothing changes (swapping two identical panes…): no new history entry.
  if (href === `${location.pathname}${location.search}`) return;
  if (!isSplit(state)) forgetSplit();
  appNavigate(href, replace ? { replace: true } : undefined);
}

function workspaceFromLocation(): string | null {
  return /^\/w\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
}

export const splitActions = {
  /** Opens a page in the pane beside the active one (or beside pane `from`). Plain navigation on mobile. */
  openBeside(pageId: string, from?: number): void {
    const state = runtime.state;
    if (isNarrowViewport() || !runtime.workspaceId || !state) {
      const ws = runtime.workspaceId ?? workspaceFromLocation();
      if (ws) appNavigate(pagePath(ws, pageId));
      return;
    }
    const capacity = currentCapacity();
    if (capacity < 2 && state.panes.length < 2) {
      toast('La fenêtre est trop étroite pour une vue scindée.');
      appNavigate(pagePath(runtime.workspaceId, pageId));
      return;
    }
    go(openBesideState(state, pageId, capacity, from));
  },
  /** Drop from the sidebar: insert before/after a pane, or replace it. */
  drop(target: DropTarget, pageId: string): void {
    const state = runtime.state;
    if (!state || !runtime.workspaceId || isNarrowViewport()) return;
    go(applyDrop(state, target, pageId, Math.max(currentCapacity(), state.panes.length)));
  },
  activate(index: number): void {
    const state = runtime.state;
    if (!state || state.active === index || index < 0 || index >= state.panes.length) return;
    go(setActive(state, index), true);
  },
  close(index: number): void {
    if (runtime.state) go(closePane(runtime.state, index));
  },
  swap(index: number): void {
    const state = runtime.state;
    if (!state) return;
    const other = swapTarget(state, index);
    if (other >= 0) go(swapPanes(state, index, other));
  },
  keepOnly(index: number): void {
    if (runtime.state) go(keepOnly(runtime.state, index));
  },
  /** Replaces a pane's page (the pane becomes active). */
  replace(index: number, pageId: string): void {
    if (runtime.state) go(replacePane(runtime.state, index, pageId));
  },
};

// --- Persistent widths ------------------------------------------------------------------------------

const WIDTHS_KEY = 'oriel:split:widths';
type WidthsMap = Record<string, number[]>;

function readWidths(): WidthsMap {
  const raw = storage.getJSON<unknown>(WIDTHS_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as WidthsMap) : {};
}

export const widthsStore = createStore<WidthsMap>(readWidths());

/** Fractions for `count` panes (equal when nothing valid is stored). */
export function widthsFor(map: WidthsMap, count: number): number[] {
  return normalizeWidths(count, map[String(count)]);
}

export function saveWidths(count: number, widths: number[]) {
  widthsStore.set((map) => {
    const next = { ...map, [String(count)]: widths.map((w) => Math.round(w * 10000) / 10000) };
    storage.set(WIDTHS_KEY, JSON.stringify(next));
    return next;
  });
}

/** Pane (index) shown full size, or null. Reset when the set of panes changes. */
export const maximizedStore = createStore<number | null>(null);
