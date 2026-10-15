import { createContext, useContext } from 'react';
import type { User, WorkspaceRole, WorkspaceSummary } from '@oriel/shared';

export interface WorkspaceCtx {
  workspace: WorkspaceSummary;
  workspaceId: string;
  role: WorkspaceRole;
  /** Can create and edit content. */
  canEdit: boolean;
  /** Can manage members, invitations and workspace settings. */
  canManage: boolean;
  user: User;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspaceCtx(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspaceCtx outside of the app shell');
  return ctx;
}

export function useOptionalWorkspaceCtx(): WorkspaceCtx | null {
  return useContext(WorkspaceContext);
}
