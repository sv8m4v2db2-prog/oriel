// Version history (G6): comparison of two versions (or a version and the current content), with
// highlighted text changes, row properties and restore of chosen blocks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, RotateCcw, Undo2 } from 'lucide-react';
import type { DatabaseSchema, PublicUser, RestoreBlockItem } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { formatDateTime } from '../lib/util';
import { EmptyState, Spinner } from '../components/common';
import { changeIds, diffRows, type DiffNode, type DiffOutcome, type TextOp } from './diff';
import { runDiff } from './runDiff';
import { plainText } from './tree';
import { historyApi, historyKeys } from './api';
import { formatPropertyValue, propLabel, propValueLabel, sameValue, typeLabel } from './labels';

export interface CompareSide {
  /** Null for the current content. */
  snapshotId: string | null;
  /** Null for the current content. */
  at: number | null;
  update: string;
  authors: PublicUser[];
}

const MAX_ROWS = 3000;

/** Title of a referenced page or database, resolved with the reader's rights, same workspace only. */
function RefTitle({ id, workspaceId, kind }: { id: string; workspaceId: string; kind: 'page' | 'database' }) {
  const q = useQuery({ queryKey: ['history', 'ref', id], queryFn: () => api.pages.get(id), retry: false, staleTime: 60_000 });
  if (q.isLoading) return <span className="muted">…</span>;
  if (!q.data || q.data.page.workspaceId !== workspaceId) return <span className="muted">Contenu indisponible</span>;
  return <span>{q.data.page.title || (kind === 'database' ? 'Base sans titre' : 'Sans titre')}</span>;
}

function Ops({ ops }: { ops: TextOp[] }) {
  return (
    <>
      {ops.map((o, i) =>
        o.op === 'eq' ? (
          <span key={i}>{o.text}</span>
        ) : o.op === 'ins' ? (
          <ins key={i} className="hdiff__ins">
            {o.text}
          </ins>
        ) : (
          <del key={i} className="hdiff__del">
            {o.text}
          </del>
        ),
      )}
    </>
  );
}

function BlockBody({ node, workspaceId }: { node: DiffNode; workspaceId: string }) {
  const b = node.block;
  if (node.text) return <Ops ops={node.text} />;
  const text = plainText(b);
  if (text.trim()) return <>{text}</>;
  const ref = b.props.pageId ? { id: b.props.pageId, kind: 'page' as const } : b.props.databaseId ? { id: b.props.databaseId, kind: 'database' as const } : null;
  if (ref) return <RefTitle id={ref.id} workspaceId={workspaceId} kind={ref.kind} />;
  if (b.type === 'syncedBlock') return <span className="muted">Contenu versionné séparément</span>;
  return <span className="muted">{b.children.length > 0 || b.type !== 'paragraph' ? '' : 'Bloc vide'}</span>;
}

const STATUS_LABEL: Record<string, string> = { added: 'Ajouté', removed: 'Supprimé', modified: 'Modifié' };

function actionOf(node: DiffNode): RestoreBlockItem['action'] | null {
  if (node.status === 'removed') return 'reinsert';
  if (node.status === 'modified') return 'revert';
  return null;
}

function PropertiesSection({ pageId, schema, older, newer }: { pageId: string; schema: DatabaseSchema; older: CompareSide; newer: CompareSide }) {
  const a = useQuery({ queryKey: historyKeys.properties(pageId, older.at ?? 'now'), queryFn: () => historyApi.properties(pageId, older.at ?? undefined) });
  const b = useQuery({ queryKey: historyKeys.properties(pageId, newer.at ?? 'now'), queryFn: () => historyApi.properties(pageId, newer.at ?? undefined) });
  if (a.isLoading || b.isLoading) return null;
  if (!a.data || !b.data || !a.data.row) return null;
  const changes: Array<{ name: string; before: string; after: string }> = [];
  if (a.data.known && b.data.known) {
    if (a.data.title !== b.data.title) changes.push({ name: 'Titre', before: a.data.title || '—', after: b.data.title || '—' });
    for (const def of schema.properties) {
      if (def.type === 'title') continue;
      const va = a.data.values[def.id];
      const vb = b.data.values[def.id];
      if (!(def.id in a.data.values) && !(def.id in b.data.values)) continue;
      if (!sameValue(va, vb)) changes.push({ name: def.name, before: formatPropertyValue(def, va), after: formatPropertyValue(def, vb) });
    }
  }
  return (
    <section className="hdiff__props">
      <h4>Propriétés</h4>
      {!(a.data.known && b.data.known) ? (
        <p className="muted">L’état des propriétés n’est pas connu à cette date : leur historique n’était pas encore enregistré.</p>
      ) : changes.length === 0 ? (
        <p className="muted">Aucun changement de propriété.</p>
      ) : (
        <ul>
          {changes.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong> : <del className="hdiff__del">{c.before}</del> → <ins className="hdiff__ins">{c.after}</ins>
            </li>
          ))}
        </ul>
      )}
      {b.data.changedAt && (
        <p className="hdiff__meta">
          Dernière modification des propriétés : {formatDateTime(b.data.changedAt)}
          {b.data.changedBy ? `, par ${b.data.changedBy.name}` : ''}
        </p>
      )}
    </section>
  );
}

