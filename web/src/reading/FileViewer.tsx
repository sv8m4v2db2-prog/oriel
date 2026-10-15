// Full-screen viewer of a page's attachments (SPEC §13.8).
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, X } from 'lucide-react';
import { getEditor } from '../editor/registry';
import { canFramePdf } from '../editor/frameGuards';
import { useStore } from '../lib/store';
import { closeFileViewer, fileViewerStore } from './store';
import { collectFiles, isViewableUrl, type PageFile } from './outlineLogic';

export function FileViewer() {
  const state = useStore(fileViewerStore);
  if (!state) return null;
  return createPortal(<Viewer key={state.pageId} pageId={state.pageId} blockId={state.blockId} />, document.body);
}

function Viewer({ pageId, blockId }: { pageId: string; blockId: string | null }) {
  const files = useMemo(() => collectFiles(getEditor(pageId)?.document), [pageId]);
  const [index, setIndex] = useState(() => Math.max(0, files.findIndex((f) => f.blockId === blockId)));
  const file = files[index];

  useEffect(() => {
    if (files.length === 0) closeFileViewer();
  }, [files.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFileViewer();
      } else if (e.key === 'ArrowRight') setIndex((i) => Math.min(files.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [files.length]);

  if (!file) return null;
  return (
    <div className="or-viewer" role="dialog" aria-modal="true" aria-label="Visionneuse de fichiers" onClick={(e) => e.target === e.currentTarget && closeFileViewer()}>
      <header className="or-viewer__bar">
        <span className="or-viewer__name">{file.name}</span>
        <span className="or-viewer__count">
          {index + 1} / {files.length}
        </span>
        {isViewableUrl(file.url, location.href) && (
          <>
            <a className="icon-btn" href={file.url} download={file.name} aria-label="Télécharger" title="Télécharger">
              <Download size={17} />
            </a>
            <a className="icon-btn" href={file.url} target="_blank" rel="noopener noreferrer" aria-label="Ouvrir dans un nouvel onglet" title="Ouvrir dans un nouvel onglet">
              <ExternalLink size={17} />
            </a>
          </>
        )}
        <button type="button" className="icon-btn" aria-label="Fermer la visionneuse" title="Fermer (Échap)" onClick={closeFileViewer}>
          <X size={18} />
        </button>
      </header>
      <button type="button" className="or-viewer__nav or-viewer__nav--prev" aria-label="Fichier précédent" disabled={index === 0} onClick={() => setIndex(index - 1)}>
        <ChevronLeft size={26} />
      </button>
      <div className="or-viewer__stage">
        <Stage file={file} />
        {file.caption && <p className="or-viewer__caption">{file.caption}</p>}
      </div>
      <button type="button" className="or-viewer__nav or-viewer__nav--next" aria-label="Fichier suivant" disabled={index === files.length - 1} onClick={() => setIndex(index + 1)}>
        <ChevronRight size={26} />
      </button>
    </div>
  );
}

function Stage({ file }: { file: PageFile }) {
  const ok = isViewableUrl(file.url, location.href);
  if (!ok) return <p className="or-viewer__fallback">Adresse non prise en charge.</p>;
  if (file.kind === 'image') return <img className="or-viewer__media" src={file.url} alt={file.caption || file.name} />;
  if (file.kind === 'video') return <video className="or-viewer__media" src={file.url} controls autoPlay={false} />;
  if (file.kind === 'audio') return <audio src={file.url} controls />;
  if (file.kind === 'pdf' && canFramePdf(file.url, file.name)) return <iframe className="or-viewer__frame" src={file.url} title={file.name} />;
  return (
    <div className="or-viewer__fallback">
      <FileText size={40} />
      <p>{file.name}</p>
      <a className="btn btn--secondary" href={file.url} target="_blank" rel="noopener noreferrer">
        Ouvrir le fichier
      </a>
    </div>
  );
}
