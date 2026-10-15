// CSV cells read by spreadsheets: values starting with = + - @ (or tab / carriage return) are evaluated
// as formulas (CSV injection: =HYPERLINK(…) leaking neighbouring cells, DDE payloads). Exports prefix
// them with an apostrophe — the spreadsheet "text" marker, not displayed — and imports drop it again.

/** Formula-like cell; plain numbers (-12.5, -3,5, -1e-7, -5%, -5 €) are left alone. */
export const SPREADSHEET_FORMULA = /^(?!-\d+(?:[.,]\d+)?(?:e[-+]?\d+)?(?:\s?[%€])?$)[=+\-@\t\r]/i;

/** Inverse of the export escaping: drops the apostrophe written before a formula-like cell. */
export function unescapeSpreadsheetCell(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}
