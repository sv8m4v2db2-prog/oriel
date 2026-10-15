// Pure helpers over BlockNote documents for the reading features: headings (table of contents) and
// attachments (file viewer). Blocks are read defensively: the document may hold forged props.

export interface RawBlock {
  id?: unknown;
  type?: unknown;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

export interface OutlineHeading {
  id: string;
  level: number;
  text: string;
}

const MAX_BLOCKS = 20_000;

function walk(blocks: unknown, visit: (b: RawBlock) => void, budget = { left: MAX_BLOCKS }) {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks as RawBlock[]) {
    if (!b || typeof b !== 'object' || budget.left-- <= 0) continue;
    visit(b);
    walk(b.children, visit, budget);
  }
}

/** Plain text of inline content (text and links; other inline elements are skipped). */
export function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const item of content as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') out += item.text;
    else if (item.type === 'link') out += inlineText(item.content);
  }
  return out;
}

/** Headings (levels 1 to 4) in document order, children included. */
export function collectHeadings(blocks: unknown): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  walk(blocks, (b) => {
    if (b.type !== 'heading' || typeof b.id !== 'string') return;
    const raw = b.props?.level;
    const level = Math.min(4, Math.max(1, Math.round(Number(raw)) || 1));
    out.push({ id: b.id, level, text: inlineText(b.content).trim() });
  });
  return out;
}

/** Whether the floating table of contents is shown (SPEC §13.2). */
export function tocVisible(setting: boolean | undefined, headingCount: number, variant: 'full' | 'peek'): boolean {
  if (setting === false) return false;
  if (setting === true) return headingCount >= 1;
  return variant === 'full' && headingCount >= 3;
}

/** The heading that is "current": the last one whose top is above `line`, else the first. */
export function activeHeadingIndex(tops: Array<number | null>, line: number): number {
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    if (t === null || t === undefined) continue;
    if (t <= line) active = i;
    else break;
  }
  if (active >= 0) return active;
  return tops.findIndex((t) => t !== null);
}

// --- attachments ------------------------------------------------------------------------------

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export interface PageFile {
  /** Block id (to find the block back in the DOM). */
  blockId: string;
  kind: FileKind;
  url: string;
  name: string;
  caption: string;
}

const FILE_BLOCKS: Record<string, FileKind> = { image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', file: 'file' };

/** Attachments of a page in document order. Blocks without an address are ignored. */
export function collectFiles(blocks: unknown): PageFile[] {
  const out: PageFile[] = [];
  walk(blocks, (b) => {
    const kind = typeof b.type === 'string' ? FILE_BLOCKS[b.type] : undefined;
    if (!kind || typeof b.id !== 'string') return;
    const url = typeof b.props?.url === 'string' ? b.props.url.trim() : '';
    if (!url) return;
    const name = typeof b.props?.name === 'string' ? b.props.name : '';
    const caption = typeof b.props?.caption === 'string' ? b.props.caption : '';
    out.push({ blockId: b.id, kind, url, name: name || fileNameOf(url), caption });
  });
  return out;
}

/** Last path segment of a URL, decoded; '' when there is none. */
export function fileNameOf(url: string): string {
  try {
    const u = new URL(url, 'http://x.invalid');
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

/** http(s) or relative addresses only: never `javascript:`, `data:`, `blob:`… in a viewer. */
export function isViewableUrl(raw: string, base = 'http://x.invalid'): boolean {
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
