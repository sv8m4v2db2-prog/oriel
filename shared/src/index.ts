export * from './types.js';
export * from './api.js';
export * from './events.js';
export * from './constants.js';
export * from './positions.js';
export * from './ai.js';
export * from './collab.js';
export * from './editor.js';
export * from './io.js';
export * from './apiTokens.js';
export * from './security.js';
export * from './reading.js';
export * from './navigation.js';
export * from './organize.js';
export * from './formulaSyntax.js';
export * from './formulaReferences.js';
export * from './canvas.js';
export * from './recurrence.js';

/** Random short id for database properties and select options. */
export function shortId(length = 6): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export const newId = (): string => globalThis.crypto.randomUUID();
