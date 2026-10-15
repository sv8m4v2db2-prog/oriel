// Teamspaces directory (navigation module, N07): browse open and closed teamspaces, join one,
// ask to join a closed one, and — for owners — manage access mode, members and requests.
// Private teamspaces only appear to their members (filtered by the server).
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Select, Switch, Textarea } from '@mantine/core';
import { Check, Lock, LockOpen, Search, Shield, UserMinus, Users, X } from 'lucide-react';
import type { TeamspaceAccess, TeamspaceRole, TeamspaceSummary } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { confirmDialog, toast } from '../lib/ui';
import { normalizeText, pagePath, pageTitle, useDocumentTitle } from '../lib/util';
import { Avatar, EmptyState, ErrorState, PageIcon, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { navApi, nk } from '../shell/nav/api';
import { ACCESS_HELP, ACCESS_LABELS } from '../shell/nav/access';
import { profilePath } from '../shell/nav/profile';
import './navigation.css';

const ACCESS_ICONS: Record<TeamspaceAccess, typeof Lock> = { open: LockOpen, closed: Lock, private: Shield };

function refresh(workspaceId: string, tid?: string) {
  void queryClient.invalidateQueries({ queryKey: nk.teamspaces(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: qk.tree(workspaceId) });
  if (tid) void queryClient.invalidateQueries({ queryKey: nk.teamspaceMembers(tid) });
}

async function run(workspaceId: string, tid: string, action: () => Promise<unknown>, success?: string) {
  try {
    await action();
    if (success) toast.success(success);
  } catch (e) {
    toast.error(errorMessage(e, 'Action impossible.'));
  } finally {
    refresh(workspaceId, tid);
  }
}

export function TeamspacesPage() {
  const { workspaceId, workspace } = useWorkspaceCtx();
  useDocumentTitle(`Espaces d’équipe · ${workspace.name}`);
  const [params, setParams] = useSearchParams();
  const managing = params.get('manage');
  const list = useQuery({ queryKey: nk.teamspaces(workspaceId), queryFn: () => navApi.teamspaces(workspaceId) });
  const [filter, setFilter] = useState('');
  const items = useMemo(() => {
    const q = normalizeText(filter);
    return (list.data?.teamspaces ?? []).filter((t) => !q || normalizeText(`${pageTitle(t.title)} ${t.description}`).includes(q));
  }, [list.data, filter]);

  const setManaging = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('manage', id);
    else next.delete('manage');
    setParams(next, { replace: true });
  };

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <Users size={15} /> Espaces d’équipe
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="narrow-page">
          <h1 className="narrow-page__title">Espaces d’équipe</h1>
          <p className="muted">
            Rejoignez les espaces ouverts, demandez l’accès aux espaces fermés. Les espaces privés n’apparaissent qu’à leurs membres.
          </p>
          <label className="input-with-icon">
            <Search size={15} />
            <input className="input" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrer les espaces d’équipe" />
          </label>
          {list.isLoading ? (
            <div className="list-skeleton">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={64} radius={8} />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={<Users size={26} />} title={filter ? 'Aucun résultat' : 'Aucun espace d’équipe'}>
              {filter
                ? 'Aucun espace ne correspond à ce filtre.'
                : 'Un administrateur de l’espace peut en créer un : menu « … » d’une page › « Transformer en espace d’équipe ».'}
            </EmptyState>
          ) : (
            <ul className="ts-list">
              {items.map((t) => (
                <TeamspaceCard key={t.id} ts={t} managing={managing === t.id} onManage={(open) => setManaging(open ? t.id : null)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function TeamspaceCard({ ts, managing, onManage }: { ts: TeamspaceSummary; managing: boolean; onManage: (open: boolean) => void }) {
  const { workspaceId } = useWorkspaceCtx();
  const Icon = ACCESS_ICONS[ts.access];
  const isMember = !!ts.myRole;
  const canOpen = isMember || ts.access === 'open';
  return (
    <li className={`ts-card${managing ? ' is-managing' : ''}`}>
      <div className="ts-card__main">
        <PageIcon icon={ts.icon} kind="page" size={22} />
        <div className="ts-card__text">
          <div className="ts-card__title">
            {canOpen ? <Link to={pagePath(workspaceId, ts.id)}>{pageTitle(ts.title)}</Link> : <span>{pageTitle(ts.title)}</span>}
            <span className={`ts-badge ts-badge--${ts.access}`}>
              <Icon size={12} aria-hidden /> {ACCESS_LABELS[ts.access]}
            </span>
            {ts.isDefault && <span className="ts-badge">Par défaut</span>}
          </div>
          {ts.description && <p className="ts-card__desc">{ts.description}</p>}
          <p className="ts-card__meta">
            {ts.memberCount === 1 ? '1 membre' : `${ts.memberCount} membres`}
            {ts.owners.length > 0 && <> · propriétaires : {ts.owners.map((o) => o.name).join(', ')}</>}
            {ts.myRole && <> · vous êtes {ts.myRole === 'owner' ? 'propriétaire' : 'membre'}</>}
          </p>
        </div>
        <div className="ts-card__actions">
          {!isMember && ts.access === 'open' && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void run(workspaceId, ts.id, () => navApi.join(ts.id), 'Espace rejoint')}>
              Rejoindre
            </button>
          )}
          {!isMember && ts.access === 'closed' && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={ts.requested}
              onClick={() => void run(workspaceId, ts.id, () => navApi.requestAccess(ts.id), 'Demande envoyée aux propriétaires')}
            >
              {ts.requested ? 'Demande envoyée' : 'Demander l’accès'}
            </button>
          )}
          {isMember && !ts.isDefault && !(ts.myRole === 'owner' && ts.owners.length <= 1) && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Quitter cet espace d’équipe ?',
                  message: ts.access === 'open' ? 'Il disparaîtra de votre barre latérale.' : 'Vous ne pourrez plus lire ses pages sans y être réinvité.',
                  confirmLabel: 'Quitter',
                  danger: ts.access !== 'open',
                });
                if (ok) void run(workspaceId, ts.id, () => navApi.leave(ts.id), 'Vous avez quitté l’espace');
              }}
            >
              Quitter
            </button>
          )}
          {ts.canManage && (
            <button type="button" className="btn btn--ghost btn--sm" aria-expanded={managing} onClick={() => onManage(!managing)}>
              {managing ? 'Fermer' : 'Gérer'}
            </button>
          )}
        </div>
      </div>
      {managing && ts.canManage && <ManagePanel ts={ts} />}
    </li>
  );
}

