// Navigation module: people profiles open from an avatar or a mention.
import { appNavigate } from '../../lib/util';

export const profilePath = (workspaceId: string, userId: string) => `/w/${workspaceId}/people/${encodeURIComponent(userId)}`;

export function openProfile(workspaceId: string, userId: string) {
  appNavigate(profilePath(workspaceId, userId));
}
