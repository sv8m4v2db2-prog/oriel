// Split view (lot E): global entry points — ⌥click, « Ouvrir à côté » in context menus, the peek
// interceptor and the drag from the sidebar to the edge of a pane. Installed once by the shell.
import { useEffect } from 'react';
import { Columns2 } from 'lucide-react';
import { setContextMenuDecorator, type ContextMenuEntry } from '../components/ContextMenu';
import { navigation } from '../lib/navigation';
import { createStore, useStore } from '../lib/store';
import { dropTargetAt, pageIdFromHref, type DropTarget, type PaneRect } from './splitLogic';
import { isNarrowViewport, runtime, splitActions } from './actions';

/** Page id designated by an element: a page link, a mention, a sub-page card, a sidebar row. */
export function pageIdAt(el: Element | null, workspaceId: string | null): string | null {
  const node = el?.closest<HTMLElement>('a[data-page-id], .tree-row[data-page-id], a[href]');
  if (!node) return null;
  const direct = node.dataset.pageId;
  if (direct && !node.classList.contains('page')) return direct;
  if (node instanceof HTMLAnchorElement) {
    const ref = pageIdFromHref(node.getAttribute('href') ?? '', location.origin);
    if (ref && (!workspaceId || ref.workspaceId === workspaceId)) return ref.pageId;
  }
  return null;
}

// --- ⌥ held during the current event (rows of databases open through navigation.openPeek) ------------

let altNow = false;
let altTimer: ReturnType<typeof setTimeout> | null = null;
function noteAlt(e: MouseEvent | KeyboardEvent | PointerEvent) {
  altNow = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
  if (altTimer) clearTimeout(altTimer);
  altTimer = setTimeout(() => (altNow = false), 0);
}

// --- Sidebar drag -------------------------------------------------------------------------------------

export interface DragView {
  pageId: string;
  /** Highlighted rectangle in viewport pixels, or null when outside any pane. */
  rect: { left: number; top: number; width: number; height: number } | null;
  label: string;
  target: DropTarget | null;
}
export const dragStore = createStore<DragView | null>(null);

function paneRects(): PaneRect[] {
  const panes = Array.from(document.querySelectorAll<HTMLElement>('[data-split-pane]'));
  const elements = panes.length ? panes : Array.from(document.querySelectorAll<HTMLElement>('.shell__main')).slice(0, 1);
  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

function viewFor(pageId: string, x: number, y: number): DragView {
  const rects = paneRects();
  const target = dropTargetAt(x, y, rects);
  if (!target) return { pageId, rect: null, label: '', target: null };
  const r = rects[target.pane]!;
  const w = r.right - r.left;
  const edge = Math.max(48, w * 0.25);
  const top = r.top;
  const height = r.bottom - r.top;
  if (target.mode === 'replace') {
    return { pageId, target, label: 'Remplacer ce panneau', rect: { left: r.left, top, width: w, height } };
  }
  const left = target.mode === 'before' ? r.left : r.right - edge;
  return { pageId, target, label: target.mode === 'before' ? 'Ouvrir à gauche' : 'Ouvrir à droite', rect: { left, top, width: edge, height } };
}

function installSidebarDrag(): () => void {
  let pending: { id: string; x: number; y: number } | null = null;
  let dragging = false;

  const reset = () => {
    pending = null;
    dragging = false;
    dragStore.set(null);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || isNarrowViewport() || !runtime.state) return;
    const row = (e.target as Element | null)?.closest<HTMLElement>('.tree-row[data-page-id]');
    if (!row || (e.target as Element).closest('button, input, textarea')) return;
    pending = { id: row.dataset.pageId!, x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent) => {
    if (!pending) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 8) return;
      dragging = true;
    }
    dragStore.set(viewFor(pending.id, e.clientX, e.clientY));
  };
  const onUp = (e: PointerEvent) => {
    if (pending && dragging) {
      const view = viewFor(pending.id, e.clientX, e.clientY);
      if (view.target) splitActions.drop(view.target, pending.id);
    }
    reset();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') reset();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', reset, true);
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', reset, true);
    document.removeEventListener('keydown', onKey, true);
    reset();
  };
}

// --- Install --------------------------------------------------------------------------------------------

const hasLabel = (e: ContextMenuEntry, test: (label: string) => boolean) => 'label' in e && !('submenu' in e) && test(e.label);

export function installSplitInteractions(): () => void {
  // ⌥click on a page link opens the page beside (capture: before the editor's own handlers).
  const onClick = (e: MouseEvent) => {
    noteAlt(e);
    if (!altNow || e.button !== 0 || isNarrowViewport() || !runtime.workspaceId) return;
    if ((e.target as Element | null)?.closest?.('button, input, textarea')) return;
    const id = pageIdAt(e.target as Element, runtime.workspaceId);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    navigation.closePeek();
    splitActions.openBeside(id);
  };
  const onOther = (e: MouseEvent | KeyboardEvent) => noteAlt(e);

  document.addEventListener('click', onClick, true);
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'keydown'] as const) document.addEventListener(type, onOther as EventListener, true);

  navigation.setPeekInterceptor((pageId) => {
    if (!altNow || isNarrowViewport() || !runtime.workspaceId) return false;
    splitActions.openBeside(pageId);
    return true;
  });

  setContextMenuDecorator((event, entries) => {
    if (isNarrowViewport() || !runtime.workspaceId) return entries;
    const id = pageIdAt(event.target as Element | null, runtime.workspaceId);
    if (!id || entries.some((e) => hasLabel(e, (l) => l === 'Ouvrir à côté'))) return entries;
    let at = -1;
    entries.forEach((e, i) => {
      if (hasLabel(e, (l) => l === 'Ouvrir' || l.startsWith('Ouvrir dans'))) at = i;
    });
    if (at < 0) return entries;
    const item: ContextMenuEntry = {
      label: 'Ouvrir à côté',
      icon: <Columns2 size={15} />,
      shortcut: '⌥clic',
      onClick: () => splitActions.openBeside(id),
    };
    return [...entries.slice(0, at + 1), item, ...entries.slice(at + 1)];
  });

  const removeDrag = installSidebarDrag();
  return () => {
    document.removeEventListener('click', onClick, true);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'keydown'] as const) document.removeEventListener(type, onOther as EventListener, true);
    navigation.setPeekInterceptor(null);
    setContextMenuDecorator(null);
    removeDrag();
  };
}

/** Highlight shown while a sidebar entry is dragged over the main area. */
export function SplitDropOverlay() {
  const view = useStore(dragStore);
  useEffect(() => {
    document.body.classList.toggle('is-split-dragging', !!view);
    return () => document.body.classList.remove('is-split-dragging');
  }, [view]);
  if (!view?.rect) return null;
  return (
    <div className="splitv-drop" aria-hidden style={view.rect}>
      <span className="splitv-drop__label">{view.label}</span>
    </div>
  );
}
