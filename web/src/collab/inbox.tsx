// Inbox ("Boîte de réception"): notifications of the current workspace, unread badge in the
// sidebar (live through the `notifications` change) and optional browser/desktop notifications.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Archive, ArchiveRestore, AtSign, Bell, CheckCheck, Circle, CircleCheck, ClipboardList, Inbox, MessageSquare, Reply, UserPlus } from 'lucide-react';
import { ROLE_LABELS, type NotificationItem } from '@oriel/shared';
import { errorMessage, queryClient } from '../lib/queryClient';
import { createStore, storage, useStore } from '../lib/store';
import { toast } from '../lib/ui';
import { formatRelative, pageTitle } from '../lib/util';
import { Avatar, EmptyState, ErrorState, PageIcon, Skeleton } from '../components/common';
import { TopBar } from '../shell/TopBar';
import { useOptionalWorkspaceCtx, useWorkspaceCtx } from '../shell/WorkspaceContext';
import { collabApi } from './api';
import { formatDateLong } from './dates';
import { ck } from './keys';
import './collab.css';

// --- data -----------------------------------------------------------------------------------

export function useUnreadCount(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ck.unread(workspaceId ?? ''),
    queryFn: () => collabApi.unread(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

function useNotifications(workspaceId: string, filter: 'inbox' | 'archived') {
  return useQuery({ queryKey: ck.notifications(workspaceId, filter), queryFn: () => collabApi.notifications(workspaceId, filter) });
}

function invalidate(workspaceId: string) {
  void queryClient.invalidateQueries({ queryKey: ck.notificationsAll(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: ck.unread(workspaceId) });
}

export function notificationTarget(n: NotificationItem): string | null {
  // Navigation module: requests are answered from the teamspaces directory.
  if (n.type === 'teamspace_request' && n.page) return `/w/${n.workspaceId}/teamspaces?manage=${encodeURIComponent(n.page.id)}`;
  if (n.page) return `/w/${n.workspaceId}/p/${n.page.id}${n.threadId ? `?thread=${encodeURIComponent(n.threadId)}` : ''}`;
  if (n.type === 'invite_accepted') return `/w/${n.workspaceId}/settings/members`;
  return null;
}

/** Plain-text summary (browser notifications). */
export function notificationSummary(n: NotificationItem): string {
  const who = n.actor?.name ?? 'Quelqu’un';
  const page = n.page ? `« ${pageTitle(n.page.title)} »` : 'une page';
  switch (n.type) {
    case 'mention':
      return `${who} vous a mentionné dans ${page}`;
    case 'comment_mention':
      return `${who} vous a mentionné dans un commentaire sur ${page}`;
    case 'comment':
      return `${who} a commenté ${page}`;
    case 'reply':
      return `${who} a répondu dans une discussion sur ${page}`;
    case 'reminder':
      return `Rappel${n.date ? ` du ${formatDateLong(n.date)}` : ''} : ${page}`;
    case 'invite_accepted':
      return `${who} a rejoint l’espace`;
    case 'form_response':
      return `Nouvelle réponse à un formulaire : ${page}`;
    case 'teamspace_request':
      return `${who} demande à rejoindre l’espace d’équipe ${page}`;
    case 'teamspace_request_granted':
      return `${who} vous a ajouté à l’espace d’équipe ${page}`;
    default:
      return 'Nouvelle notification';
  }
}

// --- browser / desktop notifications ------------------------------------------------------------

const BROWSER_KEY = 'oriel:browser-notifications';
export const browserNotificationsStore = createStore<boolean>(storage.get(BROWSER_KEY) === '1');

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function setBrowserNotifications(enabled: boolean): Promise<boolean> {
  if (enabled) {
    if (!browserNotificationsSupported()) return false;
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast.error('Les notifications sont bloquées par le navigateur pour ce site.');
      return false;
    }
  }
  storage.set(BROWSER_KEY, enabled ? '1' : '0');
  browserNotificationsStore.set(enabled);
  return true;
}

function useBrowserNotifications(workspaceId: string, unread: number | undefined) {
  const enabled = useStore(browserNotificationsStore);
  const navigate = useNavigate();
  const previous = useRef<number | undefined>(undefined);
  const seenSince = useRef(Date.now());
  useEffect(() => {
    const before = previous.current;
    previous.current = unread;
    if (!enabled || unread === undefined || before === undefined || unread <= before) return;
    if (!browserNotificationsSupported() || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    void (async () => {
      try {
        const res = await queryClient.fetchQuery({
          queryKey: ck.notifications(workspaceId, 'inbox'),
          queryFn: () => collabApi.notifications(workspaceId, 'inbox'),
          staleTime: 0,
        });
        const fresh = res.notifications.filter((n) => !n.readAt && n.createdAt >= seenSince.current).slice(0, 3);
        seenSince.current = Date.now();
        for (const n of fresh) {
          const notification = new Notification('Oriel', { body: `${notificationSummary(n)}${n.excerpt ? `\n${n.excerpt}` : ''}`, tag: n.id });
          notification.onclick = () => {
            window.focus();
            const target = notificationTarget(n);
            if (target) navigate(target);
            notification.close();
          };
        }
      } catch {
        /* offline */
      }
    })();
  }, [unread, enabled, workspaceId, navigate]);
}

// --- sidebar link ---------------------------------------------------------------------------------

/** Sidebar entry under "Accueil": "Boîte de réception" with unread badge. */
export function InboxSidebarLink() {
  const ctx = useOptionalWorkspaceCtx();
  const workspaceId = ctx?.workspaceId ?? null;
  const unread = useUnreadCount(workspaceId);
  useBrowserNotifications(workspaceId ?? '', workspaceId ? unread.data?.unread : undefined);
  if (!workspaceId) return null;
  const count = unread.data?.unread ?? 0;
  return (
    <NavLink to={`/w/${workspaceId}/inbox`} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
      <Inbox size={16} />
      <span className="nav-item__label">Boîte de réception</span>
      {count > 0 && (
        <span className="nav-item__badge" aria-label={`${count} non lue${count > 1 ? 's' : ''}`}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  );
}

// --- page --------------------------------------------------------------------------------------------

function dayLabel(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return 'Aujourd’hui';
  if (isYesterday(d)) return 'Hier';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return format(d, sameYear ? 'EEEE d MMMM' : 'EEEE d MMMM yyyy', { locale: fr });
}

function TypeIcon({ type }: { type: NotificationItem['type'] }) {
  const icon: Record<NotificationItem['type'], ReactNode> = {
    mention: <AtSign size={15} />,
    comment_mention: <AtSign size={15} />,
    comment: <MessageSquare size={15} />,
    reply: <Reply size={15} />,
    reminder: <Bell size={15} />,
    invite_accepted: <UserPlus size={15} />,
    form_response: <ClipboardList size={15} />,
    teamspace_request: <UserPlus size={15} />,
    teamspace_request_granted: <UserPlus size={15} />,
  };
  return <span className="inbox-item__icon">{icon[type]}</span>;
}

function PageRef({ n }: { n: NotificationItem }) {
  if (!n.page) return <span className="muted">une page supprimée ou inaccessible</span>;
  return (
    <span className="inbox-item__page">
      <PageIcon icon={n.page.icon} kind={n.page.kind} size={14} />
      {pageTitle(n.page.title)}
    </span>
  );
}

function ItemText({ n }: { n: NotificationItem }) {
  const who = <strong>{n.actor?.name ?? 'Quelqu’un'}</strong>;
  switch (n.type) {
    case 'mention':
      return (
        <>
          {who} vous a mentionné dans <PageRef n={n} />
        </>
      );
    case 'comment_mention':
      return (
        <>
          {who} vous a mentionné dans un commentaire sur <PageRef n={n} />
        </>
      );
    case 'comment':
      return (
        <>
          {who} a commenté <PageRef n={n} />
        </>
      );
    case 'reply':
      return (
        <>
          {who} a répondu dans une discussion sur <PageRef n={n} />
        </>
      );
    case 'reminder':
      return (
        <>
          <strong>Rappel{n.date ? ` du ${formatDateLong(n.date)}` : ''}</strong> · <PageRef n={n} />
        </>
      );
    case 'form_response':
      return (
        <>
          Nouvelle réponse à un formulaire : <PageRef n={n} />
        </>
      );
    case 'teamspace_request':
      return (
        <>
          {who} demande à rejoindre l’espace d’équipe <PageRef n={n} />
        </>
      );
    case 'teamspace_request_granted':
      return (
        <>
          {who} vous a ajouté à l’espace d’équipe <PageRef n={n} />
        </>
      );
    case 'invite_accepted':
      return (
        <>
          {who} a rejoint l’espace grâce à votre invitation{n.role ? ` (${ROLE_LABELS[n.role].toLowerCase()})` : ''}
        </>
      );
    default:
      return <>Nouvelle notification</>;
  }
}

function InboxItem({ n, workspaceId }: { n: NotificationItem; workspaceId: string }) {
  const navigate = useNavigate();
  const update = async (body: { read?: boolean; archived?: boolean }) => {
    try {
      await collabApi.updateNotification(n.id, body);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      invalidate(workspaceId);
    }
  };
  const open = () => {
    if (!n.readAt) void update({ read: true });
    const target = notificationTarget(n);
    if (target) navigate(target);
  };
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    fn();
  };
  return (
    <li
      className={`inbox-item${n.readAt ? ' is-read' : ''}`}
      tabIndex={0}
      role="link"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
    >
      {!n.readAt && <span className="inbox-item__dot" aria-label="Non lue" />}
      {n.actor ? <Avatar name={n.actor.name} id={n.actor.id} url={n.actor.avatarUrl} size={28} /> : <TypeIcon type={n.type} />}
      <div className="inbox-item__body">
        <div className="inbox-item__text">
          <ItemText n={n} />
        </div>
        {n.excerpt && n.type !== 'reminder' && <div className="inbox-item__excerpt">{n.excerpt}</div>}
        <div className="inbox-item__time">{formatRelative(n.createdAt)}</div>
      </div>
      <div className="inbox-item__actions">
        <button
          type="button"
          className="icon-btn"
          title={n.readAt ? 'Marquer comme non lue' : 'Marquer comme lue'}
          aria-label={n.readAt ? 'Marquer comme non lue' : 'Marquer comme lue'}
          onClick={stop(() => void update({ read: !n.readAt }))}
        >
          {n.readAt ? <Circle size={15} /> : <CircleCheck size={15} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          title={n.archivedAt ? 'Désarchiver' : 'Archiver'}
          aria-label={n.archivedAt ? 'Désarchiver' : 'Archiver'}
          onClick={stop(() => void update({ archived: !n.archivedAt }))}
        >
          {n.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
        </button>
      </div>
    </li>
  );
}

/** Route element for /w/:workspaceId/inbox */
export function InboxPage() {
  const { workspaceId, workspace } = useWorkspaceCtx();
  const [filter, setFilter] = useState<'inbox' | 'archived'>('inbox');
  const query = useNotifications(workspaceId, filter);
  const unread = query.data?.unread ?? 0;
  useEffect(() => {
    document.title = `Boîte de réception · ${workspace.name} · Oriel`;
  }, [workspace.name]);

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: NotificationItem[] }> = [];
    for (const n of query.data?.notifications ?? []) {
      const label = dayLabel(n.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [query.data]);

  const readAll = async () => {
    try {
      await collabApi.readAll(workspaceId);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      invalidate(workspaceId);
    }
  };

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <Inbox size={15} /> Boîte de réception
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="inbox">
          <div className="inbox__head">
            <h1 className="inbox__title">Boîte de réception</h1>
            <div className="inbox__actions">
              <div className="segmented segmented--inline" role="tablist">
                <button type="button" role="tab" aria-selected={filter === 'inbox'} className={filter === 'inbox' ? 'is-active' : ''} onClick={() => setFilter('inbox')}>
                  Notifications{unread > 0 ? ` · ${unread}` : ''}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'archived'}
                  className={filter === 'archived' ? 'is-active' : ''}
                  onClick={() => setFilter('archived')}
                >
                  Archivées
                </button>
              </div>
              {filter === 'inbox' && unread > 0 && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void readAll()}>
                  <CheckCheck size={15} /> Tout marquer comme lu
                </button>
              )}
            </div>
          </div>
          {query.isLoading ? (
            <>
              <Skeleton height={44} />
              <Skeleton height={44} style={{ marginTop: 8 }} />
            </>
          ) : query.isError ? (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          ) : groups.length === 0 ? (
            <EmptyState icon={<Inbox size={28} />} title={filter === 'inbox' ? 'Aucune notification' : 'Aucune notification archivée'}>
              {filter === 'inbox'
                ? 'Mentions, commentaires, réponses et rappels apparaîtront ici.'
                : 'Les notifications archivées sont conservées ici pendant 60 jours.'}
            </EmptyState>
          ) : (
            groups.map((g) => (
              <section key={g.label}>
                <h2 className="inbox__group">{g.label}</h2>
                <ul className="inbox__list">
                  {g.items.map((n) => (
                    <InboxItem key={n.id} n={n} workspaceId={workspaceId} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}
