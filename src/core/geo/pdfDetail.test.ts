import {
  planPdfDetail,
  rasterCropGeometry,
  planPdfDetailTiles,
  type PdfDetailPlan,
} from './pdfDetail';
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
  expect(g.widthPx).toBeLessThanOrEqual(3072);
  expect(g.heightPx).toBeLessThanOrEqual(3072);
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

const ecoCorners: typeof corners = [
  [-63.80551499883427, 49.665938252884004],
  [-63.475779930834975, 49.65138168291479],
  [-63.495360933724356, 49.46373648897131],
  [-63.82509600172365, 49.47829305894052],
];
const ecoPage = { width: 3456, height: 3024 };
it.each([false, true])(
  'keeps padding on the actual Eco viewport triangle (mirrored: %s)',
  (mirrored) => {
    const original: typeof corners = mirrored
      ? [ecoCorners[2], ecoCorners[3], ecoCorners[0], ecoCorners[1]]
      : ecoCorners;
    const width = 0.02;
    const height = (width * Math.cos((49.53913 * Math.PI) / 180) * 2600) / 1320;
    const result = planPdfDetail(
      original,
      ecoPage,
      {
        west: -63.65536 - width / 2,
        east: -63.65536 + width / 2,
        south: 49.53913 - height / 2,
        north: 49.53913 + height / 2,
      },
      1320,
    )!;
    // Inverse Mercator triangle coordinates of this exact viewport's corners.
    let visible = {
      left: 0.45904855561760116,
      right: 0.5274757685999377,
      top: 0.5677879551748847,
      bottom: 0.7080234831574245,
    };
    if (mirrored)
      visible = {
        left: 1 - visible.right,
        right: 1 - visible.left,
        top: 1 - visible.bottom,
        bottom: 1 - visible.top,
      };
    expect(result.crop.x0).toBeLessThanOrEqual(visible.left + 1e-12);
    expect(result.crop.x1).toBeGreaterThanOrEqual(visible.right - 1e-12);
    expect(result.crop.y0).toBeLessThanOrEqual(visible.top + 1e-12);
    expect(result.crop.y1).toBeGreaterThanOrEqual(visible.bottom - 1e-12);
    if (mirrored) expect(result.crop.x1 + result.crop.y1).toBeLessThanOrEqual(1);
    else expect(result.crop.x0 + result.crop.y0).toBeGreaterThanOrEqual(1);
    const project = ([lng, lat]: LngLat) => [
      (lng * Math.PI) / 180,
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
    ];
    const at = (quad: typeof corners, u: number, v: number) => {
      const [a, b, c, d] = quad.map(project);
      return [0, 1].map(
        (i) =>
          a![i]! +
          u * (b![i]! - a![i]!) +
          v * (d![i]! - a![i]!) +
          Math.max(0, u + v - 1) * (c![i]! - b![i]! - d![i]! + a![i]!),
      );
    };
    for (const u of [0, 0.25, 0.5, 0.75, 1])
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const full = at(
          original,
          result.crop.x0 + u * (result.crop.x1 - result.crop.x0),
          result.crop.y0 + v * (result.crop.y1 - result.crop.y0),
        );
        const detail = at(result.coordinates, u, v);
        expect(detail[0]).toBeCloseTo(full[0]!, 12);
        expect(detail[1]).toBeCloseTo(full[1]!, 12);
      }
    const visibleWidthPx =
      (result.targetWidthPx * (visible.right - visible.left)) / (result.crop.x1 - result.crop.x0);
    // Previously only 259 pixels spanned the 1320-pixel viewport, a 5x enlargement.
    expect(visibleWidthPx).toBeGreaterThan(950);
    const geometry = rasterCropGeometry(
      ecoPage.width,
      ecoPage.height,
      result.targetWidthPx,
      result.crop,
    );
    expect(geometry.widthPx * geometry.heightPx).toBeLessThanOrEqual(3 * 1024 * 1024);
  },
);
it('uses the existing pixel budget for tall portrait detail instead of an unnecessarily short edge', () => {
  const result = rasterCropGeometry(1320, 2600, 1320, { x0: 0, y0: 0, x1: 1, y1: 1 });
  expect(result.widthPx).toBeGreaterThan(1250);
  expect(result.heightPx).toBeGreaterThan(2450);
  expect(result.widthPx * result.heightPx).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(Math.max(result.widthPx, result.heightPx)).toBeLessThanOrEqual(3072);
});
it('tiles the genuinely diagonal-crossing Eco view within one bounded pixel budget', () => {
  const width = 0.03;
  const height = (width * Math.cos((49.53913 * Math.PI) / 180) * 2600) / 1320;
  const bounds = {
    west: -63.65536 - width / 2,
    east: -63.65536 + width / 2,
    south: 49.53913 - height / 2,
    north: 49.53913 + height / 2,
  };
  const tiles = planPdfDetailTiles(ecoCorners, ecoPage, bounds, 1320);
  expect(tiles.length).toBeGreaterThan(1);
  expect(tiles.length).toBeLessThanOrEqual(24);
  let pixels = 0;
  for (const tile of tiles) {
    const geometry = rasterCropGeometry(
      ecoPage.width,
      ecoPage.height,
      tile.targetWidthPx,
      tile.crop,
    );
    pixels += geometry.widthPx * geometry.heightPx;
    // Exact inverse-projected viewport width: previously389pixels on1320screen.
    expect(
      (tile.targetWidthPx / (tile.crop.x1 - tile.crop.x0)) * 0.1026404969831079,
    ).toBeGreaterThan(1150);
    expect(tile.tileKey).toBeDefined();
  }
  expect(pixels).toBeLessThanOrEqual(6 * 1024 * 1024);
});

