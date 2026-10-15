// Settings of a chart (chart views' « Disposition » menu and dashboard widgets): X axis and its date
// grouping, aggregate, series, order, legend / labels / « Sans valeur ».
import type { ChartAggregate, ChartConfig, ChartDateBucket, ChartSort, ChartViewType, ViewConfig } from '@oriel/shared';
import { defaultChartConfig } from '@oriel/shared';
import { useDb } from '../context';
import { CHART_AGGREGATE_LABELS, CHART_BUCKET_LABELS, canAggregate, canChartBy, isDateDimension } from '../logic/chart';
import type { ValueKind } from '../logic/values';
import { NativeSelect, Toggle } from '../ui/primitives';

const SORT_LABELS: Record<ChartSort, string> = {
  default: 'Ordre naturel',
  label_asc: 'Libellé (A → Z)',
  label_desc: 'Libellé (Z → A)',
  value_asc: 'Valeur croissante',
  value_desc: 'Valeur décroissante',
};

const BUCKET_CHOICES = (Object.keys(CHART_BUCKET_LABELS) as ChartDateBucket[]).map((b) => ({ value: b, label: CHART_BUCKET_LABELS[b] }));

export function ChartSettings({
  type,
  chart,
  onChange,
  kinds,
}: {
  type: ChartViewType;
  chart: ChartConfig;
  onChange: (patch: Partial<ChartConfig>) => void;
  kinds: Map<string, ValueKind>;
}) {
  const { properties } = useDb();
  const dims = properties.filter(canChartBy);
  const numbers = properties.filter((p) => canAggregate(p, kinds.get(p.id)));
  const x = properties.find((p) => p.id === chart.xProperty);
  const series = properties.find((p) => p.id === chart.seriesProperty);
  const isNumber = type === 'chart_number';
  const withSeries = type === 'chart_bar' || type === 'chart_hbar' || type === 'chart_line';
  const aggregate = chart.aggregate;
  return (
    <>
      {!isNumber && (
        <div className="ordb-field-row">
          <span>{type === 'chart_donut' ? 'Parts selon' : 'Axe des catégories'}</span>
          <NativeSelect
            ariaLabel="Propriété des catégories"
            value={chart.xProperty ?? ''}
            onChange={(v) => onChange({ xProperty: v || null, ...(v && v === chart.seriesProperty ? { seriesProperty: null } : {}) })}
            choices={[{ value: '', label: 'Choisir…' }, ...dims.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
      )}
      {!isNumber && x && isDateDimension(x, kinds.get(x.id)) && (
        <div className="ordb-field-row">
          <span>Regrouper par</span>
          <NativeSelect
            ariaLabel="Regroupement des dates"
            value={chart.xBucket ?? 'month'}
            onChange={(v) => onChange({ xBucket: v as ChartDateBucket })}
            choices={BUCKET_CHOICES}
          />
        </div>
      )}
      <div className="ordb-field-row">
        <span>Valeur</span>
        <NativeSelect
          ariaLabel="Calcul de la valeur"
          value={aggregate}
          onChange={(v) => {
            const next = v as ChartAggregate;
            const keep = chart.valueProperty && numbers.some((p) => p.id === chart.valueProperty);
            onChange({ aggregate: next, valueProperty: next === 'count' ? chart.valueProperty : keep ? chart.valueProperty : (numbers[0]?.id ?? null) });
          }}
          choices={(Object.keys(CHART_AGGREGATE_LABELS) as ChartAggregate[]).map((a) => ({
            value: a,
            label: CHART_AGGREGATE_LABELS[a],
            disabled: a !== 'count' && numbers.length === 0,
          }))}
        />
      </div>
      {aggregate !== 'count' && (
        <div className="ordb-field-row">
          <span>Propriété calculée</span>
          <NativeSelect
            ariaLabel="Propriété nombre calculée"
            value={chart.valueProperty ?? ''}
            onChange={(v) => onChange({ valueProperty: v || null })}
            choices={[{ value: '', label: 'Choisir…' }, ...numbers.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
      )}
      {numbers.length === 0 && <div className="ordb-menu-hint is-tight">Ajoutez une propriété Nombre pour calculer une somme ou une moyenne.</div>}
      {withSeries && (
        <div className="ordb-field-row">
          <span>{type === 'chart_line' ? 'Une ligne par' : 'Séries'}</span>
          <NativeSelect
            ariaLabel="Propriété des séries"
            value={chart.seriesProperty ?? ''}
            // A first series turns the legend on: the colors need a key.
            onChange={(v) => onChange({ seriesProperty: v || null, ...(v && !chart.seriesProperty ? { showLegend: true } : {}) })}
            choices={[{ value: '', label: 'Aucune' }, ...dims.filter((p) => p.id !== chart.xProperty).map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
      )}
      {withSeries && series && isDateDimension(series, kinds.get(series.id)) && (
        <div className="ordb-field-row">
          <span>Séries par</span>
          <NativeSelect
            ariaLabel="Regroupement des dates des séries"
            value={chart.seriesBucket ?? 'month'}
            onChange={(v) => onChange({ seriesBucket: v as ChartDateBucket })}
            choices={BUCKET_CHOICES}
          />
        </div>
      )}
      {!isNumber && (
        <>
          <div className="ordb-field-row">
            <span>Ordre</span>
            <NativeSelect
              ariaLabel="Ordre des catégories"
              value={chart.sort ?? 'default'}
              onChange={(v) => onChange({ sort: v as ChartSort })}
              choices={(Object.keys(SORT_LABELS) as ChartSort[]).map((s) => ({ value: s, label: SORT_LABELS[s] }))}
            />
          </div>
          <Toggle label="Légende" checked={chart.showLegend === true} onChange={(showLegend) => onChange({ showLegend })} />
          <Toggle
            label={type === 'chart_donut' ? 'Pourcentages' : 'Étiquettes de valeur'}
            checked={type === 'chart_line' ? chart.showLabels === true : chart.showLabels !== false}
            onChange={(showLabels) => onChange({ showLabels })}
          />
          <Toggle label="Masquer « Sans valeur »" checked={chart.hideEmpty === true} onChange={(hideEmpty) => onChange({ hideEmpty })} />
        </>
      )}
    </>
  );
}

/** « Disposition » options of a chart view. */
export function ChartViewOptions({
  type,
  config,
  set,
  kinds,
}: {
  type: ChartViewType;
  config: ViewConfig;
  set: (patch: Partial<ViewConfig>) => void;
  kinds: Map<string, ValueKind>;
}) {
  const { properties } = useDb();
  const chart = config.chart ?? defaultChartConfig(type, properties);
  return <ChartSettings type={type} chart={chart} kinds={kinds} onChange={(patch) => set({ chart: { ...chart, ...patch } })} />;
}
