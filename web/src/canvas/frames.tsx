// Frames of a canvas (H1): ordered list (rename, reorder by drag or arrows, go to, present from)
// and the full-screen presentation, one frame per slide.
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Play, X } from 'lucide-react';
import { CANVAS_LIMITS, positionBetween, type CanvasFrame, type CanvasObject } from '@oriel/shared';
import type { CanvasStore } from './store';
import { StaticCanvas } from './viewer';

export function FramesPanel({
  store,
  frames,
  readOnly,
  onClose,
  onGo,
  onPresent,
}: {
  store: CanvasStore;
  frames: CanvasFrame[];
  readOnly: boolean;
  onClose: () => void;
  onGo: (f: CanvasFrame) => void;
  onPresent: (f: CanvasFrame) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  /** Moves `id` to index `to` of the ordered list (only its order key changes). */
  const moveTo = (id: string, to: number) => {
    const rest = frames.filter((f) => f.id !== id);
    const before = rest[to - 1]?.order ?? null;
    const after = rest[to]?.order ?? null;
    const f = frames.find((x) => x.id === id);
    if (!f || readOnly) return;
    store.checkpoint();
    store.put({ ...f, order: positionBetween(before, after === before ? null : after) });
  };

  return (
    <aside className="or-cv-frames or-cv-chrome-scroll" aria-label="Cadres">
      <div className="or-cv-frames-head">
        <span>Cadres</span>
        <button type="button" className="or-cv-btn" aria-label="Fermer" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {frames.length === 0 ? (
        <p className="or-cv-frames-empty">Aucun cadre. Utilisez l’outil Cadre (F) pour délimiter des diapositives.</p>
      ) : (
        <ol className="or-cv-frames-list">
          {frames.map((f, i) => (
            <li
              key={f.id}
              className={`or-cv-frame-item${dragId === f.id ? ' is-dragging' : ''}`}
              draggable={!readOnly && renaming !== f.id}
              onDragStart={(e) => {
                setDragId(f.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/x-oriel-frame', f.id);
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== f.id) moveTo(dragId, i);
                setDragId(null);
              }}
            >
              {!readOnly && <GripVertical size={14} className="or-cv-frame-grip" aria-hidden />}
              <span className="or-cv-frame-num">{i + 1}</span>
              {renaming === f.id ? (
                <input
                  className="or-cv-frame-input"
                  defaultValue={f.name}
                  maxLength={CANVAS_LIMITS.label}
                  autoFocus
                  aria-label="Nom du cadre"
                  onBlur={(e) => {
                    setRenaming(null);
                    if (e.target.value !== f.name) store.put({ ...f, name: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                  }}
                />
              ) : (
                <button type="button" className="or-cv-frame-name" onClick={() => onGo(f)} onDoubleClick={() => !readOnly && setRenaming(f.id)} title="Aller au cadre (double-clic : renommer)">
                  {f.name || 'Cadre'}
                </button>
              )}
              {!readOnly && (
                <>
                  <button type="button" className="or-cv-btn or-cv-btn--sm" aria-label="Monter" disabled={i === 0} onClick={() => moveTo(f.id, i - 1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" className="or-cv-btn or-cv-btn--sm" aria-label="Descendre" disabled={i === frames.length - 1} onClick={() => moveTo(f.id, i + 1)}>
                    <ArrowDown size={13} />
                  </button>
                </>
              )}
              <button type="button" className="or-cv-btn or-cv-btn--sm" aria-label="Présenter à partir de ce cadre" onClick={() => onPresent(f)}>
                <Play size={13} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

export function Presentation({
  objects,
  frames,
  startId,
  publicMode,
  onClose,
}: {
  objects: ReadonlyMap<string, CanvasObject>;
  frames: CanvasFrame[];
  startId: string;
  publicMode: boolean;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => Math.max(0, frames.findIndex((f) => f.id === startId)));
  const ref = useRef<HTMLDivElement>(null);
  const frame = frames[Math.min(index, frames.length - 1)];

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    if (el && document.fullscreenEnabled && !document.fullscreenElement) void el.requestFullscreen().catch(() => undefined);
    const onFs = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  const next = () => setIndex((i) => Math.min(frames.length - 1, i + 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));

  if (!frame) return null;
  return (
    <div
      ref={ref}
      className="or-cv-present"
      tabIndex={-1}
      role="dialog"
      aria-label={`Présentation : ${frame.name || 'Cadre'} (${index + 1} sur ${frames.length})`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
          e.preventDefault();
          next();
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') {
          e.preventDefault();
          prev();
        } else if (e.key === 'Home') setIndex(0);
        else if (e.key === 'End') setIndex(frames.length - 1);
        else if (e.key === 'Escape') onClose();
      }}
    >
      <StaticCanvas className="or-cv-present-svg" objects={objects} region={{ x: frame.x, y: frame.y, w: frame.w, h: frame.h }} env={{ publicMode }} label={frame.name || 'Cadre'} />
      <div className="or-cv-present-bar">
        <button type="button" className="or-cv-btn" aria-label="Précédent" onClick={prev} disabled={index === 0}>
          <ChevronLeft size={18} />
        </button>
        <span className="or-cv-present-count">
          {frame.name || 'Cadre'} · {index + 1} / {frames.length}
        </span>
        <button type="button" className="or-cv-btn" aria-label="Suivant" onClick={next} disabled={index === frames.length - 1}>
          <ChevronRight size={18} />
        </button>
        <button type="button" className="or-cv-btn" aria-label="Quitter la présentation" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
