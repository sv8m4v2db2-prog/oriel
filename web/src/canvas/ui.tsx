// Chrome of the canvas editor (H1): tool bar, selection inspector, zoom controls, main menu
// (export, frames, presentation) and starter templates.
import { useState, type ReactNode } from 'react';
import { Menu, Popover, Tooltip } from '@mantine/core';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Circle,
  Copy,
  Diamond,
  Download,
  Eraser,
  FileText,
  Frame,
  Group,
  Hand,
  Hexagon,
  Highlighter,
  ImagePlus,
  ListTree,
  Lock,
  Maximize,
  Minus,
  MousePointer2,
  Network,
  Paperclip,
  PenLine,
  Play,
  Plus,
  Redo2,
  Spline,
  Square,
  SquareDashed,
  StickyNote,
  Trash2,
  Triangle,
  Type,
  Undo2,
  Ungroup,
  Unlock,
  MoreHorizontal,
  RectangleHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
} from 'lucide-react';
import type { CanvasCap, CanvasColor, CanvasFill, CanvasObject, CanvasShapeKind, MindmapLayout, MindmapStyle } from '@oriel/shared';
import { toast } from '../lib/ui';
import { modKey } from '../lib/util';
import { COLOR_NAMES, PALETTE, ink, softFill, type Rect } from './model';
import type { AlignMode } from './geometry';
import type { CanvasStore } from './store';
import type { Camera, Style } from './CanvasEditor';
import { CANVAS_TEMPLATES } from './templates';
import { buildSvg, download, svgToPng } from './export';
import { FramesPanel, Presentation } from './frames';
import { framesInOrder } from './viewer';

export type Tool = 'select' | 'hand' | 'shape' | 'text' | 'note' | 'connector' | 'pen' | 'highlighter' | 'eraser' | 'frame' | 'mindmap';

export interface Actions {
  patch: (fn: (o: CanvasObject) => CanvasObject) => void;
  remove: () => void;
  duplicate: () => void;
  group: () => void;
  ungroup: () => void;
  lock: (locked: boolean) => void;
  front: () => void;
  back: () => void;
  align: (mode: AlignMode) => void;
  distribute: (axis: 'x' | 'y') => void;
  copyOutline: () => void;
  edit: () => void;
}

function Btn({ label, active, onClick, children, disabled, shortcut }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean; shortcut?: string }) {
  return (
    <Tooltip label={shortcut ? `${label} (${shortcut})` : label} openDelay={350} withinPortal>
      <button type="button" className={`or-cv-btn${active ? ' is-active' : ''}`} aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    </Tooltip>
  );
}

const SHAPES: Array<{ kind: CanvasShapeKind; label: string; icon: ReactNode }> = [
  { kind: 'rounded', label: 'Rectangle arrondi', icon: <RectangleHorizontal size={17} /> },
  { kind: 'rect', label: 'Rectangle', icon: <Square size={17} /> },
  { kind: 'ellipse', label: 'Ellipse', icon: <Circle size={17} /> },
  { kind: 'diamond', label: 'Losange', icon: <Diamond size={17} /> },
  { kind: 'triangle', label: 'Triangle', icon: <Triangle size={17} /> },
  { kind: 'hexagon', label: 'Hexagone', icon: <Hexagon size={17} /> },
];

