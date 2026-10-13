/**
 * A static mini map for a shared trail (#589): the web-mercator zoom that fits
 * the trail in a box, the tiles that cover it and where each one goes, and
 * the trail projected into the same pixels — so a few cached tile images
 * plus one SVG line give the route its context without a MapLibre view. Pure.
 */
export const TILE_PX = 256;

export interface MiniMapTile {
  z: number;
  x: number;
  y: number;
  /** Top-left in box pixels. */
  left: number;
  top: number;
}

export interface MiniMapLayout {
  z: number;
  tiles: MiniMapTile[];
  /** [lng, lat] → box pixels. */
  project: (lng: number, lat: number) => [number, number];
}

function worldPx(lng: number, lat: number, z: number): [number, number] {
  const n = TILE_PX * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** Null for an empty trail. `maxZoom` caps detail for short trails. */
export function miniMapLayout(
  points: readonly [number, number][],
  width: number,
  height: number,
  options: { padding?: number; maxZoom?: number; minZoom?: number } = {},
): MiniMapLayout | null {
  if (points.length === 0 || width <= 0 || height <= 0) return null;
  const pad = options.padding ?? 18;
  const maxZ = options.maxZoom ?? 16;
  const minZ = options.minZoom ?? 3;
  let z = maxZ;
  for (; z > minZ; z--) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [lng, lat] of points) {
      const [x, y] = worldPx(lng, lat, z);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x1 - x0 <= width - 2 * pad && y1 - y0 <= height - 2 * pad) break;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [lng, lat] of points) {
    const [x, y] = worldPx(lng, lat, z);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const left = (x0 + x1) / 2 - width / 2;
  const top = (y0 + y1) / 2 - height / 2;
  const n = 2 ** z;
  const tiles: MiniMapTile[] = [];
  for (let ty = Math.floor(top / TILE_PX); ty <= Math.floor((top + height) / TILE_PX); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE_PX); tx <= Math.floor((left + width) / TILE_PX); tx++) {
      tiles.push({
        z,
        x: ((tx % n) + n) % n,
        y: ty,
        left: tx * TILE_PX - left,
        top: ty * TILE_PX - top,
      });
    }
  }
  return {
    z,
    tiles,
    project: (lng, lat) => {
      const [x, y] = worldPx(lng, lat, z);
      return [x - left, y - top];
    },
  };
}
