// View of the « Cadre de canevas » block (H1), loaded on demand: the canvas document opened
// read-only through the collaboration channel (the reader's own rights: an invisible canvas is
// « Cadre inaccessible »), one frame or the whole canvas, live.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Frame, Lock } from 'lucide-react';
import { useCollab, useCollabState } from '../lib/collab';
import { openPagePicker, toast } from '../lib/ui';
import { pagePath, sharePath } from '../lib/util';
import { editorApi } from '../editor/editorApi';
import { isCanvasFormat } from '@oriel/shared';
import { CanvasStore, useCanvasObjects } from './store';
import { StaticCanvas, framesInOrder, regionOf } from './viewer';
import { pendingCanvasPick } from './editorBlocks';
import './canvas.css';

interface Props {
  blockId: string;
  pageId: string;
  frameId: string;
  canEdit: boolean;
  publicMode: boolean;
  workspaceId: string | null;
  hostPageId: string;
  update: (p: { pageId?: string; frameId?: string }) => void;
}

export default function FrameBlock(props: Props) {
  const { pageId, canEdit, blockId, update, hostPageId } = props;

  const pick = () =>
    openPagePicker({
      title: 'Choisir un canevas',
      exclude: new Set([hostPageId]),
      onPick: (target) => {
        if (target.kind !== 'page') return;
        void editorApi
          .pageInfo(target.id)
          .then((d) => {
            if (!isCanvasFormat(d.page.format)) toast.error('Cette page n’est pas un canevas.');
            else update({ pageId: target.id, frameId: '' });
          })
          .catch(() => toast.error('Canevas introuvable.'));
      },
    });

  useEffect(() => {
    if (!pageId && canEdit && pendingCanvasPick.has(blockId)) {
      pendingCanvasPick.delete(blockId);
      pick();
    }
  }, [blockId, pageId, canEdit]);

  if (!pageId) {
    return (
      <div className="or-cv-block or-cv-block-empty">
        <Frame size={16} />
        <span>Cadre de canevas</span>
        {canEdit && (
          <button type="button" className="ordb-btn is-outline is-sm" onClick={pick}>
            Choisir un canevas…
          </button>
        )}
      </div>
    );
  }
  return <LiveFrame {...props} onPick={pick} />;
}

function LiveFrame({ pageId, frameId, canEdit, publicMode, workspaceId, update, onPick }: Props & { onPick: () => void }) {
  const entry = useCollab(pageId, false);
  const state = useCollabState(entry);
  const store = useMemo(() => (entry ? new CanvasStore(entry.doc) : null), [entry]);
  useEffect(() => () => store?.destroy(), [store]);
  if (!entry || !state || !store) return <div className="or-cv-block or-cv-block-empty">Chargement du cadre…</div>;
  if (state.denied) {
    return (
      <div className="or-cv-block or-cv-block-empty">
        <Lock size={16} /> Cadre inaccessible
      </div>
    );
  }
  return <FrameContent store={store} synced={state.synced} pageId={pageId} frameId={frameId} canEdit={canEdit} publicMode={publicMode} workspaceId={workspaceId} update={update} onPick={onPick} />;
}

function FrameContent({
  store,
  synced,
  pageId,
  frameId,
  canEdit,
  publicMode,
  workspaceId,
  update,
  onPick,
}: {
  store: CanvasStore;
  synced: boolean;
  pageId: string;
  frameId: string;
  canEdit: boolean;
  publicMode: boolean;
  workspaceId: string | null;
  update: (p: { pageId?: string; frameId?: string }) => void;
  onPick: () => void;
}) {
  const objects = useCanvasObjects(store);
  const frames = framesInOrder(objects);
  const [region, setRegion] = useState(() => regionOf(objects, frameId || null));
  useEffect(() => setRegion(regionOf(objects, frameId || null)), [objects, frameId]);
  const frame = frameId ? frames.find((f) => f.id === frameId) : null;
  const href = publicMode ? sharePath(pageId) : workspaceId ? pagePath(workspaceId, pageId) : sharePath(pageId);
  return (
    <div className="or-cv-block">
      {region ? (
        <StaticCanvas className="or-cv-block-svg" objects={objects} region={region} env={{ publicMode }} label={frame?.name || 'Canevas'} />
      ) : (
        <div className="or-cv-block-empty">{!synced ? 'Chargement du cadre…' : frameId ? 'Ce cadre n’existe plus.' : 'Ce canevas est vide.'}</div>
      )}
      <div className="or-cv-block-bar">
        <Frame size={14} />
        {canEdit ? (
          <select
            aria-label="Cadre affiché"
            value={frame ? frame.id : ''}
            onChange={(e) => update({ frameId: e.target.value })}
            className="or-cv-block-select"
          >
            <option value="">Canevas entier</option>
            {frames.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name || 'Cadre'}
              </option>
            ))}
          </select>
        ) : (
          <span>{frame ? frame.name || 'Cadre' : 'Canevas entier'}</span>
        )}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <button type="button" className="link-button" onClick={onPick}>
            Changer de canevas
          </button>
        )}
        <Link to={href}>Ouvrir le canevas</Link>
      </div>
    </div>
  );
}
