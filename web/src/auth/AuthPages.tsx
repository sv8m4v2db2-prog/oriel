import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Fingerprint, LogIn } from 'lucide-react';
import { isMfaChallenge, LIMITS, type LoginResponse, type SecondFactorMethod, type SessionResponse } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/queryClient';
import { setSession, useAuthConfig, useSession } from '../lib/session';
import { Logo, Spinner } from '../components/common';
import { desktop } from '../lib/desktop';
import { safeNext } from './next';
import { MfaStep } from './MfaStep';
import { securityApi } from './securityApi';
import { getPasskey, passkeyError, passkeysSupported } from './webauthn';
import './auth.css';
import './security.css';

/** Messages of the SSO callback errors (`?sso_error=`). */
const SSO_ERRORS: Record<string, string> = {
  expired: 'La connexion d’entreprise a expiré ou a été ouverte dans un autre navigateur : recommencez.',
  invalid: 'La réponse du fournisseur d’identité a été refusée.',
  denied: 'Connexion annulée chez le fournisseur d’identité.',
  link_required:
    'Un compte Oriel existe déjà avec cette adresse : connectez-vous avec votre mot de passe, puis associez votre compte d’entreprise dans Réglages › Sécurité.',
  signup_closed: 'Aucun compte Oriel n’est associé à cette identité et les inscriptions sont fermées.',
  unavailable: 'La connexion d’entreprise n’est pas configurée sur ce serveur.',
  rate_limited: 'Trop de tentatives. Réessayez dans une minute.',
};

const VALID_METHODS: SecondFactorMethod[] = ['totp', 'recovery', 'passkey'];

export { safeNext };

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth__drag" />
      <main className="auth__card">
        <div className="auth__brand">
          <Logo size={36} />
          <span>Oriel</span>
        </div>
        <h1 className="auth__title">{title}</h1>
        {subtitle && <p className="auth__subtitle">{subtitle}</p>}
        {children}
      </main>
      {footer && <div className="auth__footer">{footer}</div>}
      {desktop && (
        <button type="button" className="link-button auth__server" onClick={() => desktop?.openSetup()}>
          Changer de serveur…
        </button>
      )}
    </div>
  );
}

function FullScreenSpinner() {
  return (
    <div className="center-screen">
      <Spinner size={22} />
    </div>
  );
}

