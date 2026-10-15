// "Mot de passe oublié ?" and "Choisir un nouveau mot de passe" (link received by e-mail or
// created by an instance administrator).
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isMfaChallenge, LIMITS, type LoginResponse } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { setSession, useSession } from '../lib/session';
import { Spinner } from '../components/common';
import { collabApi } from '../collab/api';
import { ck } from '../collab/keys';
import { AuthLayout } from './AuthPages';
import './auth.css';

export function ForgotPasswordPage() {
  const session = useSession();
  const config = useQuery({ queryKey: ck.passwordConfig, queryFn: collabApi.passwordConfig, staleTime: 60_000 });
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.data) return <Navigate to="/" replace />;
  const emailEnabled = config.data?.emailEnabled ?? true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await collabApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, 'Envoi impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <Link to="/login">Retour à la connexion</Link>
    </>
  );

  if (!emailEnabled) {
    return (
      <AuthLayout title="Mot de passe oublié" footer={footer}>
        <p className="auth__note">
          L’envoi d’e-mails n’est pas configuré sur ce serveur. Demandez à un administrateur de l’instance de créer un lien de réinitialisation
          (Réglages › Instance › Utilisateurs).
        </p>
        <Link to="/login" className="btn btn--secondary btn--block">
          Retour à la connexion
        </Link>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout title="Vérifiez vos e-mails" footer={footer}>
        <p className="auth__note">
          Si un compte existe pour <strong>{email.trim()}</strong>, un e-mail contenant un lien de réinitialisation vient d’être envoyé. Le lien est valable
          1 heure.
        </p>
        <p className="auth__note">Pensez à vérifier vos courriers indésirables.</p>
        <Link to="/login" className="btn btn--secondary btn--block">
          Retour à la connexion
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Mot de passe oublié" subtitle="Indiquez l’adresse e-mail de votre compte : nous vous enverrons un lien pour choisir un nouveau mot de passe." footer={footer}>
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Adresse e-mail</span>
          <input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? <Spinner size={15} /> : 'Envoyer le lien'}
        </button>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['collab-reset-token', token], queryFn: () => collabApi.resetInfo(token), retry: false, staleTime: Infinity });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (info.isLoading) {
    return (
      <div className="center-screen">
        <Spinner size={22} />
      </div>
    );
  }

  if (!info.data?.valid) {
    return (
      <AuthLayout title="Lien expiré ou invalide" footer={<Link to="/login">Retour à la connexion</Link>}>
        <p className="auth__note">Ce lien de réinitialisation a déjà été utilisé, a expiré ou est incorrect. Demandez-en un nouveau.</p>
        <Link to="/forgot-password" className="btn btn--primary btn--block">
          Demander un nouveau lien
        </Link>
      </AuthLayout>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < LIMITS.passwordMin) return setError(`Le mot de passe doit contenir au moins ${LIMITS.passwordMin} caractères.`);
    if (password !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    try {
      const result = (await collabApi.resetPassword(token, password)) as LoginResponse;
      // Protected account: the new password is set, the second step is still required (G9).
      if (isMfaChallenge(result)) navigate('/login', { replace: true, state: { mfa: result.mfa } });
      else {
        setSession(result);
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err, 'Réinitialisation impossible.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Nouveau mot de passe"
      subtitle={
        <>
          Choisissez un nouveau mot de passe pour <strong>{info.data.email}</strong>. Vos autres sessions seront fermées.
        </>
      }
      footer={<Link to="/login">Retour à la connexion</Link>}
    >
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Nouveau mot de passe</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={LIMITS.passwordMin}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field-hint">{LIMITS.passwordMin} caractères minimum.</span>
        </label>
        <label className="field">
          <span className="field-label">Confirmer le mot de passe</span>
          <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? <Spinner size={15} /> : 'Enregistrer et se connecter'}
        </button>
      </form>
    </AuthLayout>
  );
}
