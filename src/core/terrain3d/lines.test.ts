import {
  densify,
  extrudeOffset,
  liftHeights,
  rasterizePolygons,
  ringToTile,
  ringTouchesTile,
} from './lines';

describe('densify', () => {
  it('keeps every original point and splits long segments', () => {
    const out = densify(
      [
        [0, 0],
        [10, 0],
        [10, 1],
      ],
      2,
    );
    expect(out[0]).toEqual([0, 0]);
    expect(out).toContainEqual([10, 0]);
    expect(out[out.length - 1]).toEqual([10, 1]);
    expect(out.length).toBe(1 + 5 + 1);
    for (let i = 1; i < out.length; i++) {
      expect(
        Math.hypot(out[i]![0] - out[i - 1]![0], out[i]![1] - out[i - 1]![1]),
      ).toBeLessThanOrEqual(2 + 1e-9);
    }
  });
  it('caps runaway subdivision', () => {
    expect(
      densify(
        [
          [0, 0],
          [1e9, 0],
        ],
        1,
      ).length,
    ).toBe(257);
  });
  it('single points and empty input pass through', () => {
    expect(densify([[3, 4]], 1)).toEqual([[3, 4]]);
    expect(densify([], 1)).toEqual([]);
  });
});

describe('liftHeights', () => {
  it('samples heights, unknown ground falls back', () => {
    expect(
      liftHeights(
        [
          [0, 0],
          [1, 1],
        ],
        (x) => (x > 0 ? 1200 : null),
        5,
      ),
    ).toEqual([5, 1200]);
  });
});

describe('extrudeOffset', () => {
  const vp: [number, number] = [400, 800];
  it('offsets perpendicular to a horizontal segment, by half…full width in px', () => {
    const [ox, oy] = extrudeOffset([-0.5, 0], [0.5, 0], 1, 4, vp);
    expect(ox).toBeCloseTo(0, 12);
    expect(oy * vp[1]).toBeCloseTo(4, 9); // NDC→px: ×viewport/2 per unit, so 4/… = 2 px each side
  });
  it('sides are opposite', () => {
    const a = extrudeOffset([0, 0], [0.3, 0.4], 1, 3, vp);
    const b = extrudeOffset([0, 0], [0.3, 0.4], -1, 3, vp);
    expect(a[0]).toBeCloseTo(-b[0], 12);
    expect(a[1]).toBeCloseTo(-b[1], 12);
  });
  it('the offset is perpendicular on screen', () => {
    const a: [number, number] = [0.1, -0.2];
    const b: [number, number] = [0.4, 0.5];
    const [ox, oy] = extrudeOffset(a, b, 1, 5, vp);
    const dot = (b[0] - a[0]) * vp[0] * ox * vp[0] + (b[1] - a[1]) * vp[1] * oy * vp[1];
    expect(dot).toBeCloseTo(0, 6);
  });
  it('a degenerate segment does not extrude', () => {
    expect(extrudeOffset([0.2, 0.2], [0.2, 0.2], 1, 4, vp)).toEqual([0, 0]);
  });
});

describe('rasterizePolygons', () => {
  const square = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ] as [number, number][];
  it('fills the inside, leaves the outside', () => {
    const m = rasterizePolygons([square], 8);
    expect(m[3 * 8 + 3]).toBe(255);
    expect(m[0]).toBe(0);
    expect(Array.from(m).filter((v) => v).length).toBe(16);
  });
  it('even–odd: a hole stays empty', () => {
    const hole = [
      [0.375, 0.375],
      [0.625, 0.375],
      [0.625, 0.625],
      [0.375, 0.625],
    ] as [number, number][];
    const m = rasterizePolygons([square, hole], 8);
    expect(Array.from(m).filter((v) => v).length).toBe(12);
    expect(m[3 * 8 + 3]).toBe(0);
  });
  it('polygons larger than the tile fill it all; outside ones nothing', () => {
    const big = [
      [-1, -1],
      [2, -1],
      [2, 2],
      [-1, 2],
    ] as [number, number][];
    expect(Array.from(rasterizePolygons([big], 4)).every((v) => v === 255)).toBe(true);
    const off = big.map(([x, y]) => [x + 10, y] as [number, number]);
    expect(Array.from(rasterizePolygons([off], 4)).every((v) => v === 0)).toBe(true);
  });
  it('a triangle covers about half its bounding square', () => {
    const tri = [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as [number, number][];
    const n = Array.from(rasterizePolygons([tri], 64)).filter((v) => v).length;
    expect(n / 4096).toBeCloseTo(0.5, 1);
  });
});

describe('tile mapping', () => {
  it('maps mercator rings into a tile square and tests overlap', () => {
    const r = ringToTile(
      [
        [0.5, 0.5],
        [0.5 + 1 / 1024, 0.5],
      ],
      10,
      512,
      512,
    );
    expect(r[0]).toEqual([0, 0]);
    expect(r[1]![0]).toBeCloseTo(1, 9);
    expect(ringTouchesTile(r)).toBe(true);
    expect(
      ringTouchesTile([
        [2, 2],
        [3, 3],
      ]),
    ).toBe(false);
  });
});
