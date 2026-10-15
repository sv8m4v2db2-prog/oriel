// Réglages › Sécurité (wave G9): two-factor authentication (authenticator app, recovery codes,
// passkeys), single sign-on, e-mail address, security log; workspace policy, verified domains and
// transfer for managers; two-factor reset for instance administrators.
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Fingerprint, Globe, KeyRound, ShieldCheck, ShieldAlert, Smartphone, Trash, X } from 'lucide-react';
import {
  ROLE_LABELS,
  SECURITY_LIMITS,
  type SecurityEvent,
  type SecurityStatus,
  type SessionResponse,
  type VerifiedDomain,
} from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { confirmDialog, promptDialog, toast } from '../lib/ui';
import { copyToClipboard, formatDate, formatWhen } from '../lib/util';
import { ErrorState, Skeleton, Spinner } from '../components/common';
import { createStore, useStore } from '../lib/store';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { encodeQr, qrSvgPath } from './qr';
import { securityApi, securityKeys } from './securityApi';
import { createPasskey, passkeyError, passkeysSupported } from './webauthn';
import './security.css';

function Section({ title, description, children, danger }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`settings-section${danger ? ' is-danger' : ''}`}>
      <h2 className="settings-section__title">{title}</h2>
      {description && <p className="settings-section__desc">{description}</p>}
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

const refreshStatus = () => queryClient.invalidateQueries({ queryKey: ['security'] });

async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (success) toast.success(success);
    return result;
  } catch (err) {
    toast.error(errorMessage(err));
    return undefined;
  } finally {
    void refreshStatus();
  }
}

// ---------------------------------------------------------------------------
// Reusable pieces (also used by the enrolment page)
// ---------------------------------------------------------------------------

export function QrCode({ text, size = 176 }: { text: string; size?: number }) {
  const { path, size: n } = useMemo(() => qrSvgPath(encodeQr(text)), [text]);
  return (
    <svg className="sec-qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code à scanner" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/**
 * Recovery codes waiting to be saved: kept outside the components, since enabling the app refreshes
 * the status and re-renders the section (the codes are shown only once).
 */
const pendingCodesStore = createStore<string[] | null>(null);
export const usePendingRecoveryCodes = () => useStore(pendingCodesStore);

/** Shows the pending recovery codes, if any; `onClose` runs once they are saved. */
export function PendingRecoveryCodes({ onClose }: { onClose?: () => void }) {
  const codes = usePendingRecoveryCodes();
  if (!codes) return null;
  return <RecoveryCodes codes={codes} onClose={() => (pendingCodesStore.set(null), onClose?.())} />;
}

export function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Codes de secours Oriel (usage unique)\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'oriel-codes-de-secours.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="sec-recovery">
      <p className="sec-strong">Conservez ces codes de secours en lieu sûr.</p>
      <p className="sec-muted">Chacun permet une seule connexion si vous perdez votre téléphone. Ils ne seront plus affichés.</p>
      <ol className="sec-recovery__codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="sec-row">
        <button type="button" className="btn btn--secondary btn--sm" onClick={async () => (await copyToClipboard(text)) && toast.success('Codes copiés')}>
          <Copy size={14} /> Copier
        </button>
        <button type="button" className="btn btn--secondary btn--sm" onClick={download}>
          <Download size={14} /> Télécharger
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onClose}>
          <Check size={14} /> Je les ai enregistrés
        </button>
      </div>
    </div>
  );
}

/** Authenticator app enrolment: QR code + key, then confirmation code, then recovery codes. */
export function TotpEnrol({ onDone }: { onDone?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!setup) {
    return (
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const s = await attempt(() => securityApi.totpSetup());
          if (s) setSetup(s);
          setBusy(false);
        }}
      >
        <Smartphone size={15} /> Activer l’application d’authentification
      </button>
    );
  }
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      pendingCodesStore.set((await securityApi.totpConfirm(code.trim())).recoveryCodes);
      toast.success('Double authentification activée');
      setSetup(null);
      void refreshStatus();
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sec-enrol">
      <QrCode text={setup.uri} />
      <div className="sec-enrol__steps">
        <p>1. Scannez ce QR code avec votre application d’authentification (Authy, 1Password, Google Authenticator, l’app Mots de passe d’Apple…).</p>
        <p className="sec-muted">
          Ou saisissez la clé : <code className="sec-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
        </p>
        <form className="sec-row" onSubmit={confirm}>
          <label className="field sec-grow">
            <span className="field-label">2. Code affiché par l’application</span>
            <input
              className="input sec-code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : 'Valider'}
          </button>
        </form>
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

