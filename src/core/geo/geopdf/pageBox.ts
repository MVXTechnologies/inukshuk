import type { CornerCoordinates, GeoReference, PointRect } from '@core/models';
import { extrapolatePageCorners } from '@core/geo/geomath';

/**
 * The *rendered page box* — the one rectangle every render path agrees on.
 *
 * A PDF page has several boxes. The georeferencing (`/VP` `/BBox`, LGIDict
 * `/Neatline` and `/Registration`) is written in page user space, whose origin
 * is wherever the MediaBox says it is. But what actually gets drawn — by
 * pdf.js (`page.view`), Android `PdfRenderer` and CoreGraphics alike — is the
 * CropBox intersected with the MediaBox. The overlay pipeline used to assume
 * the two were the same rectangle anchored at (0, 0), so a page with
 * `/MediaBox [0 0 200 100] /CropBox [50 25 150 75]` rendered its 100×50 pt
 * crop while the placement math stretched that image over the 200×100 pt
 * MediaBox: twice the intended extent, and offset (#287, audit A02 in #275).
 *
 * Everything here is pure geometry so the parser, the overview placement, the
 * detail-tile planner and the native hand-off gate can share one definition.
 */

/** A PDF rectangle `[x0, y0, x1, y1]` in user-space points. */
export type PdfRect = [number, number, number, number];

/** What pdf.js falls back to for a page with no usable MediaBox (US Letter). */
export const DEFAULT_MEDIABOX: PdfRect = [0, 0, 612, 792];

/**
 * A rectangle with its corners ordered (x0 < x1, y0 < y1) and a positive area,
 * or `undefined` when the input is not a usable box. Mirrors pdf.js's
 * `_getBoundingBox`: producers do write `[x1 y1 x0 y0]` and degenerate boxes.
 */
export function normalizePdfRect(rect: readonly number[] | undefined): PdfRect | undefined {
  if (!rect || rect.length < 4) return undefined;
  const [a, b, c, d] = rect as unknown as PdfRect;
  if (![a, b, c, d].every(Number.isFinite)) return undefined;
  const box: PdfRect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : undefined;
}

/**
 * The box a renderer draws for a page: CropBox ∩ MediaBox, normalized; the
 * MediaBox alone when there is no CropBox or the intersection is empty; US
 * Letter when even the MediaBox is unusable. This is exactly pdf.js's
 * `page.view`, which is what the WebView rasterizes, and matches pdfium
 * (Android) and CoreGraphics (iOS) page sizing.
 */
export function effectivePageBox(
  mediaBox: readonly number[] | undefined,
  cropBox: readonly number[] | undefined,
): PdfRect {
  const media = normalizePdfRect(mediaBox) ?? DEFAULT_MEDIABOX;
  const crop = normalizePdfRect(cropBox);
  if (!crop) return media;
  const box: PdfRect = [
    Math.max(media[0], crop[0]),
    Math.max(media[1], crop[1]),
    Math.min(media[2], crop[2]),
    Math.min(media[3], crop[3]),
  ];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : media;
}

/** `[x0, y0, x1, y1]` as the model's `PointRect`. */
export function pointRectFromPdfRect([x0, y0, x1, y1]: PdfRect): PointRect {
  return { x0, y0, x1, y1 };
}

type PlacementInput = Pick<GeoReference, 'pageWidthPt' | 'pageHeightPt' | 'pageBox'>;

/**
 * The rectangle, in the same user space as `viewport.rect`, that the rendered
 * raster's pixels span. `pageBox` when the document carries it; otherwise the
 * pre-#287 assumption of a zero-origin box of the recorded size, so a map
 * imported by an older build is placed exactly as it was before the fix.
 */
export function renderedPageRect(geo: PlacementInput): PointRect {
  return geo.pageBox ?? { x0: 0, y0: 0, x1: geo.pageWidthPt, y1: geo.pageHeightPt };
}

/**
 * Geographic corners of the rendered raster: the viewport's corner
 * correspondences extrapolated affinely to the rendered page box. Feed these
 * to MapLibre's `ImageSource` (top-left, top-right, bottom-right, bottom-left)
 * and to the detail-tile planner, which subdivides this same image.
 */
export function renderedPageCorners(
  geo: PlacementInput & Pick<GeoReference, 'viewport'>,
): CornerCoordinates {
  return extrapolatePageCorners(geo.viewport.rect, geo.viewport.corners, renderedPageRect(geo));
}

/**
 * The page dimensions the native renderers (Android `PdfRenderer`, iOS
 * JPEG/mosaic crops) must find before they are allowed to draw a page, or
 * `null` when the page can never be handed to them.
 *
 * Both native paths only accept a page whose CropBox equals its MediaBox with
 * the origin at (0, 0) — anything else goes through pdf.js, which handles
 * arbitrary boxes. A rendered box with a nonzero origin is therefore refused
 * here, up front, instead of paying for a WebView geometry probe that is
 * guaranteed to decline. The sizes are the rendered box's, so on the accepted
 * path the native crop fractions and the placement refer to the same box.
 */
export function nativePageGeometry(
  geo: PlacementInput,
): { expectedPageWidthPt: number; expectedPageHeightPt: number } | null {
  const rect = renderedPageRect(geo);
  if (rect.x0 !== 0 || rect.y0 !== 0) return null;
  return { expectedPageWidthPt: rect.x1 - rect.x0, expectedPageHeightPt: rect.y1 - rect.y0 };
}

/**
 * True for a georeference persisted before #287: it never recorded the
 * rendered page box, so its placement still assumes a zero-origin MediaBox.
 * That is correct for every sheet whose CropBox is absent or equal to its
 * MediaBox (all the known Sépaq / NRCan / USGS sources), and wrong only for
 * cropped or shifted pages — which cannot be told apart without re-parsing
 * the PDF. Re-importing the map records the box and clears this flag.
 */
export function needsPageBoxReprocessing(geo: PlacementInput): boolean {
  return geo.pageBox === undefined;
}
