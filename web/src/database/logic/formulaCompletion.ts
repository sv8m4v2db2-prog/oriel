// Autocompletion of the formula editor: the identifier being typed at the caret, and the matching
// functions and variables. Pure module (no React).
import { FORMULA_FUNCTIONS } from './formula';

export interface FormulaCompletion {
  /** Text shown and inserted (a function is inserted with its opening parenthesis). */
  label: string;
  insert: string;
  detail: string;
  kind: 'function' | 'variable';
}

export interface FormulaCompletions {
  /** Offset where the identifier being typed starts (replaced on acceptance). */
  start: number;
  items: FormulaCompletion[];
}

const MAX_ITEMS = 8;
const IDENT_TAIL = /[\p{L}_][\p{L}\p{M}\p{N}_]*$/u;

const VARIABLES: FormulaCompletion[] = [
  { label: 'current', insert: 'current', detail: 'Élément en cours, dans map(), filter() et les fonctions de liste.', kind: 'variable' },
  { label: 'index', insert: 'index', detail: 'Position de l’élément en cours (à partir de 0).', kind: 'variable' },
];

/** Whether `offset` is inside a string literal of `source` (quotes "…" or '…', backslash escapes). */
function insideString(source: string, offset: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < offset; i++) {
    const ch = source.charAt(i);
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}

/** Completions for the identifier ending at `caret` (none inside a string or after a number). */
export function formulaCompletions(source: string, caret: number): FormulaCompletions | null {
  const before = source.slice(0, caret);
  const match = IDENT_TAIL.exec(before);
  if (!match || insideString(source, caret)) return null;
  const start = caret - match[0].length;
  if (/[0-9]/.test(source.charAt(start - 1))) return null;
  const prefix = match[0].toLowerCase();
  const afterDot = source.charAt(start - 1) === '.';
  const functions: FormulaCompletion[] = FORMULA_FUNCTIONS.filter((f) => !(afterDot && (f.name === 'let' || f.name === 'lets'))).map((f) => ({
    label: f.name,
    insert: `${f.name}(`,
    detail: f.description,
    kind: 'function',
  }));
  const candidates = afterDot ? functions : [...functions, ...VARIABLES];
  const items = candidates
    .filter((c) => c.label.toLowerCase().startsWith(prefix) && c.label.toLowerCase() !== prefix)
    .slice(0, MAX_ITEMS);
  return items.length ? { start, items } : null;
}
