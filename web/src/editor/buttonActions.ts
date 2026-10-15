// Button block actions (pure, unit-tested): validation of the stored JSON, copies of recorded blocks,
// conversion of the text values to property values, row filter. The `actions` prop comes from the
// shared document, where any editor can store anything: it is always read through parseButtonActions.
import {
  BUTTON_MAX_ACTIONS,
  BUTTON_MAX_INSERT_BLOCKS,
  type ButtonAction,
  type ButtonPropertyValues,
  type Page,
  type PropertyDef,
  type PropertyValue,
  type PublicUser,
} from '@oriel/shared';
import { csvCell, csvToValue, parseCsvBoolean } from '../database/logic/csv';
import { createRowContext, isComputedType } from '../database/logic/values';
import { normalizeText } from '../database/logic/text';
import { safeLinkUrl } from '../lib/safeUrl';

export type { ButtonAction };

/** Largest serialized `actions` prop accepted (characters). */
export const BUTTON_MAX_JSON = 100_000;
/** Most properties preset by one action, longest value, longest confirmation message. */
export const BUTTON_MAX_VALUES = 50;
export const BUTTON_MAX_VALUE_LENGTH = 2000;
export const BUTTON_MAX_MESSAGE = 500;
/** Deepest nesting of the recorded blocks. */
export const BUTTON_MAX_DEPTH = 8;
/** Most rows one « Modifier des lignes » action changes. */
export const BUTTON_MAX_EDITED_ROWS = 500;
/** Above this many rows, the user confirms the change first. */
export const BUTTON_CONFIRM_ROWS = 20;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const isEntityId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanValues(raw: unknown): ButtonPropertyValues {
  const out: ButtonPropertyValues = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= BUTTON_MAX_VALUES) break;
    if (!PROPERTY_ID.test(key) || typeof value !== 'string' || key === '__proto__') continue;
    out[key] = value.slice(0, BUTTON_MAX_VALUE_LENGTH);
    n++;
  }
  return out;
}

/**
 * Copies of recorded blocks without ids (fresh ids at each insertion), at most
 * BUTTON_MAX_INSERT_BLOCKS blocks in all (children included) and BUTTON_MAX_DEPTH levels.
 * `known` (block types of the schema) drops the unknown ones.
 */
export function sanitizeInsertBlocks(raw: unknown, known?: (type: string) => boolean, max = BUTTON_MAX_INSERT_BLOCKS): unknown[] {
  let budget = max;
  const walk = (list: unknown, depth: number): unknown[] => {
    if (!Array.isArray(list) || depth > BUTTON_MAX_DEPTH) return [];
    const out: unknown[] = [];
    for (const item of list) {
      if (budget <= 0) break;
      if (!isObject(item) || typeof item.type !== 'string' || !item.type || (known && !known(item.type))) continue;
      budget--;
      const block: Record<string, unknown> = { type: item.type };
      if (isObject(item.props)) block.props = { ...item.props };
      if (item.content !== undefined) block.content = stripIds(item.content);
      const children = walk(item.children, depth + 1);
      if (children.length) block.children = children;
      out.push(block);
    }
    return out;
  };
  return walk(raw, 0);
}

/** Inline content / table content without `id` keys (deep copy). */
function stripIds(value: unknown, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripIds(v, depth + 1));
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== 'id' && k !== '__proto__') out[k] = stripIds(v, depth + 1);
  return out;
}

/** One stored action, or null when it is not valid. */
export function sanitizeButtonAction(raw: unknown): ButtonAction | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'insert': {
      const blocks = sanitizeInsertBlocks(raw.blocks);
      return { type: 'insert', blocks };
    }
    case 'addRow':
      return isEntityId(raw.databaseId) ? { type: 'addRow', databaseId: raw.databaseId, values: cleanValues(raw.values) } : null;
    case 'editRows': {
      if (!isEntityId(raw.databaseId)) return null;
      const f = raw.filter;
      const filter = isObject(f) && typeof f.propertyId === 'string' && PROPERTY_ID.test(f.propertyId) ? { propertyId: f.propertyId, value: str(f.value, BUTTON_MAX_VALUE_LENGTH) } : null;
      return { type: 'editRows', databaseId: raw.databaseId, filter, values: cleanValues(raw.values) };
    }
    case 'open': {
      if (isEntityId(raw.pageId)) return { type: 'open', pageId: raw.pageId };
      const url = safeLinkUrl(raw.url);
      return url ? { type: 'open', url } : null;
    }
    case 'confirm':
      return { type: 'confirm', message: str(raw.message, BUTTON_MAX_MESSAGE).trim() || 'Continuer ?' };
    default:
      return null;
  }
}

/** Actions of the `actions` prop (JSON text, or an array): invalid ones dropped, bounded. */
export function parseButtonActions(raw: unknown): ButtonAction[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim() || raw.length > BUTTON_MAX_JSON) return [];
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ButtonAction[] = [];
  let budget = BUTTON_MAX_INSERT_BLOCKS;
  for (const item of list.slice(0, BUTTON_MAX_ACTIONS)) {
    const action = sanitizeButtonAction(item);
    if (!action) continue;
    if (action.type === 'insert') {
      // The block bound applies to the whole button, not to each action.
      const blocks = sanitizeInsertBlocks(action.blocks, undefined, budget);
      budget -= countBlocks(blocks);
      out.push({ ...action, blocks });
    } else out.push(action);
  }
  return out;
}

