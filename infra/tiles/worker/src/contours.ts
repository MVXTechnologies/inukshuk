/**
 * Contour-line vector tiles, generated on demand from the same Terrarium DEM
 * the app already uses, and cached at the edge like any tile:
 *
 *   GET /contours/{z}/{x}/{y}.mvt   layer "contours", properties ele (m), level (0 minor, 1 major)
 *
 * Because they are ordinary vector tiles, MapLibre loads them around the
 * viewport with the base map (no computed "window" that pans into blank), and
 * offline packs store them. Uses maplibre-contour's isoline code with a pure-JS
 * PNG decoder (Workers have no canvas).
 */
import mlcontour from 'maplibre-contour';
import { decode } from 'fast-png';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** [minor, major] contour interval (m) by tile zoom — denser as you zoom in. */
export function contourLevels(z: number): [number, number] {
  if (z <= 9) return [100, 500];
  if (z === 10) return [50, 250];
  if (z === 11) return [25, 100];
  if (z === 12) return [20, 100];
  return [10, 50];
}

/** Deepest zoom we generate; MapLibre overzooms the vector lines beyond it. */
export const CONTOUR_MAX_ZOOM = 14;

const manager = new mlcontour.LocalDemManager({
  demUrlPattern: DEM_URL,
  cacheSize: 64,
  encoding: 'terrarium',
  maxzoom: 15,
  timeoutMs: 20_000,
  getTile: async (url: string, abort: AbortController) => {
    const res = await fetch(url, {
      signal: abort.signal,
      cf: { cacheTtl: 2_592_000, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`DEM ${res.status}`);
    return { data: await res.blob() };
  },
  decodeImage: async (blob: Blob) => {
    const png = decode(new Uint8Array(await blob.arrayBuffer()));
    const channels = png.channels;
    const px = png.width * png.height;
    const data = new Float32Array(px);
    const src = png.data;
    for (let i = 0; i < px; i++) {
      const o = i * channels;
      data[i] = src[o]! * 256 + src[o + 1]! + src[o + 2]! / 256 - 32768;
    }
    return { width: png.width, height: png.height, data };
  },
});

export async function contourTile(z: number, x: number, y: number): Promise<ArrayBuffer> {
  const [minor, major] = contourLevels(z);
  const tile = await manager.fetchContourTile(
    z,
    x,
    y,
    {
      levels: [minor, major],
      contourLayer: 'contours',
      elevationKey: 'ele',
      levelKey: 'level',
      extent: 4096,
      buffer: 1,
      overzoom: 1,
      subsampleBelow: 100,
    },
    new AbortController(),
  );
  return tile.arrayBuffer;
}
