// Embeds (YouTube, Vimeo, Figma, Google…, generic iframe), bookmarks (link previews) and the PDF viewer.
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import {
  Bookmark,
  Clapperboard,
  Download,
  ExternalLink,
  FileText,
  Frame,
  Globe,
  MapPin,
  Music,
  Presentation,
  Table,
  Upload,
} from 'lucide-react';
import { EDITOR_BLOCK_TYPES, type EmbedProvider } from '@oriel/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/queryClient';
import { confirmDialog, toast } from '../lib/ui';
import { pickFile } from '../lib/util';
import { safeWebUrl } from '../lib/safeUrl';
import { propNumber, propString } from '../lib/props';
import { Spinner } from '../components/common';
import { useEditorEnv } from './env';
import { editorApi } from './editorApi';
import { PROVIDER_LABELS, detectProvider, embedSource, hostLabel } from './embeds';
import { canFramePdf, isAppOrigin } from './frameGuards';

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = { id: string; type: string; props: Record<string, any> };

const isHttps = (s: string) => /^https:\/\//i.test(s);

function providerIcon(provider: string, size = 15): ReactNode {
  switch (provider as EmbedProvider) {
    case 'youtube':
    case 'vimeo':
    case 'loom':
    case 'frameio':
      return <Clapperboard size={size} />;
    case 'figma':
      return <Frame size={size} />;
    case 'google-maps':
      return <MapPin size={size} />;
    case 'google-sheets':
      return <Table size={size} />;
    case 'google-slides':
      return <Presentation size={size} />;
    case 'google-docs':
    case 'google-drive':
      return <FileText size={size} />;
    case 'spotify':
      return <Music size={size} />;
    default:
      return <Globe size={size} />;
  }
}

