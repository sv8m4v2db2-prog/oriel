// Pure helpers of "Rechercher dans la page" (SPEC §13.1): accent- and case-insensitive matching that
// keeps string indices, so a match found in the folded text addresses the original text.

/**
 * Lower-cases and strips diacritics character by character. A character whose folded form has another
 * length (ligatures, 'İ'…) is kept as is: the result always has the length of the input.
 */
export function foldText(input: string): string {
  let out = '';
  for (const ch of input) {
    let folded = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (folded.length !== ch.length) folded = ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
    out += folded;
  }
  return out;
}

export interface TextMatch {
  start: number;
  end: number;
}

/** Non-overlapping occurrences of `needle` in `haystack`, in order. An empty needle matches nothing. */
export function findMatches(haystack: string, needle: string, limit = 5000): TextMatch[] {
  if (!needle) return [];
  const h = foldText(haystack);
  const n = foldText(needle);
  const out: TextMatch[] = [];
  let from = 0;
  while (out.length < limit) {
    const i = h.indexOf(n, from);
    if (i < 0) break;
    out.push({ start: i, end: i + n.length });
    from = i + Math.max(n.length, 1);
  }
  return out;
}

/** Applies a replacement to the given (sorted, non-overlapping) matches of a string. */
export function replaceMatches(text: string, matches: TextMatch[], replacement: string): string {
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacement;
    last = m.end;
  }
  return out + text.slice(last);
}

/** Placeholder of a non-text inline element (mention, equation…) in the flattened text of a block. */
export const INLINE_PLACEHOLDER = '￼';

/** Position of a match among text runs: which run holds the start and the end. */
export interface Run {
  start: number;
  end: number;
}

/** Index of the run holding offset `offset` (start of match → run where start falls; end → run holding end-1). */
export function runIndexAt(runs: Run[], offset: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid]!;
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
