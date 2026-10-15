// Floating table of contents (SPEC §13.2): thin marks in the right margin, titles on hover.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { editorsVersion, getEditor } from '../editor/registry';
import { useStore } from '../lib/store';
import { activeHeadingIndex, collectHeadings, tocVisible, type OutlineHeading } from './outlineLogic';
import { revealAncestors } from './findEngine';

function scrollerOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('.peek__body, .main-scroll');
}

function headingElement(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
}

export function PageToc({ pageId, setting, variant }: { pageId: string; setting: boolean | undefined; variant: 'full' | 'peek' }) {
  useStore(editorsVersion);
  const editor = getEditor(pageId);
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [active, setActive] = useState(-1);
  const [hover, setHover] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  // Headings follow the document (own edits and collaborators').
  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => setHeadings(collectHeadings(editor.document));
    read();
    const off = editor.onChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, [editor]);

  const visible = tocVisible(setting, headings.length, variant);

  const updateActive = useCallback(() => {
    const host = holder.current;
    const page = host?.closest<HTMLElement>('.page');
    const scroller = host ? scrollerOf(host) : null;
    if (!page || !scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const tops = headings.map((h) => {
      const el = headingElement(page, h.id);
      if (!el || el.offsetParent === null) return null; // folded away
      return el.getBoundingClientRect().top - top;
    });
    setActive(activeHeadingIndex(tops, 140));
  }, [headings]);

  useEffect(() => {
    if (!visible) return;
    const scroller = holder.current ? scrollerOf(holder.current) : null;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateActive();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    updateActive();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [visible, updateActive]);

  const go = (h: OutlineHeading) => {
    const page = holder.current?.closest<HTMLElement>('.page');
    const el = page ? headingElement(page, h.id) : null;
    if (!el) return;
    revealAncestors(el);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const marks = useMemo(() => headings.map((h, i) => ({ h, i })), [headings]);

  return (
    <div ref={holder} className="or-outline-anchor">
      {visible && (
        <nav
          className={`or-outline${hover ? ' is-open' : ''}`}
          aria-label="Sommaire de la page"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onFocus={() => setHover(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false);
          }}
        >
          <div className="or-outline__rail" aria-hidden={hover}>
            {marks.map(({ h, i }) => (
              <span key={h.id} className={`or-outline__mark or-outline__mark--${h.level}${i === active ? ' is-active' : ''}`} />
            ))}
          </div>
          <ul className="or-outline__list">
            {marks.map(({ h, i }) => (
              <li key={h.id}>
                <button
                  type="button"
                  className={`or-outline__item or-outline__item--${h.level}${i === active ? ' is-active' : ''}`}
                  title={h.text || 'Sans titre'}
                  tabIndex={hover ? 0 : -1}
                  onClick={() => go(h)}
                >
                  {h.text || 'Sans titre'}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
