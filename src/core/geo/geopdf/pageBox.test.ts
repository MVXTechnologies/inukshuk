import { planPdfDetailTiles, rasterCropGeometry } from '@core/geo/pdfDetail';
import type { GeoReference, LngLat } from '@core/models';
import {
  DEFAULT_MEDIABOX,
  effectivePageBox,
  nativePageGeometry,
  needsPageBoxReprocessing,
  normalizePdfRect,
  renderedPageCorners,
  renderedPageRect,
} from './pageBox';
import { parseGeoPdf } from './parseGeoPdf';
import { buildClassicPdf } from './testUtils';

/**
 * #287 (audit A02 in #275): a page's georeferencing lives in user space, but
 * what gets rendered is CropBox ∩ MediaBox. The overlay used to assume the
 * rendered image was a zero-origin MediaBox, so a cropped or shifted page was
 * drawn at the wrong extent. These tests pin the placement math for three
 * synthetic pages — CropBox only, shifted-origin MediaBox, both — on the two
 * render paths: the pdf.js overview and the detail-tile planner.
 */

describe('effectivePageBox', () => {
  it('is the MediaBox when there is no CropBox', () => {
    expect(effectivePageBox([0, 0, 200, 100], undefined)).toEqual([0, 0, 200, 100]);
    expect(effectivePageBox([100, 200, 300, 300], undefined)).toEqual([100, 200, 300, 300]);
  });

  it('is CropBox ∩ MediaBox, origin included', () => {
    expect(effectivePageBox([0, 0, 200, 100], [50, 25, 150, 75])).toEqual([50, 25, 150, 75]);
    // A CropBox spilling past the MediaBox is clipped to it, as pdf.js does.
    expect(effectivePageBox([0, 0, 200, 100], [-50, 25, 150, 175])).toEqual([0, 25, 150, 100]);
  });

  it('falls back to the MediaBox when the intersection is empty', () => {
    expect(effectivePageBox([0, 0, 200, 100], [300, 300, 400, 400])).toEqual([0, 0, 200, 100]);
    // Touching edges have zero area — that is "empty" too.
    expect(effectivePageBox([0, 0, 200, 100], [200, 0, 300, 100])).toEqual([0, 0, 200, 100]);
  });

  it('normalizes reversed corners and ignores degenerate boxes', () => {
    expect(normalizePdfRect([150, 75, 50, 25])).toEqual([50, 25, 150, 75]);
    expect(normalizePdfRect([0, 0, 0, 100])).toBeUndefined();
    expect(normalizePdfRect([0, 0, Number.NaN, 100])).toBeUndefined();
    expect(normalizePdfRect([0, 0, 100])).toBeUndefined();
    expect(effectivePageBox([200, 100, 0, 0], [150, 75, 50, 25])).toEqual([50, 25, 150, 75]);
    expect(effectivePageBox([0, 0, 200, 100], [0, 0, 0, 0])).toEqual([0, 0, 200, 100]);
  });

  it('uses US Letter when even the MediaBox is unusable (pdf.js behaviour)', () => {
    expect(effectivePageBox(undefined, undefined)).toEqual(DEFAULT_MEDIABOX);
    expect(effectivePageBox([0, 0, 0, 0], [10, 10, 20, 20])).toEqual([10, 10, 20, 20]);
  });
});

/**
 * A one-page PDF whose map covers lon [-71, -70] × lat [45, 46]. The Adobe
 * viewport `/BBox` is `frame`; the GPTS are the ISO-default corner order
 * (lower-left, upper-left, upper-right, lower-right — lat first).
 */
