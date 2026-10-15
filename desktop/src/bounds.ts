// Window size/position: restore the last one, cascade new windows, never open off-screen.
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { getConfig, updateConfig, type WindowBounds } from './config';

const DEFAULT_SIZE = { width: 1280, height: 840 };
const CASCADE_OFFSET = 28;
const MIN_VISIBLE = 120;

export const MIN_WINDOW_SIZE = { width: 720, height: 480 };

export interface InitialBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** Bounds for a new app window: next to `cascadeFrom` if given, else the remembered ones. */
export function initialBounds(cascadeFrom?: BrowserWindow | null): InitialBounds {
  if (cascadeFrom && !cascadeFrom.isDestroyed() && !cascadeFrom.isFullScreen()) {
    const b = cascadeFrom.getNormalBounds();
    return fitOnScreen({ ...b, x: b.x + CASCADE_OFFSET, y: b.y + CASCADE_OFFSET }, false);
  }
  const saved = getConfig().windowBounds;
  if (saved) return fitOnScreen(saved, !!saved.maximized);
  return { ...DEFAULT_SIZE, maximized: false };
}

export function fitOnScreen(bounds: WindowBounds, maximized: boolean): InitialBounds {
  const width = Math.max(MIN_WINDOW_SIZE.width, bounds.width);
  const height = Math.max(MIN_WINDOW_SIZE.height, bounds.height);
  if (bounds.x === undefined || bounds.y === undefined) return { width, height, maximized };
  const rect: Rectangle = { x: bounds.x, y: bounds.y, width, height };
  const area = screen.getDisplayMatching(rect).workArea;
  const visibleW = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const visibleH = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  if (visibleW >= MIN_VISIBLE && visibleH >= MIN_VISIBLE) {
    // Mostly visible: keep, but pull it back inside if the cascade pushed it past the edge.
    const w = Math.min(width, area.width);
    const h = Math.min(height, area.height);
    const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - w);
    const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - h);
    return { x, y, width: w, height: h, maximized };
  }
  // Off-screen (display unplugged…): centre on the primary display.
  const primary = screen.getPrimaryDisplay().workArea;
  const w = Math.min(width, primary.width);
  const h = Math.min(height, primary.height);
  return {
    x: Math.round(primary.x + (primary.width - w) / 2),
    y: Math.round(primary.y + (primary.height - h) / 2),
    width: w,
    height: h,
    maximized,
  };
}

/** Remembers the window geometry (debounced) whenever it moves or is resized, and on close. */
export function trackBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getNormalBounds();
    updateConfig({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', save);
}
