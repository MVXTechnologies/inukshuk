import {
  GeometryIndex,
  isMountainous,
  latToTileY,
  lonToTileX,
  MOUNTAIN_THRESHOLDS,
  pointInRings,
  reliefStats,
  segmentIntersectsBbox,
  summarizeTerrariumTile,
  terrariumMeters,
  tilesForBbox,
  type BlockSummary,
} from './terrain';

/** RGB that Terrarium-encodes `m` metres (integer part only). */
function encode(m: number): [number, number, number] {
  const v = m + 32768;
  return [Math.floor(v / 256), Math.floor(v % 256), 0];
}

describe('Terrarium decoding and tile math', () => {
  it('decodes the Terrarium encoding', () => {
    expect(terrariumMeters(128, 0, 0)).toBe(0);
    expect(terrariumMeters(...encode(1234))).toBe(1234);
    expect(terrariumMeters(...encode(-50))).toBe(-50);
    expect(terrariumMeters(128, 0, 128)).toBe(0.5);
  });

  it('computes tile coordinates', () => {
    expect(lonToTileX(-180, 1)).toBe(0);
    expect(lonToTileX(0, 1)).toBe(1);
    expect(latToTileY(0, 3)).toBeCloseTo(4);
    expect(latToTileY(89.9, 0)).toBeCloseTo(0);
  });

  it('lists the tiles a bbox touches', () => {
    expect(tilesForBbox([-1, -1, 1, 1], 1)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(tilesForBbox([10, 10, 11, 11], 1)).toEqual([{ x: 1, y: 0 }]);
  });
});

describe('summarizeTerrariumTile', () => {
  it('reduces pixels to per-block land min/max, clamping bathymetry to 0', () => {
    const size = 4;
    const rgba = new Uint8Array(size * size * 4);
    const heights = [
      [-3000, 10, 100, 200],
      [5, 20, 300, 400],
      [0, 0, 1000, 1000],
      [0, 0, 1000, 2500],
    ];
    heights.forEach((row, y) =>
      row.forEach((m, x) => {
        const [r, g, b] = encode(m);
        rgba.set([r, g, b, 255], (y * size + x) * 4);
      }),
    );
    const s = summarizeTerrariumTile(rgba, size, 2);
    expect(s.side).toBe(2);
    expect([...s.min]).toEqual([0, 100, 0, 1000]);
    expect([...s.max]).toEqual([20, 400, 0, 2500]);
  });
});

describe('reliefStats / isMountainous', () => {
  /** One zoom-0 tile of 4 × 4 blocks with the given per-block [min,max]. */
  const tile = (blocks: [number, number][]): BlockSummary => ({
    side: 4,
    min: Int16Array.from(blocks.map((b) => b[0])),
    max: Int16Array.from(blocks.map((b) => b[1])),
  });
  const flat = tile(Array.from({ length: 16 }, () => [100, 150] as [number, number]));
  const peaky = tile(
    Array.from({ length: 16 }, (_, i) => (i === 5 ? [200, 1400] : [200, 300]) as [number, number]),
  );

  it('scores the whole world against one tile', () => {
    const stats = reliefStats([-180, -85, 180, 85], 0, 4, () => flat);
    expect(stats).toMatchObject({ min: 100, max: 150, relief: 50, localRelief: 50, blocks: 16 });
    expect(isMountainous(stats!)).toBe(false);
  });

  it('finds a local peak', () => {
    const stats = reliefStats([-180, -85, 180, 85], 0, 4, () => peaky)!;
    expect(stats.localRelief).toBe(1200);
    expect(isMountainous(stats)).toBe(true);
  });

  it('falls back to touched blocks for a footprint smaller than a block', () => {
    const stats = reliefStats([-100, 30, -99.9, 30.1], 0, 4, () => peaky);
    expect(stats?.blocks).toBe(1);
  });

  it('is null when no tile is available', () => {
    expect(reliefStats([-10, -10, 10, 10], 0, 4, () => undefined)).toBeNull();
  });

  it('counts high country only with real relief', () => {
    const t = MOUNTAIN_THRESHOLDS;
    const base = { min: 0, relief: 0, blocks: 1 };
    expect(isMountainous({ ...base, max: t.highMax + 100, localRelief: t.highLocalRelief })).toBe(
      true,
    );
    expect(isMountainous({ ...base, max: t.highMax + 100, localRelief: 50 })).toBe(false);
    expect(isMountainous({ ...base, max: 500, localRelief: t.localRelief })).toBe(true);
  });
});

describe('segment / polygon geometry', () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];

  it('segmentIntersectsBbox: crossing, inside, outside, parallel', () => {
    expect(segmentIntersectsBbox([-5, 5], [15, 5], box)).toBe(true);
    expect(segmentIntersectsBbox([2, 2], [3, 3], box)).toBe(true);
    expect(segmentIntersectsBbox([-5, -5], [-1, 20], box)).toBe(false);
    expect(segmentIntersectsBbox([11, 0], [11, 10], box)).toBe(false);
    expect(segmentIntersectsBbox([-5, 20], [20, -5.1], box)).toBe(true);
    expect(segmentIntersectsBbox([-5, 26], [26, -5], box)).toBe(false);
  });

  it('pointInRings honours holes', () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const hole: [number, number][] = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ];
    expect(pointInRings([2, 2], [outer, hole])).toBe(true);
    expect(pointInRings([5, 5], [outer, hole])).toBe(false);
    expect(pointInRings([11, 5], [outer])).toBe(false);
  });

  it('GeometryIndex finds crossings, containment both ways, and misses', () => {
    const index = new GeometryIndex(1);
    index.add({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
          [0, 0],
        ],
      ],
    });
    index.add({
      type: 'MultiLineString',
      coordinates: [
        [
          [50, 50],
          [60, 51],
        ],
      ],
    });
    index.add({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [100, 0],
            [100.1, 0],
            [100.1, 0.1],
            [100, 0],
          ],
        ],
      ],
    });
    index.add({ type: 'LineString', coordinates: [[-30, -30]] });
    expect(index.intersects([5, 5, 6, 6])).toBe(true); // wholly inside the polygon
    expect(index.intersects([19, 19, 25, 25])).toBe(true); // crosses its edge
    expect(index.intersects([55, 50, 56, 52])).toBe(true); // crossed by the line
    expect(index.intersects([99, -1, 101, 1])).toBe(true); // contains a tiny polygon
    expect(index.intersects([30, 30, 40, 40])).toBe(false);
    expect(index.intersects([55, 52, 56, 53])).toBe(false);
  });
});
