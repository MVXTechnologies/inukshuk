/**
 * The contour tile's hot path, in typed arrays and without the Workers
 * runtime, so jest can test it from the repo root (`contourGrid.test.ts`):
 *
 * - the window of DEM pixels a tile needs, stitched from up to four DEM tiles,
 *   and the corner grid marching squares runs on;
 * - the isoline tracer;
 * - which DEM tiles a request may decode (the CPU budget), and the isolate's
 *   cache of decoded tiles.
 *
 * The grid and the tracer replace maplibre-contour's `HeightTile` chain and
 * `generateIsolines` (BSD-3-Clause, © 2023 Michael Barry and maplibre-contour
 * contributors; its marching-squares cases adapted from d3-contour, ISC,
 * © 2012–2023 Mike Bostock) and produce the same lines, vertex for vertex —
 * `HeightTile` paid a closure call per pixel per stage, and the tracer's
 * `Array.splice(0, 0, …)` made every line grown from its head quadratic. Both
 * were measured as most of a warm tile's CPU (2026-10, the free plan's 1102s).
 */

import type { DemPixels } from './contourMath';

// --- DEM pixel window ----------------------------------------------------------

/** Heights outside this range are no data (maplibre-contour's `defaultIsValid`). */
const MIN_VALID_M = -12_000;
const MAX_VALID_M = 9_000;

/** DEM pixels kept around a tile: the corner grid needs two past each edge. */
export const WINDOW_MARGIN = 2;

/**
 * The DEM pixels under a contour tile plus {@link WINDOW_MARGIN} on each side,
 * row-major; NaN where no DEM tile was copied in (the world's edge, or a
 * neighbour this request could not afford to decode).
 */
export interface PixelWindow {
  /** Pixels across the tile itself. */
  size: number;
  /** `size + 2 × WINDOW_MARGIN`. */
  stride: number;
  data: Float32Array;
}

export function newPixelWindow(size: number): PixelWindow {
  const stride = size + 2 * WINDOW_MARGIN;
  return { size, stride, data: new Float32Array(stride * stride).fill(Number.NaN) };
}

/**
 * Copy the part of a decoded DEM tile that falls in the window. `offX`,
 * `offY` is the DEM tile's top-left pixel in tile pixels (0, 0 = the contour
 * tile's own top-left), so a neighbour to the left has a negative `offX`.
 * Returns how many pixels were copied.
 */
