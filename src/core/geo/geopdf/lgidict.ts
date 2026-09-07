import type { CornerCoordinates, GeoReference, LngLat, PointRect } from '@core/models';
import { applyAffine, bboxFromCorners, fitAffine } from '@core/geo/geomath';
import {
  type LgiProjection,
  type ResolvedCrs,
  type Reprojector,
  WGS84,
  makeReprojector,
  resolveLgiProjection,
} from './crs';
import type { PdfDocument } from './pdfReader';
import { type PdfArray, type PdfDict, type PdfValue, isArray, isDict, isName } from './types';

/**
 * OGC Best-Practice / TerraGo LGIDict extraction.
 *
 * A page may carry a `/LGIDict` (single dict or array of dicts). Keys we use:
 *   - `/Registration` — array of control points. Each is an array of 2 strings
 *     (page x,y) + 2 strings (geo x,y), or numbers. We map page points -> CRS
 *     with fitAffine, then reproject the result to WGS84.
 *   - `/Neatline` — flat/grouped array of page-space x,y points bounding the map
 *     frame. Its bbox becomes viewport.rect.
 *   - `/Projection` — {/ProjectionType, /Datum, /Zone, /Hemisphere, /EPSG ...}.
 *   - `/CTM` — page->geo transform (6 numbers); used if Registration is absent.
 */

function asNum(v: PdfValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v.trim());
  return NaN;
}

function nameOf(v: PdfValue | undefined): string | undefined {
  return v && isName(v) ? v.name : typeof v === 'string' ? v : undefined;
}

/** A number from the dict, or undefined — LGIDict writes them as PDF strings. */
function optionalNum(doc: PdfDocument, v: PdfValue | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = asNum(doc.resolve(v));
  return Number.isFinite(n) ? n : undefined;
}

/** Read an LGIDict `/Projection` sub-dict into its parameters. */
function readProjection(doc: PdfDocument, projVal: PdfValue | undefined): LgiProjection | null {
  const proj = doc.resolve(projVal);
  if (!isDict(proj)) return null;
  const e = (proj as PdfDict).entries;
  const str = (key: string): string | undefined => nameOf(doc.resolve(e.get(key)));
  const num = (key: string): number | undefined => optionalNum(doc, e.get(key));
  const params: LgiProjection = {};
  const set = <K extends keyof LgiProjection>(key: K, value: LgiProjection[K]): void => {
    if (value !== undefined) params[key] = value;
  };
  set('projectionType', str('ProjectionType'));
  set('datum', str('Datum'));
  set('hemisphere', str('Hemisphere'));
  set('wkt', str('WKT'));
  set('zone', num('Zone'));
  set('epsg', num('EPSG'));
  set('centralMeridian', num('CentralMeridian'));
  set('originLatitude', num('OriginLatitude'));
  set('scaleFactor', num('ScaleFactor'));
  set('falseEasting', num('FalseEasting'));
  set('falseNorthing', num('FalseNorthing'));
  set('standardParallelOne', num('StandardParallelOne'));
  set('standardParallelTwo', num('StandardParallelTwo'));
  return params;
}

/**
 * Resolve a reprojector from an LGIDict `/Projection` sub-dict, together with
 * the CRS string to report it under. `crs.proj4Def === null` means we could not
 * place this projection at all — the caller records that on the georeference so
 * the Library card and the error report can name it (#243).
 */
function crsFromProjection(
  doc: PdfDocument,
  projVal: PdfValue | undefined,
): { reproj: Reprojector; crs: ResolvedCrs } {
  const params = readProjection(doc, projVal);
  if (!params) {
    // No /Projection dict at all: the OGC BP default is geographic WGS84.
    return {
      reproj: makeReprojector({ epsg: 4326 }),
      crs: { proj4Def: WGS84, epsg: 4326, label: 'Geographic lon/lat (WGS 84)' },
    };
  }
  const crs = resolveLgiProjection(params);
  const reproj = makeReprojector({
    ...(crs.epsg === undefined ? {} : { epsg: crs.epsg }),
    ...(crs.proj4Def === null ? {} : { proj4Def: crs.proj4Def }),
  });
  return { reproj, crs };
}

/** Read /Registration into matched page->geo point pairs. */
function readRegistration(
  doc: PdfDocument,
  regVal: PdfValue | undefined,
): { page: [number, number][]; geo: [number, number][] } | undefined {
  const reg = doc.resolve(regVal);
  if (!isArray(reg)) return undefined;
  const page: [number, number][] = [];
  const geo: [number, number][] = [];
  for (const ptVal of reg as PdfArray) {
    const pt = doc.resolve(ptVal);
    if (!isArray(pt)) continue;
    const nums = (pt as PdfArray).map((x) => asNum(doc.resolve(x)));
    if (nums.length < 4 || nums.slice(0, 4).some((n) => Number.isNaN(n))) continue;
    page.push([nums[0]!, nums[1]!]);
    geo.push([nums[2]!, nums[3]!]);
  }
  if (page.length < 3) return undefined;
  return { page, geo };
}

