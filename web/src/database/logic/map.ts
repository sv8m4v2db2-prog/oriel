// Map views: rows located by a `place` property (coordinates stored with the address).
import type { Page, PlaceValue, PropertyDef } from '@oriel/shared';
import { asPlace, rawValue } from './values';

export interface MapPoint {
  row: Page;
  lat: number;
  lng: number;
  address: string;
}

export const placeProperties = (properties: PropertyDef[]): PropertyDef[] => properties.filter((p) => p.type === 'place');

/** Located place of a row (null when empty or typed without coordinates). */
export function locatedPlace(row: Page, prop: PropertyDef): (PlaceValue & { lat: number; lng: number }) | null {
  const p = asPlace(rawValue(row, prop));
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
  if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) return null;
  return p as PlaceValue & { lat: number; lng: number };
}

/** Rows with coordinates (markers) and rows with an address only / no place (listed apart). */
export function mapPoints(rows: readonly Page[], prop: PropertyDef): { points: MapPoint[]; unlocated: Page[] } {
  const points: MapPoint[] = [];
  const unlocated: Page[] = [];
  for (const row of rows) {
    const p = locatedPlace(row, prop);
    if (p) points.push({ row, lat: p.lat, lng: p.lng, address: p.address });
    else unlocated.push(row);
  }
  return { points, unlocated };
}

/** South-west / north-east corners of the points (null without points). */
export function pointsBounds(points: readonly Pick<MapPoint, 'lat' | 'lng'>[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const p of points) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
  }
  return [
    [s, w],
    [n, e],
  ];
}

/** Tile layer of the maps (served by the instance's configuration, see GET /api/public/map-config). */
export interface MapTiles {
  url: string;
  attribution: string;
  maxZoom: number;
}

/** Default tiles: the OpenStreetMap standard layer (attribution required by its usage policy). */
export const DEFAULT_TILES: MapTiles = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© contributeurs OpenStreetMap',
  maxZoom: 19,
};

/**
 * Coordinates typed by hand (« 48.8566, 2.3522 » or « 48,8566 ; 2,3522 »), for instances without
 * address search. Null when the text is not a valid latitude / longitude pair.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  // U+2212 (minus sign) as written by some number formats.
  const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[;,\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(text.replace(/−/g, '-'));
  if (!m) return null;
  const lat = Number(m[1]!.replace(',', '.'));
  const lng = Number(m[2]!.replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** « 48,8566, 2,3522 » (5 decimals, about 1 m). */
export const formatCoordinates = (lat: number, lng: number): string =>
  `${lat.toLocaleString('fr-FR', { maximumFractionDigits: 5 })} ; ${lng.toLocaleString('fr-FR', { maximumFractionDigits: 5 })}`;

export interface TypedPlaceChoice {
  value: PlaceValue;
  label: string;
  /** The value has coordinates (shown on a map). */
  located: boolean;
}

const hasCoordinates = (p: PlaceValue | null): p is PlaceValue & { lat: number; lng: number } =>
  !!p && typeof p.lat === 'number' && typeof p.lng === 'number';

/**
 * Values offered for a place typed by hand (no geocoder, or none of its results):
 *  - coordinates locate the current address (when it is a real address), or stand alone;
 *  - the current address unchanged keeps its coordinates;
 *  - any other text is an address without position.
 */
export function typedPlaceChoices(text: string, current: PlaceValue | null): TypedPlaceChoice[] {
  const typed = text.trim().slice(0, 500);
  if (!typed) return [];
  const coords = parseCoordinates(typed);
  const address = current?.address.trim() ?? '';
  if (coords) {
    const at = formatCoordinates(coords.lat, coords.lng);
    const out: TypedPlaceChoice[] = [];
    if (address && !parseCoordinates(address)) {
      out.push({ value: { address, lat: coords.lat, lng: coords.lng }, label: `Placer « ${address} » aux coordonnées ${at}`, located: true });
    }
    out.push({ value: { address: at, lat: coords.lat, lng: coords.lng }, label: `Placer aux coordonnées ${at}`, located: true });
    return out;
  }
  if (address === typed && hasCoordinates(current)) return [{ value: current, label: `Garder « ${typed} »`, located: true }];
  return [{ value: { address: typed }, label: `Utiliser « ${typed} »`, located: false }];
}
