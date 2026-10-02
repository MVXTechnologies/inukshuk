import { coverFromCache, parseTileKey, pdfTileBudgets, type CachedTile } from './pdfTileCache';

const tile = (key: string, pageKey = 'page', pixels = 100): CachedTile & { key: string } => ({
  key,
  pageKey,
  cell: parseTileKey(key),
  pixels,
});

describe('parseTileKey', () => {
  it('reads a planner tile key', () => {
    expect(parseTileKey('8:3:5:768')).toEqual({ divisions: 8, x: 3, y: 5, width: 768 });
  });

  it.each([
    [undefined],
    [''],
    ['8:3:5'],
    ['8:3:5:768:1'],
    ['{"x0":0}'],
    ['8:8:0:768'], // x outside the grid
    ['8:0:9:768'],
    ['0:0:0:768'],
    ['8:0:0:0'],
    ['8:-1:0:768'],
    ['8:1.5:0:768'],
  ])('rejects %j', (key) => {
    expect(parseTileKey(key)).toBeNull();
  });
});

describe('coverFromCache', () => {
  const want = { divisions: 8, x: 3, y: 5, width: 768 };

  it('uses the same cell when it is at least as wide, preferring the narrowest', () => {
    const cached = [tile('8:3:5:1536'), tile('8:3:5:1024'), tile('8:3:5:640')];
    expect(coverFromCache('page', want, cached)?.map((t) => t.key)).toEqual(['8:3:5:1024']);
  });

  it('accepts the exact width', () => {
    expect(coverFromCache('page', want, [tile('8:3:5:768')])?.map((t) => t.key)).toEqual([
      '8:3:5:768',
    ]);
  });

  it('never shows a narrower (blurrier) raster of the same cell', () => {
    expect(coverFromCache('page', want, [tile('8:3:5:640')])).toBeNull();
  });

  it('covers a zoomed-out cell with its four children from the previous zoom', () => {
    const cached = [
      tile('16:6:10:512'),
      tile('16:7:10:384'),
      tile('16:6:11:384'),
      tile('16:7:11:384'),
      tile('16:7:11:768'), // a wider duplicate: the narrower one is enough
      tile('16:8:10:768'), // not a child
    ];
    expect(
      coverFromCache('page', want, cached)
        ?.map((t) => t.key)
        .sort(),
    ).toEqual(['16:6:10:512', '16:6:11:384', '16:7:10:384', '16:7:11:384']);
  });

  it('prefers the single same-cell raster over four children', () => {
    const cached = [
      tile('16:6:10:512'),
      tile('16:7:10:512'),
      tile('16:6:11:512'),
      tile('16:7:11:512'),
      tile('8:3:5:768'),
    ];
    expect(coverFromCache('page', want, cached)?.map((t) => t.key)).toEqual(['8:3:5:768']);
  });

  it('needs all four children, each at least half as wide', () => {
    const three = [tile('16:6:10:512'), tile('16:7:10:512'), tile('16:6:11:512')];
    expect(coverFromCache('page', want, three)).toBeNull();
    const narrow = [...three, tile('16:7:11:256')];
    expect(coverFromCache('page', want, narrow)).toBeNull();
  });

  it('never mixes pages or looks, and skips rasters off the grid', () => {
    const cached = [
      tile('8:3:5:1024', 'other page'),
      { key: 'crop', pageKey: 'page', cell: null, pixels: 1 },
    ];
    expect(coverFromCache('page', want, cached)).toBeNull();
  });

  it('ignores grandchildren (two levels down would cost 16 textures)', () => {
    const cached = [];
    for (let y = 20; y < 24; y++)
      for (let x = 12; x < 16; x++) cached.push(tile(`32:${x}:${y}:512`));
    expect(coverFromCache('page', want, cached)).toBeNull();
  });
});

describe('pdfTileBudgets', () => {
  it('prefetches a ring and keeps a generous file cache normally', () => {
    const b = pdfTileBudgets(false);
    expect(b.prefetchMargin).toBeGreaterThan(0);
    expect(b.maxPrefetchTiles).toBeGreaterThan(0);
    expect(b.holdDocument).toBe(true);
    expect(b.settledPixels).toBeLessThanOrEqual(b.handoffPixels);
    // Keeping the previous zoom's tiles on screen is at most another view's worth.
    expect(b.fallbackPixels).toBeLessThanOrEqual(b.visiblePixels);
  });

  it('drops the ring and shrinks every cache after a memory warning', () => {
    const normal = pdfTileBudgets(false);
    const low = pdfTileBudgets(true);
    expect(low.prefetchMargin).toBe(0);
    expect(low.maxPrefetchTiles).toBe(0);
    expect(low.holdDocument).toBe(false);
    expect(low.visiblePixels).toBe(normal.visiblePixels);
    expect(low.fallbackPixels).toBeLessThan(normal.fallbackPixels);
    expect(low.cacheFiles).toBeLessThan(normal.cacheFiles);
    expect(low.settledPixels).toBeLessThan(normal.settledPixels);
    expect(low.settledPixels).toBeLessThanOrEqual(low.handoffPixels);
    // Still room for a full view plus a little continuity.
    expect(low.settledPixels).toBeGreaterThanOrEqual(low.visiblePixels);
  });
});
