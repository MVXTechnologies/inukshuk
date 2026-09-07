import { cornersAreValid } from '@core/geo/geomath';
import { georeferenceNotice, unsupportedProjectionNotice } from '@core/library/overlayPages';
import { parseGeoPdf } from './parseGeoPdf';
import { primaryGeoreferenceForPage } from './primary';
import { buildClassicPdf } from './testUtils';

/**
 * #243 — NRCan CanTopo GeoPDFs, from the real file.
 *
 * The three dictionaries below are transcribed **verbatim** from page 1 of
 * `cantopo_021g14_geopdf.zip` (021G14 Canterbury, New Brunswick — objects 2352,
 * 2353 and 2354 of `021g14_0300_geo.pdf`). Only the object numbers change, so
 * the page can be reassembled around them without committing a 5 MB PDF.
 *
 * What they encode, and why the sheet used to vanish: the map frame's
 * `/Projection` is a Transverse Mercator spelled out in parameters — central
 * meridian −69°, scale 0.9996, false easting 500 000, datum `NAR` — which is
 * NAD83 / UTM zone 19N (EPSG:26919). It carries no EPSG code and no "UTM zone"
 * phrase, so `crs.ts` used to resolve nothing, the corners stayed in projected
 * metres, `cornersAreValid` rejected them and `usePdfOverlays` skipped the page
 * without a word. All 2,234 CanTopo sheets behaved this way.
 */

/** Object 2352: the Canada locator inset, a NAD83 Lambert Conformal Conic. */
const CANADA_INSET =
  '<< /CTM [ (34219.2782419254) (298.6271171124) (-298.6271171124) (34219.2782419254) ' +
  '(-3773064.1685393695) (-15148218.2802434840) ] /Description (CANADA) ' +
  '/Projection << /CentralMeridian (-96.00000) /Datum (NAR) /FalseEasting (0.00000) ' +
  '/FalseNorthing (0.00000) /OriginLatitude (40.00000) /ProjectionType (LE) ' +
  '/StandardParallelOne (45.00000) /StandardParallelTwo (82.00000) /Type /Projection >> ' +
  '/Neatline [ (17.6519823406) (439.9312500000) (17.6519823406) (598.4775000000) ' +
  '(208.6980176594) (598.4775000000) (208.6980176594) (439.9312500000) ] ' +
  '/Type /LGIDict /Version (2.1) >>';

/** Object 2353: the MGRS legend box, a tiny geographic frame. */
const MGRS_FRAME =
  '<< /CTM [ (0.0069444444) (0.0000000000) (0.0000000000) (0.0069444444) ' +
  '(-82.6026562500) (45.0000000000) ] /Description (MGRS_FRAME) ' +
  '/Projection << /Datum (WE) /ProjectionType (GEOGRAPHIC) /Type /Projection >> ' +
  '/Neatline [ (2174.7825000000) (108.0000000000) (2174.7825000000) (144.0000000000) ' +
  '(2246.7825000000) (144.0000000000) (2246.7825000000) (108.0000000000) ] ' +
  '/Type /LGIDict /Version (2.1) >>';

/** Object 2354: THE MAP. NAD83 / UTM 19N, written as a Transverse Mercator. */
const MAP_FRAME =
  '<< /CTM [ (17.6346836189) (0.3867549903) (-0.3867549903) (17.6346836189) ' +
  '(608395.7669825068) (5062494.7877158914) ] /Description (MAP_FRAME) ' +
  '/Projection << /CentralMeridian (-69.00000) /Datum (NAR) /FalseEasting (500000.00000) ' +
  '/FalseNorthing (0.00000) /OriginLatitude (0.00000) /ProjectionType (TC) ' +
  '/ScaleFactor (0.99960) /Type /Projection >> ' +
  '/Neatline [ (338.1525000000) (214.4025000000) (338.1525000000) (1892.0025000000) ' +
  '(2822.1525000000) (1892.0025000000) (2822.1525000000) (214.4025000000) ] ' +
  '/Type /LGIDict /Version (2.1) >>';

