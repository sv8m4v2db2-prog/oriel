// Tolerant HTML reader producing a small element tree (DOM-free, linear time).
// The tree is only ever converted to editor blocks (htmlToBlocks.ts): imported HTML is never
// injected as markup. <script> and <style> bodies are dropped, comments and DOCTYPE ignored.
import { IMPORT_LIMITS, ImportError } from './limits';
import { decodeXmlEntities, type XmlElement } from './xml';

export type HtmlElement = XmlElement;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title-raw']);
const BLOCK_CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  otilde: 'õ', ouml: 'ö', oelig: 'œ', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Icirc: 'Î',
  Iuml: 'Ï', Ocirc: 'Ô', Ouml: 'Ö', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', OElig: 'Œ', emsp: ' ', ensp: ' ', thinsp: ' ',
  shy: '', zwj: '', zwnj: '',
};

export function decodeHtmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return decodeXmlEntities(s).replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, name: string) => HTML_ENTITIES[name] ?? m);
}

const isNameChar = (c: number) => (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c === 45 || c === 46 || c > 127;

/** Parses an HTML document or fragment; returns a synthetic root whose children are the top-level nodes. */
export function parseHtml(src: string, opts: { maxDepth?: number; maxNodes?: number } = {}): HtmlElement {
  const maxDepth = opts.maxDepth ?? IMPORT_LIMITS.maxDepth;
  const maxNodes = opts.maxNodes ?? IMPORT_LIMITS.maxNodes;
  const root: HtmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const n = src.length;
  let i = 0;
  let nodes = 0;
  let lowerSrc: string | null = null;

  const closeUntil = (names: string[], stopAt: string[]): void => {
    for (let k = stack.length - 1; k > 0; k--) {
      const nm = stack[k]!.name;
      if (names.includes(nm)) {
        stack.length = k;
        return;
      }
      if (stopAt.includes(nm)) return;
    }
  };
  const closeImplied = (name: string): void => {
    if (name === 'li') closeUntil(['li'], ['ul', 'ol', 'table']);
    else if (name === 'td' || name === 'th') closeUntil(['td', 'th'], ['tr', 'table']);
    else if (name === 'tr') closeUntil(['tr'], ['table']);
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeUntil(['thead', 'tbody', 'tfoot'], ['table']);
    else if (name === 'dt' || name === 'dd') closeUntil(['dt', 'dd'], ['dl']);
    else if (name === 'option') closeUntil(['option'], ['select']);
    if (BLOCK_CLOSES_P.has(name) && top().name === 'p') stack.pop();
  };
  const pushText = (t: string) => {
    if (!t) return;
    const cur = top();
    const last = cur.children[cur.children.length - 1];
    if (typeof last === 'string') cur.children[cur.children.length - 1] = last + t;
    else cur.children.push(t);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeHtmlEntities(src.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeHtmlEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      pushText(src.slice(i + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i + 2);
      const name = src.slice(i + 2, end < 0 ? n : end).trim().toLowerCase();
      i = end < 0 ? n : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    let j = i + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    if (j === i + 1) {
      pushText('<');
      i += 1;
      continue;
    }
    const name = src.slice(i + 1, j).toLowerCase();
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
      const key = src.slice(s, j).toLowerCase();
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
      if (!(key in attrs)) attrs[key] = decodeHtmlEntities(value);
    }
    i = j;
    if (RAW.has(name) && !selfClosing) {
      // Raw text element: skip to its closing tag (body dropped, except <textarea>).
      lowerSrc ??= src.replace(/[^\x00-\x7f]/g, ' ').toLowerCase(); // same length as src
      const end = lowerSrc.indexOf(`</${name}`, i);
      const stop = end < 0 ? n : end;
      if (name === 'style' && stop - i <= 2_000_000) {
        // Kept as text of an (otherwise ignored) element: the class rules style imported runs.
        top().children.push({ name: 'style', attrs: {}, children: [src.slice(i, stop)] });
      }
      const close = src.indexOf('>', stop);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (++nodes > maxNodes) throw new ImportError('Document HTML trop volumineux (trop d’éléments).');
    closeImplied(name);
    const el: HtmlElement = { name, attrs, children: [] };
    top().children.push(el);
    if (!VOID.has(name) && !selfClosing) {
      stack.push(el);
      if (stack.length > maxDepth) throw new ImportError('Document HTML trop profondément imbriqué.');
    }
  }
  return root;
}

// --- tree helpers -------------------------------------------------------------------------

export function findAll(el: HtmlElement, pred: (e: HtmlElement) => boolean, out: HtmlElement[] = []): HtmlElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

export const findFirst = (el: HtmlElement, pred: (e: HtmlElement) => boolean): HtmlElement | undefined => findAll(el, pred)[0];

export function hasClass(el: HtmlElement, cls: string): boolean {
  const c = el.attrs.class;
  return !!c && (' ' + c + ' ').includes(' ' + cls + ' ');
}

export function htmlText(el: HtmlElement): string {
  let out = '';
  const walk = (e: HtmlElement) => {
    for (const c of e.children) {
      if (typeof c === 'string') out += c;
      else if (c.name === 'br') out += '\n';
      else walk(c);
    }
  };
  walk(el);
  return out;
}
