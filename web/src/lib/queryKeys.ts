// Single source of truth for TanStack Query keys. Real-time invalidation (lib/events.ts)
// relies on these exact shapes, so every query in the app must build its key here.
export const qk = {
  session: ['session'] as const,
  authConfig: ['auth-config'] as const,
  workspaces: ['workspaces'] as const,
  workspace: (wid: string) => ['workspace', wid] as const,
  tree: (wid: string) => ['tree', wid] as const,
  favorites: (wid: string) => ['favorites', wid] as const,
  recent: (wid: string) => ['recent', wid] as const,
  trash: (wid: string) => ['trash', wid] as const,
  members: (wid: string) => ['members', wid] as const,
  invites: (wid: string) => ['invites', wid] as const,
  search: (wid: string, query: string) => ['search', wid, query] as const,
  page: (pid: string) => ['page', pid] as const,
  backlinks: (pid: string) => ['backlinks', pid] as const,
  snapshots: (pid: string) => ['snapshots', pid] as const,
  /** DatabaseResponse: page + schema + views */
  database: (did: string) => ['database', did] as const,
  /** RowsResponse */
  rows: (did: string) => ['rows', did] as const,
  publicPage: (pid: string) => ['public-page', pid] as const,
  publicDatabase: (did: string) => ['public-database', did] as const,
  publicRows: (did: string) => ['public-rows', did] as const,
  adminSettings: ['admin-settings'] as const,
  adminUsers: ['admin-users'] as const,
};
