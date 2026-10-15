// "Confirmez votre identité": opened when the server answers 403 `reauth_required` to a sensitive
// action (lib/api.ts onApiErrorCode, wired in App.tsx); the action is replayed after confirmation.
import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@mantine/core';
import { Fingerprint, LogIn } from 'lucide-react';
import type { ReauthMethod } from '@oriel/shared';
import { createStore, useStore } from '../lib/store';
import { errorMessage } from '../lib/queryClient';
import { Spinner } from '../components/common';
import { securityApi } from './securityApi';
import { getPasskey, passkeyError, passkeysSupported } from './webauthn';

const reauthStore = createStore<{ resolve: (ok: boolean) => void } | null>(null);
let pending: Promise<boolean> | null = null;

/** Opens the dialog (one at a time: concurrent requests share it). Resolves true once confirmed. */
export function requestReauth(): Promise<boolean> {
  pending ??= new Promise<boolean>((resolve) => reauthStore.set({ resolve })).finally(() => {
    pending = null;
  });
  return pending;
}

export function ReauthHost() {
  const req = useStore(reauthStore);
  const [methods, setMethods] = useState<ReauthMethod[] | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) return;
    setMethods(null);
    setPassword('');
    setCode('');
    setError(null);
    securityApi
      .reauthOptions()
      .then((r) => setMethods(r.methods))
      .catch((err) => setError(errorMessage(err)));
  }, [req]);

  const close = (ok: boolean) => {
    req?.resolve(ok);
    reauthStore.set(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      close(true);
    } catch (err) {
      setError(errorMessage(err, 'Identité non confirmée.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => securityApi.reauth(methods?.includes('totp') ? { code: code.trim() } : { password }));
  };

  const withPasskey = () =>
    run(async () => {
      const { ticket, options } = await securityApi.reauthPasskeyOptions();
      let passkey;
      try {
        passkey = await getPasskey(options);
      } catch (err) {
        throw new Error(passkeyError(err));
      }
      await securityApi.reauth({ ticket, passkey });
    });

  const withSso = async () => {
    try {
      const { url } = await securityApi.oidcStart('reauth', window.location.pathname);
      close(false);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const hasForm = methods?.includes('totp') || methods?.includes('password');
  return (
    <Modal opened={!!req} onClose={() => close(false)} title="Confirmez votre identité" centered size="sm">
      <p className="sec-muted">Cette action est sensible : confirmez qu’il s’agit bien de vous. Vous ne le referez pas avant 10 minutes.</p>
      {!methods && !error && <Spinner />}
      {methods && (
        <div className="auth__form">
          {methods.includes('passkey') && passkeysSupported() && (
            <button type="button" className="btn btn--secondary btn--block" disabled={busy} onClick={() => void withPasskey()}>
              <Fingerprint size={16} /> Utiliser ma clé d’accès
            </button>
          )}
          {hasForm && (
            <form className="auth__form" onSubmit={submit}>
              {methods.includes('totp') ? (
                <label className="field">
                  <span className="field-label">Code de l’application d’authentification</span>
                  <input
                    className="input sec-code-input"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={7}
                    required
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">Mot de passe</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    required
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              )}
              <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
                {busy ? <Spinner size={15} /> : 'Confirmer'}
              </button>
            </form>
          )}
          {methods.includes('sso') && (
            <button type="button" className="btn btn--secondary btn--block" disabled={busy} onClick={() => void withSso()}>
              <LogIn size={16} /> Confirmer avec la connexion d’entreprise
            </button>
          )}
          {methods.length === 0 && <p className="sec-muted">Aucune méthode disponible : déconnectez-vous puis reconnectez-vous.</p>}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
