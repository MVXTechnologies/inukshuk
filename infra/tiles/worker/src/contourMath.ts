/**
 * The pure half of the contour tiles (#509): no Worker or library imports, so
 * jest can test it from the repo root (`contourMath.test.ts`).
 *
 * - which contour interval a tile gets (by zoom, coarser in steep regions),
 * - line clean-up (Douglas–Peucker, tiny closed rings),
 * - a small Mapbox Vector Tile encoder for the result,
 * - a Terrarium PNG decoder that leaves the inflate to the platform's native
 *   DecompressionStream (fast-png's pure-JS inflate was most of a tile's CPU),
 * - an LRU map for the decoded DEM tiles an isolate keeps between requests,
 * - the R2 key the generated tiles are stored under.
 */

/** Deepest zoom we generate (older apps still ask for z14). */
export const CONTOUR_MAX_ZOOM = 14;

/**
 * The app's contour source `maxzoom` (src/features/map/mapStyle.ts): tiles
 * from here down are overzoomed on screen, so they are simplified less.
 */
export const OVERZOOMED_FROM = 13;

/**
 * Bump whenever the generated geometry changes (interval rules, clean-up,
 * encoder): stored tiles live under this prefix, so old ones are never read
 * again (and can be deleted from R2 at leisure).
 */
export const CONTOUR_VERSION = 'v3';

/** Where a generated tile is kept in R2 (gzipped MVT bytes). */
export function contourR2Key(z: number, x: number, y: number): string {
  return `contours/${CONTOUR_VERSION}/${z}/${x}/${y}.mvt`;
}

/** Vector-tile grid size, and the DEM pixels added on each side of a tile. */
export const CONTOUR_EXTENT = 4096;

/** [minor, major] contour interval (m). */
export type ContourLevels = readonly [number, number];

/** [minor, major] contour interval (m) by tile zoom — denser as you zoom in. */
export function contourLevels(z: number): ContourLevels {
  if (z <= 9) return [100, 500];
  if (z === 10) return [50, 250];
  if (z === 11) return [25, 100];
  if (z === 12) return [20, 100];
  return [10, 50];
}

/**
 * Every interval a tile can get, finest first. A steep region steps up this
 * ladder from its zoom's entry until its lines fit the density budget; each
 * major stays a multiple of its minor, so the `level` tag keeps its meaning.
 */
export const LEVEL_LADDER: readonly ContourLevels[] = [
  [10, 50],
  [20, 100],
  [25, 100],
  [50, 250],
  [100, 500],
  [200, 1000],
  [500, 2500],
];

/**
 * Density budget: contour crossings per cell of the tile's 128-cell grid
 * (≈ vertices / 16 384 before simplification) in the steepest tile of the
 * region, as estimated from the region's DEM. 1.25 keeps lines ≥ ~3 px apart
 * on screen. Measured (2026-10, #509) at z10–14: Québec City ≤ 0.75 and the
 * Mont-Sainte-Anne slopes ≤ 1.1 keep their zoom's interval; Zermatt, Chamonix
 * and the Bernese Oberland read 1.6–3.3 (30–55 k vertices, the tiles that hit
 * Cloudflare's CPU limit) and step to a coarser one — z10 200 m, z11 100 m,
 * z12 50 m, z13 20–25 m — which also reads better: 20 m lines on a z12
 * Matterhorn were a solid smear of ink.
 */
export const MAX_CROSSINGS_PER_CELL = 1.25;

/**
 * The density decision is made on the DEM tile this many zooms above the one
 * the tile's grid is cut from — one shared by 4 × 4 contour tiles (and the
 * grid of the zoom above, so usually decoded already) — not per tile:
 * neighbours share one interval, so a seam where it changes only falls on
 * that 4-tile grid, between a massif and its foothills.
 */
export const DENSITY_REGION_ZOOMS = 1;

