// Canvas module (H1), light entry point: the page route, the public page and the sidebar import
// this file only; the editor and its dependencies load on demand.
import { lazy, Suspense } from 'react';
import { isCanvasFormat, type Page } from '@oriel/shared';
import { ErrorBoundary, PageSkeleton } from '../components/common';
import type { CanvasPageProps } from './CanvasPage';

const CanvasPageLazy = lazy(() => import('./CanvasPage'));

export const isCanvasPage = (page: Pick<Page, 'format'>) => isCanvasFormat(page.format);

export function CanvasView(props: CanvasPageProps) {
  return (
    <ErrorBoundary resetKey={props.page.id}>
      <Suspense fallback={<PageSkeleton />}>
        <CanvasPageLazy {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

export { createCanvasPage } from './create';
