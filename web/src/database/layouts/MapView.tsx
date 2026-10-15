// Map layout: rows placed by a `place` property (coordinates stored with the address, never geocoded
// at display time). Leaflet and its stylesheet are loaded on first use. The tile layer comes from
// the instance configuration (GET /api/public/map-config, MAP_TILE_URL): the browser only contacts
// that tile server, never a geocoder. Popups are DOM nodes filled with textContent (no HTML injected).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import type { Map as LeafletMap, LayerGroup } from 'leaflet';
import type { Page, PropertyDef } from '@oriel/shared';
import { dbExtrasApi } from '../api';
import { useDb } from '../context';
import { displayText } from '../logic/format';
import { mapPoints, placeProperties, pointsBounds, type MapPoint, type MapTiles } from '../logic/map';
import { getText, isEmptyValue } from '../logic/values';
import { cx } from '../ui/primitives';
import type { ViewState } from '../view/types';
import { EmptyState, openRow, RowTitle } from './common';

type LeafletModule = typeof import('leaflet');

let leafletPromise: Promise<LeafletModule> | null = null;
/** Leaflet + its CSS, loaded once on first map. */
function loadLeaflet(): Promise<LeafletModule> {
  if (!leafletPromise) {
    leafletPromise = Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
      .then(([mod]) => ((mod as { default?: LeafletModule }).default ?? mod) as LeafletModule)
      .catch((e) => {
        leafletPromise = null;
        throw e;
      });
  }
  return leafletPromise;
}

