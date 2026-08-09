import type { CatalogBbox } from './schema';

/**
 * Locator-thumbnail geometry for the map store: a small offline "where is this
 * sheet" preview. Each catalog row shows the item's bbox as a highlighted
 * rectangle over a simplified land/lake/border outline of the Canada region
 * (baked into `locatorBasemap.ts` from Natural Earth data).
 *
 * Pure math + SVG path-string building — rendering is `react-native-svg` in
 * `@features/store`. The scene is computed per item and memoized by the UI, so
 * everything here is deterministic and allocation-light: rings are stored as
 * flat `[lon, lat, …]` arrays with a precomputed bounds box for cheap
 * window rejection before any clipping happens.
 */

/** One ring/polyline: precomputed bounds + flat [lon0, lat0, lon1, lat1, …]. */
export interface LocatorRing {
  /** Bounds [west, south, east, north] for cheap window rejection. */
  b: readonly [number, number, number, number];
  /** Flat lon/lat pairs. */
  p: readonly number[];
}

export interface LocatorBasemap {
  /** Coastline polygons (filled land). */
  land: readonly LocatorRing[];
  /** Lake polygons (filled water over land). */
  lakes: readonly LocatorRing[];
  /** Country + province boundary polylines (stroked). */
  borders: readonly LocatorRing[];
}

/** Geographic view window of a thumbnail, degrees. */
export interface LocatorWindow {
  west: number;
  south: number;
  east: number;
  north: number;
  /** cos(center latitude): the x-scale that keeps the window square in px. */
  cosLat: number;
}

const DEG2RAD = Math.PI / 180;

/** How many times bigger than the sheet the window is (sheet ≈ 1/5 of the thumb). */
const WINDOW_FACTOR = 5;
/** Window latitude span clamp, degrees: enough context, never the whole country. */
const MIN_LAT_SPAN = 3;
const MAX_LAT_SPAN = 16;

/**
 * The geographic window a thumbnail shows for an item bbox: centered on the
 * sheet, `WINDOW_FACTOR`× its projected size (clamped), and square in
 * projected pixels (lon span = lat span / cos φ).
 */
export function locatorWindow(bbox: CatalogBbox): LocatorWindow {
  const [west, south, east, north] = bbox;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos(centerLat * DEG2RAD));
  const projectedSpan = Math.max(north - south, (east - west) * cosLat);
  const latSpan = Math.min(MAX_LAT_SPAN, Math.max(MIN_LAT_SPAN, projectedSpan * WINDOW_FACTOR));
  const lonSpan = latSpan / cosLat;
  return {
    west: centerLon - lonSpan / 2,
    east: centerLon + lonSpan / 2,
    south: centerLat - latSpan / 2,
    north: centerLat + latSpan / 2,
    cosLat,
  };
}

/** Project lon/lat to thumbnail px (y grows downward). */
export function projectToWindow(
  lon: number,
  lat: number,
  window: LocatorWindow,
  size: number,
): [number, number] {
  const scale = size / (window.north - window.south);
  return [(lon - window.west) * window.cosLat * scale, (window.north - lat) * scale];
}

type Pt = readonly [number, number];

/**
 * Sutherland–Hodgman polygon clip against an axis-aligned px rect [0, size]².
 * Returns the clipped polygon (possibly empty). Input/output are px points.
 */
export function clipPolygonToSquare(points: readonly Pt[], size: number): Pt[] {
  type Edge = (p: Pt) => boolean;
  type Intersect = (a: Pt, b: Pt) => Pt;
  const clipEdge = (input: readonly Pt[], inside: Edge, intersect: Intersect): Pt[] => {
    const output: Pt[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]!;
      const previous = input[(i + input.length - 1) % input.length]!;
      const currentIn = inside(current);
      const previousIn = inside(previous);
      if (currentIn) {
        if (!previousIn) output.push(intersect(previous, current));
        output.push(current);
      } else if (previousIn) {
        output.push(intersect(previous, current));
      }
    }
    return output;
  };
  const atX = (a: Pt, b: Pt, x: number): Pt => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + t * (b[1] - a[1])];
  };
  const atY = (a: Pt, b: Pt, y: number): Pt => {
    const t = (y - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), y];
  };
  let out: Pt[] = [...points];
  out = clipEdge(
    out,
    (p) => p[0] >= 0,
    (a, b) => atX(a, b, 0),
  );
  out = clipEdge(
    out,
    (p) => p[0] <= size,
    (a, b) => atX(a, b, size),
  );
  out = clipEdge(
    out,
    (p) => p[1] >= 0,
    (a, b) => atY(a, b, 0),
  );
  out = clipEdge(
    out,
    (p) => p[1] <= size,
    (a, b) => atY(a, b, size),
  );
  return out;
}

