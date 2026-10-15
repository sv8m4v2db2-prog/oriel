// Ingest guard of canvas documents (H1). A canvas page's Yjs document has one root, the Y.Map
// `canvas`, whose values are plain JSON objects (ContentAny). Every update sent by an editor is
// decoded BEFORE Yjs applies it (like realtime/updateGuard.ts for pages) and refused when:
//  - it names another root type, or nests a Yjs type anywhere (ContentType, Doc, binary, text…);
//  - a value is not one valid canvas object (`sanitizeCanvasObject`), its key is not its id, or it
//    is larger than CANVAS_LIMITS.objectBytes;
//  - the canvas would hold more than CANVAS_LIMITS.objects objects or totalBytes of JSON.
// The parent of an item is resolved the way Yjs integrates it: explicit parent, else the item it
// replaces (left origin, same key), in the document or in the update. Items Yjs would leave pending
// (missing dependencies) are not checked: they are dropped after each transaction
// (`dropPendingStructs`, called by the collab service), so they can never be integrated unchecked.
import * as Y from 'yjs';
import { CANVAS_ID_RE, CANVAS_LIMITS, CANVAS_ROOT, sanitizeCanvasObject } from '@oriel/shared';

type Struct = Y.Item | Y.GC | Y.Skip;
type Place = { status: 'ok'; key: string } | { status: 'skip' } | { status: 'bad'; reason: string };

/** JSON size of each object of a loaded canvas, kept current by an observer (one per document). */
interface Budget {
  sizes: Map<string, number>;
  total: number;
}
const budgets = new WeakMap<Y.Doc, Budget>();

const sizeOf = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export function canvasMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(CANVAS_ROOT);
}

function budgetOf(doc: Y.Doc): Budget {
  let budget = budgets.get(doc);
  if (budget) return budget;
  const map = canvasMap(doc);
  const b: Budget = { sizes: new Map(), total: 0 };
  for (const [key, value] of map.entries()) {
    const size = sizeOf(value);
    b.sizes.set(key, size);
    b.total += size;
  }
  map.observe((event) => {
    for (const key of event.keysChanged) {
      b.total -= b.sizes.get(key) ?? 0;
      b.sizes.delete(key);
      if (map.has(key)) {
        const size = sizeOf(map.get(key));
        b.sizes.set(key, size);
        b.total += size;
      }
    }
  });
  budgets.set(doc, b);
  return b;
}

/** Prepares a freshly loaded canvas document (root type declared, budget observer installed). */
export function prepareCanvasDocument(doc: Y.Doc): void {
  budgetOf(doc);
}