export function copyDemIntoWindow(
  win: PixelWindow,
  dem: DemPixels,
  offX: number,
  offY: number,
): number {
  const lo = -WINDOW_MARGIN;
  const hi = win.size + WINDOW_MARGIN;
  const x0 = Math.max(lo, offX);
  const x1 = Math.min(hi, offX + dem.width);
  const y0 = Math.max(lo, offY);
  const y1 = Math.min(hi, offY + dem.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const src = dem.data;
  const dst = win.data;
  for (let y = y0; y < y1; y++) {
    let s = (y - offY) * dem.width + (x0 - offX);
    let d = (y + WINDOW_MARGIN) * win.stride + (x0 + WINDOW_MARGIN);
    for (let x = x0; x < x1; x++, s++, d++) {
      const v = src[s]!;
      dst[d] = v >= MIN_VALID_M && v <= MAX_VALID_M ? v : Number.NaN;
    }
  }
  return (x1 - x0) * (y1 - y0);
}

/** One DEM tile a contour tile reads, and where it sits in the pixel window. */
export interface DemPart {
  /** `z/x/y` of the DEM tile (x wrapped around the world). */
  key: string;
  z: number;
  x: number;
  y: number;
  /** Where to copy it: see {@link copyDemIntoWindow}. One tile can sit at several (z0–1). */
  offsets: [number, number][];
  /** Pixels of the window it covers — the bigger, the more it matters. */
  area: number;
  /** The DEM tile the contour tile itself lies in. */
  own: boolean;
}

/**
 * The DEM tiles (at `demZ`, `demSize` pixels wide) under contour tile
 * `z/x/y` and its margin: its own first, then the neighbours by how much of
 * the window they fill. Rows past the poles are left out (NaN in the window).
 */
export function demPartsFor(
  z: number,
  x: number,
  y: number,
  demZ: number,
  demSize: number,
): { size: number; parts: DemPart[] } {
  const size = demSize / 2 ** (z - demZ);
  const world = 2 ** demZ;
  const gx0 = x * size - WINDOW_MARGIN;
  const gx1 = (x + 1) * size + WINDOW_MARGIN;
  const gy0 = y * size - WINDOW_MARGIN;
  const gy1 = (y + 1) * size + WINDOW_MARGIN;
  const ownX = Math.floor((x * size) / demSize);
  const ownY = Math.floor((y * size) / demSize);
  const byKey = new Map<string, DemPart>();
  for (let ty = Math.floor(gy0 / demSize); ty <= Math.floor((gy1 - 1) / demSize); ty++) {
    if (ty < 0 || ty >= world) continue;
    for (let tx = Math.floor(gx0 / demSize); tx <= Math.floor((gx1 - 1) / demSize); tx++) {
      const wx = ((tx % world) + world) % world;
      const key = `${demZ}/${wx}/${ty}`;
      const w = Math.min(gx1, (tx + 1) * demSize) - Math.max(gx0, tx * demSize);
      const h = Math.min(gy1, (ty + 1) * demSize) - Math.max(gy0, ty * demSize);
      const offset: [number, number] = [tx * demSize - x * size, ty * demSize - y * size];
      const own = tx === ownX && ty === ownY;
      const part = byKey.get(key);
      if (part) {
        part.offsets.push(offset);
        part.area += w * h;
        part.own ||= own;
      } else {
        byKey.set(key, { key, z: demZ, x: wx, y: ty, offsets: [offset], area: w * h, own });
      }
    }
  }
  const parts = [...byKey.values()].sort(
    (a, b) => Number(b.own) - Number(a.own) || b.area - a.area,
  );
  return { size, parts };
}

/**
 * The grid marching squares runs on: the height at each pixel CORNER — the
 * mean of the (up to) four pixels around it, NaN pixels left out — for
 * corners −1 … size + 1 on both axes (one cell of buffer around the tile).
 * Corner (cx, cy) is at `data[(cy + 1) * stride + cx + 1]`.
 */
export interface CornerGrid {
  /** Corners across the tile itself: `size + 1`. */
  width: number;
  /** `width + 2`. */
  stride: number;
  data: Float32Array;
}

export function cornerGrid(win: PixelWindow): CornerGrid {
  const width = win.size + 1;
  const stride = width + 2;
  const data = new Float32Array(stride * stride);
  const px = win.data;
  const ps = win.stride;
  for (let gy = 0; gy < stride; gy++) {
    // Corner cy = gy − 1 sits between pixel rows cy − 1 and cy: window rows gy, gy + 1.
    const top = gy * ps;
    const bottom = top + ps;
    for (let gx = 0; gx < stride; gx++) {
      // Summed in maplibre-contour's order, so the float results match its.
      const a = px[top + gx]!;
      const b = px[bottom + gx]!;
      const c = px[top + gx + 1]!;
      const d = px[bottom + gx + 1]!;
      let sum = 0;
      let count = 0;
      if (a === a) {
        sum += a;
        count++;
      }
      if (b === b) {
        sum += b;
        count++;
      }
      if (c === c) {
        sum += c;
        count++;
      }
      if (d === d) {
        sum += d;
        count++;
      }
      data[gy * stride + gx] = count === 0 ? Number.NaN : sum / count;
    }
  }
  return { width, stride, data };
}

/** Height change (m) across the grid cell under a point in tile units — the `s` tag's input. */
export function gridGradient(grid: CornerGrid, extent: number): (x: number, y: number) => number {
  const { data, stride, width } = grid;
  const cell = extent / (width - 1);
  const last = width - 2;
  return (x, y) => {
    const gx = Math.min(last, Math.max(0, Math.floor(x / cell)));
    const gy = Math.min(last, Math.max(0, Math.floor(y / cell)));
    const i = (gy + 1) * stride + gx + 1;
    const h = data[i]!;
    return Math.abs(data[i + 1]! - h) + Math.abs(data[i + stride]! - h);
  };
}

// --- Isolines --------------------------------------------------------------------

/**
 * Marching-squares segments per corner case (bit 8 top-left, 4 top-right,
 * 2 bottom-right, 1 bottom-left above the threshold), each `[x, y]` a point
 * of the cell's 3 × 3 lattice: start then end.
 */
const CASES: readonly (readonly number[])[] = [
  [],
  [1, 2, 0, 1],
  [2, 1, 1, 2],
  [2, 1, 0, 1],
  [1, 0, 2, 1],
  [1, 2, 0, 1, 1, 0, 2, 1],
  [1, 0, 1, 2],
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [1, 2, 1, 0],
  [0, 1, 1, 0, 2, 1, 1, 2],
  [2, 1, 1, 0],
  [0, 1, 2, 1],
  [1, 2, 2, 1],
  [0, 1, 1, 2],
  [],
];

/**
 * A line being grown at both ends. Prepending and joining are O(1): the head
 * is kept reversed, and a joined line is chained on rather than copied
 * (maplibre-contour spliced at index 0 and re-pushed every point of the
 * joined line — quadratic on the long lines a tile is mostly made of).
 */
class Fragment {
  /** This piece's prepended points, last first: `[y, x, y, x, …]`. */
  private head: number[] = [];
  private tail: number[] = [];
  /** The piece joined after this one, and the last piece of the chain. */
  private next: Fragment | undefined;
  private last: Fragment = this;
  /** Coordinates in the whole chain. */
  private length = 0;
  /** Joined into another line, or closed and emitted. */
  dead = false;

  constructor(
    /** Lattice index of each end (see `traceIsolines`); −1 once dead. */
    public start: number,
    public end: number,
    /** When its start last moved: open lines are emitted in that order. */
    public order: number,
  ) {}

  append(x: number, y: number): void {
    this.last.tail.push(Math.round(x), Math.round(y));
    this.length += 2;
  }

  prepend(x: number, y: number): void {
    this.head.push(Math.round(y), Math.round(x));
    this.length += 2;
  }

  appendFragment(other: Fragment): void {
    this.last.next = other;
    this.last = other.last;
    this.length += other.length;
    this.end = other.end;
  }

  isEmpty(): boolean {
    return this.length < 2;
  }

  points(): number[] {
    const out = new Array<number>(this.length);
    let o = 0;
    for (let piece: Fragment | undefined = this; piece !== undefined; piece = piece.next) {
      const head = piece.head;
      for (let i = head.length - 1; i >= 0; i--) out[o++] = head[i]!;
      const tail = piece.tail;
      for (let i = 0; i < tail.length; i++) out[o++] = tail[i]!;
    }
    return out;
  }
}

/**
 * One elevation's open line ends on the scan frontier. A crossing on a cell
 * edge is shared with exactly one other cell — the one to the right or the
 * one below — so an end only ever waits in one of two places: the slot of
 * its column (a horizontal edge, read by the cell below) or the single
 * vertical slot (read by the next cell of the row). A slot is live while the
 * line in it still starts or ends at the lattice point asked for.
 * maplibre-contour kept every end in a Map per level instead, and those Map
 * lookups were two thirds of the trace.
 */
interface Level {
  threshold: number;
  /** Lines ending / starting on the horizontal edge under each column. */
  hEnd: (Fragment | undefined)[];
  hStart: (Fragment | undefined)[];
  /** The line ending / starting on the current cell's right edge. */
  vEnd: Fragment | undefined;
  vStart: Fragment | undefined;
  /** Every line begun at this elevation. */
  all: Fragment[];
}

/**
 * Contour lines of a corner grid, every `interval` metres: `{elevation:
 * [[x0, y0, x1, y1, …], …]}` in tile units of `extent`, covering one cell of
 * buffer around the tile. One pass over the grid builds every level's lines
 * at once (maplibre-contour's algorithm and its output, point for point and
 * line for line). Levels at or below `above` are skipped — sea level and
 * bathymetry are never drawn, and tracing them made coastal tiles dear for
 * nothing.
 */
export function traceIsolines(
  grid: CornerGrid,
  interval: number,
  extent: number,
  above = -Infinity,
): Record<string, number[][]> {
  const segments: Record<string, number[][]> = {};
  if (!(interval > 0)) return segments;
  const { data, stride, width } = grid;
  const height = width;
  const multiplier = extent / (width - 1);
  /** Lattice points per row: each cell has 3 × 3, sharing its edges. */
  const lattice = (width + 1) * 2;
  const levels = new Map<number, Level>();
  let clock = 0;
  let tld = 0;
  let trd = 0;
  let bld = 0;
  let brd = 0;
  let r = 0;
  let c = 0;
  // The point of the cell's lattice where the threshold crosses, in tile units.
  let px = 0;
  let py = 0;
  const interpolate = (x: number, y: number, threshold: number): void => {
    if (x === 0) {
      px = multiplier * (c - 1);
      py = multiplier * (r - (threshold - bld) / (tld - bld));
    } else if (x === 2) {
      px = multiplier * c;
      py = multiplier * (r - (threshold - brd) / (trd - brd));
    } else if (y === 0) {
      px = multiplier * (c - (threshold - trd) / (tld - trd));
      py = multiplier * (r - 1);
    } else {
      px = multiplier * (c - (threshold - brd) / (bld - brd));
      py = multiplier * r;
    }
  };

  // One cell of buffer: rows 0 … height, columns 0 … width (as the original
  // does, column 0's cell is degenerate — both its sides read corner 0).
  for (r = 0; r <= height; r++) {
    const top = r * stride + 1; // corner row r − 1
    const bottom = top + stride; // corner row r
    trd = data[top]!;
    brd = data[bottom]!;
    let minR = Math.min(trd, brd);
    let maxR = Math.max(trd, brd);
    for (c = 0; c <= width; c++) {
      tld = trd;
      bld = brd;
      trd = data[top + c]!;
      brd = data[bottom + c]!;
      const minL = minR;
      const maxL = maxR;
      minR = Math.min(trd, brd);
      maxR = Math.max(trd, brd);
      if (tld !== tld || trd !== trd || brd !== brd || bld !== bld) continue;
      const min = Math.min(minL, minR);
      const max = Math.max(maxL, maxR);
      const first = Math.ceil(min / interval) * interval;
      const last = Math.floor(max / interval) * interval;
      for (let threshold = first; threshold <= last; threshold += interval) {
        if (threshold <= above) continue;
        const cell =
          CASES[
            (tld > threshold ? 8 : 0) |
              (trd > threshold ? 4 : 0) |
              (brd > threshold ? 2 : 0) |
              (bld > threshold ? 1 : 0)
          ]!;
        if (cell.length === 0) continue;
        let level = levels.get(threshold);
        if (!level) {
          level = {
            threshold,
            hEnd: new Array<Fragment | undefined>(width + 1).fill(undefined),
            hStart: new Array<Fragment | undefined>(width + 1).fill(undefined),
            vEnd: undefined,
            vStart: undefined,
            all: [],
          };
          levels.set(threshold, level);
        }
        for (let s = 0; s < cell.length; s += 4) {
          const sx = cell[s]!;
          const sy = cell[s + 1]!;
          const ex = cell[s + 2]!;
          const ey = cell[s + 3]!;
          const startIndex = c * 2 + sx + (r * 2 + sy) * lattice;
          const endIndex = c * 2 + ex + (r * 2 + ey) * lattice;
          // The line ending where this segment starts: only the cell above
          // (through the top edge) or the one before (the left edge) left one.
          let f: Fragment | undefined;
          if (sy === 0) {
            f = level.hEnd[c];
            if (f !== undefined && f.end === startIndex) level.hEnd[c] = undefined;
            else f = undefined;
          } else if (sx === 0) {
            f = level.vEnd;
            if (f !== undefined && f.end === startIndex) level.vEnd = undefined;
            else f = undefined;
          }
          // The line starting where this segment ends, likewise.
          let g: Fragment | undefined;
          if (ey === 0) {
            g = level.hStart[c];
            if (g !== undefined && g.start === endIndex) level.hStart[c] = undefined;
            else g = undefined;
          } else if (ex === 0) {
            g = level.vStart;
            if (g !== undefined && g.start === endIndex) level.vStart = undefined;
            else g = undefined;
          }
          if (f !== undefined) {
            if (g === undefined) {
              // Growing f at its end.
              interpolate(ex, ey, threshold);
              f.append(px, py);
              f.end = endIndex;
              if (ey === 2) level.hEnd[c] = f;
              else if (ex === 2) level.vEnd = f;
            } else if (f === g) {
              // Closing a ring.
              interpolate(ex, ey, threshold);
              f.append(px, py);
              f.dead = true;
              f.start = f.end = -1;
              if (!f.isEmpty()) (segments[threshold] ??= []).push(f.points());
            } else {
              // Joining two lines: g's end is f's now, wherever it waits.
              const gEnd = g.end;
              f.appendFragment(g);
              g.dead = true;
              g.start = g.end = -1;
              if (gEnd % 2 === 1) {
                // An odd lattice x: a horizontal edge, in its column's slot.
                const column = ((gEnd % lattice) - 1) / 2;
                if (level.hEnd[column] === g) level.hEnd[column] = f;
              } else if (level.vEnd === g) {
                level.vEnd = f;
              }
            }
          } else if (g !== undefined) {
            // Growing g at its start.
            interpolate(sx, sy, threshold);
            g.prepend(px, py);
            g.start = startIndex;
            g.order = clock++;
            if (sy === 2) level.hStart[c] = g;
            else if (sx === 2) level.vStart = g;
          } else {
            const fresh = new Fragment(startIndex, endIndex, clock++);
            interpolate(sx, sy, threshold);
            fresh.append(px, py);
            interpolate(ex, ey, threshold);
            fresh.append(px, py);
            level.all.push(fresh);
            if (sy === 2) level.hStart[c] = fresh;
            else if (sx === 2) level.vStart = fresh;
            if (ey === 2) level.hEnd[c] = fresh;
            else if (ex === 2) level.vEnd = fresh;
          }
        }
      }
    }
  }
  // The lines left open (they leave the grid), each level's in the order
  // their starts last moved — the order maplibre-contour's Map held them in.
  for (const level of levels.values()) {
    const open = level.all.filter((f) => !f.dead && !f.isEmpty());
    if (open.length === 0) continue;
    open.sort((a, b) => a.order - b.order);
    const list = (segments[level.threshold] ??= []);
    for (const f of open) list.push(f.points());
  }
  return segments;
}

// --- CPU budget --------------------------------------------------------------------

/**
 * DEM tiles one request may fetch and decode itself. Decoding is most of an
 * uncached tile's CPU (≈ 1–1.5 ms a tile on an M-series Mac once the JIT is
 * warm, three times that on a fresh isolate), and a tile needs up to five:
 * its own, three neighbours for a two-pixel border, and its region's for the
 * interval. Five blew the free plan's 10 ms (error 1102, 20–50 % of uncached
 * tiles in northern Québec, whose DEM PNGs are 115–125 KB against 17 KB
 * around Québec City). Past the budget a tile is answered **partial** —
 * without the neighbours it could not afford — and not stored, so a later
 * request (the DEM tiles decoded meanwhile are in the isolate's cache)
 * replaces it with the full one. `CONTOUR_DECODE_BUDGET` (wrangler.toml)
 * overrides it: 9 on the Paid plan makes every tile full on the first request.
 */
export const DEFAULT_DECODE_BUDGET = 2;

/** Where a needed DEM tile stands in the isolate's cache. */
export type DemState = 'ready' | 'pending' | 'absent';

/**
 * Which of the needed DEM tiles (in priority order) this request starts
 * decoding: the first `budget` absent ones. Ready tiles are free and pending
 * ones are another request's work, so neither counts.
 */
export function planDemLoads(states: readonly DemState[], budget: number): boolean[] {
  let left = Math.max(0, Math.floor(budget));
  return states.map((state) => {
    if (state !== 'absent' || left === 0) return false;
    left--;
    return true;
  });
}

/** The budget from the environment: a whole number ≥ 1, else the default. */
export function decodeBudgetFrom(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n >= 1
    ? n
    : DEFAULT_DECODE_BUDGET;
}

interface Slot<T> {
  value?: T;
  pending?: Promise<T>;
  since: number;
}

/**
 * Loaded values kept per isolate (least recently used dropped), plus the
 * loads in flight so concurrent requests share one decode.
 *
 * A load belongs to the request that started it. If that request is
 * cancelled (the phone zoomed away) or killed (CPU limit), its promise never
 * settles — and a cache of promises would then hang every later request for
 * the same tile until the isolate is recycled. So a pending load older than
 * `staleMs` is forgotten, and callers must not wait on {@link pending}
 * without a timeout of their own.
 */
export class LoadCache<T> {
  private readonly slots = new Map<string, Slot<T>>();

  constructor(
    private readonly max: number,
    private readonly staleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.slots.size;
  }

  private slot(key: string): Slot<T> | undefined {
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    if (slot.value === undefined && this.now() - slot.since > this.staleMs) {
      this.slots.delete(key);
      return undefined;
    }
    return slot;
  }

  state(key: string): DemState {
    const slot = this.slot(key);
    if (slot === undefined) return 'absent';
    return slot.value !== undefined ? 'ready' : 'pending';
  }

  /** The loaded value (and marks it recently used). */
  value(key: string): T | undefined {
    const slot = this.slot(key);
    if (slot?.value === undefined) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  /** The load in flight, if any. */
  pending(key: string): Promise<T> | undefined {
    return this.slot(key)?.pending;
  }

  /** Start a load (replacing whatever was there); a failed one is forgotten. */
  start(key: string, load: () => Promise<T>): Promise<T> {
    const slot: Slot<T> = { since: this.now() };
    const pending = load().then(
      (value) => {
        if (this.slots.get(key) === slot) {
          slot.value = value;
          slot.pending = undefined;
        }
        return value;
      },
      (error: unknown) => {
        if (this.slots.get(key) === slot) this.slots.delete(key);
        throw error;
      },
    );
    // Nobody may be waiting any more: never an unhandled rejection.
    pending.catch(() => undefined);
    slot.pending = pending;
    this.slots.delete(key);
    this.slots.set(key, slot);
    while (this.slots.size > this.max) {
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
    return pending;
  }

  clear(): void {
    this.slots.clear();
  }
}