/**
 * Clip a polyline to the px square, splitting it where it leaves. Returns the
 * kept sub-polylines (each ≥ 2 points). Liang–Barsky per segment.
 */
export function clipPolylineToSquare(points: readonly Pt[], size: number): Pt[][] {
  const out: Pt[][] = [];
  let current: Pt[] = [];
  const flush = (): void => {
    if (current.length >= 2) out.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const clipped = clipSegment(points[i]!, points[i + 1]!, size);
    if (clipped === null) {
      flush();
      continue;
    }
    const [a, b] = clipped;
    if (current.length === 0) {
      current.push(a, b);
    } else {
      const tail = current[current.length - 1]!;
      if (tail[0] === a[0] && tail[1] === a[1]) {
        current.push(b);
      } else {
        flush();
        current.push(a, b);
      }
    }
  }
  flush();
  return out;
}

/** Liang–Barsky segment/square clip; null when fully outside. */
function clipSegment(a: Pt, b: Pt, size: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: readonly (readonly [number, number])[] = [
    [-dx, a[0]], // left: x >= 0
    [dx, size - a[0]], // right: x <= size
    [-dy, a[1]], // top: y >= 0
    [dy, size - a[1]], // bottom: y <= size
  ];
  for (const [p, qv] of checks) {
    if (p === 0) {
      if (qv < 0) return null;
      continue;
    }
    const r = qv / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** Round px to 1 decimal for compact path strings. */
const px = (v: number): string => String(Math.round(v * 10) / 10);

function toPath(points: readonly Pt[], close: boolean): string {
  let d = `M${px(points[0]![0])} ${px(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += `L${px(points[i]![0])} ${px(points[i]![1])}`;
  return close ? `${d}Z` : d;
}

/** Does a ring's bounds box intersect the geographic window? */
function ringInWindow(ring: LocatorRing, window: LocatorWindow): boolean {
  const [w, s, e, n] = ring.b;
  return w <= window.east && e >= window.west && s <= window.north && n >= window.south;
}

/** The item's bbox as a px rect in the scene. */
export interface LocatorSheetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything a thumbnail draws, precomputed as SVG path data in px. */
export interface LocatorScene {
  /** Canvas size in px the paths are expressed in (viewBox side). */
  size: number;
  /** Filled land polygons. */
  land: readonly string[];
  /** Filled lake polygons (water color, over land). */
  lakes: readonly string[];
  /** Stroked border polylines. */
  borders: readonly string[];
  /** The highlighted item-bbox rectangle. */
  sheet: LocatorSheetRect;
}

function projectRing(ring: LocatorRing, window: LocatorWindow, size: number): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i + 1 < ring.p.length; i += 2) {
    points.push(projectToWindow(ring.p[i]!, ring.p[i + 1]!, window, size));
  }
  return points;
}

/**
 * Build the full thumbnail scene for one catalog item bbox. Rings are
 * bounds-rejected against the window first, then projected and clipped, so the
 * per-item cost stays proportional to what is actually visible.
 */
export function buildLocatorScene(
  bbox: CatalogBbox,
  basemap: LocatorBasemap,
  size: number,
): LocatorScene {
  const window = locatorWindow(bbox);

  const polygons = (rings: readonly LocatorRing[]): string[] => {
    const paths: string[] = [];
    for (const ring of rings) {
      if (!ringInWindow(ring, window)) continue;
      const clipped = clipPolygonToSquare(projectRing(ring, window, size), size);
      if (clipped.length >= 3) paths.push(toPath(clipped, true));
    }
    return paths;
  };

  const polylines = (rings: readonly LocatorRing[]): string[] => {
    const paths: string[] = [];
    for (const ring of rings) {
      if (!ringInWindow(ring, window)) continue;
      for (const piece of clipPolylineToSquare(projectRing(ring, window, size), size)) {
        paths.push(toPath(piece, false));
      }
    }
    return paths;
  };

  const [topLeftX, topLeftY] = projectToWindow(bbox[0], bbox[3], window, size);
  const [bottomRightX, bottomRightY] = projectToWindow(bbox[2], bbox[1], window, size);

  return {
    size,
    land: polygons(basemap.land),
    lakes: polygons(basemap.lakes),
    borders: polylines(basemap.borders),
    sheet: {
      x: topLeftX,
      y: topLeftY,
      width: bottomRightX - topLeftX,
      height: bottomRightY - topLeftY,
    },
  };
}