/** Why an update sent by an editor of a canvas is refused (French, for the logs), or null. */
export function checkCanvasUpdate(doc: Y.Doc, update: Uint8Array): string | null {
  let structs: Struct[];
  try {
    structs = Y.decodeUpdate(update).structs;
  } catch {
    return 'mise à jour illisible';
  }
  const store = doc.store;
  const byClient = new Map<number, Struct[]>();
  let previous: Struct | null = null;
  for (const s of structs) {
    const run = byClient.get(s.id.client);
    if (previous && previous.id.client === s.id.client) {
      if (s.id.clock !== previous.id.clock + previous.length) return 'mise à jour mal formée';
      run!.push(s);
    } else {
      if (run) return 'mise à jour mal formée';
      byClient.set(s.id.client, [s]);
    }
    previous = s;
    if (s instanceof Y.Item && typeof (s.parent as unknown) === 'string' && (s.parent as unknown) !== CANVAS_ROOT) {
      return `type racine « ${String(s.parent)} » refusé`;
    }
  }

  const lookup = (id: Y.ID): Struct | null => {
    if (id.clock < Y.getState(store, id.client)) {
      const list = store.clients.get(id.client)!;
      return list[Y.findIndexSS(list, id.clock)] ?? null;
    }
    const run = byClient.get(id.client);
    if (!run) return null;
    let lo = 0;
    let hi = run.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = run[mid]!;
      if (id.clock < s.id.clock) hi = mid - 1;
      else if (id.clock >= s.id.clock + s.length) lo = mid + 1;
      else return s instanceof Y.Skip ? null : s;
    }
    return null;
  };

  const root = doc.share.get(CANVAS_ROOT);
  const fresh = new Set<Struct>(structs);
  const places = new Map<Y.Item, Place>();
  /** Key of the root map an item is a value of (iterative: chains of replaced values can be long). */
  const place = (item: Y.Item): Place => {
    const chain: Y.Item[] = [];
    const seen = new Set<Y.Item>();
    let current = item;
    let result: Place;
    for (;;) {
      const known = places.get(current);
      if (known) {
        result = known;
        break;
      }
      if (seen.has(current)) {
        result = { status: 'skip' }; // origin cycle: never integrated
        break;
      }
      seen.add(current);
      chain.push(current);
      const parent = current.parent as unknown;
      if (typeof parent === 'string') {
        result = current.parentSub === null ? { status: 'bad', reason: 'liste à la racine refusée' } : { status: 'ok', key: current.parentSub };
        break;
      }
      if (parent instanceof Y.ID) {
        result = { status: 'bad', reason: 'type imbriqué refusé' };
        break;
      }
      if (parent instanceof Y.AbstractType) {
        // Integrated item: only values of the root map are allowed.
        result =
          parent === root && current.parentSub !== null ? { status: 'ok', key: current.parentSub } : { status: 'bad', reason: 'contenu hors du canevas' };
        break;
      }
      if (current.rightOrigin) {
        result = { status: 'bad', reason: 'liste refusée' }; // map values have no right origin
        break;
      }
      if (!current.origin) {
        result = { status: 'skip' };
        break;
      }
      const left = lookup(current.origin);
      if (!left) {
        result = { status: 'skip' }; // missing dependency: left pending, dropped later
        break;
      }
      if (!(left instanceof Y.Item)) {
        result = { status: 'skip' }; // garbage-collected neighbour: Yjs drops the item
        break;
      }
      if (!fresh.has(left)) {
        const p = left.parent as unknown;
        result =
          p === root && left.parentSub !== null ? { status: 'ok', key: left.parentSub } : p === null ? { status: 'skip' } : { status: 'bad', reason: 'contenu hors du canevas' };
        break;
      }
      current = left;
    }
    for (const c of chain) places.set(c, result);
    return result;
  };

  const map = root instanceof Y.Map ? (root as Y.Map<unknown>) : null;
  const budget = map ? budgetOf(doc) : { sizes: new Map<string, number>(), total: 0 };
  const writes = new Map<string, number>();
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    if (s.id.clock + s.length <= Y.getState(store, s.id.client)) continue; // already integrated
    const content = s.content;
    const p = place(s);
    if (p.status === 'bad') return p.reason;
    if (p.status === 'skip') continue;
    if (content instanceof Y.ContentDeleted) continue;
    if (!(content instanceof Y.ContentAny) || content.arr.length !== 1) return 'valeur invalide';
    if (!CANVAS_ID_RE.test(p.key)) return 'identifiant d’objet invalide';
    const value = content.arr[0];
    const size = sizeOf(value);
    if (size > CANVAS_LIMITS.objectBytes) return 'objet trop volumineux';
    const object = sanitizeCanvasObject(value);
    if (!object || object.id !== p.key) return 'objet invalide';
    writes.set(p.key, size);
  }
  if (writes.size === 0) return null;
  let count = map ? map.size : 0;
  let total = budget.total;
  for (const [key, size] of writes) {
    if (!budget.sizes.has(key)) count += 1;
    total += size - (budget.sizes.get(key) ?? 0);
  }
  if (count > CANVAS_LIMITS.objects) return 'trop d’objets dans le canevas';
  if (total > CANVAS_LIMITS.totalBytes) return 'canevas trop volumineux';
  return null;
}
