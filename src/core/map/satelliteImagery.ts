/**
 * The Satellite base map's look and tile budget (#495). Pure decisions;
 * `features/map/mapStyle.ts` writes them into the style.
 *
 * Owner, 2026: "brighter images, less dark" and "satellite is much slower
 * than the vector map". Both are answered here without changing provider —
 * Esri World Imagery stays the source (see the PR for the provider survey:
 * every brighter free alternative is either regional, 10 m Sentinel-2, or
 * non-commercial).
 */
import { CANONICAL_TILE_PX } from '@core/geo/tiles';

// ---------------------------------------------------------------------------
// Look: a client-side paint over the imagery
// ---------------------------------------------------------------------------

/** How the imagery is toned: the tiles as served, or lifted shadows. */
export type ImageryLook = 'original' | 'bright' | 'brighter';

export const IMAGERY_LOOKS: readonly ImageryLook[] = ['original', 'bright', 'brighter'];

/**
 * Bright by default: the owner's complaint is that the imagery reads dark
 * (forest and north-facing slopes go near-black in Esri's Vantor/Maxar
 * mosaics), and Bright fixes that without washing out snow or rock.
 */
export const DEFAULT_IMAGERY_LOOK: ImageryLook = 'brighter';

export const IMAGERY_LOOK_LABEL: Readonly<Record<ImageryLook, string>> = {
  original: 'Original',
  bright: 'Bright',
  brighter: 'Brighter',
};

export function isImageryLook(v: unknown): v is ImageryLook {
  return typeof v === 'string' && (IMAGERY_LOOKS as readonly string[]).includes(v);
}

/** The MapLibre raster paint properties a look sets. */
export interface ImageryPaint {
  'raster-brightness-min'?: number;
  'raster-brightness-max'?: number;
  'raster-contrast'?: number;
  'raster-saturation'?: number;
}

/**
 * Picked from the #495 comparison sheet (Esri z13 over Mont-Sainte-Anne,
 * Katahdin and the Mont Blanc massif). MapLibre has no gamma, so the lift
 * comes from `raster-brightness-min` (it raises the black point: shadows
 * gain most, white stays white), a touch of NEGATIVE contrast (pulls the
 * darks further up and keeps snow from clipping), and saturation to win
 * back the colour the lift greys out. Positive contrast was rejected: it
 * darkens the forest it was meant to brighten and crushes glacier detail.
 *
 * Mean luma on the sheet's three blocks, 0–255:
 *   original 71 / 62 / 151 · bright 94 / 86 / 161 · brighter 105 / 98 / 166.
 */
export const IMAGERY_PAINT: Readonly<Record<ImageryLook, Readonly<ImageryPaint>>> = {
  original: {},
  bright: { 'raster-brightness-min': 0.1, 'raster-contrast': -0.05, 'raster-saturation': 0.2 },
  brighter: { 'raster-brightness-min': 0.15, 'raster-contrast': -0.08, 'raster-saturation': 0.3 },
};

/** A colour in linear 0–1 channels. */
export type Rgb = readonly [number, number, number];

/**
 * What MapLibre's raster shader does to one colour under a paint — the same
 * order as `raster.fragment.glsl`: saturation, then contrast, then the
 * brightness remap. Exists so the looks can be tested as pixels rather than
 * as numbers in a table.
 */
export function applyImageryPaint(rgb: Rgb, paint: ImageryPaint): Rgb {
  const sat = paint['raster-saturation'] ?? 0;
  const contrast = paint['raster-contrast'] ?? 0;
  const lo = paint['raster-brightness-min'] ?? 0;
  const hi = paint['raster-brightness-max'] ?? 1;
  const satFactor = sat > 0 ? 1 - 1 / (1.001 - sat) : -sat;
  const contrastFactor = contrast > 0 ? 1 / (1 - contrast) : 1 + contrast;
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const one = (c: number): number => {
    const s = c + (avg - c) * satFactor;
    const k = (s - 0.5) * contrastFactor + 0.5;
    return Math.min(1, Math.max(0, lo + (hi - lo) * k));
  };
  return [one(rgb[0]), one(rgb[1]), one(rgb[2])];
}

// ---------------------------------------------------------------------------
// Speed: how many tiles a screen of imagery costs
// ---------------------------------------------------------------------------

