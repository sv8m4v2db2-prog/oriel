// Version history: version list, read-only preview, comparison, restore (whole page or chosen
// blocks) and recovery of deleted blocks (G6, SPEC « Historique des versions »).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Drawer, SegmentedControl } from '@mantine/core';
import { ClockArrowLeft, RotateCcw } from 'lucide-react';
import type { SnapshotMeta, SnapshotResponse } from '@oriel/shared';
import { api, ApiError } from '../lib/api';
import { errorMessage, queryClient } from '../lib/queryClient';
import { qk } from '../lib/queryKeys';
import { useStore } from '../lib/store';
import { confirmDialog, historyStore, toast } from '../lib/ui';
import { formatDateTime, formatWhen } from '../lib/util';
import { Avatar, EmptyState, ErrorBoundary, Spinner } from '../components/common';
import { SnapshotPreview } from '../editor/SnapshotPreview';
import { CompareView, type CompareSide } from '../history/CompareView';
import { DeletedBlocks } from '../history/DeletedBlocks';
import { historyApi, historyKeys } from '../history/api';
import { canRestoreVersions } from '../history/access';
import { useWorkspaceCtx } from './WorkspaceContext';
import '../history/history.css';

const REASONS: Record<SnapshotMeta['reason'], string> = {
  auto: 'Enregistrement automatique',
  daily: 'Version du jour',
  'before-restore': 'Avant une restauration',
  restore: 'Restauration',
};

type Tab = 'preview' | 'compare' | 'deleted';
const CURRENT = 'current';

function reasonOf(s: SnapshotMeta): string {
  if (s.reason === 'restore' && s.restoredFrom) return `Restauration de la version : ${formatDateTime(s.restoredFrom.createdAt)}`;
  return REASONS[s.reason] ?? s.reason;
}