export function AddPasskeyButton({ onDone, primary }: { onDone?: () => void; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const name = await promptDialog({ title: 'Nouvelle clé d’accès', label: 'Nom (pour la reconnaître)', initialValue: navigator.platform.startsWith('Mac') ? 'Mac' : 'Mon appareil', confirmLabel: 'Continuer' });
    if (name === null) return;
    setBusy(true);
    await attempt(async () => {
      const { ticket, options } = await securityApi.passkeyRegisterOptions();
      let response;
      try {
        response = await createPasskey(options);
      } catch (err) {
        throw new Error(passkeyError(err));
      }
      await securityApi.passkeyRegister(ticket, response, name.slice(0, SECURITY_LIMITS.passkeyNameMax));
      onDone?.();
    }, 'Clé d’accès ajoutée');
    setBusy(false);
  };
  return (
    <button type="button" className={`btn ${primary ? 'btn--primary' : 'btn--secondary'}`} disabled={busy || !passkeysSupported()} onClick={() => void add()}>
      {busy ? <Spinner size={14} /> : <Fingerprint size={15} />} Ajouter une clé d’accès
    </button>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<SecurityEvent, string> = {
  totp_enabled: 'Application d’authentification activée',
  totp_disabled: 'Application d’authentification désactivée',
  recovery_codes_generated: 'Nouveaux codes de secours',
  recovery_code_used: 'Code de secours utilisé',
  passkey_added: 'Clé d’accès ajoutée',
  passkey_removed: 'Clé d’accès retirée',
  mfa_reset_by_admin: 'Double authentification réinitialisée par un administrateur',
  email_changed: 'Adresse e-mail modifiée',
  password_changed: 'Mot de passe modifié',
  sso_linked: 'Compte d’entreprise associé',
  sso_unlinked: 'Compte d’entreprise dissocié',
  transfer_proposed: 'Transfert d’espace proposé',
  transfer_accepted: 'Transfert d’espace accepté',
  transfer_declined: 'Transfert d’espace refusé',
  transfer_cancelled: 'Transfert d’espace annulé',
  workspace_policy_changed: 'Politique de double authentification modifiée',
};

function TwoFactorSection({ status }: { status: SecurityStatus }) {
  const codes = usePendingRecoveryCodes();
  const protectedAccount = status.totpEnabled || status.passkeys.length > 0;
  return (
    <Section
      title="Double authentification"
      description="Une seconde preuve d’identité est demandée après le mot de passe : code d’une application, ou clé d’accès."
    >
      <div className={`sec-status ${protectedAccount ? 'is-ok' : 'is-warn'}`}>
        {protectedAccount ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
        {protectedAccount ? 'Votre compte est protégé.' : 'Votre compte n’est protégé que par son mot de passe.'}
      </div>
      {status.requiredBy.map((r) => (
        <p key={r.workspaceId} className="sec-muted">
          L’espace « {r.workspaceName} » l’impose
          {r.graceUntil && r.graceUntil > Date.now() ? ` à partir du ${formatDate(r.graceUntil)}` : ''}.
        </p>
      ))}
      <h3 className="sec-subtitle">Application d’authentification</h3>
      {codes ? (
        <PendingRecoveryCodes />
      ) : status.totpEnabled ? (
        <div className="sec-row">
          <span className="sec-pill is-ok">
            <Check size={13} /> Activée
          </span>
          <span className="sec-muted">{status.recoveryCodesRemaining} codes de secours restants</span>
          <span className="sec-grow" />
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Régénérer les codes de secours ?', message: 'Les anciens codes cesseront de fonctionner.', confirmLabel: 'Régénérer' }))) return;
              const r = await attempt(() => securityApi.recoveryCodes());
              if (r) pendingCodesStore.set(r.recoveryCodes);
            }}
          >
            Régénérer les codes
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Désactiver l’application d’authentification ?', message: 'Les codes de secours seront supprimés.', confirmLabel: 'Désactiver', danger: true }))) return;
              await attempt(() => securityApi.totpDisable(), 'Application d’authentification désactivée');
            }}
          >
            Désactiver
          </button>
        </div>
      ) : (
        <TotpEnrol />
      )}

      <h3 className="sec-subtitle">Clés d’accès</h3>
      {!status.passkeysAvailable ? (
        <p className="sec-muted">Indisponibles sur ce serveur : l’administrateur doit définir une adresse publique en https (PUBLIC_URL).</p>
      ) : (
        <>
          <p className="sec-muted">Connexion sans mot de passe avec Touch ID, Face ID, votre téléphone ou une clé physique.</p>
          {status.passkeys.length > 0 && (
            <ul className="sec-list">
              {status.passkeys.map((p) => (
                <li key={p.id} className="sec-list__item">
                  <KeyRound size={15} />
                  <div className="sec-grow">
                    <div className="sec-strong">{p.name}</div>
                    <div className="sec-muted">
                      Ajoutée le {formatDate(p.createdAt)} · {p.lastUsedAt ? `utilisée ${formatWhen(p.lastUsedAt)}` : 'jamais utilisée'}
                      {p.backedUp ? ' · synchronisée' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      const name = await promptDialog({ title: 'Renommer la clé d’accès', initialValue: p.name, confirmLabel: 'Renommer' });
                      if (name?.trim()) await attempt(() => securityApi.passkeyRename(p.id, name.trim()));
                    }}
                  >
                    Renommer
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-label={`Retirer ${p.name}`}
                    onClick={async () => {
                      if (!(await confirmDialog({ title: `Retirer « ${p.name} » ?`, confirmLabel: 'Retirer', danger: true }))) return;
                      await attempt(() => securityApi.passkeyRemove(p.id), 'Clé d’accès retirée');
                    }}
                  >
                    <Trash size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {passkeysSupported() ? <AddPasskeyButton /> : <p className="sec-muted">Ce navigateur ne prend pas en charge les clés d’accès.</p>}
        </>
      )}
    </Section>
  );
}

function SsoSection({ status }: { status: SecurityStatus }) {
  if (!status.sso) return null;
  const link = async () => {
    const r = await attempt(() => securityApi.oidcStart('link', window.location.pathname));
    if (r) window.location.assign(r.url);
  };
  return (
    <Section title="Connexion d’entreprise" description={`Associez votre compte « ${status.sso.label} » pour vous connecter sans mot de passe Oriel.`}>
      {status.identities.length ? (
        <ul className="sec-list">
          {status.identities.map((i) => (
            <li key={i.issuer} className="sec-list__item">
              <Globe size={15} />
              <div className="sec-grow">
                <div className="sec-strong">{i.email ?? 'Compte associé'}</div>
                <div className="sec-muted">
                  Associé le {formatDate(i.createdAt)}
                  {i.lastLoginAt ? ` · dernière connexion ${formatWhen(i.lastLoginAt)}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Dissocier ce compte ?', confirmLabel: 'Dissocier', danger: true })) await attempt(() => securityApi.unlinkIdentity(i.issuer), 'Compte dissocié');
                }}
              >
                Dissocier
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" className="btn btn--secondary" onClick={() => void link()}>
          Associer mon compte {status.sso.label}
        </button>
      )}
    </Section>
  );
}

function EmailSection() {
  const { user } = useWorkspaceCtx();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await attempt(() => securityApi.changeEmail(email.trim()), 'Adresse e-mail modifiée');
    if (r) {
      queryClient.setQueryData<SessionResponse | null>(qk.session, (old) => (old ? { ...old, user: r.user } : old));
      setEmail('');
    }
    setBusy(false);
  };
  return (
    <Section title="Adresse e-mail" description={<>Adresse actuelle : <strong>{user.email}</strong>. L’ancienne adresse est prévenue du changement.</>}>
      <form className="sec-row" onSubmit={submit}>
        <input className="input sec-grow" type="email" required placeholder="nouvelle@adresse.fr" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" className="btn btn--secondary" disabled={busy || !email.trim()}>
          Modifier
        </button>
      </form>
    </Section>
  );
}

function LogSection() {
  const { user } = useWorkspaceCtx();
  const log = useQuery({ queryKey: securityKeys.log, queryFn: securityApi.log });
  return (
    <Section title="Journal de sécurité" description="Les 50 derniers événements de sécurité de votre compte.">
      {log.isLoading && <Skeleton height={60} />}
      {log.data && log.data.entries.length === 0 && <p className="sec-muted">Aucun événement pour l’instant.</p>}
      {log.data && log.data.entries.length > 0 && (
        <ul className="sec-log">
          {log.data.entries.map((e) => (
            <li key={e.id}>
              <span className="sec-strong">{EVENT_LABELS[e.event] ?? e.event}</span>
              {e.detail ? <span className="sec-muted"> · {e.detail}</span> : null}
              <span className="sec-muted">
                {' '}
                · {formatWhen(e.createdAt)}
                {e.actor && e.actor.id !== user.id ? ` · par ${e.actor.name}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function IncomingTransfers({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const transfers = useQuery({ queryKey: securityKeys.transfers, queryFn: securityApi.transfers });
  if (!transfers.data?.incoming.length) return null;
  const done = () => {
    void qc.invalidateQueries({ queryKey: securityKeys.transfers });
    void qc.invalidateQueries({ queryKey: qk.session });
    void qc.invalidateQueries({ queryKey: qk.workspaces });
  };
  return (
    <div className={compact ? 'sec-card' : undefined}>
      {transfers.data.incoming.map((t) => (
        <div key={t.id} className="sec-transfer">
          <div className="sec-grow">
            <strong>{t.from.name}</strong> vous propose de devenir propriétaire de l’espace <strong>« {t.workspaceName} »</strong>.
            <div className="sec-muted">Expire le {formatDate(t.expiresAt)}.</div>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={async () => (await attempt(() => securityApi.acceptTransfer(t.id), 'Vous êtes propriétaire de l’espace')) && done()}>
            Accepter
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={async () => (await attempt(() => securityApi.declineTransfer(t.id), 'Proposition refusée')) && done()}>
            Refuser
          </button>
        </div>
      ))}
    </div>
  );
}

function TransferSection() {
  const { workspaceId, workspace, role, user } = useWorkspaceCtx();
  const transfers = useQuery({ queryKey: securityKeys.transfers, queryFn: securityApi.transfers });
  const members = useQuery({ queryKey: qk.members(workspaceId), queryFn: () => api.workspaces.members(workspaceId), enabled: role === 'owner' });
  const [target, setTarget] = useState('');
  if (role !== 'owner') return null;
  const outgoing = transfers.data?.outgoing.find((t) => t.workspaceId === workspaceId);
  const candidates = (members.data ?? []).filter((m) => m.user.id !== user.id);
  return (
    <Section
      title="Transférer l’espace"
      description={`Proposez à un membre de devenir propriétaire de « ${workspace.name} ». Il doit accepter ; vous resterez administrateur.`}
      danger
    >
      {outgoing ? (
        <div className="sec-row">
          <span className="sec-grow">
            Proposition envoyée à <strong>{outgoing.to.name}</strong>, en attente jusqu’au {formatDate(outgoing.expiresAt)}.
          </span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void attempt(() => securityApi.cancelTransfer(workspaceId), 'Proposition annulée')}>
            Annuler
          </button>
        </div>
      ) : (
        <div className="sec-row">
          <select className="input sec-grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Nouveau propriétaire">
            <option value="">Choisir un membre…</option>
            {candidates.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name} ({ROLE_LABELS[m.role]})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--danger"
            disabled={!target}
            onClick={async () => {
              const who = candidates.find((m) => m.user.id === target)?.user.name ?? '';
              if (!(await confirmDialog({ title: `Proposer le transfert à ${who} ?`, message: 'Une fois acceptée, vous deviendrez administrateur de l’espace.', confirmLabel: 'Envoyer la proposition', danger: true }))) return;
              if (await attempt(() => securityApi.proposeTransfer(workspaceId, target), 'Proposition envoyée')) setTarget('');
              void queryClient.invalidateQueries({ queryKey: securityKeys.transfers });
            }}
          >
            Proposer
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Workspace policy and domains (managers)
// ---------------------------------------------------------------------------

const GRACE_CHOICES = [0, 3, 7, 14, 30];

function PolicySection({ status }: { status: SecurityStatus }) {
  const { workspaceId, canManage } = useWorkspaceCtx();
  const policy = useQuery({ queryKey: securityKeys.policy(workspaceId), queryFn: () => securityApi.policy(workspaceId), enabled: canManage });
  const [grace, setGrace] = useState(7);
  if (!canManage) return null;
  if (policy.isLoading) return <Skeleton height={80} />;
  if (!policy.data) return null;
  const p = policy.data;
  const self = status.totpEnabled || status.passkeys.length > 0;
  return (
    <Section title="Politique de l’espace" description="Imposer la double authentification à tous les membres de cet espace.">
      {p.require2fa ? (
        <div className="sec-row">
          <span className="sec-pill is-ok">
            <ShieldCheck size={13} /> Imposée
          </span>
          <span className="sec-muted sec-grow">
            {p.graceUntil && p.graceUntil > Date.now() ? `Délai de grâce jusqu’au ${formatDate(p.graceUntil)}.` : 'Les membres non protégés doivent l’activer avant de continuer.'}
          </span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void attempt(() => securityApi.setPolicy(workspaceId, { require2fa: false }), 'Politique retirée')}>
            Ne plus imposer
          </button>
        </div>
      ) : (
        <div className="sec-row">
          <label className="field">
            <span className="field-label">Délai de grâce</span>
            <select className="input" value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
              {GRACE_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? 'Immédiat' : `${d} jours`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!self}
            title={self ? undefined : 'Activez d’abord la double authentification sur votre compte'}
            onClick={async () => {
              const ok = await confirmDialog({
                title: 'Imposer la double authentification ?',
                message: grace === 0 ? `${p.nonCompliant.length} membre(s) non protégé(s) devront l’activer immédiatement.` : `Les membres auront ${grace} jours pour l’activer.`,
                confirmLabel: 'Imposer',
              });
              if (ok) await attempt(() => securityApi.setPolicy(workspaceId, { require2fa: true, graceDays: grace }), 'Double authentification imposée');
            }}
          >
            Imposer
          </button>
        </div>
      )}
      {p.nonCompliant.length > 0 && (
        <p className="sec-muted">
          Non protégés : {p.nonCompliant.slice(0, 12).map((u) => u.name).join(', ')}
          {p.nonCompliant.length > 12 ? ` et ${p.nonCompliant.length - 12} autres` : ''}.
        </p>
      )}
    </Section>
  );
}

function DomainRow({ wid, d }: { wid: string; d: VerifiedDomain }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="sec-list__item sec-domain">
      <Globe size={15} />
      <div className="sec-grow">
        <div className="sec-strong">
          {d.domain} {d.verified ? <span className="sec-pill is-ok">Vérifié</span> : <span className="sec-pill">À vérifier</span>}
        </div>
        {!d.verified && (
          <div className="sec-muted">
            Créez l’enregistrement DNS TXT <code>{d.record.name}</code> avec la valeur <code>{d.record.value}</code>{' '}
            <button type="button" className="link-button" onClick={async () => (await copyToClipboard(d.record.value)) && toast.success('Valeur copiée')}>
              <Copy size={12} />
            </button>
          </div>
        )}
        {d.verified && (
          <label className="sec-row sec-muted">
            <input type="checkbox" checked={d.autoJoin} onChange={(e) => void attempt(() => securityApi.updateDomain(wid, d.domain, { autoJoin: e.target.checked }))} />
            Les personnes de ce domaine (adresse vérifiée par la connexion d’entreprise) rejoignent l’espace comme
            <select className="input input--sm" value={d.joinRole} onChange={(e) => void attempt(() => securityApi.updateDomain(wid, d.domain, { joinRole: e.target.value as 'member' | 'viewer' }))}>
              <option value="member">{ROLE_LABELS.member}</option>
              <option value="viewer">{ROLE_LABELS.viewer}</option>
            </select>
          </label>
        )}
      </div>
      {!d.verified && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await attempt(() => securityApi.verifyDomain(wid, d.domain), 'Domaine vérifié');
            void queryClient.invalidateQueries({ queryKey: securityKeys.domains(wid) });
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={13} /> : 'Vérifier'}
        </button>
      )}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label={`Retirer ${d.domain}`}
        onClick={async () => {
          if (!(await confirmDialog({ title: `Retirer ${d.domain} ?`, confirmLabel: 'Retirer', danger: true }))) return;
          await attempt(() => securityApi.removeDomain(wid, d.domain));
          void queryClient.invalidateQueries({ queryKey: securityKeys.domains(wid) });
        }}
      >
        <X size={14} />
      </button>
    </li>
  );
}

function DomainsSection() {
  const { workspaceId, canManage } = useWorkspaceCtx();
  const domains = useQuery({ queryKey: securityKeys.domains(workspaceId), queryFn: () => securityApi.domains(workspaceId), enabled: canManage });
  const [domain, setDomain] = useState('');
  if (!canManage) return null;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await attempt(() => securityApi.addDomain(workspaceId, domain.trim()))) setDomain('');
    void queryClient.invalidateQueries({ queryKey: securityKeys.domains(workspaceId) });
  };
  return (
    <Section title="Domaines vérifiés" description="Prouvez que vous contrôlez un nom de domaine pour accueillir automatiquement ses adresses.">
      {domains.data && domains.data.domains.length > 0 && (
        <ul className="sec-list">
          {domains.data.domains.map((d) => (
            <DomainRow key={d.domain} wid={workspaceId} d={d} />
          ))}
        </ul>
      )}
      <form className="sec-row" onSubmit={add}>
        <input className="input sec-grow" placeholder="studio.fr" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Nom de domaine" />
        <button type="submit" className="btn btn--secondary" disabled={!domain.trim()}>
          Ajouter
        </button>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Instance administration
// ---------------------------------------------------------------------------

function AdminSection() {
  const { user } = useWorkspaceCtx();
  const users = useQuery({ queryKey: securityKeys.adminUsers, queryFn: securityApi.adminUsers, enabled: user.isAdmin });
  if (!user.isAdmin || !users.data) return null;
  return (
    <Section
      title="Comptes de l’instance"
      description="Si quelqu’un a perdu l’accès à sa double authentification, réinitialisez-la : ses sessions sont fermées et l’action est journalisée."
    >
      <ul className="sec-list">
        {users.data.users.map((u) => (
          <li key={u.userId} className="sec-list__item">
            <div className="sec-grow">
              <div className="sec-strong">{u.name}</div>
              <div className="sec-muted">{u.email}</div>
            </div>
            <span className={`sec-pill${u.totpEnabled || u.passkeys ? ' is-ok' : ''}`}>
              {u.totpEnabled ? 'Application' : ''}
              {u.totpEnabled && u.passkeys ? ' + ' : ''}
              {u.passkeys ? `${u.passkeys} clé(s)` : ''}
              {!u.totpEnabled && !u.passkeys ? 'Mot de passe seul' : ''}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!u.totpEnabled && !u.passkeys}
              onClick={async () => {
                if (!(await confirmDialog({ title: `Réinitialiser la double authentification de ${u.name} ?`, message: 'Application, codes de secours et clés d’accès seront supprimés, et ses sessions fermées.', confirmLabel: 'Réinitialiser', danger: true }))) return;
                await attempt(() => securityApi.adminReset(u.userId), 'Double authentification réinitialisée');
                void queryClient.invalidateQueries({ queryKey: securityKeys.adminUsers });
              }}
            >
              Réinitialiser
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function SecuritySettings() {
  const status = useQuery({ queryKey: securityKeys.status, queryFn: securityApi.status });
  if (status.isLoading) return <Skeleton height={120} />;
  if (status.error || !status.data) return <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />;
  if (!status.data.available) {
    return (
      <Section title="Sécurité" description="Indisponible en mode local : un seul utilisateur, connecté automatiquement depuis cet ordinateur.">
        <p className="sec-muted">Connectez l’app à un serveur Oriel pour utiliser la double authentification et les clés d’accès.</p>
      </Section>
    );
  }
  return (
    <>
      <IncomingTransfers />
      <TwoFactorSection status={status.data} />
      <SsoSection status={status.data} />
      <EmailSection />
      <PolicySection status={status.data} />
      <DomainsSection />
      <TransferSection />
      <AdminSection />
      <LogSection />
    </>
  );
}
