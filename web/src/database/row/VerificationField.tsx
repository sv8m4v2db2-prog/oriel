// Verification property (D21, SPEC §5.9): badge (cells, row page) and editor (verify for a duration or
// until a date, remove). The server stamps who verified and when; the client only chooses the expiry.
import { useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { VerificationValue } from '@oriel/shared';
import { useSession } from '../../lib/session';
import { useDb } from '../context';
import { formatDate } from '../logic/format';
import { Btn, cx } from '../ui/primitives';
import { asVerification, EXPIRY_PRESETS, expiryFrom, localDay, verificationState, VERIFICATION_STATE_LABELS } from './verification';
import './g3.css';

const dayLabel = (day: string) => formatDate(new Date(`${day}T12:00:00`));

export function VerificationBadge({ value, detailed = false }: { value: unknown; detailed?: boolean }) {
  const { ctx } = useDb();
  const v = asVerification(value);
  const state = verificationState(v);
  if (!v || state === 'none') return null;
  const who = ctx.users.get(v.verifiedBy)?.name ?? 'une personne';
  const detail = `${VERIFICATION_STATE_LABELS[state]} par ${who} le ${formatDate(new Date(v.verifiedAt))}${
    v.expiresAt ? (state === 'expired' ? ` — expirée le ${dayLabel(v.expiresAt)}` : ` — jusqu'au ${dayLabel(v.expiresAt)}`) : ''
  }`;
  return (
    <span className={cx('ordb-verif', `is-${state}`)} title={detail}>
      {state === 'verified' ? <ShieldCheck size={13} aria-hidden /> : <ShieldAlert size={13} aria-hidden />}
      <span className="ordb-ellipsis">{detailed ? detail : VERIFICATION_STATE_LABELS[state]}</span>
    </span>
  );
}

export function VerificationEditor({
  value,
  onChange,
  onDone,
}: {
  value: unknown;
  onChange: (v: VerificationValue | null) => void;
  onDone: () => void;
}) {
  const me = useSession().data?.user.id ?? '';
  const current = asVerification(value);
  const [until, setUntil] = useState(() => expiryFrom('month') ?? localDay());
  const verify = (expiresAt: string | null) => {
    // verifiedBy / verifiedAt are replaced by the server (the writer, now); sent for the optimistic display.
    onChange({ verifiedBy: me, verifiedAt: new Date().toISOString(), expiresAt });
    onDone();
  };
  return (
    <div className="ordb-verif-editor">
      {current ? (
        <div className="ordb-verif-current">
          <VerificationBadge value={current} detailed />
        </div>
      ) : (
        <div className="ordb-menu-hint">Cette page n'est pas vérifiée.</div>
      )}
      <div className="ordb-menu-label">{current ? 'Vérifier à nouveau' : 'Vérifier'}, valable :</div>
      <div className="ordb-verif-presets">
        {EXPIRY_PRESETS.map((p) => (
          <Btn key={p.id} size="sm" variant="outline" onClick={() => verify(expiryFrom(p.id))}>
            {p.label}
          </Btn>
        ))}
      </div>
      <form
        className="ordb-verif-until"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^\d{4}-\d{2}-\d{2}$/.test(until)) verify(until);
        }}
      >
        <label>
          Jusqu'au <input type="date" value={until} min={localDay()} onChange={(e) => setUntil(e.target.value)} aria-label="Date d'expiration" />
        </label>
        <Btn size="sm" variant="primary" type="submit">
          Vérifier
        </Btn>
      </form>
      {current && (
        <Btn
          size="sm"
          variant="danger"
          onClick={() => {
            onChange(null);
            onDone();
          }}
        >
          Retirer la vérification
        </Btn>
      )}
    </div>
  );
}
