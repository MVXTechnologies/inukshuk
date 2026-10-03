/**
 * Terrain tile identities. A terrain tile is a Web-Mercator XYZ tile plus a
 * `wrap` (the world copy it sits in: −1 west of the antimeridian, +1 east),
 * so a view across 180° draws the tiles on both sides. Its heights come from
 * the Terrarium DEM tile at the same zoom up to {@link DEM_MAX_ZOOM}; deeper
 * terrain tiles read a sub-square of the z15 DEM.
 */
import { worldSize } from './mercator';

/** Deepest Terrarium DEM zoom (AWS Terrain Tiles). */
export const DEM_MAX_ZOOM = 15;
/** Deepest terrain mesh zoom (z15 DEM, finer grid near the camera). */
export const TERRAIN_MAX_ZOOM = 17;

export interface TileId {
  z: number;
  x: number;
  y: number;
  /** World copy: 0 = the primary world, ±1 = neighbours across the antimeridian. */
  wrap: number;
}

/** A DEM tile key — no wrap: every world copy shares the same data. */
export interface DemId {
  z: number;
  x: number;
  y: number;
}

/** Where a terrain tile's square sits inside its DEM tile's [0, 1]² square. */
export interface DemWindow {
  dem: DemId;
  /** Offset of the terrain tile's (0, 0) corner, in DEM-tile units. */
  offsetX: number;
  offsetY: number;
  /** Size of the terrain tile in DEM-tile units (1 at the same zoom, ½ one deeper…). */
  scale: number;
}

export function tileKey(t: TileId): string {
  return `${t.z}/${t.x}/${t.y}/${t.wrap}`;
}

export function demKey(d: DemId): string {
  return `${d.z}/${d.x}/${d.y}`;
}

export function isValidTile(t: TileId): boolean {
  const n = 2 ** t.z;
  return (
    Number.isInteger(t.z) &&
    t.z >= 0 &&
    t.z <= TERRAIN_MAX_ZOOM &&
    Number.isInteger(t.x) &&
    Number.isInteger(t.y) &&
    t.x >= 0 &&
    t.x < n &&
    t.y >= 0 &&
    t.y < n
  );
}

export function children(t: TileId): TileId[] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y, wrap: t.wrap },
    { z, x: x + 1, y, wrap: t.wrap },
    { z, x, y: y + 1, wrap: t.wrap },
    { z, x: x + 1, y: y + 1, wrap: t.wrap },
  ];
}

export function parent(t: TileId): TileId | null {
  if (t.z === 0) return null;
  return { z: t.z - 1, x: t.x >> 1, y: t.y >> 1, wrap: t.wrap };
}

/** The tile's ancestor at zoom `z` (itself when `z >= t.z`). */
export function ancestorAt(t: TileId, z: number): TileId {
  if (z >= t.z) return t;
  const d = t.z - Math.max(0, z);
  return { z: t.z - d, x: t.x >> d, y: t.y >> d, wrap: t.wrap };
}

/** Which quadrant of its parent a tile is: 0..1 on each axis. */
export function quadrant(t: TileId): [number, number] {
  return [t.x & 1, t.y & 1];
}

/** The tile's square in world pixels at camera zoom `zoom` (wrap applied). */
export function tileBoundsPx(
  t: TileId,
  zoom: number,
): { minX: number; minY: number; maxX: number; maxY: number; size: number } {
  const ws = worldSize(zoom);
  const size = ws / 2 ** t.z;
  const minX = t.x * size + t.wrap * ws;
  const minY = t.y * size;
  return { minX, minY, maxX: minX + size, maxY: minY + size, size };
}

/** The DEM window for a terrain tile, reading DEM zoom ≤ `maxDemZoom`. */
export function demWindow(t: TileId, maxDemZoom = DEM_MAX_ZOOM): DemWindow {
  const dz = Math.min(t.z, maxDemZoom);
  const d = t.z - dz;
  const k = 2 ** d;
  const dem = { z: dz, x: t.x >> d, y: t.y >> d };
  return {
    dem,
    offsetX: (t.x - dem.x * k) / k,
    offsetY: (t.y - dem.y * k) / k,
    scale: 1 / k,
  };
}

/** The DEM window of the nearest ancestor DEM at zoom `demZ` (≤ the tile's own). */
export function demWindowAt(t: TileId, demZ: number): DemWindow {
  const dz = Math.max(0, Math.min(demZ, t.z));
  const d = t.z - dz;
  const k = 2 ** d;
  const dem = { z: dz, x: t.x >> d, y: t.y >> d };
  return {
    dem,
    offsetX: (t.x - dem.x * k) / k,
    offsetY: (t.y - dem.y * k) / k,
    scale: 1 / k,
  };
}

/** Wrap an x tile index into [0, 2^z) and report the world copy it came from. */
export function wrapTileX(x: number, z: number): { x: number; wrap: number } {
  const n = 2 ** z;
  const wrap = Math.floor(x / n);
  return { x: x - wrap * n, wrap };
}

/** Neighbouring DEM tile, with x wrapping across the antimeridian; null past a pole. */
export function demNeighbor(d: DemId, dx: number, dy: number): DemId | null {
  const n = 2 ** d.z;
  const y = d.y + dy;
  if (y < 0 || y >= n) return null;
  const x = (((d.x + dx) % n) + n) % n;
  return { z: d.z, x, y };
}
