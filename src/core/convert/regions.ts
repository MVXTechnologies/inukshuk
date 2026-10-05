/**
 * Where things apply: frame regions, province / state / country boxes for
 * suggestions and grid packs, and chart-datum zones.
 *
 * These boxes only SUGGEST (the picker's "Suggested here") and pick packs.
 * Correctness never depends on them: a grid answers "outside" itself (the
 * engine refuses), and projections have their own zone check.
 */
import type { BBox, Region } from './types';

export const BOX = {
  canada: [-141.1, 41.6, -52.5, 83.2],
  qc: [-79.8, 44.99, -57.1, 62.6],
  on: [-95.2, 41.6, -74.3, 56.9],
  sk: [-110.01, 48.99, -101.35, 60.01],
  nb: [-69.1, 44.55, -63.7, 48.1],
  bc: [-139.1, 48.2, -114.0, 60.01],
  pe: [-64.5, 45.9, -61.9, 47.1],
  ns: [-66.4, 43.3, -59.6, 47.1],
  conus: [-125.0, 24.4, -66.9, 49.4],
  france: [-5.2, 41.3, 9.6, 51.15],
  uk: [-8.7, 49.8, 1.9, 60.9],
  gb: [-6.5, 49.8, 1.9, 60.9],
  ni: [-8.2, 54.0, -5.4, 55.4],
  switzerland: [5.9, 45.8, 10.5, 47.85],
  norway: [4.0, 57.9, 31.2, 71.3],
  netherlands: [3.2, 50.7, 7.3, 53.6],
  /** Where NSGI's RDNAPTRANS2018 points were validated, grid + Helmert fallback. */
  rdFallback: [-2.5, 31.0, 15.5, 60.5],
  world: [-180, -90, 180, 90],
} as const satisfies Record<string, BBox>;

export function inBox(box: BBox, lon: number, lat: number): boolean {
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
}

/**
 * The conterminous United States, coarsely (≈ 5–10 km along the Canadian
 * border, which is what matters: NOAA's NADCON5 grids reach 50° N, and using
 * them in Québec is TRAP 5). Offshore to the south and both coasts.
 */
export const CONUS_OUTLINE: readonly (readonly [number, number])[] = [
  [-124.9, 48.4],
  [-123.3, 48.25],
  [-123.25, 48.7],
  [-123.05, 49.0],
  [-95.15, 49.0],
  [-95.15, 49.38],
  [-94.82, 49.32],
  [-94.6, 48.72],
  [-93.0, 48.6],
  [-91.4, 48.06],
  [-89.6, 48.0],
  [-88.4, 48.3],
  [-84.85, 46.9],
  [-84.4, 46.5],
  [-83.6, 46.1],
  [-82.5, 45.3],
  [-82.4, 43.0],
  [-83.1, 42.1],
  [-82.4, 41.7],
  [-79.0, 42.5],
  [-79.05, 43.25],
  [-77.5, 43.6],
  [-76.4, 44.1],
  [-75.3, 44.8],
  [-74.7, 45.0],
  [-71.5, 45.01],
  [-71.1, 45.3],
  [-70.8, 45.4],
  [-70.25, 45.95],
  [-70.0, 46.7],
  [-69.22, 47.45],
  [-68.3, 47.35],
  [-67.8, 47.07],
  [-67.78, 45.95],
  [-67.4, 45.6],
  [-66.95, 44.8],
  [-66.5, 44.0],
  [-69.5, 40.5],
  [-74.5, 38.0],
  [-75.0, 35.0],
  [-79.0, 31.0],
  [-79.5, 24.0],
  [-82.5, 24.0],
  [-84.0, 28.5],
  [-89.0, 28.5],
  [-97.0, 25.9],
  [-97.15, 25.95],
  [-99.5, 27.5],
  [-101.4, 29.8],
  [-103.3, 29.0],
  [-104.7, 29.9],
  [-106.5, 31.78],
  [-108.2, 31.78],
  [-108.2, 31.33],
  [-111.07, 31.33],
  [-114.8, 32.5],
  [-117.12, 32.53],
  [-118.5, 32.5],
  [-121.0, 34.0],
  [-125.0, 40.0],
  [-125.2, 46.0],
];

/** Even–odd point-in-polygon on lon/lat. */
export function inPolygon(
  poly: readonly (readonly [number, number])[],
  lon: number,
  lat: number,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as readonly [number, number];
    const b = poly[j] as readonly [number, number];
    if (a[1] > lat !== b[1] > lat && lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export function inRegion(r: Region, lon: number, lat: number): boolean {
  return r === 'conus' ? inPolygon(CONUS_OUTLINE, lon, lat) : inBox(r, lon, lat);
}

/** The place name shown in "Suggested here · …". */
export function placeName(lon: number, lat: number): string | null {
  const order: [keyof typeof BOX, string][] = [
    ['qc', 'Québec'],
    ['nb', 'New Brunswick'],
    ['pe', 'Prince Edward Island'],
    ['ns', 'Nova Scotia'],
    ['on', 'Ontario'],
    ['sk', 'Saskatchewan'],
    ['bc', 'British Columbia'],
    ['canada', 'Canada'],
    ['conus', 'United States'],
    ['ni', 'Northern Ireland'],
    ['gb', 'Great Britain'],
    ['france', 'France'],
    ['switzerland', 'Switzerland'],
    ['netherlands', 'Netherlands'],
    ['norway', 'Norway'],
  ];
  for (const [k, name] of order) if (inBox(BOX[k], lon, lat)) return name;
  return null;
}

/** Great-circle distance, metres (spherical; for "within N km of the gauge"). */
export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Chart-datum zones: a station's CD is never carried across a break where
 * the local datum jumps. The first (DESIGN §2.3) is the St. Lawrence break
 * between Portneuf and Trois-Rivières (≈ 4 m): upstream of it, a downstream
 * station's offsets do not apply, and vice versa.
 */
export interface CdBreak {
  name: string;
  /** A point is "upstream" when its longitude is west of this meridian, inside `box`. */
  lon: number;
  box: BBox;
}

export const CD_BREAKS: readonly CdBreak[] = [
  { name: 'Portneuf ↔ Trois-Rivières', lon: -72.25, box: [-74.5, 45.5, -71.6, 47.2] },
];

/** The break separating two points, if any (then a station's CD can't be used). */
export function cdBreakBetween(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): CdBreak | null {
  for (const brk of CD_BREAKS) {
    const inA = inBox(brk.box, a.lon, a.lat);
    const inB = inBox(brk.box, b.lon, b.lat);
    if (!inA && !inB) continue;
    if (a.lon < brk.lon !== b.lon < brk.lon) return brk;
  }
  return null;
}
