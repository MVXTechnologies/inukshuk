import { makeReprojector } from '@core/geo/geopdf/crs';
import type { BoundingBox } from '@core/models';
import {
  cropForPolygon,
  densifyBboxRing,
  maskRgbaOutsidePolygon,
  polygonRowSpan,
  projectRingToPixels,
  type PixelPoint,
} from './neatline';
import { planRasterDownscale, type RasterModel } from './rasterTiff';

/** The real 021L14 sheet: NAD83 / UTM 19N, 4.2334 m pixels, 11289 x 8183. */
const QUEBEC_MODEL: RasterModel = {
  x0: 307633.073099,
  y0: 5209773.397729,
  dx: 4.2334,
  dy: 4.2334,
};
/** NTS 021L14's graticule quad — the printed sheet's neatline. */
const QUEBEC_QUAD: BoundingBox = { minLng: -71.5, minLat: 46.75, maxLng: -71, maxLat: 47 };

describe('densifyBboxRing', () => {
  it('walks the box clockwise from the north-west with n points per edge', () => {
    const ring = densifyBboxRing({ minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 }, 2);
    expect(ring).toHaveLength(8);
    expect(ring[0]).toEqual([0, 1]);
    expect(ring[2]).toEqual([1, 1]);
    expect(ring[4]).toEqual([1, 0]);
    expect(ring[6]).toEqual([0, 0]);
  });

  it('densifies because a graticule edge is NOT straight in a projected grid', () => {
    const reprojector = makeReprojector({ epsg: 26919 });
    const ring = projectRingToPixels(QUEBEC_MODEL, reprojector, densifyBboxRing(QUEBEC_QUAD, 16));
    // Points 0..15 are the northern edge; a chord between its ends would miss
    // the middle by a measurable number of pixels.
    const first = ring[0]!;
    const last = ring[15]!;
    const middle = ring[8]!;
    const chordY = first.y + ((middle.x - first.x) / (last.x - first.x)) * (last.y - first.y);
    expect(Math.abs(middle.y - chordY)).toBeGreaterThan(1);
  });
});

describe('projectRingToPixels + cropForPolygon on the real Québec City sheet', () => {
  const reprojector = makeReprojector({ epsg: 26919 });
  const polygon = projectRingToPixels(QUEBEC_MODEL, reprojector, densifyBboxRing(QUEBEC_QUAD));

  it('lands the neatline inside the scan, inset by the paper collar', () => {
    const crop = cropForPolygon(polygon, 11289, 8183)!;
    // Measured against the published sheet: the map frame starts ~335 px in
    // from the left and ~372 px down, and stops well short of the legend panel
    // that fills the right-hand ~1 700 px.
    expect(crop.x).toBe(335);
    expect(crop.y).toBe(372);
    expect(crop.width).toBe(9189);
    expect(crop.height).toBe(6821);
  });

  it('discards the collar — a fifth of the scan is not map', () => {
    const crop = cropForPolygon(polygon, 11289, 8183)!;
    const kept = (crop.width * crop.height) / (11289 * 8183);
    expect(kept).toBeGreaterThan(0.65);
    expect(kept).toBeLessThan(0.72);
  });

  it('refuses a clip that misses the image, so a bad bbox draws the whole scan', () => {
    const elsewhere = projectRingToPixels(
      QUEBEC_MODEL,
      reprojector,
      densifyBboxRing({ minLng: 10, minLat: 40, maxLng: 11, maxLat: 41 }),
    );
    expect(cropForPolygon(elsewhere, 11289, 8183)).toBeNull();
  });

  it('refuses a polygon with fewer than three points, or a non-finite one', () => {
    expect(cropForPolygon([{ x: 1, y: 1 }], 100, 100)).toBeNull();
    expect(
      cropForPolygon(
        [
          { x: NaN, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
        100,
        100,
      ),
    ).toBeNull();
  });

  it('drops points that fail to project rather than producing NaN corners', () => {
    const broken = {
      ...makeReprojector({ epsg: 26919 }),
      fromWgs84: () => [NaN, NaN] as [number, number],
    };
    expect(projectRingToPixels(QUEBEC_MODEL, broken, densifyBboxRing(QUEBEC_QUAD))).toEqual([]);
  });
});

describe('polygonRowSpan', () => {
  const square: PixelPoint[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('spans the shape at a scanline that crosses it', () => {
    expect(polygonRowSpan(square, 5)).toEqual({ x0: 0, x1: 10 });
  });

  it('is null above and below the shape', () => {
    expect(polygonRowSpan(square, -1)).toBeNull();
    expect(polygonRowSpan(square, 11)).toBeNull();
  });

  it('follows a rotated quad, narrowing as the scanline nears a corner', () => {
    const diamond: PixelPoint[] = [
      { x: 5, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 5 },
    ];
    const wide = polygonRowSpan(diamond, 5)!;
    const narrow = polygonRowSpan(diamond, 1)!;
    expect(wide.x1 - wide.x0).toBeGreaterThan(narrow.x1 - narrow.x0);
  });
});

describe('maskRgbaOutsidePolygon', () => {
  it('clears alpha outside the polygon and leaves the inside opaque', () => {
    const plan = planRasterDownscale({ x: 0, y: 0, width: 10, height: 10 }, 10)!;
    const rgba = new Uint8Array(10 * 10 * 4).fill(255);
    maskRgbaOutsidePolygon(rgba, plan, [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ]);
    const alphaAt = (x: number, y: number): number | undefined => rgba[(y * 10 + x) * 4 + 3];
    expect(alphaAt(5, 5)).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(9, 9)).toBe(0);
    expect(alphaAt(5, 0)).toBe(0);
  });

  it('does nothing without a usable polygon', () => {
    const plan = planRasterDownscale({ x: 0, y: 0, width: 4, height: 4 }, 4)!;
    const rgba = new Uint8Array(4 * 4 * 4).fill(255);
    maskRgbaOutsidePolygon(rgba, plan, [{ x: 0, y: 0 }]);
    expect(rgba.every((v) => v === 255)).toBe(true);
  });
});
