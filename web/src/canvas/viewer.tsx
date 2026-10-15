// Read-only rendering of a canvas region (H1): presentation slides and the « Cadre de canevas »
// block. Same renderers as the editor, in a fixed viewBox, without interaction.
import { useId, useMemo } from 'react';
import type { CanvasObject } from '@oriel/shared';
import { byZ, type Rect } from './model';
import { connectorRoute, intersects, objectBounds } from './geometry';
import { ObjectBody, objectTransform, type RenderEnv } from './render';

export function StaticCanvas({
  objects,
  region,
  env,
  className,
  label,
}: {
  objects: ReadonlyMap<string, CanvasObject>;
  region: Rect;
  env: RenderEnv;
  className?: string;
  label: string;
}) {
  const get = (id: string) => objects.get(id);
  const visible = useMemo(() => {
    const view = { x: region.x - 40, y: region.y - 40, w: region.w + 80, h: region.h + 80 };
    return [...objects.values()].filter((o) => intersects(objectBounds(o, get), view)).sort(byZ);
  }, [objects, region.x, region.y, region.w, region.h]);
  const zoom = 1;
  const clip = `or-cv-clip-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <svg className={className} viewBox={`${region.x} ${region.y} ${Math.max(1, region.w)} ${Math.max(1, region.h)}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label}>
      <defs>
        <clipPath id={clip}>
          <rect x={region.x} y={region.y} width={Math.max(1, region.w)} height={Math.max(1, region.h)} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {visible.map((o) => (
          <g key={o.id} transform={objectTransform(o)}>
            <ObjectBody o={o} route={o.type === 'connector' ? connectorRoute(o, get) : undefined} env={env} editing={false} zoom={zoom} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Region shown for a frame (its box) or for everything (union of all bounds). */
export function regionOf(objects: ReadonlyMap<string, CanvasObject>, frameId: string | null): Rect | null {
  const get = (id: string) => objects.get(id);
  if (frameId) {
    const f = objects.get(frameId);
    return f && f.type === 'frame' ? { x: f.x, y: f.y, w: f.w, h: f.h } : null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of objects.values()) {
    const b = objectBounds(o, get);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (minX === Infinity) return null;
  return { x: minX - 20, y: minY - 20, w: maxX - minX + 40, h: maxY - minY + 40 };
}

export const framesInOrder = (objects: ReadonlyMap<string, CanvasObject>) =>
  [...objects.values()]
    .filter((o): o is Extract<CanvasObject, { type: 'frame' }> => o.type === 'frame')
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
