import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CornerCoordinates, LngLat } from '@core/models';
import { cornersSignedArea, initialBearingDeg } from '@core/geo/geomath';
import {
  type PageRotation,
  displayedCorners,
  normalizePageRotation,
  rasterPixelOfPagePoint,
} from './orientation';
import { renderedPageCorners, renderedPageRect } from './pageBox';
import { parseGeoPdf } from './parseGeoPdf';
import { primaryGeoreferenceForPage } from './primary';
import { buildClassicPdf } from './testUtils';

/**
 * Map-standards orientation suite (#487).
 *
 * Every producer writes its georeferencing its own way — Adobe `/VP` with the
 * BBox bottom-first or top-first, `/LPTS` in any of four corner orders or
 * inset, TerraGo `/LGIDict` registrations, pages with a `/Rotate` — and the
 * app must draw all of them the right way up. For each standard this suite
 * rebuilds a one-page PDF from the real sheet's georeferencing (the page
 * boxes and the `/VP` / `/LGIDict` dictionaries, nothing else: the 2–53 MB
 * originals stay out of git) and checks, independently of the parser's own
 * arithmetic:
 *
 *  - the corners handed to MapLibre put north up and east right, and do not
 *    mirror the image;
 *  - the sheet's catalogued north-west corner is drawn at the raster's
 *    top-left, which (by `rasterPixelOfPagePoint`, itself pinned to pdf.js in
 *    `orientation.pdfjs.test.ts`) is where the rasterizer puts the page's
 *    user-space top-left;
 *  - the parser raises no "mirrored" warning.
 *
 * The synthetic matrix below covers what no sample in hand exercises: every
 * `/Rotate`, every BBox corner order and every LPTS order, together.
 */

type Json = number | string | null | Json[] | { [key: string]: Json };

interface Fixture {
  id: string;
  standard: string;
  source: string;
  note: string;
  fileBytes: number | null;
  page: { [key: string]: Json };
  /** Catalogue extent [west, south, east, north]; null when not placeable. */
  expectedFrame: [number, number, number, number] | null;
}

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/map-standards.json'), 'utf8'),
) as Fixture[];

/** PDF syntax for a fixture value: "/X" is a name, other strings are literals. */
function toPdf(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    const s = String(v);
    return /e/i.test(s) ? v.toFixed(12) : s;
  }
  if (typeof v === 'string') {
    if (/^\/[^\s/]+$/.test(v)) return v;
    return `(${v
      .replace(/[\\()]/g, (c) => `\\${c}`)
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')})`;
  }
  if (Array.isArray(v)) return `[${v.map(toPdf).join(' ')}]`;
  return `<< ${Object.entries(v)
    .map(([k, x]) => `/${k} ${toPdf(x)}`)
    .join(' ')} >>`;
}

