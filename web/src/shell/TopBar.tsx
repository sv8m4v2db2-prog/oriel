import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Popover, Switch, Tooltip } from '@mantine/core';
import {
  ALargeSmall,
  ArrowUpRight,
  Check,
  ChevronsRight,
  ClockArrowLeft,
  CloudOff,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileUp,
  FolderInput,
  Globe,
  LayoutTemplate,
  Link as LinkIcon,
  LoaderCircle,
  Lock,
  Menu as MenuIcon,
  MoveHorizontal,
  Printer,
  Star,
  Trash,
  Users,
} from 'lucide-react';
import type { Crumb, PageDetailResponse, PageFont } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { copyPageLink, duplicatePage, importMarkdown, setFavorite, trashPage, updatePage } from '../lib/pages';
import { useStore } from '../lib/store';
import { useTree } from '../lib/tree';
import { historyStore, toast, toggleSidebar } from '../lib/ui';
import { appNavigate, copyToClipboard, pagePath, pageTitle, sharePath } from '../lib/util';
import { usePagePeers } from '../lib/collab';
import { editorsVersion, exportPage, getEditor } from '../editor/registry';
import { Avatar, PageIcon } from '../components/common';
import { openContextMenu } from '../components/ContextMenu';
import { setPageTemplate } from '../editor/templates';
import { printPage } from '../page/print';
import { PageReadingControls } from '../reading';
import { PageTopBarExtras } from '../features/registry';
import { openMovePicker } from './PageActionsMenu';
import { useSaveStatus } from './status';
import { useWorkspaceCtx } from './WorkspaceContext';
import { PageStatsButton } from './nav/PageStats';
import { openConvertToTeamspace } from './nav/access';
import { openProfile } from './nav/profile';

export function TopBar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="topbar">
      <Tooltip label="Afficher la barre latérale" openDelay={400}>
        <button type="button" className="icon-btn topbar__expand" aria-label="Afficher la barre latérale" onClick={toggleSidebar}>
          <ChevronsRight size={17} className="topbar__expand-desktop" />
          <MenuIcon size={17} className="topbar__expand-mobile" />
        </button>
      </Tooltip>
      <div className="topbar__left">{children}</div>
      {right && <div className="topbar__right">{right}</div>}
    </header>
  );
}

function crumbMenu(e: React.MouseEvent, workspaceId: string, c: Crumb) {
  const path = pagePath(workspaceId, c.id);
  openContextMenu(e, [
    { label: 'Ouvrir', icon: <ArrowUpRight size={15} />, onClick: () => appNavigate(path) },
    { label: 'Ouvrir dans un nouvel onglet', icon: <ExternalLink size={15} />, onClick: () => window.open(path, '_blank', 'noopener') },
    { label: 'Copier le lien', icon: <LinkIcon size={15} />, onClick: () => void copyPageLink(workspaceId, c.id) },
  ]);
}

