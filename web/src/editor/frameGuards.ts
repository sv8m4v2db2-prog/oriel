// What the embed and PDF blocks may load in an iframe. Their URLs are props of the shared document
// (any editor, imports, pasted HTML): these pure decisions run on every render, for every reader.

/** Origin of the running app ('' outside a browser, e.g. in unit tests). */
export function appOrigin(): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return origin && origin !== 'null' ? origin : '';
}

/**
 * QA-WEB-14 — true for Oriel's own origin, relative addresses included. Such a page is never
 * framed as a generic embed: the CSP allows frame-src 'self' and the embed sandbox grants
 * allow-scripts + allow-same-origin, so a same-origin page (an uploaded HTML file, another route of
 * the app) would run with the reader's session and full access to the parent page.
 */
export function isAppOrigin(raw: string, origin = appOrigin()): boolean {
  if (!origin || typeof raw !== 'string') return false;
  try {
    return new URL(raw.trim(), origin).origin === origin;
  } catch {
    return false;
  }
}

const PDF_NAME = /\.pdf$/i;
// Same shape as the server route (server/src/routes/files.ts): 128-bit hex id, then the file name.
const UPLOADED_FILE = /^\/api\/files\/[a-f0-9]{32}\/([^/]+)$/;

/** File name ends with .pdf (query / hash excluded). */
export function looksLikePdf(name: string): boolean {
  return typeof name === 'string' && PDF_NAME.test(name.trim());
}

/**
 * QA-WEB-11 — whether the PDF block may frame `url`: an uploaded file of this instance whose name
 * (in the URL or in the block) is a PDF. Any other file is served as an attachment, so framing it
 * starts a download for every reader of the page: the block then shows a link. The block props are
 * forgeable, the server has the last word (non-inline files are refused to frames, Sec-Fetch-Dest).
 */
export function canFramePdf(url: string, name: string, origin = appOrigin()): boolean {
  if (!url || typeof url !== 'string' || !origin) return false;
  let u: URL;
  try {
    u = new URL(url.trim(), origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  // The parser has already resolved dot segments: `/api/files/../x` does not match.
  const m = UPLOADED_FILE.exec(u.pathname);
  if (!m) return false;
  let fileName = m[1]!;
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    /* keep the raw segment */
  }
  return looksLikePdf(fileName) || looksLikePdf(name);
}
