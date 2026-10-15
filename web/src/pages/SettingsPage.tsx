import { featureSettingsTabs } from '../features/registry';
import { InviteByEmailSection, ResetLinkButton } from '../collab';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building, Copy, Monitor, Moon, Settings, Shield, Sun, Trash, User as UserIcon, UserPlus, Users, X } from 'lucide-react';
import {
  LIMITS,
  ROLE_LABELS,
  type Invite,
  type SessionResponse,
  type SignupMode,
  type WorkspaceRole,
} from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { setThemePreference, useTheme, type ThemePreference } from '../lib/theme';
import { confirmDialog, toast } from '../lib/ui';
import { copyToClipboard, formatDate, formatWhen, pickFile } from '../lib/util';
import { useDocumentTitle } from '../lib/util';
import { Avatar, ErrorState, Skeleton, Spinner } from '../components/common';
import { EmojiPickerPopover } from '../components/EmojiPicker';
import { TopBar } from '../shell/TopBar';
import { WorkspaceIcon } from '../shell/WorkspaceSwitcher';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import './settings.css';

type Tab = string;

export function SettingsPage() {
  const { tab } = useParams();
  const { workspaceId, user, workspace } = useWorkspaceCtx();
  useDocumentTitle(`Réglages · ${workspace.name}`);
  const current = (tab ?? 'account') as Tab;
  const tabs: Array<{ id: Tab; label: string; icon: ReactNode; hidden?: boolean }> = [
    { id: 'account', label: 'Mon compte', icon: <UserIcon size={16} /> },
    { id: 'workspace', label: 'Espace', icon: <Building size={16} /> },
    { id: 'members', label: 'Membres', icon: <Users size={16} /> },
    { id: 'instance', label: 'Instance', icon: <Shield size={16} />, hidden: !user.isAdmin },
    ...featureSettingsTabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon, hidden: !!t.adminOnly && !user.isAdmin })),
  ];
  if (!tabs.some((t) => t.id === current && !t.hidden)) return <Navigate to={`/w/${workspaceId}/settings/account`} replace />;

  return (
    <>
      <TopBar>
        <span className="topbar__title">
          <Settings size={15} /> Réglages
        </span>
      </TopBar>
      <div className="main-scroll">
        <div className="settings">
          <nav className="settings__nav" aria-label="Sections des réglages">
            {tabs
              .filter((t) => !t.hidden)
              .map((t) => (
                <NavLink
                  key={t.id}
                  to={`/w/${workspaceId}/settings/${t.id}`}
                  className={() => `settings__tab${t.id === current ? ' is-active' : ''}`}
                >
                  {t.icon}
                  {t.label}
                </NavLink>
              ))}
          </nav>
          <div className="settings__content">
            {current === 'account' && <AccountSettings />}
            {current === 'workspace' && <WorkspaceSettings />}
            {current === 'members' && <MembersSettings />}
            {current === 'instance' && <InstanceSettings />}
            {featureSettingsTabs.find((t) => t.id === current)?.render()}
          </div>
        </div>
      </div>
    </>
  );
}

function Section({ title, description, children, danger }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`settings-section${danger ? ' is-danger' : ''}`}>
      <h2 className="settings-section__title">{title}</h2>
      {description && <p className="settings-section__desc">{description}</p>}
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

// --- Mon compte ------------------------------------------------------------------------

function updateSessionUser(patch: Partial<SessionResponse['user']>) {
  queryClient.setQueryData<SessionResponse | null>(qk.session, (old) => (old ? { ...old, user: { ...old.user, ...patch } } : old));
}