const OSM_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Leaflet renders attributions as HTML: the configured text is escaped (only our own OSM link is markup). */
function attributionHtml(tiles: MapTiles): string {
  const text = escapeHtml(tiles.attribution);
  if (tiles.url === OSM_TEMPLATE) {
    return `<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }
  return text;
}

const textNode = (text: string): HTMLElement => {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
};

/** Popup content: title (opens the row), address and the first visible properties, as plain text. */
function popupNode(point: MapPoint, props: PropertyDef[], text: (row: Page, p: PropertyDef) => string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'ordb-map-popup';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ordb-map-popup-title';
  title.textContent = point.row.icon ? `${point.row.icon} ${point.row.title || 'Sans titre'}` : point.row.title || 'Sans titre';
  title.addEventListener('click', () => openRow(point.row.id));
  root.appendChild(title);
  const address = document.createElement('div');
  address.className = 'ordb-map-popup-address';
  address.textContent = point.address;
  root.appendChild(address);
  for (const p of props.slice(0, 4)) {
    const value = text(point.row, p).trim();
    if (!value) continue;
    const line = document.createElement('div');
    line.className = 'ordb-map-popup-prop';
    const name = document.createElement('span');
    name.className = 'ordb-map-popup-name';
    name.textContent = p.name;
    const v = document.createElement('span');
    v.textContent = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    line.append(name, v);
    root.appendChild(line);
  }
  return root;
}

function LeafletCanvas({ points, props, tiles }: { points: MapPoint[]; props: PropertyDef[]; tiles: MapTiles | null }) {
  const { ctx } = useDb();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const L = useRef<LeafletModule | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const fittedFor = useRef<string>('');

  // Map creation (once per tile configuration).
  useEffect(() => {
    let cancelled = false;
    let created: LeafletMap | null = null;
    loadLeaflet()
      .then((leaflet) => {
        if (cancelled || !el.current) return;
        L.current = leaflet;
        created = leaflet.map(el.current, { zoomControl: true, attributionControl: true, worldCopyJump: true });
        created.attributionControl.setPrefix(false);
        if (tiles) {
          leaflet
            .tileLayer(tiles.url, { maxZoom: tiles.maxZoom, attribution: attributionHtml(tiles), crossOrigin: false })
            .addTo(created);
        }
        created.setView([46.6, 2.4], 5);
        layer.current = leaflet.layerGroup().addTo(created);
        map.current = created;
        fittedFor.current = '';
        setReady(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      created?.remove();
      map.current = null;
      layer.current = null;
      setReady(false);
    };
  }, [tiles]);

  // Leaflet measures its container: refresh when it is resized (side panel, window).
  useEffect(() => {
    const node = el.current;
    if (!ready || !node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => map.current?.invalidateSize());
    ro.observe(node);
    return () => ro.disconnect();
  }, [ready]);

  // Markers.
  useEffect(() => {
    const leaflet = L.current;
    const group = layer.current;
    const m = map.current;
    if (!ready || !leaflet || !group || !m) return;
    group.clearLayers();
    for (const p of points) {
      const marker = leaflet.circleMarker([p.lat, p.lng], { radius: 8, className: 'ordb-map-marker', weight: 2, fillOpacity: 0.9 });
      // Leaflet inserts string contents as HTML: tooltips get a text node too (titles come from anyone
      // who can write a row, anonymous form answers included).
      marker.bindTooltip(() => textNode(p.row.title || 'Sans titre'), { direction: 'top', offset: [0, -8] });
      // Display text (option names, people, formatted numbers), not the raw values used by filters.
      marker.bindPopup(() => popupNode(p, props, (row, prop) => displayText(row, prop, ctx)), { maxWidth: 280, minWidth: 160 });
      group.addLayer(marker);
    }
    // Fit the view when the set of located rows changes (not when a value is edited in place).
    const key = points.map((p) => p.row.id).join(',');
    if (key !== fittedFor.current) {
      fittedFor.current = key;
      const bounds = pointsBounds(points);
      if (bounds) {
        if (points.length === 1) m.setView(bounds[0], Math.min(14, tiles?.maxZoom ?? 14));
        else m.fitBounds(bounds, { padding: [32, 32], maxZoom: Math.min(15, tiles?.maxZoom ?? 15) });
      }
    }
  }, [ready, points, props, ctx, tiles]);

  return (
    <div className="ordb-map-frame">
      <div ref={el} className={cx('ordb-map-canvas', !tiles && 'is-blank')} role="region" aria-label="Carte" />
      {!ready && !failed && <div className="ordb-map-overlay">Chargement de la carte…</div>}
      {failed && <div className="ordb-map-overlay">La carte n’a pas pu être chargée.</div>}
    </div>
  );
}

function Unlocated({ rows, prop }: { rows: Page[]; prop: PropertyDef }) {
  const { ctx } = useDb();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="ordb-map-unlocated">
      <button type="button" className="ordb-linkbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {rows.length} ligne{rows.length > 1 ? 's' : ''} sans position sur la carte
      </button>
      {open && (
        <ul>
          {rows.slice(0, 200).map((r) => (
            <li key={r.id}>
              <button type="button" className="ordb-map-unlocated-row" onClick={() => openRow(r.id)}>
                <RowTitle row={r} />
                <span className="ordb-muted">{isEmptyValue(r, prop, ctx) ? 'Aucun lieu' : `${getText(r, prop, ctx)} (sans coordonnées)`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MapView({ vs }: { vs: ViewState }) {
  const { properties, canEdit } = useDb();
  const places = placeProperties(properties);
  const prop = places.find((p) => p.id === vs.config.placeProperty) ?? null;
  const tilesQ = useQuery({ queryKey: ['map-config'], queryFn: () => dbExtrasApi.mapConfig(), staleTime: Infinity, retry: 1 });
  const { points, unlocated } = useMemo(() => (prop ? mapPoints(vs.rows, prop) : { points: [], unlocated: [] }), [vs.rows, prop]);
  const popupProps = useMemo(() => vs.visibleProps.filter((p) => p.type !== 'title' && p.id !== prop?.id), [vs.visibleProps, prop]);

  if (!prop) {
    return (
      <EmptyState>
        <MapPin size={15} />{' '}
        {places.length === 0
          ? `Ajoutez une propriété « Lieu » à cette base pour placer ses lignes sur une carte.`
          : canEdit
            ? 'Choisissez la propriété « Lieu » à afficher dans les options de la vue (Disposition).'
            : 'Aucune propriété « Lieu » n’est choisie pour cette carte.'}
      </EmptyState>
    );
  }
  if (tilesQ.isLoading) return <div className="ordb-skeleton" />;
  const tiles = tilesQ.data ? tilesQ.data.tiles : null;
  return (
    <div className="ordb-map">
      {vs.rows.length === 0 && vs.totalRows > 0 && <EmptyState>Aucune ligne ne correspond aux filtres.</EmptyState>}
      <LeafletCanvas points={points} props={popupProps} tiles={tiles} />
      <Unlocated rows={unlocated} prop={prop} />
    </div>
  );
}
