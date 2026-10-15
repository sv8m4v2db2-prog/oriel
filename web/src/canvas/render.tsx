// SVG renderers of canvas objects (H1). Each object is a <g data-cv-id> in canvas coordinates; the
// editor hit-tests through these attributes. Colors are CSS variables (theme-aware); text comes
// from the object as React text, never as markup.
import { memo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Lock, Paperclip } from 'lucide-react';
import { CANVAS_FONT_SIZES, type CanvasConnector, type CanvasMindmap, type CanvasObject } from '@oriel/shared';
import { api } from '../lib/api';
import { editorApi } from '../editor/editorApi';
import { pageTitle } from '../lib/util';
import { ink, noteFill, softFill } from './model';
import { capPath, dashArray, freehandPath, shapePath } from './paths';
import { mindLayoutOf, type Route } from './geometry';
import { MIND_FONT, type MindBox, type MindLayout } from './mindmap/layout';
import { NoteText } from './richText';

export interface RenderEnv {
  /** Public read-only visitor: page cards use the public API. */
  publicMode: boolean;
}

const fontPx = (s: keyof typeof CANVAS_FONT_SIZES) => CANVAS_FONT_SIZES[s];

function Html({ w, h, children, className }: { w: number; h: number; children: ReactNode; className?: string }) {
  return (
    <foreignObject x={0} y={0} width={Math.max(1, w)} height={Math.max(1, h)} className="or-cv-fo">
      <div className={className} style={{ width: w, height: h }}>
        {children}
      </div>
    </foreignObject>
  );
}

export const ShapeView = memo(function ShapeView({ o, editing }: { o: Extract<CanvasObject, { type: 'shape' }>; editing: boolean }) {
  const sw = o.strokeWidth;
  return (
    <>
      <path
        d={shapePath(o.shape, o.w, o.h)}
        fill={o.fill === 'none' ? 'transparent' : softFill(o.fill)}
        stroke={sw > 0 ? ink(o.stroke) : 'none'}
        strokeWidth={sw}
        strokeDasharray={dashArray(o.dash, sw)}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="or-cv-hit"
      />
      {!editing && o.text && (
        <Html w={o.w} h={o.h} className="or-cv-shape-text">
          <span style={{ color: ink(o.textColor), fontSize: fontPx(o.fontSize) }}>{o.text}</span>
        </Html>
      )}
    </>
  );
});

export const TextView = memo(function TextView({ o, editing }: { o: Extract<CanvasObject, { type: 'text' }>; editing: boolean }) {
  return (
    <>
      <rect width={o.w} height={o.h} fill="transparent" className="or-cv-hit" />
      {!editing && (
        <Html w={o.w} h={o.h} className="or-cv-text">
          <span style={{ color: ink(o.color), fontSize: fontPx(o.fontSize), fontWeight: o.bold ? 650 : 400, textAlign: o.align, display: 'block' }}>
            {o.text || <span className="or-cv-placeholder">Texte</span>}
          </span>
        </Html>
      )}
    </>
  );
});

export const NoteView = memo(function NoteView({ o, editing }: { o: Extract<CanvasObject, { type: 'note' }>; editing: boolean }) {
  return (
    <>
      <rect width={o.w} height={o.h} rx={4} fill={noteFill(o.fill)} className="or-cv-hit or-cv-note-paper" />
      {!editing && (
        <Html w={o.w} h={o.h} className="or-cv-note">
          <NoteText text={o.text} placeholder="Note" />
        </Html>
      )}
    </>
  );
});

export const StrokeView = memo(function StrokeView({ o }: { o: Extract<CanvasObject, { type: 'stroke' }> }) {
  const d = freehandPath(o.points, o.size, o.tool);
  return (
    <>
      <path d={d} fill={ink(o.color)} opacity={o.tool === 'highlighter' ? 0.38 : 1} className={o.tool === 'highlighter' ? 'or-cv-highlight' : undefined} />
      <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(10, o.size)} className="or-cv-hit-stroke" />
    </>
  );
});

export const ConnectorView = memo(
  function ConnectorView({ o, route, editing }: { o: CanvasConnector; route: Route; editing: boolean }) {
    const start = capPath(o.startCap, route.start, route.startAngle, o.strokeWidth);
    const end = capPath(o.endCap, route.end, route.endAngle, o.strokeWidth);
    const color = ink(o.color);
    return (
      <>
        <path d={route.d} fill="none" stroke="transparent" strokeWidth={Math.max(12, o.strokeWidth + 10)} className="or-cv-hit-stroke" />
        <path d={route.d} fill="none" stroke={color} strokeWidth={o.strokeWidth} strokeDasharray={dashArray(o.dash, o.strokeWidth)} strokeLinecap="round" strokeLinejoin="round" />
        {start && <path d={start.d} fill={start.filled ? color : 'none'} stroke={color} strokeWidth={o.strokeWidth} strokeLinejoin="round" strokeLinecap="round" />}
        {end && <path d={end.d} fill={end.filled ? color : 'none'} stroke={color} strokeWidth={o.strokeWidth} strokeLinejoin="round" strokeLinecap="round" />}
        {o.label && !editing && (
          <text x={route.mid.x} y={route.mid.y} className="or-cv-connector-label" textAnchor="middle" dominantBaseline="central" fill={color}>
            {o.label}
          </text>
        )}
      </>
    );
  },
  (a, b) => a.o === b.o && a.route.d === b.route.d && a.editing === b.editing,
);