function Swatches({ value, onChange, allowNone, kind }: { value: CanvasFill; onChange: (c: CanvasFill) => void; allowNone?: boolean; kind: 'ink' | 'fill' }) {
  return (
    <div className="or-cv-swatches" role="radiogroup">
      {allowNone && (
        <button type="button" role="radio" aria-checked={value === 'none'} aria-label="Aucun" className={`or-cv-swatch is-none${value === 'none' ? ' is-active' : ''}`} onClick={() => onChange('none')} />
      )}
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          className={`or-cv-swatch${value === c ? ' is-active' : ''}`}
          style={{ background: kind === 'ink' ? ink(c) : softFill(c), borderColor: ink(c) }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; icon?: ReactNode }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="or-cv-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <Tooltip key={String(o.value)} label={o.label} openDelay={350} withinPortal>
          <button type="button" role="radio" aria-checked={value === o.value} aria-label={o.label} className={`or-cv-seg-btn${value === o.value ? ' is-active' : ''}`} onClick={() => onChange(o.value)}>
            {o.icon ?? o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function ColorPop({ label, value, onChange, allowNone, kind }: { label: string; value: CanvasFill; onChange: (c: CanvasFill) => void; allowNone?: boolean; kind: 'ink' | 'fill' }) {
  return (
    <Popover position="bottom" withinPortal shadow="md">
      <Popover.Target>
        <button type="button" className="or-cv-btn" aria-label={label} title={label}>
          <span className={`or-cv-chip${value === 'none' ? ' is-none' : ''}`} style={value === 'none' ? undefined : { background: kind === 'ink' ? ink(value) : softFill(value), borderColor: ink(value) }} />
        </button>
      </Popover.Target>
      <Popover.Dropdown>
        <div className="or-cv-pop-title">{label}</div>
        <Swatches value={value} onChange={onChange} allowNone={allowNone} kind={kind} />
      </Popover.Dropdown>
    </Popover>
  );
}

const CAPS: Array<{ value: CanvasCap; label: string }> = [
  { value: 'none', label: 'Aucune' },
  { value: 'arrow', label: 'Flèche' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'dot', label: 'Point' },
  { value: 'diamond', label: 'Losange' },
];

function Inspector({ selected, actions, mindNode }: { selected: CanvasObject[]; actions: Actions; mindNode: { map: string; node: string } | null }) {
  const first = selected[0]!;
  const all = <T extends CanvasObject['type']>(t: T) => selected.every((o) => o.type === t);
  const locked = selected.every((o) => o.locked);
  const set = (patch: Record<string, unknown>, only?: CanvasObject['type'][]) =>
    actions.patch((o) => (!only || only.includes(o.type) ? ({ ...o, ...patch } as CanvasObject) : o));
  const shapes = selected.filter((o) => o.type === 'shape');
  const s0 = shapes[0];
  const grouped = selected.some((o) => o.groupId);
  return (
    <div className="or-cv-inspector" role="toolbar" aria-label="Mise en forme de la sélection">
      {!locked && s0 && (
        <>
          <Menu withinPortal position="bottom">
            <Menu.Target>
              <button type="button" className="or-cv-btn" aria-label="Forme" title="Forme">
                {SHAPES.find((x) => x.kind === s0.shape)?.icon}
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              {SHAPES.map((x) => (
                <Menu.Item key={x.kind} leftSection={x.icon} onClick={() => set({ shape: x.kind }, ['shape'])}>
                  {x.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <ColorPop label="Remplissage" value={s0.fill} allowNone kind="fill" onChange={(c) => set({ fill: c }, ['shape'])} />
          <ColorPop label="Contour" value={s0.stroke} kind="ink" onChange={(c) => set({ stroke: c }, ['shape'])} />
          <Segmented label="Épaisseur" value={s0.strokeWidth} onChange={(v) => set({ strokeWidth: v }, ['shape'])} options={[0, 1, 2, 4, 8].map((v) => ({ value: v, label: v === 0 ? 'Sans' : `${v}` }))} />
          <ColorPop label="Couleur du texte" value={s0.textColor} kind="ink" onChange={(c) => set({ textColor: c }, ['shape'])} />
        </>
      )}
      {!locked && all('connector') && first.type === 'connector' && (
        <>
          <Segmented
            label="Tracé"
            value={first.route}
            onChange={(v) => set({ route: v })}
            options={[
              { value: 'straight', label: 'Droit' },
              { value: 'elbow', label: 'Coudé' },
              { value: 'curve', label: 'Courbe' },
            ]}
          />
          <Menu withinPortal>
            <Menu.Target>
              <button type="button" className="or-cv-btn or-cv-btn--text">Extrémités</button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Début</Menu.Label>
              {CAPS.map((c) => (
                <Menu.Item key={`s${c.value}`} onClick={() => set({ startCap: c.value })}>
                  {first.startCap === c.value ? '✓ ' : ''}
                  {c.label}
                </Menu.Item>
              ))}
              <Menu.Label>Fin</Menu.Label>
              {CAPS.map((c) => (
                <Menu.Item key={`e${c.value}`} onClick={() => set({ endCap: c.value })}>
                  {first.endCap === c.value ? '✓ ' : ''}
                  {c.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <ColorPop label="Couleur" value={first.color} kind="ink" onChange={(c) => set({ color: c })} />
          <Segmented label="Épaisseur" value={first.strokeWidth} onChange={(v) => set({ strokeWidth: v })} options={[1, 2, 4, 8].map((v) => ({ value: v, label: `${v}` }))} />
          <Segmented
            label="Trait"
            value={first.dash}
            onChange={(v) => set({ dash: v })}
            options={[
              { value: 'solid', label: 'Plein' },
              { value: 'dashed', label: 'Tirets' },
              { value: 'dotted', label: 'Points' },
            ]}
          />
          <button type="button" className="or-cv-btn or-cv-btn--text" onClick={actions.edit}>
            Étiquette
          </button>
        </>
      )}
      {!locked && all('text') && first.type === 'text' && (
        <>
          <ColorPop label="Couleur" value={first.color} kind="ink" onChange={(c) => set({ color: c })} />
          <Btn label="Gras" active={!!first.bold} onClick={() => set({ bold: !first.bold || undefined })}>
            <Bold size={16} />
          </Btn>
          <Segmented
            label="Alignement"
            value={first.align}
            onChange={(v) => set({ align: v })}
            options={[
              { value: 'left', label: 'Gauche' },
              { value: 'center', label: 'Centre' },
              { value: 'right', label: 'Droite' },
            ]}
          />
        </>
      )}
      {!locked && selected.some((o) => o.type === 'text' || o.type === 'shape') && (
        <Segmented
          label="Taille du texte"
          value={(selected.find((o) => o.type === 'text' || o.type === 'shape') as { fontSize: 's' }).fontSize}
          onChange={(v) => set({ fontSize: v }, ['text', 'shape'])}
          options={[
            { value: 's', label: 'P' },
            { value: 'm', label: 'M' },
            { value: 'l', label: 'G' },
            { value: 'xl', label: 'TG' },
          ]}
        />
      )}
      {!locked && all('note') && first.type === 'note' && <ColorPop label="Couleur de la note" value={first.fill} kind="fill" onChange={(c) => set({ fill: c })} />}
      {!locked && all('stroke') && first.type === 'stroke' && <ColorPop label="Couleur du tracé" value={first.color} kind="ink" onChange={(c) => set({ color: c })} />}
      {!locked && all('frame') && first.type === 'frame' && (
        <>
          <ColorPop label="Fond du cadre" value={first.fill} allowNone kind="fill" onChange={(c) => set({ fill: c })} />
          <button type="button" className="or-cv-btn or-cv-btn--text" onClick={actions.edit}>
            Renommer
          </button>
        </>
      )}
      {!locked && all('mindmap') && first.type === 'mindmap' && selected.length === 1 && (
        <>
          <Segmented<MindmapLayout>
            label="Disposition"
            value={first.layout}
            onChange={(v) => set({ layout: v })}
            options={[
              { value: 'right', label: 'Droite' },
              { value: 'left', label: 'Gauche' },
              { value: 'balanced', label: 'Équilibrée' },
            ]}
          />
          <Segmented<MindmapStyle>
            label="Style"
            value={first.style}
            onChange={(v) => set({ style: v })}
            options={[
              { value: 'classic', label: 'Classique' },
              { value: 'outline', label: 'Contour' },
              { value: 'org', label: 'Organigramme' },
              { value: 'minimal', label: 'Minimal' },
            ]}
          />
          {mindNode?.map === first.id && (
            <Tooltip label="Tab : enfant · Entrée : frère · Suppr : retirer · Espace : replier" withinPortal>
              <span className="or-cv-hint">Nœud sélectionné</span>
            </Tooltip>
          )}
          <Btn label="Copier en liste" onClick={actions.copyOutline}>
            <ListTree size={16} />
          </Btn>
        </>
      )}
      <span className="or-cv-sep" />
      {!locked && selected.length >= 2 && (
        <Menu withinPortal>
          <Menu.Target>
            <button type="button" className="or-cv-btn" aria-label="Aligner" title="Aligner et répartir">
              <AlignStartVertical size={16} />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<AlignStartVertical size={15} />} onClick={() => actions.align('left')}>
              Aligner à gauche
            </Menu.Item>
            <Menu.Item leftSection={<AlignCenterVertical size={15} />} onClick={() => actions.align('hcenter')}>
              Centrer horizontalement
            </Menu.Item>
            <Menu.Item leftSection={<AlignEndVertical size={15} />} onClick={() => actions.align('right')}>
              Aligner à droite
            </Menu.Item>
            <Menu.Item leftSection={<AlignStartHorizontal size={15} />} onClick={() => actions.align('top')}>
              Aligner en haut
            </Menu.Item>
            <Menu.Item leftSection={<AlignCenterHorizontal size={15} />} onClick={() => actions.align('vmiddle')}>
              Centrer verticalement
            </Menu.Item>
            <Menu.Item leftSection={<AlignEndHorizontal size={15} />} onClick={() => actions.align('bottom')}>
              Aligner en bas
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<AlignHorizontalSpaceAround size={15} />} disabled={selected.length < 3} onClick={() => actions.distribute('x')}>
              Répartir horizontalement
            </Menu.Item>
            <Menu.Item leftSection={<AlignVerticalSpaceAround size={15} />} disabled={selected.length < 3} onClick={() => actions.distribute('y')}>
              Répartir verticalement
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
      {!locked && selected.length >= 2 && !grouped && (
        <Btn label="Grouper" shortcut={`${modKey()}G`} onClick={actions.group}>
          <Group size={16} />
        </Btn>
      )}
      {!locked && grouped && (
        <Btn label="Dégrouper" shortcut={`${modKey()}⇧G`} onClick={actions.ungroup}>
          <Ungroup size={16} />
        </Btn>
      )}
      {!locked && (
        <>
          <Btn label="Premier plan" shortcut={`${modKey()}]`} onClick={actions.front}>
            <ArrowUpToLine size={16} />
          </Btn>
          <Btn label="Arrière-plan" shortcut={`${modKey()}[`} onClick={actions.back}>
            <ArrowDownToLine size={16} />
          </Btn>
          <Btn label="Dupliquer" shortcut={`${modKey()}D`} onClick={actions.duplicate}>
            <Copy size={16} />
          </Btn>
        </>
      )}
      <Btn label={locked ? 'Déverrouiller' : 'Verrouiller'} shortcut={`${modKey()}⇧L`} active={locked} onClick={() => actions.lock(!locked)}>
        {locked ? <Unlock size={16} /> : <Lock size={16} />}
      </Btn>
      {!locked && (
        <Btn label="Supprimer" shortcut="Suppr" onClick={actions.remove}>
          <Trash2 size={16} />
        </Btn>
      )}
    </div>
  );
}

export function CanvasChrome(props: {
  store: CanvasStore;
  objects: ReadonlyMap<string, CanvasObject>;
  selected: CanvasObject[];
  mindNode: { map: string; node: string } | null;
  tool: Tool;
  setTool: (t: Tool) => void;
  style: Style;
  setStyle: (fn: (s: Style) => Style) => void;
  readOnly: boolean;
  publicMode: boolean;
  camera: Camera;
  canUndo: boolean;
  canRedo: boolean;
  actions: Actions;
  mindCommand: (cmd: 'child' | 'sibling' | 'remove' | 'toggle') => boolean;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  fitAll: () => void;
  fitRect: (r: Rect | null, maxZoom?: number) => void;
  insertTemplate: (list: CanvasObject[]) => void;
  linkPage: () => void;
  addImage: () => void;
  addFile: () => void;
  canUpload: boolean;
  presenting: string | null;
  setPresenting: (frameId: string | null) => void;
  pageId: string;
  select: (ids: Iterable<string>) => void;
  boundsOf: (o: CanvasObject) => Rect;
}) {
  const { tool, setTool, style, setStyle, readOnly, objects, selected, actions } = props;
  const [framesOpen, setFramesOpen] = useState(false);
  const frames = framesInOrder(objects);
  const shapeIcon = SHAPES.find((s) => s.kind === style.shape)?.icon ?? <Square size={17} />;

  const exportAs = async (format: 'png' | 'svg', scope: 'all' | 'selection' | string) => {
    const list = [...objects.values()];
    let region: Rect | null = null;
    if (scope === 'selection') {
      const b = selected.map(props.boundsOf);
      if (b.length === 0) return;
      const minX = Math.min(...b.map((r) => r.x));
      const minY = Math.min(...b.map((r) => r.y));
      region = { x: minX, y: minY, w: Math.max(...b.map((r) => r.x + r.w)) - minX, h: Math.max(...b.map((r) => r.y + r.h)) - minY };
    } else if (scope !== 'all') {
      const f = objects.get(scope);
      if (f?.type === 'frame') region = { x: f.x, y: f.y, w: f.w, h: f.h };
    }
    const scoped = scope === 'selection' ? selected : list;
    try {
      const built = await buildSvg({ objects: scoped, get: (id) => objects.get(id), region });
      if (!built) return void toast.error('Rien à exporter.');
      const name = scope === 'all' ? 'canevas' : scope === 'selection' ? 'selection' : (objects.get(scope) as { name?: string } | undefined)?.name || 'cadre';
      const safe = name.replace(/[^\p{L}\p{N}_ -]+/gu, '').trim().slice(0, 80) || 'canevas';
      if (format === 'svg') download(new Blob([built.svg], { type: 'image/svg+xml' }), `${safe}.svg`);
      else {
        const png = await svgToPng(built.svg, built.width, built.height);
        if (!png) return void toast.error('Export PNG impossible.');
        download(png, `${safe}.png`);
      }
    } catch {
      toast.error('Export impossible.');
    }
  };

  const empty = objects.size === 0;
  const zoomPct = Math.round(props.camera.zoom * 100);

  return (
    <>
      <div className="or-cv-topleft">
        <Menu withinPortal position="bottom-start" width={240}>
          <Menu.Target>
            <button type="button" className="or-cv-btn" aria-label="Menu du canevas" title="Menu du canevas">
              <MoreHorizontal size={17} />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Exporter</Menu.Label>
            <Menu.Item leftSection={<Download size={15} />} onClick={() => void exportAs('png', 'all')} disabled={empty}>
              Tout le canevas en PNG
            </Menu.Item>
            <Menu.Item leftSection={<Download size={15} />} onClick={() => void exportAs('svg', 'all')} disabled={empty}>
              Tout le canevas en SVG
            </Menu.Item>
            <Menu.Item leftSection={<Download size={15} />} onClick={() => void exportAs('png', 'selection')} disabled={selected.length === 0}>
              La sélection en PNG
            </Menu.Item>
            <Menu.Item leftSection={<Download size={15} />} onClick={() => void exportAs('svg', 'selection')} disabled={selected.length === 0}>
              La sélection en SVG
            </Menu.Item>
            {frames.length > 0 && <Menu.Label>Cadres</Menu.Label>}
            {frames.slice(0, 12).map((f) => (
              <Menu.Item key={f.id} leftSection={<Frame size={15} />} onClick={() => void exportAs('png', f.id)} rightSection={<span className="or-cv-menu-hint">PNG</span>}>
                {f.name || 'Cadre'}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item leftSection={<Maximize size={15} />} onClick={props.fitAll}>
              Tout afficher (⇧1)
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        {!readOnly && (
          <>
            <Btn label="Annuler" shortcut={`${modKey()}Z`} onClick={() => props.store.undo.undo()} disabled={!props.canUndo}>
              <Undo2 size={16} />
            </Btn>
            <Btn label="Rétablir" shortcut={`${modKey()}⇧Z`} onClick={() => props.store.undo.redo()} disabled={!props.canRedo}>
              <Redo2 size={16} />
            </Btn>
          </>
        )}
      </div>

      <div className="or-cv-topright">
        <button type="button" className={`or-cv-btn or-cv-btn--text${framesOpen ? ' is-active' : ''}`} onClick={() => setFramesOpen((v) => !v)} aria-pressed={framesOpen}>
          <Frame size={15} /> Cadres{frames.length > 0 ? ` (${frames.length})` : ''}
        </button>
        <button type="button" className="or-cv-btn or-cv-btn--text or-cv-btn--accent" onClick={() => props.setPresenting(frames[0]?.id ?? '')} disabled={frames.length === 0} title={frames.length === 0 ? 'Ajoutez un cadre pour présenter' : 'Présenter les cadres'}>
          <Play size={15} /> Présenter
        </button>
      </div>

      {selected.length > 0 && !props.presenting && <Inspector selected={selected} actions={actions} mindNode={props.mindNode} />}

      {!readOnly && (
        <div className="or-cv-toolbar" role="toolbar" aria-label="Outils du canevas">
          <Btn label="Sélection" shortcut="V" active={tool === 'select'} onClick={() => setTool('select')}>
            <MousePointer2 size={17} />
          </Btn>
          <Btn label="Main" shortcut="H" active={tool === 'hand'} onClick={() => setTool('hand')}>
            <Hand size={17} />
          </Btn>
          <span className="or-cv-sep" />
          <div className="or-cv-split">
            <Btn label="Forme" shortcut="R" active={tool === 'shape'} onClick={() => setTool('shape')}>
              {shapeIcon}
            </Btn>
            <Menu withinPortal position="top">
              <Menu.Target>
                <button type="button" className="or-cv-split-more" aria-label="Choisir la forme">
                  ▾
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                {SHAPES.map((s) => (
                  <Menu.Item
                    key={s.kind}
                    leftSection={s.icon}
                    onClick={() => {
                      setStyle((st) => ({ ...st, shape: s.kind }));
                      setTool('shape');
                    }}
                  >
                    {s.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </div>
          <Btn label="Texte" shortcut="T" active={tool === 'text'} onClick={() => setTool('text')}>
            <Type size={17} />
          </Btn>
          <Btn label="Note" shortcut="N" active={tool === 'note'} onClick={() => setTool('note')}>
            <StickyNote size={17} />
          </Btn>
          <Btn label="Connecteur" shortcut="C" active={tool === 'connector'} onClick={() => setTool('connector')}>
            <Spline size={17} />
          </Btn>
          <Popover opened={tool === 'pen' || tool === 'highlighter'} position="top" withinPortal shadow="md" trapFocus={false} returnFocus={false}>
            <Popover.Target>
              <span className="or-cv-pen-group">
                <Btn label="Stylo" shortcut="P" active={tool === 'pen'} onClick={() => setTool('pen')}>
                  <PenLine size={17} />
                </Btn>
                <Btn label="Surligneur" shortcut="M" active={tool === 'highlighter'} onClick={() => setTool('highlighter')}>
                  <Highlighter size={17} />
                </Btn>
              </span>
            </Popover.Target>
            <Popover.Dropdown>
              <Swatches
                kind="ink"
                value={tool === 'highlighter' ? style.highlighterColor : style.penColor}
                onChange={(c) => setStyle((s) => (tool === 'highlighter' ? { ...s, highlighterColor: c as CanvasColor } : { ...s, penColor: c as CanvasColor }))}
              />
              <Segmented label="Épaisseur" value={style.penSize} onChange={(v) => setStyle((s) => ({ ...s, penSize: v }))} options={[2, 4, 8, 14].map((v) => ({ value: v, label: `${v}` }))} />
            </Popover.Dropdown>
          </Popover>
          <Btn label="Gomme" shortcut="E" active={tool === 'eraser'} onClick={() => setTool('eraser')}>
            <Eraser size={17} />
          </Btn>
          <span className="or-cv-sep" />
          <Btn label="Cadre" shortcut="F" active={tool === 'frame'} onClick={() => setTool('frame')}>
            <SquareDashed size={17} />
          </Btn>
          <Btn label="Carte mentale" shortcut="K" active={tool === 'mindmap'} onClick={() => setTool('mindmap')}>
            <Network size={17} />
          </Btn>
          <span className="or-cv-sep" />
          <Btn label="Image" onClick={props.addImage} disabled={!props.canUpload}>
            <ImagePlus size={17} />
          </Btn>
          <Btn label="Fichier" onClick={props.addFile} disabled={!props.canUpload}>
            <Paperclip size={17} />
          </Btn>
          <Btn label="Lier une page" onClick={props.linkPage}>
            <FileText size={17} />
          </Btn>
        </div>
      )}

      <div className="or-cv-zoom" role="group" aria-label="Zoom">
        <Btn label="Dézoomer" shortcut={`${modKey()}−`} onClick={() => props.zoomBy(1 / 1.2)}>
          <Minus size={15} />
        </Btn>
        <Tooltip label="Revenir à 100 %" withinPortal openDelay={350}>
          <button type="button" className="or-cv-zoom-value" onClick={props.resetZoom} aria-label={`Zoom ${zoomPct} %, revenir à 100 %`}>
            {zoomPct} %
          </button>
        </Tooltip>
        <Btn label="Zoomer" shortcut={`${modKey()}+`} onClick={() => props.zoomBy(1.2)}>
          <Plus size={15} />
        </Btn>
        <Btn label="Tout afficher" shortcut="⇧1" onClick={props.fitAll}>
          <Maximize size={15} />
        </Btn>
      </div>

      {empty && !readOnly && (
        <div className="or-cv-templates" role="region" aria-label="Modèles de départ">
          <div className="or-cv-templates-title">Commencer avec un modèle</div>
          <div className="or-cv-templates-grid">
            {CANVAS_TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="or-cv-template" onClick={() => props.insertTemplate(t.build())}>
                <span className="or-cv-template-name">{t.name}</span>
                <span className="or-cv-template-desc">{t.description}</span>
              </button>
            ))}
          </div>
          <div className="or-cv-templates-hint">ou choisissez un outil ci-dessous, collez une image ou une liste à puces.</div>
        </div>
      )}
      {empty && readOnly && <div className="or-cv-empty">Ce canevas est vide.</div>}

      {framesOpen && (
        <FramesPanel
          store={props.store}
          frames={frames}
          readOnly={readOnly}
          onClose={() => setFramesOpen(false)}
          onGo={(f) => {
            props.select([f.id]);
            props.fitRect({ x: f.x, y: f.y, w: f.w, h: f.h }, 2);
          }}
          onPresent={(f) => props.setPresenting(f.id)}
        />
      )}
      {props.presenting !== null && frames.length > 0 && (
        <Presentation objects={objects} frames={frames} startId={props.presenting} publicMode={props.publicMode} onClose={() => props.setPresenting(null)} />
      )}
    </>
  );
}