function AccountSettings() {
  const { user, workspaceId } = useWorkspaceCtx();
  const theme = useTheme();
  const [name, setName] = useState(user.name);
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => setName(user.name), [user.name]);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === user.name) return;
    setSavingName(true);
    try {
      const res = await api.me.update({ name: name.trim() });
      updateSessionUser(res.user);
      toast.success('Nom mis à jour');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingName(false);
    }
  };

  const changeAvatar = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choisissez une image.');
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.workspaces.upload(workspaceId, file);
      const res = await api.me.update({ avatarUrl: uploaded.url });
      updateSessionUser(res.user);
      toast.success('Photo de profil mise à jour');
    } catch (err) {
      toast.error(errorMessage(err, 'Envoi impossible.'));
    } finally {
      setUploading(false);
    }
  };

  const removeAvatar = async () => {
    try {
      const res = await api.me.update({ avatarUrl: null });
      updateSessionUser(res.user);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const themes: Array<{ id: ThemePreference; label: string; icon: ReactNode }> = [
    { id: 'light', label: 'Clair', icon: <Sun size={15} /> },
    { id: 'dark', label: 'Sombre', icon: <Moon size={15} /> },
    { id: 'system', label: 'Système', icon: <Monitor size={15} /> },
  ];

  return (
    <>
      <h1 className="settings__title">Mon compte</h1>
      <Section title="Profil">
        <div className="profile-row">
          <Avatar name={user.name} id={user.id} url={user.avatarUrl} size={56} />
          <div className="profile-row__actions">
            <button type="button" className="btn btn--secondary btn--sm" disabled={uploading} onClick={() => void changeAvatar()}>
              {uploading ? <Spinner size={14} /> : null} Changer la photo
            </button>
            {user.avatarUrl && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void removeAvatar()}>
                Retirer
              </button>
            )}
          </div>
        </div>
        <form className="inline-form" onSubmit={saveName}>
          <label className="field">
            <span className="field-label">Nom</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <button type="submit" className="btn btn--primary" disabled={savingName || !name.trim() || name.trim() === user.name}>
            Enregistrer
          </button>
        </form>
        <div className="field">
          <span className="field-label">Adresse e-mail</span>
          <span className="field-static">{user.email}</span>
        </div>
      </Section>
      <Section title="Apparence" description="Choisissez le thème de l’interface. « Système » suit le réglage de votre appareil.">
        <div className="segmented segmented--inline" role="radiogroup" aria-label="Thème">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme.preference === t.id}
              className={theme.preference === t.id ? 'is-active' : ''}
              onClick={() => setThemePreference(t.id)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </Section>
      <PasswordSection />
    </>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < LIMITS.passwordMin) return setError(`Au moins ${LIMITS.passwordMin} caractères.`);
    if (next !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    try {
      await api.me.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success('Mot de passe modifié');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Mot de passe">
      <form className="stack-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Mot de passe actuel</span>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Nouveau mot de passe</span>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Confirmer le nouveau mot de passe</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            Changer le mot de passe
          </button>
        </div>
      </form>
    </Section>
  );
}

// --- Espace -----------------------------------------------------------------------------

