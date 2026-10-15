// Interactive canvas editor (H1). One SVG in a camera transform (screen = world × zoom + offset);
// objects are memoised per id, so a Yjs change re-renders only what changed. Gestures write to
// Yjs once, when they end (moves and resizes are previewed locally), in one undoable transaction.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import {
  CANVAS_LIMITS,
  positionBetween,
  sanitizeCanvasObject,
  type CanvasEnd,
  type CanvasObject,
  type CanvasShapeKind,
  type CanvasColor,
  type CanvasRoute,
  type MindNode,
} from '@oriel/shared';
import { api } from '../lib/api';
import { toast, openPagePicker } from '../lib/ui';
import { appNavigate, isMac, pagePath, pickFile, sharePath, userColor, copyToClipboard } from '../lib/util';
import { cid, byZ, makeFrame, makeNote, makeShape, makeText, topZ, zAbove, zBelow, type Point, type Rect } from './model';
import {
  HANDLES,
  alignRects,
  connectorRoute,
  containsPoint,
  containsRect,
  distributeRects,
  handlePoint,
  intersects,
  mindLayoutOf,
  nearPolyline,
  normRect,
  objectBounds,
  resizeRect,
  scaleObject,
  setMindMeasure,
  simplify,
  snapRect,
  strokeFromPoints,
  strokePoints,
  translateObject,
  unionRects,
  type AlignMode,
  type Guides,
  type Handle,
  type Route,
} from './geometry';
import { freehandPath } from './paths';
import { ObjectBody, objectTransform, type RenderEnv } from './render';
import { useCanvasObjects, useUndoState, type CanvasStore } from './store';
import { addChild, addSibling, clean, findNode, fromOutline, looksLikeOutline, neighbour, removeNode, setText, toOutline, toggleCollapsed } from './mindmap/ops';
import { MIND_FONT } from './mindmap/layout';
import { CanvasChrome, type Tool } from './ui';
import { framesInOrder } from './viewer';

// --- text measure for mind maps (canvas 2D) ----------------------------------------------------

{
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (ctx) {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'sans-serif';
    setMindMeasure((text, depth) => {
      const fs = MIND_FONT(depth);
      const padX = depth === 0 ? 20 : 12;
      const padY = depth === 0 ? 12 : 7;
      ctx.font = `${depth === 0 ? 600 : 400} ${fs}px ${family}`;
      const textW = Math.max(fs * 2, ctx.measureText(text || 'Idée').width + 2);
      const max = 280;
      const lines = Math.max(1, Math.ceil(textW / max));
      return { w: Math.round(Math.min(textW, max) + padX * 2), h: Math.round(lines * fs * 1.35 + padY * 2) };
    });
  }
}

// --- types -------------------------------------------------------------------------------------

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

type Preview =
  | { kind: 'move'; ids: Set<string>; dx: number; dy: number; guides: Guides }
  | { kind: 'resize'; ids: Set<string>; from: Rect; to: Rect }
  | { kind: 'marquee'; rect: Rect }
  | { kind: 'create'; rect: Rect }
  | { kind: 'draw'; points: Point[] }
  | { kind: 'connector'; from: CanvasEnd; to: CanvasEnd }
  | { kind: 'end'; id: string; which: 'from' | 'to'; end: CanvasEnd }
  | { kind: 'erase'; ids: Set<string> };

interface Editing {
  id: string;
  /** Mind map node being edited. */
  node?: string;
}

export interface Style {
  shape: CanvasShapeKind;
  penColor: CanvasColor;
  penSize: number;
  highlighterColor: CanvasColor;
  noteColor: CanvasColor;
  route: CanvasRoute;
}

const CLIPBOARD_PREFIX = 'oriel-canvas:';
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac() ? e.metaKey : e.ctrlKey);
const resizable = (o: CanvasObject) => o.type !== 'connector' && o.type !== 'mindmap';
const editableText = (o: CanvasObject) => o.type === 'shape' || o.type === 'text' || o.type === 'note' || o.type === 'connector' || o.type === 'frame';

