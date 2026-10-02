import { encodeContourMvt } from '../../../infra/tiles/worker/src/contourMath';
import {
  ContourRecoveryLog,
  insetRect,
  intersectRect,
  linesCrossRect,
  MAX_FETCH_TRIES,
  MAX_NUDGES_PER_TILE,
  MIN_NUDGE_INTERVAL_MS,
  readMvtLines,
  RECOVERY_MIN_ZOOM,
  RETRY_DELAYS_MS,
  sourceTileZoom,
  tileBounds,
  tileKey,
  tileScreenBox,
  tilesInBounds,
  tileUrl,
  type TileLines,
} from './contourRecovery';

describe('contour tiles in view', () => {
  it('reads the source zoom off the camera, inside the source range', () => {
    expect(sourceTileZoom(12.7, 8, 13)).toBe(12);
    expect(sourceTileZoom(13, 8, 13)).toBe(13);
    expect(sourceTileZoom(16.2, 8, 13)).toBe(13);
    expect(sourceTileZoom(8, 8, 13)).toBe(8);
    expect(sourceTileZoom(7.99, 8, 13)).toBeNull();
    expect(sourceTileZoom(Number.NaN, 8, 13)).toBeNull();
    // Recovery starts where the style draws every line.
    expect(RECOVERY_MIN_ZOOM).toBe(10);
  });

  it('lists the tiles under the viewport, row by row', () => {
    // Around 51° N, 67° W at z13: the tile the bug report was about.
    const [west, south, east, north] = tileBounds({ z: 13, x: 2571, y: 2742 });
    const dx = (east - west) * 0.1;
    const dy = (north - south) * 0.1;
    // A viewport reaching a little into the tiles to the east and south.
    const tiles = tilesInBounds([west + dx, south - dy, east + dx, north - dy], 13);
    expect(tiles.map(tileKey)).toEqual([
      '13/2571/2742',
      '13/2572/2742',
      '13/2571/2743',
      '13/2572/2743',
    ]);
  });

  it('round-trips a tile through its bounds', () => {
    const tile = { z: 12, x: 1285, y: 1371 };
    const [west, south, east, north] = tileBounds(tile);
    expect(west).toBeCloseTo(-67.06, 2);
    expect(north).toBeGreaterThan(south);
    const inside = tilesInBounds([west + 1e-6, south + 1e-6, east - 1e-6, north - 1e-6], tile.z);
    expect(inside).toEqual([tile]);
  });

  it('skips views it cannot make sense of', () => {
    // Too many tiles (a tilted map sees to the horizon).
    expect(tilesInBounds([-80, 40, -60, 55], 13)).toEqual([]);
    expect(tilesInBounds([-68, 50, -66, 52], 13, 4)).toEqual([]);
    // Across the antimeridian, upside down, or not numbers.
    expect(tilesInBounds([179, 10, -179, 11], 10)).toEqual([]);
    expect(tilesInBounds([-67, 52, -66, 51], 10)).toEqual([]);
    expect(tilesInBounds([Number.NaN, 51, -66, 52], 10)).toEqual([]);
  });

  it('clamps to the world', () => {
    const tiles = tilesInBounds([-180, -89, 180, 89], 1);
    expect(tiles.map(tileKey)).toEqual(['1/0/0', '1/1/0', '1/0/1', '1/1/1']);
  });

  it('fills the URL template', () => {
    expect(
      tileUrl('https://t.example/contours/{z}/{x}/{y}.mvt?v=2', { z: 13, x: 2571, y: 2742 }),
    ).toBe('https://t.example/contours/13/2571/2742.mvt?v=2');
  });
});

