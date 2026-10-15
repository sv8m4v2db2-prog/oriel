// Database-level context shared by every component of the module (views, cells, menus, row panel).
import { createContext, useContext } from 'react';
import type { Page, PropertyDef, PublicUser } from '@oriel/shared';
import type { DbMutations, RelatedPage } from './data';
import type { RowContext } from './logic/values';

export interface DbContextValue {
  databaseId: string;
  workspaceId: string;
  /** The database page (title, icon, cover); null when only the schema is known. */
  page: Page | null;
  properties: PropertyDef[];
  /** Workspace members (person picker). */
  members: PublicUser[];
  ctx: RowContext;
  /** Content edits allowed (rows, schema, views are persisted). */
  canEdit: boolean;
  publicMode: boolean;
  m: DbMutations;
  related: Map<string, RelatedPage>;
  /** Related databases whose rows are loaded (see RelatedData.loaded). */
  relatedLoaded?: ReadonlySet<string>;
  reportError: (message: string) => void;
  /** Linked database block: id of the block (its views are its own). */
  linkId?: string;
  /** I1: page whose content shows this database (inline or linked block): the « cette page » of filters and relations. */
  hostPageId?: string;
}

const DbContext = createContext<DbContextValue | null>(null);

export const DbProvider = DbContext.Provider;

export function useDb(): DbContextValue {
  const v = useContext(DbContext);
  if (!v) throw new Error('useDb() must be used inside <DbProvider>');
  return v;
}
