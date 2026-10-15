// Sidebar tree helpers built on the `tree(ws)` query.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sortByPosition, type TreeNode, type Visibility } from '@oriel/shared';
import { api } from './api';
import { qk } from './queryKeys';

export interface TreeIndex {
  byId: Map<string, TreeNode>;
  /** key `${parentType}:${parentId}` → children sorted by position */
  children: Map<string, TreeNode[]>;
}

export const childKey = (parentType: string, parentId: string) => `${parentType}:${parentId}`;

export function buildTreeIndex(nodes: TreeNode[]): TreeIndex {
  const byId = new Map<string, TreeNode>();
  const groups = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const key = childKey(n.parentType, n.parentId);
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  const children = new Map<string, TreeNode[]>();
  for (const [k, list] of groups) children.set(k, sortByPosition(list));
  return { byId, children };
}

export function rootNodes(index: TreeIndex, workspaceId: string, visibility: Visibility): TreeNode[] {
  return (index.children.get(childKey('workspace', workspaceId)) ?? []).filter((n) => n.visibility === visibility);
}

export function childrenOf(index: TreeIndex, id: string): TreeNode[] {
  return index.children.get(childKey('page', id)) ?? [];
}

export function siblingsOf(index: TreeIndex, node: TreeNode): TreeNode[] {
  const list = index.children.get(childKey(node.parentType, node.parentId)) ?? [];
  return node.parentType === 'workspace' ? list.filter((n) => n.visibility === node.visibility) : list;
}

/** Ancestors (root first), excluding the node itself. */
export function ancestorsOf(index: TreeIndex, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  let cur = index.byId.get(id);
  const seen = new Set<string>();
  while (cur && cur.parentType === 'page' && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = index.byId.get(cur.parentId);
    if (!parent) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

export function descendantIds(index: TreeIndex, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of childrenOf(index, cur)) {
      if (!out.has(c.id)) {
        out.add(c.id);
        stack.push(c.id);
      }
    }
  }
  return out;
}

export function useTree(workspaceId: string | undefined) {
  const query = useQuery({
    queryKey: qk.tree(workspaceId ?? ''),
    queryFn: () => api.workspaces.tree(workspaceId!),
    enabled: !!workspaceId,
  });
  const index = useMemo(() => buildTreeIndex(query.data?.nodes ?? []), [query.data]);
  return { ...query, index };
}