/**
 * The interval for a tile whose region's steepest tile climbs `cellRelief`
 * metres per grid cell: its zoom's entry, stepped coarser until the expected
 * crossings per cell fit {@link MAX_CROSSINGS_PER_CELL}.
 */
export function adaptiveLevels(z: number, cellRelief: number): ContourLevels {
  const base = contourLevels(z);
  let i = LEVEL_LADDER.findIndex(([minor, major]) => minor === base[0] && major === base[1]);
  if (i < 0 || !Number.isFinite(cellRelief) || cellRelief <= 0) return base;
  while (i < LEVEL_LADDER.length - 1) {
    const step = LEVEL_LADDER[i];
    if (step === undefined || cellRelief / step[0] <= MAX_CROSSINGS_PER_CELL) break;
    i++;
  }
  return LEVEL_LADDER[i] ?? base;
}

/**
 * The steepest of a DEM tile's `blocks` × `blocks` blocks (one per contour
 * tile of the region): its mean relief per pixel. The region's interval is set
 * by its steepest tile, so no tile in it blows the budget — a lake or a valley
 * floor in the region can't average a massif's density away.
 */
export function steepestBlockRelief(
  data: Float32Array,
  width: number,
  height: number,
  blocks: number,
): number {
  const bw = Math.max(1, Math.floor(width / blocks));
  const bh = Math.max(1, Math.floor(height / blocks));
  let worst = 0;
  for (let by = 0; by + bh <= height; by += bh) {
    for (let bx = 0; bx + bw <= width; bx += bw) {
      const r = meanPixelRelief(data, width, height, bx, by, bw, bh);
      if (r > worst) worst = r;
    }
  }
  return worst;
}

/**
 * Mean |Δh| between horizontally and vertically adjacent pixels (m), over the
 * valid pixels of a decoded DEM tile (or the `w` × `h` window at `x0`, `y0`)
 * — how many metres the ground climbs per pixel on average. NaN pixels are
 * skipped.
 */
export function meanPixelRelief(
  data: Float32Array,
  width: number,
  height: number,
  x0 = 0,
  y0 = 0,
  w = width - x0,
  h = height - y0,
): number {
  let sum = 0;
  let n = 0;
  const xEnd = Math.min(width, x0 + w);
  const yEnd = Math.min(height, y0 + h);
  for (let y = y0; y < yEnd; y++) {
    const row = y * width;
    for (let x = x0; x < xEnd; x++) {
      const v = data[row + x]!;
      if (Number.isNaN(v)) continue;
      if (x + 1 < width) {
        const r = data[row + x + 1]!;
        if (!Number.isNaN(r)) {
          sum += Math.abs(r - v);
          n++;
        }
      }
      if (y + 1 < height) {
        const d = data[row + width + x]!;
        if (!Number.isNaN(d)) {
          sum += Math.abs(d - v);
          n++;
        }
      }
    }
  }
  // |dx| + |dy| per pixel ≈ the height range a marching-squares cell spans.
  return n === 0 ? 0 : (2 * sum) / n;
}

/**
 * The region relief measured on a DEM tile at `regionZoom`, scaled to one
 * cell of a contour grid built from DEM tiles at `gridZoom` (a pixel there is
 * 2^(gridZoom − regionZoom) times narrower, so it climbs that much less).
 */
export function cellReliefAt(regionRelief: number, regionZoom: number, gridZoom: number): number {
  return regionRelief / 2 ** Math.max(0, gridZoom - regionZoom);
}

/**
 * Douglas–Peucker tolerance (tile units of a 4096 extent; a 512 px tile is
 * 8 units per pixel). Half a pixel where the tile is shown at its own zoom;
 * a quarter at the deepest zoom, which the map keeps overzooming past.
 */
export function simplifyTolerance(z: number, maxZoom: number): number {
  return z >= maxZoom ? 2 : 4;
}

/**
 * Closed rings smaller than this (tile units, bbox side) are dropped: a one-
 * or two-pixel bump of the DEM, unreadable as a contour at any zoom we draw.
 */
