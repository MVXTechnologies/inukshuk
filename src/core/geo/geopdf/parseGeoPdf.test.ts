import { parseGeoPdf } from './parseGeoPdf';
import { buildClassicPdf, latin1Bytes } from './testUtils';

/**
 * Builds a 3-object PDF: catalog -> pages -> single page. The page object body
 * is supplied so each test can attach its own georeferencing.
 */
function pdfWithPage(pageBody: string): Uint8Array {
  return buildClassicPdf(
    ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', pageBody],
    1,
  );
}

describe('parseGeoPdf — LGIDict (EPSG:4326)', () => {
  it('maps 4 registration points (page->lon/lat) to corners', () => {
    // Page is 200x100 pt. Registration maps page corners to a clean lon/lat box:
    //   page (0,0)     -> (-75, 45)   bottom-left
    //   page (200,0)   -> (-74, 45)   bottom-right
    //   page (200,100) -> (-74, 46)   top-right
    //   page (0,100)   -> (-75, 46)   top-left
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /LGIDict ' +
      '<< /Type /LGIDict /Version 2 ' +
      '/Projection << /ProjectionType /GEOGRAPHIC /Datum /WE >> ' +
      '/Neatline [0 0 200 0 200 100 0 100] ' +
      '/Registration [ ' +
      '[ (0) (0) (-75) (45) ] ' +
      '[ (200) (0) (-74) (45) ] ' +
      '[ (200) (100) (-74) (46) ] ' +
      '[ (0) (100) (-75) (46) ] ' +
      '] >> >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    const g = res.georeferences[0]!;
    expect(g.source).toBe('lgidict');
    expect(g.sourceEpsg).toBe(4326);
    // Visual top = larger Y in page space.
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-75, 6);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.topRight[0]).toBeCloseTo(-74, 6);
    expect(g.viewport.corners.topRight[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.bottomRight[0]).toBeCloseTo(-74, 6);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(45, 6);
    expect(g.viewport.corners.bottomLeft[0]).toBeCloseTo(-75, 6);
    expect(g.viewport.corners.bottomLeft[1]).toBeCloseTo(45, 6);
    expect(g.bbox.minLng).toBeCloseTo(-75, 6);
    expect(g.bbox.maxLat).toBeCloseTo(46, 6);
    expect(g.pageWidthPt).toBe(200);
    expect(g.pageHeightPt).toBe(100);
  });

  it('reprojects a UTM zone 18N (EPSG:32618) LGIDict to plausible lon/lat', () => {
    // A small box near New York City in UTM 18N meters.
    //   easting 585000..586000, northing 4510000..4511000
    const page =
      '<< /Type /Page /MediaBox [0 0 100 100] /LGIDict ' +
      '<< /Type /LGIDict /Version 2 ' +
      '/Projection << /ProjectionType /UT /Zone 18 /Hemisphere /N /Datum /WE >> ' +
      '/Registration [ ' +
      '[ (0) (0) (585000) (4510000) ] ' +
      '[ (100) (0) (586000) (4510000) ] ' +
      '[ (100) (100) (586000) (4511000) ] ' +
      '[ (0) (100) (585000) (4511000) ] ' +
      '] >> >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.georeferences).toHaveLength(1);
    const g = res.georeferences[0]!;
    expect(g.sourceEpsg).toBe(32618);
    // NYC area: lon ~ -74, lat ~ 40.7. Loose tolerance.
    expect(g.bbox.minLng).toBeGreaterThan(-74.5);
    expect(g.bbox.maxLng).toBeLessThan(-73.5);
    expect(g.bbox.minLat).toBeGreaterThan(40.0);
    expect(g.bbox.maxLat).toBeLessThan(41.5);
    // Top edge (larger Y / larger northing) is further north than the bottom.
    expect(g.viewport.corners.topLeft[1]).toBeGreaterThan(g.viewport.corners.bottomLeft[1]);
  });

  it('accepts an LGIDict array on the page', () => {
    const page =
      '<< /Type /Page /MediaBox [0 0 10 10] /LGIDict [ ' +
      '<< /Type /LGIDict /Projection << /ProjectionType /GEOGRAPHIC >> ' +
      '/Registration [ [ (0) (0) (0) (0) ] [ (10) (0) (1) (0) ] [ (10) (10) (1) (1) ] ] >> ' +
      '] >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.source).toBe('lgidict');
  });
});

