// Virtual file system over whatever the user dropped: ZIP archives (nested ZIPs are mounted in
// place), loose files and folders. Paths are normalized ('/'-separated, NFC, no leading slash).
import { MAX_ENTRY_BYTES, ZipError, blobSource, bytesSource, entryDataOffset, readZipDirectory, readZipEntry, sliceSource, type ByteSource } from './zip';
import { fixMojibake, looseKey } from './text';
import { IMPORT_LIMITS } from './importers/limits';
import { refusalReason } from './importers/safeZip';

export interface VfsFile {
  path: string;
  size: number;
  read(): Promise<Uint8Array>;
}

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const MAX_ZIP_DEPTH = 3;

export function normalizePath(raw: string): string {
  const out: string[] = [];
  for (const seg of raw.replace(/\\/g, '/').split('/')) {
    const s = fixMojibake(seg).normalize('NFC');
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const joinPath = (dir: string, rel: string) => normalizePath(dir ? `${dir}/${rel}` : rel);
export const extname = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};

export function isJunkPath(p: string): boolean {
  return p.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('._') || JUNK_NAMES.has(seg.toLowerCase()));
}

export class Vfs {
  private readonly files = new Map<string, VfsFile>();
  private readonly loose = new Map<string, string>();
  readonly warnings: string[] = [];
  /** Bytes still allowed for compressed nested archives, which are inflated in memory (zip bombs). */
  nestedBudget = MAX_ENTRY_BYTES;
  /** Archive entries seen so far (nested archives included) and bytes inflated by reads (bombs). */
  entryCount = 0;
  inflated = 0;

  add(file: VfsFile): void {
    if (!file.path || isJunkPath(file.path)) return;
    if (this.files.has(file.path)) {
      this.warnings.push(`Fichier en double ignoré : ${file.path}`);
      return;
    }
    this.files.set(file.path, file);
    const k = looseKey(file.path);
    if (!this.loose.has(k)) this.loose.set(k, file.path);
  }

  /** Exact path first, then a case/accents/Unicode-insensitive match. */
  resolve(path: string): VfsFile | undefined {
    const p = normalizePath(path);
    return this.files.get(p) ?? this.files.get(this.loose.get(looseKey(p)) ?? '');
  }

  list(): VfsFile[] {
    return [...this.files.values()];
  }

  get size(): number {
    return this.files.size;
  }
}

async function mountZip(vfs: Vfs, src: ByteSource, baseDir: string, label: string, depth: number): Promise<void> {
  const entries = await readZipDirectory(src);
  vfs.entryCount += entries.length;
  if (vfs.entryCount > IMPORT_LIMITS.maxZipEntries) throw new ZipError('Archive trop volumineuse (trop de fichiers).');
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const refused = refusalReason(entry);
    if (refused) {
      vfs.warnings.push(`Entrée ignorée dans ${label} : ${refused}.`);
      continue;
    }
    const path = joinPath(baseDir, entry.name);
    if (!path || isJunkPath(path)) continue;
    if (/\.zip$/i.test(path) && depth < MAX_ZIP_DEPTH) {
      try {
        // Stored archives are read in place; compressed ones have to be inflated in memory (bounded).
        let inner: ByteSource;
        if (entry.method === 0) inner = sliceSource(src, await entryDataOffset(src, entry), entry.compressedSize);
        else {
          const bytes = await readZipEntry(src, entry, vfs.nestedBudget);
          vfs.nestedBudget -= bytes.byteLength;
          inner = bytesSource(bytes);
        }
        // Archives split in parts (Export-…-Part-1.zip) merge into the folder that holds them.
        await mountZip(vfs, inner, dirname(path), path, depth + 1);
      } catch (e) {
        vfs.warnings.push(`Archive imbriquée illisible (${path}) : ${(e as Error).message}`);
      }
      continue;
    }
    vfs.add({
      path,
      size: entry.size,
      read: async () => {
        // QA-G8-01: the declared size is only a reservation, corrected by the real one, and the read
        // is bounded by what is left of the budget (an entry declaring 0 bytes used to be free).
        vfs.inflated += entry.size;
        const left = IMPORT_LIMITS.maxTotalInflatedBytes - vfs.inflated;
        if (left < 0) throw new ZipError('Volume décompressé maximal dépassé.');
        const bytes = await readZipEntry(src, entry, Math.min(MAX_ENTRY_BYTES, left + entry.size));
        vfs.inflated += bytes.byteLength - entry.size;
        return bytes;
      },
    });
  }
  if (entries.length === 0) vfs.warnings.push(`Archive vide : ${label}`);
}

export interface InputFile {
  /** Relative path (folder drops) or plain name. */
  path: string;
  blob: Blob;
}

/** Builds the VFS from dropped/picked files; ZIPs are opened lazily (only their directory is read). */
export async function buildVfs(inputs: InputFile[], nestedBudget = MAX_ENTRY_BYTES): Promise<Vfs> {
  const vfs = new Vfs();
  vfs.nestedBudget = nestedBudget;
  for (const input of inputs) {
    const path = normalizePath(input.path);
    if (!path || isJunkPath(path)) continue;
    if (/\.zip$/i.test(path)) {
      try {
        await mountZip(vfs, blobSource(input.blob), dirname(path), path, 1);
      } catch (e) {
        vfs.warnings.push(`Archive illisible (${path}) : ${(e as Error).message}`);
      }
    } else {
      const blob = input.blob;
      vfs.add({ path, size: blob.size, read: async () => new Uint8Array(await blob.arrayBuffer()) });
    }
  }
  return vfs;
}

// --- Browser helpers: drag & drop of folders ---------------------------------------------

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  file(ok: (f: File) => void, ko: (e: unknown) => void): void;
}
interface FsDirEntry extends FsEntry {
  createReader(): { readEntries(ok: (entries: FsEntry[]) => void, ko: (e: unknown) => void): void };
}

async function walkEntry(entry: FsEntry, out: InputFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, ko) => (entry as FsFileEntry).file(ok, ko));
    out.push({ path: entry.fullPath.replace(/^\//, ''), blob: file });
  } else if (entry.isDirectory) {
    const reader = (entry as FsDirEntry).createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, ko) => reader.readEntries(ok, ko));
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

/** Files of a drop event, folders included (when the browser exposes them). */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<InputFile[]> {
  const out: InputFile[] = [];
  const entries: FsEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const getter = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry;
    const entry = getter ? getter.call(item) : null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) out.push({ path: f.name, blob: f });
    }
  }
  for (const entry of entries) await walkEntry(entry, out);
  if (out.length === 0) for (const f of Array.from(dt.files ?? [])) out.push({ path: f.name, blob: f });
  return out;
}

/** Files picked with <input type=file> (webkitRelativePath set for folder pickers). */
export function filesFromInput(list: FileList | null): InputFile[] {
  return Array.from(list ?? []).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, blob: f }));
}
