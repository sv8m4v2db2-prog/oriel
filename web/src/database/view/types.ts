import type { Page, PropertyDef, PropertyValue, TemplateRecurrenceInfo, View, ViewConfig } from '@oriel/shared';
import type { ValueKind } from '../logic/values';

export interface NewRowRequest {
  title?: string;
  properties?: Record<string, PropertyValue>;
  /** Position hint: undefined = last, null = first, id = after that row. */
  after?: string | null;
  /** Row template to use (undefined = the default template, null = blank row). */
  templateId?: string | null;
}

/** Everything a layout (table, board…) needs about the active view. */
export interface ViewState {
  view: View;
  config: ViewConfig;
  setConfig: (patch: Partial<ViewConfig>) => void;
  /** Rows after filters / search / sorts (or manual order). */
  rows: Page[];
  /** Number of rows in the database (unfiltered). */
  totalRows: number;
  /** Every row of the database (unfiltered), e.g. timeline dependencies. */
  allRows: Page[];
  /** All properties in view order. */
  orderedProps: PropertyDef[];
  /** Visible properties in view order (title included). */
  visibleProps: PropertyDef[];
  /** Kind of each property (formulas resolved from their results). */
  kinds: Map<string, ValueKind>;
  /** No sort rule: manual (drag) order applies. */
  manualOrder: boolean;
  /** Creates a row that satisfies the active filters; returns its id (null when not allowed). */
  createRow: (req?: NewRowRequest, opts?: { open?: boolean }) => string | null;
  /** Opens the filter menu with a new rule on this property. */
  filterOnProperty: (propertyId: string) => void;
  /** Row id whose title should be edited right away (just created in a table). */
  editTitleOf: string | null;
  clearEditTitle: () => void;
  /** Row templates of the database (hidden from views) and the default one of this view (I1: the view's own, else the database's). */
  templates: Page[];
  defaultTemplateId: string | null;
  /** I1: default template of the database, and recurring templates. */
  databaseDefaultTemplateId: string | null;
  recurrences: TemplateRecurrenceInfo[];
  /** I1: places a row after `after` (null = first) in this view's manual order only. */
  moveRow: (id: string, after: string | null) => void;
}
