import type { CatalogBbox } from './schema';

/**
 * Terrain classification geometry — the pure half of the build-time terrain
 * pass (`scripts/catalog/terrain.ts` does the downloading and caching).
 *
 * Two independent signals, both judged against an item's bbox:
 *
 * - **Relief** from the Terrarium DEM (Mapzen/AWS open elevation tiles, the
 *   ones the contour Worker already uses). A tile is reduced to per-block
 *   min/max elevations ({@link summarizeTerrariumTile}); an item's footprint is
 *   then scored from the blocks it covers ({@link reliefStats}) and called
 *   mountainous by {@link isMountainous}.
 * - **Vector overlap** with Natural Earth layers (glaciers, lakes, rivers,
 *   coastline) through a grid-bucketed segment/polygon index
 *   ({@link GeometryIndex}), so ~90 000 bboxes can be tested in seconds.
 */

/* ------------------------------------------------------------ DEM tiles --- */

/** Terrarium encoding: metres = R·256 + G + B/256 − 32768. */
export function terrariumMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional Web-Mercator tile x of a longitude at zoom `z`. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Fractional Web-Mercator tile y of a latitude at zoom `z` (clamped to ±85.0511°). */
export function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

export interface TileXY {
  x: number;
  y: number;
}

/** Every tile at zoom `z` that a bbox touches. */
export function tilesForBbox(bbox: CatalogBbox, z: number): TileXY[] {
  const n = 2 ** z;
  const [west, south, east, north] = bbox;
  const x0 = Math.max(0, Math.floor(lonToTileX(west, z)));
  const x1 = Math.min(n - 1, Math.floor(lonToTileX(east, z) - 1e-9));
  const y0 = Math.max(0, Math.floor(latToTileY(north, z)));
  const y1 = Math.min(n - 1, Math.floor(latToTileY(south, z) - 1e-9));
  const tiles: TileXY[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ x, y });
  return tiles;
}

/** Per-block elevation extremes for one tile, row-major, `side × side` blocks. */
export interface BlockSummary {
  side: number;
  min: Int16Array;
  max: Int16Array;
}

/**
 * Terrarium elevations clamped to land: bathymetry is not relief (a coastal
 * sheet must not read as a 3 000 m mountain), and the dataset's rare void
 * sentinels (≈ −32 768) must not either.
 */
const clampLand = (m: number): number => Math.max(0, Math.min(9000, Math.round(m)));

/**
 * Reduce a decoded RGBA Terrarium tile (`size × size`) to `size / blockPx`
 * blocks per side, each holding the min and max land elevation of its pixels.
 */
export function summarizeTerrariumTile(
  rgba: Uint8Array,
  size: number,
  blockPx: number,
): BlockSummary {
  const side = Math.floor(size / blockPx);
  const min = new Int16Array(side * side).fill(32767);
  const max = new Int16Array(side * side).fill(-32768);
  for (let py = 0; py < side * blockPx; py++) {
    const row = Math.floor(py / blockPx) * side;
    for (let px = 0; px < side * blockPx; px++) {
      const o = (py * size + px) * 4;
      const m = clampLand(terrariumMeters(rgba[o] ?? 0, rgba[o + 1] ?? 0, rgba[o + 2] ?? 0));
      const b = row + Math.floor(px / blockPx);
      if (m < (min[b] ?? 32767)) min[b] = m;
      if (m > (max[b] ?? -32768)) max[b] = m;
    }
  }
  return { side, min, max };
}

export interface ReliefStats {
  /** Lowest land elevation over the footprint (m). */
  min: number;
  /** Highest elevation over the footprint (m). */
  max: number;
  /** max − min over the whole footprint (m). */
  relief: number;
  /**
   * The largest relief inside any 3 × 3-block window of the footprint (m) —
   * a scale-free "how steep is it here" that does not grow just because a
   * 1:250 000 sheet spans more ground than a 7.5′ quad.
   */
  localRelief: number;
  /** Blocks sampled. */
  blocks: number;
}

/** Look up a tile's summary (undefined when the tile is missing). */
export type BlockLookup = (x: number, y: number) => BlockSummary | undefined;

/**
 * Relief over a bbox from block summaries at zoom `z`. Blocks whose centre
 * lies inside the bbox are used; a footprint smaller than one block falls back
 * to the blocks it touches. Null when no block could be read.
 */