export function tinyRingSpan(gridCells: number, extent = CONTOUR_EXTENT): number {
  return (extent / gridCells) * 1.5;
}

/** Douglas–Peucker on a flat `[x0, y0, x1, y1, …]` line; endpoints always stay. */
export function simplifyLine(line: readonly number[], tolerance: number): number[] {
  const n = line.length / 2;
  if (n <= 2 || tolerance <= 0) return line.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const ax = line[first * 2]!;
    const ay = line[first * 2 + 1]!;
    const bx = line[last * 2]!;
    const by = line[last * 2 + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol2;
    for (let i = first + 1; i < last; i++) {
      const px = line[i * 2]! - ax;
      const py = line[i * 2 + 1]! - ay;
      let d: number;
      if (len2 === 0) {
        d = px * px + py * py;
      } else {
        // Distance to the segment (a ring's chord has length 0 at the start).
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(line[i * 2]!, line[i * 2 + 1]!);
  }
  return out;
}

/** A closed ring (first point = last) whose bounding box is under `span` on both sides. */
export function isTinyRing(line: readonly number[], span: number): boolean {
  const n = line.length;
  if (n < 4) return true;
  if (line[0] !== line[n - 2] || line[1] !== line[n - 1]) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 2) {
    const x = line[i]!;
    const y = line[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX - minX < span && maxY - minY < span;
}

export interface ContourFeature {
  ele: number;
  level: number;
  /**
   * Coarsening (#509): how many lines of the zoom's own interval each line of
   * this tile stands for — 1 where adaptiveLevels kept the interval.
   */
  k?: number;
  /**
   * Steepness class 0–3 of this stretch of line (always 0 when k = 1): how
   * dense the zoom's own interval would have been there — see
   * {@link slopeClass}. Lines are cut where it changes, and the style thickens
   * and darkens the steep stretches, so a wall that used to be a dark band of
   * 20 m lines still reads dark with 50 m ones while the slopes around it
   * stay light.
   */
  s?: number;
  lines: number[][];
}

/** The highest steepness class. */
export const MAX_SLOPE_CLASS = 3;

/**
 * Steepness class from the crossings per grid cell the zoom's own interval
 * would have had there (a cell is ~4 px on screen at the tile's zoom; the old
 * lines merged into a solid band from ~2). Measured in the Alps at z10–13,
 * the stretches of line spread over ~1–5: 0 under 1.5, 1 under 2.5, 2 under
 * 3.5, 3 beyond — the cliffs and walls.
 */
export function slopeClass(crossingsPerCell: number): number {
  if (!(crossingsPerCell >= 1.5)) return 0;
  if (crossingsPerCell < 2.5) return 1;
  if (crossingsPerCell < 3.5) return 2;
  return MAX_SLOPE_CLASS;
}

/** How many of the zoom's `baseMinor` lines one `minor` line stands for (≥ 1). */
export function coarsening(minor: number, baseMinor: number): number {
  return Math.max(1, Math.round(minor / baseMinor));
}

/** Vertices each side averaged into a vertex's steepness (smooths cell noise). */
const SLOPE_WINDOW = 3;
/** Shortest stretch (vertices, ≈ grid cells) kept as its own class. */
export const MIN_SLOPE_RUN = 6;

/**
 * Cut a raw isoline into stretches of one steepness class each: the class
 * of each vertex from the (windowed) `gradientAt` / `baseMinor`, stretches
 * shorter than {@link MIN_SLOPE_RUN} folded into the one before. Neighbouring
 * stretches share their joining vertex, so the line stays continuous.
 */
export function splitBySlope(
  line: readonly number[],
  gradientAt: (x: number, y: number) => number,
  baseMinor: number,
): { s: number; line: number[] }[] {
  const n = line.length / 2;
  if (n < 2) return [{ s: 0, line: line.slice() }];
  // Prefix sums of the gradient for the windowed mean.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const g = gradientAt(line[i * 2]!, line[i * 2 + 1]!);
    prefix[i + 1] = prefix[i]! + (Number.isFinite(g) ? g : 0);
  }
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - SLOPE_WINDOW);
    const hi = Math.min(n, i + SLOPE_WINDOW + 1);
    cls[i] = slopeClass((prefix[hi]! - prefix[lo]!) / (hi - lo) / baseMinor);
  }
  // Runs of one class: [start, end) vertex ranges.
  const runs: { s: number; start: number; end: number }[] = [];
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && cls[j] === cls[i]) j++;
    const prev = runs[runs.length - 1];
    if (prev && (j - i < MIN_SLOPE_RUN || prev.s === cls[i])) prev.end = j;
    else runs.push({ s: cls[i]!, start: i, end: j });
    i = j;
  }
  // A short first run folds into the next one.
  const first = runs[0];
  const second = runs[1];
  if (first && second && first.end - first.start < MIN_SLOPE_RUN) {
    second.start = first.start;
    runs.shift();
  }
  return runs.map(({ s, start, end }) => ({
    s,
    // Each stretch runs on to the next one's first vertex.
    line: line.slice(start * 2, Math.min(n, end + 1) * 2),
  }));
}

