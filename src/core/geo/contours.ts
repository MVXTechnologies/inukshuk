import type { Feature, MultiLineString, Position } from 'geojson';
import type { BoundingBox } from '@core/models';
import { autoContourInterval } from './terrainAnalysis';

/**
 * Marching-squares contour extraction over a metre-space heightmap grid,
 * producing GeoJSON for the 2D map's contour overlay. The 3D map draws the
 * same isolines analytically in its fragment shader; this module is the
 * vector-space equivalent for MapLibre line layers.
 *
 * Grid convention matches {@link import('@features/map/dem').Heightmap}:
 * row-major `grid × grid`, row 0 = the NORTH edge of `bbox`.
 */

/** The heightmap subset contouring needs (structurally matches `Heightmap`). */
export interface ContourGrid {
  data: ArrayLike<number>;
  grid: number;
  bbox: BoundingBox;
  minH: number;
  maxH: number;
}

/** Contour polylines split by rank, ready for two MapLibre line layers. */
export interface ContourFeatures {
  minor: Feature<MultiLineString>;
  major: Feature<MultiLineString>;
  /** The interval actually used (after auto/clamping). */
  intervalM: number;
}

/** Every 5th line is a major (bolder) contour — same as the 3D shader. */
export const CONTOUR_MAJOR_EVERY = 5;

/**
 * Cap on drawn levels: a viewport whose relief would produce more lines than
 * this at the requested interval steps up to the next coarser interval — a
 * 10 m request over a 3000 m relief span must not emit 300 polyline levels.
 */
const MAX_LEVELS = 120;
const INTERVAL_LADDER = [10, 25, 50, 100, 200, 500, 1000] as const;

/**
 * The interval actually contoured for a relief span: the request (0 = auto,
 * span-based), stepped up the ladder until the level count is drawable.
 */
export function effectiveContourInterval(spanM: number, requestedM: number): number {
  let interval = requestedM > 0 ? requestedM : autoContourInterval(spanM);
  for (const step of INTERVAL_LADDER) {
    if (spanM / interval <= MAX_LEVELS) break;
    if (step > interval) interval = step;
  }
  return interval;
}

/** Grid-space point on a cell edge, keyed so shared edges chain exactly. */
interface EdgePoint {
  key: string;
  x: number;
  y: number;
}

/**
 * Linear interpolation of the level crossing between two grid nodes.
 * The key is direction-independent so the two cells sharing the edge produce
 * the identical endpoint, letting segments chain into polylines by key.
 */
function crossing(
  x0: number,
  y0: number,
  h0: number,
  x1: number,
  y1: number,
  h1: number,
  level: number,
  grid: number,
): EdgePoint {
  const t = (level - h0) / (h1 - h0);
  const a = y0 * grid + x0;
  const b = y1 * grid + x1;
  return {
    key: a < b ? `${a}-${b}` : `${b}-${a}`,
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * t,
  };
}

/** Chain unordered segments (pairs of keyed points) into polylines. */
function chainSegments(segments: [EdgePoint, EdgePoint][]): EdgePoint[][] {
  // Adjacency: endpoint key → indices of segments touching it.
  const byKey = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const k of [a.key, b.key]) {
      const list = byKey.get(k);
      if (list) list.push(i);
      else byKey.set(k, [i]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const lines: EdgePoint[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const [a, b] = segments[start]!;
    const line: EdgePoint[] = [a, b];
    // Extend forward from the tail, then backward from the head.
    for (const dir of [1, -1] as const) {
      for (;;) {
        const tip = dir === 1 ? line[line.length - 1]! : line[0]!;
        const nextI = (byKey.get(tip.key) ?? []).find((i) => !used[i]);
        if (nextI === undefined) break;
        used[nextI] = true;
        const [p, q] = segments[nextI]!;
        const next = p.key === tip.key ? q : p;
        if (dir === 1) line.push(next);
        else line.unshift(next);
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Extract contour polylines for every multiple of the effective interval
 * inside the grid's elevation range, split into minor/major MultiLineStrings
 * (major = every {@link CONTOUR_MAJOR_EVERY}th level) in lng/lat coordinates.
 */
export function contourFeatures(hm: ContourGrid, requestedIntervalM: number): ContourFeatures {
  const { data, grid, bbox } = hm;
  const intervalM = effectiveContourInterval(hm.maxH - hm.minH, requestedIntervalM);
  // 6 decimals ≈ 0.11 m — far finer than a grid cell, and it halves the
  // serialized GeoJSON (full-precision doubles print ~17 digits), which is
  // what MapLibre's ShapeSource ships across the bridge on every recompute.
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const toLngLat = (p: EdgePoint): Position => [
    round6(bbox.minLng + (p.x / (grid - 1)) * (bbox.maxLng - bbox.minLng)),
    round6(bbox.maxLat - (p.y / (grid - 1)) * (bbox.maxLat - bbox.minLat)),
  ];

  const minor: Position[][] = [];
  const major: Position[][] = [];
  const at = (x: number, y: number) => data[y * grid + x] as number;

  const firstLevel = Math.ceil(hm.minH / intervalM) * intervalM;
  for (let level = firstLevel; level <= hm.maxH; level += intervalM) {
    const segments: [EdgePoint, EdgePoint][] = [];
    for (let y = 0; y < grid - 1; y++) {
      for (let x = 0; x < grid - 1; x++) {
        const tl = at(x, y);
        const tr = at(x + 1, y);
        const br = at(x + 1, y + 1);
        const bl = at(x, y + 1);
        // Marching-squares case index; ≥ counts as inside so a node exactly on
        // the level doesn't create degenerate zero-length crossings.
        let idx = 0;
        if (tl >= level) idx |= 8;
        if (tr >= level) idx |= 4;
        if (br >= level) idx |= 2;
        if (bl >= level) idx |= 1;
        if (idx === 0 || idx === 15) continue;

        const top = () => crossing(x, y, tl, x + 1, y, tr, level, grid);
        const right = () => crossing(x + 1, y, tr, x + 1, y + 1, br, level, grid);
        const bottom = () => crossing(x, y + 1, bl, x + 1, y + 1, br, level, grid);
        const left = () => crossing(x, y, tl, x, y + 1, bl, level, grid);

        switch (idx) {
          case 1:
          case 14:
            segments.push([left(), bottom()]);
            break;
          case 2:
          case 13:
            segments.push([bottom(), right()]);
            break;
          case 3:
          case 12:
            segments.push([left(), right()]);
            break;
          case 4:
          case 11:
            segments.push([top(), right()]);
            break;
          case 6:
          case 9:
            segments.push([top(), bottom()]);
            break;
          case 7:
          case 8:
            segments.push([left(), top()]);
            break;
          case 5: // saddle: disambiguate by the cell-centre elevation
          case 10: {
            const centreHigh = (tl + tr + br + bl) / 4 >= level;
            const joinA = (idx === 5) === centreHigh;
            if (joinA) {
              segments.push([left(), top()], [bottom(), right()]);
            } else {
              segments.push([left(), bottom()], [top(), right()]);
            }
            break;
          }
        }
      }
    }
    if (segments.length === 0) continue;
    const lines = chainSegments(segments).map((line) => line.map(toLngLat));
    const isMajor = Math.round(level / intervalM) % CONTOUR_MAJOR_EVERY === 0;
    (isMajor ? major : minor).push(...lines);
  }

  const feature = (coords: Position[][]): Feature<MultiLineString> => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiLineString', coordinates: coords },
  });
  return { minor: feature(minor), major: feature(major), intervalM };
}
