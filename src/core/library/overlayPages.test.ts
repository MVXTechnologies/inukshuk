import type { GeoReference } from '@core/models';
import { parseGeoPdf } from '@core/geo/geopdf';
import { buildClassicPdf } from '@core/geo/geopdf/testUtils';
import { NO_GEOREFERENCE_NOTICE, defaultActivePages, georeferenceNotice } from './overlayPages';

/**
 * #236: an imported GeoPDF must land with EVERY georeferenced page active, and
 * a PDF with none must be able to say so. Both halves are asserted from a real
 * `parseGeoPdf` result, not a hand-written georeference list — the bug the
 * issue chased was the import path and the card disagreeing about what "has
 * pages" means.
 */

function geo(pageIndex: number, size: number): GeoReference {
  return {
    pageIndex,
    source: 'adobe-geo',
    pageWidthPt: 612,
    pageHeightPt: 792,
    viewport: {
      rect: { x0: 0, y0: 0, x1: size, y1: size },
      corners: {
        topLeft: [-71.3, 46.9],
        topRight: [-71.1, 46.9],
        bottomRight: [-71.1, 46.7],
        bottomLeft: [-71.3, 46.7],
      },
    },
    bbox: { minLat: 46.7, minLng: -71.3, maxLat: 46.9, maxLng: -71.1 },
  };
}

/** A two-page PDF whose second page carries a /VP + /Measure /GEO viewport. */
function twoPageGeoPdf(): Uint8Array {
  const measure =
    '<< /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] ' +
    '/GPTS [46.7 -71.3 46.9 -71.3 46.9 -71.1 46.7 -71.1] ' +
    '/LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 >> >>';
  return buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /VP [ << /Type /Viewport /BBox [0 0 612 792] /Measure ${measure} >> ] >>`,
    ],
    1,
  );
}

/** A one-page PDF with no georeferencing of any kind. */
function plainPdf(): Uint8Array {
  return buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    ],
    1,
  );
}

describe('defaultActivePages', () => {
  it('activates every georeferenced page of a parsed GeoPDF', () => {
    const parsed = parseGeoPdf(twoPageGeoPdf());
    expect(parsed.georeferences.length).toBeGreaterThan(0);
    expect(defaultActivePages(parsed.georeferences)).toEqual([1]);
  });

  it('is empty when the parsed PDF carries no georeferencing', () => {
    const parsed = parseGeoPdf(plainPdf());
    expect(parsed.georeferences).toEqual([]);
    expect(defaultActivePages(parsed.georeferences)).toEqual([]);
  });

  it('activates a multi-viewport page ONCE, not once per viewport', () => {
    // A US Topo sheet: map frame plus a locator inset and an adjoining-sheet
    // diagram, all on page 0.
    expect(defaultActivePages([geo(0, 600), geo(0, 140), geo(0, 90)])).toEqual([0]);
  });

  it('lists pages in ascending order regardless of PDF order', () => {
    expect(defaultActivePages([geo(2, 600), geo(0, 600), geo(1, 600)])).toEqual([0, 1, 2]);
  });
});

/**
 * A page whose corners never left the PDF's projected CRS — the shape every
 * CanTopo sheet persisted before #243: real georeferencing, in metres.
 */
function unplaceable(pageIndex: number, sourceCrs?: string): GeoReference {
  const corners = {
    topLeft: [300848, 5236961] as [number, number],
    topRight: [351625, 5236961] as [number, number],
    bottomRight: [351625, 5202313] as [number, number],
    bottomLeft: [300848, 5202313] as [number, number],
  };
  return {
    pageIndex,
    source: 'lgidict',
    ...(sourceCrs === undefined ? {} : { sourceCrs }),
    pageWidthPt: 2880,
    pageHeightPt: 2016,
    viewport: { rect: { x0: 0, y0: 0, x1: 2484, y1: 1678 }, corners },
    bbox: { minLng: 300848, minLat: 5202313, maxLng: 351625, maxLat: 5236961 },
  };
}

describe('georeferenceNotice', () => {
  it('explains, in plain language, that an ungeoreferenced PDF cannot be placed', () => {
    expect(georeferenceNotice({ georeferences: [] })).toBe(NO_GEOREFERENCE_NOTICE);
  });

  it('is silent for a map that has georeferenced pages', () => {
    expect(georeferenceNotice({ georeferences: [geo(0, 600)] })).toBeNull();
  });

  it('names the projection it cannot place instead of showing page counts', () => {
    expect(georeferenceNotice({ georeferences: [unplaceable(0, 'Polyconic, datum NAD27')] })).toBe(
      'Map projection not supported (Polyconic, datum NAD27) — cannot be placed on the map',
    );
  });

  it('says so even for a map imported before the CRS was recorded', () => {
    // Migration decision (#243): hydrate does NOT re-derive these. The raw
    // projection was never persisted and projected metres alone cannot identify
    // it — 300848/5202313 is a UTM easting/northing in *some* zone, and nothing
    // stored says which. Such a map keeps its (unusable) georeference, says why
    // it cannot be drawn, and must be re-imported or re-downloaded to be fixed.
    expect(georeferenceNotice({ georeferences: [unplaceable(0)] })).toBe(
      'Map projection not supported — cannot be placed on the map',
    );
  });

  it('stays silent when at least one page CAN be drawn', () => {
    // A mixed document still shows its counts: the placeable page draws.
    expect(georeferenceNotice({ georeferences: [unplaceable(0, 'x'), geo(1, 600)] })).toBeNull();
  });

  it('judges the PRIMARY viewport, not a decorative inset', () => {
    // The CanTopo layout: a placeable little MGRS legend box beside a map frame
    // in an unresolvable projection. The sheet is unplaceable, and must say so
    // rather than be excused by its legend.
    const legend = { ...geo(0, 60), sourceCrs: 'Geographic lon/lat (WGS 84)' };
    expect(georeferenceNotice({ georeferences: [legend, unplaceable(0, 'Polyconic')] })).toBe(
      'Map projection not supported (Polyconic) — cannot be placed on the map',
    );
  });
});