export function reliefStats(
  bbox: CatalogBbox,
  z: number,
  side: number,
  lookup: BlockLookup,
): ReliefStats | null {
  const scale = side; // blocks per tile side
  const gx0f = lonToTileX(bbox[0], z) * scale;
  const gx1f = lonToTileX(bbox[2], z) * scale;
  const gy0f = latToTileY(bbox[3], z) * scale;
  const gy1f = latToTileY(bbox[1], z) * scale;
  // Blocks whose centre (g + 0.5) is inside [f0, f1).
  let gx0 = Math.ceil(gx0f - 0.5);
  let gx1 = Math.ceil(gx1f - 0.5) - 1;
  let gy0 = Math.ceil(gy0f - 0.5);
  let gy1 = Math.ceil(gy1f - 0.5) - 1;
  if (gx1 < gx0) [gx0, gx1] = [Math.floor(gx0f), Math.floor(gx1f - 1e-9)];
  if (gy1 < gy0) [gy0, gy1] = [Math.floor(gy0f), Math.floor(gy1f - 1e-9)];

  const w = gx1 - gx0 + 1;
  const h = gy1 - gy0 + 1;
  if (w <= 0 || h <= 0) return null;
  const mins = new Float64Array(w * h).fill(NaN);
  const maxs = new Float64Array(w * h).fill(NaN);
  let lo = Infinity;
  let hi = -Infinity;
  let blocks = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = gx0 + i;
      const gy = gy0 + j;
      const tile = lookup(Math.floor(gx / scale), Math.floor(gy / scale));
      if (tile === undefined) continue;
      const b = (gy % scale) * tile.side + (gx % scale);
      const bmin = tile.min[b];
      const bmax = tile.max[b];
      if (bmin === undefined || bmax === undefined || bmax < bmin) continue;
      mins[j * w + i] = bmin;
      maxs[j * w + i] = bmax;
      lo = Math.min(lo, bmin);
      hi = Math.max(hi, bmax);
      blocks += 1;
    }
  }
  if (blocks === 0) return null;

  let localRelief = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let wlo = Infinity;
      let whi = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const a = mins[jj * w + ii] ?? NaN;
          const c = maxs[jj * w + ii] ?? NaN;
          if (Number.isNaN(a) || Number.isNaN(c)) continue;
          wlo = Math.min(wlo, a);
          whi = Math.max(whi, c);
        }
      }
      if (whi >= wlo) localRelief = Math.max(localRelief, whi - wlo);
    }
  }
  return { min: lo, max: hi, relief: hi - lo, localRelief, blocks };
}

/**
 * Mountain thresholds, tuned on known sheets (docs/CATALOG.md §6): at zoom 9
 * with 8-px blocks a 3 × 3 window is ~5–7 km across, so `localRelief` is
 * "vertical metres within a few kilometres".
 */
export const MOUNTAIN_THRESHOLDS = {
  /** Steep ground: this much relief within one ~6 km window. */
  localRelief: 450,
  /** High country: summits this high count if there is real relief too… */
  highMax: 2000,
  /** …at least this much within one window (excludes high flat plateaus). */
  highLocalRelief: 250,
} as const;

export function isMountainous(stats: ReliefStats): boolean {
  const t = MOUNTAIN_THRESHOLDS;
  if (stats.localRelief >= t.localRelief) return true;
  return stats.max >= t.highMax && stats.localRelief >= t.highLocalRelief;
}

/* ------------------------------------------------------- vector overlap --- */

type Point = readonly [number, number];

