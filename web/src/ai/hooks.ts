// Data hooks of the AI module.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiBrief, AiLatestBriefResponse } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { aiApi } from './api';
import { aiKeys } from './queryKeys';

const POLL_MS = 3000;

export function useAiSettings(workspaceId: string) {
  return useQuery({ queryKey: aiKeys.settings(workspaceId), queryFn: () => aiApi.settings(workspaceId), staleTime: 60_000 });
}

/** Latest brief + run in progress; polls every 3 s while a run is in progress. */
export function useLatestBrief(workspaceId: string, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: aiKeys.latest(workspaceId),
    queryFn: () => aiApi.latest(workspaceId),
    enabled,
    refetchInterval: (q) => (q.state.data?.running ? POLL_MS : false),
  });
  // When a run finishes: refresh history and usage, and tell the user how it went.
  const runningId = query.data?.running?.id ?? null;
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = runningId;
    if (!prev || runningId) return;
    void queryClient.invalidateQueries({ queryKey: aiKeys.history(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: aiKeys.usage(workspaceId) });
    // The spend changed: the manual-run state (quota, reserve, caps) of the settings too.
    void queryClient.invalidateQueries({ queryKey: aiKeys.settings(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: aiKeys.instance });
    const last = query.data?.lastRun;
    if (last?.id === prev) {
      if (last.status === 'succeeded') toast.success('Le brief du jour est prêt.');
      else if (last.error) toast.error(last.error);
    }
  }, [runningId, workspaceId, queryClient, query.data?.lastRun]);
  return query;
}

export function useBriefHistory(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: aiKeys.history(workspaceId), queryFn: () => aiApi.history(workspaceId), enabled });
}

export function useBrief(id: string | null) {
  return useQuery({ queryKey: aiKeys.brief(id ?? ''), queryFn: () => aiApi.brief(id!), enabled: !!id, staleTime: 5 * 60_000 });
}

export function useAiUsage(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: aiKeys.usage(workspaceId), queryFn: () => aiApi.usage(workspaceId), enabled });
}

/** Instance-wide cap and month spend (instance admins only: pass `enabled` accordingly). */
export function useAiInstance(enabled: boolean) {
  return useQuery({ queryKey: aiKeys.instance, queryFn: () => aiApi.instance(), enabled });
}

/** Starts a brief run; resolves with the run (null on error, already reported by a toast). */
export function useStartBrief(workspaceId: string) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const start = async (): Promise<AiBrief | null> => {
    setStarting(true);
    try {
      const { brief } = await aiApi.start(workspaceId);
      if (brief.status === 'skipped') {
        toast.error(brief.error ?? 'Brief non généré.');
      } else {
        queryClient.setQueryData<AiLatestBriefResponse>(aiKeys.latest(workspaceId), (old) =>
          old ? { ...old, running: brief, lastRun: brief } : { latest: null, running: brief, lastRun: brief },
        );
      }
      void queryClient.invalidateQueries({ queryKey: aiKeys.latest(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.usage(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.settings(workspaceId) });
      return brief;
    } catch (err) {
      // e.g. 429: daily quota of manual runs, budget reserve of the scheduled briefs, instance cap busy.
      toast.error(errorMessage(err, 'Impossible de lancer le brief.'));
      void queryClient.invalidateQueries({ queryKey: aiKeys.latest(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.settings(workspaceId) });
      return null;
    } finally {
      setStarting(false);
    }
  };
  return { start, starting };
}
