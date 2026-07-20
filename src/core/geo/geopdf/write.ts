import type { CornerCoordinates } from '@core/models';
import { PDFName, type PDFDocument, type PDFPage } from 'pdf-lib';

/**
 * GeoPDF *writer* — the inverse of `adobeGeo.ts`. Attaches an ISO 32000-2
 * `/VP` viewport with a `/Measure /GEO` dictionary to a pdf-lib page so the
 * map frame of a made map is georeferenced. Written strictly in the dialect
 * our own parser reads (and Avenza/QGIS/CalTopo understand):
 *
 *   - `/BBox` — the map frame in page points (origin bottom-left)
 *   - `/GPTS` — geographic corners as LAT,LON pairs (lat first, per spec)
 *   - `/BOUNDS` — matching unit-square points, ISO default order:
 *     lower-left, upper-left, upper-right, lower-right
 *   - `/GCS` — `{ /Type /GEOGCS, /EPSG 4326 }` (WGS84)
 *
 * The round-trip test in `write.test.ts` parses the result with
 * `parseGeoPdf`, which is exactly what the Library import runs on the file.
 */

export interface MapFrameRect {
  /** Origin bottom-left, PDF points. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function attachGeoViewport(
  doc: PDFDocument,
  page: PDFPage,
  mapRect: MapFrameRect,
  corners: CornerCoordinates,
): void {
  // BOUNDS unit points in ISO default order with their matching lat,lon GPTS.
  const ring = [
    { u: [0, 0], c: corners.bottomLeft },
    { u: [0, 1], c: corners.topLeft },
    { u: [1, 1], c: corners.topRight },
    { u: [1, 0], c: corners.bottomRight },
  ];
  const gpts = ring.flatMap(({ c: [lng, lat] }) => [lat, lng]);
  const bounds = ring.flatMap(({ u }) => u);

  const viewport = doc.context.obj({
    Type: 'Viewport',
    BBox: [mapRect.x, mapRect.y, mapRect.x + mapRect.w, mapRect.y + mapRect.h],
    Name: 'Map',
    Measure: {
      Type: 'Measure',
      Subtype: 'GEO',
      GPTS: gpts,
      BOUNDS: bounds,
      GCS: { Type: 'GEOGCS', EPSG: 4326 },
    },
  });

  page.node.set(PDFName.of('VP'), doc.context.obj([viewport]));
}
