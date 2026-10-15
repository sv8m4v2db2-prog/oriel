// Lazy ZIP reader: parses the central directory, then inflates single entries on demand by reading
// only their byte range (a multi-gigabyte archive never needs to fit in memory). ZIP64 aware.
import { Inflate } from 'fflate';
import { fixMojibake, tryUtf8 } from './text';

export interface ByteSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export const blobSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
});

export const bytesSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  read: async (start, end) => bytes.subarray(start, end),
});

/** A byte range of another source (stored entries of a parent archive, read lazily). */
export const sliceSource = (src: ByteSource, offset: number, size: number): ByteSource => ({
  size,
  read: (start, end) => src.read(offset + start, offset + Math.min(end, size)),
});

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  encrypted: boolean;
}

export class ZipError extends Error {}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o, true));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// CP437 upper half (the historical default encoding of ZIP file names).
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(raw);
  // Many tools write UTF-8 names without the flag: accept valid UTF-8 first.
  const utf8 = tryUtf8(raw);
  if (utf8 !== null) return utf8;
  let out = '';
  for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  return fixMojibake(out);
}

/** Reads the central directory of a ZIP archive. */
export async function readZipDirectory(src: ByteSource): Promise<ZipEntry[]> {
  const tailLen = Math.min(src.size, 22 + 0xffff);
  if (tailLen < 22) throw new ZipError('Archive ZIP invalide (trop courte).');
  const tail = await src.read(src.size - tailLen, src.size);
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Archive ZIP invalide (fin de répertoire introuvable).');
  let count = u16(tv, eocd + 10);
  let cdSize = u32(tv, eocd + 12);
  let cdOffset = u32(tv, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAbs = src.size - tailLen + eocd - 20;
    if (locAbs >= 0) {
      const loc = view(await src.read(locAbs, locAbs + 20));
      if (u32(loc, 0) === 0x07064b50) {
        const z64At = u64(loc, 8);
        const z64 = view(await src.read(z64At, z64At + 56));
        if (u32(z64, 0) === 0x06064b50) {
          count = u64(z64, 32);
          cdSize = u64(z64, 40);
          cdOffset = u64(z64, 48);
        }
      }
    }
  }
  if (cdOffset + cdSize > src.size) throw new ZipError('Archive ZIP tronquée ou corrompue.');
  const cd = await src.read(cdOffset, cdOffset + cdSize);
  const cv = view(cd);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cv, p) !== 0x02014b50) break;
    const flags = u16(cv, p + 8);
    const method = u16(cv, p + 10);
    let compressedSize = u32(cv, p + 20);
    let size = u32(cv, p + 24);
    const nameLen = u16(cv, p + 28);
    const extraLen = u16(cv, p + 30);
    const commentLen = u16(cv, p + 32);
    let localOffset = u32(cv, p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    let name = decodeName(rawName, (flags & 0x800) !== 0);
    // Extra fields: ZIP64 sizes/offset, Info-ZIP Unicode path.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cv, e);
      const len = u16(cv, e + 2);
      const body = e + 4;
      if (id === 0x0001) {
        let q = body;
        if (size === 0xffffffff && q + 8 <= body + len) (size = u64(cv, q)), (q += 8);
        if (compressedSize === 0xffffffff && q + 8 <= body + len) (compressedSize = u64(cv, q)), (q += 8);
        if (localOffset === 0xffffffff && q + 8 <= body + len) localOffset = u64(cv, q);
      } else if (id === 0x7075 && len > 5) {
        const unicode = tryUtf8(cd.subarray(body + 5, body + len));
        if (unicode) name = unicode;
      }
      e = body + len;
    }
    p = extraEnd + commentLen;
    name = name.replace(/\\/g, '/');
    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      method,
      compressedSize,
      size,
      localOffset,
      encrypted: (flags & 1) !== 0,
    });
  }
  return entries;
}

/** Offset of the (compressed) data of an entry. */
export async function entryDataOffset(src: ByteSource, entry: ZipEntry): Promise<number> {
  if (entry.encrypted) throw new ZipError(`« ${entry.name} » est chiffré (archive protégée par mot de passe).`);
  const head = view(await src.read(entry.localOffset, entry.localOffset + 30));
  if (u32(head, 0) !== 0x04034b50) throw new ZipError(`En-tête local invalide pour « ${entry.name} ».`);
  return entry.localOffset + 30 + u16(head, 26) + u16(head, 28);
}

/**
 * Largest entry inflated in memory. Directory sizes are declarative: without a bound, a few kilobytes
 * of deflate claiming 0 bytes expand to gigabytes (zip bomb).
 */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

const tooLarge = (entry: ZipEntry) => new ZipError(`« ${entry.name} » est trop volumineux pour être importé.`);

/**
 * Streaming inflate that gives up past `maxBytes` (input pushed in small chunks to stop early).
 * `expected` (the declared size) only preallocates the output: QA-G8-01, the size of the directory is
 * declarative, an entry that inflates to more is neither truncated nor trusted.
 */
function inflateBounded(data: Uint8Array, maxBytes: number, entry: ZipEntry, expected = 0): Uint8Array {
  let buf: Uint8Array | null = expected > 0 && expected <= maxBytes ? new Uint8Array(expected) : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    if (total + chunk.length > maxBytes) throw tooLarge(entry);
    if (buf && total + chunk.length <= buf.length) buf.set(chunk, total);
    else {
      if (buf) {
        chunks.push(buf.subarray(0, total));
        buf = null;
      }
      chunks.push(chunk);
    }
    total += chunk.length;
  });
  const step = 16 * 1024;
  for (let i = 0; i < data.length; i += step) inflater.push(data.subarray(i, i + step), i + step >= data.length);
  if (data.length === 0) inflater.push(data, true);
  if (buf) return total === buf.length ? buf : buf.subarray(0, total);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Decompressed content of one entry. */
export async function readZipEntry(src: ByteSource, entry: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  const start = await entryDataOffset(src, entry);
  if (entry.method === 0 && entry.compressedSize > maxBytes) throw tooLarge(entry);
  if (entry.method === 8 && entry.size > maxBytes) throw tooLarge(entry);
  const data = await src.read(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    // QA-G8-01: never `inflateSync` into a buffer of the declared size: a larger stream was silently
    // truncated, and inflated to its end whatever its real size (a CPU bomb, ≈1.6 s per real GB).
    try {
      return inflateBounded(data, maxBytes, entry, entry.size);
    } catch (e) {
      if (e instanceof ZipError) throw e;
      throw new ZipError(`« ${entry.name} » est corrompu (décompression impossible).`);
    }
  }
  throw new ZipError(`Méthode de compression non prise en charge (${entry.method}) pour « ${entry.name} ».`);
}
