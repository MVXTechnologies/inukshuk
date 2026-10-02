import type { LatLng } from '@core/models';
import {
  clipPolygonToSquare,
  clipPolylineToSquare,
  projectRing,
  projectToWindow,
  ringInWindow,
  toPath,
  type LocatorBasemap,
  type LocatorRing,
  type LocatorSheetRect,
  type LocatorWindow,
} from './locator';
import type { CatalogBbox } from './schema';

/**
 * Footprint thumbnails for the Explore "Popular near you" cards: the map
 * sheet's bbox drawn as a rectangle over the offline Natural Earth outline
 * (`locatorBasemap.ts`), in a **rectangular** frame (the cards are 4:3, the
 * store-row locator is square).
 *
 * Pure math: no tiles, no network, so a carousel of eight cards costs nothing
 * on the tile server and draws the same offline. Rendering is
 * `react-native-svg` in `@features/store/explore/FootprintThumb`.
 *
 * Honesty rule: the baked basemap only covers a window around Canada
 * ({@link LOCATOR_BASEMAP_EXTENT}). Outside it the land layer is simply
 * absent, so a Colorado quad would sit in a blue "ocean". A scene whose
 * window is not wholly inside the extent therefore reports
 * `basemap: false`, carries no land/lake/border paths, and the UI draws a
 * neutral paper ground with a graticule instead.
 */

/** The baked basemap's extent [west, south, east, north] (see build-locator-basemap.ts). */
export const LOCATOR_BASEMAP_EXTENT: CatalogBbox = [-142, 40, -49, 84];

/** How many times bigger than the sheet the frame is, on its tighter axis. */
export const FOOTPRINT_WINDOW_FACTOR = 3.2;
/** Frame latitude span clamp, degrees: a place, not a pixel; a region, not a country. */
export const FOOTPRINT_MIN_LAT_SPAN = 1.2;
export const FOOTPRINT_MAX_LAT_SPAN = 14;
/** Smallest footprint side drawn, px — a 1:24 000 quad must stay visible. */
export const FOOTPRINT_MIN_SHEET_PX = 7;

const DEG2RAD = Math.PI / 180;

export interface FootprintSceneOptions {
  width: number;
  height: number;
  /** The user, drawn as a dot when inside the frame. */
  origin?: LatLng | null;
}

export interface FootprintScene {
  width: number;
  height: number;
  /** False when the frame leaves the basemap's extent: draw a neutral ground. */
  basemap: boolean;
  land: readonly string[];
  lakes: readonly string[];
  borders: readonly string[];
  /** Graticule lines (whole or half degrees) for the neutral ground. */
  graticule: readonly string[];
  /** The footprint, grown to at least {@link FOOTPRINT_MIN_SHEET_PX} a side. */
  sheet: LocatorSheetRect;
  /** The user's position in px, or null when unknown or outside the frame. */
  you: { x: number; y: number } | null;
}

/**
 * The frame a card shows for `bbox`: centred on it, {@link FOOTPRINT_WINDOW_FACTOR}×
 * the sheet on its tighter axis (clamped), with the card's aspect ratio in
 * projected pixels (lon span = lat span × aspect / cos φ).
 */
export function footprintWindow(bbox: CatalogBbox, aspect: number): LocatorWindow {
  const [west, south, east, north] = bbox;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const cosLat = Math.max(0.2, Math.cos(centerLat * DEG2RAD));
  const needed = Math.max(north - south, ((east - west) * cosLat) / safeAspect);
  const latSpan = Math.min(
    FOOTPRINT_MAX_LAT_SPAN,
    Math.max(FOOTPRINT_MIN_LAT_SPAN, needed * FOOTPRINT_WINDOW_FACTOR),
  );
  const lonSpan = (latSpan * safeAspect) / cosLat;
  return {
    west: centerLon - lonSpan / 2,
    east: centerLon + lonSpan / 2,
    south: centerLat - latSpan / 2,
    north: centerLat + latSpan / 2,
    cosLat,
  };
}

/** Is the whole window inside `extent`? */
export function windowInsideExtent(window: LocatorWindow, extent: CatalogBbox): boolean {
  return (
    window.west >= extent[0] &&
    window.south >= extent[1] &&
    window.east <= extent[2] &&
    window.north <= extent[3]
  );
}