function WorkspaceSettings() {
  const { workspace, workspaceId, canManage, role } = useWorkspaceCtx();
  const navigate = useNavigate();
  const [name, setName] = useState(workspace.name);
  const [iconOpen, setIconOpen] = useState(false);
  useEffect(() => setName(workspace.name), [workspace.name]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workspaces });
    void queryClient.invalidateQueries({ queryKey: qk.workspace(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: qk.session });
  };

  const save = async (body: { name?: string; icon?: string | null }) => {
    try {
      await api.workspaces.update(workspaceId, body);
      refresh();
      toast.success('Espace mis à jour');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Supprimer « ${workspace.name} » ?`,
      message: 'Toutes les pages, bases de données et fichiers de cet espace seront supprimés pour tous les membres. Cette action est irréversible.',
      confirmLabel: 'Supprimer l’espace',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.workspaces.remove(workspaceId);
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      await queryClient.invalidateQueries({ queryKey: qk.session });
      toast.success('Espace supprimé');
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <h1 className="settings__title">Espace de travail</h1>
      <Section title="Identité" description={canManage ? undefined : 'Seuls les propriétaires et administrateurs peuvent modifier ces réglages.'}>
        <div className="ws-identity">
          <EmojiPickerPopover
            opened={iconOpen}
            onClose={() => setIconOpen(false)}
            onSelect={(icon) => void save({ icon })}
            onRemove={() => void save({ icon: null })}
          >
            <button type="button" className="ws-identity__icon" disabled={!canManage} onClick={() => setIconOpen((o) => !o)} aria-label="Changer l’icône">
              <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={44} />
            </button>
          </EmojiPickerPopover>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== workspace.name) void save({ name: name.trim() });
            }}
          >
            <label className="field">
              <span className="field-label">Nom</span>
              <input className="input" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
            </label>
            {canManage && (
              <button type="submit" className="btn btn--primary" disabled={!name.trim() || name.trim() === workspace.name}>
                Enregistrer
              </button>
            )}
          </form>
        </div>
      </Section>
      {role === 'owner' && (
        <Section title="Zone de danger" danger description="La suppression d’un espace efface définitivement tout son contenu.">
          <button type="button" className="btn btn--danger" onClick={() => void remove()}>
            <Trash size={15} /> Supprimer l’espace de travail
          </button>
        </Section>
      )}
    </>
  );
}

// --- Membres ----------------------------------------------------------------------------

const INVITE_ROLES: Array<Exclude<WorkspaceRole, 'owner'>> = ['admin', 'member', 'viewer'];

function absoluteUrl(url: string) {
  return /^https?:\/\//.test(url) ? url : `${location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

function MembersSettings() {
  const { workspaceId, canManage, role: myRole, user } = useWorkspaceCtx();
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId) });
  const invites = useQuery({ queryKey: qk.invites(workspaceId), queryFn: () => api.workspaces.invites(workspaceId), enabled: canManage });
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, 'owner'>>('member');
  const [days, setDays] = useState<number>(LIMITS.inviteDefaultDays);
  const [creating, setCreating] = useState(false);

  const roles: WorkspaceRole[] = myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer'];

  const changeRole = async (uid: string, role: WorkspaceRole) => {
    try {
      await api.workspaces.updateMember(workspaceId, uid, { role });
      toast.success('Rôle modifié');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.members(workspaceId) });
    }
  };

  const removeMember = async (uid: string, name: string) => {
    const ok = await confirmDialog({
      title: `Retirer ${name} ?`,
      message: 'Cette personne perdra l’accès à l’espace de travail. Ses pages privées seront conservées.',
      confirmLabel: 'Retirer',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.workspaces.removeMember(workspaceId, uid);
      toast.success('Membre retiré');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.members(workspaceId) });
    }
  };

  const createInvite = async () => {
    setCreating(true);
    try {
      const invite = await api.workspaces.createInvite(workspaceId, { role: inviteRole, expiresInDays: days });
      void queryClient.invalidateQueries({ queryKey: qk.invites(workspaceId) });
      if (await copyToClipboard(absoluteUrl(invite.url))) toast.success('Lien d’invitation créé et copié');
      else toast.success('Lien d’invitation créé');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (invite: Invite) => {
    try {
      await api.workspaces.revokeInvite(workspaceId, invite.token);
      toast.success('Invitation révoquée');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.invites(workspaceId) });
    }
  };

  return (
    <>
      <h1 className="settings__title">Membres</h1>
      {canManage && (
        <Section title="Inviter des personnes" description="Générez un lien à partager. Il permet de créer un compte (même si les inscriptions sont fermées) puis de rejoindre l’espace.">
          <div className="invite-form">
            <label className="field">
              <span className="field-label">Rôle</span>
              <select className="input select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Exclude<WorkspaceRole, 'owner'>)}>
                {INVITE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Expire après</span>
              <select className="input select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[1, 7, 30].map((d) => (
                  <option key={d} value={d}>
                    {d} jour{d > 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn--primary" disabled={creating} onClick={() => void createInvite()}>
              {creating ? <Spinner size={14} /> : <UserPlus size={15} />} Créer un lien
            </button>
          </div>
          {invites.data && invites.data.length > 0 && (
            <ul className="invite-list">
              {invites.data.map((inv) => (
                <li key={inv.token} className="invite-item">
                  <span className="tag">{ROLE_LABELS[inv.role]}</span>
                  <span className="invite-item__meta">
                    Expire le {formatDate(inv.expiresAt)} · {inv.uses} utilisation{inv.uses > 1 ? 's' : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      if (await copyToClipboard(absoluteUrl(inv.url))) toast.success('Lien copié');
                    }}
                  >
                    <Copy size={14} /> Copier
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm btn--danger-text" onClick={() => void revoke(inv)}>
                    <X size={14} /> Révoquer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      <InviteByEmailSection />
      <Section title={`Membres${members.data ? ` (${members.data.length})` : ''}`}>
        {members.isLoading ? (
          <Skeleton height={40} />
        ) : members.isError ? (
          <ErrorState onRetry={() => void members.refetch()} />
        ) : (
          <ul className="member-list">
            {members.data!.map((m) => (
              <li key={m.user.id} className="member-item">
                <Avatar name={m.user.name} id={m.user.id} url={m.user.avatarUrl} size={32} />
                <span className="member-item__text">
                  <span className="member-item__name">
                    {m.user.name}
                    {m.user.id === user.id && <span className="muted"> (vous)</span>}
                  </span>
                  <span className="member-item__email">{m.user.email}</span>
                </span>
                {canManage && (m.role !== 'owner' || myRole === 'owner') ? (
                  <select
                    className="input select select--sm"
                    value={m.role}
                    aria-label={`Rôle de ${m.user.name}`}
                    onChange={(e) => void changeRole(m.user.id, e.target.value as WorkspaceRole)}
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="member-item__role">{ROLE_LABELS[m.role]}</span>
                )}
                {canManage && m.user.id !== user.id && (m.role !== 'owner' || myRole === 'owner') && (
                  <button type="button" className="icon-btn" aria-label={`Retirer ${m.user.name}`} onClick={() => void removeMember(m.user.id, m.user.name)}>
                    <X size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// --- Instance ---------------------------------------------------------------------------

const SIGNUP_MODES: Array<{ id: SignupMode; label: string; description: string }> = [
  { id: 'first-user', label: 'Premier compte uniquement', description: 'Après le compte administrateur, l’inscription se fait seulement par invitation.' },
  { id: 'invite', label: 'Sur invitation', description: 'Les nouveaux comptes doivent disposer d’un lien d’invitation.' },
  { id: 'open', label: 'Ouverte', description: 'Toute personne peut créer un compte sur cette instance.' },
];

function InstanceSettings() {
  const settings = useQuery({ queryKey: qk.adminSettings, queryFn: api.admin.settings });
  const users = useQuery({ queryKey: qk.adminUsers, queryFn: api.admin.users });

  const setMode = async (signupMode: SignupMode) => {
    try {
      const res = await api.admin.updateSettings({ signupMode });
      queryClient.setQueryData(qk.adminSettings, res);
      void queryClient.invalidateQueries({ queryKey: qk.authConfig });
      toast.success('Mode d’inscription mis à jour');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <h1 className="settings__title">Instance</h1>
      <Section title="Inscriptions" description="Qui peut créer un compte sur ce serveur Oriel.">
        {settings.isLoading ? (
          <Skeleton height={80} />
        ) : settings.isError ? (
          <ErrorState onRetry={() => void settings.refetch()} />
        ) : (
          <div className="radio-cards" role="radiogroup">
            {SIGNUP_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.data?.signupMode === m.id}
                className={`radio-card${settings.data?.signupMode === m.id ? ' is-active' : ''}`}
                onClick={() => void setMode(m.id)}
              >
                <span className="radio-card__label">{m.label}</span>
                <span className="radio-card__desc">{m.description}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title={`Utilisateurs${users.data ? ` (${users.data.users.length})` : ''}`}>
        {users.isLoading ? (
          <Skeleton height={40} />
        ) : users.isError ? (
          <ErrorState onRetry={() => void users.refetch()} />
        ) : (
          <ul className="member-list">
            {users.data!.users.map((u) => (
              <li key={u.id} className="member-item">
                <Avatar name={u.name} id={u.id} url={u.avatarUrl} size={32} />
                <span className="member-item__text">
                  <span className="member-item__name">
                    {u.name} {u.isAdmin && <span className="tag" data-color="blue">Administrateur</span>}
                  </span>
                  <span className="member-item__email">{u.email}</span>
                </span>
                <span className="member-item__role">
                  {u.workspaceCount} espace{u.workspaceCount > 1 ? 's' : ''} · inscrit {formatWhen(u.createdAt)}
                </span>
                <ResetLinkButton userId={u.id} name={u.name} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
