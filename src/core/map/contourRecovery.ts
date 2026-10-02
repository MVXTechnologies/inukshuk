/**
 * Recovering contour tiles the map failed to load (2026-10: "some chunks are
 * not loading").
 *
 * Our contour tiles are generated on demand by a Cloudflare Worker, and an
 * uncached tile can die with HTTP 503 (error 1102, the free plan's CPU
 * limit). MapLibre Native does have a retry for 5xx (1 s three times, then
 * exponential back-off), but since maplibre-native #2051 (Android 11 /
 * iOS 6, Feb 2024) the tile loader frees its request as soon as the first
 * answer arrives, and the retry timer dies with it. A failed tile is then
 * asked for again only when it stops being needed and is needed again — the
 * user pans away and back. Until then it is a hole in the lines.
 *
 * MapLibre React Native reports no tile errors, so the map screen looks for
 * the holes itself once the camera settles (`useContourRecovery`): a visible
 * contour tile that draws nothing is fetched from JS — at most
 * {@link MAX_FETCH_TRIES} times, {@link RETRY_DELAYS_MS} apart — and when the
 * answer has lines that should be on screen, the map is nudged to load its
 * tiles again. Everything that decides is here, pure.
 */

/** A tile of the contour source. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

export function tileKey({ z, x, y }: TileId): string {
  return `${z}/${x}/${y}`;
}

/**
 * Camera zoom from which recovery runs: where the style draws every line a
 * tile carries (the minor lines start at z10), so "this tile has lines here
 * and the map shows none" can only be a tile that failed to load. Below it a
 * loaded tile may legitimately draw nothing (majors only).
 */
export const RECOVERY_MIN_ZOOM = 10;

/** Past this many tiles in view (a tilted map), recovery sits the settle out. */
export const MAX_TILES_IN_VIEW = 30;

/** Tiles looked at, and fetched, per pass: a pass must stay light. */
export const MAX_CHECKS_PER_PASS = 16;
export const MAX_FETCHES_PER_PASS = 6;

/** Fetches of one tile before giving up on it for the session. */
export const MAX_FETCH_TRIES = 3;
const LAST_RETRY_DELAY_MS = 6000;
/** Wait before the second and the third fetch of a tile. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, LAST_RETRY_DELAY_MS];
/** Times the map is asked to reload for one tile, and the pause between asks. */
export const MAX_NUDGES_PER_TILE = 2;
export const MIN_NUDGE_INTERVAL_MS = 5000;

/**
 * The zoom of the tiles a vector source shows at a camera zoom (512-px tiles:
 * the integer part), kept inside the source's own range; null below it —
 * nothing is loaded there.
 */
export function sourceTileZoom(
  cameraZoom: number,
  minzoom: number,
  maxzoom: number,
): number | null {
  if (!Number.isFinite(cameraZoom) || cameraZoom < minzoom) return null;
  return Math.min(maxzoom, Math.floor(cameraZoom));
}

const MAX_LAT = 85.0511287798066;

function tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function tileY(lat: number, z: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const r = (clamped * Math.PI) / 180;
  const n = 2 ** z;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return Math.max(0, Math.min(n - 1, y));
}

/**
 * The tiles of zoom `z` under `[west, south, east, north]`, row by row —
 * empty when there would be more than `limit` (or the bounds make no sense,
 * as across the antimeridian: recovery is a nicety, it can skip a view).
 */
export function tilesInBounds(
  bounds: readonly [number, number, number, number],
  z: number,
  limit = MAX_TILES_IN_VIEW,
): TileId[] {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
    return [];
  }
  const n = 2 ** z;
  const x0 = Math.max(0, tileX(west, z));
  const x1 = Math.min(n - 1, tileX(east, z));
  const y0 = tileY(north, z);
  const y1 = tileY(south, z);
  if (x1 < x0 || (x1 - x0 + 1) * (y1 - y0 + 1) > limit) return [];
  const tiles: TileId[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  return tiles;
}

/** A tile's corners: `[west, south, east, north]` in degrees. */
export function tileBounds({ z, x, y }: TileId): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** The tile's URL from a `{z}/{x}/{y}` template. */
export function tileUrl(template: string, { z, x, y }: TileId): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

// --- What a fetched tile holds -------------------------------------------------

/** The lines of a vector tile: flat `[x0, y0, x1, y1, …]` in tile units of `extent`. */
export interface TileLines {
  kind: 'lines';
  extent: number;
  lines: number[][];
}

export type TileContent =
  /** A layer without features: nothing to draw, ever. */
  | { kind: 'empty' }
  | TileLines
  /** Not a vector tile we can read (still gzipped, truncated…). */
  | { kind: 'unreadable' };

