// Props of blocks and inline contents come from the shared Yjs document, where any client can store
// any JSON value (an object where a string is expected). Renderers read them through these coercions:
// an object rendered as a React child throws, and the error takes the whole editor down.

export const propString = (v: unknown): string => (typeof v === 'string' ? v : '');

export const propNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
