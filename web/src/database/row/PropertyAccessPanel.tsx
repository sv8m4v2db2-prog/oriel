// « Droits d'accès » of a property (D30, SPEC §5.9): who sees it and who edits its values, by workspace
// role. Shown to workspace owners/admins only, who always keep both rights. The server applies the rule
// to every output (schema, rows, public views, forms, exports, AI brief…).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PAGE_METADATA_PROPERTY_TYPES, type PropertyAccessRole, type PropertyDef } from '@oriel/shared';
import { api, ApiError } from '../../lib/api';
import { databaseKey, rowsKey } from '../data';
import { useDb } from '../context';
import { Btn, MenuLabel, PanelHeader, Toggle } from '../ui/primitives';
import './g3.css';

const ROLE_LABELS: Record<PropertyAccessRole, string> = { member: 'Membres', viewer: 'Lecteurs' };

/** Short summary of a property's permissions, or null when unrestricted. */
export function accessSummary(prop: PropertyDef): string | null {
  const read = prop.access?.readRoles;
  const edit = prop.access?.editRoles;
  if (!read && !edit) return null;
  if (read) {
    const extra = read.map((r) => ROLE_LABELS[r].toLowerCase());
    return extra.length ? `Visible : administrateurs, ${extra.join(', ')}` : 'Visible : administrateurs';
  }
  return 'Modifiable : administrateurs';
}

export function PropertyAccessPanel({ prop, onBack }: { prop: PropertyDef; onBack: () => void }) {
  const { databaseId, reportError } = useDb();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const read = prop.access?.readRoles;
  const edit = prop.access?.editRoles;
  const sees = (r: PropertyAccessRole) => !read || read.includes(r);
  const memberEdits = sees('member') && (!edit || edit.includes('member'));
  // QA-G3-04: creator, last editor and their dates appear on every page; the server refuses rights on them.
  const metadata = PAGE_METADATA_PROPERTY_TYPES.includes(prop.type);
  const twoWay = prop.type === 'relation' && !!prop.relation?.syncedPropertyId;

  const save = async (body: { readRoles?: PropertyAccessRole[] | null; editRoles?: PropertyAccessRole[] | null }) => {
    setBusy(true);
    try {
      await api.databases.setPropertyAccess(databaseId, prop.id, body);
      await Promise.all([
        qc.invalidateQueries({ queryKey: databaseKey(databaseId, false) }),
        qc.invalidateQueries({ queryKey: rowsKey(databaseId, false) }),
      ]);
    } catch (err) {
      reportError(err instanceof ApiError ? err.message : 'Enregistrement des droits impossible.');
    } finally {
      setBusy(false);
    }
  };

  const toggleRead = (role: PropertyAccessRole, on: boolean) => {
    const next = (['member', 'viewer'] as const).filter((r) => (r === role ? on : sees(r)));
    void save({ readRoles: next.length === 2 ? null : next });
  };

  return (
    <>
      <PanelHeader title="Droits d'accès" onBack={onBack} />
      <div className="ordb-panel-body ordb-access-panel">
        <MenuLabel>Qui peut voir « {prop.name} »</MenuLabel>
        {(['member', 'viewer'] as const).map((r) => (
          <Toggle key={r} label={ROLE_LABELS[r]} checked={sees(r)} disabled={busy || metadata} onChange={(on) => toggleRead(r, on)} />
        ))}
        <MenuLabel>Qui peut la modifier</MenuLabel>
        <Toggle
          label={ROLE_LABELS.member}
          checked={memberEdits}
          disabled={busy || metadata || !sees('member')}
          onChange={(on) => void save({ editRoles: on ? null : [] })}
        />
        {metadata && (
          <p className="ordb-menu-hint">
            Ces droits ne s'appliquent pas à cette propriété : l'auteur et les dates de création et de modification figurent sur
            chaque page.
            {(read || edit) && (
              <>
                {' '}
                <Btn size="sm" disabled={busy} onClick={() => void save({ readRoles: null, editRoles: null })}>
                  Retirer la restriction
                </Btn>
              </>
            )}
          </p>
        )}
        {twoWay && !metadata && (
          <p className="ordb-menu-hint">Ces droits valent aussi pour la relation liée dans l'autre base, qui contient les mêmes liens.</p>
        )}
        <p className="ordb-menu-hint">
          Les propriétaires et administrateurs de l'espace voient et modifient toujours cette propriété. Pour les autres, une
          propriété masquée disparaît partout : vues, page de la ligne, pages publiées, formulaires, exports, recherche et
          brief IA. Les lecteurs ne modifient jamais rien.
        </p>
      </div>
    </>
  );
}
