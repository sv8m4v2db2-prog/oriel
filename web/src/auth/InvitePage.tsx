import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ROLE_LABELS, type InviteInfoResponse } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { rememberWorkspace, setSession, useSession } from '../lib/session';
import { logoutWithConfirm } from '../lib/logout';
import { Spinner } from '../components/common';
import { AuthLayout, SignupForm } from './AuthPages';

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  // Not cached through TanStack Query: one-shot public lookup (no key in qk for it).
  const [info, setInfo] = useState<{ isLoading: boolean; data: InviteInfoResponse | null }>({ isLoading: true, data: null });
  useEffect(() => {
    let cancelled = false;
    setInfo({ isLoading: true, data: null });
    api.invites
      .info(token)
      .then((data) => !cancelled && setInfo({ isLoading: false, data }))
      .catch(() => !cancelled && setInfo({ isLoading: false, data: null }));
    return () => {
      cancelled = true;
    };
  }, [token]);
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.invites.accept(token);
      await queryClient.invalidateQueries({ queryKey: qk.session });
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      rememberWorkspace(res.workspace.id);
      navigate(`/w/${res.workspace.id}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'Impossible de rejoindre l’espace.'));
    } finally {
      setBusy(false);
    }
  };

  /** After signup / login: join (the signup may already have done it), then open the workspace. */
  const joinAfterAuth = async () => {
    try {
      const res = await api.invites.accept(token);
      rememberWorkspace(res.workspace.id);
    } catch {
      if (info.data?.workspace) rememberWorkspace(info.data.workspace.id);
    }
    await queryClient.invalidateQueries({ queryKey: qk.session });
    await queryClient.invalidateQueries({ queryKey: qk.workspaces });
    navigate(info.data?.workspace ? `/w/${info.data.workspace.id}` : '/', { replace: true });
  };

  if (info.isLoading || session.isLoading) {
    return (
      <div className="center-screen">
        <Spinner size={22} />
      </div>
    );
  }

  if (!info.data || !info.data.valid || !info.data.workspace) {
    return (
      <AuthLayout title="Invitation invalide" subtitle="Ce lien d’invitation a expiré, a été révoqué ou n’existe pas. Demandez-en un nouveau.">
        <Link to="/" className="btn btn--secondary btn--block">
          Retour à l’accueil
        </Link>
      </AuthLayout>
    );
  }

  const ws = info.data.workspace;
  const role = info.data.role ? ROLE_LABELS[info.data.role] : null;
  const subtitle = (
    <>
      {info.data.invitedBy?.name ? `${info.data.invitedBy.name} vous invite` : 'Vous êtes invité·e'} à rejoindre{' '}
      <strong>
        {ws.icon ? `${ws.icon} ` : ''}
        {ws.name}
      </strong>
      {role ? ` en tant que ${role.toLowerCase()}` : ''}.
    </>
  );

  if (session.data) {
    return (
      <AuthLayout title="Rejoindre l’espace" subtitle={subtitle}>
        <p className="auth__note">
          Connecté·e en tant que <strong>{session.data.user.email}</strong>.
        </p>
        {error && <div className="form-error">{error}</div>}
        <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={accept}>
          {busy ? <Spinner size={15} /> : 'Rejoindre l’espace'}
        </button>
        <button type="button" className="btn btn--ghost btn--block" onClick={() => void logoutWithConfirm()}>
          Utiliser un autre compte
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Rejoindre l’espace" subtitle={subtitle}>
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-active' : ''} onClick={() => setMode('signup')}>
          Créer un compte
        </button>
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => setMode('login')}>
          J’ai déjà un compte
        </button>
      </div>
      {mode === 'signup' ? (
        <SignupForm inviteToken={token} submitLabel="Créer mon compte et rejoindre" onDone={joinAfterAuth} />
      ) : (
        <InviteLogin onDone={joinAfterAuth} />
      )}
    </AuthLayout>
  );
}

function InviteLogin({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.login({ email: email.trim(), password });
      setSession(res);
      await onDone();
    } catch (err) {
      setError(errorMessage(err, 'Connexion impossible.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth__form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Adresse e-mail</span>
        <input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Mot de passe</span>
        <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? <Spinner size={15} /> : 'Se connecter et rejoindre'}
      </button>
    </form>
  );
}