describe('parseGeoPdf — Adobe VP/Measure GEO', () => {
  it('maps a viewport BBox to corners using GPTS (lat,lon order)', () => {
    // BBox covers the page. GPTS gives the geo position of the bbox corners.
    // BOUNDS defaults to corners 0,0 0,1 1,1 1,0. GPTS pairs are lat,lon.
    //   (0,0)->(45,-75)  (0,1)->(46,-75)  (1,1)->(46,-74)  (1,0)->(45,-74)
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/BOUNDS [0 0 0 1 1 1 1 0] ' +
      '/GPTS [45 -75 46 -75 46 -74 45 -74] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    const g = res.georeferences[0]!;
    expect(g.source).toBe('adobe-geo');
    expect(g.sourceEpsg).toBe(4326);
    // topLeft = unit (0,1) -> (lat 46, lon -75)
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-75, 6);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.bottomRight[0]).toBeCloseTo(-74, 6);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(45, 6);
  });

  // Real files list their points in whatever order the producer chose, and
  // the parser used to ignore /LPTS and assume the ISO default order — so a
  // Sépaq/Avenza sheet whose LPTS starts at the upper-left drew vertically
  // flipped, and a UTM sheet going lower-left, lower-RIGHT, upper-right,
  // upper-left (with a 10 % inset) drew transposed. Same terrain, three
  // different rotations on the map (#269). Both orders must come out north-up.
  it("pairs GPTS with the file's own /LPTS order (upper-left first)", () => {
    // LPTS: UL, LL, LR, UR — the order the 52 MB EcoLL1.pdf sheet uses.
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/LPTS [0 1 0 0 1 0 1 1] ' +
      '/GPTS [46 -75 45 -75 45 -74 46 -74] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-75, 6);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.topRight[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.bottomRight[0]).toBeCloseTo(-74, 6);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(45, 6);
    expect(g.viewport.corners.bottomLeft[1]).toBeCloseTo(45, 6);
  });

  it('pairs GPTS with an inset, clockwise-from-lower-left /LPTS', () => {
    // LPTS: LL, LR, UR, UL at 0.1..0.9 — the 216 MB NORD UTM sheet's order.
    // The corners of the FULL unit square are extrapolated from the inset
    // points, so the sheet spans lon -75..-74 and lat 45..46 exactly.
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/LPTS [0.1 0.1 0.9 0.1 0.9 0.9 0.1 0.9] ' +
      '/GPTS [45.1 -74.9 45.1 -74.1 45.9 -74.1 45.9 -74.9] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-75, 6);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.topRight[0]).toBeCloseTo(-74, 6);
    expect(g.viewport.corners.topRight[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(45, 6);
    expect(g.viewport.corners.bottomLeft[0]).toBeCloseTo(-75, 6);
  });

  it('ignores /BOUNDS for pairing: it is a clip polygon, not the LPTS', () => {
    // A BOUNDS in a different order than the (default) LPTS must not flip the map.
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/BOUNDS [0 1 0 0 1 0 1 1] ' +
      '/GPTS [45 -75 46 -75 46 -74 45 -74] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 6);
    expect(g.viewport.corners.bottomLeft[1]).toBeCloseTo(45, 6);
  });

  it('treats GPTS as geographic even when /GCS names a projected EPSG (regression)', () => {
    // Real GeoPDFs (e.g. Canadian topo sheets) declare a projected /GCS such as
    // UTM 19N (EPSG:32619) but per ISO 32000-2 the GPTS values are STILL
    // geographic lat/lon degrees. A previous bug reprojected them through the UTM
    // transform, collapsing every page to a degenerate point near (~-73.5, ~0).
    // The corners must come out as the geographic GPTS values, untouched.
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/BOUNDS [0 0 0 1 1 1 1 0] ' +
      '/GPTS [47 -71 48 -71 48 -70 47 -70] ' +
      '/GCS << /Type /PROJCS /EPSG 32619 >> ' +
      '>> >> ] >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.georeferences).toHaveLength(1);
    const g = res.georeferences[0]!;
    expect(g.sourceEpsg).toBe(32619);
    // Geographic GPTS used directly — NOT reprojected/collapsed.
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-71, 6);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(48, 6);
    expect(g.viewport.corners.bottomRight[0]).toBeCloseTo(-70, 6);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(47, 6);
    expect(g.bbox.maxLat - g.bbox.minLat).toBeCloseTo(1, 6);
  });

  it('reads GCS WKT to detect EPSG when no /EPSG key present', () => {
    const wkt = 'GEOGCS[\\"WGS 84\\",DATUM[\\"WGS_1984\\"],AUTHORITY[\\"EPSG\\",\\"4326\\"]]';
    const page =
      '<< /Type /Page /MediaBox [0 0 100 100] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 100 100] ' +
      '/Measure << /Subtype /GEO ' +
      '/GPTS [10 20 11 20 11 21 10 21] ' +
      `/GCS << /Type /GEOGCS /WKT (${wkt}) >> ` +
      '>> >> ] >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.sourceEpsg).toBe(4326);
  });
});

