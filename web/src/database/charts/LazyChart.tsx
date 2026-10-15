// Lazy entry point of the SVG charts: the chart code is downloaded the first time a chart is shown.
import { lazy, Suspense } from 'react';
import type { ChartRendererProps } from './ChartRenderer';

const ChartRenderer = lazy(() => import('./ChartRenderer'));

export function LazyChart(props: ChartRendererProps) {
  return (
    <Suspense fallback={<div className="ordb-chart-loading" aria-busy="true" />}>
      <ChartRenderer {...props} />
    </Suspense>
  );
}
