// Settings pieces of the collab module: Settings › Notifications, "Inviter par e-mail"
// (Members) and "Lien de réinitialisation" (Instance › Utilisateurs).
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Popover, Switch } from '@mantine/core';
import { Copy, KeyRound, Mail, Send } from 'lucide-react';
import { LIMITS, ROLE_LABELS, type EmailFrequency, type WorkspaceRole } from '@oriel/shared';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { toast } from '../lib/ui';
import { copyToClipboard, formatWhen } from '../lib/util';
import { Skeleton, Spinner } from '../components/common';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { collabApi } from './api';
import { browserNotificationsStore, browserNotificationsSupported, setBrowserNotifications } from './inbox';
import { ck } from './keys';
import './collab.css';

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="settings-section__title">{title}</h2>
      {description && <p className="settings-section__desc">{description}</p>}
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

const absoluteUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${location.origin}${url.startsWith('/') ? '' : '/'}${url}`);

export function useNotificationSettings() {
  return useQuery({ queryKey: ck.settings, queryFn: collabApi.settings, staleTime: 60_000 });
}

// --- Settings › Notifications ----------------------------------------------------------------------

const FREQUENCIES: Array<{ id: EmailFrequency; label: string; description: string }> = [
  { id: 'immediate', label: 'Immédiatement', description: 'Un e-mail pour chaque mention, réponse ou rappel.' },
  { id: 'daily', label: 'Résumé quotidien', description: 'Un seul e-mail vers 8 h avec les notifications non lues.' },
  { id: 'never', label: 'Jamais', description: 'Uniquement la boîte de réception d’Oriel.' },
];

/** Settings › Notifications tab content (every user). */
export function NotificationSettings() {
  const { user } = useWorkspaceCtx();
  const settings = useNotificationSettings();
  const browser = useStore(browserNotificationsStore);
  const [sending, setSending] = useState(false);
  const emailEnabled = settings.data?.emailEnabled ?? false;
  const supported = browserNotificationsSupported();
  const permission = supported ? Notification.permission : 'denied';

  const setFrequency = async (emailFrequency: EmailFrequency) => {
    try {
      const res = await collabApi.updateSettings({ emailFrequency });
      queryClient.setQueryData(ck.settings, res);
      toast.success('Préférence enregistrée');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const sendTest = async () => {
    setSending(true);
    try {
      const res = await collabApi.testMail();
      toast.success(`E-mail de test envoyé à ${res.to}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <h1 className="settings__title">Notifications</h1>
      <Section
        title="E-mails"
        description={
          emailEnabled
            ? 'Recevez par e-mail les mentions, commentaires sur vos pages, réponses et rappels que vous n’avez pas encore lus.'
            : 'L’envoi d’e-mails n’est pas configuré sur ce serveur (variables SMTP). Les notifications restent disponibles dans la boîte de réception.'
        }
      >
        {settings.isLoading ? (
          <Skeleton height={80} />
        ) : (
          <div className="radio-cards" role="radiogroup" aria-label="Fréquence des e-mails">
            {FREQUENCIES.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={settings.data?.emailFrequency === f.id}
                disabled={!emailEnabled}
                className={`radio-card${settings.data?.emailFrequency === f.id ? ' is-active' : ''}`}
                onClick={() => void setFrequency(f.id)}
              >
                <span className="radio-card__label">{f.label}</span>
                <span className="radio-card__desc">{f.description}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title="Notifications du navigateur" description="Affiche une notification système quand une nouvelle notification arrive alors qu’Oriel n’est pas au premier plan (sur cet appareil uniquement).">
        <div className="collab-switch-row">
          <span>{!supported ? 'Non prises en charge par ce navigateur.' : permission === 'denied' ? 'Bloquées dans les réglages du navigateur pour ce site.' : 'Activer sur cet appareil'}</span>
          <Switch
            checked={browser && permission === 'granted'}
            disabled={!supported || permission === 'denied'}
            onChange={(e) => void setBrowserNotifications(e.currentTarget.checked)}
            aria-label="Notifications du navigateur"
          />
        </div>
      </Section>
      {user.isAdmin && (
        <Section title="Envoi d’e-mails (administrateur)" description="Vérifie la configuration SMTP du serveur en vous envoyant un e-mail.">
          <div>
            <button type="button" className="btn btn--secondary" disabled={!emailEnabled || sending} onClick={() => void sendTest()}>
              {sending ? <Spinner size={14} /> : <Send size={15} />} Envoyer un e-mail de test à {user.email}
            </button>
          </div>
          {!emailEnabled && <p className="collab-note">Renseignez SMTP_URL (ou SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) et MAIL_FROM, puis redémarrez Oriel.</p>}
        </Section>
      )}
    </>
  );
}

// --- Settings › Membres : "Inviter par e-mail" ----------------------------------------------------------

const INVITE_ROLES: Array<Exclude<WorkspaceRole, 'owner'>> = ['admin', 'member', 'viewer'];

export function InviteByEmailSection() {
  const { workspaceId, canManage } = useWorkspaceCtx();
  const settings = useNotificationSettings();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<WorkspaceRole, 'owner'>>('member');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  if (!canManage) return null;
  const emailEnabled = settings.data?.emailEnabled ?? false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLink(null);
    try {
      const res = await collabApi.emailInvite(workspaceId, { email: email.trim(), role, expiresInDays: LIMITS.inviteDefaultDays });
      void queryClient.invalidateQueries({ queryKey: qk.invites(workspaceId) });
      if (res.emailed) {
        toast.success(`Invitation envoyée à ${email.trim()}`);
        setEmail('');
      } else {
        setLink(absoluteUrl(res.invite.url));
        toast(emailEnabled ? 'L’e-mail n’a pas pu être envoyé : transmettez le lien vous-même.' : 'Invitation créée : transmettez le lien vous-même.');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Inviter par e-mail"
      description={
        emailEnabled
          ? 'Oriel envoie un lien d’invitation personnel (valable 7 jours) à l’adresse indiquée.'
          : 'L’envoi d’e-mails n’est pas configuré sur ce serveur : un lien d’invitation est créé et affiché pour que vous le transmettiez.'
      }
    >
      <form className="invite-form" onSubmit={submit}>
        <label className="field" style={{ flex: 2 }}>
          <span className="field-label">Adresse e-mail</span>
          <input className="input" type="email" required value={email} placeholder="prenom@exemple.fr" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Rôle</span>
          <select className="input select" value={role} onChange={(e) => setRole(e.target.value as Exclude<WorkspaceRole, 'owner'>)}>
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !email.trim()}>
          {busy ? <Spinner size={14} /> : <Mail size={15} />} {emailEnabled ? 'Envoyer l’invitation' : 'Créer l’invitation'}
        </button>
      </form>
      {link && <LinkBox url={link} />}
    </Section>
  );
}

function LinkBox({ url }: { url: string }) {
  return (
    <div className="collab-link-box">
      <input className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Lien" />
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={async () => {
          if (await copyToClipboard(url)) toast.success('Lien copié');
        }}
      >
        <Copy size={14} /> Copier
      </button>
    </div>
  );
}

// --- Settings › Instance : "Créer un lien de réinitialisation" --------------------------------------------

export function ResetLinkButton({ userId, name }: { userId: string; name: string }) {
  const settings = useNotificationSettings();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; expiresAt: number; emailed: boolean } | null>(null);
  const emailEnabled = settings.data?.emailEnabled ?? false;

  const create = async (sendEmail: boolean) => {
    setBusy(true);
    try {
      const res = await collabApi.adminResetLink(userId, sendEmail);
      setResult({ ...res, url: absoluteUrl(res.url) });
      if (sendEmail && res.emailed) toast.success(`Lien envoyé par e-mail à ${name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={380} shadow="md" withinPortal>
      <Popover.Target>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpened((o) => !o)} title="Créer un lien de réinitialisation du mot de passe">
          <KeyRound size={14} /> Réinitialiser
        </button>
      </Popover.Target>
      <Popover.Dropdown>
        <div className="collab-reset-pop">
          <strong>Mot de passe de {name}</strong>
          <p className="collab-note">
            Crée un lien à usage unique, valable 24 h, pour choisir un nouveau mot de passe. Toutes les sessions de la personne seront fermées après la réinitialisation.
          </p>
          {result ? (
            <>
              <LinkBox url={result.url} />
              <p className="collab-note">
                {result.emailed ? 'Envoyé par e-mail. ' : ''}Expire {formatWhen(result.expiresAt)}.
              </p>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void create(false)}>
                {busy ? <Spinner size={14} /> : <KeyRound size={14} />} Créer un lien de réinitialisation
              </button>
              {emailEnabled && (
                <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => void create(true)}>
                  <Mail size={14} /> Créer et envoyer par e-mail
                </button>
              )}
            </div>
          )}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
