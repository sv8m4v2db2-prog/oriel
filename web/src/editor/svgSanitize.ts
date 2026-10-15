// SVG produced by third-party renderers (Mermaid, abcjs) is never trusted: it is REBUILT from an
// allow-list of elements and attributes before it is shown. Standalone, string-based (no DOM) so that
// it is the same code in the browser and in tests.
//
// Dropped with their content: script, foreignObject, image, a, animate*, set, iframe, style-less
// unknown elements… Dropped attributes: every `on*` handler, any `href` that is not a `#fragment`,
// any `url(…)` that is not a `#fragment`, `javascript:` / `data:` values. `<style>` is kept (diagram
// themes) with its CSS filtered, and is only ever displayed inside a Shadow DOM (codeRender.ts).

/** In-document reference (`#id`). Typst ids are base64-like: `+`, `/` and `=` are allowed. */
const FRAGMENT_ID = /^#[\w:.+/=-]+$/;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ELEMENTS = [
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'textPath', 'title', 'desc', 'marker', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'symbol',
  'use', 'style', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feFlood', 'feColorMatrix',
  'feComposite', 'feMerge', 'feMergeNode', 'feDropShadow',
];
const ELEMENT_BY_LOWER = new Map(ELEMENTS.map((n) => [n.toLowerCase(), n]));

const ATTRIBUTES = new Set(
  (
    'id class d x y x1 y1 x2 y2 cx cy r rx ry width height points transform viewBox preserveAspectRatio fill stroke ' +
    'stroke-width stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity ' +
    'fill-opacity fill-rule clip-rule opacity font-family font-size font-weight font-style font-variant text-anchor ' +
    'dominant-baseline alignment-baseline baseline-shift text-decoration letter-spacing word-spacing dx dy rotate ' +
    'textLength lengthAdjust xml:space space style role marker-start marker-end marker-mid markerWidth markerHeight ' +
    'markerUnits refX refY orient clip-path filter offset stop-color stop-opacity gradientUnits gradientTransform ' +
    'spreadMethod fx fy clipPathUnits href xlink:href xmlns xmlns:xlink version visibility display color ' +
    'text-rendering shape-rendering startOffset in in2 stdDeviation result flood-color flood-opacity type values ' +
    'mode operator k1 k2 k3 k4 aria-label aria-hidden aria-roledescription aria-describedby aria-labelledby ' +
    'direction unicode-bidi vector-effect pointer-events paint-order writing-mode'
  ).split(' '),
);
const ATTRIBUTE_BY_LOWER = new Map([...ATTRIBUTES].map((n) => [n.toLowerCase(), n]));

const MAX_INPUT = 3 * 1024 * 1024;
const MAX_ELEMENTS = 30_000;

const XML_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;
const HTML_ENTITIES: Record<string, string> = { nbsp: '&#160;', copy: '&#169;', reg: '&#174;', hellip: '&#8230;', mdash: '&#8212;', ndash: '&#8211;', laquo: '&#171;', raquo: '&#187;', times: '&#215;', rarr: '&#8594;', larr: '&#8592;', harr: '&#8596;' };

/** Text or attribute content, escaped for XML: valid XML entities are kept, others are neutralized. */
function escapeXml(text: string, attribute: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '&') {
      const rest = text.slice(i, i + 12);
      const xml = XML_ENTITY.exec(rest);
      if (xml) {
        out += xml[0];
        i += xml[0].length - 1;
        continue;
      }
      const named = /^&([A-Za-z]{2,8});/.exec(rest);
      if (named && HTML_ENTITIES[named[1]!]) {
        out += HTML_ENTITIES[named[1]!];
        i += named[0].length - 1;
        continue;
      }
      out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"' && attribute) out += '&quot;';
    // Control characters (except tab, newline, carriage return) are not valid XML.
    else if (c < ' ' && c !== '\t' && c !== '\n' && c !== '\r') out += '';
    else out += c;
  }
  return out;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff) || 0x20))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff) || 0x20))
    .replace(/&(?:amp|quot|apos|lt|gt|colon|tab|newline);?/gi, (m) => {
      const k = m.toLowerCase();
      if (k.startsWith('&amp')) return '&';
      if (k.startsWith('&quot')) return '"';
      if (k.startsWith('&apos')) return "'";
      if (k.startsWith('&lt')) return '<';
      if (k.startsWith('&gt')) return '>';
      if (k.startsWith('&colon')) return ':';
      return ' ';
    });
}