/**
 * Read a vector tile's line geometry — only the protobuf framing and the
 * geometry commands, whatever the layers and properties are. Anything
 * unexpected makes the whole tile `unreadable`, so garbage never triggers a
 * reload.
 */
export function readMvtLines(bytes: Uint8Array): TileContent {
  let pos = 0;
  let bad = false;
  /** A varint at `pos`; flags the tile bad when the bytes run out. */
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const byte = bytes[pos++];
      if (byte === undefined) break;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    bad = true;
    return 0;
  };
  const skip = (wire: number): void => {
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const length = varint();
      pos += length;
    } else bad = true;
    if (pos > bytes.length) bad = true;
  };
  const unzig = (n: number): number => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

  const lines: number[][] = [];
  let extent = 4096;
  let layers = 0;
  while (pos < bytes.length && !bad) {
    const tag = varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      skip(tag & 7);
      continue;
    }
    layers++;
    const layerEndLength = varint();
    const layerEnd = pos + layerEndLength;
    if (layerEnd > bytes.length) bad = true;
    while (pos < layerEnd && !bad) {
      const field = varint();
      if (field >> 3 === 5 && (field & 7) === 0) {
        extent = varint();
      } else if (field >> 3 === 2 && (field & 7) === 2) {
        const featureEndLength = varint();
        const featureEnd = pos + featureEndLength;
        if (featureEnd > layerEnd) bad = true;
        while (pos < featureEnd && !bad) {
          const inner = varint();
          if (inner >> 3 !== 4 || (inner & 7) !== 2) {
            skip(inner & 7);
            continue;
          }
          const geometryEndLength = varint();
          const geometryEnd = pos + geometryEndLength;
          if (geometryEnd > featureEnd) bad = true;
          let x = 0;
          let y = 0;
          let line: number[] | null = null;
          while (pos < geometryEnd && !bad) {
            const command = varint();
            const id = command & 7;
            let count = command >> 3;
            if (id === 7) continue; // ClosePath takes no coordinates
            if (id !== 1 && id !== 2) bad = true;
            while (count-- > 0 && !bad) {
              x += unzig(varint());
              y += unzig(varint());
              if (id === 1 || line === null) lines.push((line = []));
              line.push(x, y);
            }
          }
        }
      } else {
        skip(field & 7);
      }
    }
  }
  if (bad || layers === 0 || !(extent > 0)) return { kind: 'unreadable' };
  return lines.length === 0 ? { kind: 'empty' } : { kind: 'lines', extent, lines };
}

// --- Where a tile is on screen -------------------------------------------------

/** An axis-aligned screen rectangle. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `rect` pulled in by `by` on every side; null when nothing is left. */
export function insetRect(rect: ScreenRect, by: number): ScreenRect | null {
  const out = {
    left: rect.left + by,
    top: rect.top + by,
    right: rect.right - by,
    bottom: rect.bottom - by,
  };
  return out.right > out.left && out.bottom > out.top ? out : null;
}

/** The part of `a` inside `b`; null when they do not overlap. */
export function intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  return insetRect(
    {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    },
    0,
  );
}

/**
 * Where a tile sits on screen: the pixel of three of its corners. The map is
 * a similarity at pitch 0 (pan, zoom, rotation), so every tile point follows
 * from them; a tilted map is only close, and recovery sits those out.
 */
export interface TileOnScreen {
  topLeft: readonly [number, number];
  topRight: readonly [number, number];
  bottomLeft: readonly [number, number];
}

