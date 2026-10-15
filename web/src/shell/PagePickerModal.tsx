// Page picker used by "Déplacer vers…" and the "Lien vers une page" block.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@mantine/core';
import { Lock, Search, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ancestorsOf, useTree } from '../lib/tree';
import { closePagePicker, pagePickerStore } from '../lib/ui';
import { normalizeText, pageTitle } from '../lib/util';
import { Spinner } from '../components/common';
import { ResultRow, useDebounced, useListKeyboard, type ListItem } from './SearchModal';
import { useWorkspaceCtx } from './WorkspaceContext';

type PickItem = ListItem & { root?: 'workspace' | 'private' };

export function PagePickerModal() {
  const req = useStore(pagePickerStore);
  const { workspaceId } = useWorkspaceCtx();
  const tree = useTree(workspaceId);
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 200);
  const [remote, setRemote] = useState<PickItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!req) {
      setQuery('');
      setRemote([]);
    }
  }, [req]);

  // Database rows are not in the tree: ask the search API when allowed.
  useEffect(() => {
    if (!req?.includeRows || debounced.length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.workspaces
      .search(workspaceId, debounced, 15)
      .then((res) => {
        if (cancelled) return;
        setRemote(
          res.results.map((r) => ({ id: r.page.id, title: r.page.title, icon: r.page.icon, kind: r.page.kind, path: r.path })),
        );
      })
      .catch(() => !cancelled && setRemote([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [req, debounced, workspaceId]);

  const items: PickItem[] = useMemo(() => {
    if (!req) return [];
    const q = normalizeText(query);
    const out: PickItem[] = [];
    if (req.allowRoots && (!q || normalizeText('espace de travail prive').includes(q))) {
      out.push({ id: 'root:workspace', title: 'Espace de travail', icon: null, kind: 'page', root: 'workspace' });
      out.push({ id: 'root:private', title: 'Privé', icon: null, kind: 'page', root: 'private' });
    }
    const nodes = [...tree.index.byId.values()]
      .filter((n) => !req.exclude?.has(n.id))
      .filter((n) => (req.allowRoots ? n.kind === 'page' : true))
      .filter((n) => !q || normalizeText(pageTitle(n.title)).includes(q))
      .sort((a, b) => pageTitle(a.title).localeCompare(pageTitle(b.title), 'fr'))
      .slice(0, 50)
      .map((n) => ({ id: n.id, title: n.title, icon: n.icon, kind: n.kind, path: ancestorsOf(tree.index, n.id) }));
    const seen = new Set(nodes.map((n) => n.id));
    out.push(...nodes, ...remote.filter((r) => !seen.has(r.id) && !req.exclude?.has(r.id)));
    return out;
  }, [req, query, tree.index, remote]);

  const pick = (i: number) => {
    const item = items[i];
    if (!item || !req) return;
    closePagePicker();
    if (item.root) req.onPick({ kind: 'root', visibility: item.root });
    else req.onPick({ kind: 'page', id: item.id });
  };
  const kb = useListKeyboard(items.length, pick);

  return (
    <Modal opened={!!req} onClose={closePagePicker} title={req?.title} size={560} radius="lg" yOffset="12vh" classNames={{ content: 'search-modal picker-modal' }}>
      <div className="search-modal__input">
        <Search size={17} />
        <input data-autofocus autoFocus value={query} placeholder="Rechercher une page…" onChange={(e) => setQuery(e.target.value)} onKeyDown={kb.onKeyDown} />
        {loading && <Spinner size={14} />}
      </div>
      <div className="search-modal__results" role="listbox">
        {items.map((item, i) =>
          item.root ? (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={i === kb.active}
              className={`result-row${i === kb.active ? ' is-active' : ''}`}
              onClick={() => pick(i)}
              onMouseMove={() => kb.setActive(i)}
            >
              <span className="page-icon page-icon--default">{item.root === 'private' ? <Lock size={15} /> : <Users size={15} />}</span>
              <span className="result-row__main">
                <span className="result-row__title">{item.title}</span>
                <span className="result-row__snippet">Racine de la section</span>
              </span>
            </button>
          ) : (
            <ResultRow key={item.id} item={item} active={i === kb.active} onSelect={() => pick(i)} onHover={() => kb.setActive(i)} />
          ),
        )}
        {items.length === 0 && <div className="search-modal__empty">Aucune page ne correspond.</div>}
      </div>
    </Modal>
  );
}
