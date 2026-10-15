// Bounded access to the parts of an OOXML package (docx, xlsx) or any small ZIP: entry count, path
// safety, declared ratio, per-part size and a shared inflate budget are enforced before reading.
import { blobSource, bytesSource, readZipDirectory, readZipEntry, ZipError, type ByteSource, type ZipEntry } from '../zip';
import { tryUtf8 } from '../text';
import { IMPORT_LIMITS, ImportError, isSafeArchivePath } from './limits';

/** Bytes an import may still inflate (shared by every archive of one import). */
export class InflateBudget {
  remaining: number;
  constructor(total: number = IMPORT_LIMITS.maxTotalInflatedBytes) {
    this.remaining = total;
  }
  take(bytes: number, label: string): void {
    this.remaining -= bytes;
    if (this.remaining < 0) throw new ZipError(`Import interrompu : « ${label} » dépasse le volume décompressé autorisé.`);
  }
}

/** Reason why an entry must not be read, or null when it is acceptable. */
export function refusalReason(entry: Pick<ZipEntry, 'name' | 'size' | 'compressedSize' | 'encrypted'>): string | null {
  if (!isSafeArchivePath(entry.name)) return `chemin d’archive refusé (« ${entry.name} »)`;
  if (entry.encrypted) return `entrée chiffrée (« ${entry.name} »)`;
  if (entry.size > IMPORT_LIMITS.ratioFloorBytes && entry.size / Math.max(1, entry.compressedSize) > IMPORT_LIMITS.maxZipRatio) {
    return `taux de compression anormal (« ${entry.name} »)`;
  }
  return null;
}

export interface BoundedZip {
  /** Safe file entries by archive path. */
  readonly files: Map<string, ZipEntry>;
  readonly warnings: string[];
  has(path: string): boolean;
  read(path: string, maxBytes?: number): Promise<Uint8Array>;
  readText(path: string, maxBytes?: number): Promise<string | null>;
}

export async function openBoundedZip(input: Blob | Uint8Array, label: string, budget: InflateBudget = new InflateBudget()): Promise<BoundedZip> {
  const src: ByteSource = input instanceof Uint8Array ? bytesSource(input) : blobSource(input);
  if (src.size > IMPORT_LIMITS.maxInputBytes) throw new ImportError(`« ${label} » est trop volumineux (plus de ${IMPORT_LIMITS.maxInputBytes / 1024 / 1024} Mo).`);
  let entries: ZipEntry[];
  try {
    entries = await readZipDirectory(src);
  } catch (e) {
    throw new ImportError(`« ${label} » n’est pas une archive valide (${(e as Error).message}).`);
  }
  if (entries.length > IMPORT_LIMITS.maxZipEntries) throw new ImportError(`« ${label} » contient trop de fichiers (${entries.length}).`);
  const files = new Map<string, ZipEntry>();
  const warnings: string[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const why = refusalReason(e);
    if (why) {
      warnings.push(`${label} : ${why}, ignoré.`);
      continue;
    }
    files.set(e.name.replace(/^\.\//, ''), e);
  }
  const read = async (path: string, maxBytes: number = IMPORT_LIMITS.maxTextPartBytes): Promise<Uint8Array> => {
    const entry = files.get(path);
    if (!entry) throw new ImportError(`« ${path} » est absent de « ${label} ».`);
    if (entry.size > maxBytes) throw new ZipError(`« ${path} » est trop volumineux pour être importé.`);
    // QA-G8-01: the declared size is only a reservation, corrected by the real one; the read is bounded
    // by what is left of the shared budget (the directory may declare 1 byte for a 600 KB part).
    const reserved = Math.min(entry.size || 0, maxBytes);
    budget.take(reserved, label);
    const bytes = await readZipEntry(src, entry, Math.min(maxBytes, budget.remaining + reserved));
    budget.take(bytes.byteLength - reserved, label);
    return bytes;
  };
  return {
    files,
    warnings,
    has: (p) => files.has(p),
    read,
    async readText(path, maxBytes) {
      if (!files.has(path)) return null;
      const bytes = await read(path, maxBytes);
      let start = 0;
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
      return tryUtf8(bytes.subarray(start)) ?? new TextDecoder('utf-8').decode(bytes.subarray(start));
    },
  };
}
