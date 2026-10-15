// Second step of a sign-in (account protected by two-factor authentication): code of the authenticator
// app, recovery code or passkey. The pending ticket comes from the login response, or from a cookie
// after a redirect (SSO).
import { useState, type FormEvent } from 'react';
import { Fingerprint, KeyRound, Smartphone } from 'lucide-react';
import type { SecondFactorMethod, SessionResponse } from '@oriel/shared';
import { errorMessage } from '../lib/queryClient';
import { Spinner } from '../components/common';
import { securityApi } from './securityApi';
import { getPasskey, passkeyError, passkeysSupported } from './webauthn';

export function MfaStep({
  ticket,
  methods,
  onDone,
  onCancel,
}: {
  ticket?: string;
  methods: SecondFactorMethod[];
  onDone: (session: SessionResponse) => void;
  onCancel: () => void;
}) {
  const canPasskey = methods.includes('passkey') && passkeysSupported();
  const initial = methods.includes('totp') ? 'totp' : canPasskey ? 'passkey' : 'recovery';
  const [mode, setMode] = useState<'totp' | 'recovery' | 'passkey'>(initial);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<SessionResponse>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(errorMessage(err, 'Vérification impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => securityApi.loginMfa(mode === 'totp' ? { ticket, code: code.trim() } : { ticket, recoveryCode: code.trim() }));
  };

  const usePasskey = () =>
    run(async () => {
      const { options } = await securityApi.loginMfaPasskeyOptions(ticket);
      let response;
      try {
        response = await getPasskey(options);
      } catch (err) {
        throw new Error(passkeyError(err));
      }
      return securityApi.loginMfa({ ticket, passkey: response });
    });

  return (
    <div className="auth__form">
      {mode === 'passkey' ? (
        <>
          <p className="auth__note">Utilisez la clé d’accès enregistrée sur votre compte (Touch ID, téléphone, clé physique…).</p>
          <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => void usePasskey()}>
            {busy ? <Spinner size={15} /> : (
              <>
                <Fingerprint size={16} /> Utiliser ma clé d’accès
              </>
            )}
          </button>
        </>
      ) : (
        <form className="auth__form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{mode === 'totp' ? 'Code de l’application d’authentification' : 'Code de secours'}</span>
            <input
              className="input sec-code-input"
              autoComplete="one-time-code"
              inputMode={mode === 'totp' ? 'numeric' : 'text'}
              pattern={mode === 'totp' ? '[0-9 ]{6,7}' : undefined}
              maxLength={mode === 'totp' ? 7 : 20}
              placeholder={mode === 'totp' ? '123 456' : 'XXXX-XXXX-XXXX'}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? <Spinner size={15} /> : 'Vérifier'}
          </button>
        </form>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="sec-alt">
        {mode !== 'totp' && methods.includes('totp') && (
          <button type="button" className="link-button" onClick={() => (setMode('totp'), setCode(''))}>
            <Smartphone size={14} /> Code de l’application
          </button>
        )}
        {mode !== 'passkey' && canPasskey && (
          <button type="button" className="link-button" onClick={() => setMode('passkey')}>
            <Fingerprint size={14} /> Clé d’accès
          </button>
        )}
        {mode !== 'recovery' && methods.includes('recovery') && (
          <button type="button" className="link-button" onClick={() => (setMode('recovery'), setCode(''))}>
            <KeyRound size={14} /> Code de secours
          </button>
        )}
        <button type="button" className="link-button" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  );
}
