import type { LngLat } from '@core/models';
import { planPdfDetailTiles, rasterCropGeometry } from './pdfDetail';
import { blockDiagonalErrorPx, pageToMercator, planDetailBlocks } from './pdfDetailBlocks';
import { blockTileKey, coverFromCache, parseTileKey, type CachedTile } from './pdfTileCache';

// A US Topo-like sheet: a lat/lon rectangle (a rectangle in Mercator too).
const rect: [LngLat, LngLat, LngLat, LngLat] = [
  [-69.5, 47.5],
  [-69.375, 47.5],
  [-69.375, 47.375],
  [-69.5, 47.375],
];
// A sheet placed by four unrelated corners (strongly non-parallelogram).
const skewed: [LngLat, LngLat, LngLat, LngLat] = [
  [-71, 46],
  [-70.8, 47],
  [-69.8, 47.1],
  [-70, 46.1],
];
const page = { width: 1600, height: 1940 };

const cellsOf = (x0: number, y0: number, x1: number, y1: number) => {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
};

describe('planDetailBlocks', () => {
  it('renders a whole view of cells as one block when it fits the crop limits', () => {
    const blocks = planDetailBlocks({
      corners: rect,
      page,
      divisions: 32,
      cellWidthPx: 384,
      cells: cellsOf(10, 12, 12, 15),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ x: 10, y: 12, cols: 3, rows: 4, targetWidthPx: 1152 });
  });

  it('draws a block at exactly the scale of its cells (same pixels per point)', () => {
    const cell = rasterCropGeometry(page.width, page.height, 480, {
      x0: 0,
      y0: 0,
      x1: 1 / 32,
      y1: 1 / 32,
    });
    const [block] = planDetailBlocks({
      corners: rect,
      page,
      divisions: 32,
      cellWidthPx: 480,
      cells: cellsOf(4, 4, 6, 6),
    });
    const g = rasterCropGeometry(page.width, page.height, block!.targetWidthPx, block!.crop);
    expect(g.scale).toBeCloseTo(cell.scale, 12);
    expect(g.widthPx).toBeGreaterThanOrEqual(3 * cell.widthPx);
    expect(g.widthPx).toBeLessThanOrEqual(3 * cell.widthPx + 2);
  });

  it('splits a set too large for one crop, every block within the limits, every cell once', () => {
    const cells = cellsOf(0, 0, 5, 5);
    const blocks = planDetailBlocks({
      corners: rect,
      page,
      divisions: 32,
      cellWidthPx: 768,
      cells,
    });
    expect(blocks.length).toBeGreaterThan(1);
    const seen = new Map<string, number>();
    for (const b of blocks) {
      const g = rasterCropGeometry(page.width, page.height, b.targetWidthPx, b.crop);
      expect(g.widthPx).toBeLessThanOrEqual(3072);
      expect(g.heightPx).toBeLessThanOrEqual(3072);
      expect(g.widthPx * g.heightPx).toBeLessThanOrEqual(3 * 1024 * 1024);
      for (let y = b.y; y < b.y + b.rows; y++)
        for (let x = b.x; x < b.x + b.cols; x++)
          seen.set(`${x}:${y}`, (seen.get(`${x}:${y}`) ?? 0) + 1);
    }
    for (const c of cells) expect(seen.get(`${c.x}:${c.y}`)).toBe(1);
  });

  it('never reaches outside the bounding rectangle of the cells asked for', () => {
    const blocks = planDetailBlocks({
      corners: rect,
      page,
      divisions: 16,
      cellWidthPx: 512,
      cells: [
        { x: 2, y: 2 },
        { x: 4, y: 3 },
      ],
    });
    for (const b of blocks) {
      expect(b.x).toBeGreaterThanOrEqual(2);
      expect(b.y).toBeGreaterThanOrEqual(2);
      expect(b.x + b.cols - 1).toBeLessThanOrEqual(4);
      expect(b.y + b.rows - 1).toBeLessThanOrEqual(3);
    }
  });

  it('places a block exactly where its cells would be placed', () => {
    const tiles = planPdfDetailTiles(
      rect,
      page,
      { west: -69.45, east: -69.43, south: 47.43, north: 47.45 },
      1080,
    );
    const first = parseTileKey(tiles[0]!.tileKey)!;
    const blocks = planDetailBlocks({
      corners: rect,
      page,
      divisions: first.divisions,
      cellWidthPx: first.width,
      cells: tiles.map((t) => parseTileKey(t.tileKey)!),
    });
    for (const b of blocks) {
      // The block's top-left corner is the top-left corner of its first cell.
      const topLeft = tiles.find((t) => {
        const c = parseTileKey(t.tileKey)!;
        return c.x === b.x && c.y === b.y;
      });
      if (!topLeft) continue;
      expect(b.coordinates[0][0]).toBeCloseTo(topLeft.coordinates[0][0], 10);
      expect(b.coordinates[0][1]).toBeCloseTo(topLeft.coordinates[0][1], 10);
    }
  });

  it('orders blocks nearest the focus first', () => {
    const blocks = planDetailBlocks({
      corners: rect,
      page,
      divisions: 32,
      cellWidthPx: 1024,
      cells: cellsOf(0, 0, 7, 0),
      focus: { x: 7.5, y: 0.5 },
    });
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]!.x + blocks[0]!.cols).toBe(8);
  });

  it('ignores duplicates and cells off the grid', () => {
    expect(
      planDetailBlocks({
        corners: rect,
        page,
        divisions: 4,
        cellWidthPx: 256,
        cells: [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
          { x: 9, y: 0 },
          { x: -1, y: 0 },
          { x: 0.5, y: 0 },
        ],
      }),
    ).toHaveLength(1);
    expect(
      planDetailBlocks({ corners: rect, page, divisions: 4, cellWidthPx: 256, cells: [] }),
    ).toEqual([]);
  });
});