export interface CleanOptions {
  levels: ContourLevels;
  tolerance: number;
  tinySpan: number;
  /** The zoom's own minor interval (contourLevels): sets `k`, and with it `s`. */
  baseMinor?: number;
  /** Height change (m) per grid cell at a point in tile units: sets `s`. */
  gradientAt?: (x: number, y: number) => number;
}

/**
 * From generateIsolines' `{ele: lines}` to the features we encode: sea level
 * and below dropped (the style never draws them, and Terrarium's bathymetry
 * made coastal tiles heavy for nothing), tiny rings dropped, lines simplified,
 * `level` = 1 on major lines. With `baseMinor`, every feature carries `k` and
 * `s`; where the tile was coarsened (k > 1) and `gradientAt` is given, lines
 * are cut into stretches by steepness, one feature per elevation and class.
 */
export function cleanIsolines(
  isolines: Record<string, number[][]>,
  { levels, tolerance, tinySpan, baseMinor, gradientAt }: CleanOptions,
): ContourFeature[] {
  const k = baseMinor === undefined ? undefined : coarsening(levels[0], baseMinor);
  const out: ContourFeature[] = [];
  for (const [key, raw] of Object.entries(isolines)) {
    const ele = Number(key);
    if (!(ele > 0)) continue;
    const level = ele % levels[1] === 0 ? 1 : 0;
    const byClass = new Map<number, number[][]>();
    const add = (s: number, part: readonly number[]) => {
      const simple = simplifyLine(part, tolerance);
      if (simple.length < 4) return;
      const group = byClass.get(s);
      if (group) group.push(simple);
      else byClass.set(s, [simple]);
    };
    for (const line of raw) {
      if (isTinyRing(line, tinySpan)) continue;
      if (k !== undefined && k > 1 && gradientAt && baseMinor) {
        // Measured on the raw line: its vertices sit on the grid cells it crosses.
        for (const part of splitBySlope(line, gradientAt, baseMinor)) add(part.s, part.line);
      } else {
        add(0, line);
      }
    }
    for (const [s, lines] of [...byClass].sort((a, b) => a[0] - b[0])) {
      out.push(k === undefined ? { ele, level, lines } : { ele, level, k, s, lines });
    }
  }
  return out;
}

// --- Mapbox Vector Tile encoding -------------------------------------------

class Writer {
  private buf = new Uint8Array(4096);
  pos = 0;

