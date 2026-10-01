/**
 * On-disk formats of the stored heatmap (#500):
 *
 * - **Tile grid** (binary, varints): every slot's contribution inside one
 *   tile. Cells are delta-coded (sorted), offsets and steps take a byte or
 *   two each, so a trail costs a few bytes per 20 m cell it visits.
 * - **Tile render** (compact JSON): the tile's pass-count lines and glow
 *   points as integer coordinates.
 * - **Manifest** (JSON): format/grid parameters, every stored trail (slot,
 *   revision hash, tiles) and every tile's revision. Anything that does not
 *   parse as the current version reads as "no manifest" → rebuild.
 *
 * Every decoder returns null on a short, corrupt or foreign file — never a
 * partial result.
 *
 * Pure.
 */

import type { Feature, MultiLineString, Point } from 'geojson';

import type { HeatGlowProps, HeatLineProps } from './heatGrid';
import {
  parseTileKey,
  TileGrid,
  type TileContribution,
  type TileKey,
  type TileRender,
} from './heatTiles';

/**
 * Bump when anything stored changes meaning (grid, tiling, encodings,
 * derivation): an older store is then rebuilt from scratch.
 */
export const HEAT_STORE_VERSION = 1;

// ---- varints ---------------------------------------------------------------------

/** Growable byte buffer with LEB128 varints (arithmetic, safe past 2^31). */
export class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  uint(v: number): void {
    this.ensure(8);
    let x = Math.max(0, Math.floor(v));
    while (x >= 0x80) {
      this.buf[this.len++] = (x % 0x80) | 0x80;
      x = Math.floor(x / 0x80);
    }
    this.buf[this.len++] = x;
  }
  /** Zig-zag signed varint. */
  sint(v: number): void {
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Truncated extends Error {}

export class ByteReader {
  private at = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.at >= this.buf.length;
  }
  byte(): number {
    if (this.at >= this.buf.length) throw new Truncated();
    return this.buf[this.at++] as number;
  }
  uint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 0x80;
    }
    throw new Truncated();
  }
  sint(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
}

// ---- tile grid ----------------------------------------------------------------------

const GRID_MAGIC = [0x48, 0x47]; // "HG"
/** Bounds on decoded counts: a corrupt length never allocates the world. */
const MAX_CELLS_PER_SLOT = 1_000_000;

/** A tile's grid as bytes (slots ascending), stamped with its revision. */
export function encodeTileGrid(tile: TileGrid, rev: number): Uint8Array {
  const w = new ByteWriter();
  for (const b of GRID_MAGIC) w.byte(b);
  w.uint(HEAT_STORE_VERSION);
  w.uint(rev);
  const slots = [...tile.slots.keys()].sort((a, b) => a - b);
  w.uint(slots.length);
  for (const slot of slots) {
    const c = tile.slots.get(slot) as TileContribution;
    const n = c.cells.length;
    w.uint(slot);
    w.uint(n);
    w.uint(c.extra.length / 2);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const cell = c.cells[i] as number;
      if (i === 0) w.sint(cell);
      else w.uint(cell - prev);
      prev = cell;
    }
    for (let i = 0; i < n; i++) w.sint(c.dx[i] as number);
    for (let i = 0; i < n; i++) w.sint(c.dy[i] as number);
    for (let i = 0; i < n; i++) w.byte(c.mask[i] as number);
    for (let i = 0; i + 1 < c.extra.length; i += 2) {
      const a = c.extra[i] as number;
      w.sint(a);
      w.sint((c.extra[i + 1] as number) - a);
    }
  }
  return w.bytes();
}

/** Decode {@link encodeTileGrid}'s bytes; null when corrupt or of another version. */
export function decodeTileGrid(bytes: Uint8Array): { rev: number; tile: TileGrid } | null {
  try {
    const r = new ByteReader(bytes);
    for (const b of GRID_MAGIC) if (r.byte() !== b) return null;
    if (r.uint() !== HEAT_STORE_VERSION) return null;
    const rev = r.uint();
    const count = r.uint();
    const tile = new TileGrid();
    for (let s = 0; s < count; s++) {
      const slot = r.uint();
      const n = r.uint();
      const extraN = r.uint();
      if (n > MAX_CELLS_PER_SLOT || extraN > MAX_CELLS_PER_SLOT * 4) return null;
      const cells = new Float64Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        prev = i === 0 ? r.sint() : prev + r.uint();
        cells[i] = prev;
      }
      const dx = new Int32Array(n);
      const dy = new Int32Array(n);
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) dx[i] = r.sint();
      for (let i = 0; i < n; i++) dy[i] = r.sint();
      for (let i = 0; i < n; i++) mask[i] = r.byte();
      const extra = new Float64Array(extraN * 2);
      for (let i = 0; i < extraN; i++) {
        const a = r.sint();
        extra[2 * i] = a;
        extra[2 * i + 1] = a + r.sint();
      }
      tile.slots.set(slot, { cells, dx, dy, mask, extra });
    }
    if (!r.done) return null;
    return { rev, tile };
  } catch {
    return null;
  }
}

// ---- tile render -----------------------------------------------------------------------

const LINE_SCALE = 1e5;
const GLOW_SCALE = 1e6;

