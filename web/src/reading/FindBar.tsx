// "Rechercher dans la page" bar (SPEC §13.1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { updatePage } from '../lib/pages';
import { useStore } from '../lib/store';
import { getEditor } from '../editor/registry';
import { clearHighlights, paintHighlights, scanEditor, scrollRangeIntoView, type FoundMatch } from './findEngine';
import { findMatches, replaceMatches } from './findLogic';
import { closeFind, findStore } from './store';

/** Root element of the page `pageId` as rendered (full page or peek). */
function pageElement(pageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.page[data-page-id="${CSS.escape(pageId)}"]`);
}

export function FindBar() {
  const { open, pageId, nonce } = useStore(findStore);
  if (!open || !pageId) return null;
  return createPortal(<FindBarInner key={pageId} pageId={pageId} nonce={nonce} />, document.body);
}

function FindBarInner({ pageId, nonce }: { pageId: string; nonce: number }) {
  const detail = useQuery({ queryKey: qk.page(pageId), queryFn: () => api.pages.get(pageId) });
  const page = detail.data?.page ?? null;
  const canEdit = !!detail.data?.canEdit && !!page && !page.trashedAt && !page.format.locked;

  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [matches, setMatches] = useState<FoundMatch[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<FoundMatch[]>([]);
  matchesRef.current = matches;
  const queryRef = useRef(query);
  queryRef.current = query;
  const title = page?.title ?? '';

  // Focus and select the field (also when ⌘F is pressed again).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [nonce]);

  const scan = useCallback(() => {
    const q = queryRef.current;
    if (!q) {
      setMatches([]);
      return;
    }
    const root = pageElement(pageId);
    const titleMatches: FoundMatch[] = findMatches(title, q).map((m) => ({ kind: 'title' as const, start: m.start, end: m.end }));
    const body = root?.querySelector<HTMLElement>('.page-body') ?? root;
    setMatches([...titleMatches, ...(body ? scanEditor(body, q) : [])]);
  }, [pageId, title]);

  useEffect(() => {
    setIndex(0);
    scan();
  }, [query, scan]);

  // Content changes (own edits, collaborators, embedded blocks): rescan, debounced.
  useEffect(() => {
    const root = pageElement(pageId);
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(scan, 200);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [pageId, scan]);

  const safeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);

  // Paint and bring the current match into view.
  useEffect(() => {
    paintHighlights(matches, safeIndex);
    return undefined;
  }, [matches, safeIndex]);
  useEffect(() => () => clearHighlights(), []);

  const reveal = useCallback(
    (i: number) => {
      const m = matchesRef.current[i];
      if (!m) return;
      if (m.kind === 'dom') {
        scrollRangeIntoView(m.range);
      } else {
        const el = pageElement(pageId)?.querySelector<HTMLTextAreaElement>('textarea.page-title');
        el?.scrollIntoView({ block: 'center' });
        if (el && document.activeElement !== el) {
          el.focus({ preventScroll: true });
          el.setSelectionRange(m.start, m.end);
          inputRef.current?.focus({ preventScroll: true });
        }
      }
    },
    [pageId],
  );
  const lastRevealed = useRef<string>('');
  useEffect(() => {
    const m = matches[safeIndex];
    if (!m) return;
    // Only when the position or the query changed, not when a rescan returns the same matches.
    const key = `${query}|${safeIndex}|${matches.length}`;
    if (lastRevealed.current === key) return;
    lastRevealed.current = key;
    reveal(safeIndex);
  }, [matches, safeIndex, query, reveal]);

  const go = (delta: number) => {
    if (matches.length === 0) return;
    setIndex((safeIndex + delta + matches.length) % matches.length);
  };

  const editor = getEditor(pageId);

  /** Replaces the DOM matches `list` (any order) in one transaction. */
  const replaceDom = (list: Extract<FoundMatch, { kind: 'dom' }>[]) => {
    if (!editor || list.length === 0) return;
    const view = editor.prosemirrorView;
    if (!view) return;
    const spans = list
      .map((m) => ({
        from: view.posAtDOM(m.range.startContainer, m.range.startOffset),
        to: view.posAtDOM(m.range.endContainer, m.range.endOffset),
      }))
      .sort((a, b) => b.from - a.from);
    editor.transact((tr) => {
      for (const s of spans) tr.insertText(replacement, s.from, s.to);
    });
  };

  const replaceTitle = async (all: boolean) => {
    const found = findMatches(title, query);
    if (found.length === 0) return;
    const next = replaceMatches(title, all ? found : [found[0]!], replacement).slice(0, 200);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await updatePage(page!.workspaceId, pageId, { title: next }).catch(() => undefined);
  };

  const replaceCurrent = () => {
    const m = matches[safeIndex];
    if (!m || !canEdit) return;
    if (m.kind === 'title') void replaceTitle(false);
    else replaceDom([m]);
    setTimeout(scan, 30);
  };
  const replaceAll = () => {
    if (!canEdit) return;
    const dom = matches.filter((m): m is Extract<FoundMatch, { kind: 'dom' }> => m.kind === 'dom');
    if (matches.some((m) => m.kind === 'title')) void replaceTitle(true);
    replaceDom(dom);
    setTimeout(scan, 30);
  };

  const status = useMemo(() => {
    if (!query) return '';
    if (matches.length === 0) return 'Aucun résultat';
    return `${safeIndex + 1} / ${matches.length}`;
  }, [query, matches.length, safeIndex]);

  return (
    <div className="or-find" role="search" aria-label="Rechercher dans la page" onKeyDownCapture={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
      }
    }}>
      <div className="or-find__row">
        <input
          ref={inputRef}
          className="or-find__input"
          type="search"
          placeholder="Rechercher dans la page"
          aria-label="Rechercher dans la page"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="or-find__count" aria-live="polite">
          {status}
        </span>
        <button type="button" className="icon-btn" aria-label="Occurrence précédente" title="Précédente (Maj+Entrée)" disabled={matches.length === 0} onClick={() => go(-1)}>
          <ChevronUp size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label="Occurrence suivante" title="Suivante (Entrée)" disabled={matches.length === 0} onClick={() => go(1)}>
          <ChevronDown size={16} />
        </button>
        {canEdit && (
          <button
            type="button"
            className={`icon-btn${showReplace ? ' is-active' : ''}`}
            aria-label="Remplacer"
            aria-pressed={showReplace}
            title="Remplacer"
            onClick={() => setShowReplace((v) => !v)}
          >
            <Replace size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Fermer la recherche" title="Fermer (Échap)" onClick={closeFind}>
          <X size={16} />
        </button>
      </div>
      {canEdit && showReplace && (
        <div className="or-find__row">
          <input
            className="or-find__input"
            type="text"
            placeholder="Remplacer par"
            aria-label="Remplacer par"
            value={replacement}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                replaceCurrent();
              }
            }}
          />
          <button type="button" className="btn btn--sm btn--secondary" disabled={matches.length === 0} onClick={replaceCurrent}>
            Remplacer
          </button>
          <button type="button" className="btn btn--sm btn--secondary" disabled={matches.length === 0} onClick={replaceAll}>
            Tout
          </button>
        </div>
      )}
    </div>
  );
}
