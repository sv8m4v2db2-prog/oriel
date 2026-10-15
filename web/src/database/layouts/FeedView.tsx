// Feed view: one post per row (author, date, visible properties), with the first lines of the
// row's content and its number of open comments (GET …/previews, under the rows query key so
// real-time row invalidations refresh it). A click opens the row in the side panel.
import { useMemo } from 'react';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type { Page, RowPreviewsResponse, ViewConfig } from '@oriel/shared';
import { navigation } from '../../lib/navigation';
import { formatRelative } from '../../lib/util';
import { dbExtrasApi } from '../api';
import { useDb } from '../context';
import { rowsKey } from '../data';
import { openRowMenu } from '../ui/contextMenus';
import { useChunk } from '../ui/hooks';
import { Avatar, cx, NativeSelect, Toggle } from '../ui/primitives';
import type { ViewState } from '../view/types';
import { AddRowButton, CardProperties, coverStyle, EmptyState, openRow, RowIcon } from './common';
import '../views.css';

const STEP = 30;

/** Previews of the shown rows, fetched by batches of STEP ids (a batch is fetched once). */
function usePreviews(ids: string[], lines: number) {
  const { databaseId, publicMode } = useDb();
  // Public pages have no comment counts: nothing to fetch when no line is previewed.
  const wanted = lines > 0 || !publicMode;
  const batches = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += STEP) out.push(ids.slice(i, i + STEP));
    return out;
  }, [ids]);
  const results = useQueries({
    queries: batches.map((batch) => ({
      queryKey: [...rowsKey(databaseId, publicMode), 'previews', lines, batch.join(',')],
      queryFn: () => dbExtrasApi.previews(databaseId, batch, Math.max(1, lines), publicMode),
      enabled: wanted && batch.length > 0,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    })),
  });
  return useMemo(() => {
    const map = new Map<string, RowPreviewsResponse['previews'][string]>();
    for (const r of results) for (const [id, p] of Object.entries(r.data?.previews ?? {})) map.set(id, p);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')]);
}

function FeedPost({ row, vs, preview, lines }: { row: Page; vs: ViewState; preview?: { text: string; comments: number }; lines: number }) {
  const db = useDb();
  const author = db.ctx.users.get(row.createdBy);
  const cover = vs.config.cardCover === 'cover' ? coverStyle(row.cover, row.format?.coverPosition) : null;
  return (
    <article
      className="ordb-feed-post"
      role="button"
      tabIndex={0}
      aria-label={row.title || 'Sans titre'}
      onClick={() => openRow(row.id)}
      onContextMenu={(e) => openRowMenu(e, db, row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigation.openPeek(row.id);
      }}
    >
      {cover && <div className="ordb-feed-cover" style={cover} />}
      <header className="ordb-feed-head">
        <Avatar user={author} id={row.createdBy} size={22} />
        <span className="ordb-feed-author">{author?.name ?? 'Utilisateur inconnu'}</span>
        <span className="ordb-feed-date" title={new Date(row.createdAt).toLocaleString('fr-FR')}>
          {formatRelative(row.createdAt)}
        </span>
      </header>
      <h3 className="ordb-feed-title">
        <RowIcon row={row} size={18} />
        <span className={cx(!row.title && 'is-empty')}>{row.title || 'Sans titre'}</span>
      </h3>
      <CardProperties row={row} props={vs.visibleProps} />
      {lines > 0 && preview?.text && (
        <p className="ordb-feed-preview" style={{ WebkitLineClamp: lines }}>
          {preview.text}
        </p>
      )}
      {!!preview?.comments && (
        <footer className="ordb-feed-foot">
          <MessageSquare size={13} aria-hidden />
          {preview.comments} commentaire{preview.comments > 1 ? 's' : ''} ouvert{preview.comments > 1 ? 's' : ''}
        </footer>
      )}
    </article>
  );
}

export function FeedView({ vs }: { vs: ViewState }) {
  const { canEdit } = useDb();
  const lines = vs.config.feedPreviewLines ?? 3;
  // Without a sort rule, the newest posts come first.
  const rows = useMemo(() => (vs.manualOrder ? [...vs.rows].reverse().sort((a, b) => b.createdAt - a.createdAt) : vs.rows), [vs.rows, vs.manualOrder]);
  const chunk = useChunk(rows.length, STEP, vs.view.id);
  const shown = rows.slice(0, chunk.count);
  const ids = useMemo(() => shown.map((r) => r.id), [shown.map((r) => r.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const previews = usePreviews(ids, lines);

  if (rows.length === 0) {
    return (
      <EmptyState
        action={canEdit ? <AddRowButton label="Nouvelle publication" onClick={() => vs.createRow(undefined, { open: true })} /> : undefined}
      >
        {vs.totalRows > 0 ? 'Aucune publication ne correspond aux filtres.' : 'Aucune publication pour le moment.'}
      </EmptyState>
    );
  }
  return (
    <div className="ordb-feed">
      {shown.map((r) => (
        <FeedPost key={r.id} row={r} vs={vs} preview={previews.get(r.id)} lines={lines} />
      ))}
      {chunk.hasMore && (
        <div ref={chunk.sentinel} className="ordb-more">
          <button type="button" className="ordb-linkbtn" onClick={chunk.showMore}>
            Afficher plus ({rows.length - chunk.count})
          </button>
        </div>
      )}
      {canEdit && <AddRowButton label="Nouvelle publication" onClick={() => vs.createRow(undefined, { open: true })} />}
    </div>
  );
}

/** « Disposition » options of a feed view. */
export function FeedOptions({ config, set }: { config: ViewConfig; set: (patch: Partial<ViewConfig>) => void }) {
  return (
    <>
      <div className="ordb-field-row">
        <span>Aperçu du contenu</span>
        <NativeSelect
          ariaLabel="Lignes de contenu affichées"
          value={String(config.feedPreviewLines ?? 3)}
          onChange={(v) => set({ feedPreviewLines: Number(v) })}
          choices={[
            { value: '0', label: 'Aucun' },
            { value: '1', label: '1 ligne' },
            { value: '2', label: '2 lignes' },
            { value: '3', label: '3 lignes' },
            { value: '5', label: '5 lignes' },
            { value: '10', label: '10 lignes' },
          ]}
        />
      </div>
      <Toggle
        label="Image de couverture"
        checked={config.cardCover === 'cover'}
        onChange={(on) => set({ cardCover: on ? 'cover' : 'none' })}
      />
    </>
  );
}
