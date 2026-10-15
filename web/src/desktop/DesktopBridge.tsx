// Sends the number of unread notifications (all workspaces) to the macOS app, which shows it on the
// Dock icon. Renders nothing; reads the same queries as the inbox (collab/keys + collab/api), so the
// real-time invalidation of `notifications` keeps it current. No-op outside the desktop app.
import { useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { collabApi } from '../collab/api';
import { ck } from '../collab/keys';
import { useWorkspaces } from '../lib/session';
import { desktop } from '../lib/desktop';

const MAX_BADGE = 99_999;

export function DesktopBridge() {
  const bridge = desktop?.setBadge ? desktop : null;
  const workspaces = useWorkspaces();
  const ids = bridge ? (workspaces.data ?? []).map((w) => w.id) : [];
  const unread = useQueries({
    queries: ids.map((id) => ({
      queryKey: ck.unread(id),
      queryFn: () => collabApi.unread(id),
      staleTime: 60_000,
      refetchInterval: 5 * 60_000,
    })),
  });
  const total = Math.min(
    MAX_BADGE,
    unread.reduce((sum, q) => sum + Math.max(0, Math.floor(q.data?.unread ?? 0)), 0),
  );

  useEffect(() => {
    bridge?.setBadge?.(total);
  }, [bridge, total]);
  // Signed out / left the workspace shell: clear the badge.
  useEffect(() => () => desktop?.setBadge?.(0), []);
  return null;
}
