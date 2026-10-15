// A page: header (icon, cover, title), row properties or database, block editor, trash banner.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ImagePlus, Trash, FaceSlightlySmiling, RotateCcw } from 'lucide-react';
import { LIMITS, type Cover, type Page, type PageDetailResponse, type TreeResponse } from '@oriel/shared';
import { DatabaseView, RowProperties } from '../database';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { consumeTitleFocus, destroyPage, restorePage, updatePage } from '../lib/pages';
import { confirmDialog } from '../lib/ui';
import { formatWhen, pagePath, pageTitle } from '../lib/util';
import { EmojiPickerPopover, loadEmojiData, randomEmoji } from '../components/EmojiPicker';
import { ErrorBoundary, PageIcon } from '../components/common';
import { PageEditor } from '../editor/PageEditor';
import { focusEditorStart } from '../editor/registry';
import { PageToc } from '../reading';
import { PageOrganizeBar } from '../organize/PageOrganizeBar';
import { PageCover, randomCover } from './Cover';
import './print';
import './page.css';

// --- Title ----------------------------------------------------------------------------

function patchTitleLocally(workspaceId: string | null, pageId: string, title: string) {
  queryClient.setQueryData<PageDetailResponse>(qk.page(pageId), (old) => (old ? { ...old, page: { ...old.page, title } } : old));
  if (workspaceId) {
    queryClient.setQueryData<TreeResponse>(qk.tree(workspaceId), (old) =>
      old ? { nodes: old.nodes.map((n) => (n.id === pageId ? { ...n, title } : n)) } : old,
    );
  }
}

export function TitleInput({
  page,
  workspaceId,
  canEdit,
  onEnter,
}: {
  page: Page;
  workspaceId: string | null;
  canEdit: boolean;
  onEnter: () => void;
}) {
  const [value, setValue] = useState(page.title);
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!focused.current && pending.current === null) setValue(page.title);
  }, [page.title]);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(resize, [value, resize]);
  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v !== null) void updatePage(workspaceId, page.id, { title: v }).catch(() => undefined);
  }, [workspaceId, page.id]);

  useEffect(() => () => flush(), [flush]);

  useEffect(() => {
    if (canEdit && consumeTitleFocus(page.id)) {
      const t = setTimeout(() => ref.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [page.id, canEdit]);

  return (
    <textarea
      ref={ref}
      className="page-title"
      rows={1}
      value={value}
      placeholder="Sans titre"
      readOnly={!canEdit}
      maxLength={LIMITS.titleLength}
      aria-label="Titre de la page"
      spellCheck
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, ' ');
        setValue(v);
        pending.current = v;
        patchTitleLocally(workspaceId, page.id, v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 500);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          flush();
          onEnter();
        }
      }}
    />
  );
}

// --- Header ---------------------------------------------------------------------------

export function PageHeader({
  page,
  workspaceId,
  canEdit,
  onTitleEnter,
}: {
  page: Page;
  workspaceId: string | null;
  canEdit: boolean;
  onTitleEnter: () => void;
}) {
  const [iconOpen, setIconOpen] = useState(false);
  const update = (body: Parameters<typeof updatePage>[2]) => void updatePage(workspaceId, page.id, body).catch(() => undefined);

  const addIcon = async () => {
    const data = await loadEmojiData();
    update({ icon: randomEmoji(data) });
  };

  return (
    <div className={`page-header${page.cover ? ' has-cover' : ''}${page.icon ? ' has-icon' : ''}`}>
      {page.cover && (
        <PageCover
          cover={page.cover}
          position={page.format.coverPosition ?? 50}
          canEdit={canEdit}
          workspaceId={workspaceId}
          onChange={(cover: Cover | null) => update({ cover })}
          onPositionChange={(coverPosition) => update({ format: { coverPosition } })}
        />
      )}
      <div className="page-header__inner page-width">
        {page.icon && (
          <EmojiPickerPopover
            opened={iconOpen}
            onClose={() => setIconOpen(false)}
            onSelect={(icon) => update({ icon })}
            onRemove={() => update({ icon: null })}
          >
            <button
              type="button"
              className="page-header__icon"
              aria-label="Changer l’icône"
              disabled={!canEdit}
              onClick={() => canEdit && setIconOpen((o) => !o)}
            >
              {page.icon}
            </button>
          </EmojiPickerPopover>
        )}
        {canEdit && (
          <div className="page-header__controls">
            {!page.icon && (
              <button type="button" className="ghost-control" onClick={() => void addIcon()}>
                <FaceSlightlySmiling size={15} /> Ajouter une icône
              </button>
            )}
            {!page.cover && (
              <button type="button" className="ghost-control" onClick={() => update({ cover: randomCover() })}>
                <ImagePlus size={15} /> Ajouter une couverture
              </button>
            )}
          </div>
        )}
        <TitleInput page={page} workspaceId={workspaceId} canEdit={canEdit} onEnter={onTitleEnter} />
      </div>
    </div>
  );
}