/** The screen box around the whole tile. */
export function tileScreenBox({ topLeft, topRight, bottomLeft }: TileOnScreen): ScreenRect {
  const bottomRight = [
    topRight[0] + bottomLeft[0] - topLeft[0],
    topRight[1] + bottomLeft[1] - topLeft[1],
  ] as const;
  const xs = [topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]];
  const ys = [topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/** Whether the segment (x0, y0)–(x1, y1) passes through the rectangle (Liang–Barsky). */
function segmentCrossesRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: ScreenRect,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: readonly (readonly [number, number])[] = [
    [-dx, x0 - rect.left],
    [dx, rect.right - x0],
    [-dy, y0 - rect.top],
    [dy, rect.bottom - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/**
 * Whether any of a tile's lines runs through `rect` once the tile is placed
 * on screen — i.e. whether the map, had it loaded this tile, would be
 * drawing something there.
 */
export function linesCrossRect(
  content: TileLines,
  onScreen: TileOnScreen,
  rect: ScreenRect,
): boolean {
  const { topLeft, topRight, bottomLeft } = onScreen;
  const ux = (topRight[0] - topLeft[0]) / content.extent;
  const uy = (topRight[1] - topLeft[1]) / content.extent;
  const vx = (bottomLeft[0] - topLeft[0]) / content.extent;
  const vy = (bottomLeft[1] - topLeft[1]) / content.extent;
  for (const line of content.lines) {
    let px = 0;
    let py = 0;
    for (let i = 0; i + 1 < line.length; i += 2) {
      const tx = line[i] ?? 0;
      const ty = line[i + 1] ?? 0;
      const sx = topLeft[0] + tx * ux + ty * vx;
      const sy = topLeft[1] + tx * uy + ty * vy;
      if (i > 0 && segmentCrossesRect(px, py, sx, sy, rect)) return true;
      px = sx;
      py = sy;
    }
  }
  return false;
}

// --- What has been tried ---------------------------------------------------------

interface TileRecord {
  /** Drawn by the map, known to hold no lines, or given up on: never looked at again. */
  settled: boolean;
  /** Failed JS fetches so far, and when the next one may go. */
  tries: number;
  nextTryAt: number;
  /** The Worker answered a tile with lines in it: the map should have it. */
  ready: boolean;
  nudges: number;
}

/** Tiles remembered per session (a few screens' worth of every zoom). */
const MAX_RECORDS = 3000;

/**
 * What has been tried for which tile, and what may be tried next: the caps
 * that keep recovery bounded and polite. Time is passed in, so it is pure.
 */
export class ContourRecoveryLog {
  private readonly records = new Map<string, TileRecord>();
  private lastNudgeAt = -Infinity;

  private record(key: string): TileRecord {
    let record = this.records.get(key);
    if (record === undefined) {
      record = { settled: false, tries: 0, nextTryAt: 0, ready: false, nudges: 0 };
      this.records.set(key, record);
      if (this.records.size > MAX_RECORDS) {
        const oldest = this.records.keys().next();
        if (!oldest.done) this.records.delete(oldest.value);
      }
    }
    return record;
  }

  /** Nothing more to do for this tile: it draws, it is empty, or we gave up. */
  isSettled(key: string): boolean {
    return this.records.get(key)?.settled === true;
  }

  /** The map draws it, it holds no lines, or it is not worth another look. */
  settle(key: string): void {
    this.record(key).settled = true;
  }

  /** The Worker answered it with lines: the map should have it. */
  isReady(key: string): boolean {
    const record = this.records.get(key);
    return record !== undefined && record.ready && !record.settled;
  }

  /** May JS fetch this tile now? (Not settled or ready, tries left, back-off elapsed.) */
  mayFetch(key: string, now: number): boolean {
    const record = this.records.get(key);
    if (record === undefined) return true;
    return (
      !record.settled && !record.ready && record.tries < MAX_FETCH_TRIES && now >= record.nextTryAt
    );
  }

  /** When a tile in back-off may be fetched again; null when it is not waiting. */
  retryAt(key: string): number | null {
    const record = this.records.get(key);
    if (record === undefined || record.settled || record.ready) return null;
    return record.tries > 0 && record.tries < MAX_FETCH_TRIES ? record.nextTryAt : null;
  }

  /**
   * A fetch failed (5xx, network). Returns when the next one may go, or null
   * when the tries are spent — the tile is then left alone for the session.
   */
  fetchFailed(key: string, now: number): number | null {
    const record = this.record(key);
    record.tries++;
    if (record.tries >= MAX_FETCH_TRIES) {
      record.settled = true;
      return null;
    }
    record.nextTryAt = now + (RETRY_DELAYS_MS[record.tries - 1] ?? LAST_RETRY_DELAY_MS);
    return record.nextTryAt;
  }

  /** A fetch answered: with lines (the map should have them) or without (done). */
  fetchSucceeded(key: string, hasLines: boolean): void {
    const record = this.record(key);
    if (hasLines) record.ready = true;
    else record.settled = true;
  }

  /**
   * Of the ready tiles whose lines should be on screen and are not, those
   * worth a reload now: none while the last reload is under
   * {@link MIN_NUDGE_INTERVAL_MS} old; a tile already nudged
   * {@link MAX_NUDGES_PER_TILE} times is given up on instead.
   */
  nudgeable(keys: readonly string[], now: number): string[] {
    const out: string[] = [];
    for (const key of keys) {
      const record = this.records.get(key);
      if (record === undefined || !record.ready || record.settled) continue;
      if (record.nudges >= MAX_NUDGES_PER_TILE) {
        record.settled = true;
        continue;
      }
      out.push(key);
    }
    return now - this.lastNudgeAt < MIN_NUDGE_INTERVAL_MS ? [] : out;
  }

  /** The map was asked to reload for these tiles. */
  nudged(keys: readonly string[], now: number): void {
    this.lastNudgeAt = now;
    for (const key of keys) this.record(key).nudges++;
  }

  /** When the map may next be nudged. */
  nextNudgeAt(): number {
    return this.lastNudgeAt + MIN_NUDGE_INTERVAL_MS;
  }
}
