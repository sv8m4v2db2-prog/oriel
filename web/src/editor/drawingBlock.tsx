// Drawing block (E14): freehand sketch, hand-made (pointer events + SVG), no drawing library.
// Strokes are kept in the block prop `strokes` (bounded JSON, see drawingLogic.ts). The stroke in
// progress stays local; it is written to the shared document when the pen is lifted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockNoteEditor } from '@blocknote/core';
import { Eraser, PenLine, Redo2, Trash2, Undo2 } from 'lucide-react';
import { DRAWING_HEIGHT, DRAWING_WIDTH, EDITOR_BLOCK_TYPES } from '@oriel/shared';
import { useEditorEnv } from './env';
import { withSafeProps } from './safeProps';
import {
  DRAWING_COLORS,
  DRAWING_WIDTHS,
  drawingSvg,
  parseStrokes,
  serializeStrokes,
  simplifyPoints,
  strokeAt,
  strokePath,
  type Stroke,
} from './drawingLogic';
import './advancedBlocks.css';

type AnyEditor = BlockNoteEditor<any, any, any>;

function DrawingView({ block, editor }: { block: { id: string; props: Record<string, unknown> }; editor: AnyEditor }) {
  const env = useEditorEnv();
  const stored = useMemo(() => parseStrokes(block.props.strokes), [block.props.strokes]);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState<string>(DRAWING_COLORS[0]);
  const [width, setWidth] = useState<number>(DRAWING_WIDTHS[1]);
  const [live, setLive] = useState<Stroke | null>(null);
  const undo = useRef<Stroke[][]>([]);
  const redo = useRef<Stroke[][]>([]);
  const [, bump] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointer = useRef<{ id: number; points: number[] } | null>(null);
  const strokesRef = useRef(stored);
  strokesRef.current = stored;
  const editable = env.canEdit && env.mode === 'app';

  useEffect(() => {
    undo.current = [];
    redo.current = [];
  }, [block.id]);

  const commit = (next: Stroke[], record = true) => {
    if (record) {
      undo.current.push(strokesRef.current);
      if (undo.current.length > 50) undo.current.shift();
      redo.current = [];
    }
    strokesRef.current = next;
    try {
      editor.updateBlock(block.id, { props: { strokes: serializeStrokes(next) } } as never);
    } catch {
      /* block removed meanwhile */
    }
    bump((n) => n + 1);
  };

  const toLocal = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * DRAWING_WIDTH, ((e.clientY - r.top) / r.height) * DRAWING_HEIGHT];
  };
  const eraseAt = (e: React.PointerEvent) => {
    const [x, y] = toLocal(e);
    const i = strokeAt(strokesRef.current, x, y, 10);
    if (i >= 0) commit(strokesRef.current.filter((_, k) => k !== i));
  };

  const onDown = (e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (tool === 'eraser') {
      pointer.current = { id: e.pointerId, points: [] };
      eraseAt(e);
      return;
    }
    const [x, y] = toLocal(e);
    pointer.current = { id: e.pointerId, points: [x, y] };
    setLive({ c: color, w: width, p: [x, y] });
  };
  const onMove = (e: React.PointerEvent) => {
    const cur = pointer.current;
    if (!cur || cur.id !== e.pointerId) return;
    if (tool === 'eraser') return eraseAt(e);
    const [x, y] = toLocal(e);
    cur.points.push(x, y);
    setLive({ c: color, w: width, p: [...cur.points] });
  };
  const onUp = (e: React.PointerEvent) => {
    const cur = pointer.current;
    if (!cur || cur.id !== e.pointerId) return;
    pointer.current = null;
    if (tool === 'pen' && cur.points.length >= 2) {
      const points = simplifyPoints(cur.points).map((n) => Math.round(n));
      commit([...strokesRef.current, { c: color, w: width, p: points }]);
    }
    setLive(null);
  };

  const shown = live ? [...stored, live] : stored;
  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev) return;
    redo.current.push(strokesRef.current);
    commit(prev, false);
  };
  const doRedo = () => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(strokesRef.current);
    commit(next, false);
  };

  return (
    <div className="or-drawing" contentEditable={false}>
      {editable && (
        <div className="or-drawing__bar" role="toolbar" aria-label="Outils de dessin">
          <button type="button" className={`or-media__action${tool === 'pen' ? ' is-active' : ''}`} title="Stylo" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>
            <PenLine size={14} />
          </button>
          <button type="button" className={`or-media__action${tool === 'eraser' ? ' is-active' : ''}`} title="Gomme (efface le tracé touché)" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>
            <Eraser size={14} />
          </button>
          {DRAWING_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`or-drawing__swatch${c === color ? ' is-active' : ''}`}
              style={{ background: c }}
              title={`Couleur ${c}`}
              aria-label={`Couleur ${c}`}
              aria-pressed={c === color}
              onClick={() => {
                setColor(c);
                setTool('pen');
              }}
            />
          ))}
          {DRAWING_WIDTHS.map((w) => (
            <button key={w} type="button" className={`or-media__action${w === width ? ' is-active' : ''}`} title={`Épaisseur ${w}`} aria-label={`Épaisseur ${w}`} aria-pressed={w === width} onClick={() => setWidth(w)}>
              <span className="or-drawing__dot" style={{ width: 4 + w, height: 4 + w }} />
            </button>
          ))}
          <button type="button" className="or-media__action" title="Annuler" disabled={undo.current.length === 0} onClick={doUndo}>
            <Undo2 size={14} />
          </button>
          <button type="button" className="or-media__action" title="Rétablir" disabled={redo.current.length === 0} onClick={doRedo}>
            <Redo2 size={14} />
          </button>
          <button type="button" className="or-media__action" title="Tout effacer" disabled={stored.length === 0} onClick={() => commit([])}>
            <Trash2 size={14} />
          </button>
        </div>
      )}
      <svg
        ref={svgRef}
        className="or-drawing__canvas"
        viewBox={`0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}`}
        role="img"
        aria-label="Dessin"
        style={{ touchAction: editable ? 'none' : undefined, cursor: editable ? (tool === 'eraser' ? 'cell' : 'crosshair') : 'default' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {shown.map((s, i) => (
          <path key={i} d={strokePath(s)} fill="none" stroke={s.c} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
    </div>
  );
}

export const DrawingBlock = () =>
  withSafeProps(
    createReactBlockSpec(
      { type: EDITOR_BLOCK_TYPES.drawing, propSchema: { strokes: { default: '[]' } }, content: 'none' },
      {
        render: ({ block, editor }) => <DrawingView block={block as never} editor={editor as AnyEditor} />,
        // Copies and exports: the drawing as an image.
        toExternalHTML: ({ block }) => {
          const src = `data:image/svg+xml;base64,${btoa(drawingSvg(block.props.strokes, '#ffffff'))}`;
          return <img src={src} alt="Dessin" />;
        },
      },
    )(),
  );