/** Drag handle at the bottom of a block that resizes its height (stored in props.height). */
function ResizeHandle({ block, editor, frameRef, min = 120, max = 1600 }: { block: AnyBlock; editor: AnyEditor; frameRef: React.RefObject<HTMLElement | null>; min?: number; max?: number }) {
  const onPointerDown = (e: ReactPointerEvent) => {
    const frame = frameRef.current;
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = frame.getBoundingClientRect().height;
    let h = startH;
    document.body.classList.add('is-resizing-block');
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(max, Math.max(min, startH + ev.clientY - startY)));
      frame.style.height = `${h}px`;
      frame.style.aspectRatio = 'auto';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing-block');
      const current = editor.getBlock(block.id);
      if (current && h !== startH) editor.updateBlock(current, { props: { height: h } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="or-media__resize" onPointerDown={onPointerDown} role="separator" aria-label="Redimensionner" title="Glisser pour redimensionner" />;
}

/** URL input shown by empty embed / bookmark blocks. */
function UrlForm({
  placeholder,
  action,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  action: string;
  onSubmit: (url: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="or-media__form" onSubmit={(e) => void submit(e)}>
      <input
        className="input input--sm"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />
      <button type="submit" className="btn btn--primary btn--sm" disabled={!value.trim() || busy}>
        {busy ? <Spinner size={13} /> : action}
      </button>
    </form>
  );
}

/**
 * Empty embed / bookmark block: a compact placeholder row. The URL form only opens on click — an
 * always-open, auto-focused form would steal the focus and scroll the page to it on load.
 */
function EmptyMediaPlaceholder({
  icon,
  label,
  readOnlyLabel,
  canEdit,
  placeholder,
  action,
  onSubmit,
}: {
  icon: ReactNode;
  label: string;
  readOnlyLabel: string;
  canEdit: boolean;
  placeholder: string;
  action: string;
  onSubmit: (url: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!canEdit) {
    return (
      <div className="or-media-placeholder is-readonly" contentEditable={false}>
        {icon} <span>{readOnlyLabel}</span>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="or-media-placeholder" contentEditable={false} onClick={() => setOpen(true)}>
        {icon} <span>{label}</span>
      </button>
    );
  }
  return (
    <div className="or-media or-media--empty" contentEditable={false}>
      <UrlForm placeholder={placeholder} action={action} onSubmit={onSubmit} onCancel={() => setOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

/** Generic iframes the current user just confirmed (load immediately for them). */
const confirmedEmbeds = new Set<string>();

/** Sets an embed's URL after confirmation (generic iframes) — Frame.io and unknown links become bookmarks. */
export async function applyEmbedUrl(editor: AnyEditor, blockId: string, raw: string): Promise<boolean> {
  const info = detectProvider(raw);
  const block = editor.getBlock(blockId);
  if (!block) return false;
  if (!info) {
    toast.error('Lien invalide : collez une adresse https.');
    return false;
  }
  if (info.provider === 'frameio') {
    // Frame.io review links refuse to be framed: show a bookmark card instead.
    editor.updateBlock(block, { type: EDITOR_BLOCK_TYPES.bookmark, props: { url: raw } } as never);
    return true;
  }
  if (info.provider === 'generic' && isAppOrigin(raw)) {
    // QA-WEB-14: Oriel itself is never framed as a web page (it would run with the reader's
    // session); its uploaded PDFs go to the PDF viewer.
    if (!canFramePdf(raw, '')) {
      toast.error('Les adresses d’Oriel ne peuvent pas être intégrées : ajoutez plutôt un lien ou une mention de page.');
      return false;
    }
    editor.updateBlock(block, { type: EDITOR_BLOCK_TYPES.pdf, props: { url: raw, name: '' } } as never);
    return true;
  }
  if (info.provider === 'generic') {
    const ok = await confirmDialog({
      title: 'Intégrer cette page web ?',
      message: `Le contenu de ${hostLabel(raw)} sera affiché dans un cadre isolé. Chaque lecteur devra confirmer son affichage. N’intégrez que des sites de confiance.`,
      confirmLabel: 'Intégrer',
    });
    if (!ok) return false;
    confirmedEmbeds.add(blockId);
  }
  const current = editor.getBlock(blockId);
  if (!current) return false;
  editor.updateBlock(current, { props: { url: raw, provider: info.provider, height: info.defaultHeight } } as never);
  return true;
}

function EmbedView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const url = propString(block.props.url);
  const provider = propString(block.props.provider) || 'generic';
  // Same bounds as the resize handle (a stored height of 10⁹ px would otherwise blow up the page).
  const height = Math.min(1600, propNumber(block.props.height));
  const src = url ? embedSource(url, provider) : null;
  const [revealed, setRevealed] = useState(() => confirmedEmbeds.has(block.id));
  const [blocked, setBlocked] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  // Frames refused by the Content-Security-Policy (site not allowed by the server) → link card.
  useEffect(() => {
    setBlocked(false);
    if (!src) return;
    let origin: string;
    try {
      origin = new URL(src).origin;
    } catch {
      return;
    }
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (e.effectiveDirective.startsWith('frame-src') && e.blockedURI.startsWith(origin)) setBlocked(true);
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  }, [src]);

  if (!url) {
    return (
      <EmptyMediaPlaceholder
        icon={<Globe size={16} />}
        label="Intégrer un contenu"
        readOnlyLabel="Aucun contenu intégré"
        canEdit={env.canEdit}
        placeholder="Collez un lien YouTube, Vimeo, Loom, Figma, Google Docs, Spotify…"
        action="Intégrer"
        onSubmit={async (value) => void (await applyEmbedUrl(editor, block.id, value))}
      />
    );
  }

  const label = PROVIDER_LABELS[provider as EmbedProvider] ?? 'Page web';
  const href = safeWebUrl(url) ?? undefined;
  const header = (
    <div className="or-media__bar">
      <span className="or-media__provider">
        {providerIcon(provider)} {label}
      </span>
      <span className="or-media__host">{hostLabel(url)}</span>
      <a className="or-media__action" href={href} target="_blank" rel="noopener noreferrer" title="Ouvrir dans un nouvel onglet">
        <ExternalLink size={14} />
      </a>
    </div>
  );

  if (!src || blocked) {
    return (
      <div className="or-media" contentEditable={false}>
        {header}
        <div className="or-media__fallback">
          {blocked ? 'Ce site ne peut pas être affiché ici (non autorisé par le serveur).' : 'Ce lien ne peut pas être intégré.'}{' '}
          <a href={href} target="_blank" rel="noopener noreferrer">
            Ouvrir le lien
          </a>
        </div>
      </div>
    );
  }

  const frameStyle = height > 0 ? { height } : { aspectRatio: '16 / 9' };
  const needsConfirm = provider === 'generic' && !revealed;
  return (
    <div className={`or-media or-embed or-embed--${provider}`} contentEditable={false} data-provider={provider}>
      {header}
      <div className="or-media__frame" ref={frameRef} style={frameStyle}>
        {needsConfirm ? (
          <div className="or-embed__gate">
            <Globe size={22} />
            <div>
              Contenu externe de <strong>{hostLabel(url)}</strong>
            </div>
            <div className="or-media__muted">
              Ce site s’affichera dans un cadre : il ne pourra pas lire cette page, mais il exécutera ses scripts et verra votre adresse IP. N’affichez que des
              sites de confiance.
            </div>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setRevealed(true)}>
              Afficher le contenu
            </button>
          </div>
        ) : (
          <iframe
            src={src}
            title={`${label} — ${hostLabel(url)}`}
            loading="lazy"
            allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation"
          />
        )}
      </div>
      {env.canEdit && <ResizeHandle block={block} editor={editor} frameRef={frameRef} />}
    </div>
  );
}

export const EmbedBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.embed,
    propSchema: { url: { default: '' }, provider: { default: 'generic' }, height: { default: 0 } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <EmbedView block={block as AnyBlock} editor={editor as AnyEditor} />,
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.url}</a>
      </p>
    ),
  },
);

// ---------------------------------------------------------------------------
// Bookmark (link preview card)
// ---------------------------------------------------------------------------

/** Blocks whose preview was already requested in this tab (no refetch loops). */
const previewRequested = new Set<string>();

export async function fillBookmark(editor: AnyEditor, blockId: string, url: string): Promise<void> {
  previewRequested.add(blockId);
  try {
    const p = await editorApi.linkPreview(url);
    const current = editor.getBlock(blockId);
    if (!current || current.props.url !== url) return;
    editor.updateBlock(current, {
      props: { title: p.title, description: p.description, image: p.image, favicon: p.favicon },
    } as never);
  } catch (e) {
    const current = editor.getBlock(blockId);
    if (current && current.props.url === url && !current.props.title) {
      editor.updateBlock(current, { props: { title: hostLabel(url) } } as never);
    }
    console.info('[Oriel] aperçu de lien indisponible :', errorMessage(e));
  }
}

function BookmarkView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const url = propString(block.props.url);
  const title = propString(block.props.title);
  const description = propString(block.props.description);
  const image = propString(block.props.image);
  const favicon = propString(block.props.favicon);
  const [imageOk, setImageOk] = useState(true);
  const loading = !!url && !title && env.canEdit && env.mode === 'app';

  useEffect(() => {
    if (!url || title || !env.canEdit || env.mode !== 'app' || previewRequested.has(block.id)) return;
    void fillBookmark(editor, block.id, url);
  }, [url, title, env.canEdit, env.mode, editor, block.id]);

  if (!url) {
    return (
      <EmptyMediaPlaceholder
        icon={<Bookmark size={16} />}
        label="Ajouter un signet"
        readOnlyLabel="Signet vide"
        canEdit={env.canEdit}
        placeholder="Collez un lien pour créer un signet"
        action="Créer le signet"
        onSubmit={(value) => {
          const info = detectProvider(value);
          if (!info) {
            toast.error('Lien invalide : collez une adresse http ou https.');
            return;
          }
          const current = editor.getBlock(block.id);
          if (current) editor.updateBlock(current, { props: { url: value, title: '', description: '', image: '', favicon: '' } } as never);
        }}
      />
    );
  }

  // The URL is a prop of the shared document: only web addresses are opened.
  const href = safeWebUrl(url) ?? undefined;
  return (
    <a
      className="or-bookmark"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      contentEditable={false}
      draggable={false}
      onClick={(e) => {
        e.preventDefault();
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      <span className="or-bookmark__text">
        <span className="or-bookmark__title">{loading ? 'Chargement de l’aperçu…' : title || hostLabel(url)}</span>
        {description && <span className="or-bookmark__desc">{description}</span>}
        <span className="or-bookmark__url">
          {favicon && isHttps(favicon) ? (
            <img src={favicon} alt="" width={14} height={14} referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
          ) : (
            <Globe size={13} />
          )}
          <span>{url}</span>
        </span>
      </span>
      {image && isHttps(image) && imageOk && (
        <span className="or-bookmark__image">
          <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageOk(false)} />
        </span>
      )}
    </a>
  );
}

export const BookmarkBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.bookmark,
    propSchema: {
      url: { default: '' },
      title: { default: '' },
      description: { default: '' },
      image: { default: '' },
      favicon: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <BookmarkView block={block as AnyBlock} editor={editor as AnyEditor} />,
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.title || block.props.url}</a>
        {block.props.description ? ` — ${block.props.description}` : ''}
      </p>
    ),
  },
);

