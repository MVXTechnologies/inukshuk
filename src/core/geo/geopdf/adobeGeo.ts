import type { CornerCoordinates, GeoReference, LngLat, PointRect } from '@core/models';
import { applyAffine, bboxFromCorners, fitAffine } from '@core/geo/geomath';
import { isMirroredSheet } from './orientation';
import { type Reprojector, epsgFromText, makeReprojector } from './crs';
import { pointRectFromPdfRect } from './pageBox';
import type { PdfDocument } from './pdfReader';
import { type PageInfo, readRect } from './pageTree';
import { type PdfArray, type PdfDict, type PdfValue, isArray, isDict, isName } from './types';

/**
 * Adobe ISO 32000 geospatial extraction.
 *
 * A page may carry a `/VP` array of Viewport dicts. Each viewport has:
 *   - `/BBox` — rectangle in page points bounding the georeferenced frame. Its
 *     corner ORDER matters: the LPTS unit square is anchored on it as written
 *     (see `bboxUnitToPage`), and some producers write it top-first (#487).
 *   - `/Measure` dict with `/Subtype /GEO`:
 *       - `/GPTS` — flat array of lat,lon pairs (GEOGRAPHIC, lat-first!) giving
 *         the geo positions of the /LPTS points
 *       - `/LPTS` — optional flat array of x,y in the unit square of the bbox,
 *         one point per GPTS pair, in the SAME order (per ISO 32000-2 it
 *         defaults to 0,0 0,1 1,1 1,0 — the bbox corners lower-left,
 *         upper-left, upper-right, lower-right). Producers do not agree on the
 *         order: Sépaq/Avenza-style sheets start at the upper-left, a UTM
 *         sheet from another tool went lower-left, lower-RIGHT, upper-right,
 *         upper-left with a 10 % inset. Pairing GPTS with the default order
 *         instead of the file's LPTS drew those flipped and transposed.
 *       - `/BOUNDS` — optional clip polygon in the same unit square. NOT the
 *         pairing key for GPTS (it was mistaken for one until #269).
 *       - `/GCS` — coordinate system dict (/EPSG, /WKT, or /Type /PROJCS|GEOGCS)
 *
 * `/BBox` is in page user space. The georeference records, in that same
 * space, the page's *rendered* box (`page.pageBox` — CropBox ∩ MediaBox), so
 * the overlay can map the viewport onto the pixels a renderer actually
 * produces rather than onto a zero-origin MediaBox (#287).
 *
 * Page `/Rotate` plays no part here: the rasterizer draws every page in
 * unrotated user space (`PDF_RASTER_ROTATION`), the same space as the BBox,
 * so the corners below are the rendered raster's corners whatever the page's
 * display rotation (see `orientation.ts`).
 */

function numArray(doc: PdfDocument, v: PdfValue | undefined): number[] | undefined {
  const a = doc.resolve(v);
  if (!isArray(a)) return undefined;
  const nums = (a as PdfArray).map((x) => Number(doc.resolve(x)));
  return nums.some((n) => Number.isNaN(n)) ? undefined : nums;
}

/** Resolve the GCS dict into a reprojector to WGS84. */
function reprojectorFromGcs(doc: PdfDocument, gcs: PdfValue | undefined): Reprojector {
  const d = doc.resolve(gcs);
  if (!isDict(d)) return makeReprojector({ epsg: 4326 });
  const dict = d as PdfDict;
  const epsgVal = doc.resolve(dict.entries.get('EPSG'));
  let epsg: number | undefined;
  if (typeof epsgVal === 'number') epsg = epsgVal;
  const wktVal = doc.resolve(dict.entries.get('WKT'));
  const wkt = typeof wktVal === 'string' ? wktVal : undefined;
  if (epsg == null) epsg = epsgFromText(wkt);
  // Some GCS dicts use /Type /PROJCS or /GEOGCS with a /WKT string only.
  return makeReprojector({ epsg, wkt });
}

/**
 * The page user-space point at unit-square `(u, v)` of a viewport `/BBox`.
 *
 * The unit square is anchored on the BBox **as written**: `u` runs from its
 * first x to its second, `v` from its first y to its second. That is GDAL's
 * reading, and the only one under which every real sheet comes out
 * unmirrored. Most producers write the BBox bottom-first (`[x0 y0 x1 y1]`),
 * but the 2024 USGS US Topo production writes it TOP-first — Beau Lake, Maine
 * has `/BBox [84.42 2088 1634.72 59.03]` — and lists its `/LPTS` against that
 * order: the first point, `(0, 1.00062)`, is the frame's LOWER-left and pairs
 * with the sheet's south-west GPTS. Reading `v = 1` as "the top" whatever
 * the BBox order flipped that sheet north–south, i.e. mirrored it (#487).
 */
export function bboxUnitToPage(
  bbox: readonly [number, number, number, number],
  u: number,
  v: number,
): [number, number] {
  const [bx0, by0, bx1, by1] = bbox;
  return [bx0 + u * (bx1 - bx0), by0 + v * (by1 - by0)];
}

/**
 * Map a viewport's frame to geographic corners using GPTS/LPTS. `bbox` is the
 * `/BBox` as written (it anchors the LPTS); `rect` is the same box normalized
 * (y1 = visual top of the unrotated raster). Returns corners of `rect` in
 * MapLibre visual-top-first order.
 */
