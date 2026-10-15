// Home card of the security module: incoming workspace transfers, and the deadline of a workspace
// that will require two-factor authentication.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { formatDate } from '../lib/util';
import { useWorkspaceCtx } from '../shell/WorkspaceContext';
import { securityApi, securityKeys } from './securityApi';
import { IncomingTransfers } from './SecuritySettings';
import './security.css';

export function SecurityHomeCard() {
  const { workspaceId } = useWorkspaceCtx();
  const status = useQuery({ queryKey: securityKeys.status, queryFn: securityApi.status, staleTime: 60_000 });
  const s = status.data;
  const unprotected = s && s.available && !s.totpEnabled && s.passkeys.length === 0;
  const upcoming = unprotected ? s.requiredBy.filter((r) => r.graceUntil && r.graceUntil > Date.now()) : [];
  return (
    <>
      {s?.available && <IncomingTransfers compact />}
      {upcoming.map((r) => (
        <div key={r.workspaceId} className="sec-card sec-card--warn">
          <ShieldAlert size={16} />
          <span className="sec-grow">
            L’espace « {r.workspaceName} » impose la double authentification à partir du {formatDate(r.graceUntil!)}.
          </span>
          <Link to={`/w/${workspaceId}/settings/security`} className="btn btn--primary btn--sm">
            L’activer
          </Link>
        </div>
      ))}
    </>
  );
}