/**
 * Grow a px rect about its centre so neither side is under `min` — a sheet a
 * fraction of a pixel wide would otherwise vanish. Never shrinks.
 */
export function ensureMinRect(rect: LocatorSheetRect, min: number): LocatorSheetRect {
  const width = Math.max(rect.width, min);
  const height = Math.max(rect.height, min);
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

/** A tidy graticule step for a span: 0.25°, 0.5°, 1°, 2° or 5°, about 2–5 lines. */
export function graticuleStep(spanDeg: number): number {
  for (const step of [0.25, 0.5, 1, 2, 5]) {
    if (spanDeg / step <= 5) return step;
  }
  return 10;
}

function graticulePaths(window: LocatorWindow, width: number, height: number): string[] {
  const paths: string[] = [];
  const latStep = graticuleStep(window.north - window.south);
  for (let lat = Math.ceil(window.south / latStep) * latStep; lat < window.north; lat += latStep) {
    const [, y] = projectToWindow(window.west, lat, window, height);
    paths.push(toPath([[0, y] as const, [width, y] as const], false));
  }
  const lonStep = graticuleStep(window.east - window.west);
  for (let lon = Math.ceil(window.west / lonStep) * lonStep; lon < window.east; lon += lonStep) {
    const [x] = projectToWindow(lon, window.north, window, height);
    paths.push(toPath([[x, 0] as const, [x, height] as const], false));
  }
  return paths;
}

/**
 * Everything one card thumbnail draws, in px of a `width` × `height` canvas.
 * Rings are bounds-rejected against the frame before projection and clipping,
 * so cost scales with what is visible.
 */
export function buildFootprintScene(
  bbox: CatalogBbox,
  basemap: LocatorBasemap,
  options: FootprintSceneOptions,
  extent: CatalogBbox = LOCATOR_BASEMAP_EXTENT,
): FootprintScene {
  const { width, height } = options;
  const window = footprintWindow(bbox, width / height);
  const covered = windowInsideExtent(window, extent);

  const polygons = (rings: readonly LocatorRing[]): string[] => {
    if (!covered) return [];
    const paths: string[] = [];
    for (const ring of rings) {
      if (!ringInWindow(ring, window)) continue;
      const clipped = clipPolygonToSquare(projectRing(ring, window, height), width, height);
      if (clipped.length >= 3) paths.push(toPath(clipped, true));
    }
    return paths;
  };
  const polylines = (rings: readonly LocatorRing[]): string[] => {
    if (!covered) return [];
    const paths: string[] = [];
    for (const ring of rings) {
      if (!ringInWindow(ring, window)) continue;
      for (const piece of clipPolylineToSquare(projectRing(ring, window, height), width, height)) {
        paths.push(toPath(piece, false));
      }
    }
    return paths;
  };

  const [x0, y0] = projectToWindow(bbox[0], bbox[3], window, height);
  const [x1, y1] = projectToWindow(bbox[2], bbox[1], window, height);
  const sheet = ensureMinRect(
    { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    FOOTPRINT_MIN_SHEET_PX,
  );

  let you: FootprintScene['you'] = null;
  const origin = options.origin ?? null;
  if (origin !== null) {
    const [x, y] = projectToWindow(origin.longitude, origin.latitude, window, height);
    if (x >= 0 && x <= width && y >= 0 && y <= height) you = { x, y };
  }

  return {
    width,
    height,
    basemap: covered,
    land: polygons(basemap.land),
    lakes: polygons(basemap.lakes),
    borders: polylines(basemap.borders),
    graticule: covered ? [] : graticulePaths(window, width, height),
    sheet,
    you,
  };
}

/**
 * A small square-ish bbox around a point (a link-out place has a position,
 * not a footprint): ±`halfLatDeg` north–south and the same ground distance
 * east–west, so the thumbnail frames it like a sheet of that size.
 */
export function pointBbox(point: LatLng, halfLatDeg = 0.3): CatalogBbox {
  const cosLat = Math.max(0.2, Math.cos(point.latitude * DEG2RAD));
  const halfLon = halfLatDeg / cosLat;
  return [
    point.longitude - halfLon,
    point.latitude - halfLatDeg,
    point.longitude + halfLon,
    point.latitude + halfLatDeg,
  ];
}