describe('readMvtLines', () => {
  it('reads the lines of a contour tile as the Worker writes them', () => {
    const bytes = encodeContourMvt([
      {
        ele: 100,
        level: 1,
        k: 1,
        s: 0,
        lines: [
          [0, 0, 100, 0, 100, 50],
          [-32, 4000, 4128, 4100],
        ],
      },
      { ele: 110, level: 0, k: 1, s: 0, lines: [[10, 10, 20, 30, 10, 10]] },
    ]);
    expect(readMvtLines(bytes)).toEqual({
      kind: 'lines',
      extent: 4096,
      lines: [
        [0, 0, 100, 0, 100, 50],
        [-32, 4000, 4128, 4100],
        [10, 10, 20, 30, 10, 10],
      ],
    });
  });

  it('tells an empty tile from one it cannot read', () => {
    expect(readMvtLines(encodeContourMvt([]))).toEqual({ kind: 'empty' });
    // No layer at all, still gzipped, truncated, or not a tile.
    expect(readMvtLines(new Uint8Array(0))).toEqual({ kind: 'unreadable' });
    expect(readMvtLines(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))).toEqual({
      kind: 'unreadable',
    });
    const whole = encodeContourMvt([{ ele: 100, level: 1, lines: [[0, 0, 100, 0, 100, 50]] }]);
    for (const cut of [3, 20, whole.length - 1]) {
      expect(readMvtLines(whole.subarray(0, cut))).toEqual({ kind: 'unreadable' });
    }
    expect(readMvtLines(new TextEncoder().encode('error code: 1102'))).toEqual({
      kind: 'unreadable',
    });
  });

  it('skips fields it does not know, and takes closed rings', () => {
    // tile { 1: varint, layer { 15: 2, 1: "a", 2: feature { 1: id, 3: POLYGON, 4: geometry }, 5: 512 } }
    const geometry = [9, 2, 2, 18, 10, 0, 0, 10, 15]; // MoveTo(1,1) LineTo(+5,0)(0,+5) ClosePath
    const feature = [8, 7, 24, 3, 34, geometry.length, ...geometry];
    const layer = [120, 2, 10, 1, 97, 18, feature.length, ...feature, 40, 128, 4];
    const tile = Uint8Array.from([8, 1, 26, layer.length, ...layer]);
    expect(readMvtLines(tile)).toEqual({ kind: 'lines', extent: 512, lines: [[1, 1, 6, 1, 6, 6]] });
    // A fixed64 and a fixed32 field are stepped over; a group is not a tile.
    expect(
      readMvtLines(Uint8Array.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 13, 0, 0, 0, 0, 26, 2, 120, 2])),
    ).toEqual({ kind: 'empty' });
    expect(readMvtLines(Uint8Array.from([11, 26, 0]))).toEqual({ kind: 'unreadable' });
    // An unknown geometry command.
    expect(readMvtLines(Uint8Array.from([26, 6, 18, 4, 34, 2, 11, 0]))).toEqual({
      kind: 'unreadable',
    });
  });
});

describe('a tile on screen', () => {
  const upright = { topLeft: [100, 200], topRight: [612, 200], bottomLeft: [100, 712] } as const;
  const lines: TileLines = {
    kind: 'lines',
    extent: 4096,
    // One line along the tile's top-left to centre diagonal.
    lines: [[0, 0, 2048, 2048]],
  };

  it('boxes the tile, rotated or not', () => {
    expect(tileScreenBox(upright)).toEqual({ left: 100, top: 200, right: 612, bottom: 712 });
    // Turned 90°: the top edge runs down the screen.
    expect(
      tileScreenBox({ topLeft: [300, 0], topRight: [300, 512], bottomLeft: [-212, 0] }),
    ).toEqual({ left: -212, top: 0, right: 300, bottom: 512 });
  });

  it('insets and intersects rectangles', () => {
    const rect = { left: 0, top: 0, right: 100, bottom: 60 };
    expect(insetRect(rect, 10)).toEqual({ left: 10, top: 10, right: 90, bottom: 50 });
    expect(insetRect(rect, 30)).toBeNull();
    expect(intersectRect(rect, { left: 50, top: -20, right: 400, bottom: 30 })).toEqual({
      left: 50,
      top: 0,
      right: 100,
      bottom: 30,
    });
    expect(intersectRect(rect, { left: 100, top: 0, right: 200, bottom: 60 })).toBeNull();
  });

  it('finds a line that runs through the box, vertex inside or not', () => {
    // The diagonal goes from (100, 200) to (356, 456) on screen.
    expect(linesCrossRect(lines, upright, { left: 200, top: 300, right: 240, bottom: 340 })).toBe(
      true,
    );
    // Off the line: the bottom-left of the tile.
    expect(linesCrossRect(lines, upright, { left: 120, top: 600, right: 200, bottom: 700 })).toBe(
      false,
    );
    // Past the end of the line.
    expect(linesCrossRect(lines, upright, { left: 400, top: 500, right: 600, bottom: 700 })).toBe(
      false,
    );
    // Parallel to an edge, just outside it.
    const flat: TileLines = { kind: 'lines', extent: 4096, lines: [[0, 800, 4096, 800]] };
    expect(linesCrossRect(flat, upright, { left: 150, top: 310, right: 500, bottom: 400 })).toBe(
      false,
    );
    expect(linesCrossRect(flat, upright, { left: 150, top: 290, right: 500, bottom: 400 })).toBe(
      true,
    );
    // A single point is not a line.
    expect(
      linesCrossRect({ kind: 'lines', extent: 4096, lines: [[1000, 1000]] }, upright, {
        left: 0,
        top: 0,
        right: 1000,
        bottom: 1000,
      }),
    ).toBe(false);
  });

  it('follows the tile when the map is rotated', () => {
    // 90° clockwise: tile x runs down the screen, tile y to the left.
    const turned = { topLeft: [612, 200], topRight: [612, 712], bottomLeft: [100, 200] } as const;
    // The diagonal now goes from (612, 200) to (356, 456).
    expect(linesCrossRect(lines, turned, { left: 470, top: 320, right: 500, bottom: 350 })).toBe(
      true,
    );
    expect(linesCrossRect(lines, turned, { left: 200, top: 300, right: 240, bottom: 340 })).toBe(
      false,
    );
  });
});