describe('parseGeoPdf — rendered page box (#287)', () => {
  it('LGIDict without a Neatline frames the CropBox, not the MediaBox', () => {
    // Registration is in page user space; with no Neatline the frame is the
    // whole RENDERED page — the 100×50 pt CropBox at (50, 25).
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /CropBox [50 25 150 75] /LGIDict ' +
      '<< /Type /LGIDict /Version 2 ' +
      '/Projection << /ProjectionType /GEOGRAPHIC /Datum /WE >> ' +
      '/Registration [ ' +
      '[ (50) (25) (-71) (45) ] ' +
      '[ (150) (25) (-70) (45) ] ' +
      '[ (150) (75) (-70) (46) ] ' +
      '[ (50) (75) (-71) (46) ] ' +
      '] >> >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.source).toBe('lgidict');
    expect(g.pageWidthPt).toBe(100);
    expect(g.pageHeightPt).toBe(50);
    expect(g.pageBox).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expect(g.viewport.rect).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expect(g.viewport.corners.topLeft[0]).toBeCloseTo(-71, 9);
    expect(g.viewport.corners.topLeft[1]).toBeCloseTo(46, 9);
    expect(g.viewport.corners.bottomRight[0]).toBeCloseTo(-70, 9);
    expect(g.viewport.corners.bottomRight[1]).toBeCloseTo(45, 9);
  });

  it('a viewport with no /BBox frames the rendered page box', () => {
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /CropBox [50 25 150 75] /VP [ ' +
      '<< /Type /Viewport ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/GPTS [45 -71 46 -71 46 -70 45 -70] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.viewport.rect).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expect(g.pageBox).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
  });

  it('a CropBox that misses the MediaBox is ignored, as pdf.js does', () => {
    const page =
      '<< /Type /Page /MediaBox [0 0 200 100] /CropBox [300 300 400 400] /VP [ ' +
      '<< /Type /Viewport /BBox [0 0 200 100] ' +
      '/Measure << /Type /Measure /Subtype /GEO ' +
      '/GPTS [45 -71 46 -71 46 -70 45 -70] ' +
      '/GCS << /Type /GEOGCS /EPSG 4326 >> ' +
      '>> >> ] >>';
    const g = parseGeoPdf(pdfWithPage(page)).georeferences[0]!;
    expect(g.pageWidthPt).toBe(200);
    expect(g.pageHeightPt).toBe(100);
    expect(g.pageBox).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 });
  });
});

describe('parseGeoPdf — robustness', () => {
  it('returns empty georeferences with a warning for a garbage PDF', () => {
    const garbage = latin1Bytes('%PDF-1.7\nthis is not a real pdf at all\n%%EOF');
    const res = parseGeoPdf(garbage);
    expect(res.georeferences).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('does not throw on totally non-PDF bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    expect(() => parseGeoPdf(bytes)).not.toThrow();
    const res = parseGeoPdf(bytes);
    expect(res.georeferences).toHaveLength(0);
  });

  it('handles a valid PDF page with no georeferencing', () => {
    const page = '<< /Type /Page /MediaBox [0 0 612 792] >>';
    const res = parseGeoPdf(pdfWithPage(page));
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(0);
    expect(res.warnings.some((w) => /no embedded georeferencing/.test(w))).toBe(true);
  });

  it('tolerates indirect references and comments', () => {
    // MediaBox via indirect ref (object 4); registration inline.
    const bytes = buildClassicPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '% a comment here\n<< /Type /Page /MediaBox 4 0 R /LGIDict ' +
          '<< /Projection << /ProjectionType /GEOGRAPHIC >> ' +
          '/Registration [ [ (0) (0) (0) (0) ] [ (10) (0) (1) (0) ] [ (0) (10) (0) (1) ] ] >> >>',
        '[0 0 10 10]',
      ],
      1,
    );
    const res = parseGeoPdf(bytes);
    expect(res.pageCount).toBe(1);
    expect(res.georeferences).toHaveLength(1);
    expect(res.georeferences[0]!.pageWidthPt).toBe(10);
  });
});
