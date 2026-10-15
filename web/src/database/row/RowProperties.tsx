// <RowProperties>: property list of a database row page (name ⇢ editable value), empty properties
// folded behind « n propriétés masquées », « + Ajouter une propriété ».
import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleAlert, LayoutTemplate, Lock, Plus, X } from 'lucide-react';
import type { Page, PageDetailResponse, PropertyDef, PublicPageResponse, RowsResponse } from '@oriel/shared';
import { api } from '../../lib/api';
import { qk } from '../../lib/queryKeys';
import { DbProvider, useDb, type DbContextValue } from '../context';
import { mergeUsers, useDatabaseQuery, useDbMutations, useMembersQuery, useRelatedData, useRowsQuery, useTemplatesQuery } from '../data';
import { createRowContext, isEmptyValue } from '../logic/values';
import { PropertyIcon } from '../ui/icons';
import { PropertyCell } from '../ui/PropertyCell';
import { AddPropertyPopover, PropertyMenu } from '../ui/PropertyMenu';
import { Btn, IconBtn } from '../ui/primitives';
import { isOutOfPropertyList, RelatedSections } from './RelatedSection';

export interface RowPropertiesRootProps {
  page: Page;
  readOnly?: boolean;
  publicMode?: boolean;
}

const EXPANDED_KEY = 'oriel:row-empty-expanded';

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function RowPropertiesRoot({ page, readOnly = false, publicMode = false }: RowPropertiesRootProps) {
  const databaseId = page.parentType === 'database' ? page.parentId : '';
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback((message: string) => setError(message), []);

  const dbQ = useDatabaseQuery(databaseId, publicMode, !!databaseId);
  // The shell usually has the page detail in cache (it carries the parent schema too).
  const detail = useQuery<PageDetailResponse>({
    queryKey: qk.page(page.id),
    queryFn: () => api.pages.get(page.id),
    enabled: false,
  }).data;
  const publicDetail = publicMode ? qc.getQueryData<PublicPageResponse>(qk.publicPage(page.id)) : undefined;

  const properties: PropertyDef[] | undefined =
    dbQ.data?.schema.properties ?? detail?.parentDatabase?.properties ?? publicDetail?.parentDatabase?.properties;
  const workspaceId = page.workspaceId;
  const canEdit = !readOnly && !publicMode && (dbQ.data?.canEdit ?? detail?.canEdit ?? false);

  const membersQ = useMembersQuery(workspaceId, !publicMode);
  const publicRows = useRowsQuery(databaseId, true, publicMode && !!databaseId);
  const cachedUsers = qc.getQueryData<RowsResponse>(qk.rows(databaseId))?.users;
  const users = useMemo(
    () => mergeUsers(membersQ.data, publicRows.data?.users ?? cachedUsers),
    [membersQ.data, publicRows.data?.users, cachedUsers],
  );
  const { pages: related, resolver, loaded: relatedLoaded } = useRelatedData(properties, publicMode, users);
  const m = useDbMutations(databaseId, reportError);
  const templatesQ = useTemplatesQuery(databaseId, !publicMode && !!databaseId);
  const isTemplate = !!templatesQ.data?.rows.some((t) => t.id === page.id);
  const isDefaultTemplate = templatesQ.data?.defaultTemplateId === page.id;

  const members = useMemo(() => (membersQ.data ?? []).map((mb) => mb.user), [membersQ.data]);
  const relationTitle = useCallback((id: string) => related.get(id)?.title, [related]);
  const ctx = useMemo(
    () => createRowContext(properties ?? [], { users, relationTitle, related: resolver }),
    [properties, users, relationTitle, resolver],
  );

  // Prefer the freshest copy of the row (our optimistic updates patch the page detail cache).
  const cachedPage = detail?.page;
  const row = cachedPage && cachedPage.id === page.id && cachedPage.updatedAt >= page.updatedAt ? cachedPage : page;

  const value = useMemo<DbContextValue | null>(
    () =>
      properties && databaseId
        ? {
            databaseId,
            workspaceId,
            page: dbQ.data?.page ?? null,
            properties,
            members,
            ctx,
            canEdit,
            publicMode,
            m,
            related,
            relatedLoaded,
            reportError,
          }
        : null,
    [properties, databaseId, workspaceId, dbQ.data?.page, members, ctx, canEdit, publicMode, m, related, relatedLoaded, reportError],
  );

  if (!databaseId) return null;
  if (!value) {
    return dbQ.isLoading ? <div className="ordb-rp"><div className="ordb-skeleton is-short" /></div> : null;
  }
  return (
    <DbProvider value={value}>
      <div className="ordb-rp">
        {isTemplate && (
          <div className="ordb-template-banner" role="note">
            <LayoutTemplate size={15} />
            <span>
              Vous modifiez un modèle de « {dbQ.data?.page.title || 'Sans titre'} ». Les nouvelles lignes créées depuis ce modèle reprendront ses
              propriétés et son contenu.
            </span>
            <span className="ordb-option-spacer" />
            {canEdit && (
              <Btn size="sm" variant="outline" onClick={() => void m.setDefaultTemplate(isDefaultTemplate ? null : page.id)}>
                {isDefaultTemplate ? 'Modèle par défaut ✓' : 'Utiliser par défaut'}
              </Btn>
            )}
          </div>
        )}
        {error && (
          <div className="ordb-error" role="alert">
            <CircleAlert size={15} />
            <span>Modification impossible : {error}</span>
            <IconBtn label="Fermer" onClick={() => setError(null)}>
              <X size={14} />
            </IconBtn>
          </div>
        )}
        <RowPropertyList row={row} />
        <RelatedSections row={row} />
      </div>
    </DbProvider>
  );
}