/** The real 021G14 page: 2880x2016 pt, three LGIDicts. */
function cantopoSheet(dicts: string[]): Uint8Array {
  const refs = dicts.map((_, i) => `${i + 4} 0 R`).join(' ');
  return buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 2880 2016 ] /LGIDict [ ${refs} ] >>`,
      ...dicts,
    ],
    1,
  );
}

/** 021G14 covers 45.75–46.00 N, 67.50–67.00 W: the sheet centre is ~45.9/-67.4. */
const CANTERBURY: [number, number] = [-67.4, 45.9];

describe('CanTopo GeoPDF (#243)', () => {
  it('places the map frame over New Brunswick, in degrees', () => {
    const res = parseGeoPdf(cantopoSheet([CANADA_INSET, MGRS_FRAME, MAP_FRAME]));
    const geo = primaryGeoreferenceForPage(res.georeferences, 0);
    expect(geo).toBeDefined();

    // The map frame wins over the two insets (it is by far the largest).
    expect(geo!.viewport.rect).toEqual({
      x0: 338.1525,
      y0: 214.4025,
      x1: 2822.1525,
      y1: 1892.0025,
    });

    // Resolved, reprojected, and inside the quadrangle — not metres.
    expect(geo!.sourceEpsg).toBe(26919);
    expect(geo!.sourceCrs).toBe('NAD83 / UTM zone 19N (EPSG:26919)');
    expect(cornersAreValid(geo!.viewport.corners)).toBe(true);
    for (const corner of Object.values(geo!.viewport.corners)) {
      expect(Math.abs(corner[0] - CANTERBURY[0])).toBeLessThan(0.5);
      expect(Math.abs(corner[1] - CANTERBURY[1])).toBeLessThan(0.5);
    }
    expect(geo!.bbox.minLng).toBeCloseTo(-67.532, 2);
    expect(geo!.bbox.maxLng).toBeCloseTo(-66.967, 2);
    expect(geo!.bbox.minLat).toBeCloseTo(45.742, 2);
    expect(geo!.bbox.maxLat).toBeCloseTo(46.008, 2);
  });

  it('regression: the map frame is no longer left in projected metres', () => {
    // What the bug produced: bbox {minLng: 300848, minLat: 5202313} — a UTM
    // easting and northing that every lon/lat check rejects.
    const res = parseGeoPdf(cantopoSheet([CANADA_INSET, MGRS_FRAME, MAP_FRAME]));
    const geo = primaryGeoreferenceForPage(res.georeferences, 0)!;
    expect(Math.abs(geo.bbox.minLng)).toBeLessThan(180);
    expect(Math.abs(geo.bbox.minLat)).toBeLessThan(90);
  });

  it('resolves the Lambert locator inset too, without letting it win', () => {
    const res = parseGeoPdf(cantopoSheet([CANADA_INSET, MGRS_FRAME, MAP_FRAME]));
    const inset = res.georeferences.find((g) => g.sourceCrs?.startsWith('Lambert'));
    expect(inset?.sourceCrs).toBe('Lambert Conformal Conic (NAD83, CM -96°)');
    expect(cornersAreValid(inset!.viewport.corners)).toBe(true);
    // ...and the primary is still the map frame, not this continent-wide inset.
    expect(primaryGeoreferenceForPage(res.georeferences, 0)!.sourceEpsg).toBe(26919);
  });

  it('reads the MGRS legend frame as plain WGS84 lon/lat', () => {
    const res = parseGeoPdf(cantopoSheet([MGRS_FRAME]));
    const geo = res.georeferences[0]!;
    expect(geo.sourceEpsg).toBe(4326);
    expect(geo.bbox.minLng).toBeCloseTo(-67.5, 5);
    expect(geo.bbox.maxLat).toBeCloseTo(46.0, 5);
  });

  it('says which projection it cannot place, instead of skipping in silence', () => {
    // A Polyconic frame on NAD27 — we have no def for it. The georeference is
    // still emitted (so the card can explain), the warning names the CRS, and
    // the notice quotes it.
    const polyconic =
      '<< /CTM [ (1) (0) (0) (1) (0) (0) ] /Description (MAP_FRAME) ' +
      '/Projection << /CentralMeridian (-96.00000) /Datum (NAS) /ProjectionType (PH) ' +
      '/Type /Projection >> ' +
      '/Neatline [ (0) (0) (0) (100) (100) (100) (100) (0) ] /Type /LGIDict >>';
    const res = parseGeoPdf(cantopoSheet([polyconic]));
    const geo = res.georeferences[0]!;
    expect(geo.sourceCrs).toBe('Polyconic, datum NAD27');
    expect(geo.sourceEpsg).toBeUndefined();
    expect(res.warnings).toContain('page 0: unsupported map projection (Polyconic, datum NAD27)');
    expect(georeferenceNotice({ georeferences: res.georeferences })).toBe(
      unsupportedProjectionNotice('Polyconic, datum NAD27'),
    );
  });

  it('leaves a USGS US Topo sheet exactly as it was', () => {
    // The control: KY_Belfry.pdf's viewport, with the corner values this parser
    // reads out of the real file. US Topo georeferences through /VP + /Measure
    // /GEO, whose GPTS are geographic even though /GCS names UTM 17N — a path
    // the CanTopo fix must not touch.
    const page =
      '<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 1728 2088 ] /VP [ ' +
      '<< /Type /Viewport /BBox [ 0 41.75369 1727.95998 2088 ] ' +
      '/Measure << /Type /Measure /Subtype /GEO /BOUNDS [0 0 0 1 1 1 1 0] ' +
      '/GPTS [37.48020 -82.39490 37.63815 -82.39767 37.64002 -82.22933 37.48207 -82.22657] ' +
      '/GCS << /Type /PROJCS /EPSG 32617 >> >> >> ] >>';
    const res = parseGeoPdf(
      buildClassicPdf(
        ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page],
        1,
      ),
    );
    const geo = res.georeferences[0]!;
    expect(geo.source).toBe('adobe-geo');
    expect(geo.sourceEpsg).toBe(32617);
    expect(geo.viewport.corners.topLeft[0]).toBeCloseTo(-82.39767, 5);
    expect(geo.viewport.corners.topLeft[1]).toBeCloseTo(37.63815, 5);
    expect(geo.viewport.corners.bottomRight[0]).toBeCloseTo(-82.22657, 5);
    expect(geo.viewport.corners.bottomRight[1]).toBeCloseTo(37.48207, 5);
    expect(georeferenceNotice({ georeferences: res.georeferences })).toBeNull();
  });
});
