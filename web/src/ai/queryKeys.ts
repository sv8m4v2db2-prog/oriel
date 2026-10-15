// TanStack Query keys of the AI module (kept apart from lib/queryKeys: no real-time invalidation).
export const aiKeys = {
  all: ['ai'] as const,
  settings: (wid: string) => ['ai', 'settings', wid] as const,
  latest: (wid: string) => ['ai', 'latest', wid] as const,
  history: (wid: string) => ['ai', 'history', wid] as const,
  brief: (id: string) => ['ai', 'brief', id] as const,
  usage: (wid: string) => ['ai', 'usage', wid] as const,
  /** Instance-wide status (cap, month spend): instance admins only. */
  instance: ['ai', 'instance'] as const,
};
