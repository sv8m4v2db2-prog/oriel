// Split view (lot E): two or three pages side by side in the main area.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tooltip } from '@mantine/core';
import { ArrowLeftRight, FileQuestion, Maximize2, Minimize2, PanelLeftClose, X } from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage, isNotFound } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { navigation } from '../lib/navigation';
import { pagePath, pageTitle } from '../lib/util';
import { EmptyState, ErrorState, PageIcon, PageSkeleton } from '../components/common';
import { PageView } from '../page/PageView';
import { PageTopBar, TopBar } from '../shell/TopBar';
import { MIN_PANE_PX, dragHandle, equalWidths, swapTarget, type SplitState } from './splitLogic';
import { maximizedStore, saveWidths, splitActions, widthsFor, widthsStore } from './actions';
import './split.css';

/** Keys that stay stable when panes are swapped or closed, even when a page is open twice. */
function paneKeys(panes: string[]): string[] {
  const seen = new Map<string, number>();
  return panes.map((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return `${id}#${n}`;
  });
}

export function SplitView({ workspaceId, state }: { workspaceId: string; state: SplitState }) {
  const count = state.panes.length;
  const activeId = state.panes[state.active]!;
  const activeQuery = useQuery({ queryKey: qk.page(activeId), queryFn: () => api.pages.get(activeId) });
  const widthsMap = useStore(widthsStore);
  const stored = useMemo(() => widthsFor(widthsMap, count), [widthsMap, count]);
  const [live, setLive] = useState<number[] | null>(null);
  const widths = live && live.length === count ? live : stored;
  const maximized = useStore(maximizedStore);
  const shown = maximized !== null && maximized < count ? maximized : null;
  const containerRef = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => paneKeys(state.panes), [state.panes]);

  // Esc folds a pane that was made full size (unless something else on top handles it).
  useEffect(() => {
    if (shown === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || navigation.getState().peekPageId) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[role="dialog"], .mantine-Popover-dropdown, .mantine-Menu-dropdown')) return;
      maximizedStore.set(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);

  const onHandleDown = (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = widths.slice();
    const min = Math.min(0.45, MIN_PANE_PX / Math.max(1, box.width));
    let last = start;
    const move = (ev: PointerEvent) => {
      last = dragHandle(start, index, (ev.clientX - startX) / box.width, min);
      setLive(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      saveWidths(count, last);
      setLive(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onHandleKey = (index: number) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const box = containerRef.current?.getBoundingClientRect();
    const min = Math.min(0.45, MIN_PANE_PX / Math.max(1, box?.width ?? 1000));
    saveWidths(count, dragHandle(widths, index, e.key === 'ArrowLeft' ? -0.02 : 0.02, min));
  };

  return (
    <>
      {activeQuery.data ? <PageTopBar detail={activeQuery.data} /> : <TopBar />}
      <div className={`splitv${shown !== null ? ' has-maximized' : ''}`} ref={containerRef} data-split-count={count}>
        {state.panes.map((id, i) => (
          <Fragment key={keys[i]}>
            {i > 0 && (
              <div
                className="splitv__handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Redimensionner les panneaux"
                tabIndex={0}
                onPointerDown={onHandleDown(i - 1)}
                onKeyDown={onHandleKey(i - 1)}
                onDoubleClick={() => saveWidths(count, equalWidths(count))}
              />
            )}
            <Pane
              pageId={id}
              index={i}
              count={count}
              active={i === state.active}
              maximized={shown === i}
              workspaceId={workspaceId}
              flex={widths[i] ?? 1 / count}
              swapIndex={swapTarget(state, i)}
            />
          </Fragment>
        ))}
      </div>
    </>
  );
}

function Pane({
  pageId,
  index,
  count,
  active,
  maximized,
  workspaceId,
  flex,
  swapIndex,
}: {
  pageId: string;
  index: number;
  count: number;
  active: boolean;
  maximized: boolean;
  workspaceId: string;
  flex: number;
  swapIndex: number;
}) {
  const query = useQuery({ queryKey: qk.page(pageId), queryFn: () => api.pages.get(pageId) });
  const detail = query.data;
  const ref = useRef<HTMLElement>(null);
  const [size, setSize] = useState<'s' | 'm' | 'l'>('l');

  // Pane width drives the gutters (data-size) and the wrapping of the title: the page title measures
  // itself on window resize, so a pane that changes width asks for it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let lastWidth = el.clientWidth;
    const measure = () => {
      const w = el.clientWidth;
      setSize(w < 480 ? 's' : w < 720 ? 'm' : 'l');
      if (w !== lastWidth) {
        lastWidth = w;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [size]);

  const activate = (e: { target: EventTarget | null }) => {
    if (active) return;
    if ((e.target as HTMLElement | null)?.closest?.('.splitv__actions')) return;
    splitActions.activate(index);
  };

  const page = detail?.page;
  const title = page ? pageTitle(page.title) : query.isError ? 'Page introuvable' : 'Chargement…';
  const foreign = !!page && page.workspaceId !== workspaceId;

  return (
    <section
      ref={ref}
      className={`splitv__pane${active ? ' is-active' : ''}${maximized ? ' is-maximized' : ''}`}
      style={{ flex: `${flex} 1 0%` }}
      data-size={size}
      data-split-pane={index}
      aria-label={`Panneau ${index + 1} : ${title}`}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
    >
      <header className="splitv__head">
        <div className="splitv__title" title={title}>
          <PageIcon icon={page?.icon ?? null} kind={page?.kind ?? 'page'} size={15} />
          <span>{title}</span>
        </div>
        <div className="splitv__actions">
          <Tooltip label={maximized ? 'Réduire le panneau' : 'Agrandir le panneau'} openDelay={300}>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={maximized ? 'Réduire le panneau' : 'Agrandir le panneau'}
              aria-pressed={maximized}
              onClick={() => maximizedStore.set(maximized ? null : index)}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </Tooltip>
          <Tooltip label="Échanger avec le panneau voisin" openDelay={300}>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Échanger avec le panneau voisin"
              disabled={swapIndex < 0}
              onClick={() => splitActions.swap(index)}
            >
              <ArrowLeftRight size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Garder seul" openDelay={300}>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Garder seul ce panneau" onClick={() => splitActions.keepOnly(index)}>
              <PanelLeftClose size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Fermer le panneau" openDelay={300}>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Fermer le panneau" disabled={count < 2} onClick={() => splitActions.close(index)}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="main-scroll splitv__scroll" key={pageId}>
        {query.isLoading ? (
          <PageSkeleton />
        ) : query.isError || !detail ? (
          isNotFound(query.error) ? (
            <EmptyState icon={<FileQuestion size={28} />} title="Page introuvable">
              Elle a peut-être été supprimée, ou vous n’y avez pas accès.
            </EmptyState>
          ) : (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          )
        ) : foreign ? (
          <EmptyState
            icon={<FileQuestion size={28} />}
            title="Page d’un autre espace"
            action={
              <a className="btn btn--secondary btn--sm" href={pagePath(page!.workspaceId, page!.id)}>
                Ouvrir cette page
              </a>
            }
          />
        ) : (
          <PageView detail={detail} workspaceId={workspaceId} variant="full" />
        )}
      </div>
    </section>
  );
}