/** A tile's render pieces as compact JSON (integer coordinates). */
export function encodeTileRender(render: TileRender, rev: number): string {
  const l = render.lines.features.map((f) => [
    f.properties.count,
    f.geometry.coordinates.map((line) => {
      const flat: number[] = [];
      for (const p of line)
        flat.push(Math.round((p[0] ?? 0) * LINE_SCALE), Math.round((p[1] ?? 0) * LINE_SCALE));
      return flat;
    }),
  ]);
  const g: number[] = [];
  for (const f of render.glow.features) {
    const [lng, lat] = f.geometry.coordinates;
    g.push(
      Math.round((lng ?? 0) * GLOW_SCALE),
      Math.round((lat ?? 0) * GLOW_SCALE),
      f.properties.count,
    );
  }
  return JSON.stringify({ v: HEAT_STORE_VERSION, rev, l, g });
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/** Decode {@link encodeTileRender}'s text; null when corrupt or of another version. */
export function decodeTileRender(text: string): { rev: number; render: TileRender } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const { v, rev, l, g } = doc as { v?: unknown; rev?: unknown; l?: unknown; g?: unknown };
  if (v !== HEAT_STORE_VERSION || !isInt(rev) || !Array.isArray(l) || !Array.isArray(g))
    return null;
  if (g.length % 3 !== 0) return null;
  const lineFeatures: Feature<MultiLineString, HeatLineProps>[] = [];
  for (const bucket of l) {
    if (!Array.isArray(bucket) || !isInt(bucket[0]) || !Array.isArray(bucket[1])) return null;
    const coordinates: [number, number][][] = [];
    for (const flat of bucket[1] as unknown[]) {
      if (!Array.isArray(flat) || flat.length % 2 !== 0) return null;
      const line: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i];
        const y = flat[i + 1];
        if (!isInt(x) || !isInt(y)) return null;
        line.push([x / LINE_SCALE, y / LINE_SCALE]);
      }
      coordinates.push(line);
    }
    lineFeatures.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates },
      properties: { count: bucket[0] },
    });
  }
  const glowFeatures: Feature<Point, HeatGlowProps>[] = [];
  for (let i = 0; i < g.length; i += 3) {
    const x = g[i];
    const y = g[i + 1];
    const count = g[i + 2];
    if (!isInt(x) || !isInt(y) || !isInt(count)) return null;
    glowFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [x / GLOW_SCALE, y / GLOW_SCALE] },
      properties: { count },
    });
  }
  return {
    rev,
    render: {
      lines: { type: 'FeatureCollection', features: lineFeatures },
      glow: { type: 'FeatureCollection', features: glowFeatures },
    },
  };
}

// ---- manifest --------------------------------------------------------------------------

/** One stored trail. */
export interface ManifestTrack {
  /** Its number inside tile grids. */
  slot: number;
  /** Revision hash of the geometry it was stored from (see {@link hashText}). */
  hash: string;
  /** Tiles holding its contribution (empty: nothing drawable). */
  tiles: TileKey[];
}

/** What the store holds. */
export interface HeatManifest {
  version: number;
  cellM: number;
  tileDeg: number;
  /** Next unused slot (slots are never reused within a store). */
  nextSlot: number;
  tracks: Map<string, ManifestTrack>;
  /** tile → revision (bumped on every write of that tile). */
  tiles: Map<TileKey, number>;
}

/** An empty store for these grid parameters. */
export function emptyManifest(cellM: number, tileDeg: number): HeatManifest {
  return {
    version: HEAT_STORE_VERSION,
    cellM,
    tileDeg,
    nextSlot: 0,
    tracks: new Map(),
    tiles: new Map(),
  };
}

export function serializeManifest(m: HeatManifest): string {
  const tracks: Record<string, [number, string, TileKey[]]> = {};
  for (const [id, t] of m.tracks) tracks[id] = [t.slot, t.hash, t.tiles];
  const tiles: Record<TileKey, number> = {};
  for (const [k, rev] of m.tiles) tiles[k] = rev;
  return JSON.stringify({
    v: m.version,
    cellM: m.cellM,
    tileDeg: m.tileDeg,
    nextSlot: m.nextSlot,
    tracks,
    tiles,
  });
}

/**
 * The manifest in `text`, or null when it is missing, corrupt, inconsistent,
 * of another version or for other grid parameters — every case in which
 * the store must be rebuilt.
 */
export function parseManifest(
  text: string | null,
  cellM: number,
  tileDeg: number,
): HeatManifest | null {
  if (text === null) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  if (d.v !== HEAT_STORE_VERSION || d.cellM !== cellM || d.tileDeg !== tileDeg) return null;
  if (!isInt(d.nextSlot) || d.nextSlot < 0) return null;
  if (!d.tracks || typeof d.tracks !== 'object' || !d.tiles || typeof d.tiles !== 'object')
    return null;
  const tiles = new Map<TileKey, number>();
  for (const [k, rev] of Object.entries(d.tiles as Record<string, unknown>)) {
    if (!parseTileKey(k) || !isInt(rev)) return null;
    tiles.set(k, rev);
  }
  const tracks = new Map<string, ManifestTrack>();
  const slots = new Set<number>();
  for (const [id, entry] of Object.entries(d.tracks as Record<string, unknown>)) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [slot, hash, list] = entry as unknown[];
    if (!isInt(slot) || slot < 0 || slot >= d.nextSlot || slots.has(slot)) return null;
    if (typeof hash !== 'string' || !Array.isArray(list)) return null;
    for (const k of list) if (typeof k !== 'string' || !tiles.has(k)) return null;
    slots.add(slot);
    tracks.set(id, { slot, hash, tiles: list as TileKey[] });
  }
  return { version: HEAT_STORE_VERSION, cellM, tileDeg, nextSlot: d.nextSlot, tracks, tiles };
}

/** FNV-1a (32-bit) of `text`, as 8 hex digits: a trail revision's fingerprint. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
