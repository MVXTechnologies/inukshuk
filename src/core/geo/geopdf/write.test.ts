import { PDFDocument } from 'pdf-lib';
import { parseGeoPdf } from './index';
import { attachGeoViewport } from './write';
import type { CornerCoordinates } from '@core/models';

/**
 * Round-trip acceptance test: a viewport written by `attachGeoViewport` must
 * come back byte-identical in meaning through our own GeoPDF parser — the
 * same code path every made map takes on import.
 */
const CORNERS: CornerCoordinates = {
  topLeft: [-71.35, 46.8],
  topRight: [-71.2, 46.8],
  bottomRight: [-71.2, 46.75],
  bottomLeft: [-71.35, 46.75],
};

test('attachGeoViewport round-trips through parseGeoPdf', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const mapRect = { x: 24, y: 88, w: 547.28, h: 729.89 };
  attachGeoViewport(doc, page, mapRect, CORNERS);
  const bytes = await doc.save();

  const parsed = parseGeoPdf(bytes);
  expect(parsed.pageCount).toBe(1);
  expect(parsed.georeferences).toHaveLength(1);
  const geo = parsed.georeferences[0]!;
  expect(geo.pageIndex).toBe(0);
  expect(geo.pageWidthPt).toBeCloseTo(595.28, 1);
  expect(geo.pageHeightPt).toBeCloseTo(841.89, 1);
  // The parser reports the viewport rect origin-bottom-left, like we wrote it.
  expect(geo.viewport.rect.x0).toBeCloseTo(mapRect.x, 3);
  expect(geo.viewport.rect.y0).toBeCloseTo(mapRect.y, 3);
  expect(geo.viewport.rect.x1).toBeCloseTo(mapRect.x + mapRect.w, 3);
  expect(geo.viewport.rect.y1).toBeCloseTo(mapRect.y + mapRect.h, 3);
  for (const key of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
    expect(geo.viewport.corners[key][0]).toBeCloseTo(CORNERS[key][0], 6);
    expect(geo.viewport.corners[key][1]).toBeCloseTo(CORNERS[key][1], 6);
  }
  expect(geo.bbox.minLng).toBeCloseTo(-71.35, 6);
  expect(geo.bbox.maxLng).toBeCloseTo(-71.2, 6);
  expect(geo.bbox.minLat).toBeCloseTo(46.75, 6);
  expect(geo.bbox.maxLat).toBeCloseTo(46.8, 6);
});
