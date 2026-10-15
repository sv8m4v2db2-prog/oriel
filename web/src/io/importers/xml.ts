// Small, safe XML reader (DOM-free, runs under Node and in the browser).
//
// Security: a DOCTYPE (external or internal subset) is skipped as opaque text, never interpreted:
// no entity declaration is honoured, no external entity or DTD is fetched (XXE), and there is no
// entity expansion (billion laughs). Only the five predefined entities and numeric references are
// decoded; any other `&name;` is kept literally. Depth and element count are bounded.
import { IMPORT_LIMITS, ImportError } from './limits';

export interface XmlElement {
  /** Qualified name as written (`w:p`). */
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | string>;
}

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,8});/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? m;
  });
}

const isNameChar = (c: number) =>
  (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c === 45 || c === 46 || c > 127;

/** SAX-style scan. Linear time. Throws ImportError on structural problems that make output unsafe. */
export function scanXml(src: string, handler: XmlHandler, opts: { maxDepth?: number; maxNodes?: number } = {}): void {
  const maxDepth = opts.maxDepth ?? IMPORT_LIMITS.maxDepth;
  const maxNodes = opts.maxNodes ?? IMPORT_LIMITS.maxNodes;
  const n = src.length;
  let i = 0;
  let depth = 0;
  let nodes = 0;
  const stack: string[] = [];

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (depth > 0) handler.text(decodeXmlEntities(src.slice(i)));
      break;
    }
    if (lt > i && depth > 0) handler.text(decodeXmlEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const stop = end < 0 ? n : end;
      if (depth > 0) handler.text(src.slice(i + 9, stop));
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE (possibly with an internal subset in brackets): skipped, never interpreted.
      let j = i + 2;
      let bracket = 0;
      let quote = 0;
      for (; j < n; j++) {
        const c = src.charCodeAt(j);
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 91) bracket++;
        else if (c === 93) bracket = Math.max(0, bracket - 1);
        else if (c === 62 && bracket === 0) break;
      }
      i = j + 1;
    } else if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i + 2);
      const name = src.slice(i + 2, end < 0 ? n : end).trim();
      i = end < 0 ? n : end + 1;
      // Tolerate unbalanced documents: close the nearest matching open element, ignore strays.
      const at = stack.lastIndexOf(name);
      if (at >= 0) {
        while (stack.length > at) {
          handler.close(stack.pop()!);
          depth--;
        }
      }
    } else {
      // Start tag.
      let j = i + 1;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      const name = src.slice(i + 1, j);
      if (!name) {
        // A lone "<": plain text.
        if (depth > 0) handler.text('<');
        i += 1;
        continue;
      }
      const attrs: Record<string, string> = {};
      let selfClosing = false;
      for (;;) {
        while (j < n && src.charCodeAt(j) <= 32) j++;
        if (j >= n) break;
        const c = src[j]!;
        if (c === '>') {
          j++;
          break;
        }
        if (c === '/') {
          selfClosing = true;
          j++;
          continue;
        }
        const s = j;
        while (j < n && isNameChar(src.charCodeAt(j))) j++;
        const key = src.slice(s, j);
        if (!key) {
          j++;
          continue;
        }
        while (j < n && src.charCodeAt(j) <= 32) j++;
        let value = '';
        if (src[j] === '=') {
          j++;
          while (j < n && src.charCodeAt(j) <= 32) j++;
          const q = src[j];
          if (q === '"' || q === "'") {
            const e = src.indexOf(q, j + 1);
            value = src.slice(j + 1, e < 0 ? n : e);
            j = e < 0 ? n : e + 1;
          } else {
            const vs = j;
            while (j < n && src.charCodeAt(j) > 32 && src[j] !== '>') j++;
            value = src.slice(vs, j);
          }
        }
        // First occurrence wins (a duplicate attribute never overrides a checked one).
        if (!(key in attrs)) attrs[key] = decodeXmlEntities(value);
      }
      i = j;
      if (++nodes > maxNodes) throw new ImportError('Document XML trop volumineux (trop d’éléments).');
      handler.open(name, attrs, selfClosing);
      if (!selfClosing) {
        stack.push(name);
        depth++;
        if (depth > maxDepth) throw new ImportError('Document XML trop profondément imbriqué.');
      } else {
        handler.close(name);
      }
    }
  }
  while (stack.length) handler.close(stack.pop()!);
}

/** Whole document as a tree (root element). */
export function parseXml(src: string, opts?: { maxDepth?: number; maxNodes?: number }): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  scanXml(
    src,
    {
      open(name, attrs) {
        const el: XmlElement = { name, attrs, children: [] };
        stack[stack.length - 1]!.children.push(el);
        stack.push(el); // scanXml always calls close(), also for self-closing elements
      },
      close() {
        if (stack.length > 1) stack.pop();
      },
      text(t) {
        stack[stack.length - 1]!.children.push(t);
      },
    },
    opts,
  );
  const first = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!first) throw new ImportError('Document XML vide ou illisible.');
  return first;
}

// --- tree helpers -------------------------------------------------------------------------

export const elements = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== 'string');

export function child(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return elements(el).filter((c) => c.name === name);
}

/** Concatenated text of an element (all descendants). */
export function textOf(el: XmlElement): string {
  let out = '';
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (typeof c === 'string') out += c;
      else walk(c);
    }
  };
  walk(el);
  return out;
}