const ecoTileBounds = (() => {
  const width = 0.03;
  const height = (width * Math.cos((49.53913 * Math.PI) / 180) * 2600) / 1320;
  return {
    west: -63.65536 - width / 2,
    east: -63.65536 + width / 2,
    south: 49.53913 - height / 2,
    north: 49.53913 + height / 2,
  };
})();
function projectedPoint(quad: typeof corners, u: number, v: number): LngLat {
  const project = ([lng, lat]: LngLat): LngLat => [
    (lng * Math.PI) / 180,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  ];
  const [a, b, c, d] = quad.map(project) as typeof corners;
  return [0, 1].map(
    (i) =>
      a[i]! +
      u * (b[i]! - a[i]!) +
      v * (d[i]! - a[i]!) +
      Math.max(0, u + v - 1) * (c[i]! - b[i]! - d[i]! + a[i]!),
  ) as LngLat;
}
it.each([3, 6])(
  'covers the complete visible region without holes, within a %s Mi-pixel budget',
  (mip) => {
    const tiles = planPdfDetailTiles(ecoCorners, ecoPage, ecoTileBounds, 1320, mip * 1024 * 1024);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(24);
    let total = 0;
    for (const tile of tiles) {
      const r = tile.crop;
      expect(r.x1 - r.x0).toBe(r.y1 - r.y0);
      // Every tile's two native triangles coincide with the original mapping.
      for (const u of [0, 0.25, 0.5, 0.75, 1])
        for (const v of [0, 0.25, 0.5, 0.75, 1]) {
          const full = projectedPoint(
            ecoCorners,
            r.x0 + u * (r.x1 - r.x0),
            r.y0 + v * (r.y1 - r.y0),
          );
          const detail = projectedPoint(tile.coordinates, u, v);
          expect(detail[0]).toBeCloseTo(full[0], 12);
          expect(detail[1]).toBeCloseTo(full[1], 12);
        }
      const geometry = rasterCropGeometry(ecoPage.width, ecoPage.height, tile.targetWidthPx, r);
      total += geometry.widthPx * geometry.heightPx;
    }
    // Exact inverse bounds of the real portrait fixture, including its corners.
    for (let x = 0; x <= 20; x++)
      for (let y = 0; y <= 20; y++) {
        const u = 0.44194141709535734 + (x / 20) * (0.5445819140784652 - 0.44194141709535734);
        const v = 0.5327179887793808 + (y / 20) * (0.7430712886580432 - 0.5327179887793808);
        expect(
          tiles.some(
            ({ crop: r }) =>
              u >= r.x0 - 1e-12 && u <= r.x1 + 1e-12 && v >= r.y0 - 1e-12 && v <= r.y1 + 1e-12,
          ),
        ).toBe(true);
      }
    expect(total).toBeLessThanOrEqual(mip * 1024 * 1024);
  },
);
it('keeps stable tile keys and geometry across a small pan and orders the nearest tile first', () => {
  const first = planPdfDetailTiles(ecoCorners, ecoPage, ecoTileBounds, 1320);
  const next = planPdfDetailTiles(
    ecoCorners,
    ecoPage,
    { ...ecoTileBounds, west: ecoTileBounds.west + 1e-7, east: ecoTileBounds.east + 1e-7 },
    1320,
  );
  expect(next.map((p) => p.tileKey).sort()).toEqual(first.map((p) => p.tileKey).sort());
  for (const tile of next) expect(tile).toEqual(first.find((p) => p.tileKey === tile.tileKey));
  const cx = (0.44194141709535734 + 0.5445819140784652) / 2,
    cy = (0.5327179887793808 + 0.7430712886580432) / 2;
  const distance = (p: (typeof first)[number]) =>
    ((p.crop.x0 + p.crop.x1) / 2 - cx) ** 2 + ((p.crop.y0 + p.crop.y1) / 2 - cy) ** 2;
  for (const tile of first)
    expect(distance(tile)).toBeGreaterThanOrEqual(distance(first[0]!) - 1e-12);
});
it('skips invalid, distant, and overview-only tile requests', () => {
  expect(planPdfDetailTiles(corners, page, { west: 0, east: 1, south: 0, north: 1 }, 1320)).toEqual(
    [],
  );
  expect(
    planPdfDetailTiles(corners, page, { west: -72, east: -69, south: 45, north: 48 }, 1320),
  ).toEqual([]);
  expect(planPdfDetailTiles(corners, page, view, 1320, 0)).toEqual([]);
  expect(planPdfDetailTiles(corners, page, { ...view, east: NaN }, 1320)).toEqual([]);
});