/** Read /Neatline into a list of page-space points. */
function readNeatline(doc: PdfDocument, nlVal: PdfValue | undefined): [number, number][] {
  const nl = doc.resolve(nlVal);
  if (!isArray(nl)) return [];
  const flat = (nl as PdfArray).map((x) => asNum(doc.resolve(x)));
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (!Number.isNaN(flat[i]!) && !Number.isNaN(flat[i + 1]!)) {
      pts.push([flat[i]!, flat[i + 1]!]);
    }
  }
  return pts;
}

function bboxOfPoints(pts: [number, number][]): PointRect | undefined {
  if (pts.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Build one GeoReference from a single LGIDict dictionary. */
function fromOneLgiDict(
  doc: PdfDocument,
  lgi: PdfDict,
  page: { index: number; mediaBox: [number, number, number, number] },
  warnings: string[],
): GeoReference | undefined {
  const { reproj, crs } = crsFromProjection(doc, lgi.entries.get('Projection'));
  if (crs.proj4Def === null) {
    // Not fatal — the georeference is still emitted, with its corners left in
    // the native CRS and `sourceCrs` naming it, so the Library card can say
    // "Map projection not supported (...)" rather than showing nothing (#243).
    warnings.push(`page ${page.index}: unsupported map projection (${crs.label})`);
  }

  const [mx0, my0, mx1, my1] = page.mediaBox;
  const pageWidthPt = Math.abs(mx1 - mx0);
  const pageHeightPt = Math.abs(my1 - my0);

  // Viewport rect: neatline bbox or whole MediaBox.
  const neatPts = readNeatline(doc, lgi.entries.get('Neatline'));
  const rect: PointRect = bboxOfPoints(neatPts) ?? {
    x0: Math.min(mx0, mx1),
    y0: Math.min(my0, my1),
    x1: Math.max(mx0, mx1),
    y1: Math.max(my0, my1),
  };

  // page->geo affine: prefer /Registration, else /CTM.
  let pageToGeo: ((x: number, y: number) => [number, number]) | undefined;
  const reg = readRegistration(doc, lgi.entries.get('Registration'));
  if (reg) {
    try {
      const t = fitAffine(reg.page, reg.geo);
      pageToGeo = (x, y) => applyAffine(t, x, y);
    } catch (e) {
      warnings.push(`page ${page.index}: LGIDict registration degenerate: ${(e as Error).message}`);
    }
  }
  if (!pageToGeo) {
    const ctm = doc.resolve(lgi.entries.get('CTM'));
    if (isArray(ctm)) {
      const c = (ctm as PdfArray).map((x) => asNum(doc.resolve(x)));
      if (c.length >= 6 && !c.slice(0, 6).some((n) => Number.isNaN(n))) {
        // CTM is [a b c d e f] mapping page->geo as a*x+c*y+e, b*x+d*y+f.
        pageToGeo = (x, y) => [c[0]! * x + c[2]! * y + c[4]!, c[1]! * x + c[3]! * y + c[5]!];
      }
    }
  }
  if (!pageToGeo) {
    warnings.push(`page ${page.index}: LGIDict has no usable Registration/CTM`);
    return undefined;
  }

  const toWgs = (x: number, y: number): LngLat => {
    const [gx, gy] = pageToGeo!(x, y);
    return reproj.isWgs84 ? [gx, gy] : reproj.toWgs84(gx, gy);
  };

  const corners: CornerCoordinates = {
    topLeft: toWgs(rect.x0, rect.y1),
    topRight: toWgs(rect.x1, rect.y1),
    bottomRight: toWgs(rect.x1, rect.y0),
    bottomLeft: toWgs(rect.x0, rect.y0),
  };

  return {
    pageIndex: page.index,
    source: 'lgidict',
    sourceEpsg: reproj.epsg,
    sourceCrs: crs.label,
    pageWidthPt,
    pageHeightPt,
    viewport: { rect, corners },
    bbox: bboxFromCorners(corners),
  };
}

/** Extract all LGIDict georeferences from a single page. */
export function extractLgiDict(
  doc: PdfDocument,
  page: { index: number; dict: PdfDict; mediaBox: [number, number, number, number] },
  warnings: string[],
): GeoReference[] {
  const lgiVal = doc.resolve(page.dict.entries.get('LGIDict'));
  if (!lgiVal) return [];
  const dicts: PdfDict[] = [];
  if (isArray(lgiVal)) {
    for (const d of lgiVal as PdfArray) {
      const rd = doc.resolve(d);
      if (isDict(rd)) dicts.push(rd as PdfDict);
    }
  } else if (isDict(lgiVal)) {
    dicts.push(lgiVal as PdfDict);
  }
  const out: GeoReference[] = [];
  for (const d of dicts) {
    const ref = fromOneLgiDict(doc, d, page, warnings);
    if (ref) out.push(ref);
  }
  return out;
}
