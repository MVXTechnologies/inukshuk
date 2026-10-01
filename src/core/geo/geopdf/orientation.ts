import type { CornerCoordinates, PointRect } from '@core/models';
import { bboxFromCorners, cornersAreMirrored } from '@core/geo/geomath';

/**
 * How a georeferenced page's raster is oriented, in one place.
 *
 * Two things decide which way up a PDF map lands on the map:
 *
 *  1. **The raster.** The WebView rasterizer asks pdf.js for a viewport with
 *     `rotation: PDF_RASTER_ROTATION` (0), overriding the page's `/Rotate`
 *     display flag. Pixel (0, 0) is therefore always the rendered page box's
 *     user-space top-left `(x0, y1)`, x growing right and y growing DOWN —
 *     `rasterPixelOfPagePoint` below, pinned against real pdf.js in
 *     `orientation.pdfjs.test.ts`. The native renderers are only used for
 *     pages whose `/Rotate` is 0, so they agree.
 *  2. **The georeference.** `/VP` BBox + LPTS/GPTS and LGIDict registration are
 *     all written in that same unrotated user space, so the parser can compute
 *     the geographic position of each RASTER corner directly. MapLibre's
 *     ImageSource takes exactly those (top-left, top-right, bottom-right,
 *     bottom-left of the image), and warps the raster onto them — a sheet
 *     whose content was laid out sideways for a `/Rotate 90` display still
 *     lands north-up, because its corners say where each pixel belongs.
 *
 * `/Rotate` is thus deliberately NOT applied on either side. Applying it on
 * one side only is what makes a rotated page draw flipped or transposed.
 * `displayedCorners` answers the complementary question — where the corners of
 * the page AS A PDF VIEWER SHOWS IT fall — which is how the map-standards suite
 * checks that every sheet comes out as its producer intended.
 */

/** The rotation the rasterizer passes to pdf.js `getViewport`. Never `/Rotate`. */
export const PDF_RASTER_ROTATION = 0;

/** A page `/Rotate`, normalized the way pdf.js does it. */
export type PageRotation = 0 | 90 | 180 | 270;

/**
 * Normalize a `/Rotate` value: multiples of 90 are reduced into 0..270 (so
 * -90 is 270); anything else — absent, not a number, not a multiple of 90 —
 * is ignored as 0, as pdf.js does.
 */
export function normalizePageRotation(value: unknown): PageRotation {
  if (typeof value !== 'number' || !Number.isFinite(value) || value % 90 !== 0) return 0;
  return (((value % 360) + 360) % 360) as PageRotation;
}

/**
 * Pixel position, in a raster of the page box `box` rendered at `scale`
 * pixels per point with `PDF_RASTER_ROTATION`, of the user-space point
 * `(x, y)`. Mirrors pdf.js's `PageViewport` transform for rotation 0.
 */
export function rasterPixelOfPagePoint(
  box: PointRect,
  scale: number,
  x: number,
  y: number,
): [number, number] {
  return [scale * (x - box.x0), scale * (box.y1 - y)];
}

/**
 * Geographic corners of the page as a viewer displays it — the raster turned
 * clockwise by `rotation` — given the corners of the unrotated raster.
 * Turning an image a quarter clockwise brings its bottom-left corner to the
 * top-left, and so on round.
 */
export function displayedCorners(
  raster: CornerCoordinates,
  rotation: PageRotation,
): CornerCoordinates {
  const ring = [raster.topLeft, raster.topRight, raster.bottomRight, raster.bottomLeft];
  const shift = rotation / 90;
  const at = (i: number) => ring[(i - shift + 4) % 4]!;
  return { topLeft: at(0), topRight: at(1), bottomRight: at(2), bottomLeft: at(3) };
}

/**
 * Widest frame, in degrees of latitude or longitude, the mirror check trusts.
 * Real sheets are far smaller (a 1:1 000 000 sheet spans 6°×4°); the
 * continent-wide locator insets some producers add (a CanTopo sheet maps all
 * of Canada in Lambert conformal, its top corners past the pole) are not
 * quadrilaterals on the ground, so their corner winding means nothing.
 */
export const MIRROR_CHECK_MAX_SPAN_DEG = 15;

/**
 * True when a sheet-sized georeference would draw its raster mirrored — the
 * signature of a point-order mistake, since no printed map is a mirror image.
 * Frames wider than `MIRROR_CHECK_MAX_SPAN_DEG` are never flagged.
 */
export function isMirroredSheet(corners: CornerCoordinates): boolean {
  const b = bboxFromCorners(corners);
  const local =
    b.maxLat - b.minLat <= MIRROR_CHECK_MAX_SPAN_DEG &&
    b.maxLng - b.minLng <= MIRROR_CHECK_MAX_SPAN_DEG;
  return local && cornersAreMirrored(corners);
}
