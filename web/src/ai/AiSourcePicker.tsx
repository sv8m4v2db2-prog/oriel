// Settings › IA — multi-select of the workspace databases analysed by the agent.
import { Lock, TriangleAlert } from 'lucide-react';
import type { AiSettingsResponse } from '@oriel/shared';
import { pageTitle } from '../lib/util';
import { PageIcon } from '../components/common';

export function AiSourcePicker({
  value,
  onChange,
  disabled,
  data,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  data: AiSettingsResponse;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  // Members who cannot manage the settings only see the configured sources.
  const options = data.canManage
    ? (data.databases ?? [])
    : data.sources.filter((s) => s.available).map((s) => ({ id: s.id, title: s.title, icon: s.icon, path: '' }));
  const listed = new Set(options.map((d) => d.id));
  const unavailable = data.sources.filter((s) => value.includes(s.id) && !listed.has(s.id));

  return (
    <div className="ai-sources">
      {options.length === 0 && unavailable.length === 0 && <p className="muted">Aucune base de données partagée dans cet espace.</p>}
      {options.map((d) => (
        <label key={d.id} className={`ai-source${value.includes(d.id) ? ' is-checked' : ''}`}>
          <input type="checkbox" checked={value.includes(d.id)} disabled={disabled} onChange={() => toggle(d.id)} />
          <PageIcon icon={d.icon} kind="database" size={16} />
          <span className="ai-source__title">{pageTitle(d.title)}</span>
          {d.path && <span className="ai-source__path">dans {d.path}</span>}
        </label>
      ))}
      {unavailable.map((s) => (
        <label key={s.id} className="ai-source is-unavailable">
          <input type="checkbox" checked disabled={disabled} onChange={() => toggle(s.id)} />
          <TriangleAlert size={15} />
          <span className="ai-source__title">{s.title ? pageTitle(s.title) : 'Base supprimée'}</span>
          <span className="ai-source__path">indisponible (supprimée, dans la corbeille ou privée) : décochez-la</span>
        </label>
      ))}
      <p className="field-hint ai-sources__hint">
        <Lock size={11} /> Seules les bases visibles par tout l’espace peuvent être analysées ; les pages privées ne sont jamais lues. Pas
        besoin de cocher les rétro-plannings insérés dans les pages des projets ni les bases liées par une relation : l’agent les retrouve
        à partir de la base « Projets ».
      </p>
    </div>
  );
}
