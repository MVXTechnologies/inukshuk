/**
 * Locator-basemap generator — bakes a simplified Canada-region outline into
 * `src/core/catalog/locatorBasemap.ts` for the store's offline locator
 * thumbnails (see `src/core/catalog/locator.ts`).
 *
 * Sources: Natural Earth 1:50m public-domain vectors (land, lakes, country
 * borders, province lines), fetched from the natural-earth-vector GitHub repo.
 * The geometry is cropped to the CanTopo coverage window, Douglas–Peucker
 * simplified, pruned of tiny rings and quantized to 2 decimals (~1.1 km) —
 * plenty at the province-scale windows the thumbnails draw.
 *
 * Usage (regenerates the checked-in data file; network required):
 *   npx tsx scripts/catalog/build-locator-basemap.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** Crop window: CanTopo coverage (all of Canada) plus context margin. */
const WEST = -142;
const EAST = -49;
const SOUTH = 40;
const NORTH = 84;

/** Douglas–Peucker tolerance, degrees. */
const TOLERANCE = 0.02;
/** Drop rings whose bbox diagonal is under this many degrees (islets, ponds). */
const MIN_RING_DIAG = 0.35;
/** Quantization: 2 decimals ≈ 1.1 km — invisible at province scale. */
const DECIMALS = 2;

type Pt = readonly [number, number];

interface GjGeometry {
  type: string;
  coordinates: unknown;
}
interface GjFeature {
  properties?: Record<string, unknown>;
  geometry?: GjGeometry | null;
}
interface GjCollection {
  features: GjFeature[];
}

async function fetchGeojson(name: string): Promise<GjCollection> {
  const res = await fetch(`${NE}/${name}.geojson`);
  if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
  return (await res.json()) as GjCollection;
}

/** Perpendicular distance from p to segment a-b (planar degrees — fine for simplification). */
function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points: readonly Pt[], tolerance: number): Pt[] {
  if (points.length < 3) return [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let maxDist = -1;
  let maxIdx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= tolerance) return [first, last];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
  const right = douglasPeucker(points.slice(maxIdx), tolerance);
  return [...left.slice(0, -1), ...right];
}

function ringBounds(points: readonly Pt[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

function intersectsWindow(b: readonly [number, number, number, number]): boolean {
  return b[0] <= EAST && b[2] >= WEST && b[1] <= NORTH && b[3] >= SOUTH;
}

const q = (v: number): number => Number(v.toFixed(DECIMALS));

interface OutRing {
  b: [number, number, number, number];
  p: number[];
}

/** Simplify + quantize one ring/line; null when pruned. */
function processLine(raw: readonly Pt[], minDiag: number): OutRing | null {
  const bounds = ringBounds(raw);
  if (!intersectsWindow(bounds)) return null;
  if (Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) < minDiag) return null;
  const simplified = douglasPeucker(raw, TOLERANCE);
  // Quantize, then drop consecutive duplicates the quantization created.
  const p: number[] = [];
  for (const [x, y] of simplified) {
    const qx = q(x);
    const qy = q(y);
    if (p.length >= 2 && p[p.length - 2] === qx && p[p.length - 1] === qy) continue;
    p.push(qx, qy);
  }
  if (p.length < 6) return null;
  return { b: ringBounds(pairs(p)) as [number, number, number, number], p };
}

function pairs(flat: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** Every LineString/ring of a geometry, as point arrays. `polygons` keeps only outer+large rings. */
function extractLines(geometry: GjGeometry): Pt[][] {
  const out: Pt[][] = [];
  const pushRing = (coords: unknown): void => {
    if (Array.isArray(coords)) out.push(coords as Pt[]);
  };
  switch (geometry.type) {
    case 'LineString':
      pushRing(geometry.coordinates);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const line of geometry.coordinates as unknown[]) pushRing(line);
      break;
    case 'MultiPolygon':
      for (const poly of geometry.coordinates as unknown[][]) {
        for (const ring of poly) pushRing(ring);
      }
      break;
    default:
      break;
  }
  return out;
}

function collect(collection: GjCollection, minDiag: number, filter?: (f: GjFeature) => boolean) {
  const rings: OutRing[] = [];
  for (const feature of collection.features) {
    if (feature.geometry == null) continue;
    if (filter !== undefined && !filter(feature)) continue;
    for (const line of extractLines(feature.geometry)) {
      const ring = processLine(line, minDiag);
      if (ring !== null) rings.push(ring);
    }
  }
  return rings;
}

function emitRings(rings: OutRing[]): string {
  const rows = rings.map((r) => `{b:[${r.b.join(',')}],p:[${r.p.join(',')}]}`);
  return `[\n${rows.join(',\n')}\n]`;
}

async function main(): Promise<void> {
  const [land, lakes, countries, provinces] = await Promise.all([
    fetchGeojson('ne_50m_land'),
    fetchGeojson('ne_50m_lakes'),
    fetchGeojson('ne_50m_admin_0_boundary_lines_land'),
    fetchGeojson('ne_50m_admin_1_states_provinces_lines'),
  ]);

  const landRings = collect(land, MIN_RING_DIAG);
  const lakeRings = collect(lakes, 0.5);
  // Borders: country lines everywhere in-window; province lines for CA + US context.
  const borderRings = [
    ...collect(countries, 0.1),
    ...collect(provinces, 0.1, (f) => {
      const adm = String(f.properties?.ADM0_A3 ?? f.properties?.adm0_a3 ?? '');
      return adm === 'CAN' || adm === 'USA';
    }),
  ];

  const file = `/**
 * GENERATED FILE — do not edit by hand.
 * Simplified Canada-region basemap for the store's locator thumbnails.
 * Regenerate with: npx tsx scripts/catalog/build-locator-basemap.ts
 * Source: Natural Earth 1:50m (public domain), cropped to ${WEST}..${EAST}, ${SOUTH}..${NORTH},
 * simplified to ${TOLERANCE}° and quantized to ${DECIMALS} decimals.
 */
import type { LocatorBasemap } from './locator';

// prettier-ignore
export const LOCATOR_BASEMAP: LocatorBasemap = {
  land: ${emitRings(landRings)},
  lakes: ${emitRings(lakeRings)},
  borders: ${emitRings(borderRings)},
};
`;

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outPath = join(scriptDir, '..', '..', 'src', 'core', 'catalog', 'locatorBasemap.ts');
  writeFileSync(outPath, file);
  const points = [...landRings, ...lakeRings, ...borderRings].reduce(
    (acc, r) => acc + r.p.length / 2,
    0,
  );
  console.log(
    `locatorBasemap.ts: ${landRings.length} land, ${lakeRings.length} lake, ` +
      `${borderRings.length} border rings — ${points} points, ${(file.length / 1024).toFixed(0)} KB`,
  );
}

void main();
