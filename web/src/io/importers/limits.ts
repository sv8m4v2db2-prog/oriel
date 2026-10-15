// Bounds of the file importers (Word, Excel, Confluence, Evernote, Trello, Asana). Every input is
// hostile until proven otherwise: archives and documents come from anywhere.

export const IMPORT_LIMITS = {
  /** A single input file (docx, xlsx, enex, json, csv, html), in bytes. */
  maxInputBytes: 512 * 1024 * 1024,
  /** One decompressed XML / HTML / JSON part. */
  maxTextPartBytes: 96 * 1024 * 1024,
  /** Entries of one archive. */
  maxZipEntries: 100_000,
  /** Declared decompression ratio above which an entry larger than `ratioFloorBytes` is refused. */
  maxZipRatio: 1000,
  ratioFloorBytes: 4 * 1024 * 1024,
  /** Decompressed bytes an import may read in total (attachments included). */
  maxTotalInflatedBytes: 4 * 1024 * 1024 * 1024,
  /** Nesting depth of XML / HTML elements and of nested lists. */
  maxDepth: 128,
  /** Elements of one XML / HTML document. */
  maxNodes: 4_000_000,
  /** Pages (including rows) one import may create. */
  maxPages: 50_000,
  maxRowsPerSheet: 20_000,
  maxColumns: 100,
  maxSheets: 100,
  /** Characters of one cell / text field. */
  maxCellChars: 100_000,
} as const;

/** A document that cannot be imported (the importer reports it and carries on with the others). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Safe archive entry path: no `..` segment, no absolute or drive path, no NUL. */
export function isSafeArchivePath(raw: string): boolean {
  if (!raw || raw.includes('\0')) return false;
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}
