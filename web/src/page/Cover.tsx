// Page cover: image / gradient / color, change / reposition / remove.
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Popover } from '@mantine/core';
import { ImagePlus, MoveVertical } from 'lucide-react';
import { COVER_COLORS, COVER_GRADIENTS, type Cover } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/queryClient';
import { toast } from '../lib/ui';
import { Spinner } from '../components/common';

export function coverBackground(cover: Cover): string | undefined {
  if (cover.type === 'gradient') return COVER_GRADIENTS[cover.value] ?? COVER_GRADIENTS.glacier;
  if (cover.type === 'color') return COVER_COLORS[cover.value] ?? COVER_COLORS.blue;
  return undefined;
}

export function randomCover(): Cover {
  const keys = Object.keys(COVER_GRADIENTS);
  return { type: 'gradient', value: keys[Math.floor(Math.random() * keys.length)]! };
}

const GRADIENT_LABELS: Record<string, string> = {
  aurora: 'Aurore',
  glacier: 'Glacier',
  dawn: 'Aube',
  lagoon: 'Lagon',
  lavender: 'Lavande',
  ember: 'Braise',
  night: 'Nuit',
  moss: 'Mousse',
};

export function CoverPicker({ workspaceId, onPick }: { workspaceId: string | null; onPick: (cover: Cover) => void }) {
  const [tab, setTab] = useState<'gallery' | 'upload' | 'link'>('gallery');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined) => {
    if (!file || !workspaceId) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choisissez un fichier image.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.workspaces.upload(workspaceId, file);
      onPick({ type: 'image', url: res.url });
    } catch (e) {
      toast.error(errorMessage(e, 'Envoi impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const submitLink = (e: FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!/^https?:\/\//i.test(v) && !v.startsWith('/api/files/')) {
      toast.error('Saisissez une adresse commençant par https://');
      return;
    }
    onPick({ type: 'image', url: v });
  };

  return (
    <div className="cover-picker">
      <div className="tabs tabs--small" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'gallery'} className={tab === 'gallery' ? 'is-active' : ''} onClick={() => setTab('gallery')}>
          Galerie
        </button>
        {workspaceId && (
          <button type="button" role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'is-active' : ''} onClick={() => setTab('upload')}>
            Importer
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'is-active' : ''} onClick={() => setTab('link')}>
          Lien
        </button>
      </div>
      {tab === 'gallery' && (
        <div className="cover-picker__body">
          <div className="cover-picker__label">Dégradés</div>
          <div className="cover-picker__grid">
            {Object.entries(COVER_GRADIENTS).map(([key, bg]) => (
              <button
                key={key}
                type="button"
                className="cover-swatch"
                style={{ background: bg }}
                title={GRADIENT_LABELS[key] ?? key}
                aria-label={GRADIENT_LABELS[key] ?? key}
                onClick={() => onPick({ type: 'gradient', value: key })}
              />
            ))}
          </div>
          <div className="cover-picker__label">Couleurs</div>
          <div className="cover-picker__grid">
            {Object.entries(COVER_COLORS).map(([key, bg]) => (
              <button
                key={key}
                type="button"
                className="cover-swatch"
                style={{ background: bg }}
                aria-label={key}
                onClick={() => onPick({ type: 'color', value: key })}
              />
            ))}
          </div>
        </div>
      )}
      {tab === 'upload' && (
        <div className="cover-picker__body cover-picker__upload">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? <Spinner size={14} /> : <ImagePlus size={15} />} Choisir une image
          </button>
          <p className="muted">Images larges recommandées (au moins 1500 px de large).</p>
        </div>
      )}
      {tab === 'link' && (
        <form className="cover-picker__body cover-picker__link" onSubmit={submitLink}>
          <input className="input input--sm" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          <button type="submit" className="btn btn--primary btn--sm">
            Utiliser
          </button>
        </form>
      )}
    </div>
  );
}

export function PageCover({
  cover,
  position,
  canEdit,
  workspaceId,
  onChange,
  onPositionChange,
}: {
  cover: Cover;
  position: number;
  canEdit: boolean;
  workspaceId: string | null;
  onChange: (cover: Cover | null) => void;
  onPositionChange: (position: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [pos, setPos] = useState(position);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!repositioning) setPos(position);
  }, [position, repositioning]);

  const startDrag = (e: ReactPointerEvent) => {
    if (!repositioning) return;
    e.preventDefault();
    const startY = e.clientY;
    const startPos = pos;
    const height = ref.current?.clientHeight ?? 240;
    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientY - startY) / height) * 100;
      setPos(Math.min(100, Math.max(0, startPos - delta)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const isImage = cover.type === 'image';
  return (
    <div ref={ref} className={`page-cover${repositioning ? ' is-repositioning' : ''}`} style={{ background: coverBackground(cover) }} onPointerDown={startDrag}>
      {isImage && <img src={cover.url} alt="" draggable={false} style={{ objectPosition: `center ${pos}%` }} />}
      {repositioning && <div className="page-cover__hint">Faites glisser l’image pour la repositionner</div>}
      {canEdit && (
        <div className={`page-cover__controls${pickerOpen || repositioning ? ' is-visible' : ''}`}>
          {repositioning ? (
            <>
              <button
                type="button"
                className="cover-btn"
                onClick={() => {
                  onPositionChange(Math.round(pos));
                  setRepositioning(false);
                }}
              >
                Enregistrer la position
              </button>
              <button
                type="button"
                className="cover-btn"
                onClick={() => {
                  setPos(position);
                  setRepositioning(false);
                }}
              >
                Annuler
              </button>
            </>
          ) : (
            <>
              <Popover opened={pickerOpen} onChange={setPickerOpen} position="bottom-end" width={380} shadow="md" withinPortal>
                <Popover.Target>
                  <button type="button" className="cover-btn" onClick={() => setPickerOpen((o) => !o)}>
                    Changer la couverture
                  </button>
                </Popover.Target>
                <Popover.Dropdown className="popover-panel">
                  <CoverPicker
                    workspaceId={workspaceId}
                    onPick={(c) => {
                      onChange(c);
                      setPickerOpen(false);
                    }}
                  />
                </Popover.Dropdown>
              </Popover>
              {isImage && (
                <button type="button" className="cover-btn" onClick={() => setRepositioning(true)}>
                  <MoveVertical size={13} /> Repositionner
                </button>
              )}
              <button type="button" className="cover-btn" onClick={() => onChange(null)}>
                Retirer
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
