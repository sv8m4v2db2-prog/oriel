// Canvas page (H1), loaded lazily by the page route and the public page: page title, then the
// editor on the page's collaborative document once it may be shown (same gate as the page editor:
// never an editable empty document that the server has not described yet).
import { useEffect, useMemo, useState } from 'react';
import { Lock, WifiOff } from 'lucide-react';
import type { Page } from '@oriel/shared';
import { collabEditorGate, useCollab, useCollabState } from '../lib/collab';
import { useSession } from '../lib/session';
import { updatePage } from '../lib/pages';
import { pageTitle } from '../lib/util';
import { EmptyState, PageSkeleton } from '../components/common';
import { CanvasStore } from './store';
import { CanvasEditor } from './CanvasEditor';
import './canvas.css';

export interface CanvasPageProps {
  page: Page;
  workspaceId: string | null;
  canEdit: boolean;
  mode: 'app' | 'public';
}

function TitleBar({ page, workspaceId, canEdit }: { page: Page; workspaceId: string | null; canEdit: boolean }) {
  const [value, setValue] = useState(page.title);
  useEffect(() => setValue(page.title), [page.title]);
  const save = () => {
    const title = value.trim();
    if (title !== page.title && canEdit) void updatePage(workspaceId, page.id, { title }).catch(() => setValue(page.title));
  };
  return (
    <div className="or-cv-header">
      <span className="or-cv-header-icon" aria-hidden>
        {page.icon ?? '🎨'}
      </span>
      {canEdit ? (
        <input
          className="or-cv-header-title"
          value={value}
          placeholder="Sans titre"
          aria-label="Titre du canevas"
          maxLength={500}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <h1 className="or-cv-header-title is-static">{pageTitle(page.title)}</h1>
      )}
    </div>
  );
}

export default function CanvasPage({ page, workspaceId, canEdit, mode }: CanvasPageProps) {
  const entry = useCollab(page.id, mode === 'app');
  const state = useCollabState(entry);
  const session = useSession();
  const user = mode === 'app' ? (session.data?.user ?? null) : null;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), 4000);
    return () => clearTimeout(t);
  }, [page.id]);
  const store = useMemo(() => (entry ? new CanvasStore(entry.doc) : null), [entry]);
  useEffect(() => () => store?.destroy(), [store]);

  let body: React.ReactNode;
  if (!entry || !state || !store) body = <PageSkeleton />;
  else {
    const gate = collabEditorGate(state, { isEmpty: store.map.size === 0, waited });
    if (gate === 'denied') {
      body = (
        <div className="center-content">
          <EmptyState icon={<Lock size={24} />} title="Canevas inaccessible">
            Vous n’avez pas accès à ce contenu.
          </EmptyState>
        </div>
      );
    } else if (gate === 'unavailable') {
      body = (
        <div className="center-content">
          <EmptyState icon={<WifiOff size={24} />} title="Hors ligne">
            Ce canevas n’a pas encore été chargé sur cet appareil.
          </EmptyState>
        </div>
      );
    } else if (gate === 'loading') body = <PageSkeleton />;
    else {
      const readOnly = mode !== 'app' || !canEdit || state.readOnly || page.trashedAt !== null;
      body = (
        <CanvasEditor
          store={store}
          awareness={entry.provider.awareness ?? null}
          pageId={page.id}
          workspaceId={workspaceId}
          readOnly={readOnly}
          publicMode={mode === 'public'}
          userId={user?.id ?? null}
          userName={user?.name ?? ''}
        />
      );
    }
  }
  return (
    <div className="or-cv-page">
      <TitleBar page={page} workspaceId={workspaceId} canEdit={canEdit && mode === 'app' && page.trashedAt === null} />
      <div className="or-cv-stage">{body}</div>
    </div>
  );
}