/**
 * Tile size DECLARED for the satellite source: 256·√2 ≈ 362.
 *
 * Why the imagery was slower than the vector map (measured 2026-10-01 on a
 * 412×915 dp phone viewport, Esri over Mont-Sainte-Anne): per-tile latency
 * is NOT the difference — Esri's CloudFront edge answers a warm tile in
 * ~25 ms and a cold one in ~120–190 ms, about what our Worker does for a
 * vector tile. The difference is the BUDGET. Vector tiles are 512-canonical
 * and ~5 KB; the imagery was declared 256, so MapLibre fetched it a full
 * level deeper than the camera — and, rounding raster zooms rather than
 * flooring them, a SECOND level deeper past every half zoom. Over z12–z16 a
 * screen averaged 16.9 imagery tiles (~15 KB each, ~250 KB) against 5.7
 * vector tiles (~5 KB each, ~30 KB): 3× the requests and 8× the bytes, all
 * over Esri's HTTP/1.1 (no multiplexing), each fading in over 300 ms.
 *
 * MapLibre picks a raster tile zoom as `round(z + log2(512 / tileSize))`.
 * At 362 that is always `floor(z) + 1`: the same tiles as 256 at every
 * whole zoom (so offline packs, whose tile cover MapLibre computes the same
 * way at integer zooms, are unchanged), but never the extra level past the
 * half zoom. Mean requests per screen drop by a third (16.9 → 11.4) and the
 * worst screen halves (24 → 12, just past z.5) — see
 * `meanRasterViewportTiles`. The price: imagery pixels are drawn up to 2
 * points wide instead of 1.41 just before each level switch.
 *
 * 512 would cut the budget again but draws every image pixel 1.4–2.8
 * points wide — visibly soft on a 3× phone. Not worth it for imagery.
 */
export const SATELLITE_TILE_SIZE = 362;

/** The previous declaration, kept for the before/after arithmetic. */
export const LEGACY_SATELLITE_TILE_SIZE = 256;

/**
 * Satellite tiles fade in over this long (MapLibre's default is 300 ms).
 * Long fades on a 15-tile screen read as "still loading" well after the
 * bytes have arrived; 100 ms keeps the edge soft without the lag.
 */
export const SATELLITE_FADE_MS = 100;

/** A viewport in logical points (dp / pt). */
export interface ViewportPt {
  width: number;
  height: number;
}

/**
 * The tile zoom MapLibre Native requests a RASTER source at — `round`, not
 * `floor` (that is `util::coveringZoomLevel` for raster/video sources).
 * Clamped to the source's maxzoom, past which it overscales.
 */
export function rasterTileZoom(cameraZoom: number, tileSize: number, maxZoom: number): number {
  const ideal = Math.max(0, Math.round(cameraZoom + Math.log2(CANONICAL_TILE_PX / tileSize)));
  return Math.min(maxZoom, ideal);
}

/** How wide, in points, one tile of a raster source is drawn at a camera zoom. */
export function rasterTileScreenPt(cameraZoom: number, tileSize: number, maxZoom: number): number {
  return CANONICAL_TILE_PX * 2 ** (cameraZoom - rasterTileZoom(cameraZoom, tileSize, maxZoom));
}

/** Tiles of a raster source on screen at one (fractional) camera zoom. */
export function rasterViewportTiles(
  cameraZoom: number,
  viewport: ViewportPt,
  tileSize: number,
  maxZoom: number,
): number {
  const pt = rasterTileScreenPt(cameraZoom, tileSize, maxZoom);
  return (Math.ceil(viewport.width / pt) + 1) * (Math.ceil(viewport.height / pt) + 1);
}

/**
 * The mean tiles per screen over every camera zoom from `fromZoom` up to
 * (not including) `toZoom`, sampled `steps` times per zoom level — what a
 * user who browses at arbitrary zooms actually pays.
 */
export function meanRasterViewportTiles(
  fromZoom: number,
  toZoom: number,
  viewport: ViewportPt,
  tileSize: number,
  maxZoom: number,
  steps = 20,
): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; fromZoom + i / steps < toZoom; i++) {
    sum += rasterViewportTiles(fromZoom + i / steps, viewport, tileSize, maxZoom);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}
