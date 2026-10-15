// Text helpers shared by import and export (DOM-free, unit-tested under Node).

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');

/** Decodes a text file: BOM-aware (UTF-8/UTF-16), UTF-8 first, Windows-1252 as a fallback. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else {
    const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    try {
      text = utf8Strict.decode(body);
    } catch {
      try {
        text = new TextDecoder('windows-1252').decode(body);
      } catch {
        text = utf8Loose.decode(body);
      }
    }
  }
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Valid UTF-8 bytes → string, or null. */
export function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Repairs a name whose UTF-8 bytes were read as Latin-1 / CP437 ("CafÃ©" → "Café").
 * Returns the input unchanged when it does not look like mojibake.
 */
export function fixMojibake(name: string): string {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) return name;
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
  const fixed = tryUtf8(bytes);
  return fixed && fixed !== name ? fixed : name;
}

/** Key used to compare titles/names loosely (case, accents, spacing, Unicode normalization). */
export function looseKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s  ]+/g, ' ')
    .trim();
}

/** Natural, French-aware comparison for file names. */
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

const EMOJI_RE = /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/u;

/** Leading emoji of a string (with its modifiers), or null. */
export function leadingEmoji(s: string): string | null {
  const m = EMOJI_RE.exec(s.trimStart());
  return m ? m[0] : null;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** File-system-safe file or folder name (no extension), never empty, ≤ 100 characters. */
export function safeName(title: string, fallback = 'Sans titre'): string {
  let name = (title || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const chars = Array.from(name);
  if (chars.length > 100) name = chars.slice(0, 100).join('').trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name = `${name}_`;
  return name;
}

/** Bytes → base64 (chunked, safe for multi-megabyte buffers). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Runs `worker` over `items` with at most `limit` concurrent calls; stops early when `signal` aborts. */
export async function pool<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export class Cancelled extends Error {
  constructor() {
    super('Opération annulée.');
    this.name = 'Cancelled';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Cancelled();
}
