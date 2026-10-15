// Canvas store (H1): wraps the root Y.Map of a canvas document. Keeps an immutable snapshot of the
// valid objects (only changed keys are re-read on each Yjs event), writes local changes in one
// transaction with the LOCAL origin, and undoes/redoes them with Yjs' UndoManager (local changes
// only: a collaborator's edits are never undone by someone else's ⌘Z).
import { useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { CANVAS_ROOT, sanitizeCanvasObject, type CanvasObject } from '@oriel/shared';
import { same } from './model';

export const LOCAL_ORIGIN = 'oriel-canvas-local';

export class CanvasStore {
  readonly map: Y.Map<unknown>;
  readonly undo: Y.UndoManager;
  private snapshot: ReadonlyMap<string, CanvasObject>;
  private readonly listeners = new Set<() => void>();
  private readonly observer: (e: Y.YMapEvent<unknown>) => void;
  private undoState = { canUndo: false, canRedo: false };
  private readonly undoListeners = new Set<() => void>();

  constructor(readonly doc: Y.Doc) {
    this.map = doc.getMap(CANVAS_ROOT);
    const initial = new Map<string, CanvasObject>();
    for (const [key, value] of this.map.entries()) {
      const o = sanitizeCanvasObject(value);
      if (o && o.id === key) initial.set(key, o);
    }
    this.snapshot = initial;
    this.observer = (e) => {
      const next = new Map(this.snapshot);
      for (const key of e.keysChanged) {
        const o = sanitizeCanvasObject(this.map.get(key));
        if (o && o.id === key) next.set(key, o);
        else next.delete(key);
      }
      this.snapshot = next;
      for (const l of this.listeners) l();
    };
    this.map.observe(this.observer);
    this.undo = new Y.UndoManager(this.map, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    const refresh = () => {
      const next = { canUndo: this.undo.canUndo(), canRedo: this.undo.canRedo() };
      if (next.canUndo !== this.undoState.canUndo || next.canRedo !== this.undoState.canRedo) {
        this.undoState = next;
        for (const l of this.undoListeners) l();
      }
    };
    this.undo.on('stack-item-added', refresh);
    this.undo.on('stack-item-popped', refresh);
    this.undo.on('stack-cleared', refresh);
  }

  readonly subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  readonly getSnapshot = () => this.snapshot;
  readonly subscribeUndo = (l: () => void) => {
    this.undoListeners.add(l);
    return () => void this.undoListeners.delete(l);
  };
  readonly getUndoState = () => this.undoState;

  get(id: string): CanvasObject | undefined {
    return this.snapshot.get(id);
  }

  /** One local, undoable transaction. */
  transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /** Writes objects that changed (invalid ones are skipped: the server would refuse the update). */
  put(objects: CanvasObject | CanvasObject[]): void {
    const list = Array.isArray(objects) ? objects : [objects];
    const valid = list.filter((o) => sanitizeCanvasObject(o) !== null && !same(this.map.get(o.id), o));
    if (valid.length === 0) return;
    this.transact(() => {
      for (const o of valid) this.map.set(o.id, o);
    });
  }

  remove(ids: Iterable<string>): void {
    const list = [...ids].filter((id) => this.map.has(id));
    if (list.length === 0) return;
    this.transact(() => {
      for (const id of list) this.map.delete(id);
    });
  }

  /** Separates the next change from the previous one in the undo history. */
  checkpoint(): void {
    this.undo.stopCapturing();
  }

  destroy(): void {
    this.map.unobserve(this.observer);
    this.undo.destroy();
    this.listeners.clear();
    this.undoListeners.clear();
  }
}

export function useCanvasObjects(store: CanvasStore): ReadonlyMap<string, CanvasObject> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useUndoState(store: CanvasStore) {
  return useSyncExternalStore(store.subscribeUndo, store.getUndoState);
}
