// View types offered by the « Nouvelle vue » menu and the « Disposition » pickers (tabs and toolbar).
import type { ViewType } from '@oriel/shared';
import { CHART_VIEW_TYPES } from '@oriel/shared';

export const MENU_VIEW_TYPES: ViewType[] = [
  'table',
  'board',
  'list',
  'gallery',
  'calendar',
  'timeline',
  // Fil d'actualité, graphiques, tableau de bord.
  'feed',
  ...CHART_VIEW_TYPES,
  'dashboard',
  // A2 : carte et formulaire.
  'map',
  'form',
];

/** Layouts whose rows are aggregated (charts, dashboard): no row order nor property columns, so
 *  the « Trier » and « Propriétés » menus are hidden. */
export const AGGREGATE_VIEW_TYPES: ViewType[] = [...CHART_VIEW_TYPES, 'dashboard'];
