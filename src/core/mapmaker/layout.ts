import type { BoundingBox } from '@core/models';

/**
 * Page geometry for a made map: fit a geographic region onto a printed page
 * with a margin strip, and derive everything the composer needs — the map
 * frame in PDF points, the (aspect-expanded) region it shows, the print
 * scale, the raster zoom to fetch, and a clean scale bar.
 *
 * Point = 1/72 inch. Page origin is bottom-left (PDF convention). Ground
 * distances use the small-span equirectangular approximation (111 320 m/deg,
 * cos-corrected longitudes at the centre latitude) — consistent with the
 * terrain pipeline's cell math and plenty below print resolution for the
 * ≤ tens-of-km regions the box selector produces.
 */

export interface PageSpec {
  widthPt: number;
  heightPt: number;
}

export type PageFormat = 'a4' | 'letter';

/** Portrait dimensions; landscape swaps them. */
export const PAGE_FORMATS: Record<PageFormat, PageSpec> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612, heightPt: 792 },
};

/** Side/top margin and the taller bottom strip that carries the legend. */
export const MARGIN_PT = 24;
export const BOTTOM_STRIP_PT = 88;

/** Long-edge cap for the stitched basemap raster (memory: 4096² RGBA = 64 MB). */
export const RASTER_LONG_EDGE_PX = 4096;

const M_PER_DEG = 111320;
/** WebMercator ground resolution at zoom 0 (m/px at the equator, 256px tiles). */
const MERCATOR_M0 = 156543.03392;
const M_PER_PT = 0.0254 / 72;

export interface MadeMapLayout {
  format: PageFormat;
  page: PageSpec;
  /** Map frame in page points, origin bottom-left. */
  mapRect: { x: number; y: number; w: number; h: number };
  /** Requested bbox expanded (centre-anchored) to the map frame's aspect. */
  drawBbox: BoundingBox;
  metersPerPt: number;
  /** Print-scale denominator for the label, rounded to 2 significant digits. */
  approxScaleDenom: number;
  /** Zoom whose tiles render the frame as sharp as the raster cap allows. */
  rasterZoom: number;
  scaleBar: { meters: number; widthPt: number; label: string };
}

const SCALE_BAR_METERS = [
  100, 250, 500, 1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000,
] as const;

export function layoutMadeMap(bbox: BoundingBox, format: PageFormat): MadeMapLayout {
  const latMid = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat = Math.cos((latMid * Math.PI) / 180);
  const groundW = (bbox.maxLng - bbox.minLng) * M_PER_DEG * cosLat;
  const groundH = (bbox.maxLat - bbox.minLat) * M_PER_DEG;

  const portrait = PAGE_FORMATS[format];
  const landscape = groundW > groundH;
  const page: PageSpec = landscape
    ? { widthPt: portrait.heightPt, heightPt: portrait.widthPt }
    : portrait;

  const mapRect = {
    x: MARGIN_PT,
    y: BOTTOM_STRIP_PT,
    w: page.widthPt - 2 * MARGIN_PT,
    h: page.heightPt - BOTTOM_STRIP_PT - MARGIN_PT,
  };

  // Expand the bbox (never shrink) to the frame's aspect, centre-anchored.
  const frameAspect = mapRect.w / mapRect.h;
  let spanLngM = groundW;
  let spanLatM = groundH;
  if (groundW / groundH > frameAspect) spanLatM = groundW / frameAspect;
  else spanLngM = groundH * frameAspect;
  const cLng = (bbox.minLng + bbox.maxLng) / 2;
  const halfLng = spanLngM / (M_PER_DEG * cosLat) / 2;
  const halfLat = spanLatM / M_PER_DEG / 2;
  // min/max with the input keeps the containment guarantee exact — the
  // centre±half reconstruction can lose the original edge to float noise.
  const drawBbox: BoundingBox = {
    minLng: Math.min(cLng - halfLng, bbox.minLng),
    maxLng: Math.max(cLng + halfLng, bbox.maxLng),
    minLat: Math.min(latMid - halfLat, bbox.minLat),
    maxLat: Math.max(latMid + halfLat, bbox.maxLat),
  };

  const metersPerPt = spanLngM / mapRect.w;
  const scaleDenom = metersPerPt / M_PER_PT;
  const magnitude = 10 ** Math.floor(Math.log10(scaleDenom) - 1);
  const approxScaleDenom = Math.round(scaleDenom / magnitude) * magnitude;

  // Sharpest zoom whose raster for the frame stays under the long-edge cap.
  const longEdgeM = Math.max(spanLngM, spanLatM);
  let rasterZoom = 0;
  for (let z = 1; z <= 17; z++) {
    const mPerPx = (MERCATOR_M0 * cosLat) / 2 ** z;
    if (longEdgeM / mPerPx > RASTER_LONG_EDGE_PX) break;
    rasterZoom = z;
  }

  const maxBarM = mapRect.w * 0.4 * metersPerPt;
  const meters =
    [...SCALE_BAR_METERS].reverse().find((m) => m <= maxBarM) ?? SCALE_BAR_METERS[0];
  const scaleBar = {
    meters,
    widthPt: meters / metersPerPt,
    label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m`,
  };

  return { format, page, mapRect, drawBbox, metersPerPt, approxScaleDenom, rasterZoom, scaleBar };
}