// ---------------------------------------------------------------------------
// PDF viewer
// ---------------------------------------------------------------------------

/** Only uploaded PDF files (same origin) are framed; anything else is offered as a link (QA-WEB-11). */
export function isFramablePdf(url: string, name = ''): boolean {
  return canFramePdf(url, name);
}

export const isPdfUrl = (url: string, name?: string) => /\.pdf($|[?#])/i.test(name || '') || /\.pdf($|[?#])/i.test(url || '');

function PdfView({ block, editor }: { block: AnyBlock; editor: AnyEditor }) {
  const env = useEditorEnv();
  const url = propString(block.props.url);
  const name = propString(block.props.name);
  const height = Math.min(2400, propNumber(block.props.height));
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  const upload = async () => {
    if (!env.workspaceId) return;
    const file = await pickFile('application/pdf,.pdf');
    if (!file) return;
    if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      toast.error('Choisissez un fichier PDF.');
      return;
    }
    setBusy(true);
    try {
      // A PDF picked without its extension keeps one: the viewer only frames files named *.pdf.
      const res = await api.workspaces.upload(env.workspaceId, file, /\.pdf$/i.test(file.name) ? file.name : `${file.name || 'document'}.pdf`);
      const current = editor.getBlock(block.id);
      if (current) editor.updateBlock(current, { props: { url: res.url, name: res.name } } as never);
    } catch (e) {
      toast.error(errorMessage(e, 'Envoi impossible.'));
    } finally {
      setBusy(false);
    }
  };

  if (!url) {
    return (
      <div className="or-media or-media--empty" contentEditable={false}>
        <div className="or-media__empty-title">
          <FileText size={16} /> PDF
        </div>
        {env.canEdit && env.mode === 'app' ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void upload()} disabled={busy}>
            {busy ? <Spinner size={13} /> : <Upload size={14} />} Choisir un PDF…
          </button>
        ) : (
          <div className="or-media__muted">Aucun PDF.</div>
        )}
      </div>
    );
  }

  const label = name || 'Document PDF';
  return (
    <div className="or-media or-pdf" contentEditable={false}>
      <div className="or-media__bar">
        <span className="or-media__provider">
          <FileText size={15} /> {label}
        </span>
        <span className="or-media__host" />
        <a className="or-media__action" href={url} target="_blank" rel="noopener noreferrer" title="Ouvrir dans un nouvel onglet">
          <ExternalLink size={14} />
        </a>
        <a className="or-media__action" href={url} download={label} title="Télécharger">
          <Download size={14} />
        </a>
      </div>
      {isFramablePdf(url, name) ? (
        <div className="or-media__frame" ref={frameRef} style={{ height: height > 0 ? height : 640 }}>
          <iframe src={url} title={label} loading="lazy" />
        </div>
      ) : (
        <div className="or-media__fallback">
          <a href={url} target="_blank" rel="noopener noreferrer">
            Ouvrir le PDF
          </a>
        </div>
      )}
      {env.canEdit && isFramablePdf(url, name) && <ResizeHandle block={block} editor={editor} frameRef={frameRef} min={240} max={2400} />}
    </div>
  );
}

export const PdfBlock = createReactBlockSpec(
  {
    type: EDITOR_BLOCK_TYPES.pdf,
    propSchema: { url: { default: '' }, name: { default: '' }, height: { default: 640 } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <PdfView block={block as AnyBlock} editor={editor as AnyEditor} />,
    toExternalHTML: ({ block }) => (
      <p>
        <a href={block.props.url}>{block.props.name || 'Document PDF'}</a>
      </p>
    ),
  },
);
