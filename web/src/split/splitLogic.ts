// Split view (lot E): pure state logic. No React, no DOM, no router, so it is unit-tested directly.
//
// The state lives in the URL: `/w/:wid/p/:pageId?split=<id>,<id>[,<id>]&active=<n>`. `:pageId` is always
// the page of the active pane (so everything that follows "the current page" follows the active pane).

export const MAX_PANES = 3;
/** Smallest comfortable pane width, in pixels. */
export const MIN_PANE_PX = 280;
/** Below this viewport width the split view is disabled. */
export const SPLIT_MIN_VIEWPORT = 768;

export interface SplitState {
  /** Page of each pane, from left to right (at least one). */
  panes: string[];
  /** Index of the active pane. */
  active: number;
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export const isPaneId = (id: string): boolean => ID_RE.test(id);

export const isSplit = (state: SplitState): boolean => state.panes.length > 1;
export const activePage = (state: SplitState): string => state.panes[state.active] ?? state.panes[0]!;

function clampIndex(i: number, length: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(0, Math.trunc(i)), Math.max(0, length - 1));
}

/**
 * Reads the split from the route page and the query string. The route wins when they disagree.
 * Invalid ids are dropped, more than {@link MAX_PANES} panes are truncated, one pane is a plain page.
 */
export function parseSplit(routePageId: string, search: string): SplitState {
  const params = new URLSearchParams(search);
  const raw = (params.get('split') ?? '').split(',').filter(isPaneId).slice(0, MAX_PANES);
  if (raw.length < 2) return { panes: [routePageId], active: 0 };
  const active = clampIndex(Number(params.get('active') ?? 0), raw.length);
  const panes = raw.slice();
  panes[active] = routePageId;
  return { panes, active };
}

/** Query string (with the leading `?`, or empty) of a state. */
export function splitSearch(state: SplitState): string {
  if (state.panes.length < 2) return '';
  const params = [`split=${state.panes.join(',')}`];
  if (state.active > 0) params.push(`active=${state.active}`);
  return `?${params.join('&')}`;
}

/** Full path of a state in a workspace. */
export function splitHref(workspaceId: string, state: SplitState): string {
  return `/w/${workspaceId}/p/${activePage(state)}${splitSearch(state)}`;
}

/** `/w/<workspace>/p/<page>` of an internal link (absolute or relative), else null. */
export function pageIdFromHref(href: string, origin?: string): { workspaceId: string; pageId: string } | null {
  let url: URL;
  try {
    url = new URL(href, origin ?? 'http://localhost');
  } catch {
    return null;
  }
  if (origin && url.origin !== origin) return null;
  const m = /^\/w\/([^/]+)\/p\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  return { workspaceId: decodeURIComponent(m[1]!), pageId: decodeURIComponent(m[2]!) };
}

/** Number of panes that fit in `width` pixels (1…MAX_PANES). */
export function paneCapacity(width: number): number {
  if (!Number.isFinite(width)) return MAX_PANES;
  return Math.min(MAX_PANES, Math.max(1, Math.floor(width / MIN_PANE_PX)));
}

const single = (id: string): SplitState => ({ panes: [id], active: 0 });

/**
 * Inserts `pageId` at `index` (0 = before the first pane). When there is no room, the pane next to the
 * insertion point is replaced instead. The new pane becomes active.
 */
export function insertPane(state: SplitState, index: number, pageId: string, capacity = MAX_PANES): SplitState {
  const cap = Math.min(MAX_PANES, Math.max(1, capacity));
  const at = Math.min(Math.max(0, Math.trunc(index)), state.panes.length);
  if (state.panes.length < cap) {
    const panes = state.panes.slice();
    panes.splice(at, 0, pageId);
    return { panes, active: at };
  }
  // Full: replace the neighbor on the side of the insertion point.
  const target = clampIndex(at >= state.panes.length ? state.panes.length - 1 : at, state.panes.length);
  return replacePane(state, target, pageId);
}

/** Opens a page in the pane beside `from` (the active pane by default): to its right, else replacing a neighbor. */
export function openBeside(state: SplitState, pageId: string, capacity = MAX_PANES, from = state.active): SplitState {
  if (capacity < 2 && state.panes.length < 2) return single(pageId);
  const index = clampIndex(from, state.panes.length);
  if (state.panes.length < Math.min(MAX_PANES, capacity)) return insertPane(state, index + 1, pageId, capacity);
  // No room: replace the right neighbor, or the left one when `from` is the last pane.
  const neighbor = index < state.panes.length - 1 ? index + 1 : index - 1;
  return replacePane(state, Math.max(0, neighbor), pageId);
}

