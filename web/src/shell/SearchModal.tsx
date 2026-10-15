// Global search (⌘K / ⌘P): recent pages when empty, debounced full-text search otherwise.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Modal } from '@mantine/core';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Crumb, PageKind } from '@oriel/shared';
import { api } from '../lib/api';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { closeSearch, searchStore } from '../lib/ui';
import { formatRelative, pagePath, pageTitle } from '../lib/util';
import { Kbd, PageIcon, Spinner } from '../components/common';
import { useWorkspaceCtx } from './WorkspaceContext';
import { filterActions, useCommandActions, type CommandAction } from './commands';

export function useDebounced<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/** Renders a snippet where matches are wrapped in [[ ]]. */
export function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\[\[(.*?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={i++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export interface ListItem {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  path?: Crumb[];
  snippet?: string;
  meta?: string;
}

export function useListKeyboard(count: number, onEnter: (index: number) => void) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive((a) => (count === 0 ? 0 : Math.min(a, count - 1)));
  }, [count]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (count ? (a + 1) % count : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (count ? (a - 1 + count) % count : 0));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (count) onEnter(active);
    }
  };
  return { active, setActive, onKeyDown };
}

export function ResultRow({ item, active, onSelect, onHover }: { item: ListItem; active: boolean; onSelect: () => void; onHover: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      className={`result-row${active ? ' is-active' : ''}`}
      onClick={onSelect}
      onMouseMove={onHover}
    >
      <PageIcon icon={item.icon} kind={item.kind} size={18} />
      <span className="result-row__main">
        <span className="result-row__title">
          {pageTitle(item.title)}
          {item.path && item.path.length > 0 && (
            <span className="result-row__path"> — {item.path.map((c) => pageTitle(c.title)).join(' / ')}</span>
          )}
        </span>
        {item.snippet && (
          <span className="result-row__snippet">
            <Snippet text={item.snippet} />
          </span>
        )}
      </span>
      {item.meta && <span className="result-row__meta">{item.meta}</span>}
      {active && <CornerDownLeft size={14} className="result-row__enter" />}
    </button>
  );
}

function ActionRow({ action, active, onSelect, onHover }: { action: CommandAction; active: boolean; onSelect: () => void; onHover: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      className={`result-row result-row--action${active ? ' is-active' : ''}`}
      onClick={onSelect}
      onMouseMove={onHover}
    >
      <span className="page-icon page-icon--default result-row__action-icon">{action.icon}</span>
      <span className="result-row__main">
        <span className="result-row__title">{action.title}</span>
      </span>
      {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
      {active && <CornerDownLeft size={14} className="result-row__enter" />}
    </button>
  );
}

export function SearchModal() {
  const { open } = useStore(searchStore);
  const { workspaceId, canEdit } = useWorkspaceCtx();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const allActions = useCommandActions({ workspaceId, canEdit, pageId });
  const debounced = useDebounced(query.trim(), 180);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const recent = useQuery({ queryKey: qk.recent(workspaceId), queryFn: () => api.workspaces.recent(workspaceId), enabled: open });
  const search = useQuery({
    queryKey: qk.search(workspaceId, debounced),
    queryFn: () => api.workspaces.search(workspaceId, debounced, 20),
    enabled: open && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  // "> texte" searches actions only.
  const actionMode = query.trim().startsWith('>');
  const actions: CommandAction[] = useMemo(
    () => (query.trim() ? filterActions(allActions, query).slice(0, actionMode ? 20 : 5) : allActions.slice(0, 4)),
    [allActions, query, actionMode],
  );

  const items: ListItem[] = useMemo(() => {
    if (actionMode) return [];
    if (!query.trim()) {
      return (recent.data?.pages ?? []).slice(0, 12).map((p) => ({
        id: p.id,
        title: p.title,
        icon: p.icon,
        kind: p.kind,
        path: p.path,
        meta: formatRelative(p.visitedAt),
      }));
    }
    // Templates are listed after the regular results (stable order otherwise).
    const results = search.data?.results ?? [];
    const ordered = [...results.filter((r) => !r.page.isTemplate), ...results.filter((r) => r.page.isTemplate)];
    return ordered.map((r) => ({
      id: r.page.id,
      title: r.page.title,
      icon: r.page.icon,
      kind: r.page.kind,
      path: r.path,
      snippet: r.snippet || undefined,
      meta: r.page.isTemplate ? 'Modèle' : undefined,
    }));
  }, [query, recent.data, search.data, actionMode]);

  const openItem = (i: number) => {
    if (i >= items.length) {
      const action = actions[i - items.length];
      if (!action) return;
      closeSearch();
      // Let the modal close (focus restore) before running the action.
      setTimeout(action.run, 0);
      return;
    }
    const item = items[i];
    if (!item) return;
    closeSearch();
    navigate(pagePath(workspaceId, item.id));
  };
  const kb = useListKeyboard(items.length + actions.length, openItem);
  const loading = query.trim() && !actionMode ? search.isFetching && !search.data : recent.isLoading;

  return (
    <Modal
      opened={open}
      onClose={closeSearch}
      withCloseButton={false}
      size={640}
      padding={0}
      radius="lg"
      yOffset="12vh"
      classNames={{ content: 'search-modal' }}
      aria-label="Rechercher"
    >
      <div className="search-modal__input">
        <Search size={18} />
        <input
          data-autofocus
          autoFocus
          value={query}
          placeholder="Rechercher des pages ou des actions…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={kb.onKeyDown}
          aria-label="Rechercher"
          role="combobox"
          aria-expanded
          aria-controls="search-results"
        />
        {loading && <Spinner size={15} />}
      </div>
      <div className="search-modal__results" id="search-results" role="listbox">
        {!query.trim() && items.length > 0 && <div className="search-modal__label">Pages récentes</div>}
        {items.map((item, i) => (
          <ResultRow key={item.id} item={item} active={i === kb.active} onSelect={() => openItem(i)} onHover={() => kb.setActive(i)} />
        ))}
        {!loading && items.length === 0 && !actionMode && (
          <div className="search-modal__empty">
            {query.trim() ? 'Aucune page trouvée. Essayez d’autres mots.' : 'Les pages que vous consultez apparaîtront ici.'}
          </div>
        )}
        {actions.length > 0 && <div className="search-modal__label">Actions</div>}
        {actions.map((a, j) => {
          const i = items.length + j;
          return <ActionRow key={a.id} action={a} active={i === kb.active} onSelect={() => openItem(i)} onHover={() => kb.setActive(i)} />;
        })}
      </div>
      <div className="search-modal__footer">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> pour naviguer
        </span>
        <span>
          <Kbd>Entrée</Kbd> pour ouvrir
        </span>
        <span>
          <Kbd>Échap</Kbd> pour fermer
        </span>
      </div>
    </Modal>
  );
}