/** Does segment a→b touch the rectangle? (Liang–Barsky clip.) */
export function segmentIntersectsBbox(a: Point, b: Point, bbox: CatalogBbox): boolean {
  const [west, south, east, north] = bbox;
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: [number, number][] = [
    [-dx, a[0] - west],
    [dx, east - a[0]],
    [-dy, a[1] - south],
    [dy, north - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

/** Even-odd point-in-polygon over all rings (outer + holes). */
export function pointInRings(point: Point, rings: readonly (readonly Point[])[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      if (pi === undefined || pj === undefined) continue;
      if (
        pi[1] > y !== pj[1] > y &&
        x < ((pj[0] - pi[0]) * (y - pi[1])) / (pj[1] - pi[1]) + pi[0]
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** GeoJSON-ish geometry the index accepts (coordinates as [lon, lat]). */
export type IndexGeometry =
  | { type: 'LineString'; coordinates: Point[] }
  | { type: 'MultiLineString'; coordinates: Point[][] }
  | { type: 'Polygon'; coordinates: Point[][] }
  | { type: 'MultiPolygon'; coordinates: Point[][][] };

/**
 * A grid-bucketed index answering "does anything in this layer touch this
 * bbox?". Every segment is filed under each grid cell its own bbox covers;
 * polygons are also filed whole (by bbox) for the interior test — a sheet
 * lying entirely inside a lake or an ice sheet touches no edge at all.
 */
export class GeometryIndex {
  private readonly segments = new Map<number, number[]>();
  private readonly coords: number[] = [];
  private readonly polygons: { bbox: CatalogBbox; rings: Point[][] }[] = [];
  private readonly polygonCells = new Map<number, number[]>();

  constructor(private readonly cellDeg = 0.5) {}

  private cellKey(cx: number, cy: number): number {
    return (cy + 1000) * 10000 + (cx + 1000);
  }

  private cellRange(w: number, s: number, e: number, n: number): [number, number, number, number] {
    return [
      Math.floor(w / this.cellDeg),
      Math.floor(s / this.cellDeg),
      Math.floor(e / this.cellDeg),
      Math.floor(n / this.cellDeg),
    ];
  }

  private addLine(line: readonly Point[]): void {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if (a === undefined || b === undefined) continue;
      const id = this.coords.length / 4;
      this.coords.push(a[0], a[1], b[0], b[1]);
      const [cx0, cy0, cx1, cy1] = this.cellRange(
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      );
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = this.cellKey(cx, cy);
          const bucket = this.segments.get(key);
          if (bucket === undefined) this.segments.set(key, [id]);
          else bucket.push(id);
        }
      }
    }
  }

  private addPolygon(rings: Point[][]): void {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const ring of rings) {
      this.addLine(ring);
      for (const [x, y] of ring) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
    }
    if (!(w < e && s < n)) return;
    const id = this.polygons.length;
    this.polygons.push({ bbox: [w, s, e, n], rings });
    const [cx0, cy0, cx1, cy1] = this.cellRange(w, s, e, n);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = this.cellKey(cx, cy);
        const bucket = this.polygonCells.get(key);
        if (bucket === undefined) this.polygonCells.set(key, [id]);
        else bucket.push(id);
      }
    }
  }

  add(geometry: IndexGeometry): void {
    switch (geometry.type) {
      case 'LineString':
        this.addLine(geometry.coordinates);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates) this.addLine(line);
        break;
      case 'Polygon':
        this.addPolygon(geometry.coordinates);
        break;
      case 'MultiPolygon':
        for (const polygon of geometry.coordinates) this.addPolygon(polygon);
        break;
    }
  }

  /** Does any indexed geometry touch (cross, lie within, or contain) the bbox? */
  intersects(bbox: CatalogBbox): boolean {
    const [cx0, cy0, cx1, cy1] = this.cellRange(bbox[0], bbox[1], bbox[2], bbox[3]);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (const id of this.segments.get(this.cellKey(cx, cy)) ?? []) {
          const o = id * 4;
          const a: Point = [this.coords[o] ?? 0, this.coords[o + 1] ?? 0];
          const b: Point = [this.coords[o + 2] ?? 0, this.coords[o + 3] ?? 0];
          if (segmentIntersectsBbox(a, b, bbox)) return true;
        }
      }
    }
    // No edge touches the bbox: it is wholly inside or wholly outside each
    // polygon, so its centre decides.
    const centre: Point = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const [px, py] = this.cellRange(centre[0], centre[1], centre[0], centre[1]);
    for (const id of this.polygonCells.get(this.cellKey(px, py)) ?? []) {
      const polygon = this.polygons[id];
      if (polygon === undefined) continue;
      const [w, s, e, n] = polygon.bbox;
      if (centre[0] < w || centre[0] > e || centre[1] < s || centre[1] > n) continue;
      if (pointInRings(centre, polygon.rings)) return true;
    }
    return false;
  }
}
