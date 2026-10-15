// Hover preview of page links and mentions (SPEC §13.7). An inaccessible page answers 404: no card.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { appNavigate, formatRelative, pagePath, pageTitle } from '../lib/util';
import { PageIcon } from '../components/common';
import { readingApi, readingKeys } from './api';

const SCOPE = '.or-editor, .page-backlinks, .or-info, .or-discussion';
const PAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_PATH = /^\/w\/[^/]+\/p\/([^/?#]+)/;

/** Page id targeted by a link or mention element, or null. */
export function pageIdOfLink(a: HTMLAnchorElement): string | null {
  const data = a.dataset.pageId;
  if (data && PAGE_ID.test(data)) return data;
  try {
    const url = new URL(a.getAttribute('href') ?? '', location.href);
    if (url.origin !== location.origin) return null;
    const m = PAGE_PATH.exec(url.pathname);
    return m && PAGE_ID.test(m[1]!) ? m[1]! : null;
  } catch {
    return null;
  }
}

interface Target {
  pageId: string;
  rect: DOMRect;
}

export function HoverPreview() {
  const [target, setTarget] = useState<Target | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (window.matchMedia?.('(hover: none)').matches) return;
    const clear = () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    const scheduleHide = () => {
      clear();
      hideTimer.current = setTimeout(() => setTarget(null), 200);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('.or-hover-card')) {
        clear();
        return;
      }
      const a = el?.closest<HTMLAnchorElement>('a');
      if (!a || !a.closest(SCOPE)) return;
      const pageId = pageIdOfLink(a);
      if (!pageId) return;
      clear();
      showTimer.current = setTimeout(() => setTarget({ pageId, rect: a.getBoundingClientRect() }), 400);
    };
    const onOut = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('a, .or-hover-card')) scheduleHide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTarget(null);
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', () => setTarget(null), true);
    return () => {
      clear();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!target) return null;
  return createPortal(<Card key={target.pageId} target={target} onClose={() => setTarget(null)} />, document.body);
}

function Card({ target, onClose }: { target: Target; onClose: () => void }) {
  const q = useQuery({ queryKey: readingKeys.preview(target.pageId), queryFn: () => readingApi.preview(target.pageId), retry: false, staleTime: 60_000 });
  const p = q.data;
  if (!p) return null;
  const width = 320;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, target.rect.left));
  const below = target.rect.bottom + 8;
  const style = below + 160 > window.innerHeight ? { left, width, bottom: window.innerHeight - target.rect.top + 8 } : { left, width, top: below };
  return (
    <div
      className="or-hover-card"
      role="tooltip"
      style={style}
      onClick={() => {
        onClose();
        appNavigate(pagePath(p.workspaceId, p.id));
      }}
    >
      <div className="or-hover-card__head">
        <PageIcon icon={p.icon} kind={p.kind} size={18} />
        <strong>{pageTitle(p.title)}</strong>
      </div>
      {p.trashed ? <p className="or-hover-card__text">Cette page est dans la corbeille.</p> : p.excerpt && <p className="or-hover-card__text">{p.excerpt}</p>}
      <div className="or-hover-card__foot">Modifiée {formatRelative(p.updatedAt)}</div>
    </div>
  );
}
