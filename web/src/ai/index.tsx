// AI module — « Brief du jour ». Public interface used by features/registry.tsx.
/** Route element for /w/:workspaceId/brief */
export { BriefPage } from './BriefPage';
/** Sidebar entry (rendered under "Accueil"); hidden for members while the feature is not configured. */
export { BriefSidebarLink } from './BriefSidebarLink';
/** Settings › IA tab content. */
export { AiSettings } from './AiSettings';
/** Card rendered on the Home page under the action buttons; nothing when the feature is disabled. */
export { HomeBriefCard } from './HomeBriefCard';