describe('the page diagonal', () => {
  it('is free for a rectangle sheet: a block may cross it', () => {
    expect(blockDiagonalErrorPx(rect, 8, 512, { x: 2, y: 2, cols: 4, rows: 4 })).toBeLessThan(1e-6);
  });

  it('measures the misplacement of a skewed sheet crossing it, and zero off it', () => {
    expect(blockDiagonalErrorPx(skewed, 8, 512, { x: 0, y: 0, cols: 2, rows: 2 })).toBe(0);
    expect(blockDiagonalErrorPx(skewed, 8, 512, { x: 2, y: 2, cols: 3, rows: 3 })).toBeGreaterThan(
      0.25,
    );
  });

  it('splits a crossing block on a skewed sheet until each piece is exact enough', () => {
    const blocks = planDetailBlocks({
      corners: skewed,
      page,
      divisions: 16,
      cellWidthPx: 256,
      cells: cellsOf(5, 5, 10, 10),
    });
    for (const b of blocks) {
      expect(blockDiagonalErrorPx(skewed, 16, 256, b)).toBeLessThanOrEqual(0.25);
    }
  });

  it('agrees with the page mapping MapLibre uses for the overview', () => {
    const map = pageToMercator(skewed);
    const [x, y] = map(1, 1);
    expect(x).toBeCloseTo((-69.8 * Math.PI) / 180, 12);
    expect(y).toBeGreaterThan(0);
  });
});

describe('block rasters in the tile cache', () => {
  const tile = (key: string): CachedTile & { key: string } => ({
    key,
    pageKey: 'page',
    cell: parseTileKey(key),
    pixels: 1,
  });

  it('round-trips a block key', () => {
    const key = blockTileKey({ divisions: 32, x: 3, y: 4, width: 512, cols: 2, rows: 3 });
    expect(key).toBe('32:3:4:512:2x3');
    expect(parseTileKey(key)).toEqual({ divisions: 32, x: 3, y: 4, width: 512, cols: 2, rows: 3 });
    expect(parseTileKey('32:31:4:512:2x3')).toBeNull(); // runs off the grid
    expect(parseTileKey('32:3:4:512:0x3')).toBeNull();
    expect(parseTileKey('32:3:4:512:2y3')).toBeNull();
  });

  it('shows a cell from a block holding it, preferring the block over a lone tile', () => {
    const want = { divisions: 32, x: 4, y: 5, width: 512 };
    const cover = coverFromCache('page', want, [tile('32:4:5:512'), tile('32:3:4:512:2x3')]);
    expect(cover?.map((t) => t.key)).toEqual(['32:3:4:512:2x3']);
    expect(coverFromCache('page', { ...want, x: 5 }, [tile('32:3:4:512:2x3')])).toBeNull();
  });

  it('covers a zoomed-out cell from the previous zoom’s block, one texture', () => {
    const cover = coverFromCache('page', { divisions: 8, x: 3, y: 5, width: 768 }, [
      tile('16:5:9:512:4x4'),
    ]);
    expect(cover?.map((t) => t.key)).toEqual(['16:5:9:512:4x4']);
  });
});
