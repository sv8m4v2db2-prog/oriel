// Script of tabs.html: renders the tab list pushed by the main process and turns pointer gestures
// into IPC messages (select, close, reorder by dragging, detach by dragging out of the bar).
import type { TabsState } from '../ipc';
import { dropIndex } from '../tabsLogic';

declare global {
  interface Window {
    orielTabs?: {
      get(): Promise<TabsState>;
      onState(callback: (state: TabsState) => void): void;
      select(id: string): void;
      close(id: string): void;
      newTab(): void;
      move(id: string, index: number): void;
      detach(id: string, screenX: number, screenY: number): void;
      menu(id: string): void;
    };
  }
}

const api = window.orielTabs;
const bar = document.getElementById('bar') as HTMLElement;
const list = document.getElementById('tabs') as HTMLElement;
const newButton = document.getElementById('new') as HTMLButtonElement;

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Distance below the bar (or outside the window) that turns a drag into a detach. */
const DETACH_DISTANCE = 56;

let state: TabsState = { tabs: [], fullScreen: false };
let dragging = false;

function render(): void {
  if (dragging) return; // the list is rebuilt once the gesture ends
  bar.classList.toggle('is-fullscreen', state.fullScreen);
  list.textContent = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.active ? ' is-active' : ''}${tab.loading ? ' is-loading' : ''}`;
    el.dataset.id = tab.id;
    if (tab.color) el.dataset.color = tab.color;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(tab.active));
    el.title = tab.title;

    const dot = document.createElement('span');
    dot.className = 'tab__color';
    const title = document.createElement('span');
    title.className = 'tab__title';
    title.textContent = tab.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab__close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Fermer l’onglet');
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      api?.close(tab.id);
    });
    el.append(dot, title, close);

    el.addEventListener('pointerdown', (e) => onPointerDown(e, el, tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        api?.close(tab.id);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api?.menu(tab.id);
    });
    list.append(el);
  }
}

function onPointerDown(event: PointerEvent, el: HTMLElement, id: string): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const wasActive = el.classList.contains('is-active');
  const elements = [...list.children] as HTMLElement[];
  const slots = elements.map((e) => ({ left: e.offsetLeft, width: e.offsetWidth }));
  const from = elements.indexOf(el);
  let moved = false;
  dragging = true; // state pushes are applied once the gesture ends (the element must survive)
  if (!wasActive) api?.select(id);
  el.setPointerCapture(event.pointerId);

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD && e.clientY >= 0 && e.clientY < bar.offsetHeight) return;
    moved = true;
    el.classList.add('is-dragging');
    el.style.transform = `translateX(${dx}px)`;
  };
  const onUp = (e: PointerEvent) => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragging = false;
    if (!moved) {
      render();
      return;
    }
    const outside =
      e.clientY > bar.offsetHeight + DETACH_DISTANCE ||
      e.clientY < -DETACH_DISTANCE ||
      e.clientX < -DETACH_DISTANCE ||
      e.clientX > window.innerWidth + DETACH_DISTANCE;
    if (outside && state.tabs.length > 1) {
      api?.detach(id, e.screenX, e.screenY);
    } else {
      const to = dropIndex(slots[from]!.left + slots[from]!.width / 2 + (e.clientX - startX), slots);
      if (to !== from) api?.move(id, to);
    }
    render();
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

newButton.addEventListener('click', () => api?.newTab());
api?.onState((next) => {
  state = next;
  render();
});
void api?.get().then((initial) => {
  state = initial;
  render();
});