export const ImageView = memo(function ImageView({ o }: { o: Extract<CanvasObject, { type: 'image' }> }) {
  return (
    <>
      <rect width={o.w} height={o.h} className="or-cv-image-bg or-cv-hit" />
      <image href={o.src} width={o.w} height={o.h} preserveAspectRatio="xMidYMid meet" />
    </>
  );
});

const formatSize = (size: number) =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(size / 1024))} Ko`;

export const FileView = memo(function FileView({ o }: { o: Extract<CanvasObject, { type: 'file' }> }) {
  return (
    <>
      <rect width={o.w} height={o.h} rx={8} className="or-cv-card or-cv-hit" />
      <Html w={o.w} h={o.h} className="or-cv-card-body">
        <Paperclip size={18} />
        <span className="or-cv-card-text">
          <span className="or-cv-card-title">{o.name || 'Fichier'}</span>
          <span className="or-cv-card-sub">{formatSize(o.size)} · double-clic pour ouvrir</span>
        </span>
      </Html>
    </>
  );
});

/** Title and icon of a linked page, through the reader's own access (404 = inaccessible). */
export function usePageMeta(pageId: string, publicMode: boolean) {
  return useQuery({
    queryKey: ['canvas-page-card', publicMode ? 'public' : 'member', pageId],
    queryFn: async () => {
      const page = publicMode ? (await api.public.page(pageId)).page : (await editorApi.pageInfo(pageId)).page;
      return { title: page.title, icon: page.icon, trashed: page.trashedAt !== null };
    },
    retry: false,
    staleTime: 30_000,
  });
}

export const PageCardView = memo(function PageCardView({ o, env }: { o: Extract<CanvasObject, { type: 'page' }>; env: RenderEnv }) {
  const meta = usePageMeta(o.pageId, env.publicMode);
  const inaccessible = meta.isError || meta.data?.trashed;
  return (
    <>
      <rect width={o.w} height={o.h} rx={8} className="or-cv-card or-cv-hit" />
      <Html w={o.w} h={o.h} className={`or-cv-card-body${inaccessible ? ' is-muted' : ''}`}>
        {inaccessible ? <Lock size={18} /> : meta.data?.icon ? <span className="or-cv-card-icon">{meta.data.icon}</span> : <FileText size={18} />}
        <span className="or-cv-card-text">
          <span className="or-cv-card-title">{meta.isLoading ? '…' : inaccessible ? 'Page inaccessible' : pageTitle(meta.data?.title)}</span>
          {!inaccessible && <span className="or-cv-card-sub">Page liée · double-clic pour ouvrir</span>}
        </span>
      </Html>
    </>
  );
});

export const FrameView = memo(function FrameView({ o, editing, zoom }: { o: Extract<CanvasObject, { type: 'frame' }>; editing: boolean; zoom: number }) {
  const label = 13 / zoom;
  return (
    <>
      <rect width={o.w} height={o.h} rx={6 / zoom} className="or-cv-frame" fill={o.fill === 'none' ? 'var(--or-cv-frame-bg)' : softFill(o.fill)} />
      <rect width={o.w} height={o.h} rx={6 / zoom} fill="none" stroke="transparent" strokeWidth={10 / zoom} className="or-cv-hit-stroke" />
      {!editing && (
        <text x={0} y={-6 / zoom} className="or-cv-frame-label" fontSize={label} data-cv-frame-label="">
          {o.name || 'Cadre'}
        </text>
      )}
    </>
  );
});

function mindLinkPath(layout: MindLayout, from: MindBox, to: MindBox, style: CanvasMindmap['style']): string {
  const side = to.side === -1 ? -1 : 1;
  const sx = side === 1 ? from.x + from.w : from.x;
  const sy = from.y + from.h / 2;
  const ex = side === 1 ? to.x : to.x + to.w;
  const ey = style === 'minimal' ? to.y + to.h : to.y + to.h / 2;
  void layout;
  if (style === 'outline') return `M ${sx} ${sy} L ${ex} ${ey}`;
  if (style === 'org') {
    const mx = sx + (ex - sx) / 2;
    return `M ${sx} ${sy} H ${mx} V ${ey} H ${ex}`;
  }
  const k = (ex - sx) / 2;
  return `M ${sx} ${sy} C ${sx + k} ${sy}, ${ex - k} ${ey}, ${ex} ${ey}`;
}

export const MindmapView = memo(function MindmapView({
  o,
  selectedNode,
  editingNode,
}: {
  o: CanvasMindmap;
  selectedNode: string | null;
  editingNode: string | null;
}) {
  const layout = mindLayoutOf(o);
  return (
    <>
      {layout.links.map((l) => {
        const from = layout.byId.get(l.from)!;
        const to = layout.byId.get(l.to)!;
        return (
          <path
            key={`${l.from}-${l.to}`}
            d={mindLinkPath(layout, from, to, o.style)}
            fill="none"
            stroke={o.style === 'minimal' ? 'var(--border-strong)' : ink(l.color)}
            strokeWidth={from.depth === 0 ? 2.5 : 1.75}
            strokeLinecap="round"
          />
        );
      })}
      {layout.boxes.map((b) => (
        <MindNodeView key={b.id} box={b} style={o.style} selected={b.id === selectedNode} editing={b.id === editingNode} />
      ))}
    </>
  );
});

function MindNodeView({ box, style, selected, editing }: { box: MindBox; style: CanvasMindmap['style']; selected: boolean; editing: boolean }) {
  const root = box.depth === 0;
  const fill =
    style === 'minimal' ? 'transparent' : style === 'outline' ? 'var(--bg)' : root ? `var(--or-cv-solid-${box.color === 'default' ? 'blue' : box.color})` : softFill(box.color);
  const stroke = style === 'outline' || root ? ink(box.color === 'default' && !root ? 'gray' : box.color) : 'none';
  return (
    <g transform={`translate(${box.x} ${box.y})`} data-cv-node={box.id}>
      <rect width={box.w} height={box.h} rx={style === 'org' ? 3 : root ? box.h / 2 : 8} fill={fill} stroke={stroke} strokeWidth={style === 'outline' ? 1.5 : root ? 0 : 0} className="or-cv-hit" />
      {style === 'minimal' && <line x1={0} x2={box.w} y1={box.h} y2={box.h} stroke={ink(box.color)} strokeWidth={2} />}
      {selected && <rect x={-3} y={-3} width={box.w + 6} height={box.h + 6} rx={10} fill="none" className="or-cv-node-selected" />}
      {!editing && (
        <Html w={box.w} h={box.h} className={`or-cv-mind-text${root ? ' is-root' : ''}${root && style !== 'outline' && style !== 'minimal' ? ' on-solid' : ''}`}>
          <span style={{ fontSize: MIND_FONT(box.depth) }}>{box.text || <span className="or-cv-placeholder">Idée</span>}</span>
        </Html>
      )}
      {box.hidden > 0 && (
        <g transform={`translate(${box.side === -1 ? -10 : box.w + 10} ${box.h / 2})`} data-cv-toggle={box.id}>
          <circle r={9} className="or-cv-mind-badge" />
          <text textAnchor="middle" dominantBaseline="central" className="or-cv-mind-badge-text">
            {box.hidden > 99 ? '99+' : box.hidden}
          </text>
        </g>
      )}
    </g>
  );
}

/** One object at its position (connectors and mind maps carry their own coordinates). */
export function ObjectBody({
  o,
  route,
  env,
  editing,
  zoom,
  mind,
}: {
  o: CanvasObject;
  route?: Route;
  env: RenderEnv;
  editing: boolean;
  zoom: number;
  mind?: { selectedNode: string | null; editingNode: string | null };
}) {
  switch (o.type) {
    case 'shape':
      return <ShapeView o={o} editing={editing} />;
    case 'text':
      return <TextView o={o} editing={editing} />;
    case 'note':
      return <NoteView o={o} editing={editing} />;
    case 'stroke':
      return <StrokeView o={o} />;
    case 'connector':
      return route ? <ConnectorView o={o} route={route} editing={editing} /> : null;
    case 'image':
      return <ImageView o={o} />;
    case 'file':
      return <FileView o={o} />;
    case 'page':
      return <PageCardView o={o} env={env} />;
    case 'frame':
      return <FrameView o={o} editing={editing} zoom={zoom} />;
    case 'mindmap':
      return <MindmapView o={o} selectedNode={mind?.selectedNode ?? null} editingNode={mind?.editingNode ?? null} />;
  }
}

/** Translation of an object's own coordinate system (none for connectors). */
export const objectTransform = (o: CanvasObject) => (o.type === 'connector' ? undefined : `translate(${o.x} ${o.y})`);
