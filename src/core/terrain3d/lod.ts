/**
 * Which terrain tiles to draw this frame: a quadtree walk from z0 that keeps
 * splitting a tile while its grid spacing, as seen on screen, exceeds an
 * error budget (screen-space error), culls tiles outside the frustum or
 * beyond the fog, and stays under a tile budget by relaxing the error
 * threshold. Pure: the native engines run the same walk (C++ twin) every
 * frame on MapLibre's own matrix.
 */
import { eyeFromProjection } from './camera';
import { aabbOutside, distanceToAabb, frustumPlanes, type Aabb } from './frustum';
import type { Mat4, Vec3 } from './mat4';
import { pixelsPerMeter } from './mercator';
import { children, TERRAIN_MAX_ZOOM, tileBoundsPx, type TileId } from './tiles';

/** Cells per terrain-tile edge (the shared grid is GRID × GRID quads). */
export const GRID = 32;
/** Default split threshold: on-screen grid spacing in logical pixels. */
export const DEFAULT_MAX_ERROR_PX = 10;
/** Default tile budget per frame (≈ 290 k vertices at GRID 32 with skirts). */
export const DEFAULT_MAX_TILES = 240;
/** Tiles farther than this many camera-to-centre distances are fog. */
export const DEFAULT_FOG_END_CTC = 12;
/** How many zooms deeper than the camera the terrain may go. */
export const MAX_ZOOM_ABOVE_CAMERA = 3;
/** Absolute elevation range assumed for a tile with no DEM anywhere above it. */
export const UNKNOWN_HEIGHT_RANGE: readonly [number, number] = [-100, 9000];
/** Visit cap per walk — bounds the CPU cost of a pathological camera. */
export const MAX_VISITS = 20000;

export interface FrameCamera {
  /** MapLibre's projection matrix: (x_px, y_px, z_m, 1) → clip. */
  P: Mat4;
  /** Viewport, logical pixels. */
  width: number;
  height: number;
  fovRad: number;
  zoom: number;
  /** Latitude of the view centre (pixels-per-metre for heights). */
  lat: number;
}

export interface LodOptions {
  grid?: number;
  maxErrorPx?: number;
  maxTiles?: number;
  maxZoom?: number;
  fogEndCtc?: number;
  /**
   * Coarser LOD toward the fog (round 3): the split threshold grows by up to
   * ×(1 + fogLodBoost) between fogStartCtc and fogEndCtc (smoothstep). 0 = off.
   */
  fogStartCtc?: number;
  fogLodBoost?: number;
  /** Absolute [min, max] elevation (m) known for a tile, or null when unknown. */
  heightRange?: (t: TileId) => readonly [number, number] | null;
  /** Reference height subtracted from every elevation (m). */
  hRef?: number;
  /** Exaggeration × pitch ramp: displayed z = (h − hRef) · heightScale. */
  heightScale?: number;
}

export interface SelectedTile {
  tile: TileId;
  /** Eye → tile box distance, pixels. */
  distance: number;
  /** On-screen grid spacing, pixels. */
  sse: number;
}

export interface Selection {
  tiles: SelectedTile[];
  /** The error threshold the budget settled on. */
  threshold: number;
  visited: number;
  eye: Vec3 | null;
  /** Camera-to-centre distance, pixels. */
  ctc: number;
}

/** The z range (P space, metres) a tile's box spans once displayed. */
export function displayedZRange(
  range: readonly [number, number],
  hRef: number,
  heightScale: number,
): [number, number] {
  const a = (range[0] - hRef) * heightScale;
  const b = (range[1] - hRef) * heightScale;
  return a <= b ? [a, b] : [b, a];
}

/** On-screen size (px) of the grid spacing of a tile seen from `distance`. */
export function screenSpaceError(
  tileSizePx: number,
  grid: number,
  ctc: number,
  distance: number,
): number {
  return ((tileSizePx / grid) * ctc) / Math.max(distance, 1e-6);
}

/** The split-threshold multiplier at `distance` px: 1 up to the fog start, 1 + boost at its end. */
export function fogLodFactor(
  distance: number,
  o: { fogStartCtc: number; fogEndCtc: number; fogLodBoost: number },
  ctc: number,
): number {
  if (!(o.fogLodBoost > 0)) return 1;
  const a = o.fogStartCtc * ctc;
  const b = o.fogEndCtc * ctc;
  if (!(b > a)) return 1;
  const t = Math.min(Math.max((distance - a) / (b - a), 0), 1);
  return 1 + o.fogLodBoost * t * t * (3 - 2 * t);
}