const sideLabel = (s: CompareSide) => (s.at === null ? 'État actuel' : `Version · ${formatDateTime(s.at)}`);

export function CompareView({
  pageId,
  workspaceId,
  older,
  newer,
  canRestore,
  parentDatabase,
  onRestored,
}: {
  pageId: string;
  workspaceId: string;
  older: CompareSide;
  newer: CompareSide;
  canRestore: boolean;
  parentDatabase: DatabaseSchema | null;
  onRestored: () => void;
}) {
  const [outcome, setOutcome] = useState<DiffOutcome | null>(null);
  const [changesOnly, setChangesOnly] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    setSelected(new Set());
    setCursor(-1);
    void runDiff(older.update, newer.update).then((o) => !cancelled && setOutcome(o));
    return () => {
      cancelled = true;
    };
  }, [older.update, newer.update]);

  const rows = useMemo(() => (outcome?.kind === 'ok' ? diffRows(outcome.result.nodes, changesOnly) : []), [outcome, changesOnly]);
  const changes = useMemo(() => changeIds(rows), [rows]);
  // Chosen blocks can be restored only into the current content, from the older version.
  const restorable = canRestore && newer.at === null && !!older.snapshotId;

  const go = (delta: number) => {
    if (changes.length === 0) return;
    const next = (cursor + delta + changes.length) % changes.length;
    setCursor(next);
    box.current?.querySelector(`[data-hid="${CSS.escape(changes[next]!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const restore = async (items: RestoreBlockItem[]) => {
    if (!older.snapshotId || items.length === 0) return;
    setBusy(true);
    try {
      const res = await historyApi.restoreBlocks(pageId, older.snapshotId, items);
      const n = res.restored.length;
      if (n > 0) toast.success(n > 1 ? `${n} blocs restaurés` : 'Bloc restauré');
      if (res.skipped.length > 0) {
        toast.error(
          `${res.skipped.length} bloc${res.skipped.length > 1 ? 's' : ''} ignoré${res.skipped.length > 1 ? 's' : ''} : ` +
            res.skipped.map((s) => (s.reason === 'exists' ? 'déjà présent' : s.reason === 'missing' ? 'n’existe plus' : 'absent de la version')).join(', '),
        );
      }
      setSelected(new Set());
      onRestored();
    } catch (e) {
      toast.error(errorMessage(e, 'Restauration impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const nodeById = useMemo(() => {
    const m = new Map<string, DiffNode>();
    for (const r of rows) if (r.kind === 'block') m.set(r.node.id, r.node);
    return m;
  }, [rows]);

  if (!outcome) {
    return (
      <div className="history__loading">
        <Spinner />
      </div>
    );
  }
  if (outcome.kind === 'too-large') return <EmptyState title="Page trop longue">La comparaison est limitée à 20 000 blocs. L’aperçu reste disponible.</EmptyState>;
  if (outcome.kind === 'error') return <EmptyState title="Comparaison impossible">Une des deux versions n’a pas pu être lue.</EmptyState>;
  const { stats } = outcome.result;
  const total = stats.added + stats.removed + stats.modified + stats.moved;

  return (
    <div className="hdiff" ref={box}>
      <div className="hdiff__head">
        <div className="hdiff__sides">
          {[older, newer].map((s, i) => (
            <div key={i} className="hdiff__side">
              <span className="hdiff__side-label">{i === 0 ? 'Avant' : 'Après'}</span>
              <strong>{sideLabel(s)}</strong>
              {s.authors.length > 0 && <span className="muted">par {s.authors.map((a) => a.name).join(', ')}</span>}
            </div>
          ))}
        </div>
        <div className="hdiff__summary" role="status">
          {total === 0 ? (
            'Aucune différence de contenu.'
          ) : (
            <>
              <span className="hdiff__chip is-added">{stats.added} ajouté{stats.added > 1 ? 's' : ''}</span>
              <span className="hdiff__chip is-removed">{stats.removed} supprimé{stats.removed > 1 ? 's' : ''}</span>
              <span className="hdiff__chip is-modified">{stats.modified} modifié{stats.modified > 1 ? 's' : ''}</span>
              <span className="hdiff__chip is-moved">{stats.moved} déplacé{stats.moved > 1 ? 's' : ''}</span>
            </>
          )}
        </div>
        <div className="hdiff__tools">
          <label className="hdiff__toggle">
            <input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} /> Changements seulement
          </label>
          <button type="button" className="btn btn--sm" disabled={changes.length === 0} onClick={() => go(-1)} title="Changement précédent">
            <ArrowUp size={14} />
          </button>
          <button type="button" className="btn btn--sm" disabled={changes.length === 0} onClick={() => go(1)} title="Changement suivant">
            <ArrowDown size={14} />
          </button>
          {restorable && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={selected.size === 0 || busy}
              onClick={() =>
                void restore(
                  [...selected].flatMap((id) => {
                    const n = nodeById.get(id);
                    const action = n && actionOf(n);
                    return action ? [{ blockId: id, action }] : [];
                  }),
                )
              }
            >
              {busy ? <Spinner size={14} /> : <RotateCcw size={14} />} Restaurer la sélection{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          )}
        </div>
      </div>

      {parentDatabase && <PropertiesSection pageId={pageId} schema={parentDatabase} older={older} newer={newer} />}

      <div className="hdiff__rows">
        {rows.slice(0, MAX_ROWS).map((r, i) => {
          if (r.kind === 'gap') {
            return (
              <div key={`gap-${i}`} className="hdiff__gap" style={{ marginLeft: r.depth * 20 }}>
                {r.count} bloc{r.count > 1 ? 's' : ''} inchangé{r.count > 1 ? 's' : ''}
              </div>
            );
          }
          const n = r.node;
          const action = restorable ? actionOf(n) : null;
          const notes: string[] = [];
          if (n.oldType) notes.push(`Type : ${typeLabel(n.oldType, n.old?.props)} → ${typeLabel(n.block.type, n.block.props)}`);
          for (const p of n.props) notes.push(`${propLabel(p.key)} : ${propValueLabel(p.before)} → ${propValueLabel(p.after)}`);
          if (n.formatChanged) notes.push('Mise en forme modifiée');
          const active = cursor >= 0 && changes[cursor] === n.id;
          return (
            <div
              key={`${n.id}-${i}`}
              data-hid={n.id}
              className={`hdiff__row is-${n.status}${n.moved ? ' is-moved' : ''}${r.context ? ' is-context' : ''}${active ? ' is-current' : ''}`}
              style={{ marginLeft: r.depth * 20 }}
            >
              {action && (
                <input
                  type="checkbox"
                  className="hdiff__check"
                  aria-label="Sélectionner ce bloc"
                  checked={selected.has(n.id)}
                  onChange={() => toggle(n.id)}
                />
              )}
              <div className="hdiff__main">
                <div className="hdiff__label">
                  <span>{typeLabel(n.block.type, n.block.props)}</span>
                  {STATUS_LABEL[n.status] && <span className={`hdiff__badge is-${n.status}`}>{STATUS_LABEL[n.status]}</span>}
                  {n.moved && <span className="hdiff__badge is-moved">Déplacé</span>}
                </div>
                <div className={`hdiff__text${n.block.type === 'codeBlock' ? ' is-code' : ''}`}>
                  <BlockBody node={n} workspaceId={workspaceId} />
                </div>
                {notes.length > 0 && <div className="hdiff__notes">{notes.join(' · ')}</div>}
              </div>
              {action && (
                <button type="button" className="btn btn--sm hdiff__act" disabled={busy} onClick={() => void restore([{ blockId: n.id, action }])}>
                  <Undo2 size={13} /> {action === 'reinsert' ? 'Réinsérer' : 'Rétablir ce texte'}
                </button>
              )}
            </div>
          );
        })}
        {rows.length > MAX_ROWS && <p className="muted">Affichage limité aux {MAX_ROWS} premières lignes.</p>}
      </div>
    </div>
  );
}