/**
 * QA-EDT-01 — why an « Ajouter une ligne » / « Modifier des lignes » action may not write to the
 * database it names (null: it may). The database id comes from the shared document: a forged button
 * of a page of this workspace would otherwise make whoever clicks it create or change rows of a
 * database of ANOTHER workspace (the requests carry the clicker's rights, so the server accepts them).
 * `host` (page of the button, when known) adds the QA-EDT-05 pre-check: a database read by fewer
 * people than the page (the clicker's private database named by a button of a shared page).
 */
export function buttonDatabaseProblem(
  page: Pick<Page, 'workspaceId' | 'kind' | 'trashedAt'> & Partial<Pick<Page, 'visibility' | 'ownerId'>>,
  workspaceId: string | null,
  host?: Pick<Page, 'visibility' | 'ownerId'> | null,
): string | null {
  if (!workspaceId || page.workspaceId !== workspaceId) return 'la base appartient à un autre espace de travail';
  if (page.kind !== 'database') return 'la cible n’est pas une base de données';
  if (page.trashedAt !== null) return 'la base est dans la corbeille';
  // QA-EDT-05 — pre-check only (message to the clicker): the server refuses these requests anyway
  // (`viaButtonOn`, assertButtonTarget), and also compares the teamspaces, unknown here.
  if (host && page.visibility === 'private' && (host.visibility !== 'private' || host.ownerId !== page.ownerId)) {
    return 'ce bouton ne peut pas modifier une base privée depuis une page partagée';
  }
  if (host && page.visibility === 'teamspace' && host.visibility === 'workspace') {
    return 'ce bouton ne peut pas modifier une base d’un espace d’équipe restreint depuis une page visible plus largement';
  }
  return null;
}

/** Text of the `actions` prop. */
export function serializeButtonActions(actions: ButtonAction[]): string {
  const json = JSON.stringify(parseButtonActions(actions));
  return json.length > BUTTON_MAX_JSON ? '[]' : json;
}

/** Number of blocks (children included) of a list of recorded blocks. */
export function countBlocks(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  return list.reduce<number>((n, b) => n + 1 + (isObject(b) ? countBlocks(b.children) : 0), 0);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Words accepted in values, besides the plain text form of each type. */
export const TODAY_WORDS = ['aujourd’hui', "aujourd'hui", 'aujourdhui', 'today'];
export const NOW_WORDS = ['maintenant', 'now'];
export const ME_WORDS = ['moi', 'me'];

export interface ValueContext {
  users: readonly PublicUser[];
  /** User running the button (« moi »). */
  meId: string | null;
  now: Date;
}

/**
 * Stored value of a text value for a property; undefined = nothing to write (unknown option,
 * unparsable number, computed property…). An empty text clears the value (null).
 */
export function buttonValue(prop: PropertyDef, raw: string, cx: ValueContext): PropertyValue | undefined {
  if (isComputedType(prop.type) || prop.type === 'title') return undefined;
  const s = raw.trim();
  if (!s) return null;
  const word = normalizeText(s);
  if (prop.type === 'date') {
    if (TODAY_WORDS.some((w) => normalizeText(w) === word)) return { start: isoDay(cx.now) };
    if (NOW_WORDS.includes(word)) return { start: cx.now.toISOString(), includeTime: true };
  }
  if (prop.type === 'person') {
    const ids = s
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (ME_WORDS.includes(normalizeText(part)) ? cx.meId : csvToValue(prop, part, { users: cx.users })))
      .flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : []));
    return ids.length ? [...new Set(ids)] : undefined;
  }
  return csvToValue(prop, raw, { users: cx.users });
}

/** Title and properties of the values of an action, for a database schema. */
export function buttonUpdate(values: ButtonPropertyValues, properties: PropertyDef[], cx: ValueContext): { title?: string; properties: Record<string, PropertyValue> } {
  const out: { title?: string; properties: Record<string, PropertyValue> } = { properties: {} };
  for (const [id, raw] of Object.entries(values)) {
    const prop = properties.find((p) => p.id === id);
    if (!prop) continue;
    if (prop.type === 'title') {
      out.title = raw.trim().slice(0, 2000);
      continue;
    }
    const v = buttonValue(prop, raw, cx);
    if (v !== undefined) out.properties[id] = v;
  }
  return out;
}

/** Rows whose property reads as the filter value (case and accents ignored); every row without filter. */
export function filterRows(rows: readonly Page[], properties: PropertyDef[], filter: { propertyId: string; value: string } | null, users: readonly PublicUser[] = []): Page[] {
  if (!filter) return [...rows];
  const prop = properties.find((p) => p.id === filter.propertyId);
  if (!prop) return [];
  const ctx = createRowContext(properties, { users });
  const wanted = normalizeText(filter.value.trim());
  return rows.filter((row) => {
    const text = csvCell(row, prop, ctx);
    if (prop.type === 'multi_select' || prop.type === 'person') {
      return wanted === '' ? text === '' : text.split(/\s*,\s*/).some((part) => normalizeText(part) === wanted);
    }
    if (prop.type === 'checkbox') return (text === 'Oui') === (parseCsvBoolean(filter.value) ?? false);
    return normalizeText(text.trim()) === wanted;
  });
}