function walk(
  cam: FrameCamera,
  opts: Required<Omit<LodOptions, 'heightRange'>> & Pick<LodOptions, 'heightRange'>,
  threshold: number,
  eye: Vec3,
  ctc: number,
): { tiles: SelectedTile[]; visited: number; overflow: boolean } {
  const planes = frustumPlanes(cam.P);
  const ppm = pixelsPerMeter(cam.lat, cam.zoom);
  const fogEnd = opts.fogEndCtc * ctc;
  const maxZ = Math.min(opts.maxZoom, Math.floor(cam.zoom) + MAX_ZOOM_ABOVE_CAMERA);
  const out: SelectedTile[] = [];
  let visited = 0;
  let overflow = false;
  const stack: TileId[] = [
    { z: 0, x: 0, y: 0, wrap: -1 },
    { z: 0, x: 0, y: 0, wrap: 0 },
    { z: 0, x: 0, y: 0, wrap: 1 },
  ];
  while (stack.length > 0) {
    const t = stack.pop()!;
    visited++;
    if (visited > MAX_VISITS) {
      overflow = true;
      break;
    }
    const b = tileBoundsPx(t, cam.zoom);
    const range = opts.heightRange?.(t) ?? UNKNOWN_HEIGHT_RANGE;
    const [zMin, zMax] = displayedZRange(range, opts.hRef, opts.heightScale);
    const box: Aabb = {
      minX: b.minX,
      minY: b.minY,
      minZ: zMin,
      maxX: b.maxX,
      maxY: b.maxY,
      maxZ: zMax,
    };
    if (aabbOutside(planes, box)) continue;
    const distance = distanceToAabb(eye[0], eye[1], eye[2], box, ppm);
    if (distance > fogEnd) continue;
    const sse = screenSpaceError(b.size, opts.grid, ctc, distance);
    if (sse > threshold * fogLodFactor(distance, opts, ctc) && t.z < maxZ) {
      for (const c of children(t)) stack.push(c);
    } else {
      out.push({ tile: t, distance, sse });
      if (out.length > opts.maxTiles) {
        overflow = true;
        break;
      }
    }
  }
  return { tiles: out, visited, overflow };
}

/**
 * The tiles to draw, nearest first. Deterministic: the same camera and
 * options always give the same list.
 */
export function selectTiles(cam: FrameCamera, options: LodOptions = {}): Selection {
  const opts = {
    grid: options.grid ?? GRID,
    maxErrorPx: options.maxErrorPx ?? DEFAULT_MAX_ERROR_PX,
    maxTiles: options.maxTiles ?? DEFAULT_MAX_TILES,
    maxZoom: options.maxZoom ?? TERRAIN_MAX_ZOOM,
    fogEndCtc: options.fogEndCtc ?? DEFAULT_FOG_END_CTC,
    fogStartCtc: options.fogStartCtc ?? 0,
    fogLodBoost: options.fogLodBoost ?? 0,
    heightRange: options.heightRange,
    hRef: options.hRef ?? 0,
    heightScale: options.heightScale ?? 1,
  };
  const ctc = (0.5 * cam.height) / Math.tan(cam.fovRad / 2);
  const eye = eyeFromProjection(cam.P);
  if (!eye || !Number.isFinite(ctc) || ctc <= 0) {
    return { tiles: [], threshold: opts.maxErrorPx, visited: 0, eye, ctc };
  }
  let threshold = opts.maxErrorPx;
  let visitedTotal = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    const r = walk(cam, opts, threshold, eye, ctc);
    visitedTotal += r.visited;
    if (!r.overflow) {
      r.tiles.sort((a, b) => a.distance - b.distance || a.tile.z - b.tile.z);
      return { tiles: r.tiles, threshold, visited: visitedTotal, eye, ctc };
    }
    threshold *= 1.25;
  }
  return { tiles: [], threshold, visited: visitedTotal, eye, ctc };
}

/** Total vertices a selection draws (grid + 4-edge skirt per tile). */
export function vertexBudget(tileCount: number, grid = GRID): number {
  return tileCount * ((grid + 1) * (grid + 1) + 4 * (grid + 1));
}
