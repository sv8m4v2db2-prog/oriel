// Post-login destination (?next=): only paths of this application.

export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  // Browsers read "/\host" (and "/<tab>/host": tabs and newlines are dropped) as //host.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  return next;
}