describe('ContourRecoveryLog', () => {
  it('fetches a new tile at once, and never one that is settled', () => {
    const log = new ContourRecoveryLog();
    expect(log.mayFetch('a', 0)).toBe(true);
    expect(log.isSettled('a')).toBe(false);
    log.settle('a');
    expect(log.isSettled('a')).toBe(true);
    expect(log.mayFetch('a', 1e9)).toBe(false);
    expect(log.retryAt('a')).toBeNull();
  });

  it('retries a failed tile after 2 s and 6 s, then leaves it alone', () => {
    const log = new ContourRecoveryLog();
    expect(RETRY_DELAYS_MS).toEqual([2000, 6000]);
    expect(MAX_FETCH_TRIES).toBe(3);
    expect(log.retryAt('a')).toBeNull();

    expect(log.fetchFailed('a', 1000)).toBe(3000);
    expect(log.mayFetch('a', 2999)).toBe(false);
    expect(log.retryAt('a')).toBe(3000);
    expect(log.mayFetch('a', 3000)).toBe(true);

    expect(log.fetchFailed('a', 3000)).toBe(9000);
    expect(log.mayFetch('a', 8999)).toBe(false);
    expect(log.mayFetch('a', 9000)).toBe(true);

    // The third failure is the last: given up on for the session.
    expect(log.fetchFailed('a', 9000)).toBeNull();
    expect(log.isSettled('a')).toBe(true);
    expect(log.mayFetch('a', 1e12)).toBe(false);
    expect(log.retryAt('a')).toBeNull();
  });

  it('settles an empty tile, and marks one with lines ready for the map', () => {
    const log = new ContourRecoveryLog();
    log.fetchSucceeded('empty', false);
    expect(log.isSettled('empty')).toBe(true);
    expect(log.isReady('empty')).toBe(false);

    log.fetchSucceeded('lines', true);
    expect(log.isSettled('lines')).toBe(false);
    expect(log.isReady('lines')).toBe(true);
    // Fetched: not fetched again.
    expect(log.mayFetch('lines', 1e9)).toBe(false);
    expect(log.retryAt('lines')).toBeNull();
    log.settle('lines');
    expect(log.isReady('lines')).toBe(false);
  });

  it('nudges the map at most twice a tile, and never twice within 5 s', () => {
    const log = new ContourRecoveryLog();
    expect(MAX_NUDGES_PER_TILE).toBe(2);
    log.fetchSucceeded('a', true);
    log.fetchSucceeded('b', true);
    // Only ready tiles count.
    expect(log.nudgeable(['a', 'b', 'unknown'], 10_000)).toEqual(['a', 'b']);
    log.nudged(['a', 'b'], 10_000);
    expect(log.nextNudgeAt()).toBe(10_000 + MIN_NUDGE_INTERVAL_MS);

    expect(log.nudgeable(['a'], 12_000)).toEqual([]);
    expect(log.isSettled('a')).toBe(false);
    expect(log.nudgeable(['a'], 15_000)).toEqual(['a']);
    log.nudged(['a'], 15_000);

    // Twice was enough: `a` is given up on; `b` has one left.
    expect(log.nudgeable(['a', 'b'], 30_000)).toEqual(['b']);
    expect(log.isSettled('a')).toBe(true);
    expect(log.isSettled('b')).toBe(false);
  });

  it('forgets the oldest tiles past its size', () => {
    const log = new ContourRecoveryLog();
    log.settle('first');
    for (let i = 0; i < 3000; i++) log.settle(`t${i}`);
    expect(log.isSettled('first')).toBe(false);
    expect(log.isSettled('t2999')).toBe(true);
  });
});
