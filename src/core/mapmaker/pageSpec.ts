import type { BoundingBox, LngLat } from '@core/models';

/**
 * The printed sheet as an explicit choice (#349).
 *
 * The old model inferred everything: the page came from A4-or-Letter, the
 * orientation from whether the selected region was wider than tall, and the
 * scale from whatever denominator made the region fit — rounded UP to the next
 * standard rung, which silently enlarged the drawn area by 1.2x to 4.3x. Here
 * the page, the orientation and the scale are all inputs, and the ground the
 * sheet covers is *derived* from them. Nothing is snapped behind the user's
 * back; a 1:25 000 sheet covers exactly what 1:25 000 covers.
 *
 * Point = 1/72 inch, PDF convention, origin bottom-left.
 */

export type PagePreset = 'a4' | 'letter' | 'square' | 'free';
export type PageOrientation = 'portrait' | 'landscape';

export interface PageSpec {
  widthPt: number;
  heightPt: number;
}

/** Side/top margin and the taller bottom strip that carries the legend. */
export const MARGIN_PT = 30;
export const BOTTOM_STRIP_PT = 88;

/** Portrait dimensions of the fixed presets; landscape swaps them. */
export const PAGE_PRESETS: Record<Exclude<PagePreset, 'free'>, PageSpec> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612, heightPt: 792 },
  square: { widthPt: 600, heightPt: 600 },
};

/**
 * A free sheet's long edge. Held at A4's long edge so "Free" trades shape for
 * shape rather than quietly producing a poster: the paper a phone user can
 * actually print stays the same size, only its proportions follow the frame.
 */
export const FREE_LONG_EDGE_PT = 841.89;

/** Sheets narrower/wider than this read as a banner, not a map. */
export const FREE_ASPECT_MIN = 0.4;
export const FREE_ASPECT_MAX = 2.5;

export interface PageChoice {
  preset: PagePreset;
  orientation: PageOrientation;
  /**
   * Whole-sheet width/height for `preset: 'free'` — the aspect the user framed
   * on screen. Ignored by every other preset.
   */
  aspect?: number;
}

export interface PageGeometry {
  page: PageSpec;
  /** The map frame in page points, origin bottom-left. */
  mapRect: { x: number; y: number; w: number; h: number };
}

export const clampFreeAspect = (aspect: number): number =>
  !Number.isFinite(aspect) || aspect <= 0
    ? 1
    : Math.min(FREE_ASPECT_MAX, Math.max(FREE_ASPECT_MIN, aspect));

/** The sheet and its map frame for a page choice. */
export function pageGeometry(choice: PageChoice): PageGeometry {
  let widthPt: number;
  let heightPt: number;

  if (choice.preset === 'free') {
    const aspect = clampFreeAspect(choice.aspect ?? 1);
    if (aspect >= 1) {
      widthPt = FREE_LONG_EDGE_PT;
      heightPt = FREE_LONG_EDGE_PT / aspect;
    } else {
      heightPt = FREE_LONG_EDGE_PT;
      widthPt = FREE_LONG_EDGE_PT * aspect;
    }
    // A free sheet already IS the orientation the user framed; rotating it
    // again would fight them.
  } else {
    const p = PAGE_PRESETS[choice.preset];
    const landscape = choice.orientation === 'landscape';
    widthPt = landscape ? p.heightPt : p.widthPt;
    heightPt = landscape ? p.widthPt : p.heightPt;
  }

  return {
    page: { widthPt, heightPt },
    mapRect: {
      x: MARGIN_PT,
      y: BOTTOM_STRIP_PT,
      w: widthPt - 2 * MARGIN_PT,
      h: heightPt - BOTTOM_STRIP_PT - MARGIN_PT,
    },
  };
}

const M_PER_PT = 0.0254 / 72;
const M_PER_DEG_LAT = 111320;

/** The standard ladder the scale chips offer. */
export const SCALE_LADDER = [10000, 25000, 50000, 100000] as const;

/** Metres of ground per page point at a print scale. */
export const metersPerPt = (scaleDenom: number): number => scaleDenom * M_PER_PT;

/**
 * The ground a sheet covers at a scale — the whole point of choosing one.
 * Derived, never rounded: 1:25 000 on A4 portrait is 4 721 m x 6 384 m, full
 * stop.
 */
export function coverageMeters(
  geometry: PageGeometry,
  scaleDenom: number,
): { widthM: number; heightM: number } {
  const mpp = metersPerPt(scaleDenom);
  return { widthM: geometry.mapRect.w * mpp, heightM: geometry.mapRect.h * mpp };
}

/**
 * The bbox a sheet prints, given where its centre sits. Longitude degrees are
 * cos-corrected at the centre latitude, matching the composer's own small-span
 * equirectangular convention.
 */
export function coverageBbox(
  center: LngLat,
  coverage: { widthM: number; heightM: number },
): BoundingBox {
  const [lng, lat] = center;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const halfLng = coverage.widthM / (M_PER_DEG_LAT * cosLat) / 2;
  const halfLat = coverage.heightM / M_PER_DEG_LAT / 2;
  return {
    minLng: lng - halfLng,
    maxLng: lng + halfLng,
    minLat: lat - halfLat,
    maxLat: lat + halfLat,
  };
}

/** The scale that would make a sheet cover an existing bbox (unrounded). */
export function scaleDenomToFit(geometry: PageGeometry, bbox: BoundingBox): number {
  const latMid = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat = Math.max(0.01, Math.cos((latMid * Math.PI) / 180));
  const groundW = (bbox.maxLng - bbox.minLng) * M_PER_DEG_LAT * cosLat;
  const groundH = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;
  const { mapRect } = geometry;
  // Whichever axis needs the coarser scale sets it, so the region always fits.
  return Math.max(groundW / mapRect.w, groundH / mapRect.h) / M_PER_PT;
}

/** The ladder rung closest to a denominator, in log space (scales are ratios). */
export function nearestLadderScale(denom: number): number {
  let best: number = SCALE_LADDER[0];
  let bestErr = Infinity;
  for (const rung of SCALE_LADDER) {
    const err = Math.abs(Math.log(denom / rung));
    if (err < bestErr) {
      bestErr = err;
      best = rung;
    }
  }
  return best;
}