/** Saved camera per canvas (this browser only). */
function loadCamera(pageId: string): Camera | null {
  try {
    const raw = localStorage.getItem(`oriel:canvas-camera:${pageId}`);
    if (!raw) return null;
    const c = JSON.parse(raw) as Camera;
    return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom) ? { ...c, zoom: clampZoom(c.zoom) } : null;
  } catch {
    return null;
  }
}
function saveCamera(pageId: string, c: Camera) {
  try {
    localStorage.setItem(`oriel:canvas-camera:${pageId}`, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

// --- object node -------------------------------------------------------------------------------

const ObjectNode = memo(function ObjectNode({
  o,
  route,
  env,
  editing,
  zoom,
  mindSelected,
  mindEditing,
  hidden,
}: {
  o: CanvasObject;
  route?: Route;
  env: RenderEnv;
  editing: boolean;
  zoom: number;
  mindSelected: string | null;
  mindEditing: string | null;
  hidden: boolean;
}) {
  return (
    <g
      data-cv-id={o.id}
      transform={objectTransform(o)}
      className={`or-cv-obj or-cv-obj--${o.type}${o.locked ? ' is-locked' : ''}`}
      style={hidden ? { opacity: 0.25 } : undefined}
    >
      <ObjectBody o={o} route={route} env={env} editing={editing} zoom={zoom} mind={{ selectedNode: mindSelected, editingNode: mindEditing }} />
    </g>
  );
});

/** All rendered objects; memoised so that a camera move alone re-renders nothing here. */
const ObjectsLayer = memo(function ObjectsLayer({
  visible,
  routes,
  env,
  editing,
  frameZoom,
  mindNode,
  erased,
}: {
  visible: CanvasObject[];
  routes: Map<string, Route>;
  env: RenderEnv;
  editing: Editing | null;
  frameZoom: number;
  mindNode: { map: string; node: string } | null;
  erased: Set<string> | null;
}) {
  return (
    <>
      {visible.map((o) => (
        <ObjectNode
          key={o.id}
          o={o}
          route={routes.get(o.id)}
          env={env}
          editing={editing?.id === o.id && !editing.node}
          zoom={o.type === 'frame' ? frameZoom : 1}
          mindSelected={mindNode?.map === o.id ? mindNode.node : null}
          mindEditing={editing?.id === o.id ? (editing.node ?? null) : null}
          hidden={!!erased?.has(o.id)}
        />
      ))}
    </>
  );
});

// --- editor ------------------------------------------------------------------------------------

export function CanvasEditor({
  store,
  awareness,
  pageId,
  workspaceId,
  readOnly,
  publicMode,
  userId,
  userName,
}: {
  store: CanvasStore;
  awareness: Awareness | null;
  pageId: string;
  workspaceId: string | null;
  readOnly: boolean;
  publicMode: boolean;
  userId: string | null;
  userName: string;
}) {
  const objects = useCanvasObjects(store);
  const undoState = useUndoState(store);
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [camera, setCamera] = useState<Camera>(() => loadCamera(pageId) ?? { x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const [tool, setToolState] = useState<Tool>(readOnly ? 'hand' : 'select');
  const [style, setStyle] = useState<Style>({ shape: 'rounded', penColor: 'default', penSize: 4, highlighterColor: 'yellow', noteColor: 'yellow', route: 'curve' });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [mindNode, setMindNode] = useState<{ map: string; node: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [spacePan, setSpacePan] = useState(false);
  const [presenting, setPresenting] = useState<string | null>(null);
  const [peers, setPeers] = useState<Array<{ id: number; name: string; color: string; x: number; y: number }>>([]);
  const env = useMemo<RenderEnv>(() => ({ publicMode }), [publicMode]);
  const get = useCallback((id: string) => objects.get(id), [objects]);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const pasteCount = useRef(0);

  const setTool = useCallback(
    (t: Tool) => {
      setToolState(readOnly && t !== 'hand' && t !== 'select' ? 'hand' : t);
      if (t !== 'select') setMindNode(null);
    },
    [readOnly],
  );

  useEffect(() => {
    if (readOnly) setToolState((t) => (t === 'hand' || t === 'select' ? t : 'hand'));
  }, [readOnly]);

  // Viewport size.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Camera persistence (debounced).
  useEffect(() => {
    const t = setTimeout(() => saveCamera(pageId, camera), 300);
    return () => clearTimeout(t);
  }, [pageId, camera]);

  // Drop selection entries that disappeared (remote deletion, undo).
  useEffect(() => {
    if ([...selection].some((id) => !objects.has(id))) setSelection(new Set([...selection].filter((id) => objects.has(id))));
    if (mindNode && !objects.has(mindNode.map)) setMindNode(null);
    if (editing && !objects.has(editing.id)) setEditing(null);
  }, [objects, selection, mindNode, editing]);

  // --- coordinates --------------------------------------------------------------------------------

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    const c = cameraRef.current;
    return { x: (clientX - r.left - c.x) / c.zoom, y: (clientY - r.top - c.y) / c.zoom };
  }, []);

  const viewRect = useMemo<Rect>(
    () => ({ x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, w: size.w / camera.zoom, h: size.h / camera.zoom }),
    [camera, size],
  );

  const zoomAt = useCallback((factor: number, screen?: Point) => {
    setCamera((c) => {
      const zoom = clampZoom(c.zoom * factor);
      const p = screen ?? { x: (rootRef.current?.clientWidth ?? 800) / 2, y: (rootRef.current?.clientHeight ?? 600) / 2 };
      const wx = (p.x - c.x) / c.zoom;
      const wy = (p.y - c.y) / c.zoom;
      return { zoom, x: p.x - wx * zoom, y: p.y - wy * zoom };
    });
  }, []);

  const fitRect = useCallback((r: Rect | null, maxZoom = 1) => {
    if (!r) {
      setCamera({ x: (rootRef.current?.clientWidth ?? 800) / 2, y: (rootRef.current?.clientHeight ?? 600) / 2, zoom: 1 });
      return;
    }
    const w = rootRef.current?.clientWidth ?? 800;
    const h = rootRef.current?.clientHeight ?? 600;
    const pad = 64;
    const zoom = clampZoom(Math.min(maxZoom, (w - pad * 2) / Math.max(1, r.w), (h - pad * 2) / Math.max(1, r.h)));
    setCamera({ zoom, x: w / 2 - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + r.h / 2) * zoom });
  }, []);

  const allBounds = useCallback(() => unionRects([...objectsRef.current.values()].map((o) => objectBounds(o, (id) => objectsRef.current.get(id)))), []);

  // First display without a saved camera: show everything.
  const fitted = useRef(!!loadCamera(pageId));
  useEffect(() => {
    if (fitted.current || size.w < 10) return;
    fitted.current = true;
    fitRect(allBounds());
  }, [size, fitRect, allBounds]);

  // Wheel: pan, or zoom with ⌘/Ctrl (trackpad pinch sends ctrlKey).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.('.or-cv-chrome-scroll')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), { x: e.clientX - r.left, y: e.clientY - r.top });
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        setCamera((c) => ({ ...c, x: c.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k, y: c.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // --- presence ----------------------------------------------------------------------------------

  useEffect(() => {
    if (!awareness || publicMode || !userId) return;
    awareness.setLocalStateField('user', { id: userId, name: userName, color: userColor(userId) });
    const update = () => {
      const list: Array<{ id: number; name: string; color: string; x: number; y: number }> = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const user = state.user as { name?: string; color?: string } | undefined;
        const cur = state.cvCursor as { x?: unknown; y?: unknown } | undefined;
        if (!user?.name || !cur || typeof cur.x !== 'number' || typeof cur.y !== 'number' || !Number.isFinite(cur.x) || !Number.isFinite(cur.y)) return;
        const color = typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#888888';
        list.push({ id: clientId, name: String(user.name).slice(0, 60), color, x: cur.x, y: cur.y });
      });
      setPeers(list);
    };
    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
      awareness.setLocalStateField('cvCursor', null);
    };
  }, [awareness, publicMode, userId, userName]);

  const lastCursor = useRef(0);
  const broadcastCursor = (p: Point) => {
    if (!awareness || publicMode) return;
    const now = performance.now();
    if (now - lastCursor.current < 60) return;
    lastCursor.current = now;
    awareness.setLocalStateField('cvCursor', { x: Math.round(p.x), y: Math.round(p.y) });
  };

  // --- selection helpers ---------------------------------------------------------------------------

  /** Ids with their group mates. */
  const withGroups = useCallback((ids: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    const groups = new Set<string>();
    for (const id of ids) {
      const o = objectsRef.current.get(id);
      if (!o) continue;
      out.add(id);
      if (o.groupId) groups.add(o.groupId);
    }
    if (groups.size > 0) for (const o of objectsRef.current.values()) if (o.groupId && groups.has(o.groupId)) out.add(o.id);
    return out;
  }, []);

  const select = useCallback((ids: Iterable<string>) => {
    setSelection(new Set(ids));
    setMindNode(null);
  }, []);

  // --- writes --------------------------------------------------------------------------------------

  const put = useCallback(
    (list: CanvasObject[]) => {
      if (readOnly) return;
      store.put(list);
    },
    [store, readOnly],
  );

  const insert = useCallback(
    (list: CanvasObject[], selectThem = true) => {
      if (readOnly || list.length === 0) return;
      if (objectsRef.current.size + list.length > CANVAS_LIMITS.objects) {
        toast.error(`Un canevas contient au plus ${CANVAS_LIMITS.objects} objets.`);
        return;
      }
      store.checkpoint();
      store.put(list);
      store.checkpoint();
      if (selectThem) select(list.map((o) => o.id));
    },
    [store, readOnly, select],
  );

  const removeIds = useCallback(
    (ids: Iterable<string>) => {
      if (readOnly) return;
      const list = [...ids].filter((id) => !objectsRef.current.get(id)?.locked);
      if (list.length === 0) return;
      // Connectors attached to removed objects become free at their last position.
      const gone = new Set(list);
      const detached: CanvasObject[] = [];
      for (const o of objectsRef.current.values()) {
        if (o.type !== 'connector' || gone.has(o.id)) continue;
        const r = connectorRoute(o, (id) => objectsRef.current.get(id));
        const free = (e: CanvasEnd, p: Point): CanvasEnd => ('id' in e && gone.has(e.id) ? { x: p.x, y: p.y } : e);
        const next = { ...o, from: free(o.from, r.start), to: free(o.to, r.end) };
        if (next.from !== o.from || next.to !== o.to) detached.push(next);
      }
      store.checkpoint();
      store.transact(() => {
        for (const d of detached) store.map.set(d.id, d);
        for (const id of list) store.map.delete(id);
      });
      store.checkpoint();
      setSelection(new Set());
      setMindNode(null);
    },
    [store, readOnly],
  );

  // --- display (objects with the gesture preview applied) --------------------------------------

  const display = useMemo(() => {
    if (!preview || (preview.kind !== 'move' && preview.kind !== 'resize' && preview.kind !== 'end')) return objects;
    const next = new Map(objects);
    if (preview.kind === 'move') {
      for (const id of preview.ids) {
        const o = objects.get(id);
        if (o && !o.locked) next.set(id, translateObject(o, preview.dx, preview.dy));
      }
    } else if (preview.kind === 'resize') {
      for (const id of preview.ids) {
        const o = objects.get(id);
        if (o && !o.locked) next.set(id, scaleObject(o, preview.from, preview.to));
      }
    } else {
      const o = objects.get(preview.id);
      if (o?.type === 'connector') next.set(o.id, { ...o, [preview.which]: preview.end });
    }
    return next;
  }, [objects, preview]);
  const displayGet = useCallback((id: string) => display.get(id), [display]);

  const sorted = useMemo(() => [...display.values()].sort(byZ), [display]);
  const routes = useMemo(() => {
    const m = new Map<string, Route>();
    for (const o of sorted) if (o.type === 'connector') m.set(o.id, connectorRoute(o, displayGet));
    return m;
  }, [sorted, displayGet]);
  const boundsCache = useMemo(() => new Map<string, Rect>(), [display]);
  const boundsOf = useCallback(
    (o: CanvasObject) => {
      let b = boundsCache.get(o.id);
      if (!b) {
        b = objectBounds(o, displayGet);
        boundsCache.set(o.id, b);
      }
      return b;
    },
    [boundsCache, displayGet],
  );

  // Culling: objects outside a cull area (the view plus half of it on each side) are not rendered,
  // except the selection. The area only changes when the view leaves it or the zoom changes a lot,
  // so panning usually re-renders nothing but the camera transform.
  const cullRef = useRef<{ rect: Rect; zoom: number } | null>(null);
  const cull = useMemo(() => {
    const prev = cullRef.current;
    if (prev && containsRect(prev.rect, viewRect) && camera.zoom / prev.zoom < 1.5 && prev.zoom / camera.zoom < 1.5) return prev.rect;
    const rect = { x: viewRect.x - viewRect.w / 2, y: viewRect.y - viewRect.h / 2, w: viewRect.w * 2, h: viewRect.h * 2 };
    cullRef.current = { rect, zoom: camera.zoom };
    return rect;
  }, [viewRect, camera.zoom]);
  const visible = useMemo(() => sorted.filter((o) => selection.has(o.id) || intersects(boundsOf(o), cull)), [sorted, cull, selection, boundsOf]);

  const selectionBounds = useMemo(() => unionRects([...selection].map((id) => display.get(id)).filter((o): o is CanvasObject => !!o).map(boundsOf)), [selection, display, boundsOf]);
  const selected = useMemo(() => [...selection].map((id) => objects.get(id)).filter((o): o is CanvasObject => !!o), [selection, objects]);

  // --- hit testing ---------------------------------------------------------------------------------

  const hitObject = (target: EventTarget | null): string | null => {
    const el = (target as Element | null)?.closest?.('[data-cv-id]');
    return el?.getAttribute('data-cv-id') ?? null;
  };

  /** Top-most object under a point that a connector can attach to. */
  const attachTarget = (p: Point, exclude?: string): string | null => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const o = sorted[i]!;
      if (o.id === exclude || o.type === 'connector' || o.type === 'stroke') continue;
      if (o.type === 'frame' && !containsPoint({ x: o.x, y: o.y, w: o.w, h: 0.001 }, p)) continue;
      if (containsPoint(boundsOf(o), p)) return o.id;
    }
    return null;
  };

  // --- gestures -----------------------------------------------------------------------------------

  const gesture = useRef<
    | null
    | { kind: 'pan'; start: Point; cam: Camera }
    | { kind: 'move'; start: Point; ids: Set<string>; others: Rect[]; base: Rect | null; moved: boolean }
    | { kind: 'resize'; start: Point; handle: Handle; ids: Set<string>; from: Rect }
    | { kind: 'marquee'; start: Point; additive: boolean }
    | { kind: 'create'; start: Point; tool: Tool }
    | { kind: 'draw'; points: Point[]; tool: 'pen' | 'highlighter' }
    | { kind: 'connector'; start: Point; from: CanvasEnd }
    | { kind: 'end'; id: string; which: 'from' | 'to' }
    | { kind: 'erase'; ids: Set<string> }
  >(null);

  const finishEditing = useRef<() => void>(() => undefined);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (presenting) return;
    finishEditing.current();
    // No compatibility mousedown: its default focus change would blur the text editor opened below.
    e.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const p = toWorld(e.clientX, e.clientY);
    const panning = e.button === 1 || tool === 'hand' || spacePan;
    if (e.button === 2) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    if (panning) {
      gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, cam: cameraRef.current };
      // Read-only: a click on a page card or a file opens it.
      if (readOnly && e.button === 0) {
        const id = hitObject(e.target);
        const o = id ? objects.get(id) : undefined;
        if (o?.type === 'page' || o?.type === 'file') pendingOpen.current = { id: o.id, x: e.clientX, y: e.clientY };
      }
      return;
    }
    const el = e.target as Element;
    if (tool === 'select') {
      const handle = el.closest('[data-cv-handle]')?.getAttribute('data-cv-handle') as Handle | null;
      if (handle && selectionBounds) {
        const ids = new Set([...selection].filter((id) => !objects.get(id)?.locked));
        if (ids.size > 0) gesture.current = { kind: 'resize', start: p, handle, ids, from: selectionBounds };
        return;
      }
      const endHandle = el.closest('[data-cv-end]')?.getAttribute('data-cv-end') as 'from' | 'to' | null;
      if (endHandle && selected.length === 1 && selected[0]!.type === 'connector') {
        gesture.current = { kind: 'end', id: selected[0]!.id, which: endHandle };
        return;
      }
      const toggle = el.closest('[data-cv-toggle]')?.getAttribute('data-cv-toggle');
      const id = hitObject(e.target);
      const o = id ? objects.get(id) : undefined;
      if (o) {
        let ids: Set<string>;
        if (o.type === 'mindmap') {
          const node = toggle ?? el.closest('[data-cv-node]')?.getAttribute('data-cv-node') ?? null;
          if (toggle && !readOnly) put([{ ...o, root: clean(toggleCollapsed(o.root, toggle)) }]);
          ids = selection.has(o.id) && !node ? new Set(selection) : new Set([o.id]);
          setSelection(ids);
          setMindNode(node ? { map: o.id, node } : null);
        } else {
          if (e.shiftKey) {
            ids = new Set(selection);
            const has = selection.has(o.id);
            for (const g of withGroups([o.id])) {
              if (has) ids.delete(g);
              else ids.add(g);
            }
          } else ids = selection.has(o.id) ? new Set(selection) : withGroups([o.id]);
          setSelection(ids);
          setMindNode(null);
          if (!ids.has(o.id)) return;
        }
        if (readOnly) return;
        ids = new Set(ids);
        // Frames carry what they contain.
        for (const sid of [...ids]) {
          const f = objects.get(sid);
          if (f?.type !== 'frame') continue;
          for (const other of objects.values()) if (other.id !== f.id && !other.locked && containsRect(f, boundsOf(other))) ids.add(other.id);
        }
        for (const sid of [...ids]) if (objects.get(sid)?.locked) ids.delete(sid);
        if (ids.size === 0) return;
        const moving = [...ids].map((i) => objects.get(i)).filter((x): x is CanvasObject => !!x);
        const base = unionRects(moving.filter((m) => m.type !== 'connector').map(boundsOf));
        const near = { x: viewRect.x, y: viewRect.y, w: viewRect.w, h: viewRect.h };
        const others: Rect[] = [];
        for (const other of sorted) {
          if (ids.has(other.id) || other.type === 'connector' || other.type === 'stroke') continue;
          const b = boundsOf(other);
          if (intersects(b, near)) others.push(b);
          if (others.length > 400) break;
        }
        gesture.current = { kind: 'move', start: p, ids, others, base, moved: false };
        return;
      }
      gesture.current = { kind: 'marquee', start: p, additive: e.shiftKey };
      if (!e.shiftKey) {
        setSelection(new Set());
        setMindNode(null);
      }
      return;
    }
    if (readOnly) return;
    switch (tool) {
      case 'pen':
      case 'highlighter':
        gesture.current = { kind: 'draw', points: [p], tool };
        setPreview({ kind: 'draw', points: [p] });
        return;
      case 'eraser': {
        gesture.current = { kind: 'erase', ids: new Set() };
        eraseAt(p);
        return;
      }
      case 'connector': {
        const target = attachTarget(p);
        const from: CanvasEnd = target ? { id: target } : { x: p.x, y: p.y };
        gesture.current = { kind: 'connector', start: p, from };
        setPreview({ kind: 'connector', from, to: { x: p.x, y: p.y } });
        return;
      }
      case 'text': {
        const [z] = zAbove(objects.values());
        const o = makeText({ x: p.x, y: p.y - 14, z: z!, fontSize: 'm' });
        insert([o]);
        setEditing({ id: o.id });
        setTool('select');
        return;
      }
      case 'mindmap': {
        const [z] = zAbove(objects.values());
        const root = { id: cid(), text: 'Idée centrale', children: [] };
        const o: CanvasObject = { id: cid(), type: 'mindmap', x: p.x, y: p.y, w: 160, h: 48, z: z!, layout: 'right', style: 'classic', root };
        insert([o]);
        setMindNode({ map: o.id, node: root.id });
        setEditing({ id: o.id, node: root.id });
        setTool('select');
        return;
      }
      default:
        gesture.current = { kind: 'create', start: p, tool };
        setPreview({ kind: 'create', rect: { x: p.x, y: p.y, w: 0, h: 0 } });
    }
  };

  const pendingOpen = useRef<{ id: string; x: number; y: number } | null>(null);

  const eraseAt = (p: Point) => {
    const g = gesture.current;
    if (!g || g.kind !== 'erase') return;
    const radius = 8 / cameraRef.current.zoom;
    for (const o of sorted) {
      if (o.type !== 'stroke' || o.locked || g.ids.has(o.id)) continue;
      const b = boundsOf(o);
      if (!containsPoint({ x: b.x - radius, y: b.y - radius, w: b.w + radius * 2, h: b.h + radius * 2 }, p)) continue;
      if (nearPolyline(strokePoints(o), p, radius + o.size / 2)) g.ids.add(o.id);
    }
    setPreview({ kind: 'erase', ids: new Set(g.ids) });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    broadcastCursor(p);
    const g = gesture.current;
    if (!g) return;
    switch (g.kind) {
      case 'pan':
        if (pendingOpen.current && Math.hypot(e.clientX - pendingOpen.current.x, e.clientY - pendingOpen.current.y) > 4) pendingOpen.current = null;
        setCamera({ ...g.cam, x: g.cam.x + e.clientX - g.start.x, y: g.cam.y + e.clientY - g.start.y });
        return;
      case 'move': {
        let dx = p.x - g.start.x;
        let dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * cameraRef.current.zoom < 3) return;
        g.moved = true;
        let guides: Guides = { x: [], y: [] };
        if (g.base && !e.altKey) {
          const s = snapRect({ ...g.base, x: g.base.x + dx, y: g.base.y + dy }, g.others, 6 / cameraRef.current.zoom);
          dx += s.dx;
          dy += s.dy;
          guides = s.guides;
        }
        setPreview({ kind: 'move', ids: g.ids, dx, dy, guides });
        return;
      }
      case 'resize': {
        const to = resizeRect(g.from, g.handle, p.x - g.start.x, p.y - g.start.y, e.shiftKey || [...g.ids].some((id) => objects.get(id)?.type === 'image'));
        setPreview({ kind: 'resize', ids: g.ids, from: g.from, to });
        return;
      }
      case 'marquee':
        setPreview({ kind: 'marquee', rect: normRect(g.start, p) });
        return;
      case 'create': {
        let r = normRect(g.start, p);
        if (e.shiftKey) {
          const s = Math.max(r.w, r.h);
          r = { x: p.x < g.start.x ? g.start.x - s : g.start.x, y: p.y < g.start.y ? g.start.y - s : g.start.y, w: s, h: s };
        }
        setPreview({ kind: 'create', rect: r });
        return;
      }
      case 'draw': {
        const last = g.points[g.points.length - 1]!;
        if (Math.hypot(p.x - last.x, p.y - last.y) * cameraRef.current.zoom < 1.5) return;
        if (g.points.length >= CANVAS_LIMITS.strokeNumbers / 2 - 1) return;
        g.points.push(p);
        setPreview({ kind: 'draw', points: [...g.points] });
        return;
      }
      case 'connector': {
        const target = attachTarget(p, 'id' in g.from ? g.from.id : undefined);
        setPreview({ kind: 'connector', from: g.from, to: target ? { id: target } : { x: p.x, y: p.y } });
        return;
      }
      case 'end': {
        const c = objects.get(g.id);
        if (c?.type !== 'connector') return;
        const other = g.which === 'from' ? c.to : c.from;
        const target = attachTarget(p, 'id' in other ? other.id : undefined);
        setPreview({ kind: 'end', id: g.id, which: g.which, end: target ? { id: target } : { x: p.x, y: p.y } });
        return;
      }
      case 'erase':
        eraseAt(p);
        return;
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = null;
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (pendingOpen.current) {
      const id = pendingOpen.current.id;
      pendingOpen.current = null;
      openObject(id);
    }
    const pv = preview;
    setPreview(null);
    if (!g) return;
    switch (g.kind) {
      case 'move':
        if (pv?.kind === 'move' && (pv.dx !== 0 || pv.dy !== 0)) {
          store.checkpoint();
          put([...g.ids].map((id) => objects.get(id)).filter((o): o is CanvasObject => !!o && !o.locked).map((o) => translateObject(o, pv.dx, pv.dy)));
          store.checkpoint();
        }
        return;
      case 'resize':
        if (pv?.kind === 'resize') {
          store.checkpoint();
          put([...g.ids].map((id) => objects.get(id)).filter((o): o is CanvasObject => !!o && !o.locked).map((o) => scaleObject(o, pv.from, pv.to)));
          store.checkpoint();
        }
        return;
      case 'marquee': {
        if (pv?.kind !== 'marquee' || pv.rect.w * camera.zoom < 3) return;
        const hit = sorted.filter((o) => !o.locked && containsRect(pv.rect, boundsOf(o))).map((o) => o.id);
        const next = new Set(g.additive ? selection : []);
        for (const id of withGroups(hit)) next.add(id);
        setSelection(next);
        return;
      }
      case 'create': {
        const r = pv?.kind === 'create' ? pv.rect : { x: g.start.x, y: g.start.y, w: 0, h: 0 };
        const tiny = r.w * camera.zoom < 6 && r.h * camera.zoom < 6;
        const sized = (w: number, h: number): Rect => (tiny ? { x: g.start.x - w / 2, y: g.start.y - h / 2, w, h } : r);
        let o: CanvasObject | null = null;
        if (g.tool === 'shape') o = makeShape({ ...sized(160, 100), z: zAbove(objects.values())[0]!, shape: style.shape });
        else if (g.tool === 'note') o = makeNote({ ...sized(220, 180), z: zAbove(objects.values())[0]!, fill: style.noteColor });
        else if (g.tool === 'frame') {
          const frames = framesInOrder(objects);
          o = makeFrame({ ...sized(640, 360), z: zBelow(objects.values()), name: `Cadre ${frames.length + 1}`, order: positionBetween(frames.at(-1)?.order ?? null, null) });
        }
        if (o) {
          insert([o]);
          if (o.type === 'note') setEditing({ id: o.id });
        }
        setTool('select');
        return;
      }
      case 'draw': {
        const pts = simplify(g.points, 1.2 / camera.zoom);
        const size = g.tool === 'highlighter' ? style.penSize * 4 + 8 : style.penSize;
        const box = strokeFromPoints(pts.length === 1 ? [pts[0]!, { x: pts[0]!.x + 0.1, y: pts[0]!.y + 0.1 }] : pts, size);
        const o: CanvasObject = {
          id: cid(),
          type: 'stroke',
          ...box,
          z: zAbove(objects.values())[0]!,
          tool: g.tool,
          color: g.tool === 'highlighter' ? style.highlighterColor : style.penColor,
          size,
        };
        insert([o], false);
        return;
      }
      case 'connector': {
        if (pv?.kind !== 'connector') return;
        const free = (e2: CanvasEnd) => ('id' in e2 ? null : e2);
        const a = free(pv.from);
        const b = free(pv.to);
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) * camera.zoom < 8) return;
        if ('id' in pv.from && 'id' in pv.to && pv.from.id === pv.to.id) return;
        const o: CanvasObject = {
          id: cid(),
          type: 'connector',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          z: zAbove(objects.values())[0]!,
          from: pv.from,
          to: pv.to,
          route: style.route,
          startCap: 'none',
          endCap: 'arrow',
          color: 'default',
          strokeWidth: 2,
          dash: 'solid',
          label: '',
        };
        insert([o]);
        setTool('select');
        return;
      }
      case 'end': {
        if (pv?.kind !== 'end') return;
        const c = objects.get(g.id);
        if (c?.type === 'connector') {
          store.checkpoint();
          put([{ ...c, [g.which]: pv.end }]);
        }
        return;
      }
      case 'erase':
        if (g.ids.size > 0) removeIds(g.ids);
        return;
    }
  };

  // --- open / edit -----------------------------------------------------------------------------------

  const openObject = (id: string) => {
    const o = objectsRef.current.get(id);
    if (!o) return;
    if (o.type === 'page') appNavigate(publicMode ? sharePath(o.pageId) : workspaceId ? pagePath(workspaceId, o.pageId) : sharePath(o.pageId));
    else if (o.type === 'file' || o.type === 'image') window.open(o.src, '_blank', 'noopener,noreferrer');
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (presenting) return;
    const id = hitObject(e.target);
    const o = id ? objects.get(id) : undefined;
    if (!o) {
      if (readOnly || tool !== 'select') return;
      const p = toWorld(e.clientX, e.clientY);
      const t = makeText({ x: p.x, y: p.y - 14, z: zAbove(objects.values())[0]! });
      insert([t]);
      setEditing({ id: t.id });
      return;
    }
    if (o.type === 'page' || o.type === 'file') return openObject(o.id);
    if (readOnly || o.locked) return;
    if (o.type === 'mindmap') {
      const node = (e.target as Element).closest('[data-cv-node]')?.getAttribute('data-cv-node');
      if (node) {
        setMindNode({ map: o.id, node });
        setEditing({ id: o.id, node });
      }
      return;
    }
    if (editableText(o)) {
      setSelection(new Set([o.id]));
      setEditing({ id: o.id });
    }
  };

  // --- mind map commands ----------------------------------------------------------------------------

  const mindCommand = useCallback(
    (cmd: 'child' | 'sibling' | 'remove' | 'toggle', edit = true) => {
      if (!mindNode || readOnly) return false;
      const o = objectsRef.current.get(mindNode.map);
      if (o?.type !== 'mindmap' || o.locked) return false;
      store.checkpoint();
      if (cmd === 'remove') {
        const r = removeNode(o.root, mindNode.node);
        if (!r.root) {
          removeIds([o.id]);
          return true;
        }
        put([{ ...o, root: clean(r.root) }]);
        setMindNode(r.next ? { map: o.id, node: r.next } : null);
        return true;
      }
      if (cmd === 'toggle') {
        put([{ ...o, root: clean(toggleCollapsed(o.root, mindNode.node)) }]);
        return true;
      }
      const res = cmd === 'child' ? addChild(o.root, mindNode.node) : addSibling(o.root, mindNode.node);
      if (!res) {
        toast.error('Limite de la carte mentale atteinte.');
        return true;
      }
      put([{ ...o, root: clean(res.root) }]);
      setMindNode({ map: o.id, node: res.id });
      if (edit) setEditing({ id: o.id, node: res.id });
      return true;
    },
    [mindNode, readOnly, store, put, removeIds],
  );

  // --- clipboard -----------------------------------------------------------------------------------

  const copySelection = useCallback(
    (cut: boolean, data?: DataTransfer | null) => {
      const list = [...selectionRef.current].map((id) => objectsRef.current.get(id)).filter((o): o is CanvasObject => !!o);
      if (list.length === 0) return false;
      const text = `${CLIPBOARD_PREFIX}${JSON.stringify({ v: 1, objects: list })}`;
      if (data) data.setData('text/plain', text);
      else void copyToClipboard(text);
      if (cut) removeIds(list.map((o) => o.id));
      return true;
    },
    [removeIds],
  );

  /** Copies of objects with fresh ids (groups, attached connector ends and mind map nodes kept coherent). */
  const cloneObjects = useCallback((list: CanvasObject[], offset: number): CanvasObject[] => {
    const ids = new Map(list.map((o) => [o.id, cid()]));
    const groups = new Map<string, string>();
    const zs = zAbove(objectsRef.current.values(), list.length);
    const frames = framesInOrder(objectsRef.current);
    let lastOrder = frames.at(-1)?.order ?? null;
    return [...list].sort(byZ).map((o, i) => {
      let c: CanvasObject = { ...translateObject(o, offset, offset), id: ids.get(o.id)!, z: zs[i]! };
      delete (c as { locked?: boolean }).locked;
      if (o.groupId) {
        if (!groups.has(o.groupId)) groups.set(o.groupId, cid());
        c = { ...c, groupId: groups.get(o.groupId)! };
      }
      if (c.type === 'connector') {
        const end = (e: CanvasEnd): CanvasEnd => ('id' in e ? (ids.has(e.id) ? { ...e, id: ids.get(e.id)! } : objectsRef.current.has(e.id) ? e : { x: 0, y: 0 }) : e);
        c = { ...c, from: end(c.from), to: end(c.to) };
      }
      if (c.type === 'frame') {
        lastOrder = positionBetween(lastOrder, null);
        c = { ...c, order: lastOrder, z: zBelow(objectsRef.current.values()) };
      }
      if (c.type === 'mindmap') {
        const reId = (n: MindNode): MindNode => ({ ...n, id: cid(), children: n.children.map(reId) });
        c = { ...c, root: reId(c.root) };
      }
      return c;
    });
  }, []);

  const insertAtCenter = useCallback(
    (o: CanvasObject) => {
      const c = cameraRef.current;
      const w = rootRef.current?.clientWidth ?? 800;
      const h = rootRef.current?.clientHeight ?? 600;
      const center = { x: (w / 2 - c.x) / c.zoom, y: (h / 2 - c.y) / c.zoom };
      const b = objectBounds(o, () => undefined);
      insert([translateObject(o, center.x - (b.x + b.w / 2), center.y - (b.y + b.h / 2))]);
    },
    [insert],
  );

  const uploadFiles = useCallback(
    async (files: File[], at?: Point) => {
      if (readOnly || !workspaceId || files.length === 0) return;
      const c = cameraRef.current;
      const origin = at ?? { x: ((rootRef.current?.clientWidth ?? 800) / 2 - c.x) / c.zoom, y: ((rootRef.current?.clientHeight ?? 600) / 2 - c.y) / c.zoom };
      let dx = 0;
      for (const file of files.slice(0, 20)) {
        try {
          const up = await api.workspaces.upload(workspaceId, file);
          const z = zAbove(objectsRef.current.values())[0]!;
          if (up.mime.startsWith('image/') && up.mime !== 'image/svg+xml') {
            const natural = await new Promise<{ w: number; h: number }>((resolve) => {
              const img = new Image();
              img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
              img.onerror = () => resolve({ w: 400, h: 300 });
              img.src = up.url;
            });
            const k = Math.min(1, 480 / Math.max(natural.w, natural.h));
            const o: CanvasObject = { id: cid(), type: 'image', x: origin.x + dx, y: origin.y, w: natural.w * k, h: natural.h * k, z, src: up.url, name: up.name.slice(0, 300) };
            insert([o]);
            dx += o.w + 24;
          } else {
            const o: CanvasObject = { id: cid(), type: 'file', x: origin.x + dx, y: origin.y, w: 280, h: 64, z, src: up.url, name: up.name.slice(0, 300), mime: up.mime.slice(0, 200), size: up.size };
            insert([o]);
            dx += 304;
          }
        } catch {
          toast.error(`Envoi impossible : ${file.name}`);
        }
      }
    },
    [readOnly, workspaceId, insert],
  );

  const pasteText = useCallback(
    (text: string) => {
      if (readOnly) return;
      if (text.startsWith(CLIPBOARD_PREFIX)) {
        try {
          const parsed = JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as { objects?: unknown[] };
          const list = (parsed.objects ?? []).map((o) => sanitizeCanvasObject(o)).filter((o): o is CanvasObject => !!o);
          if (list.length === 0) return;
          pasteCount.current += 1;
          insert(cloneObjects(list, 24 * pasteCount.current));
        } catch {
          toast.error('Contenu collé illisible.');
        }
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) return;
      const z = zAbove(objectsRef.current.values())[0]!;
      if (looksLikeOutline(trimmed)) {
        const root = fromOutline(trimmed);
        if (root) {
          insertAtCenter({ id: cid(), type: 'mindmap', x: 0, y: 0, w: 1, h: 1, z, layout: 'right', style: 'classic', root });
          toast.success('Liste convertie en carte mentale.');
          return;
        }
      }
      insertAtCenter(makeNote({ x: 0, y: 0, w: 260, h: 200, z, text: trimmed.slice(0, CANVAS_LIMITS.text) }));
    },
    [readOnly, insert, cloneObjects, insertAtCenter],
  );

  useEffect(() => {
    const inside = () => !!rootRef.current && rootRef.current.contains(document.activeElement) && !editingRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!inside()) return;
      if (copySelection(false, e.clipboardData)) e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (!inside() || readOnly) return;
      if (copySelection(true, e.clipboardData)) e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inside() || readOnly || !e.clipboardData) return;
      const files = [...e.clipboardData.files];
      e.preventDefault();
      if (files.length > 0) void uploadFiles(files);
      else pasteText(e.clipboardData.getData('text/plain'));
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [copySelection, pasteText, uploadFiles, readOnly]);

  const editingRef = useRef(editing);
  editingRef.current = editing;

  // --- selection actions ---------------------------------------------------------------------------

  const actions = useMemo(() => {
    const sel = () => [...selectionRef.current].map((id) => objectsRef.current.get(id)).filter((o): o is CanvasObject => !!o);
    const writable = () => sel().filter((o) => !o.locked);
    return {
      patch: (fn: (o: CanvasObject) => CanvasObject) => {
        store.checkpoint();
        put(writable().map(fn));
      },
      remove: () => removeIds(selectionRef.current),
      duplicate: () => insert(cloneObjects(sel(), 24)),
      group: () => {
        const list = writable();
        if (list.length < 2) return;
        const g = cid();
        store.checkpoint();
        put(list.map((o) => ({ ...o, groupId: g })));
      },
      ungroup: () => {
        store.checkpoint();
        put(
          writable().map((o) => {
            const { groupId: _g, ...rest } = o;
            return rest as CanvasObject;
          }),
        );
      },
      lock: (locked: boolean) => {
        store.checkpoint();
        put(sel().map((o) => (locked ? { ...o, locked: true } : (({ locked: _l, ...rest }) => rest as CanvasObject)(o))));
      },
      front: () => {
        const list = writable().sort(byZ);
        const zs = zAbove(objectsRef.current.values(), list.length);
        store.checkpoint();
        put(list.map((o, i) => ({ ...o, z: zs[i]! })));
      },
      back: () => {
        const list = writable().sort(byZ).reverse();
        let low = [...objectsRef.current.values()].filter((o) => !selectionRef.current.has(o.id)).reduce<string | null>((m, o) => (m === null || o.z < m ? o.z : m), null);
        store.checkpoint();
        put(
          list.map((o) => {
            low = positionBetween(null, low);
            return { ...o, z: low };
          }),
        );
      },
      align: (mode: AlignMode) => {
        const list = writable().filter(resizable);
        const rects = new Map(list.map((o) => [o.id, objectBounds(o, get)]));
        const pos = alignRects(rects, mode);
        store.checkpoint();
        put(list.map((o) => translateObject(o, pos.get(o.id)!.x - rects.get(o.id)!.x, pos.get(o.id)!.y - rects.get(o.id)!.y)));
      },
      distribute: (axis: 'x' | 'y') => {
        const list = writable().filter(resizable);
        const rects = new Map(list.map((o) => [o.id, objectBounds(o, get)]));
        const pos = distributeRects(rects, axis);
        store.checkpoint();
        put(list.filter((o) => pos.has(o.id)).map((o) => translateObject(o, pos.get(o.id)!.x - rects.get(o.id)!.x, pos.get(o.id)!.y - rects.get(o.id)!.y)));
      },
      copyOutline: () => {
        const o = sel()[0];
        if (o?.type !== 'mindmap') return;
        const node = mindNode?.map === o.id ? findNode(o.root, mindNode.node)?.node : null;
        void copyToClipboard(toOutline(node ?? o.root)).then((ok) => (ok ? toast.success('Liste copiée.') : toast.error('Copie impossible.')));
      },
      edit: () => {
        const o = sel()[0];
        if (o && editableText(o) && !o.locked && !readOnly) setEditing({ id: o.id });
        else if (o?.type === 'mindmap' && mindNode?.map === o.id && !readOnly) setEditing({ id: o.id, node: mindNode.node });
      },
    };
  }, [store, put, removeIds, insert, cloneObjects, get, mindNode, readOnly]);

  const linkPage = useCallback(() => {
    openPagePicker({
      title: 'Lier une page au canevas',
      exclude: new Set([pageId]),
      onPick: (target) => {
        if (target.kind !== 'page') return;
        insertAtCenter({ id: cid(), type: 'page', x: 0, y: 0, w: 280, h: 64, z: zAbove(objectsRef.current.values())[0]!, pageId: target.id });
        setTool('select');
      },
    });
  }, [pageId, insertAtCenter, setTool]);

  const addImage = useCallback(async () => {
    const file = await pickFile('image/*');
    if (file) await uploadFiles([file]);
    setTool('select');
  }, [uploadFiles, setTool]);

  const addFile = useCallback(async () => {
    const file = await pickFile('*/*');
    if (file) await uploadFiles([file]);
    setTool('select');
  }, [uploadFiles, setTool]);

  // --- keyboard -----------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || presenting) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = isMod(e);
    const key = e.key;
    // Undo / redo.
    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault();
      if (readOnly) return;
      if (e.shiftKey) store.undo.redo();
      else store.undo.undo();
      return;
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault();
      if (!readOnly) store.undo.redo();
      return;
    }
    // Zoom.
    if (mod && (key === '=' || key === '+')) return void (e.preventDefault(), zoomAt(1.2));
    if (mod && key === '-') return void (e.preventDefault(), zoomAt(1 / 1.2));
    if (mod && key === '0') return void (e.preventDefault(), zoomAt(1 / cameraRef.current.zoom));
    if (e.shiftKey && (key === '!' || e.code === 'Digit1')) return void (e.preventDefault(), fitRect(allBounds()));
    if (e.shiftKey && (key === '@' || key === '"' || e.code === 'Digit2')) return void (e.preventDefault(), fitRect(selectionBounds ?? allBounds(), 2));
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault();
      select([...objects.values()].filter((o) => !o.locked).map((o) => o.id));
      return;
    }
    if (mod && key.toLowerCase() === 'd') {
      e.preventDefault();
      if (!readOnly) actions.duplicate();
      return;
    }
    if (mod && key.toLowerCase() === 'g') {
      e.preventDefault();
      if (!readOnly) (e.shiftKey ? actions.ungroup : actions.group)();
      return;
    }
    if (mod && e.shiftKey && key.toLowerCase() === 'l') {
      e.preventDefault();
      if (!readOnly) actions.lock(!selected.every((o) => o.locked));
      return;
    }
    if (mod && key === ']') return void (e.preventDefault(), readOnly || actions.front());
    if (mod && key === '[') return void (e.preventDefault(), readOnly || actions.back());
    if (mod) return;

    // Mind map node commands.
    if (mindNode && !readOnly) {
      if (key === 'Tab') return void (e.preventDefault(), mindCommand('child'));
      if (key === 'Enter') return void (e.preventDefault(), mindCommand('sibling'));
      if (key === 'Delete' || key === 'Backspace') return void (e.preventDefault(), mindCommand('remove'));
      if (key === ' ') return void (e.preventDefault(), mindCommand('toggle'));
      if (key === 'F2') return void (e.preventDefault(), setEditing({ id: mindNode.map, node: mindNode.node }));
    }
    if (mindNode && key.startsWith('Arrow')) {
      const o = objects.get(mindNode.map);
      if (o?.type === 'mindmap') {
        e.preventDefault();
        const side = mindLayoutOf(o).byId.get(mindNode.node)?.side ?? 0;
        const next = neighbour(o.root, mindNode.node, key as 'ArrowUp', side);
        if (next) setMindNode({ map: o.id, node: next });
      }
      return;
    }
    if (mindNode && !readOnly && key.length === 1 && !e.altKey) {
      // Typing replaces the node's text.
      const o = objects.get(mindNode.map);
      if (o?.type === 'mindmap' && !o.locked) {
        e.preventDefault();
        put([{ ...o, root: clean(setText(o.root, mindNode.node, key)) }]);
        setEditing({ id: o.id, node: mindNode.node });
      }
      return;
    }

    if (key === 'Escape') {
      if (tool !== 'select') setTool('select');
      else {
        setSelection(new Set());
        setMindNode(null);
      }
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && selection.size > 0 && !readOnly) {
      e.preventDefault();
      actions.remove();
      return;
    }
    if ((key === 'Enter' || key === 'F2') && selection.size === 1 && !readOnly) {
      e.preventDefault();
      const o = selected[0];
      if (o?.type === 'mindmap') setMindNode({ map: o.id, node: o.root.id });
      else actions.edit();
      return;
    }
    if (key.startsWith('Arrow') && selection.size > 0 && !readOnly) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      put(selected.filter((o) => !o.locked).map((o) => translateObject(o, dx, dy)));
      return;
    }
    if (key === ' ' && !spacePan) {
      e.preventDefault();
      setSpacePan(true);
      return;
    }
    const tools: Record<string, Tool> = { v: 'select', h: 'hand', r: 'shape', o: 'shape', t: 'text', n: 'note', c: 'connector', p: 'pen', m: 'highlighter', e: 'eraser', f: 'frame', k: 'mindmap' };
    const t = tools[key.toLowerCase()];
    if (t && !e.altKey) {
      if (key.toLowerCase() === 'o') setStyle((s) => ({ ...s, shape: 'ellipse' }));
      if (key.toLowerCase() === 'r') setStyle((s) => ({ ...s, shape: 'rounded' }));
      setTool(t);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') setSpacePan(false);
  };

  // --- drop ---------------------------------------------------------------------------------------

  const onDrop = (e: React.DragEvent) => {
    if (readOnly) return;
    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;
    e.preventDefault();
    void uploadFiles(files, toWorld(e.clientX, e.clientY));
  };

  // --- render --------------------------------------------------------------------------------------

  const z = camera.zoom;
  // Frame labels keep a constant screen size: frames re-render on zoom steps, not on every pan.
  const frameZoom = Math.round(z * 100) / 100;
  const cursor =
    spacePan || tool === 'hand'
      ? gesture.current?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : tool === 'select'
        ? 'default'
        : tool === 'text'
          ? 'text'
          : 'crosshair';
  const erased = preview?.kind === 'erase' ? preview.ids : null;
  const singleConnector = selected.length === 1 && selected[0]!.type === 'connector' ? (display.get(selected[0]!.id) as Extract<CanvasObject, { type: 'connector' }>) : null;
  const canResize = !readOnly && selected.length > 0 && selected.some((o) => resizable(o) && !o.locked) && !singleConnector;

  return (
    <div
      ref={rootRef}
      className={`or-cv-root${readOnly ? ' is-readonly' : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={onDrop}
      style={{ cursor } as CSSProperties}
      aria-label="Canevas"
      role="application"
    >
      <svg
        ref={svgRef}
        className="or-cv-svg"
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id={`or-cv-grid-${pageId}`} width={24} height={24} patternUnits="userSpaceOnUse" patternTransform={`translate(${camera.x} ${camera.y}) scale(${z})`}>
            <circle cx={1} cy={1} r={1 / Math.max(z, 0.6)} className="or-cv-grid-dot" />
          </pattern>
        </defs>
        {z > 0.25 && <rect width={size.w} height={size.h} fill={`url(#or-cv-grid-${pageId})`} />}
        <g transform={`translate(${camera.x} ${camera.y}) scale(${z})`}>
          <ObjectsLayer visible={visible} routes={routes} env={env} editing={editing} frameZoom={frameZoom} mindNode={mindNode} erased={erased} />
          <Overlay
            preview={preview}
            zoom={z}
            selected={selected.map((o) => display.get(o.id)!).filter(Boolean)}
            selectionBounds={selectionBounds}
            boundsOf={boundsOf}
            canResize={canResize}
            connector={singleConnector ? routes.get(singleConnector.id) ?? null : null}
            style={style}
            get={displayGet}
          />
          {peers.map((p) => (
            <g key={p.id} transform={`translate(${p.x} ${p.y}) scale(${1 / z})`} className="or-cv-peer" pointerEvents="none">
              <path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z" fill={p.color} stroke="#fff" strokeWidth={1.2} />
              <rect x={12} y={18} rx={4} width={Math.min(160, p.name.length * 7 + 12)} height={20} fill={p.color} />
              <text x={18} y={32} fontSize={12} fill="#fff">
                {p.name}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {editing && (
        <TextEditor
          key={`${editing.id}:${editing.node ?? ''}`}
          editing={editing}
          object={objects.get(editing.id)}
          camera={camera}
          finishRef={finishEditing}
          onCommit={(value, opts) => {
            const o = objectsRef.current.get(editing.id);
            setEditing(null);
            rootRef.current?.focus({ preventScroll: true });
            if (!o || readOnly) return;
            store.checkpoint();
            if (o.type === 'mindmap' && editing.node) {
              const next = { ...o, root: clean(setText(o.root, editing.node, value)) };
              put([next]);
              setMindNode({ map: o.id, node: editing.node });
              if (opts?.then === 'child' || opts?.then === 'sibling') {
                const res = opts.then === 'child' ? addChild(next.root, editing.node) : addSibling(next.root, editing.node);
                if (res) {
                  put([{ ...next, root: clean(res.root) }]);
                  setMindNode({ map: o.id, node: res.id });
                  setEditing({ id: o.id, node: res.id });
                }
              }
              return;
            }
            if (o.type === 'text' && !value.trim()) return removeIds([o.id]);
            if (o.type === 'connector') return put([{ ...o, label: value.slice(0, CANVAS_LIMITS.label) }]);
            if (o.type === 'frame') return put([{ ...o, name: value.slice(0, CANVAS_LIMITS.label) }]);
            if (o.type === 'text') return put([{ ...o, text: value.slice(0, CANVAS_LIMITS.text), h: Math.max(o.h, opts?.height ?? o.h) }]);
            if (o.type === 'shape' || o.type === 'note') put([{ ...o, text: value.slice(0, CANVAS_LIMITS.text) }]);
          }}
        />
      )}
      <CanvasChrome
        store={store}
        objects={objects}
        selected={selected}
        mindNode={mindNode}
        tool={tool}
        setTool={setTool}
        style={style}
        setStyle={setStyle}
        readOnly={readOnly}
        publicMode={publicMode}
        camera={camera}
        canUndo={undoState.canUndo}
        canRedo={undoState.canRedo}
        actions={actions}
        mindCommand={mindCommand}
        zoomBy={zoomAt}
        resetZoom={() => zoomAt(1 / cameraRef.current.zoom)}
        fitAll={() => fitRect(allBounds())}
        fitRect={fitRect}
        insertTemplate={(list) => {
          insert(list, false);
          setTimeout(() => fitRect(unionRects(list.map((o) => objectBounds(o, (id) => list.find((x) => x.id === id))))), 30);
        }}
        linkPage={linkPage}
        addImage={() => void addImage()}
        addFile={() => void addFile()}
        canUpload={!!workspaceId && !readOnly}
        presenting={presenting}
        setPresenting={setPresenting}
        pageId={pageId}
        select={select}
        boundsOf={(o) => objectBounds(o, get)}
      />
    </div>
  );
}

// --- overlay (selection, handles, previews) --------------------------------------------------------

function Overlay({
  preview,
  zoom,
  selected,
  selectionBounds,
  boundsOf,
  canResize,
  connector,
  style,
  get,
}: {
  preview: Preview | null;
  zoom: number;
  selected: CanvasObject[];
  selectionBounds: Rect | null;
  boundsOf: (o: CanvasObject) => Rect;
  canResize: boolean;
  connector: Route | null;
  style: Style;
  get: (id: string) => CanvasObject | undefined;
}) {
  const px = 1 / zoom;
  const hs = 8 * px;
  return (
    <g className="or-cv-overlay">
      {selected.length > 1 &&
        selected.map((o) => {
          const b = boundsOf(o);
          return <rect key={o.id} x={b.x} y={b.y} width={b.w} height={b.h} className="or-cv-sel-item" strokeWidth={px} />;
        })}
      {selectionBounds && !connector && (
        <rect
          x={selectionBounds.x - 2 * px}
          y={selectionBounds.y - 2 * px}
          width={selectionBounds.w + 4 * px}
          height={selectionBounds.h + 4 * px}
          className={`or-cv-sel${selected.some((o) => o.locked) ? ' is-locked' : ''}`}
          strokeWidth={1.5 * px}
        />
      )}
      {canResize &&
        selectionBounds &&
        HANDLES.map((h) => {
          const p = handlePoint(selectionBounds, h);
          return <rect key={h} data-cv-handle={h} x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs} rx={2 * px} className={`or-cv-handle or-cv-handle--${h}`} strokeWidth={1.5 * px} />;
        })}
      {connector && (
        <>
          <path d={connector.d} className="or-cv-sel-route" strokeWidth={2 * px} fill="none" />
          <circle data-cv-end="from" cx={connector.start.x} cy={connector.start.y} r={6 * px} className="or-cv-end" strokeWidth={1.5 * px} />
          <circle data-cv-end="to" cx={connector.end.x} cy={connector.end.y} r={6 * px} className="or-cv-end" strokeWidth={1.5 * px} />
        </>
      )}
      {preview?.kind === 'move' &&
        preview.guides.x.map((x) => <line key={`gx${x}`} x1={x} x2={x} y1={-1e6} y2={1e6} className="or-cv-guide" strokeWidth={px} />)}
      {preview?.kind === 'move' &&
        preview.guides.y.map((y) => <line key={`gy${y}`} y1={y} y2={y} x1={-1e6} x2={1e6} className="or-cv-guide" strokeWidth={px} />)}
      {preview?.kind === 'marquee' && <rect x={preview.rect.x} y={preview.rect.y} width={preview.rect.w} height={preview.rect.h} className="or-cv-marquee" strokeWidth={px} />}
      {preview?.kind === 'create' && <rect x={preview.rect.x} y={preview.rect.y} width={preview.rect.w} height={preview.rect.h} className="or-cv-create" strokeWidth={1.5 * px} />}
      {preview?.kind === 'draw' && preview.points.length > 0 && (
        <path
          d={freehandPath(
            preview.points.flatMap((p) => [p.x, p.y]),
            style.penSize,
            'pen',
            false,
          )}
          className="or-cv-draw-preview"
        />
      )}
      {preview?.kind === 'connector' && (
        <path d={connectorRoute({ from: preview.from, to: preview.to, route: style.route }, get).d} className="or-cv-sel-route" strokeWidth={2 * px} fill="none" />
      )}
      {(preview?.kind === 'connector' || preview?.kind === 'end') &&
        [preview.kind === 'connector' ? preview.to : preview.end].map((end, i) => {
          if (!('id' in end)) return null;
          const t = get(end.id);
          if (!t) return null;
          const b = boundsOf(t);
          return <rect key={i} x={b.x - 4 * px} y={b.y - 4 * px} width={b.w + 8 * px} height={b.h + 8 * px} className="or-cv-attach" strokeWidth={2 * px} rx={4 * px} />;
        })}
    </g>
  );
}

// --- text editor overlay -------------------------------------------------------------------------

function TextEditor({
  editing,
  object,
  camera,
  onCommit,
  finishRef,
}: {
  editing: Editing;
  object: CanvasObject | undefined;
  camera: Camera;
  onCommit: (value: string, opts?: { then?: 'child' | 'sibling'; height?: number }) => void;
  finishRef: { current: () => void };
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const initial = useMemo(() => {
    if (!object) return '';
    if (object.type === 'mindmap' && editing.node) return findNode(object.root, editing.node)?.node.text ?? '';
    if (object.type === 'connector') return object.label;
    if (object.type === 'frame') return object.name;
    if (object.type === 'shape' || object.type === 'text' || object.type === 'note') return object.text;
    return '';
  }, [object, editing.node]);
  const [value, setValue] = useState(initial);
  const valueRef = useRef(value);
  valueRef.current = value;

  const commit = useCallback(
    (then?: 'child' | 'sibling') => {
      if (done.current) return;
      done.current = true;
      const h = ref.current ? ref.current.scrollHeight / camera.zoom : undefined;
      onCommit(valueRef.current, { then, height: h });
    },
    [onCommit, camera.zoom],
  );
  useEffect(() => {
    finishRef.current = () => commit();
    return () => {
      finishRef.current = () => undefined;
    };
  }, [commit, finishRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  if (!object) return null;
  const z = camera.zoom;
  let box: Rect;
  let className = 'or-cv-editor';
  let fontSize = 16;
  if (object.type === 'mindmap' && editing.node) {
    const b = mindLayoutOf(object).byId.get(editing.node);
    if (!b) return null;
    box = { x: object.x + b.x, y: object.y + b.y, w: Math.max(b.w, 140), h: b.h };
    fontSize = MIND_FONT(b.depth);
    className += ' is-center is-mind';
  } else if (object.type === 'connector') {
    const r = connectorRoute(object, () => undefined);
    box = { x: r.mid.x - 100, y: r.mid.y - 16, w: 200, h: 32 };
    fontSize = 14;
    className += ' is-center is-label';
  } else if (object.type === 'frame') {
    box = { x: object.x, y: object.y - 30 / z, w: Math.max(200 / z, Math.min(object.w, 400 / z)), h: 26 / z };
    fontSize = 13 / z;
    className += ' is-label';
  } else {
    box = { x: object.x, y: object.y, w: object.w, h: object.h };
    if (object.type === 'shape') {
      fontSize = { s: 14, m: 18, l: 26, xl: 40 }[object.fontSize];
      className += ' is-center';
    } else if (object.type === 'text') {
      fontSize = { s: 14, m: 18, l: 26, xl: 40 }[object.fontSize];
      className += ` is-text is-${object.align}${object.bold ? ' is-bold' : ''}`;
    } else {
      fontSize = 14;
      className += ' is-note';
    }
  }
  const stylePos: CSSProperties = {
    left: box.x * z + camera.x,
    top: box.y * z + camera.y,
    width: box.w * z,
    minHeight: box.h * z,
    fontSize: fontSize * z,
  };
  const singleLine = object.type === 'mindmap' || object.type === 'connector' || object.type === 'frame';
  return (
    <textarea
      ref={ref}
      className={className}
      style={stylePos}
      value={value}
      maxLength={object.type === 'mindmap' ? CANVAS_LIMITS.mindmapText : singleLine ? CANVAS_LIMITS.label : CANVAS_LIMITS.text}
      aria-label={object.type === 'frame' ? 'Nom du cadre' : 'Texte'}
      onChange={(e) => {
        setValue(e.target.value);
        if (object.type === 'text' && ref.current) {
          ref.current.style.height = 'auto';
          ref.current.style.height = `${ref.current.scrollHeight}px`;
        }
      }}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Tab' && object.type === 'mindmap') {
          e.preventDefault();
          commit('child');
        } else if (e.key === 'Enter' && !e.shiftKey && (singleLine || isMod(e))) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

