import type { CornerCoordinates, GeoReference, LngLat, PointRect } from '@core/models';
import { applyAffine, bboxFromCorners, fitAffine } from '@core/geo/geomath';
import { epsgFromText, makeReprojector } from './crs';

/**
 * Sidecar GDAL `.aux.xml`. We extract:
 *   - <SRS>...</SRS> — a WKT/EPSG string for the CRS.
 *   - <GeoTransform> a, b, c, d, e, f </GeoTransform> — GDAL affine where
 *       geoX = a + b*col + c*row ;  geoY = d + e*col + f*row    (top-left origin)
 *   - else <GCP Pixel=".." Line=".." X=".." Y=".." /> control points.
 *
 * We avoid an XML library: tiny regex extraction is enough for this fixed shape.
 */
export function parseAuxXml(args: {
  xmlText: string;
  rasterWidthPx: number;
  rasterHeightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  pageIndex?: number;
}): GeoReference {
  const { xmlText, rasterWidthPx, rasterHeightPx, pageWidthPt, pageHeightPt, pageIndex = 0 } = args;

  const srs = extractTag(xmlText, 'SRS');
  const epsg = epsgFromText(srs);
  const reproj = makeReprojector({ epsg, wkt: srs });

  const toWgs = (gx: number, gy: number): LngLat =>
    reproj.isWgs84 ? [gx, gy] : reproj.toWgs84(gx, gy);

  const gtText = extractTag(xmlText, 'GeoTransform');
  let pixelToGeo: ((col: number, row: number) => [number, number]) | undefined;

  if (gtText) {
    const gt = gtText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number);
    if (gt.length >= 6 && !gt.slice(0, 6).some((n) => Number.isNaN(n))) {
      const [a, b, c, d, e, f] = gt as [number, number, number, number, number, number];
      pixelToGeo = (col, row) => [a + b * col + c * row, d + e * col + f * row];
    }
  }

  if (!pixelToGeo) {
    // Try GCPs.
    const gcps = extractGcps(xmlText);
    if (gcps.length >= 3) {
      const src = gcps.map((g) => [g.pixel, g.line] as [number, number]);
      const dst = gcps.map((g) => [g.x, g.y] as [number, number]);
      const t = fitAffine(src, dst);
      pixelToGeo = (col, row) => applyAffine(t, col, row) as [number, number];
    }
  }

  if (!pixelToGeo) {
    throw new Error('aux.xml has neither a usable GeoTransform nor >=3 GCPs');
  }

  // Raster corners (top-left origin) -> WGS84.
  const corners: CornerCoordinates = {
    topLeft: toWgs(...pixelToGeo(0, 0)),
    topRight: toWgs(...pixelToGeo(rasterWidthPx, 0)),
    bottomRight: toWgs(...pixelToGeo(rasterWidthPx, rasterHeightPx)),
    bottomLeft: toWgs(...pixelToGeo(0, rasterHeightPx)),
  };

  // A sidecar georeferences the rendered raster as a whole, so the frame and
  // the rendered page box are the same zero-origin rectangle.
  const rect: PointRect = { x0: 0, y0: 0, x1: pageWidthPt, y1: pageHeightPt };

  return {
    pageIndex,
    source: 'aux-xml',
    sourceEpsg: epsg,
    pageWidthPt,
    pageHeightPt,
    pageBox: { ...rect },
    viewport: { rect, corners },
    bbox: bboxFromCorners(corners),
  };
}

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1]!.trim() : undefined;
}

interface Gcp {
  pixel: number;
  line: number;
  x: number;
  y: number;
}

function extractGcps(xml: string): Gcp[] {
  const out: Gcp[] = [];
  const re = /<GCP\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]!;
    const pixel = attrNum(attrs, 'Pixel');
    const line = attrNum(attrs, 'Line');
    const x = attrNum(attrs, 'X');
    const y = attrNum(attrs, 'Y');
    if ([pixel, line, x, y].every((n) => !Number.isNaN(n))) {
      out.push({ pixel, line, x, y });
    }
  }
  return out;
}

function attrNum(attrs: string, name: string): number {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? Number(m[1]) : NaN;
}