// --- Trash banner -------------------------------------------------------------------------

function TrashBanner({ page, workspaceId, canEdit }: { page: Page; workspaceId: string; canEdit: boolean }) {
  const navigate = useNavigate();
  const destroy = async () => {
    const ok = await confirmDialog({
      title: 'Supprimer définitivement ?',
      message: 'La page et ses sous-pages seront supprimées pour toujours. Cette action est irréversible.',
      confirmLabel: 'Supprimer définitivement',
      danger: true,
    });
    if (!ok) return;
    await destroyPage(workspaceId, page.id);
    navigate(`/w/${workspaceId}`, { replace: true });
  };
  return (
    <div className="trash-banner" role="alert">
      <span>
        <Trash size={15} /> Cette page est dans la corbeille
        {page.trashedAt ? ` (supprimée ${formatWhen(page.trashedAt)})` : ''}.
      </span>
      {canEdit && (
        <span className="trash-banner__actions">
          <button type="button" className="btn btn--sm btn--on-danger" onClick={() => void restorePage(workspaceId, page.id)}>
            <RotateCcw size={14} /> Restaurer
          </button>
          <button type="button" className="btn btn--sm btn--on-danger-outline" onClick={() => void destroy()}>
            Supprimer définitivement
          </button>
        </span>
      )}
    </div>
  );
}

// --- Backlinks ("Mentionnée dans") ------------------------------------------------------------

function Backlinks({ pageId, workspaceId }: { pageId: string; workspaceId: string }) {
  const [open, setOpen] = useState(true);
  const query = useQuery({ queryKey: qk.backlinks(pageId), queryFn: () => api.pages.backlinks(pageId), staleTime: 30_000 });
  const pages = query.data?.pages ?? [];
  if (pages.length === 0) return null;
  return (
    <section className="page-width page-backlinks" aria-label="Pages qui mentionnent cette page">
      <button type="button" className={`page-backlinks__toggle${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={14} />
        Mentionnée dans {pages.length} page{pages.length > 1 ? 's' : ''}
      </button>
      {open && (
        <ul className="page-backlinks__list">
          {pages.map((c) => (
            <li key={c.id}>
              <Link className="page-backlinks__item" to={pagePath(workspaceId, c.id)}>
                <PageIcon icon={c.icon} kind={c.kind} size={16} />
                <span className="page-backlinks__title">{pageTitle(c.title)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Page ---------------------------------------------------------------------------------

export function PageView({ detail, workspaceId, variant }: { detail: PageDetailResponse; workspaceId: string; variant: 'full' | 'peek' }) {
  const page = detail.page;
  const trashed = !!page.trashedAt;
  const isDatabase = page.kind === 'database';
  // "Verrouiller la page": content is read-only for everyone until an editor unlocks it (top bar).
  const locked = !isDatabase && !!page.format.locked;
  const canEdit = detail.canEdit && !trashed && !locked;
  const isRow = page.parentType === 'database';
  const fullWidth = isDatabase || !!page.format.fullWidth;
  const font = page.format.font && page.format.font !== 'default' ? ` font-${page.format.font}` : '';

  return (
    <div
      data-page-id={page.id}
      className={`page page--${variant}${fullWidth ? ' is-full-width' : ''}${page.format.smallText ? ' is-small-text' : ''}${font}${locked ? ' is-locked' : ''}${page.format.hideComments ? ' is-hide-comments' : ''}`}
    >
      {!isDatabase && <PageToc pageId={page.id} setting={page.format.toc} variant={variant} />}
      {trashed && <TrashBanner page={page} workspaceId={workspaceId} canEdit={detail.canEdit} />}
      <PageHeader page={page} workspaceId={workspaceId} canEdit={canEdit} onTitleEnter={() => focusEditorStart(page.id)} />
      {!trashed && (
        <ErrorBoundary resetKey={page.id}>
          <PageOrganizeBar pageId={page.id} workspaceId={workspaceId} canEdit={detail.canEdit} />
        </ErrorBoundary>
      )}
      {isRow && !page.format.hideProperties && (
        <div className="page-width page-row-props">
          <ErrorBoundary resetKey={page.id}>
            <RowProperties page={page} readOnly={!canEdit} />
          </ErrorBoundary>
        </div>
      )}
      {isDatabase ? (
        <div className="page-database">
          <ErrorBoundary resetKey={page.id}>
            <DatabaseView databaseId={page.id} readOnly={!canEdit} />
          </ErrorBoundary>
        </div>
      ) : (
        <div className="page-width page-body">
          {isRow && <div className="page-row-divider" />}
          <ErrorBoundary resetKey={page.id}>
            <PageEditor pageId={page.id} workspaceId={workspaceId} canEdit={canEdit} mode="app" seed={page.format.seed} />
          </ErrorBoundary>
        </div>
      )}
      {!trashed && !isDatabase && !page.format.hideBacklinks && <Backlinks pageId={page.id} workspaceId={workspaceId} />}
    </div>
  );
}