function geoPage(args: {
  mediaBox: string;
  cropBox?: string;
  frame: string;
  pagesCropBox?: string;
}): Uint8Array {
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [${args.mediaBox}] ` +
    (args.cropBox ? `/CropBox [${args.cropBox}] ` : '') +
    `/VP [ << /Type /Viewport /BBox [${args.frame}] ` +
    '/Measure << /Type /Measure /Subtype /GEO ' +
    '/GPTS [45 -71 46 -71 46 -70 45 -70] ' +
    '/GCS << /Type /GEOGCS /EPSG 4326 >> >> >> ] >>';
  const pages =
    '<< /Type /Pages /Kids [3 0 R] /Count 1 ' +
    (args.pagesCropBox ? `/CropBox [${args.pagesCropBox}] ` : '') +
    '>>';
  return buildClassicPdf(['<< /Type /Catalog /Pages 2 0 R >>', pages, page], 1);
}

const only = (bytes: Uint8Array): GeoReference => {
  const res = parseGeoPdf(bytes);
  expect(res.georeferences).toHaveLength(1);
  return res.georeferences[0]!;
};

const expectCorners = (
  corners: ReturnType<typeof renderedPageCorners>,
  expected: { topLeft: LngLat; topRight: LngLat; bottomRight: LngLat; bottomLeft: LngLat },
) => {
  for (const key of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
    expect(corners[key][0]).toBeCloseTo(expected[key][0], 9);
    expect(corners[key][1]).toBeCloseTo(expected[key][1], 9);
  }
};

const EXACT = {
  topLeft: [-71, 46] as LngLat,
  topRight: [-70, 46] as LngLat,
  bottomRight: [-70, 45] as LngLat,
  bottomLeft: [-71, 45] as LngLat,
};

describe('overview placement (#287)', () => {
  it('CropBox only: the audit A02 reproduction lands the crop exactly', () => {
    // /MediaBox [0 0 200 100] /CropBox [50 25 150 75]; the cropped map covers
    // lon [-71, -70] × lat [45, 46]. pdf.js renders the 100×50 pt CropBox.
    const geo = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '50 25 150 75', frame: '50 25 150 75' }),
    );
    expect(geo.pageWidthPt).toBe(100);
    expect(geo.pageHeightPt).toBe(50);
    expect(geo.pageBox).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expect(geo.viewport.rect).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expectCorners(renderedPageCorners(geo), EXACT);
    expect(needsPageBoxReprocessing(geo)).toBe(false);
  });

  it('a pre-#287 document keeps the old (doubled) placement until re-imported', () => {
    // What the parser used to record for the same page: MediaBox size, no
    // box. The overlay must place it exactly as before the fix — the audit's
    // lon [-71.5, -69.5] × lat [44.5, 46.5] — and flag it, never guess.
    const fixed = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '50 25 150 75', frame: '50 25 150 75' }),
    );
    const { pageBox: _dropped, ...legacy } = { ...fixed, pageWidthPt: 200, pageHeightPt: 100 };
    expect(needsPageBoxReprocessing(legacy)).toBe(true);
    expect(renderedPageRect(legacy)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 });
    expectCorners(renderedPageCorners(legacy), {
      topLeft: [-71.5, 46.5],
      topRight: [-69.5, 46.5],
      bottomRight: [-69.5, 44.5],
      bottomLeft: [-71.5, 44.5],
    });
  });

  it('shifted-origin MediaBox: the origin is kept, not dropped', () => {
    // /MediaBox [100 200 300 300], no CropBox; the map frame is the inner
    // half of the page, so the rendered page extends half a degree beyond it
    // on every side. A zero-origin assumption would shift it a full page.
    const geo = only(geoPage({ mediaBox: '100 200 300 300', frame: '150 225 250 275' }));
    expect(geo.pageWidthPt).toBe(200);
    expect(geo.pageHeightPt).toBe(100);
    expect(geo.pageBox).toEqual({ x0: 100, y0: 200, x1: 300, y1: 300 });
    expectCorners(renderedPageCorners(geo), {
      topLeft: [-71.5, 46.5],
      topRight: [-69.5, 46.5],
      bottomRight: [-69.5, 44.5],
      bottomLeft: [-71.5, 44.5],
    });
  });

  it('shifted MediaBox AND CropBox: the crop is placed exactly', () => {
    const geo = only(
      geoPage({
        mediaBox: '100 200 300 300',
        cropBox: '150 225 250 275',
        frame: '150 225 250 275',
      }),
    );
    expect(geo.pageWidthPt).toBe(100);
    expect(geo.pageHeightPt).toBe(50);
    expect(geo.pageBox).toEqual({ x0: 150, y0: 225, x1: 250, y1: 275 });
    expectCorners(renderedPageCorners(geo), EXACT);
  });

  it('a CropBox inherited from the /Pages node counts too', () => {
    const geo = only(
      geoPage({ mediaBox: '0 0 200 100', pagesCropBox: '50 25 150 75', frame: '50 25 150 75' }),
    );
    expect(geo.pageBox).toEqual({ x0: 50, y0: 25, x1: 150, y1: 75 });
    expectCorners(renderedPageCorners(geo), EXACT);
  });

  it('a map frame inside a cropped page extrapolates within the crop', () => {
    // CropBox [50 25 150 75], frame = its inner half → rendered image spans
    // half a degree beyond the frame, measured from the CROP's edges.
    const geo = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '50 25 150 75', frame: '75 37.5 125 62.5' }),
    );
    expectCorners(renderedPageCorners(geo), {
      topLeft: [-71.5, 46.5],
      topRight: [-69.5, 46.5],
      bottomRight: [-69.5, 44.5],
      bottomLeft: [-71.5, 44.5],
    });
  });

  it('a page whose CropBox equals a zero-origin MediaBox is unchanged', () => {
    const plain = only(geoPage({ mediaBox: '0 0 200 100', frame: '0 0 200 100' }));
    const same = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '0 0 200 100', frame: '0 0 200 100' }),
    );
    for (const geo of [plain, same]) {
      expect(geo.pageWidthPt).toBe(200);
      expect(geo.pageHeightPt).toBe(100);
      expect(geo.pageBox).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 });
      expectCorners(renderedPageCorners(geo), EXACT);
    }
  });
});

describe('native hand-off gate', () => {
  it('offers the rendered size for a zero-origin box (native renders that box)', () => {
    const geo = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '0 0 100 50', frame: '0 0 100 50' }),
    );
    expect(nativePageGeometry(geo)).toEqual({ expectedPageWidthPt: 100, expectedPageHeightPt: 50 });
  });

  it('refuses a nonzero-origin box: native renderers cannot draw it', () => {
    expect(
      nativePageGeometry(
        only(geoPage({ mediaBox: '0 0 200 100', cropBox: '50 25 150 75', frame: '50 25 150 75' })),
      ),
    ).toBeNull();
    expect(
      nativePageGeometry(only(geoPage({ mediaBox: '100 200 300 300', frame: '100 200 300 300' }))),
    ).toBeNull();
  });

  it('keeps offering the recorded MediaBox size for a pre-#287 document', () => {
    expect(nativePageGeometry({ pageWidthPt: 612, pageHeightPt: 792 })).toEqual({
      expectedPageWidthPt: 612,
      expectedPageHeightPt: 792,
    });
  });
});

describe('detail placement (#287)', () => {
  const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

  it('tiles the rendered crop box and lands a known point in the right tile', () => {
    const geo = only(
      geoPage({ mediaBox: '0 0 200 100', cropBox: '50 25 150 75', frame: '50 25 150 75' }),
    );
    const c = renderedPageCorners(geo);
    const corners: [LngLat, LngLat, LngLat, LngLat] = [
      c.topLeft,
      c.topRight,
      c.bottomRight,
      c.bottomLeft,
    ];
    // The planner is handed the RENDERED box size — what pdf.js's crop
    // geometry (and the native crop) will slice — not the 200×100 MediaBox.
    const page = { width: geo.pageWidthPt, height: geo.pageHeightPt };
    expect(page).toEqual({ width: 100, height: 50 });
    const bounds = { west: -70.55, east: -70.45, north: 45.55, south: 45.45 };
    const plans = planPdfDetailTiles(corners, page, bounds, 1200);
    expect(plans.length).toBeGreaterThan(0);
    // Every tile corner's longitude is linear in the crop's unit x, and its
    // latitude is the Mercator interpolation between the crop's top and
    // bottom edges — i.e. the tile grid subdivides exactly the rendered box.
    for (const plan of plans) {
      const [tl, tr, br, bl] = plan.coordinates;
      expect(tl[0]).toBeCloseTo(-71 + plan.crop.x0, 9);
      expect(tr[0]).toBeCloseTo(-71 + plan.crop.x1, 9);
      expect(br[0]).toBeCloseTo(-71 + plan.crop.x1, 9);
      expect(bl[0]).toBeCloseTo(-71 + plan.crop.x0, 9);
      const latAt = (v: number) => {
        const y = merc(46) + v * (merc(45) - merc(46));
        return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
      };
      expect(tl[1]).toBeCloseTo(latAt(plan.crop.y0), 9);
      expect(bl[1]).toBeCloseTo(latAt(plan.crop.y1), 9);
    }
    // The point (-70.5, 45.5) sits in the tile whose crop contains it, and
    // that tile's raster is cut from the 100×50 pt box at that same crop.
    const u = 0.5;
    const v = (merc(46) - merc(45.5)) / (merc(46) - merc(45));
    const hit = plans.filter(
      (p) => p.crop.x0 <= u && u < p.crop.x1 && p.crop.y0 <= v && v < p.crop.y1,
    );
    expect(hit).toHaveLength(1);
    const tile = hit[0]!;
    expect(tile.coordinates[0][0]).toBeLessThanOrEqual(-70.5);
    expect(tile.coordinates[1][0]).toBeGreaterThanOrEqual(-70.5);
    expect(tile.coordinates[0][1]).toBeGreaterThanOrEqual(45.5);
    expect(tile.coordinates[3][1]).toBeLessThanOrEqual(45.5);
    const geometry = rasterCropGeometry(page.width, page.height, tile.targetWidthPx, tile.crop);
    expect(geometry.offsetX).toBeCloseTo(-tile.crop.x0 * 100 * geometry.scale, 9);
    expect(geometry.offsetY).toBeCloseTo(-tile.crop.y0 * 50 * geometry.scale, 9);
  });
});
