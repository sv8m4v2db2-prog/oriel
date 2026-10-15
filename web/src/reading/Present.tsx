// Presentation mode (SPEC §13.3). The page itself is shown full screen, one slide at a time: slides
// are ranges of top-level blocks, the others hidden by a generated stylesheet (robust to re-renders).
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { pageTitle } from '../lib/util';
import { getEditor } from '../editor/registry';
import { computeSlides, slideCss } from './slidesLogic';
import { presentStore, stopPresentation } from './store';

export function Presentation() {
  const { pageId } = useStore(presentStore);
  if (!pageId) return null;
  return <PresentationInner key={pageId} pageId={pageId} />;
}

function PresentationInner({ pageId }: { pageId: string }) {
  const editor = getEditor(pageId);
  const detail = useQuery({ queryKey: qk.page(pageId), queryFn: () => api.pages.get(pageId) });
  const [version, setVersion] = useState(0);
  const slides = useMemo(() => computeSlides(editor?.document ?? []), [editor, version]);
  const [index, setIndex] = useState(0);
  const current = Math.min(index, slides.length - 1);
  const last = slides.length - 1;

  useEffect(() => {
    if (!editor) {
      stopPresentation();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = editor.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, [editor]);

  // Page and body classes, read-only editor, full screen.
  useLayoutEffect(() => {
    const page = document.querySelector<HTMLElement>(`.page[data-page-id="${CSS.escape(pageId)}"]`);
    const wasEditable = editor?.isEditable ?? false;
    page?.classList.add('is-presenting');
    document.body.classList.add('or-presenting');
    if (editor && wasEditable) editor.isEditable = false;
    let entered = false;
    try {
      void document.documentElement.requestFullscreen?.().then(() => (entered = true)).catch(() => undefined);
    } catch {
      /* not allowed */
    }
    const onFs = () => {
      if (!document.fullscreenElement && entered) stopPresentation();
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      page?.classList.remove('is-presenting', 'is-title-slide');
      document.body.classList.remove('or-presenting');
      if (editor && wasEditable) editor.isEditable = true;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [pageId, editor]);

  useLayoutEffect(() => {
    const style = document.createElement('style');
    style.dataset.orPresent = '';
    style.textContent = slideCss(`.page[data-page-id="${CSS.escape(pageId)}"].is-presenting .bn-editor > .bn-block-group`, slides[current]);
    document.head.append(style);
    document
      .querySelector(`.page[data-page-id="${CSS.escape(pageId)}"]`)
      ?.classList.toggle('is-title-slide', current === 0);
    document.querySelector(`.page[data-page-id="${CSS.escape(pageId)}"] .page-body`)?.scrollTo?.({ top: 0 });
    return () => style.remove();
  }, [pageId, slides, current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
      const prev = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopPresentation();
      } else if (next.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setIndex((i) => Math.min(last, i + 1));
      } else if (prev.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(e.key === 'Home' ? 0 : last);
      } else if (e.key.length === 1 || e.key === 'Delete') {
        e.preventDefault(); // read only: nothing is typed
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last]);

  const page = detail.data?.page;
  return createPortal(
    <>
      {current === 0 && page && (
        <div className="or-present__title">
          {page.icon && <span aria-hidden>{page.icon} </span>}
          {pageTitle(page.title)}
        </div>
      )}
      <div className="or-present__controls" role="toolbar" aria-label="Présentation">
        <button type="button" className="icon-btn" aria-label="Diapositive précédente" disabled={current === 0} onClick={() => setIndex(Math.max(0, current - 1))}>
          <ChevronLeft size={18} />
        </button>
        <span className="or-present__count" aria-live="polite">
          {current + 1} / {slides.length}
        </span>
        <button type="button" className="icon-btn" aria-label="Diapositive suivante" disabled={current === last} onClick={() => setIndex(Math.min(last, current + 1))}>
          <ChevronRight size={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="Quitter la présentation" title="Quitter (Échap)" onClick={stopPresentation}>
          <X size={18} />
        </button>
      </div>
    </>,
    document.body,
  );
}
