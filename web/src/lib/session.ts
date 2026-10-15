import { useQuery } from '@tanstack/react-query';
import type { SessionResponse, WorkspaceRole, WorkspaceSummary } from '@oriel/shared';
import { api, ApiError } from './api';
import { qk } from './queryKeys';
import { queryClient } from './queryClient';
import { storage } from './store';
import { OFFLINE_DB_PREFIX, resetCollab } from './collab';
import { events } from './events';

export async function fetchSession(): Promise<SessionResponse | null> {
  try {
    return await api.auth.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: fetchSession, staleTime: 5 * 60_000 });
}

export function useAuthConfig() {
  return useQuery({ queryKey: qk.authConfig, queryFn: api.auth.config, staleTime: 60_000 });
}

export function useWorkspaces() {
  const session = useSession();
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: api.workspaces.list,
    enabled: !!session.data,
    initialData: session.data?.workspaces,
    staleTime: 30_000,
  });
}

export function useWorkspace(workspaceId: string | undefined) {
  const list = useWorkspaces();
  return useQuery({
    queryKey: qk.workspace(workspaceId ?? ''),
    queryFn: () => api.workspaces.get(workspaceId!),
    enabled: !!workspaceId,
    initialData: () => list.data?.find((w) => w.id === workspaceId),
  });
}

const LAST_WS_KEY = 'oriel:lastWorkspace';
export const rememberWorkspace = (id: string) => storage.set(LAST_WS_KEY, id);
export const lastWorkspace = () => storage.get(LAST_WS_KEY);

export function pickWorkspace(workspaces: WorkspaceSummary[]): WorkspaceSummary | null {
  const last = lastWorkspace();
  return workspaces.find((w) => w.id === last) ?? workspaces[0] ?? null;
}

export const canEditRole = (role: WorkspaceRole | undefined) => !!role && role !== 'viewer';
export const canManageRole = (role: WorkspaceRole | undefined) => role === 'owner' || role === 'admin';

export function setSession(session: SessionResponse | null) {
  queryClient.setQueryData(qk.session, session);
  if (session) queryClient.setQueryData(qk.workspaces, session.workspaces);
}

/** Clears every cached query and realtime connection (session change). */
export function clearClientState() {
  events.stop();
  resetCollab();
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.authConfig[0] });
}

/** Deletes the offline copies of page contents (y-indexeddb databases). */
async function clearLocalDocuments() {
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs
        .filter((d) => d.name?.startsWith(OFFLINE_DB_PREFIX))
        .map(
          (d) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(d.name!);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    /* not supported: nothing to do */
  }
}

export async function logout() {
  try {
    await api.auth.logout();
  } catch {
    /* ignore: we drop the local state anyway */
  }
  clearClientState();
  queryClient.setQueryData(qk.session, null);
  // Leave nothing readable for the next person using this browser.
  await clearLocalDocuments();
}
