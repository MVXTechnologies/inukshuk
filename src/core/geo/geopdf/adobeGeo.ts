import type { CornerCoordinates, GeoReference, LngLat, PointRect } from '@core/models';
import { applyAffine, bboxFromCorners, fitAffine } from '@core/geo/geomath';
import { type Reprojector, epsgFromText, makeReprojector } from './crs';
import type { PdfDocument } from './pdfReader';
import { readRect } from './pageTree';
import { type PdfArray, type PdfDict, type PdfValue, isArray, isDict, isName } from './types';

/**
 * Adobe ISO 32000 geospatial extraction.
 *
 * A page may carry a `/VP` array of Viewport dicts. Each viewport has:
 *   - `/BBox` — rectangle in page points bounding the georeferenced frame
 *   - `/Measure` dict with `/Subtype /GEO`:
 *       - `/GPTS` — flat array of lat,lon pairs (GEOGRAPHIC, lat-first!) giving
 *         the geo positions of /BOUNDS points in the unit square of the bbox
 *       - `/BOUNDS` — optional flat array of x,y in [0,1] (per ISO 32000 it
 *         defaults to 0,0 0,1 1,1 1,0 — the bbox corners lower-left,
 *         upper-left, upper-right, lower-right)
 *       - `/GCS` — coordinate system dict (/EPSG, /WKT, or /Type /PROJCS|GEOGCS)
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
 * Map a viewport's bbox corners to geographic corners using GPTS/BOUNDS.
 * Returns corners in MapLibre visual-top-first order.
 */
function cornersFromMeasure(
  doc: PdfDocument,
  bbox: [number, number, number, number],
  measure: PdfDict,
): { corners: CornerCoordinates; epsg?: number } | undefined {
  const gpts = numArray(doc, measure.entries.get('GPTS'));
  if (!gpts || gpts.length < 6 || gpts.length % 2 !== 0) return undefined;

  // BOUNDS are (x,y) pairs in the unit square; default to the four bbox corners.
  let bounds = numArray(doc, measure.entries.get('BOUNDS'));
  if (!bounds || bounds.length !== gpts.length) {
    // ISO 32000 default: pairs 0,0 0,1 1,1 1,0 — bbox corners lower-left,
    // upper-left, upper-right, lower-right. Trim to match the GPTS pair count.
    bounds = [0, 0, 0, 1, 1, 1, 1, 0].slice(0, gpts.length);
  }

  const reproj = reprojectorFromGcs(doc, measure.entries.get('GCS'));

  const [bx0, by0, bx1, by1] = bbox;
  const w = bx1 - bx0;
  const h = by1 - by0;

  // Build (unitX, unitY) -> WGS84 lng/lat sample points.
  const src: [number, number][] = [];
  const dst: LngLat[] = [];
  for (let i = 0; i + 1 < gpts.length; i += 2) {
    const lat = gpts[i]!;
    const lon = gpts[i + 1]!;
    const ux = bounds[i] ?? 0;
    const uy = bounds[i + 1] ?? 0;
    src.push([ux, uy]);
    // Per ISO 32000-2, GPTS are ALWAYS geographic lat/lon degrees, even when the
    // /GCS dict names a projected EPSG (e.g. a UTM zone). They are NOT in the
    // projected CRS's units, so they must be used as lon/lat directly — never
    // pushed through the reprojector (doing so treats ~45°/-69° as UTM metres and
    // collapses the whole page to a degenerate point near (central-meridian, 0)).
    dst.push([lon, lat]);
  }

  // Map each bbox corner (in unit space) through an affine fit of src->dst.
  const toGeo = affineFromUnit(src, dst);
  if (!toGeo) return undefined;

  const cornerUnit = {
    topLeft: [0, 1] as [number, number], // larger Y = visual top
    topRight: [1, 1] as [number, number],
    bottomRight: [1, 0] as [number, number],
    bottomLeft: [0, 0] as [number, number],
  };
  void w;
  void h;
  const corners: CornerCoordinates = {
    topLeft: toGeo(cornerUnit.topLeft[0], cornerUnit.topLeft[1]),
    topRight: toGeo(cornerUnit.topRight[0], cornerUnit.topRight[1]),
    bottomRight: toGeo(cornerUnit.bottomRight[0], cornerUnit.bottomRight[1]),
    bottomLeft: toGeo(cornerUnit.bottomLeft[0], cornerUnit.bottomLeft[1]),
  };
  return { corners, epsg: reproj.epsg };
}

/**
 * Fit an affine from unit-square sample points to lng/lat. With the typical 4
 * corner samples this is exact; with 3+ it least-squares fits. Uses the shared
 * geomath fitAffine via a tiny local solver to avoid import cycles.
 */
function affineFromUnit(
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
  page: { index: number; dict: PdfDict; mediaBox: [number, number, number, number] },
  warnings: string[],
): GeoReference[] {
  const out: GeoReference[] = [];
  const vp = doc.resolve(page.dict.entries.get('VP'));
  if (!isArray(vp)) return out;

  const [mx0, my0, mx1, my1] = page.mediaBox;
  const pageWidthPt = Math.abs(mx1 - mx0);
  const pageHeightPt = Math.abs(my1 - my0);

  for (const vpEntry of vp as PdfArray) {
    const vd = doc.resolve(vpEntry);
    if (!isDict(vd)) continue;
    const measure = doc.resolve((vd as PdfDict).entries.get('Measure'));
    if (!isDict(measure)) continue;
    const subtype = (measure as PdfDict).entries.get('Subtype');
    if (!(subtype && isName(subtype) && subtype.name === 'GEO')) continue;

    const bbox = readRect(doc, (vd as PdfDict).entries.get('BBox')) ?? page.mediaBox;
    const result = cornersFromMeasure(doc, bbox, measure as PdfDict);
    if (!result) {
      warnings.push(`page ${page.index}: VP/Measure GEO present but GPTS unusable`);
      continue;
    }

    const rect: PointRect = {
      x0: Math.min(bbox[0], bbox[2]),
      y0: Math.min(bbox[1], bbox[3]),
      x1: Math.max(bbox[0], bbox[2]),
      y1: Math.max(bbox[1], bbox[3]),
    };
    const ref: GeoReference = {
      pageIndex: page.index,
      source: 'adobe-geo',
      sourceEpsg: result.epsg,
      pageWidthPt,
      pageHeightPt,
      viewport: { rect, corners: result.corners },
      bbox: bboxFromCorners(result.corners),
    };
    out.push(ref);
  }
  return out;
}
