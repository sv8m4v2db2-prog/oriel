// Ingest guard of /collab: the Yjs updates sent by editors are checked BEFORE Yjs applies them,
// with the rules of the page content API (`assertXmlTree`, io/content.ts): the `blocknote`
// fragment holds only XML elements and texts, element attributes are plain values, texts hold only
// characters and formatting, elements nest at most MAX_CONTENT_DEPTH deep and have at most
// MAX_CONTENT_CHILDREN children. A Y.Map or Y.Text in the fragment breaks the editor of every
// reader, and absurd nesting overflows the recursive code of Yjs (clone, garbage collection).
//
// The update is decoded, not applied: the parent of each new item is resolved the way Yjs
// integrates it (explicit parent, else the parent of its left or right origin), against the
// integrated items of the document first and the items of the update second. Items Yjs would not
// integrate now (missing dependencies: left pending) or would garbage-collect are not checked;
// pending structs are dropped after every transaction (`dropPendingStructs`), so they can never be
// integrated later by another update without having been checked.
import * as Y from 'yjs';
import { COLLAB_FRAGMENT } from '@oriel/shared';
import { MAX_CONTENT_CHILDREN, MAX_CONTENT_DEPTH } from '../content/ydoc.js';

type Struct = Y.Item | Y.GC | Y.Skip;
/** A parent: key of a root type, integrated type of the document, or type item created by the update. */
type Owner = string | Y.AbstractType<unknown> | Y.Item;
type Place = { status: 'gc' } | { status: 'missing' } | { status: 'ok'; parent: Owner; parentSub: string | null };
interface Info {
  kind: 'fragment' | 'element' | 'text' | 'invalid' | 'gc' | 'missing';
  depth: number;
}

const GC_PLACE: Place = { status: 'gc' };
const MISSING_PLACE: Place = { status: 'missing' };
const GC_INFO: Info = { kind: 'gc', depth: 0 };
const MISSING_INFO: Info = { kind: 'missing', depth: 0 };
const INVALID: Info = { kind: 'invalid', depth: 0 };

const kindOfType = (type: unknown): Info['kind'] => (type instanceof Y.XmlText ? 'text' : type instanceof Y.XmlElement ? 'element' : 'invalid');

/** Drops the structs (and deletions) Yjs keeps aside for missing dependencies: they were never checked. */
export function dropPendingStructs(doc: Y.Doc): void {
  if (doc.store.pendingStructs) doc.store.pendingStructs = null;
  if (doc.store.pendingDs) doc.store.pendingDs = null;
}

