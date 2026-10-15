// CSV import: map each column to the title, an existing property or a new property (type
// inferred from the values), then import (optionally updating the rows that have the same title).
import { useMemo, useState } from 'react';
import { Modal } from '@mantine/core';
import type { DatabaseSchema, PropertyDef, PropertyType, PropertyValue } from '@oriel/shared';
import { PROPERTY_TYPE_LABELS } from '@oriel/shared';
import { api } from '../../lib/api';
import { toast } from '../../lib/ui';
import { useDb } from '../context';
import { errorMessage } from '../data';
import { csvToValue, importableProperty, inferColumnType, inferNumberFormat, missingOptions, type ParsedCsv } from '../logic/csv';
import { normalizeText } from '../logic/text';
import { newPropertyDef, uniquePropertyName } from '../logic/properties';
import { Btn, NativeSelect, Toggle } from '../ui/primitives';

const NEW_TYPES: PropertyType[] = [
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'person',
  'files',
];

interface ColumnMapping {
  /** 'skip' | 'title' | 'new' | property id */
  target: string;
  newType: PropertyType;
}

const CHUNK = 1000;

export function CsvImportModal({ csv, fileName, onClose }: { csv: ParsedCsv; fileName: string; onClose: () => void }) {
  const { properties, m, members, databaseId } = useDb();
  const titleProp = properties.find((p) => p.type === 'title')!;
  const targets = properties.filter((p) => p.type !== 'title' && importableProperty(p));

  const initial = useMemo<ColumnMapping[]>(() => {
    const used = new Set<string>();
    let titleTaken = false;
    const byName = (h: string) => properties.find((p) => normalizeText(p.name) === normalizeText(h));
    const out = csv.headers.map((h, i) => {
      const values = csv.rows.map((r) => r[i] ?? '');
      const newType = inferColumnType(values);
      const match = byName(h);
      if (match && !used.has(match.id) && importableProperty(match)) {
        used.add(match.id);
        if (match.type === 'title') titleTaken = true;
        return { target: match.type === 'title' ? 'title' : match.id, newType };
      }
      return { target: 'new', newType };
    });
    if (!titleTaken && out.length > 0) {
      const first = out.findIndex((c) => c.target === 'new');
      if (first !== -1) out[first] = { ...out[first]!, target: 'title' };
    }
    return out;
  }, [csv, properties]);

  const [mapping, setMapping] = useState<ColumnMapping[]>(initial);
  const [updateByTitle, setUpdateByTitle] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleColumn = mapping.findIndex((c) => c.target === 'title');

  const setColumn = (i: number, patch: Partial<ColumnMapping>) =>
    setMapping((list) =>
      list.map((c, j) => {
        if (j === i) return { ...c, ...patch };
        // Each property (and the title) receives one column at most.
        if (patch.target && patch.target !== 'skip' && patch.target !== 'new' && c.target === patch.target) return { ...c, target: 'skip' };
        return c;
      }),
    );

  const run = async () => {
    setBusy(true);
    try {
      const columnValues = (i: number) => csv.rows.map((r) => r[i] ?? '');
      let schema: PropertyDef[] = properties;
      const propOf = new Map<number, string>();
      // 1. New properties (select-like ones get their options right away).
      for (let i = 0; i < mapping.length; i++) {
        const c = mapping[i]!;
        if (c.target !== 'new') continue;
        const name = uniquePropertyName(csv.headers[i]!.slice(0, 200), schema);
        const def = newPropertyDef(c.newType, schema, { name });
        if (c.newType === 'number') def.numberFormat = inferNumberFormat(columnValues(i));
        if (c.newType === 'select' || c.newType === 'multi_select' || c.newType === 'status') {
          const base = { ...def, id: '', options: c.newType === 'status' ? def.options : [] } as PropertyDef;
          def.options = [...(base.options ?? []), ...missingOptions(base, columnValues(i))];
        }
        const { id, done } = m.createProperty(def);
        const res: DatabaseSchema | undefined = await done;
        if (!res) throw new Error(`Impossible de créer la propriété « ${name} ».`);
        schema = res.properties;
        propOf.set(i, id);
      }
      // 2. Existing select-like properties: add the missing options.
      for (let i = 0; i < mapping.length; i++) {
        const c = mapping[i]!;
        if (c.target === 'new' || c.target === 'skip' || c.target === 'title') continue;
        propOf.set(i, c.target);
        const prop = schema.find((p) => p.id === c.target);
        if (!prop || !['select', 'multi_select', 'status'].includes(prop.type)) continue;
        const added = missingOptions(prop, columnValues(i));
        if (added.length) {
          const res = await m.updateProperty(prop.id, { options: [...(prop.options ?? []), ...added] });
          if (res) schema = res.properties;
        }
      }
      // 3. Related rows (relation columns hold titles).
      const relationRows = new Map<string, Array<{ id: string; title: string }>>();
      for (const id of new Set(propOf.values())) {
        const p = schema.find((x) => x.id === id);
        if (p?.type === 'relation' && p.relation?.databaseId) {
          const res = await api.databases.rows(p.relation.databaseId);
          relationRows.set(p.id, res.rows);
        }
      }
      // 4. Rows.
      const cx = { users: members, relationRows };
      const rows = csv.rows.map((r) => {
        const properties: Record<string, PropertyValue> = {};
        for (const [i, id] of propOf) {
          const p = schema.find((x) => x.id === id);
          if (!p) continue;
          const v = csvToValue(p, r[i] ?? '', cx);
          if (v !== undefined) properties[id] = v;
        }
        return { title: titleColumn >= 0 ? (r[titleColumn] ?? '').trim() : '', properties };
      });
      let created = 0;
      let updated = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const res = await m.importRows({ rows: rows.slice(i, i + CHUNK), updateByTitle });
        if (!res) throw new Error('Import interrompu.');
        created += res.created;
        updated += res.updated;
      }
      toast.success(
        `Import terminé : ${created} ligne${created > 1 ? 's' : ''} créée${created > 1 ? 's' : ''}` +
          (updated ? `, ${updated} mise${updated > 1 ? 's' : ''} à jour` : '') +
          '.',
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const choices = [
    { value: 'skip', label: 'Ignorer' },
    { value: 'title', label: `${titleProp.name} (titre)` },
    { value: 'new', label: 'Nouvelle propriété' },
    ...targets.map((p) => ({ value: p.id, label: `${p.name} · ${PROPERTY_TYPE_LABELS[p.type]}` })),
  ];

  return (
    <Modal opened onClose={busy ? () => undefined : onClose} title={`Importer « ${fileName} »`} centered size="xl" zIndex={400}>
      <div className="ordb-csv" data-database-id={databaseId}>
        <div>
          {csv.rows.length} ligne{csv.rows.length > 1 ? 's' : ''} · {csv.headers.length} colonne{csv.headers.length > 1 ? 's' : ''}. Associez chaque
          colonne à une propriété de la base, ou créez-en une (type proposé d'après les valeurs).
        </div>
        <div className="ordb-csv-scroll">
          <table className="ordb-csv-table">
            <thead>
              <tr>
                <th>Colonne</th>
                <th>Exemple</th>
                <th>Importer dans</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {csv.headers.map((h, i) => {
                const c = mapping[i]!;
                const sample = csv.rows.map((r) => r[i] ?? '').find((v) => v.trim()) ?? '';
                return (
                  <tr key={i}>
                    <td>
                      <strong>{h}</strong>
                    </td>
                    <td className="ordb-csv-sample" title={sample}>
                      {sample}
                    </td>
                    <td>
                      <NativeSelect ariaLabel={`Destination de la colonne ${h}`} value={c.target} onChange={(target) => setColumn(i, { target })} choices={choices} />
                    </td>
                    <td>
                      {c.target === 'new' ? (
                        <NativeSelect
                          ariaLabel={`Type de la colonne ${h}`}
                          value={c.newType}
                          onChange={(t) => setColumn(i, { newType: t as PropertyType })}
                          choices={NEW_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))}
                        />
                      ) : (
                        <span className="ordb-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="ordb-csv-options">
          <Toggle
            label="Mettre à jour les lignes existantes ayant le même titre"
            checked={updateByTitle}
            disabled={titleColumn < 0}
            onChange={setUpdateByTitle}
          />
        </div>
        <div className="ordb-confirm-actions">
          <Btn variant="outline" onClick={onClose} disabled={busy}>
            Annuler
          </Btn>
          <Btn variant="primary" onClick={() => void run()} disabled={busy || csv.rows.length === 0}>
            {busy ? 'Import en cours…' : `Importer ${csv.rows.length} ligne${csv.rows.length > 1 ? 's' : ''}`}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
