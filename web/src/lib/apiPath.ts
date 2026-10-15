// Paths of /api/... requests built from data (QA-WEB-12). Identifiers come from the route (invite
// token), from the shared document (page mentions, database blocks, linked views…) or from the
// server: interpolated as-is, a forged `../../auth/…`, `x?y=` or `x#` would make the client call
// another API route with the reader's cookies.

/** Lone UTF-16 surrogates (which make encodeURIComponent throw a URIError) replaced by U+FFFD. */
function wellFormed(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
        continue;
      }
      out += '�';
    } else {
      out += c >= 0xdc00 && c <= 0xdfff ? '�' : s[i];
    }
  }
  return out;
}

/** One path segment: `/`, `\`, `?`, `#`, `%`, spaces, control and non-ASCII characters are percent-encoded. */
export function pathSegment(value: string | number): string {
  const s = String(value);
  try {
    return encodeURIComponent(s);
  } catch {
    return encodeURIComponent(wellFormed(s));
  }
}

/**
 * Tagged template encoding every interpolation as ONE path segment: apiPath`/pages/${id}/content`.
 * The literal parts are kept as written. A value of exactly `.` or `..` stays a dot segment (no
 * encoding prevents the URL parser from resolving `%2e%2e`): the request functions refuse such paths
 * with isSafeApiPath, asynchronously, so a forged id never throws in a render or an effect.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += pathSegment(values[i]!) + (strings[i + 1] ?? '');
  return out;
}

/** `?a=1&b=x` (URLSearchParams encoding), '' when every value is empty; undefined / null / '' are skipped. */
export function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

// `.`, `..` and their percent-encoded forms, which the URL parser resolves like `..`.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
// The URL parser treats `\` as `/` and drops tabs / newlines (`.\t.` → `..`) in http(s) URLs.
const PARSER_REWRITTEN = /[\\\u0000-\u001f\u007f]/;

/**
 * False when the URL parser would rewrite the path (dot segments, backslashes, control characters):
 * last line of defense of the request functions, whatever built the path.
 */
export function isSafeApiPath(path: string): boolean {
  if (PARSER_REWRITTEN.test(path)) return false;
  const end = path.search(/[?#]/);
  const pathname = end < 0 ? path : path.slice(0, end);
  return !pathname.split('/').some((segment) => DOT_SEGMENT.test(segment));
}
