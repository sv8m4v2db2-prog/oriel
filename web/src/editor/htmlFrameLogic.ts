// HTML block: pure decisions about its frame (unit-tested, see htmlBlock.test.ts). The frame runs
// the block's HTML in an opaque origin (sandbox="allow-scripts", never allow-same-origin): it can
// only talk to the page through postMessage, and the page accepts nothing but `ready` and `resize`.
import { HTML_BLOCK_MAX_LENGTH, HTML_FRAME_MAX_HEIGHT, type HtmlFrameMessage } from '@oriel/shared';

/** The only sandbox token of the frame (no same-origin, forms, popups, top navigation…). */
export const HTML_FRAME_SANDBOX = 'allow-scripts';

/**
 * QA-EDT-03 — what the reader is told before running a block. The frame's CSP blocks fetch, XHR,
 * WebSocket, forms and frames, but lets images and fonts load from any https address (`img-src` /
 * `font-src https:`): a block can send what is typed in it, and the reader's address, to a third-party
 * site. It must not be presented as cut off from the network.
 */
export const HTML_RUN_NOTICE =
  'Le code s’exécute dans un cadre isolé, sans accès à Oriel ni à vos données. Il peut charger des images depuis Internet : n’y saisissez jamais de mot de passe.';

/** Frame height before the first `resize` message. */
export const HTML_FRAME_INITIAL_HEIGHT = 120;

export type FrameToParent = Extract<HtmlFrameMessage, { type: 'ready' } | { type: 'resize' }>;

/**
 * Message posted by the frame, or null. `source` must be the frame's own window (the origin of an
 * opaque frame is "null" and proves nothing); anything else than `ready` / `resize` (with a finite
 * height, clamped to 0–HTML_FRAME_MAX_HEIGHT) is ignored.
 */
export function readFrameMessage(source: unknown, frameWindow: unknown, data: unknown): FrameToParent | null {
  if (!frameWindow || source !== frameWindow) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const type = (data as { type?: unknown }).type;
  if (type === 'ready') return { type: 'ready' };
  if (type === 'resize') {
    const height = (data as { height?: unknown }).height;
    if (typeof height !== 'number' || !Number.isFinite(height)) return null;
    return { type: 'resize', height: clampFrameHeight(height) };
  }
  return null;
}

export const clampFrameHeight = (height: number): number =>
  Number.isFinite(height) ? Math.max(0, Math.min(HTML_FRAME_MAX_HEIGHT, Math.ceil(height))) : HTML_FRAME_INITIAL_HEIGHT;

/** Source of the block (a forged prop may hold anything) and whether it may run (size limit). */
export function htmlSource(raw: unknown): { html: string; tooLarge: boolean } {
  const html = typeof raw === 'string' ? raw : '';
  return { html, tooLarge: html.length > HTML_BLOCK_MAX_LENGTH };
}

/** Size shown to the editor ("12,3 Ko sur 200 Ko"). */
export function sizeLabel(length: number): string {
  const ko = (n: number) => `${(n / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Ko`;
  const size = length < 1024 ? `${length} ${length > 1 ? 'octets' : 'octet'}` : ko(length);
  return `${size} sur ${ko(HTML_BLOCK_MAX_LENGTH)}`;
}

/**
 * One frame session: the HTML is sent once, after the frame's first `ready`. Later `ready` messages
 * (the frame's script navigated or reloaded itself) get nothing: the block must be run again.
 */
export function createFrameSession(html: string) {
  let sent = false;
  return {
    /** Message to send in reply to `ready`, or null when already sent. */
    onReady(): Extract<HtmlFrameMessage, { type: 'render' }> | null {
      if (sent) return null;
      sent = true;
      return { type: 'render', html };
    },
    get sent() {
      return sent;
    },
  };
}