function RowPropertyList({ row }: { row: Page }) {
  const { properties, ctx, canEdit } = useDb();
  const [editing, setEditing] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(readExpanded);
  // Properties that stay visible although empty (just created / being edited).
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());

  // Relations shown as a section, or hidden, stay out of the list (D31).
  const list = properties.filter((p) => p.type !== 'title' && !isOutOfPropertyList(p));
  const isHidden = (p: PropertyDef) => isEmptyValue(row, p, ctx) && !pinned.has(p.id) && editing !== p.id;
  const shown = expanded ? list : list.filter((p) => !isHidden(p));
  const hiddenCount = list.filter(isHidden).length;

  const toggleExpanded = () => {
    setExpanded((e) => {
      try {
        window.localStorage.setItem(EXPANDED_KEY, e ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !e;
    });
  };

  return (
    <div className="ordb-rp-list">
      {shown.map((p) => (
        <div key={p.id} className="ordb-rp-row">
          <PropertyMenu
            prop={p}
            opened={menuFor === p.id}
            onOpenedChange={(o) => setMenuFor(o ? p.id : null)}
            sampleRow={row}
          >
            <button type="button" className="ordb-rp-name" onClick={() => setMenuFor(menuFor === p.id ? null : p.id)} title={p.name}>
              <PropertyIcon type={p.type} />
              <span className="ordb-ellipsis">{p.name}</span>
              {p.readOnly && <Lock size={11} className="ordb-rp-lock" aria-label="Lecture seule" />}
            </button>
          </PropertyMenu>
          <div className="ordb-rp-value">
            <PropertyCell
              row={row}
              prop={p}
              variant="panel"
              wrap
              editing={editing === p.id}
              onEditingChange={(on) => {
                setEditing(on ? p.id : null);
                if (on) setPinned((s) => new Set(s).add(p.id));
              }}
            />
          </div>
        </div>
      ))}
      {hiddenCount > 0 || (expanded && list.some(isHidden)) ? (
        <button type="button" className="ordb-rp-toggle" onClick={toggleExpanded}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded
            ? 'Masquer les propriétés vides'
            : `${hiddenCount} propriété${hiddenCount > 1 ? 's' : ''} masquée${hiddenCount > 1 ? 's' : ''}`}
        </button>
      ) : null}
      {canEdit && (
        <AddPropertyPopover
          onCreated={(id) => {
            setPinned((s) => new Set(s).add(id));
            setTimeout(() => setEditing(id), 60);
          }}
        >
          <button type="button" className="ordb-rp-add">
            <Plus size={14} /> Ajouter une propriété
          </button>
        </AddPropertyPopover>
      )}
    </div>
  );
}