  private grow(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  varint(v: number): void {
    this.grow(10);
    let n = v >>> 0 === v ? v : Math.max(0, Math.floor(v));
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }

  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  bytes(field: number, data: Uint8Array): void {
    this.tag(field, 2);
    this.varint(data.length);
    this.grow(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  string(field: number, s: string): void {
    this.bytes(field, new TextEncoder().encode(s));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

const zigzag = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);

function encodeValue(v: number): Uint8Array {
  const w = new Writer();
  if (Number.isInteger(v)) {
    if (v >= 0) {
      w.tag(5, 0); // uint_value
      w.varint(v);
    } else {
      w.tag(6, 0); // sint_value
      w.varint(zigzag(v));
    }
  } else {
    w.tag(3, 1); // double_value
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return new Uint8Array([...w.finish(), ...b]);
  }
  return w.finish();
}

/**
 * One layer of LineString features (a MultiLineString per elevation, or per
 * elevation and steepness class), properties `{eleKey: ele, levelKey: level}`
 * plus `k` and `s` when set, coordinates rounded to the grid.
 */
export function encodeContourMvt(
  features: readonly ContourFeature[],
  {
    layer = 'contours',
    extent = CONTOUR_EXTENT,
    eleKey = 'ele',
    levelKey = 'level',
  }: { layer?: string; extent?: number; eleKey?: string; levelKey?: string } = {},
): Uint8Array {
  const values: number[] = [];
  const valueIndex = new Map<number, number>();
  const indexOf = (v: number): number => {
    let i = valueIndex.get(v);
    if (i === undefined) {
      i = values.length;
      values.push(v);
      valueIndex.set(v, i);
    }
    return i;
  };

  const layerW = new Writer();
  layerW.tag(15, 0); // version 2
  layerW.varint(2);
  layerW.string(1, layer);
  for (const f of features) {
    const geom: number[] = [];
    let cx = 0;
    let cy = 0;
    for (const line of f.lines) {
      const pts: number[] = [];
      for (let i = 0; i < line.length; i += 2) {
        const x = Math.round(line[i]!);
        const y = Math.round(line[i + 1]!);
        const n = pts.length;
        if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) continue;
        pts.push(x, y);
      }
      if (pts.length < 4) continue;
      geom.push((1 << 3) | 1); // MoveTo ×1
      geom.push(zigzag(pts[0]! - cx), zigzag(pts[1]! - cy));
      cx = pts[0]!;
      cy = pts[1]!;
      geom.push(((pts.length / 2 - 1) << 3) | 2); // LineTo ×(n − 1)
      for (let i = 2; i < pts.length; i += 2) {
        geom.push(zigzag(pts[i]! - cx), zigzag(pts[i + 1]! - cy));
        cx = pts[i]!;
        cy = pts[i + 1]!;
      }
    }
    if (geom.length === 0) continue;
    const fw = new Writer();
    const tags = new Writer();
    tags.varint(0);
    tags.varint(indexOf(f.ele));
    tags.varint(1);
    tags.varint(indexOf(f.level));
    if (f.k !== undefined) {
      tags.varint(2);
      tags.varint(indexOf(f.k));
    }
    if (f.s !== undefined) {
      tags.varint(3);
      tags.varint(indexOf(f.s));
    }
    fw.bytes(2, tags.finish()); // packed tags
    fw.tag(3, 0); // type LINESTRING
    fw.varint(2);
    const g = new Writer();
    for (const v of geom) g.varint(v);
    fw.bytes(4, g.finish()); // packed geometry
    layerW.bytes(2, fw.finish());
  }
  // Keys by index: 0 ele, 1 level, 2 k, 3 s (unused keys cost a few bytes).
  layerW.string(3, eleKey);
  layerW.string(3, levelKey);
  layerW.string(3, 'k');
  layerW.string(3, 's');
  for (const v of values) layerW.bytes(4, encodeValue(v));
  layerW.tag(5, 0);
  layerW.varint(extent);

  const tile = new Writer();
  tile.bytes(3, layerW.finish());
  return tile.finish();
}

// --- Terrarium PNG -----------------------------------------------------------

export interface DemPixels {
  width: number;
  height: number;
  /** Elevation (m), row-major. */
  data: Float32Array;
}

/** Thrown for PNG flavours the fast path doesn't handle (caller falls back). */
export class UnsupportedPng extends Error {}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Decode an 8-bit RGB/RGBA, non-interlaced Terrarium PNG into elevations,
 * with the zlib inflate supplied by the caller (native DecompressionStream in
 * the Worker, node:zlib in tests). Heights below `floor` are clamped to it.
 */
export async function decodeTerrariumPng(
  bytes: Uint8Array,
  inflate: (zlib: Uint8Array) => Promise<Uint8Array>,
  floor = -Infinity,
): Promise<DemPixels> {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new UnsupportedPng('not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat: Uint8Array[] = [];
  let idatLength = 0;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(
      bytes[pos + 4]!,
      bytes[pos + 5]!,
      bytes[pos + 6]!,
      bytes[pos + 7]!,
    );
    const start = pos + 8;
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const color = bytes[start + 9];
      const interlace = bytes[start + 12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new UnsupportedPng(`png depth ${depth} color ${color} interlace ${interlace}`);
      }
      bpp = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length));
      idatLength += length;
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4; // + CRC
  }
  if (bpp === 0 || idat.length === 0) throw new UnsupportedPng('png without IHDR/IDAT');
  const compressed = idat.length === 1 ? idat[0]! : new Uint8Array(idatLength);
  if (idat.length > 1) {
    let o = 0;
    for (const part of idat) {
      compressed.set(part, o);
      o += part.length;
    }
  }
  const raw = await inflate(compressed);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new UnsupportedPng('short png data');

  const data = new Float32Array(width * height);
  // Unfiltered in place, row by row, one tight loop per filter type (a
  // per-byte switch cost more than the native inflate itself).
  const px = raw;
  for (let y = 0; y < height; y++) {
    const s = y * (stride + 1) + 1; // this row's first byte
    const u = s - stride - 1; // the row above's (garbage when y = 0)
    const filter = px[s - 1];
    if (filter === 1) {
      for (let i = s + bpp; i < s + stride; i++) px[i] = (px[i]! + px[i - bpp]!) & 255;
    } else if (filter === 2) {
      if (y > 0) for (let i = 0; i < stride; i++) px[s + i] = (px[s + i]! + px[u + i]!) & 255;
    } else if (filter === 3) {
      if (y === 0) {
        for (let i = bpp; i < stride; i++) px[s + i] = (px[s + i]! + (px[s + i - bpp]! >> 1)) & 255;
      } else {
        for (let i = 0; i < bpp; i++) px[s + i] = (px[s + i]! + (px[u + i]! >> 1)) & 255;
        for (let i = bpp; i < stride; i++) {
          px[s + i] = (px[s + i]! + ((px[s + i - bpp]! + px[u + i]!) >> 1)) & 255;
        }
      }
    } else if (filter === 4) {
      if (y === 0) {
        // Paeth with no row above is Sub.
        for (let i = s + bpp; i < s + stride; i++) px[i] = (px[i]! + px[i - bpp]!) & 255;
      } else {
        for (let i = 0; i < bpp; i++) px[s + i] = (px[s + i]! + px[u + i]!) & 255;
        for (let i = bpp; i < stride; i++) {
          const a = px[s + i - bpp]!;
          const b = px[u + i]!;
          const c = px[u + i - bpp]!;
          const pa = b > c ? b - c : c - b;
          const pb = a > c ? a - c : c - a;
          const pc0 = a + b - c - c;
          const pc = pc0 < 0 ? -pc0 : pc0;
          px[s + i] = (px[s + i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
      }
    } else if (filter !== 0) {
      throw new UnsupportedPng(`png filter ${filter}`);
    }
    const row = y * width;
    for (let x = 0, o = s; x < width; x++, o += bpp) {
      const h = px[o]! * 256 + px[o + 1]! + px[o + 2]! / 256 - 32768;
      data[row + x] = h < floor ? floor : h;
    }
  }
  return { width, height, data };
}

// --- Isolate cache -----------------------------------------------------------

/** A size-capped map that forgets the least recently used entry. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
