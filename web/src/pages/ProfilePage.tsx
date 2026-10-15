// Profile of a workspace member (navigation module, N06): their pages, recent activity and main
// collaborators — only what the viewer can read (filtered by the server).
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { ROLE_LABELS } from '@oriel/shared';
import { useDocumentTitle, formatDate, formatWhen, pagePath, pageTitle } from '../lib/util';
import { Avatar, EmptyState, ErrorState, PageIcon, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { navApi, nk } from '../shell/nav/api';
import { profilePath } from '../shell/nav/profile';
import './navigation.css';

export function ProfilePage() {
  const { userId = '' } = useParams();
  const { workspaceId, workspace } = useWorkspaceCtx();
  const profile = useQuery({ queryKey: nk.profile(workspaceId, userId), queryFn: () => navApi.profile(workspaceId, userId), enabled: !!userId });
  const p = profile.data;
  useDocumentTitle(`${p ? p.user.name : 'Profil'} · ${workspace.name}`);

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <UserRound size={15} /> Profil
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="narrow-page nav-profile">
          {profile.isLoading ? (
            <div className="list-skeleton">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={40} radius={8} />
              ))}
            </div>
          ) : profile.isError || !p ? (
            <ErrorState title="Profil introuvable" message="Cette personne n’est pas membre de l’espace de travail." onRetry={() => void profile.refetch()} />
          ) : (
            <>
              <header className="nav-profile__head">
                <Avatar name={p.user.name} id={p.user.id} url={p.user.avatarUrl} size={64} />
                <div>
                  <h1 className="narrow-page__title nav-profile__name">{p.user.name}</h1>
                  <p className="muted">
                    {ROLE_LABELS[p.role]} · membre depuis le {formatDate(p.joinedAt)}
                  </p>
                </div>
              </header>

              <section className="nav-profile__section" aria-labelledby="profile-pages">
                <h2 id="profile-pages" className="home__heading">Ses pages</h2>
                {p.pages.length === 0 ? (
                  <p className="muted">Aucune page visible pour vous.</p>
                ) : (
                  <ul className="nav-list">
                    {p.pages.map((page) => (
                      <li key={page.id}>
                        <Link className="nav-list__item" to={pagePath(workspaceId, page.id)}>
                          <PageIcon icon={page.icon} kind={page.kind} size={16} />
                          <span className="nav-list__title">{pageTitle(page.title)}</span>
                          <span className="nav-list__meta">modifiée {formatWhen(page.updatedAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="nav-profile__section" aria-labelledby="profile-activity">
                <h2 id="profile-activity" className="home__heading">Activité récente</h2>
                {p.activity.length === 0 ? (
                  <p className="muted">Aucune activité visible pour vous.</p>
                ) : (
                  <ul className="nav-list">
                    {p.activity.map((a) => (
                      <li key={a.id}>
                        <Link className="nav-list__item" to={pagePath(workspaceId, a.id)}>
                          <PageIcon icon={a.icon} kind={a.kind} size={16} />
                          <span className="nav-list__title">{pageTitle(a.title)}</span>
                          <span className="nav-list__meta">
                            {a.created ? 'créée' : 'modifiée'} {formatWhen(a.at)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="nav-profile__section" aria-labelledby="profile-collaborators">
                <h2 id="profile-collaborators" className="home__heading">Principaux collaborateurs</h2>
                {p.collaborators.length === 0 ? (
                  <EmptyState icon={<UserRound size={24} />} title="Pas encore de collaborateurs">
                    Les personnes qui modifient les mêmes pages apparaîtront ici.
                  </EmptyState>
                ) : (
                  <ul className="nav-list">
                    {p.collaborators.map((c) => (
                      <li key={c.user.id}>
                        <Link className="nav-list__item" to={profilePath(workspaceId, c.user.id)}>
                          <Avatar name={c.user.name} id={c.user.id} url={c.user.avatarUrl} size={22} />
                          <span className="nav-list__title">{c.user.name}</span>
                          <span className="nav-list__meta">{c.sharedPages === 1 ? '1 page en commun' : `${c.sharedPages} pages en commun`}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