/** Replaces the page of a pane and makes it active. */
export function replacePane(state: SplitState, index: number, pageId: string): SplitState {
  const i = clampIndex(index, state.panes.length);
  const panes = state.panes.slice();
  panes[i] = pageId;
  return { panes, active: i };
}

export function setActive(state: SplitState, index: number): SplitState {
  return { panes: state.panes, active: clampIndex(index, state.panes.length) };
}

/** Closes a pane. The active pane stays the same page when possible, else the closest neighbor. */
export function closePane(state: SplitState, index: number): SplitState {
  if (state.panes.length < 2) return state;
  const i = clampIndex(index, state.panes.length);
  const panes = state.panes.filter((_, k) => k !== i);
  let active = state.active;
  if (i < active) active -= 1;
  else if (i === active) active = Math.min(i, panes.length - 1);
  return { panes, active: clampIndex(active, panes.length) };
}

/** Index of the pane a pane swaps with: its right neighbor, else its left one, else -1. */
export function swapTarget(state: SplitState, index: number): number {
  if (state.panes.length < 2) return -1;
  return index < state.panes.length - 1 ? index + 1 : index - 1;
}

/** Swaps two panes; the active pane follows its page. */
export function swapPanes(state: SplitState, a: number, b: number): SplitState {
  if (a === b || a < 0 || b < 0 || a >= state.panes.length || b >= state.panes.length) return state;
  const panes = state.panes.slice();
  [panes[a], panes[b]] = [panes[b]!, panes[a]!];
  let active = state.active;
  if (active === a) active = b;
  else if (active === b) active = a;
  return { panes, active };
}

/** "Garder seul": only this pane stays. */
export function keepOnly(state: SplitState, index: number): SplitState {
  return single(state.panes[clampIndex(index, state.panes.length)]!);
}

// --- Widths ---------------------------------------------------------------------------------

/** Equal fractions for `count` panes. */
export function equalWidths(count: number): number[] {
  const n = Math.max(1, count);
  return Array.from({ length: n }, () => 1 / n);
}

/** Stored widths (any JSON) → `count` fractions summing to 1, each at least `minFraction`. */
export function normalizeWidths(count: number, raw: unknown, minFraction = 0.12): number[] {
  if (count < 2) return [1];
  const list = Array.isArray(raw) ? raw : [];
  if (list.length !== count || list.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) return equalWidths(count);
  const sum = (list as number[]).reduce((s, v) => s + v, 0);
  const widths = (list as number[]).map((v) => v / sum);
  if (widths.some((v) => v < minFraction - 1e-9)) return equalWidths(count);
  return widths;
}

/**
 * Moves the handle between pane `index` and `index + 1` by `delta` (a fraction of the total width),
 * keeping every pane at least `minFraction` wide. Only these two panes change.
 */
export function dragHandle(widths: number[], index: number, delta: number, minFraction: number): number[] {
  if (index < 0 || index >= widths.length - 1) return widths;
  const pair = widths[index]! + widths[index + 1]!;
  const min = Math.min(minFraction, pair / 2);
  const left = Math.min(Math.max(widths[index]! + delta, min), pair - min);
  const next = widths.slice();
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}

// --- Drop zones (drag from the sidebar) ----------------------------------------------------------

export type DropMode = 'before' | 'after' | 'replace';
export interface PaneRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface DropTarget {
  pane: number;
  mode: DropMode;
}

/** Which pane and mode a point is over: outer quarters insert before/after, the middle replaces. */
export function dropTargetAt(x: number, y: number, rects: PaneRect[], edge = 0.25): DropTarget | null {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const rel = (x - r.left) / Math.max(1, r.right - r.left);
    return { pane: i, mode: rel < edge ? 'before' : rel > 1 - edge ? 'after' : 'replace' };
  }
  return null;
}

/** State after dropping `pageId` on a target. */
export function applyDrop(state: SplitState, target: DropTarget, pageId: string, capacity = MAX_PANES): SplitState {
  if (target.mode === 'replace') return replacePane(state, target.pane, pageId);
  return insertPane(state, target.mode === 'before' ? target.pane : target.pane + 1, pageId, capacity);
}