export function LoginPage() {
  const session = useSession();
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const location = useLocation();
  const ssoError = params.get('sso_error');
  const [error, setError] = useState<string | null>(ssoError ? (SSO_ERRORS[ssoError] ?? 'Connexion d’entreprise impossible.') : null);
  const [busy, setBusy] = useState(false);
  // Pending second step: from the login response, a password reset (router state) or an SSO redirect
  // (`?mfa=totp,recovery`, ticket in an http-only cookie).
  const [mfa, setMfa] = useState<{ ticket?: string; methods: SecondFactorMethod[] } | null>(() => {
    const fromState = (location.state as { mfa?: { ticket: string; methods: SecondFactorMethod[] } } | null)?.mfa;
    if (fromState) return fromState;
    const fromUrl = params.get('mfa');
    if (!fromUrl) return null;
    const methods = fromUrl.split(',').filter((m): m is SecondFactorMethod => (VALID_METHODS as string[]).includes(m));
    return methods.length ? { methods } : null;
  });
  const next = safeNext(params.get('next'));

  if (session.isLoading) return <FullScreenSpinner />;
  if (session.data) return <Navigate to={next} replace />;
  if (config.data && !config.data.hasUsers) return <Navigate to="/signup" replace />;

  const finish = (res: SessionResponse) => {
    setSession(res);
    navigate(next, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = (await api.auth.login({ email: email.trim(), password })) as LoginResponse;
      if (isMfaChallenge(res)) setMfa(res.mfa);
      else finish(res);
    } catch (err) {
      setError(errorMessage(err, 'Connexion impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ticket, options } = await securityApi.passkeyOptions();
      let response;
      try {
        response = await getPasskey(options);
      } catch (err) {
        throw new Error(passkeyError(err));
      }
      finish(await securityApi.passkeyLogin(ticket, response));
    } catch (err) {
      setError(errorMessage(err, 'Connexion impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const withSso = async () => {
    setBusy(true);
    try {
      const { url } = await securityApi.oidcStart('login', next);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err, 'Connexion d’entreprise impossible.'));
      setBusy(false);
    }
  };

  if (mfa) {
    return (
      <AuthLayout title="Vérification en deux étapes" subtitle="Votre compte est protégé par la double authentification.">
        <MfaStep
          ticket={mfa.ticket}
          methods={mfa.methods}
          onDone={finish}
          onCancel={() => {
            setMfa(null);
            setPassword('');
            navigate('/login', { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  const signupOpen = config.data?.signupMode === 'open';
  return (
    <AuthLayout
      title="Connexion"
      subtitle="Retrouvez vos pages et vos bases de données."
      footer={
        signupOpen ? (
          <>
            Pas encore de compte ? <Link to="/signup">Créer un compte</Link>
          </>
        ) : (
          'Pas de compte ? L’inscription se fait sur invitation d’un membre.'
        )
      }
    >
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Adresse e-mail</span>
          <input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Mot de passe</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Link to="/forgot-password" className="auth__forgot">
            Mot de passe oublié ?
          </Link>
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? <Spinner size={15} /> : 'Se connecter'}
        </button>
      </form>
      {(config.data?.passkeys && passkeysSupported()) || config.data?.sso ? (
        <div className="sec-login-alt">
          <div className="sec-login-alt__sep">ou</div>
          {config.data?.passkeys && passkeysSupported() && (
            <button type="button" className="btn btn--secondary btn--block" disabled={busy} onClick={() => void withPasskey()}>
              <Fingerprint size={16} /> Se connecter avec une clé d’accès
            </button>
          )}
          {config.data?.sso && (
            <button type="button" className="btn btn--secondary btn--block" disabled={busy} onClick={() => void withSso()}>
              <LogIn size={16} /> Continuer avec {config.data.sso.label}
            </button>
          )}
        </div>
      ) : null}
    </AuthLayout>
  );
}

export function SignupForm({
  inviteToken,
  submitLabel,
  onDone,
}: {
  inviteToken?: string;
  submitLabel: string;
  onDone: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < LIMITS.passwordMin) {
      setError(`Le mot de passe doit contenir au moins ${LIMITS.passwordMin} caractères.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.auth.signup({ name: name.trim(), email: email.trim(), password, inviteToken });
      setSession(res);
      await onDone();
    } catch (err) {
      setError(errorMessage(err, 'Inscription impossible.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth__form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Nom</span>
        <input className="input" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Adresse e-mail</span>
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Mot de passe</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          minLength={LIMITS.passwordMin}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="field-hint">{LIMITS.passwordMin} caractères minimum.</span>
      </label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? <Spinner size={15} /> : submitLabel}
      </button>
    </form>
  );
}

export function SignupPage() {
  const session = useSession();
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const inviteToken = params.get('invite') ?? undefined;

  if (session.isLoading || config.isLoading) return <FullScreenSpinner />;
  if (session.data) return <Navigate to="/" replace />;

  const hasUsers = config.data?.hasUsers ?? true;
  const open = config.data?.signupMode === 'open';
  const firstUser = !hasUsers;

  if (!firstUser && !open && !inviteToken) {
    return (
      <AuthLayout
        title="Inscription sur invitation"
        subtitle="Cette instance n’accepte de nouveaux comptes que via un lien d’invitation. Demandez-en un à un administrateur de votre espace."
        footer={
          <>
            Déjà un compte ? <Link to="/login">Se connecter</Link>
          </>
        }
      >
        <Link to="/login" className="btn btn--secondary btn--block">
          Aller à la connexion
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={firstUser ? 'Bienvenue sur Oriel' : 'Créer un compte'}
      subtitle={
        firstUser
          ? 'Créez le premier compte : il deviendra l’administrateur de cette instance, et un espace de travail vous sera préparé.'
          : 'Quelques informations pour commencer.'
      }
      footer={
        hasUsers ? (
          <>
            Déjà un compte ? <Link to="/login">Se connecter</Link>
          </>
        ) : undefined
      }
    >
      <SignupForm
        inviteToken={inviteToken}
        submitLabel={firstUser ? 'Créer le compte administrateur' : 'Créer mon compte'}
        onDone={() => navigate('/', { replace: true })}
      />
    </AuthLayout>
  );
}
