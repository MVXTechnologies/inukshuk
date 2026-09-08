import { planPdfDetail, rasterCropGeometry } from './pdfDetail';
import type { LngLat } from '@core/models';

const corners: [LngLat, LngLat, LngLat, LngLat] = [
  [-71, 47],
  [-70, 47],
  [-70, 46],
  [-71, 46],
];
const page = { width: 1000, height: 1000 };
const view = { west: -70.6, east: -70.5, south: 46.4, north: 46.5 };

it('refines a visible crop instead of enlarging a whole page', () => {
  const result = planPdfDetail(corners, page, view, 1200);
  expect(result).not.toBeNull();
  expect(result!.crop.x0).toBeLessThanOrEqual(0.4);
  expect(result!.crop.x1).toBeGreaterThanOrEqual(0.5);
  expect(result!.coordinates[0][0]).toBeCloseTo(-71 + result!.crop.x0);
  expect(result!.coordinates[0][1]).toBeGreaterThan(47 - result!.crop.y0);
  expect(result!.coordinates[2][1]).toBeGreaterThan(47 - result!.crop.y1);
  expect(result!.targetWidthPx / (result!.crop.x1 - result!.crop.x0)).toBeGreaterThan(2048);
});

it('preserves native Mercator triangle mapping for skewed crops crossing the diagonal', () => {
  const rotated: typeof corners = [
    [-71, 46],
    [-70.8, 47],
    [-69.8, 47.1],
    [-70, 46.1],
  ];
  const project = ([lng, lat]: LngLat): LngLat => [
    (lng * Math.PI) / 180,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
  const interpolate = (c: typeof corners, u: number, v: number) => {
    const [a, b, d, e] = c.map(project) as typeof corners;
    return [0, 1].map(
      (i) =>
        a[i]! +
        u * (b[i]! - a[i]!) +
        v * (e[i]! - a[i]!) +
        Math.max(0, u + v - 1) * (d[i]! - b[i]! - e[i]! + a[i]!),
    );
  };
  const result = planPdfDetail(
    rotated,
    page,
    { west: -70.5, east: -70.4, south: 46.5, north: 46.6 },
    1200,
  )!;
  const r = result.crop;
  for (const u of [0, 0.25, 0.5, 0.75, 1])
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const original = interpolate(rotated, r.x0 + u * (r.x1 - r.x0), r.y0 + v * (r.y1 - r.y0));
      const detail = interpolate(result.coordinates, u, v);
      expect(detail[0]).toBeCloseTo(original[0]!, 12);
      expect(detail[1]).toBeCloseTo(original[1]!, 12);
    }
});

it('skips distant maps, overview zoom and unsupported wrapping bounds', () => {
  expect(planPdfDetail(corners, page, { west: 0, east: 1, south: 0, north: 1 }, 1200)).toBeNull();
  expect(
    planPdfDetail(corners, page, { west: -72, east: -69, south: 45, north: 48 }, 1200),
  ).toBeNull();
  expect(planPdfDetail(corners, page, { ...view, west: 179, east: -179 }, 1200)).toBeNull();
});

it('keeps crop output bounded even for extreme aspect ratios', () => {
  const g = rasterCropGeometry(100, 10000, 5000, { x0: 0, y0: 0, x1: 1, y1: 1 });
  expect(g.widthPx).toBeLessThanOrEqual(2048);
  expect(g.heightPx).toBeLessThanOrEqual(2048);
  expect(g.widthPx * g.heightPx).toBeLessThanOrEqual(3 * 1024 * 1024);
});

it('translates a top-left-origin crop without flipping its image', () => {
  const g = rasterCropGeometry(1000, 800, 1000, { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75 });
  expect(g).toMatchObject({
    widthPx: 1000,
    heightPx: 800,
    scale: 4,
    offsetX: -1000,
    offsetY: -1600,
  });
});

it('rejects invalid crop dimensions before allocating a canvas', () => {
  expect(() => rasterCropGeometry(100, 100, 2048, { x0: 1, y0: 0, x1: 0, y1: 1 })).toThrow();
  expect(() => rasterCropGeometry(0, 100, 2048, null)).toThrow();
  expect(() => rasterCropGeometry(100, 100, NaN, null)).toThrow();
});
