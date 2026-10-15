// Queries of the organize module and the invalidation helpers shared by its components.
import { useQuery } from '@tanstack/react-query';
import type { Collection, PageProp, Tag } from '@oriel/shared';
import { queryClient } from '../lib/queryClient';
import { orgApi, ok } from './api';

export function useTags(workspaceId: string) {
  return useQuery({ queryKey: ok.tags(workspaceId), queryFn: () => orgApi.tags(workspaceId), select: (d) => d.tags, staleTime: 30_000 });
}

export function usePageProps(workspaceId: string) {
  return useQuery({ queryKey: ok.props(workspaceId), queryFn: () => orgApi.props(workspaceId), select: (d) => d.props, staleTime: 30_000 });
}

export function useCollections(workspaceId: string) {
  return useQuery({ queryKey: ok.collections(workspaceId), queryFn: () => orgApi.collections(workspaceId), select: (d) => d.collections, staleTime: 30_000 });
}

export function usePageOrganization(pageId: string) {
  return useQuery({ queryKey: ok.pageOrg(pageId), queryFn: () => orgApi.pageOrganization(pageId), staleTime: 15_000 });
}

export function useTagMap(workspaceId: string): Map<string, Tag> {
  const tags = useTags(workspaceId).data;
  return new Map((tags ?? []).map((t) => [t.id, t] as const));
}

export function usePropMap(workspaceId: string): Map<string, PageProp> {
  const props = usePageProps(workspaceId).data;
  return new Map((props ?? []).map((p) => [p.id, p] as const));
}

export type { Collection };

/** Invalidates every organize query of a kind (own mutations; others' changes come through events). */
export function invalidateOrg(...kinds: Array<'tags' | 'props' | 'collections' | 'views' | 'folder-items' | 'page-org' | 'list' | 'preview' | 'journal'>) {
  for (const kind of kinds) void queryClient.invalidateQueries({ queryKey: ['org', kind] });
}
