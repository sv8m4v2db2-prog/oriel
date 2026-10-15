// Right-hand information panel (SPEC §13.6): properties, backlinks, recent activity, open comments.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Pin, PinOff, X } from 'lucide-react';
import type { PageActivityKind } from '@oriel/shared';
import { RowProperties } from '../database';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { formatRelative, pagePath, pageTitle } from '../lib/util';
import { PageIcon } from '../components/common';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { readingApi, readingKeys } from './api';
import { inlineText } from './outlineLogic';
import { infoPanelStore } from './store';

const ACTIVITY_LABEL: Record<PageActivityKind, string> = {
  created: 'a créé la page',
  edited: 'a modifié la page',
  version: 'a enregistré une version',
  comment: 'a commenté',
  resolved: 'a résolu une discussion',
};

export function InfoPanel({ pageId }: { pageId: string | undefined }) {
  const { open, docked } = useStore(infoPanelStore);
  if (!open || !pageId) return null;
  return <InfoPanelInner key={pageId} pageId={pageId} docked={docked} />;
}

function InfoPanelInner({ pageId, docked }: { pageId: string; docked: boolean }) {
  const { workspaceId } = useWorkspaceCtx();
  const detail = useQuery({ queryKey: qk.page(pageId), queryFn: () => api.pages.get(pageId) });
  const page = detail.data?.page;
  const version = page?.version ?? 0;
  const backlinks = useQuery({ queryKey: qk.backlinks(pageId), queryFn: () => api.pages.backlinks(pageId), staleTime: 30_000 });
  const activity = useQuery({ queryKey: readingKeys.activity(pageId, version), queryFn: () => readingApi.activity(pageId), staleTime: 15_000 });
  const threads = useQuery({ queryKey: readingKeys.threads(pageId), queryFn: () => readingApi.threads(pageId), staleTime: 15_000 });
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId), staleTime: 60_000 });
  const nameOf = (id: string) => members.data?.find((m) => m.user.id === id)?.user.name ?? 'Quelqu’un';
  const openThreads = (threads.data?.threads ?? []).filter((t) => !t.resolved);
  const usersById = new Map((threads.data?.users ?? []).map((u) => [u.id, u.name]));

  return (
    <aside className={`or-info${docked ? ' is-docked' : ''}`} aria-label="Informations de la page">
      <header className="or-info__header">
        <span className="or-info__title">Informations</span>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={docked}
          aria-label={docked ? 'Détacher le panneau' : 'Ancrer le panneau'}
          title={docked ? 'Détacher (superposé à la page)' : 'Ancrer (réduit la page)'}
          onClick={() => infoPanelStore.set((s) => ({ ...s, docked: !s.docked }))}
        >
          {docked ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
        <button type="button" className="icon-btn" aria-label="Fermer le panneau" onClick={() => infoPanelStore.set((s) => ({ ...s, open: false }))}>
          <X size={16} />
        </button>
      </header>
      <div className="or-info__body">
        {!page ? (
          <p className="or-info__empty">Chargement…</p>
        ) : (
          <>
            <section className="or-info__section">
              <h3>Propriétés</h3>
              {page.parentType === 'database' ? (
                <RowProperties page={page} readOnly={!detail.data?.canEdit || !!page.trashedAt} />
              ) : (
                <dl className="or-info__meta">
                  <dt>Type</dt>
                  <dd>{page.kind === 'database' ? 'Base de données' : 'Page'}</dd>
                  <dt>Créée</dt>
                  <dd>
                    {nameOf(page.createdBy)} · {formatRelative(page.createdAt)}
                  </dd>
                  <dt>Modifiée</dt>
                  <dd>
                    {nameOf(page.updatedBy)} · {formatRelative(page.updatedAt)}
                  </dd>
                </dl>
              )}
            </section>
            <section className="or-info__section">
              <h3>Rétroliens</h3>
              {(backlinks.data?.pages.length ?? 0) === 0 ? (
                <p className="or-info__empty">Aucune page ne mentionne celle-ci.</p>
              ) : (
                <ul className="or-info__list">
                  {backlinks.data!.pages.map((c) => (
                    <li key={c.id}>
                      <Link to={pagePath(workspaceId, c.id)} className="or-info__link">
                        <PageIcon icon={c.icon} kind={c.kind} size={15} />
                        <span>{pageTitle(c.title)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="or-info__section">
              <h3>Activité récente</h3>
              {(activity.data?.events.length ?? 0) === 0 ? (
                <p className="or-info__empty">Aucune activité.</p>
              ) : (
                <ul className="or-info__list">
                  {activity.data!.events.slice(0, 12).map((e, i) => (
                    <li key={`${e.kind}-${e.at}-${i}`} className="or-info__event">
                      <span>
                        <strong>{e.user?.name ?? 'Quelqu’un'}</strong> {ACTIVITY_LABEL[e.kind]}
                      </span>
                      <time>{formatRelative(e.at)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="or-info__section">
              <h3>Commentaires{openThreads.length ? ` · ${openThreads.length}` : ''}</h3>
              {openThreads.length === 0 ? (
                <p className="or-info__empty">Aucun commentaire ouvert.</p>
              ) : (
                <ul className="or-info__list">
                  {openThreads.slice(0, 10).map((t) => {
                    const first = t.comments[0];
                    const text = first ? (first.body as Array<{ content?: unknown }>).map((b) => inlineText(b?.content)).join(' ').trim() : '';
                    return (
                      <li key={t.id} className="or-info__comment">
                        <strong>{usersById.get(t.createdBy) ?? 'Quelqu’un'}</strong>
                        {t.quote && <q>{t.quote.slice(0, 80)}</q>}
                        <span>{text.slice(0, 160) || '…'}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => document.querySelector<HTMLElement>('.or-comments-btn')?.click()}>
                Ouvrir les commentaires
              </button>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