/** `javascript:` & co. once whitespace / control characters / entities used to disguise them are removed. */
function hasScriptScheme(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const flat = decodeBasicEntities(value).replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
  return /(?:javascript|vbscript|livescript|mocha):/.test(flat) || /data:(?!image\/(?:png|gif|jpeg|webp);base64,)/.test(flat);
}

/** True when every `url(...)` of a CSS / presentation value points to a `#fragment`. */
function urlsAreFragments(value: string): boolean {
  const flat = decodeBasicEntities(value);
  const re = /url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = re.exec(flat))) {
    found++;
    if (!FRAGMENT_ID.test(m[2]!.trim())) return false;
  }
  // `url` written in a way the pattern did not match (escapes, unbalanced) → refuse.
  const mentions = (flat.match(/url\s*\(/gi) ?? []).length + (/\\/.test(flat) && /u\s*r\s*l/i.test(flat) ? 1 : 0);
  return mentions === found;
}

const CSS_FORBIDDEN = /expression\s*\(|behaviou?r\s*:|-moz-binding|@import|@charset|@namespace|javascript:|vbscript:|\bimage-set\s*\(|\bsrc\s*\(|\\/i;

/** Filtered CSS of a `<style>` element or `style=` attribute; null when it cannot be made safe. */
export function sanitizeCss(css: string): string | null {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (CSS_FORBIDDEN.test(decodeBasicEntities(text))) return null;
  if (!urlsAreFragments(text)) return null;
  return text.replace(/</g, '');
}

/** Filters a stylesheet rule by rule: unsafe rules are dropped, the rest kept (diagram themes). */
function sanitizeStylesheet(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Split on top-level `}` keeping nested blocks (@media, @keyframes) together.
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push(text.slice(start, i + 1));
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail && !tail.includes('{')) rules.push(tail);
  return rules
    .map((r) => sanitizeCss(r))
    .filter((r): r is string => !!r && r.trim() !== '')
    .join('\n');
}

function sanitizeAttribute(name: string, value: string): string | null {
  if (name === 'style') return sanitizeCss(value);
  if (name === 'href' || name === 'xlink:href') {
    const v = decodeBasicEntities(value).trim();
    return FRAGMENT_ID.test(v) ? v : null;
  }
  if (name === 'xmlns') return value === SVG_NS ? value : null;
  if (name === 'xmlns:xlink') return value === XLINK_NS ? value : null;
  if (hasScriptScheme(value)) return null;
  if (/url\s*\(/i.test(decodeBasicEntities(value)) && !urlsAreFragments(value)) return null;
  if (value.length > 20_000) return null;
  return value;
}

interface Tag {
  closing: boolean;
  name: string;
  attrs: string;
  selfClosing: boolean;
  end: number;
}

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/y;
const SKIP = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[([\s\S]*?)\]\]>/iy;

function readTag(src: string, at: number): Tag | null {
  TAG.lastIndex = at;
  const m = TAG.exec(src);
  if (!m) return null;
  return { closing: m[1] === '/', name: m[2]!, attrs: m[3] ?? '', selfClosing: m[4] === '/', end: TAG.lastIndex };
}

const ATTRIBUTE = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function readAttributes(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  ATTRIBUTE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE.exec(src))) out.push([m[1]!, m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

/**
 * Safe SVG text from untrusted SVG text, or null when it holds no usable `<svg>`. The result is
 * well-formed XML (parse it with DOMParser 'image/svg+xml' and import the root element).
 */
export function sanitizeSvg(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT) return null;
  let out = '';
  let i = 0;
  let elements = 0;
  let dropDepth = 0; // > 0 while inside a dropped element
  const stack: string[] = [];
  let sawRoot = false;
  let styleOpen = false;
  let styleText = '';

  const flushStyle = () => {
    out += escapeXml(sanitizeStylesheet(styleText), false);
    styleText = '';
  };

  while (i < input.length) {
    if (input[i] === '<') {
      SKIP.lastIndex = i;
      const skip = SKIP.exec(input);
      if (skip) {
        // CDATA keeps its text (diagram styles are often wrapped in it); comments, PI, DOCTYPE vanish.
        if (skip[1] !== undefined && dropDepth === 0) {
          if (styleOpen) styleText += skip[1];
          else out += escapeXml(skip[1], false);
        }
        i = SKIP.lastIndex;
        continue;
      }
      const tag = readTag(input, i);
      if (tag) {
        i = tag.end;
        const canonical = ELEMENT_BY_LOWER.get(tag.name.toLowerCase());
        if (dropDepth > 0) {
          if (!tag.closing && !tag.selfClosing) dropDepth++;
          else if (tag.closing) dropDepth--;
          continue;
        }
        if (tag.closing) {
          if (canonical && stack.includes(canonical)) {
            // Close everything opened after the matching element too (tolerates sloppy markup).
            while (stack.length) {
              const top = stack.pop()!;
              if (top === 'style' && styleOpen) {
                flushStyle();
                styleOpen = false;
              }
              out += `</${top}>`;
              if (top === canonical) break;
            }
          }
          continue;
        }
        if (!canonical || (canonical !== 'svg' && !sawRoot) || (canonical === 'svg' && sawRoot && stack.length === 0)) {
          if (!tag.selfClosing) dropDepth = 1;
          continue;
        }
        if (++elements > MAX_ELEMENTS) return null;
        if (canonical === 'svg' && !sawRoot) sawRoot = true;
        let attrs = '';
        let hasNs = false;
        let hasXlink = false;
        for (const [rawName, rawValue] of readAttributes(tag.attrs)) {
          const lower = rawName.toLowerCase();
          let name = ATTRIBUTE_BY_LOWER.get(lower);
          if (!name && /^data-[a-z0-9_-]+$/.test(lower)) name = lower;
          if (!name || lower.startsWith('on')) continue;
          const value = sanitizeAttribute(name, rawValue);
          if (value === null) continue;
          if (name === 'xmlns') hasNs = true;
          if (name === 'xmlns:xlink') hasXlink = true;
          attrs += ` ${name}="${escapeXml(value, true)}"`;
        }
        if (canonical === 'svg' && stack.length === 0) {
          if (!hasNs) attrs += ` xmlns="${SVG_NS}"`;
          if (!hasXlink) attrs += ` xmlns:xlink="${XLINK_NS}"`;
        }
        if (canonical === 'use' && !/\shref=/.test(attrs) && !/\sxlink:href=/.test(attrs)) {
          if (!tag.selfClosing) dropDepth = 1;
          continue;
        }
        if (tag.selfClosing) out += `<${canonical}${attrs}/>`;
        else {
          out += `<${canonical}${attrs}>`;
          stack.push(canonical);
          if (canonical === 'style') styleOpen = true;
        }
        continue;
      }
      // A lone "<" that does not start a tag is text.
    }
    const next = input.indexOf('<', i + 1);
    const end = next === -1 ? input.length : next;
    const text = input.slice(i, end);
    i = end;
    if (dropDepth > 0 || stack.length === 0) continue;
    if (styleOpen) styleText += text;
    else out += escapeXml(text, false);
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top === 'style' && styleOpen) {
      flushStyle();
      styleOpen = false;
    }
    out += `</${top}>`;
  }
  return sawRoot && out.startsWith('<svg') ? out : null;
}

/** Parses sanitized SVG text into an <svg> element of `doc` (browser only); null when it is not valid XML. */
export function svgElementFromText(svg: string, doc: Document = document): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.nodeName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) return null;
  return doc.importNode(root, true) as unknown as SVGSVGElement;
}