export function Breadcrumbs({ workspaceId, ancestors, current }: { workspaceId: string; ancestors: Crumb[]; current: Crumb }) {
  let items: Array<Crumb | 'ellipsis'> = [...ancestors, current];
  if (items.length > 4) items = [items[0]!, 'ellipsis', ...items.slice(-2)];
  return (
    <nav className="breadcrumbs" aria-label="Fil d’Ariane">
      {items.map((c, i) => (
        <Fragment key={c === 'ellipsis' ? 'ellipsis' : c.id}>
          {i > 0 && <span className="breadcrumbs__sep">/</span>}
          {c === 'ellipsis' ? (
            <span className="breadcrumbs__ellipsis">…</span>
          ) : c.id === current.id ? (
            <span className="breadcrumbs__item is-current" onContextMenu={(e) => crumbMenu(e, workspaceId, c)}>
              <PageIcon icon={c.icon} kind={c.kind} size={15} />
              <span>{pageTitle(c.title)}</span>
            </span>
          ) : (
            <Link className="breadcrumbs__item" to={pagePath(workspaceId, c.id)} onContextMenu={(e) => crumbMenu(e, workspaceId, c)}>
              <PageIcon icon={c.icon} kind={c.kind} size={15} />
              <span>{pageTitle(c.title)}</span>
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

export function PresenceAvatars({ pageId }: { pageId: string }) {
  const peers = usePagePeers(pageId);
  const { workspaceId } = useWorkspaceCtx();
  if (peers.length === 0) return null;
  const shown = peers.slice(0, 4);
  return (
    <div className="presence" aria-label="Personnes présentes">
      {shown.map((p) => (
        // Navigation module: an avatar opens the person's profile.
        <button key={p.clientId} type="button" className="presence__person" aria-label={`Profil de ${p.name}`} onClick={() => p.id && openProfile(workspaceId, p.id)}>
          <Avatar name={p.name} id={p.id} url={p.avatarUrl} color={p.color} size={24} ring title={`${p.name} est sur la page`} />
        </button>
      ))}
      {peers.length > shown.length && <span className="presence__more">+{peers.length - shown.length}</span>}
    </div>
  );
}

export function SaveIndicator() {
  const status = useSaveStatus();
  return (
    <span className={`save-indicator save-indicator--${status}`} role="status">
      {status === 'offline' ? (
        <>
          <CloudOff size={14} /> Hors ligne
        </>
      ) : status === 'saving' ? (
        <>
          <LoaderCircle size={13} className="spin" /> Enregistrement…
        </>
      ) : (
        <>
          <Check size={14} /> Enregistré
        </>
      )}
    </span>
  );
}

function SharePopover({ detail }: { detail: PageDetailResponse }) {
  const { workspaceId } = useWorkspaceCtx();
  const page = detail.page;
  const [busy, setBusy] = useState(false);
  const publicUrl = `${location.origin}${sharePath(page.id)}`;

  const togglePublish = async (isPublic: boolean) => {
    setBusy(true);
    try {
      const updated = await api.pages.publish(page.id, isPublic);
      queryClient.setQueryData<PageDetailResponse>(qk.page(page.id), (old) =>
        old ? { ...old, page: updated, publiclyVisible: isPublic || (old.publiclyVisible && !old.page.isPublic) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: qk.page(page.id) });
      toast.success(isPublic ? 'Page publiée sur le web' : 'Publication arrêtée');
    } catch (e) {
      toast.error(errorMessage(e, 'Impossible de modifier la publication.'));
    } finally {
      setBusy(false);
    }
  };

  const copyPublic = async () => {
    if (await copyToClipboard(publicUrl)) toast.success('Lien public copié');
  };

  return (
    <Popover width={360} position="bottom-end" shadow="md" withinPortal>
      <Popover.Target>
        <button type="button" className={`btn btn--ghost btn--sm${detail.publiclyVisible ? ' is-published' : ''}`}>
          {detail.publiclyVisible && <Globe size={14} />}
          Partager
        </button>
      </Popover.Target>
      <Popover.Dropdown className="popover-panel">
        <div className="share">
          <div className="share__section">
            <div className="share__title">Lien de la page</div>
            <p className="share__text">Les membres de l’espace ayant accès à cette page pourront l’ouvrir.</p>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copyPageLink(workspaceId, page.id)}>
              <LinkIcon size={14} /> Copier le lien
            </button>
          </div>
          <div className="share__section">
            <Switch
              checked={page.isPublic}
              disabled={!detail.canEdit || busy}
              onChange={(e) => void togglePublish(e.currentTarget.checked)}
              label="Publier sur le web"
              description="Toute personne disposant du lien pourra lire cette page et ses sous-pages, sans compte."
            />
            {page.isPublic && (
              <div className="share__link">
                <input className="input input--sm" readOnly value={publicUrl} onFocus={(e) => e.currentTarget.select()} />
                <Tooltip label="Copier">
                  <button type="button" className="icon-btn" aria-label="Copier le lien public" onClick={() => void copyPublic()}>
                    <Copy size={15} />
                  </button>
                </Tooltip>
                <Tooltip label="Ouvrir">
                  <a className="icon-btn" href={publicUrl} target="_blank" rel="noreferrer" aria-label="Ouvrir la page publique">
                    <ExternalLink size={15} />
                  </a>
                </Tooltip>
              </div>
            )}
            {!page.isPublic && detail.publiclyVisible && (
              <p className="share__info">
                <Globe size={13} /> Déjà visible sur le web, car une page parente est publiée.
              </p>
            )}
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

function PageMoreMenu({ detail, compact }: { detail: PageDetailResponse; compact?: boolean }) {
  const { workspaceId, canManage } = useWorkspaceCtx();
  const tree = useTree(workspaceId);
  const page = detail.page;
  useStore(editorsVersion);
  const hasEditor = !!getEditor(page.id);
  const canEdit = detail.canEdit;
  const isRow = page.parentType === 'database';
  const isPage = page.kind === 'page';
  const isTemplate = !!tree.index.byId.get(page.id)?.isTemplate;
  const font: PageFont = page.format.font ?? 'default';
  const setFormat = (format: Parameters<typeof updatePage>[2]['format']) =>
    void updatePage(workspaceId, page.id, { format }).catch(() => undefined);

  const doExport = (format: 'md' | 'html' | 'png') => {
    if (!exportPage(page.id, page.title, page.icon, format)) toast.error('Le contenu n’est pas encore chargé.');
  };

  return (
    <Menu position="bottom-end" width={250} shadow="md" withinPortal>
      <Menu.Target>
        <button type="button" className="icon-btn" aria-label="Plus d’actions">
          <Ellipsis size={18} />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        {isPage && (
          <>
            <Menu.Label>Police</Menu.Label>
            <div className="font-picker" role="radiogroup" aria-label="Police">
              {(
                [
                  ['default', 'Par défaut', 'Aa'],
                  ['serif', 'Serif', 'Aa'],
                  ['mono', 'Mono', 'Aa'],
                ] as const
              ).map(([value, label, sample]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={font === value}
                  disabled={!canEdit}
                  className={`font-picker__item font-picker__item--${value}${font === value ? ' is-active' : ''}`}
                  onClick={() => setFormat({ font: value === 'default' ? (null as never) : value })}
                >
                  <span className="font-picker__sample">{sample}</span>
                  <span className="font-picker__label">{label}</span>
                </button>
              ))}
            </div>
            <Menu.Divider />
          </>
        )}
        {isPage && (
          <Menu.Item
            leftSection={<ALargeSmall size={15} />}
            disabled={!canEdit}
            closeMenuOnClick={false}
            rightSection={<Switch size="xs" checked={!!page.format.smallText} readOnly tabIndex={-1} />}
            onClick={() => setFormat({ smallText: !page.format.smallText })}
          >
            Petit texte
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<MoveHorizontal size={15} />}
          disabled={!canEdit}
          closeMenuOnClick={false}
          rightSection={<Switch size="xs" checked={!!page.format.fullWidth} readOnly tabIndex={-1} />}
          onClick={() => void updatePage(workspaceId, page.id, { format: { fullWidth: !page.format.fullWidth } }).catch(() => undefined)}
        >
          Pleine largeur
        </Menu.Item>
        {isPage && (
          <Menu.Item
            leftSection={<Lock size={15} />}
            disabled={!canEdit}
            closeMenuOnClick={false}
            rightSection={<Switch size="xs" checked={!!page.format.locked} readOnly tabIndex={-1} />}
            onClick={() => setFormat({ locked: page.format.locked ? (null as never) : true })}
          >
            Verrouiller la page
          </Menu.Item>
        )}
        <Menu.Divider />
        <Menu.Item leftSection={<LinkIcon size={15} />} onClick={() => void copyPageLink(workspaceId, page.id)}>
          Copier le lien
        </Menu.Item>
        <Menu.Sub>
          <Menu.Sub.Target>
            <Menu.Sub.Item leftSection={<Download size={15} />} disabled={!hasEditor && isPage}>
              Exporter
            </Menu.Sub.Item>
          </Menu.Sub.Target>
          <Menu.Sub.Dropdown>
            <Menu.Item onClick={() => doExport('md')}>Markdown (.md)</Menu.Item>
            <Menu.Item onClick={() => doExport('html')}>HTML autonome (.html)</Menu.Item>
            <Menu.Item onClick={() => doExport('png')}>Image (.png)</Menu.Item>
            <Menu.Item leftSection={<Printer size={14} />} onClick={() => printPage(compact ? 'peek' : 'page')}>
              PDF (impression)
            </Menu.Item>
          </Menu.Sub.Dropdown>
        </Menu.Sub>
        {canEdit && page.kind === 'page' && (
          <Menu.Item
            leftSection={<FileUp size={15} />}
            onClick={() => void importMarkdown({ workspaceId, parentType: 'page', parentId: page.id })}
          >
            Importer Markdown
          </Menu.Item>
        )}
        {page.kind === 'page' && (
          <Menu.Item leftSection={<ClockArrowLeft size={15} />} onClick={() => historyStore.set({ pageId: page.id })}>
            Historique des versions
          </Menu.Item>
        )}
        {canEdit && (
          <>
            <Menu.Divider />
            <Menu.Item leftSection={<Copy size={15} />} onClick={() => void duplicatePage(workspaceId, page.id)}>
              Dupliquer
            </Menu.Item>
            {isPage && !isRow && (
              <Menu.Item leftSection={<LayoutTemplate size={15} />} onClick={() => void setPageTemplate(workspaceId, page.id, !isTemplate)}>
                {isTemplate ? 'Ne plus utiliser comme modèle' : 'Utiliser comme modèle'}
              </Menu.Item>
            )}
            {!isRow && (
              <Menu.Item leftSection={<FolderInput size={15} />} onClick={() => openMovePicker(workspaceId, tree.index, page.id)}>
                Déplacer vers…
              </Menu.Item>
            )}
            {canManage && isPage && !isRow && parentIsNotTeamspace(tree.index.byId.get(page.id)) && (
              <Menu.Item
                leftSection={<Users size={15} />}
                onClick={() =>
                  openConvertToTeamspace({ workspaceId, pageId: page.id, title: page.title, initial: page.visibility === 'workspace' ? 'open' : 'private' })
                }
              >
                Transformer en espace d’équipe…
              </Menu.Item>
            )}
            <Menu.Item color="red" leftSection={<Trash size={15} />} onClick={() => void trashPage(workspaceId, page.id)}>
              Supprimer
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** Top bar of a page (full view or peek). */
export function PageTopBar({ detail, compact }: { detail: PageDetailResponse; compact?: boolean }) {
  const { workspaceId } = useWorkspaceCtx();
  const page = detail.page;
  const current: Crumb = { id: page.id, title: page.title, icon: page.icon, kind: page.kind };
  const unlock = () => void updatePage(workspaceId, page.id, { format: { locked: null as never } }).catch(() => undefined);
  const right = (
    <>
      {page.format.locked && page.kind === 'page' && (
        <Tooltip label={detail.canEdit ? 'Page verrouillée — cliquer pour déverrouiller' : 'Page verrouillée'} openDelay={300}>
          <button
            type="button"
            className="btn btn--ghost btn--sm topbar__locked"
            aria-label="Page verrouillée"
            disabled={!detail.canEdit}
            onClick={unlock}
          >
            <Lock size={14} /> Verrouillée
          </button>
        </Tooltip>
      )}
      <PageTopBarExtras pageId={page.id} compact={compact} />
      {page.kind === 'page' && <SaveIndicator />}
      {!page.trashedAt && <PageStatsButton pageId={page.id} />}
      <PresenceAvatars pageId={page.id} />
      {!page.trashedAt && <SharePopover detail={detail} />}
      <Tooltip label={detail.isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} openDelay={400}>
        <button
          type="button"
          className={`icon-btn${detail.isFavorite ? ' is-favorite' : ''}`}
          aria-pressed={detail.isFavorite}
          aria-label="Favori"
          onClick={() => void setFavorite(workspaceId, page.id, !detail.isFavorite)}
        >
          <Star size={17} fill={detail.isFavorite ? 'currentColor' : 'none'} />
        </button>
      </Tooltip>
      <PageReadingControls detail={detail} compact={compact} />
      <PageMoreMenu detail={detail} compact={compact} />
    </>
  );
  if (compact) return <div className="peek__actions">{right}</div>;
  return (
    <TopBar right={right}>
      <Breadcrumbs workspaceId={workspaceId} ancestors={detail.ancestors} current={current} />
    </TopBar>
  );
}

/** Navigation module: a teamspace root (or a template) cannot be turned into a teamspace again. */
function parentIsNotTeamspace(node: { isTeamspace?: boolean; isTemplate?: boolean } | undefined): boolean {
  return !node?.isTeamspace && !node?.isTemplate;
}
