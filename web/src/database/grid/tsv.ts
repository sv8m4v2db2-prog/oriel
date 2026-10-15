// Tab-separated text exchanged with spreadsheets through the clipboard (SPEC §5.10).

const NEEDS_QUOTES = /[\t\n\r"]/;

/** Matrix → TSV. Cells with tabs, line breaks or quotes are quoted like spreadsheets do. */
export function toTsv(matrix: readonly (readonly string[])[]): string {
  return matrix.map((row) => row.map((c) => (NEEDS_QUOTES.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t')).join('\n');
}

/** Upper bound of pasted cells (a clipboard full of text must not freeze the tab). */
export const MAX_PASTE_CELLS = 100_000;

/**
 * TSV → matrix. Quoted cells may contain tabs, line breaks and doubled quotes. The final line break
 * that spreadsheets append is dropped. Rows are padded to the same width.
 */
export function parseTsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let cells = 0;
  const pushCell = () => {
    row.push(cell);
    cell = '';
    cells++;
  };
  while (i < s.length && cells < MAX_PASTE_CELLS) {
    const ch = s[i]!;
    if (ch === '"' && cell === '') {
      // Quoted cell: only when the quote opens the cell and a closing quote ends it before a separator.
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += s[j];
        j++;
      }
      if (closed && (j === s.length || s[j] === '\t' || s[j] === '\n')) {
        cell = value;
        i = j;
        continue;
      }
    }
    if (ch === '\t') {
      pushCell();
    } else if (ch === '\n') {
      pushCell();
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
    i++;
  }
  if (cell !== '' || row.length > 0) {
    pushCell();
    rows.push(row);
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}