function ManagePanel({ ts }: { ts: TeamspaceSummary }) {
  const { workspaceId } = useWorkspaceCtx();
  const members = useQuery({ queryKey: nk.teamspaceMembers(ts.id), queryFn: () => navApi.members(ts.id) });
  const workspaceMembers = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId) });
  const [description, setDescription] = useState(ts.description);
  useEffect(() => setDescription(ts.description), [ts.description]);
  const [adding, setAdding] = useState<string | null>(null);

  const changeAccess = async (access: TeamspaceAccess) => {
    if (access === ts.access) return;
    const widens = (ts.access !== 'open' && access === 'open') || (ts.access === 'private' && access === 'closed');
    const ok = await confirmDialog({
      title: `Passer l’espace en mode « ${ACCESS_LABELS[access].toLowerCase()} » ?`,
      message:
        access === 'open'
          ? 'Tous les membres de l’espace de travail pourront lire ses pages.'
          : ts.access === 'open'
            ? ts.isDefault
              ? 'Ses pages ne seront plus lisibles que par ses membres. Les membres actuels de l’espace de travail en deviennent membres explicites : personne ne perd l’accès maintenant.'
              : 'Ses pages ne seront plus lisibles que par ses membres : les autres perdront l’accès.'
            : access === 'closed'
              ? 'Il apparaîtra dans l’annuaire (nom, description, propriétaires) ; son contenu reste réservé à ses membres.'
              : 'Il disparaîtra de l’annuaire pour les non-membres.',
      confirmLabel: widens ? 'Élargir l’accès' : 'Confirmer',
    });
    if (ok) void run(workspaceId, ts.id, () => navApi.updateTeamspace(ts.id, { access, confirmAccess: widens }), 'Accès modifié');
  };

  const memberIds = new Set((members.data?.members ?? []).map((m) => m.user.id));
  const candidates = (workspaceMembers.data ?? []).filter((m) => !memberIds.has(m.user.id));

  return (
    <div className="ts-manage">
      <div className="ts-manage__row" role="radiogroup" aria-label="Mode d’accès">
        {(['open', 'closed', 'private'] as const).map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={ts.access === a}
            className={`ts-access${ts.access === a ? ' is-active' : ''}`}
            onClick={() => void changeAccess(a)}
          >
            <strong>{ACCESS_LABELS[a]}</strong>
            <span>{ACCESS_HELP[a]}</span>
          </button>
        ))}
      </div>
      {ts.access === 'open' && (
        <Switch
          checked={ts.isDefault}
          onChange={(e) => void run(workspaceId, ts.id, () => navApi.updateTeamspace(ts.id, { isDefault: e.currentTarget.checked }))}
          label="Espace par défaut"
          description="Tous les membres de l’espace de travail en font partie et ne peuvent pas le quitter."
        />
      )}
      <Textarea
        label="Description"
        value={description}
        maxLength={500}
        autosize
        minRows={2}
        onChange={(e) => setDescription(e.currentTarget.value)}
        onBlur={() => {
          if (description !== ts.description) void run(workspaceId, ts.id, () => navApi.updateTeamspace(ts.id, { description }));
        }}
      />

      {(members.data?.requests.length ?? 0) > 0 && (
        <section aria-label="Demandes d’accès">
          <h3 className="home__heading">Demandes d’accès</h3>
          <ul className="nav-list">
            {members.data!.requests.map((r) => (
              <li key={r.user.id} className="nav-list__item">
                <Avatar name={r.user.name} id={r.user.id} url={r.user.avatarUrl} size={22} />
                <span className="nav-list__title">{r.user.name}</span>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => void run(workspaceId, ts.id, () => navApi.answer(ts.id, r.user.id, true), 'Accès accordé')}>
                  <Check size={14} /> Accepter
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void run(workspaceId, ts.id, () => navApi.answer(ts.id, r.user.id, false), 'Demande refusée')}>
                  <X size={14} /> Refuser
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Membres de l’espace d’équipe">
        <h3 className="home__heading">{ts.isDefault ? 'Membres explicites (tout l’espace de travail en fait partie)' : 'Membres'}</h3>
        {members.isLoading ? (
          <Skeleton height={32} radius={8} />
        ) : (
          <ul className="nav-list">
            {(members.data?.members ?? []).map((m) => (
              <li key={m.user.id} className="nav-list__item">
                <Avatar name={m.user.name} id={m.user.id} url={m.user.avatarUrl} size={22} />
                <Link className="nav-list__title" to={profilePath(workspaceId, m.user.id)}>
                  {m.user.name}
                </Link>
                <select
                  className="input input--sm ts-role"
                  aria-label={`Rôle de ${m.user.name}`}
                  value={m.role}
                  onChange={(e) => void run(workspaceId, ts.id, () => navApi.setMember(ts.id, m.user.id, e.target.value as TeamspaceRole))}
                >
                  <option value="owner">Propriétaire</option>
                  <option value="member">Membre</option>
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Retirer ${m.user.name}`}
                  onClick={() => void run(workspaceId, ts.id, () => navApi.removeMember(ts.id, m.user.id), 'Membre retiré')}
                >
                  <UserMinus size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > 0 && (
          <div className="ts-add">
            <Select
              placeholder="Ajouter un membre…"
              searchable
              value={adding}
              onChange={setAdding}
              data={candidates.map((m) => ({ value: m.user.id, label: m.user.name || m.user.email }))}
              aria-label="Ajouter un membre"
              comboboxProps={{ withinPortal: true }}
            />
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={!adding}
              onClick={() => {
                if (!adding) return;
                const uid = adding;
                setAdding(null);
                void run(workspaceId, ts.id, () => navApi.setMember(ts.id, uid, 'member'), 'Membre ajouté');
              }}
            >
              Ajouter
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