/** Why an update sent by an editor is refused (French, for the logs), or null when it can be applied. */
export function checkCollabUpdate(doc: Y.Doc, update: Uint8Array): string | null {
  let structs: Struct[];
  try {
    structs = Y.decodeUpdate(update).structs;
  } catch {
    return 'mise à jour illisible';
  }
  const store = doc.store;
  const fresh = new Set<Struct>(structs);

  // Structs of the update by client: one contiguous run per client, as Yjs encodes them (Yjs keeps
  // only the last section of a client, so a repeated one would be checked against dropped structs).
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
    // Decoding creates the root types it names: only the editor's fragment may exist.
    if (s instanceof Y.Item && typeof (s.parent as unknown) === 'string' && (s.parent as unknown) !== COLLAB_FRAGMENT) {
      return `type racine « ${String(s.parent)} » refusé`;
    }
  }

  /** The struct holding `id`: integrated one if any (Yjs never re-integrates a clock), else the update's. */
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

  /** Place of an item without following left/right neighbours of the update (returned instead). */
  const directPlace = (item: Y.Item): Place | Y.Item => {
    const parent = item.parent as unknown;
    if (typeof parent === 'string') return { status: 'ok', parent, parentSub: item.parentSub };
    if (parent instanceof Y.ID) {
      const target = lookup(parent);
      if (!target) return MISSING_PLACE;
      if (!(target instanceof Y.Item) || !(target.content instanceof Y.ContentType)) return GC_PLACE;
      return { status: 'ok', parent: fresh.has(target) ? target : target.content.type, parentSub: item.parentSub };
    }
    const left = item.origin ? lookup(item.origin) : null;
    const right = item.rightOrigin ? lookup(item.rightOrigin) : null;
    if ((item.origin && !left) || (item.rightOrigin && !right)) return MISSING_PLACE;
    if (left instanceof Y.GC || right instanceof Y.GC) return GC_PLACE;
    const neighbour = (left ?? right) as Y.Item | null;
    if (!neighbour) return GC_PLACE;
    if (fresh.has(neighbour)) return neighbour;
    return neighbour.parent instanceof Y.AbstractType ? { status: 'ok', parent: neighbour.parent, parentSub: neighbour.parentSub } : GC_PLACE;
  };

  const places = new Map<Y.Item, Place>();
  /** Where Yjs integrates an item (iterative: chains of neighbours can be as long as the update). */
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
        result = MISSING_PLACE; // origin cycle: Yjs cannot integrate it either
        break;
      }
      seen.add(current);
      chain.push(current);
      const step = directPlace(current);
      if (step instanceof Y.Item) current = step;
      else {
        result = step;
        break;
      }
    }
    for (const c of chain) places.set(c, result);
    return result;
  };

  const rootInfo = (key: string | null): Info => (key === COLLAB_FRAGMENT ? { kind: 'fragment', depth: 0 } : INVALID);
  const rootKeyOf = (type: Y.AbstractType<unknown>): string | null => {
    for (const [key, value] of doc.share) if (value === type) return key;
    return null;
  };
  /** One level up: the owner holding `owner`, or the final information when there is none. */
  const up = (owner: Owner): { info: Info } | { parent: Owner } => {
    if (typeof owner === 'string') return { info: rootInfo(owner) };
    if (owner instanceof Y.Item) {
      const p = place(owner);
      if (p.status === 'gc') return { info: GC_INFO };
      if (p.status === 'missing') return { info: MISSING_INFO };
      if (p.parentSub !== null) return { info: INVALID }; // a type stored as an attribute value
      return { parent: p.parent };
    }
    const item = owner._item;
    if (!item) return { info: rootInfo(rootKeyOf(owner)) };
    if (item.parentSub !== null || !(item.parent instanceof Y.AbstractType)) return { info: INVALID };
    return { parent: item.parent };
  };
  const infos = new Map<Owner, Info>();
  /** Kind and depth of an owner (iterative and memoized: nesting is attacker-controlled). */
  const info = (owner: Owner): Info => {
    const path: Owner[] = [];
    const seen = new Set<Owner>();
    let current = owner;
    let acc: Info;
    for (;;) {
      const known = infos.get(current);
      if (known) {
        acc = known;
        break;
      }
      if (seen.has(current)) {
        acc = MISSING_INFO; // parent cycle between items of the update: never integrated
        break;
      }
      seen.add(current);
      const step = up(current);
      if ('info' in step) {
        acc = step.info;
        infos.set(current, acc);
        break;
      }
      path.push(current);
      current = step.parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const child = path[i]!;
      if (acc.kind === 'fragment' || acc.kind === 'element') {
        const type = child instanceof Y.Item ? (child.content as Y.ContentType).type : child;
        acc = { kind: kindOfType(type), depth: acc.depth + 1 };
      } else if (acc.kind === 'text') {
        acc = INVALID;
      }
      infos.set(child, acc);
    }
    return acc;
  };
  const existingLength = (owner: Owner): number => {
    if (owner instanceof Y.Item) return 0;
    const type = typeof owner === 'string' ? doc.share.get(owner) : owner;
    return type?._length ?? 0;
  };

  const added = new Map<Owner, number>();
  for (const s of structs) {
    if (!(s instanceof Y.Item)) continue;
    if (s.id.clock + s.length <= Y.getState(store, s.id.client)) continue; // already integrated: skipped by Yjs
    const p = place(s);
    if (p.status !== 'ok') continue;
    const parent = info(p.parent);
    if (parent.kind === 'gc' || parent.kind === 'missing') continue;
    const content = s.content;
    if (content instanceof Y.ContentDeleted) continue;
    if (parent.kind === 'invalid') return 'contenu placé hors des blocs';
    if (p.parentSub !== null) {
      if (parent.kind === 'fragment' || !(content instanceof Y.ContentAny)) return 'attribut invalide';
      continue;
    }
    if (parent.kind === 'text') {
      if (!(content instanceof Y.ContentString || content instanceof Y.ContentFormat)) return 'texte invalide';
      continue;
    }
    const type = content instanceof Y.ContentType ? content.type : null;
    if (!(type instanceof Y.XmlElement || type instanceof Y.XmlText)) return 'le document ne doit contenir que des blocs et du texte';
    if (type instanceof Y.XmlElement && parent.depth + 1 > MAX_CONTENT_DEPTH) return 'imbrication des blocs trop profonde';
    const count = (added.get(p.parent) ?? existingLength(p.parent)) + 1;
    if (count > MAX_CONTENT_CHILDREN) return 'trop de blocs au même niveau';
    added.set(p.parent, count);
  }
  return null;
}
