/**
 * What JS hands the native 3D scene besides the look (#551 redesign): the
 * trails to lift onto the terrain and the pin plates' theme. Pure packing —
 * the hook sends the result once per change, never per frame.
 */
import { parseColor, type Rgb } from './look';

/** One polyline for the native scene (the module's `TerrainLine` record). */
export interface TerrainLineSpec {
  id: number;
  /** lng, lat pairs. */
  coords: number[];
  /** color rgba, halo rgba, width, haloWidth, order. */
  style: number[];
}

export interface LineStyleInput {
  color: string;
  halo: string;
  haloOpacity: number;
  /** Line width in logical px; the halo adds `haloAdd` across. */
  width: number;
  haloAdd: number;
  /** Draw order (higher on top). */
  order: number;
}

type Position = readonly number[];
export type LineGeometry =
  | { type: 'LineString'; coordinates: readonly Position[] }
  | { type: 'MultiLineString'; coordinates: readonly (readonly Position[])[] };

/** Most points one line sends across the bridge (the engine densifies to ~15 m anyway). */
export const MAX_LINE_POINTS = 4000;

const FALLBACK_LINE: Rgb = [0xc2 / 255, 0x41 / 255, 0x0c / 255];

/** The parts of a (multi)line string, each at least two points. */
export function lineParts(g: LineGeometry): (readonly Position[])[] {
  const parts = g.type === 'LineString' ? [g.coordinates] : [...g.coordinates];
  return parts.filter((p) => p.length >= 2);
}

/**
 * Flat lng, lat pairs, decimated to at most `max` points by keeping every
 * k-th (always keeping the last, so the line still ends where it ends).
 */
export function flattenPart(part: readonly Position[], max = MAX_LINE_POINTS): number[] {
  const n = part.length;
  const step = n > max ? Math.ceil(n / max) : 1;
  const out: number[] = [];
  for (let i = 0; i < n; i += step) {
    const p = part[i];
    if (p === undefined) continue;
    const [lng, lat] = p;
    if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }
    out.push(lng, lat);
  }
  const last = part[n - 1];
  if (step > 1 && last !== undefined && (n - 1) % step !== 0) {
    const [lng, lat] = last;
    if (lng !== undefined && lat !== undefined) out.push(lng, lat);
  }
  return out;
}

/** The packed style floats for a line (see TerrainNative.nativeSetPolyline). */
export function packLineStyle(s: LineStyleInput): number[] {
  const c = parseColor(s.color) ?? FALLBACK_LINE;
  const h = parseColor(s.halo) ?? [1, 1, 1];
  return [
    c[0],
    c[1],
    c[2],
    1,
    h[0],
    h[1],
    h[2],
    s.haloOpacity,
    s.width,
    s.width + s.haloAdd,
    s.order,
  ];
}

/**
 * Lines for the scene: one spec per part, ids `base + k` so a set can be
 * replaced wholesale. `colorOf` picks a feature's colour (trail categories).
 */
export function sceneLines(
  features: readonly { geometry: LineGeometry; color?: string | null }[],
  style: LineStyleInput,
  base: number,
): TerrainLineSpec[] {
  const out: TerrainLineSpec[] = [];
  for (const f of features) {
    const packed = packLineStyle({ ...style, color: f.color ?? style.color });
    for (const part of lineParts(f.geometry)) {
      const coords = flattenPart(part);
      if (coords.length < 4) continue;
      out.push({ id: base + out.length, coords, style: packed });
    }
  }
  return out;
}

export interface LabelThemeInput {
  plate: string;
  plateOpacity: number;
  ink: string;
  muted: string;
  water: string;
}

/** Plate rgba, ink rgb, muted rgb, water rgb (the module's `labelTheme`). */
export function packLabelTheme(t: LabelThemeInput): number[] {
  const plate = parseColor(t.plate) ?? [0.97, 0.95, 0.91];
  const ink = parseColor(t.ink) ?? [0.17, 0.15, 0.12];
  const muted = parseColor(t.muted) ?? [0.42, 0.39, 0.34];
  const water = parseColor(t.water) ?? [0.25, 0.45, 0.6];
  return [...plate, t.plateOpacity, ...ink, ...muted, ...water];
}

/** Name properties for a label language (as the 2D style's nameField). */
export function nameFieldsFor(language: 'local' | 'fr' | 'en' | undefined): string[] {
  if (language === 'fr') return ['name:fr', 'name'];
  if (language === 'en') return ['name:en', 'name'];
  return ['name'];
}