it.each([90, -90, 270])(
  'preserves portrait physical sampling at a %s degree bearing',
  (bearing) => {
    // One square page in Mercator. Both views have the same zoom and a
    // 1200×2400 physical map frame; rotation swaps their geographic spans.
    const lng = (x: number) => (x * 180) / Math.PI;
    const lat = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
    const square: typeof corners = [
      [lng(-1.2), lat(0.81)],
      [lng(-1.19), lat(0.81)],
      [lng(-1.19), lat(0.8)],
      [lng(-1.2), lat(0.8)],
    ];
    const viewport = (width: number, height: number) => ({
      west: lng(-1.195 - width / 2),
      east: lng(-1.195 + width / 2),
      south: lat(0.805 - height / 2),
      north: lat(0.805 + height / 2),
    });
    const normal = planPdfDetailTiles(square, page, viewport(0.0005, 0.001), 1200);
    const rotated = planPdfDetailTiles(square, page, viewport(0.001, 0.0005), 1200, undefined, {
      heightPx: 2400,
      bearing,
    });
    const density = (tiles: PdfDetailPlan[]) =>
      tiles[0]!.targetWidthPx / (tiles[0]!.crop.x1 - tiles[0]!.crop.x0);
    // Before the fix, a rotated frame had only 1229 samples over its 2400 px edge.
    expect(density(rotated) * 0.1).toBeGreaterThanOrEqual(2400);
    expect(density(rotated)).toBe(density(normal));
    const pixels = rotated.reduce((total, tile) => {
      const raster = rasterCropGeometry(page.width, page.height, tile.targetWidthPx, tile.crop);
      return total + raster.widthPx * raster.heightPx;
    }, 0);
    expect(pixels).toBeLessThanOrEqual(6 * 1024 * 1024);
  },
);

it.each([
  { heightPx: 0, bearing: 90 },
  { heightPx: NaN, bearing: 90 },
  { heightPx: 2400, bearing: Infinity },
])('rejects invalid physical map-frame inputs %j', (viewport) => {
  expect(planPdfDetailTiles(corners, page, view, 1200, undefined, viewport)).toEqual([]);
});