function pdfForPage(page: { [key: string]: Json }): Uint8Array {
  const entries = Object.entries(page)
    .map(([k, v]) => `/${k} ${toPdf(v)}`)
    .join(' ');
  return buildClassicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R ${entries} >>`,
    ],
    1,
  );
}

const corners = (c: CornerCoordinates): LngLat[] => [
  c.topLeft,
  c.topRight,
  c.bottomRight,
  c.bottomLeft,
];

/** Bearing of the displayed top edge, left to right: 90° for north-up. */
function topEdgeBearing(c: CornerCoordinates): number {
  const [lng1, lat1] = c.topLeft;
  const [lng2, lat2] = c.topRight;
  return initialBearingDeg(
    { latitude: lat1, longitude: lng1 },
    { latitude: lat2, longitude: lng2 },
  );
}

/** Which named corner lies nearest `p` (planar, in degrees — sheets are small). */
function nearestCorner(c: CornerCoordinates, p: LngLat): keyof CornerCoordinates {
  let best: keyof CornerCoordinates = 'topLeft';
  let bestD = Infinity;
  for (const key of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
    const d = Math.hypot(c[key][0] - p[0], c[key][1] - p[1]);
    if (d < bestD) {
      best = key;
      bestD = d;
    }
  }
  return best;
}

/** Assert corners are north-up, east-right and unmirrored, to `tolDeg` of rotation. */
function expectNorthUp(c: CornerCoordinates, tolDeg = 5): void {
  expect(cornersSignedArea(c)).toBeLessThan(0);
  expect(Math.abs(topEdgeBearing(c) - 90)).toBeLessThan(tolDeg);
  expect(c.topLeft[1]).toBeGreaterThan(c.bottomLeft[1]);
  expect(c.topRight[1]).toBeGreaterThan(c.bottomRight[1]);
  expect(c.topLeft[0]).toBeLessThan(c.topRight[0]);
  expect(c.bottomLeft[0]).toBeLessThan(c.bottomRight[0]);
}

describe('map standards come out north-up (#487)', () => {
  it('covers the standards the issue names', () => {
    const ids = FIXTURES.map((f) => f.id);
    for (const prefix of ['ustopo-2024', 'ustopo-2014', 'htmc', 'cantopo', 'austopo', 'fstopo']) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
    expect(ids).toContain('sepaq-anticosti-la-loutre');
  });

  describe.each(FIXTURES.map((f) => [f.id, f] as const))('%s', (_id, fixture) => {
    const res = parseGeoPdf(pdfForPage(fixture.page));
    const geo = primaryGeoreferenceForPage(res.georeferences, 0);
    const rotation = normalizePageRotation(fixture.page.Rotate);

    it('parses without a mirrored georeference', () => {
      expect(geo).toBeDefined();
      expect(res.warnings.filter((w) => w.includes('mirrored'))).toEqual([]);
    });

    if (fixture.expectedFrame === null) {
      it('keeps an unplaceable (native-CRS) sheet north-up in its own grid', () => {
        // x = easting, y = northing: the same winding test, in plane units.
        const c = geo!.viewport.corners;
        const ring = corners(c);
        let twice = 0;
        ring.forEach(([x1, y1], i) => {
          const [x2, y2] = ring[(i + 1) % 4]!;
          twice += x1 * y2 - x2 * y1;
        });
        expect(twice).toBeLessThan(0);
        expect(c.topLeft[1]).toBeGreaterThan(c.bottomLeft[1]);
        expect(c.topLeft[0]).toBeLessThan(c.topRight[0]);
      });
      return;
    }

    const [west, south, east, north] = fixture.expectedFrame;

    it('draws the rendered raster north-up, east-right and unmirrored', () => {
      expectNorthUp(displayedCorners(renderedPageCorners(geo!), rotation));
    });

    it("puts the catalogue's corners at the matching corners of the map frame", () => {
      const c = geo!.viewport.corners;
      // 40 % of the frame is looser than any real neatline/quad mismatch
      // (CanTopo: 29 %) and far tighter than a flip (the whole frame).
      const tolLng = (east - west) * 0.4;
      const tolLat = (north - south) * 0.4;
      const at = (p: LngLat, lng: number, lat: number) => {
        expect(Math.abs(p[0] - lng)).toBeLessThan(tolLng);
        expect(Math.abs(p[1] - lat)).toBeLessThan(tolLat);
      };
      const shown = displayedCorners(c, rotation);
      at(shown.topLeft, west, north);
      at(shown.topRight, east, north);
      at(shown.bottomRight, east, south);
      at(shown.bottomLeft, west, south);
    });

    it("draws the sheet's north-west at the raster's top-left pixel", () => {
      const raster = renderedPageCorners(geo!);
      expect(nearestCorner(displayedCorners(raster, rotation), [west, north])).toBe('topLeft');
      // …and that corner is pixel (0, 0) of what the rasterizer produces.
      const box = renderedPageRect(geo!);
      expect(rasterPixelOfPagePoint(box, 1, box.x0, box.y1)).toEqual([0, 0]);
    });
  });
});

/**
 * A consistent producer: one that lays a north-up sheet out on a page shown
 * at `/Rotate rotation`, then writes its viewport `/BBox` in `bboxOrder` and
 * its `/LPTS` against that BBox (the GDAL reading, which is how the real
 * top-first US Topo sheet is written). Whatever the combination, the sheet
 * must come out north-up.
 */
describe('synthetic: every /Rotate × BBox order × LPTS order', () => {
  const W = 500;
  const H = 700;
  // Frame in user space, and the sheet: lon -70..-69, lat 46..47.
  const frame = { x0: 50, y0: 60, x1: 450, y1: 640 };
  const NW: LngLat = [-70, 47];
  const NE: LngLat = [-69, 47];
  const SE: LngLat = [-69, 46];
  const SW: LngLat = [-70, 46];

  /**
   * Geographic position of the frame's user-space corners for a page shown at
   * `rotation`: the frame corner the viewer displays top-left is the NW one.
   */
  function frameGeo(rotation: PageRotation): CornerCoordinates {
    // displayedCorners(raster, r) must be {NW, NE, SE, SW}; undo the turn.
    let raster: CornerCoordinates = { topLeft: NW, topRight: NE, bottomRight: SE, bottomLeft: SW };
    for (let i = 0; i < (4 - rotation / 90) % 4; i++) raster = displayedCorners(raster, 90);
    return raster;
  }

  /** Page point → lon/lat, bilinear (exact: affine on a rectangle). */
  function pageToGeo(c: CornerCoordinates, x: number, y: number): LngLat {
    const u = (x - frame.x0) / (frame.x1 - frame.x0);
    const v = (y - frame.y0) / (frame.y1 - frame.y0);
    const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    return lerp(lerp(c.bottomLeft, c.bottomRight, u), lerp(c.topLeft, c.topRight, u), v);
  }

  const BBOX_ORDERS = {
    'bottom-first': [frame.x0, frame.y0, frame.x1, frame.y1],
    'top-first (2024 US Topo)': [frame.x0, frame.y1, frame.x1, frame.y0],
    'right-first': [frame.x1, frame.y0, frame.x0, frame.y1],
    'both reversed': [frame.x1, frame.y1, frame.x0, frame.y0],
  } as const;

  const LPTS_ORDERS = {
    'ISO default': [0, 0, 0, 1, 1, 1, 1, 0],
    'upper-left first (Sépaq/FSTopo)': [0, 1, 0, 0, 1, 0, 1, 1],
    'inset clockwise (UTM export)': [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9],
  } as const;

  const cases: [PageRotation, string, string][] = [];
  for (const r of [0, 90, 180, 270] as const) {
    for (const b of Object.keys(BBOX_ORDERS)) {
      for (const l of Object.keys(LPTS_ORDERS)) cases.push([r, b, l]);
    }
  }

  it.each(cases)('/Rotate %p, BBox %s, LPTS %s', (rotation, bboxName, lptsName) => {
    const bbox = BBOX_ORDERS[bboxName as keyof typeof BBOX_ORDERS];
    const lpts = LPTS_ORDERS[lptsName as keyof typeof LPTS_ORDERS];
    const geoCorners = frameGeo(rotation);
    const gpts: number[] = [];
    for (let i = 0; i < lpts.length; i += 2) {
      const x = bbox[0] + lpts[i]! * (bbox[2] - bbox[0]);
      const y = bbox[1] + lpts[i + 1]! * (bbox[3] - bbox[1]);
      const [lon, lat] = pageToGeo(geoCorners, x, y);
      gpts.push(lat, lon);
    }
    const res = parseGeoPdf(
      pdfForPage({
        MediaBox: [0, 0, W, H],
        Rotate: rotation,
        VP: [
          {
            Type: '/Viewport',
            BBox: [...bbox],
            Measure: {
              Type: '/Measure',
              Subtype: '/GEO',
              LPTS: [...lpts],
              GPTS: gpts,
              GCS: { Type: '/GEOGCS', EPSG: 4326 },
            },
          },
        ],
      }),
    );
    expect(res.warnings).toEqual([]);
    const geo = res.georeferences[0]!;
    expect(geo.viewport.rect).toEqual(frame);

    // The frame as a viewer shows it is exactly the sheet, north-up.
    const shown = displayedCorners(geo.viewport.corners, rotation);
    const close = (p: LngLat, q: LngLat) => {
      expect(p[0]).toBeCloseTo(q[0], 9);
      expect(p[1]).toBeCloseTo(q[1], 9);
    };
    close(shown.topLeft, NW);
    close(shown.topRight, NE);
    close(shown.bottomRight, SE);
    close(shown.bottomLeft, SW);

    // The raster MapLibre draws is unmirrored, and north-up once displayed.
    const raster = renderedPageCorners(geo);
    expect(cornersSignedArea(raster)).toBeLessThan(0);
    expectNorthUp(displayedCorners(raster, rotation), 1);
  });

  it('flags a producer whose LPTS ignore its own top-first BBox order', () => {
    // LPTS written for a bottom-first box, BBox written top-first: the file
    // contradicts itself, and the result would be a mirror image.
    const res = parseGeoPdf(
      pdfForPage({
        MediaBox: [0, 0, W, H],
        VP: [
          {
            Type: '/Viewport',
            BBox: [frame.x0, frame.y1, frame.x1, frame.y0],
            Measure: {
              Type: '/Measure',
              Subtype: '/GEO',
              GPTS: [46, -70, 47, -70, 47, -69, 46, -69],
              GCS: { Type: '/GEOGCS', EPSG: 4326 },
            },
          },
        ],
      }),
    );
    expect(res.warnings).toContain(
      'page 0: georeference is mirrored (check /BBox and /LPTS order)',
    );
  });
});
