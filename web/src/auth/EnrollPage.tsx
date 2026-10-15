// Enrolment page: shown when a workspace requires two-factor authentication and the grace period is
// over (the server answers 403 `mfa_enrollment_required` to everything else).
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { logout, useSession } from '../lib/session';
import { Spinner } from '../components/common';
import { formatDate } from '../lib/util';
import { AuthLayout } from './AuthPages';
import { securityApi, securityKeys } from './securityApi';
import { AddPasskeyButton, IncomingTransfers, PendingRecoveryCodes, TotpEnrol, usePendingRecoveryCodes } from './SecuritySettings';
import { passkeysSupported } from './webauthn';
import './security.css';

export function EnrollPage() {
  const session = useSession();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: securityKeys.status, queryFn: securityApi.status, enabled: !!session.data });
  const pendingCodes = usePendingRecoveryCodes();
  if (session.isLoading || status.isLoading) {
    return (
      <div className="center-screen">
        <Spinner size={22} />
      </div>
    );
  }
  if (!session.data) {
    return (
      <AuthLayout title="Double authentification requise">
        <Link to="/login" className="btn btn--primary btn--block">
          Se connecter
        </Link>
      </AuthLayout>
    );
  }
  const s = status.data;
  const done = s && !s.enrollmentRequired;
  return (
    <AuthLayout
      title="Activez la double authentification"
      subtitle={
        <>
          {s?.requiredBy.map((r) => `« ${r.workspaceName} »`).join(', ') || 'Un espace'} impose une seconde preuve d’identité à ses membres
          {s?.requiredBy[0]?.graceUntil ? ` depuis le ${formatDate(s.requiredBy[0].graceUntil)}` : ''}.
        </>
      }
      footer={
        <button type="button" className="link-button" onClick={() => void logout()}>
          Se déconnecter
        </button>
      }
    >
      {pendingCodes ? (
        <PendingRecoveryCodes />
      ) : done ? (
        <div className="auth__form">
          <div className="sec-status is-ok">Votre compte est protégé.</div>
          <button type="button" className="btn btn--primary btn--block" onClick={() => navigate('/', { replace: true })}>
            Continuer vers Oriel
          </button>
        </div>
      ) : (
        <div className="auth__form">
          <div className="sec-status is-warn">
            <ShieldAlert size={16} /> Choisissez une méthode pour continuer.
          </div>
          <TotpEnrol onDone={() => void status.refetch()} />
          {s?.passkeysAvailable && passkeysSupported() && <AddPasskeyButton onDone={() => void status.refetch()} />}
          <IncomingTransfers compact />
        </div>
      )}
    </AuthLayout>
  );
}
