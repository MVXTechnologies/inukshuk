import type { BoundingBox } from '@core/models';
import { latToMercatorY } from './screenBounds';

/**
 * Pure model of MapLibre's `fitBounds` framing, plus the padding the map's
 * multi-trail (heat-spot carousel) fit hands it.
 *
 * The real fit happens natively — `cameraRef.fitBounds(bounds, { padding })`
 * ends up in mbgl's `cameraForLatLngBounds`, which projects the bbox corners
 * into Web Mercator and picks the largest zoom at which the projected box
 * still fits inside `viewport − padding`. That arithmetic is reproduced here
 * so the framing the app asks for is unit-testable: which padding is applied,
 * and how much of the screen the fitted bbox actually ends up covering.
 *
 * Only valid for a north-up, unpitched camera (bearing 0, pitch 0) — the same
 * caveat `screenBounds` carries. With bearing the screen-space box of a
 * geographic box is larger (up to √2 at 45°) and the native fit backs off
 * accordingly; with pitch the fit is approximate at best.
 */

/**
 * MapLibre's world size at zoom 0, in logical pixels. MapLibre (GL JS and the
 * native SDKs alike) uses the 512-px tile convention.
 */
const WORLD_PX_AT_ZOOM_0 = 512;

/** Pixel insets subtracted from the viewport before the bbox is fitted. */
export interface FitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The map view's size in logical pixels. */
export interface FitViewport {
  width: number;
  height: number;
}

/**
 * The margin the heat-spot carousel's camera fit leaves around the unioned
 * trail bbox — deliberately *just* enough that a trail's line width and end
 * markers aren't clipped by the very edge of the screen.
 *
 * This is the whole of the horizontal budget on purpose (owner call,
 * 2026-08-07): the carousel is a 168-px deck floating in the TOP-RIGHT corner
 * (see `HeatPointCarousel`'s styles), and trail content passing *under* it is
 * accepted rather than paid for with a zoom-out. The fit before that call
 * inflated the bbox 25% and reserved 40–190 px per edge to clear the deck,
 * which landed roughly 1.5 zoom levels too far out.
 */
export const CAROUSEL_FIT_MARGIN_PX = 16;

/**
 * Padding for the multi-trail carousel fit: a bare {@link
 * CAROUSEL_FIT_MARGIN_PX} on every edge, with the top edge additionally
 * clearing the status bar / notch.
 *
 * Nothing here reserves room for the carousel deck itself — that is the point.
 */
export function carouselFitPadding(topInsetPx: number): FitPadding {
  return {
    top: Math.max(0, topInsetPx) + CAROUSEL_FIT_MARGIN_PX,
    right: CAROUSEL_FIT_MARGIN_PX,
    bottom: CAROUSEL_FIT_MARGIN_PX,
    left: CAROUSEL_FIT_MARGIN_PX,
  };
}

/** How a bbox ends up framed once fitted into a padded viewport. */
export interface BoundsFit {
  /** The zoom the fit settles on, clamped to `[minZoom, maxZoom]`. */
  zoom: number;
  /** Fraction of the FULL viewport width the bbox spans at `zoom` (0…1+). */
  widthFraction: number;
  /** Fraction of the FULL viewport height the bbox spans at `zoom` (0…1+). */
  heightFraction: number;
  /** Which axis pinned the zoom — the other one is left with slack. */
  limitedBy: 'width' | 'height' | 'none';
}

export interface FitOptions {
  /** Camera floor; MapLibre clamps the computed zoom to it. */
  minZoom?: number;
  /** Camera cap; a degenerate (single-point) bbox always lands here. */
  maxZoom?: number;
}

/**
 * The zoom and resulting screen coverage of `bbox` fitted into `viewport`
 * with `padding`, mirroring MapLibre's `cameraForLatLngBounds`.
 *
 * A viewport fully consumed by its padding, or a bbox with no extent in
 * either axis, degenerates gracefully: the former returns `minZoom`, the
 * latter `maxZoom` (matching MapLibre, which clamps rather than returning
 * ±Infinity).
 */
export function fitBoundsCamera(
  bbox: BoundingBox,
  viewport: FitViewport,
  padding: FitPadding,
  options: FitOptions = {},
): BoundsFit {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 22;

  const availableW = viewport.width - padding.left - padding.right;
  const availableH = viewport.height - padding.top - padding.bottom;

  // Normalized Web-Mercator extents: X is linear in longitude over 360°, Y is
  // the mercator-Y span (north edge is the SMALLER y, hence maxLat first).
  const spanX = Math.max(0, bbox.maxLng - bbox.minLng) / 360;
  const spanY = Math.max(0, latToMercatorY(bbox.minLat) - latToMercatorY(bbox.maxLat));

  const zoomX =
    spanX > 0 && availableW > 0
      ? Math.log2(availableW / (spanX * WORLD_PX_AT_ZOOM_0))
      : Number.POSITIVE_INFINITY;
  const zoomY =
    spanY > 0 && availableH > 0
      ? Math.log2(availableH / (spanY * WORLD_PX_AT_ZOOM_0))
      : Number.POSITIVE_INFINITY;

  const degenerateViewport = availableW <= 0 || availableH <= 0;
  const raw = Math.min(zoomX, zoomY);
  const zoom = degenerateViewport
    ? minZoom
    : Math.min(maxZoom, Math.max(minZoom, Number.isFinite(raw) ? raw : maxZoom));

  const worldPx = WORLD_PX_AT_ZOOM_0 * Math.pow(2, zoom);
  const widthFraction = viewport.width > 0 ? (spanX * worldPx) / viewport.width : 0;
  const heightFraction = viewport.height > 0 ? (spanY * worldPx) / viewport.height : 0;

  const limitedBy: BoundsFit['limitedBy'] =
    degenerateViewport || !Number.isFinite(raw) ? 'none' : zoomX <= zoomY ? 'width' : 'height';

  return { zoom, widthFraction, heightFraction, limitedBy };
}
