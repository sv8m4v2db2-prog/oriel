// Image block with a non destructive crop and a hyperlink (E15). Replaces BlockNote's native `image`
// block (same props and behaviour: upload, caption, width handles, alignment) and adds `crop`, `link`.
import { useEffect, useRef, useState } from 'react';
import { createImageBlockConfig, imageParse } from '@blocknote/core';
import { ResizableFileBlockWrapper, createReactBlockSpec, useResolveUrl } from '@blocknote/react';
import { Modal } from '@mantine/core';
import { Crop, ExternalLink, ImageIcon, Link2, RotateCcw } from 'lucide-react';
import { useEditorEnv } from './env';
import { withSafeProps } from './safeProps';
import { cropAspect, cropImageStyle, dragCrop, imageLink, objectViewBox, parseCrop, serializeCrop, type CropHandle, type CropRect } from './imageLogic';

type AnyEditor = { isEditable: boolean; updateBlock: (id: string, update: unknown) => unknown };
const Z = 400;

function openLink(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

function CropDialog({ src, initial, onApply, onReset, onClose }: { src: string; initial: CropRect | null; onApply: (r: CropRect) => void; onReset: () => void; onClose: () => void }) {
  const [rect, setRect] = useState<CropRect>(initial ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: CropHandle; x: number; y: number; start: CropRect } | null>(null);

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = stage.current?.getBoundingClientRect();
    if (!d || !box || box.width === 0) return;
    setRect(dragCrop(d.start, d.handle, (e.clientX - d.x) / box.width, (e.clientY - d.y) / box.height));
  };
  const onUp = () => {
    drag.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  useEffect(() => onUp, []); // eslint-disable-line react-hooks/exhaustive-deps
  const begin = (handle: CropHandle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const pct = (n: number) => `${n * 100}%`;
  return (
    <Modal opened onClose={onClose} title="Recadrer l’image" centered size="xl" zIndex={Z}>
      <div className="or-crop__stage" ref={stage}>
        <img src={src} alt="" draggable={false} className="or-crop__img" />
        <div className="or-crop__shade" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${pct(rect.x)} ${pct(rect.y)},${pct(rect.x)} ${pct(rect.y + rect.h)},${pct(rect.x + rect.w)} ${pct(rect.y + rect.h)},${pct(rect.x + rect.w)} ${pct(rect.y)},${pct(rect.x)} ${pct(rect.y)})` }} />
        <div className="or-crop__rect" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }} onPointerDown={begin('move')}>
          {HANDLES.map((h) => (
            <span key={h} className={`or-crop__handle or-crop__handle--${h}`} onPointerDown={begin(h)} />
          ))}
        </div>
      </div>
      <p className="or-media__muted">L’image d’origine n’est pas modifiée : vous pouvez rouvrir le recadrage ou le réinitialiser.</p>
      <div className="or-crop__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onReset}>
          <RotateCcw size={14} /> Réinitialiser
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => onApply(rect)}>
          Appliquer
        </button>
      </div>
    </Modal>
  );
}

function ImageView(props: { block: { id: string; props: Record<string, unknown> }; editor: AnyEditor } & Record<string, unknown>) {
  const { block, editor } = props;
  const env = useEditorEnv();
  const url = String(block.props.url ?? '');
  const resolved = useResolveUrl(url);
  const src = resolved.loadingState === 'loading' ? url : resolved.downloadUrl;
  const crop = parseCrop(block.props.crop);
  const link = imageLink(block.props.link);
  const previewWidth = typeof block.props.previewWidth === 'number' ? block.props.previewWidth : undefined;
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [dialog, setDialog] = useState<'crop' | 'link' | null>(null);
  const [draftLink, setDraftLink] = useState('');
  const canEdit = env.canEdit && env.mode === 'app' && editor.isEditable;

  const update = (props: Record<string, unknown>) => {
    try {
      editor.updateBlock(block.id, { props } as never);
    } catch {
      /* block removed meanwhile */
    }
  };
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => setNat({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 });

  let visual: React.ReactNode;
  if (crop && nat) {
    const width = previewWidth ?? Math.round(nat.w * crop.w);
    visual = (
      <div className="or-image__crop" style={{ width, maxWidth: '100%', aspectRatio: String(cropAspect(crop, nat.w, nat.h)) }} contentEditable={false}>
        <img className="bn-visual-media or-image__crop-img" src={src} alt={String(block.props.name ?? '')} draggable={false} style={cropImageStyle(crop)} onLoad={onLoad} />
      </div>
    );
  } else {
    visual = (
      <img
        className="bn-visual-media"
        src={src}
        alt={String(block.props.name ?? '')}
        width={previewWidth}
        contentEditable={false}
        draggable={false}
        onLoad={onLoad}
        style={crop ? { visibility: 'hidden' } : undefined}
      />
    );
  }
  if (link) {
    visual = (
      <a
        className="or-image__link"
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        draggable={false}
        onClick={(e) => {
          // Editing: a click selects the image; ⌘/Ctrl-click follows the link.
          if (canEdit && !(e.metaKey || e.ctrlKey)) e.preventDefault();
        }}
      >
        {visual}
      </a>
    );
  }

  return (
    <ResizableFileBlockWrapper {...(props as unknown as React.ComponentProps<typeof ResizableFileBlockWrapper>)} buttonIcon={<ImageIcon size={24} />}>
      {visual}
      {url && (canEdit || link) && (
        <div className="or-image__tools" contentEditable={false}>
          {canEdit && (
            <>
              <button type="button" title="Recadrer" onMouseDown={(e) => e.preventDefault()} onClick={() => setDialog('crop')}>
                <Crop size={14} />
              </button>
              <button
                type="button"
                title="Lien"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setDraftLink(String(block.props.link ?? ''));
                  setDialog('link');
                }}
              >
                <Link2 size={14} />
              </button>
            </>
          )}
          {link && (
            <button type="button" title="Ouvrir le lien" onMouseDown={(e) => e.preventDefault()} onClick={() => openLink(link)}>
              <ExternalLink size={14} />
            </button>
          )}
        </div>
      )}
      {dialog === 'crop' && (
        <CropDialog
          src={src ?? ''}
          initial={crop}
          onClose={() => setDialog(null)}
          onApply={(r) => {
            update({ crop: serializeCrop(r) });
            setDialog(null);
          }}
          onReset={() => {
            update({ crop: '' });
            setDialog(null);
          }}
        />
      )}
      {dialog === 'link' && (
        <Modal opened onClose={() => setDialog(null)} title="Lien de l’image" centered zIndex={Z}>
          <input
            className="input"
            style={{ width: '100%' }}
            autoFocus
            placeholder="https://exemple.fr"
            aria-label="Adresse du lien"
            value={draftLink}
            onChange={(e) => setDraftLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (draftLink.trim() === '' || imageLink(draftLink))) {
                update({ link: draftLink.trim() === '' ? '' : imageLink(draftLink) });
                setDialog(null);
              }
            }}
          />
          {draftLink.trim() !== '' && !imageLink(draftLink) && <p className="or-media__muted">Adresse refusée : http, https, mailto ou tel uniquement.</p>}
          <div className="or-crop__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { update({ link: '' }); setDialog(null); }}>
              Retirer le lien
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={draftLink.trim() !== '' && !imageLink(draftLink)}
              onClick={() => {
                update({ link: draftLink.trim() === '' ? '' : imageLink(draftLink) });
                setDialog(null);
              }}
            >
              Enregistrer
            </button>
          </div>
        </Modal>
      )}
    </ResizableFileBlockWrapper>
  );
}

const baseConfig = (createImageBlockConfig as any)({}) as { type: 'image'; propSchema: Record<string, unknown>; content: 'none' };

const imageConfig = {
  ...baseConfig,
  propSchema: { ...baseConfig.propSchema, crop: { default: '' as string }, link: { default: '' as string } },
} as const;

export const ImageBlock = () =>
  withSafeProps(
    (createReactBlockSpec as any)(imageConfig, {
      meta: { fileBlockAccept: ['image/*'] },
      render: (props: any) => <ImageView {...props} />,
      parse: (element: HTMLElement) => {
        const parsed = (imageParse as any)({})(element);
        const anchor = element.closest('a');
        const href = anchor ? imageLink(anchor.getAttribute('href')) : null;
        return parsed && href ? { ...parsed, link: href } : parsed;
      },
      toExternalHTML: ({ block }: any) => {
        const props = block.props as Record<string, unknown>;
        if (!props.url) return <p>Ajouter une image</p>;
        const crop = parseCrop(props.crop);
        const link = imageLink(props.link);
        const img = (
          <img src={String(props.url)} alt={String(props.name ?? '')} width={typeof props.previewWidth === 'number' ? props.previewWidth : undefined} style={crop ? ({ objectViewBox: objectViewBox(crop) } as React.CSSProperties) : undefined} />
        );
        const body = link ? <a href={link}>{img}</a> : img;
        return props.caption ? (
          <figure>
            {body}
            <figcaption>{String(props.caption)}</figcaption>
          </figure>
        ) : (
          body
        );
      },
      runsBefore: ['file'],
    })(),
  );