export function HistoryPanel() {
  const { pageId } = useStore(historyStore);
  const { workspaceId } = useWorkspaceCtx();
  const close = () => historyStore.set({ pageId: null });
  const list = useQuery({
    queryKey: qk.snapshots(pageId ?? ''),
    queryFn: () => api.pages.snapshots(pageId!),
    enabled: !!pageId,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
  });
  const detail = useQuery({ queryKey: qk.page(pageId ?? ''), queryFn: () => api.pages.get(pageId!), enabled: !!pageId });
  const [tab, setTab] = useState<Tab>('preview');
  const [selected, setSelected] = useState<string | null>(null);
  const [against, setAgainst] = useState<string>(CURRENT);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const current = useQuery({
    queryKey: historyKeys.current(pageId ?? ''),
    queryFn: () => historyApi.current(pageId!),
    enabled: !!pageId && tab === 'compare',
    staleTime: 0,
  });
  const otherSnap = useQuery({
    queryKey: ['history', 'snapshot', pageId, against],
    queryFn: () => api.pages.snapshot(pageId!, against),
    enabled: !!pageId && tab === 'compare' && against !== CURRENT,
  });

  useEffect(() => {
    setSelected(null);
    setSnapshot(null);
    setTab('preview');
    setAgainst(CURRENT);
  }, [pageId]);

  useEffect(() => {
    if (!selected && list.data?.snapshots[0]) setSelected(list.data.snapshots[0].id);
  }, [list.data, selected]);

  useEffect(() => {
    if (!pageId || !selected) return;
    let cancelled = false;
    setLoading(true);
    api.pages
      .snapshot(pageId, selected)
      .then((s) => !cancelled && setSnapshot(s))
      .catch((e) => {
        if (!cancelled) {
          setSnapshot(null);
          toast.error(errorMessage(e, 'Version illisible.'));
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [pageId, selected]);

  const refreshAfterRestore = () => {
    if (!pageId) return;
    void queryClient.invalidateQueries({ queryKey: qk.snapshots(pageId) });
    void queryClient.invalidateQueries({ queryKey: historyKeys.current(pageId) });
    void queryClient.invalidateQueries({ queryKey: historyKeys.deleted(pageId) });
    void queryClient.invalidateQueries({ queryKey: ['history', 'properties', pageId] });
  };

  const restore = async () => {
    if (!pageId || !selected) return;
    const meta = list.data?.snapshots.find((s) => s.id === selected);
    const ok = await confirmDialog({
      title: 'Restaurer cette version ?',
      message: `Le contenu de la page sera ramené à la version enregistrée ${meta ? formatWhen(meta.createdAt) : ''}. Les personnes connectées verront le changement en direct, et l’état actuel restera dans l’historique.`,
      confirmLabel: 'Restaurer',
    });
    if (!ok) return;
    setRestoring(true);
    try {
      await historyApi.restore(pageId, selected);
      toast.success('Version restaurée');
      refreshAfterRestore();
      close();
    } catch (e) {
      toast.error(errorMessage(e, 'Restauration impossible.'));
    } finally {
      setRestoring(false);
    }
  };

  const canEdit = canRestoreVersions(detail.data);
  const denied = list.error instanceof ApiError && list.error.status === 403;
  const metaOf = (id: string) => list.data?.snapshots.find((s) => s.id === id);

  // Older side = the earlier of the two; the current content is always the newer side.
  const sides = useMemo((): { older: CompareSide; newer: CompareSide } | null => {
    if (!snapshot || !selected) return null;
    const mine: CompareSide = { snapshotId: selected, at: snapshot.snapshot.createdAt, update: snapshot.update, authors: snapshot.snapshot.authors };
    if (against === CURRENT) {
      if (!current.data) return null;
      return { older: mine, newer: { snapshotId: null, at: null, update: current.data.update, authors: [] } };
    }
    if (!otherSnap.data) return null;
    const other: CompareSide = { snapshotId: against, at: otherSnap.data.snapshot.createdAt, update: otherSnap.data.update, authors: otherSnap.data.snapshot.authors };
    return other.at! < mine.at! ? { older: other, newer: mine } : { older: mine, newer: other };
  }, [snapshot, selected, against, current.data, otherSnap.data]);

  return (
    <Drawer
      opened={!!pageId}
      onClose={close}
      position="right"
      size={1040}
      // Below the confirmation dialogs (z-index 200, mounted earlier): otherwise they open hidden.
      zIndex={190}
      title={
        <span className="drawer-title">
          <ClockArrowLeft size={17} /> Historique des versions
        </span>
      }
      classNames={{ body: 'history__drawer-body' }}
    >
      {denied ? (
        <EmptyState title="Historique réservé aux membres de l’espace">Votre rôle permet de lire la page, pas ses anciennes versions.</EmptyState>
      ) : (
        <div className="history">
          <div className="history__list" role="listbox" aria-label="Versions">
            {list.isLoading && (
              <div className="history__loading">
                <Spinner />
              </div>
            )}
            {list.data && list.data.snapshots.length === 0 && (
              <EmptyState title="Aucune version">Les versions sont enregistrées automatiquement pendant l’édition.</EmptyState>
            )}
            {list.data?.snapshots.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === selected}
                className={`history__item${s.id === selected ? ' is-active' : ''}`}
                onClick={() => {
                  setSelected(s.id);
                  if (against === s.id) setAgainst(CURRENT);
                }}
              >
                <span className="history__date">{formatDateTime(s.createdAt)}</span>
                <span className="history__reason">{reasonOf(s)}</span>
                {s.authors.length > 0 && (
                  <span className="history__authors">
                    {s.authors.slice(0, 4).map((a) => (
                      <Avatar key={a.id} name={a.name} id={a.id} url={a.avatarUrl} size={18} />
                    ))}
                    <span>{s.authors.map((a) => a.name).join(', ')}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="history__preview">
            <div className="history__toolbar">
              <SegmentedControl
                className="hist-tabs"
                size="xs"
                value={tab}
                onChange={(v) => setTab(v as Tab)}
                data={[
                  { value: 'preview', label: 'Aperçu' },
                  { value: 'compare', label: 'Comparer' },
                  { value: 'deleted', label: 'Blocs supprimés' },
                ]}
              />
              {tab === 'compare' && list.data && (
                <label className="hist-against">
                  Comparer avec
                  <select value={against} onChange={(e) => setAgainst(e.target.value)}>
                    <option value={CURRENT}>État actuel</option>
                    {list.data.snapshots
                      .filter((s) => s.id !== selected)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {formatDateTime(s.createdAt)} — {reasonOf(s)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {canEdit && tab !== 'deleted' && (
                <button type="button" className="btn btn--primary btn--sm" disabled={!snapshot || restoring} onClick={() => void restore()}>
                  {restoring ? <Spinner size={14} /> : <RotateCcw size={14} />} Restaurer cette version
                </button>
              )}
            </div>
            <div className="history__content">
              {tab === 'deleted' && pageId && <DeletedBlocks pageId={pageId} canEdit={canEdit} onRestored={refreshAfterRestore} />}
              {tab !== 'deleted' && loading && (
                <div className="history__loading">
                  <Spinner />
                </div>
              )}
              {tab === 'preview' && !loading && snapshot && pageId && (
                <>
                  {metaOf(snapshot.snapshot.id) && <p className="muted hist-caption">Aperçu en lecture seule</p>}
                  <ErrorBoundary resetKey={snapshot.snapshot.id}>
                    <SnapshotPreview update={snapshot.update} workspaceId={workspaceId} pageId={pageId} />
                  </ErrorBoundary>
                </>
              )}
              {tab === 'compare' && !loading && pageId && (
                <ErrorBoundary resetKey={`${selected}-${against}`}>
                  {sides ? (
                    <CompareView
                      pageId={pageId}
                      workspaceId={workspaceId}
                      older={sides.older}
                      newer={sides.newer}
                      canRestore={canEdit}
                      parentDatabase={detail.data?.parentDatabase ?? null}
                      onRestored={refreshAfterRestore}
                    />
                  ) : (
                    <div className="history__loading">
                      <Spinner />
                    </div>
                  )}
                </ErrorBoundary>
              )}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