function cornersFromMeasure(
  doc: PdfDocument,
  bbox: [number, number, number, number],
  rect: PointRect,
  measure: PdfDict,
): { corners: CornerCoordinates; epsg?: number } | undefined {
  const gpts = numArray(doc, measure.entries.get('GPTS'));
  if (!gpts || gpts.length < 6 || gpts.length % 2 !== 0) return undefined;

  // LPTS are the (x,y) unit-square points each GPTS pair belongs to, in the
  // file's own order. Only when the file omits them does the ISO default
  // apply: pairs 0,0 0,1 1,1 1,0 — bbox corners lower-left, upper-left,
  // upper-right, lower-right (trimmed to the GPTS pair count).
  let lpts = numArray(doc, measure.entries.get('LPTS'));
  if (!lpts || lpts.length !== gpts.length) {
    lpts = [0, 0, 0, 1, 1, 1, 1, 0].slice(0, gpts.length);
  }

  const reproj = reprojectorFromGcs(doc, measure.entries.get('GCS'));

  // Build (page x, page y) -> WGS84 lng/lat sample points. Going through page
  // space, not straight from the unit square, is what makes the result
  // independent of the order the producer wrote the BBox in (#487).
  const src: [number, number][] = [];
  const dst: LngLat[] = [];
  for (let i = 0; i + 1 < gpts.length; i += 2) {
    const lat = gpts[i]!;
    const lon = gpts[i + 1]!;
    const ux = lpts[i] ?? 0;
    const uy = lpts[i + 1] ?? 0;
    src.push(bboxUnitToPage(bbox, ux, uy));
    // Per ISO 32000-2, GPTS are ALWAYS geographic lat/lon degrees, even when the
    // /GCS dict names a projected EPSG (e.g. a UTM zone). They are NOT in the
    // projected CRS's units, so they must be used as lon/lat directly — never
    // pushed through the reprojector (doing so treats ~45°/-69° as UTM metres and
    // collapses the whole page to a degenerate point near (central-meridian, 0)).
    dst.push([lon, lat]);
  }

  // Map each frame corner (in page space) through an affine fit of src->dst.
  const toGeo = affineFromPage(src, dst);
  if (!toGeo) return undefined;

  // `rect` is normalized, so y1 is the visual top of the unrotated raster.
  const corners: CornerCoordinates = {
    topLeft: toGeo(rect.x0, rect.y1),
    topRight: toGeo(rect.x1, rect.y1),
    bottomRight: toGeo(rect.x1, rect.y0),
    bottomLeft: toGeo(rect.x0, rect.y0),
  };
  return { corners, epsg: reproj.epsg };
}

/**
 * Fit an affine from page-space sample points to lng/lat. With the typical 4
 * corner samples this is exact; with 3+ it least-squares fits.
 */
function affineFromPage(
  src: [number, number][],
  dst: LngLat[],
): ((x: number, y: number) => LngLat) | undefined {
  if (src.length < 3) return undefined;
  try {
    const t = fitAffine(src, dst as readonly (readonly [number, number])[]);
    return (x: number, y: number) => applyAffine(t, x, y) as LngLat;
  } catch {
    return undefined;
  }
}

/** Extract all Adobe-geo georeferences from a single page. */
export function extractAdobeGeo(
  doc: PdfDocument,
  page: PageInfo,
  warnings: string[],
): GeoReference[] {
  const out: GeoReference[] = [];
  const vp = doc.resolve(page.dict.entries.get('VP'));
  if (!isArray(vp)) return out;

  const pageBox = pointRectFromPdfRect(page.pageBox);
  const pageWidthPt = pageBox.x1 - pageBox.x0;
  const pageHeightPt = pageBox.y1 - pageBox.y0;

  for (const vpEntry of vp as PdfArray) {
    const vd = doc.resolve(vpEntry);
    if (!isDict(vd)) continue;
    const measure = doc.resolve((vd as PdfDict).entries.get('Measure'));
    if (!isDict(measure)) continue;
    const subtype = (measure as PdfDict).entries.get('Subtype');
    if (!(subtype && isName(subtype) && subtype.name === 'GEO')) continue;

    // A viewport without a /BBox (it is required, but producers slip) frames
    // the whole rendered page, not the MediaBox.
    const bbox = readRect(doc, (vd as PdfDict).entries.get('BBox')) ?? page.pageBox;
    const rect: PointRect = {
      x0: Math.min(bbox[0], bbox[2]),
      y0: Math.min(bbox[1], bbox[3]),
      x1: Math.max(bbox[0], bbox[2]),
      y1: Math.max(bbox[1], bbox[3]),
    };
    const result = cornersFromMeasure(doc, bbox, rect, measure as PdfDict);
    if (!result) {
      warnings.push(`page ${page.index}: VP/Measure GEO present but GPTS unusable`);
      continue;
    }
    if (isMirroredSheet(result.corners)) {
      // No printed map is a mirror image: this is the producer and this parser
      // disagreeing about the point order. Say so instead of drawing it quietly.
      warnings.push(`page ${page.index}: georeference is mirrored (check /BBox and /LPTS order)`);
    }

    const ref: GeoReference = {
      pageIndex: page.index,
      source: 'adobe-geo',
      sourceEpsg: result.epsg,
      pageWidthPt,
      pageHeightPt,
      pageBox,
      viewport: { rect, corners: result.corners },
      bbox: bboxFromCorners(result.corners),
    };
    out.push(ref);
  }
  return out;
}
