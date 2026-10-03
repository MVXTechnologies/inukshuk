import { worldSize } from './mercator';
import {
  ancestorAt,
  children,
  demKey,
  demNeighbor,
  demWindow,
  demWindowAt,
  isValidTile,
  parent,
  quadrant,
  tileBoundsPx,
  tileKey,
  wrapTileX,
  type TileId,
} from './tiles';

const t = (z: number, x: number, y: number, wrap = 0): TileId => ({ z, x, y, wrap });

describe('tile ids', () => {
  it('keys include the wrap; DEM keys do not', () => {
    expect(tileKey(t(3, 1, 2, -1))).toBe('3/1/2/-1');
    expect(demKey({ z: 3, x: 1, y: 2 })).toBe('3/1/2');
  });

  it.each([
    [t(0, 0, 0), true],
    [t(1, 1, 1), true],
    [t(1, 2, 0), false],
    [t(1, -1, 0), false],
    [t(18, 0, 0), false],
    [t(2.5, 0, 0), false],
    [t(17, 131071, 131071), true],
  ])('isValidTile(%j) = %p', (tile, ok) => {
    expect(isValidTile(tile)).toBe(ok);
  });

  it('children tile their parent exactly', () => {
    const p = t(5, 10, 20, 1);
    const kids = children(p);
    expect(kids).toHaveLength(4);
    for (const k of kids) expect(parent(k)).toEqual(p);
    const pb = tileBoundsPx(p, 12);
    const area = kids.reduce((s, k) => s + tileBoundsPx(k, 12).size ** 2, 0);
    expect(area).toBeCloseTo(pb.size ** 2, 6);
    expect(Math.min(...kids.map((k) => tileBoundsPx(k, 12).minX))).toBeCloseTo(pb.minX, 9);
    expect(Math.max(...kids.map((k) => tileBoundsPx(k, 12).maxY))).toBeCloseTo(pb.maxY, 9);
  });

  it('z0 has no parent; ancestors walk up', () => {
    expect(parent(t(0, 0, 0))).toBeNull();
    expect(ancestorAt(t(10, 600, 300), 7)).toEqual(t(7, 75, 37));
    expect(ancestorAt(t(4, 3, 3), 9)).toEqual(t(4, 3, 3));
    expect(ancestorAt(t(4, 3, 3), -2)).toEqual(t(0, 0, 0));
  });

  it.each([
    [t(4, 6, 9), [0, 1]],
    [t(4, 7, 8), [1, 0]],
    [t(4, 7, 9), [1, 1]],
    [t(4, 6, 8), [0, 0]],
  ])('quadrant(%j) = %p', (tile, q) => {
    expect(quadrant(tile)).toEqual(q);
  });
});

describe('tile bounds', () => {
  it('z0 covers the whole world at the camera zoom', () => {
    const b = tileBoundsPx(t(0, 0, 0), 3);
    expect(b).toEqual({
      minX: 0,
      minY: 0,
      maxX: worldSize(3),
      maxY: worldSize(3),
      size: worldSize(3),
    });
  });
  it('wraps shift by a whole world', () => {
    const a = tileBoundsPx(t(2, 1, 1, 0), 5);
    const b = tileBoundsPx(t(2, 1, 1, 1), 5);
    const c = tileBoundsPx(t(2, 1, 1, -1), 5);
    expect(b.minX - a.minX).toBe(worldSize(5));
    expect(a.minX - c.minX).toBe(worldSize(5));
  });
  it('a z13 tile is 512 px at camera zoom 13 and 1024 at 14', () => {
    expect(tileBoundsPx(t(13, 0, 0), 13).size).toBe(512);
    expect(tileBoundsPx(t(13, 0, 0), 14).size).toBe(1024);
  });
});

describe('DEM windows', () => {
  it('up to z15 a tile reads its own DEM whole', () => {
    expect(demWindow(t(12, 2100, 1400))).toEqual({
      dem: { z: 12, x: 2100, y: 1400 },
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    });
  });
  it.each([
    [t(16, 1, 0), { z: 15, x: 0, y: 0 }, 0.5, 0, 0.5],
    [t(16, 3, 3), { z: 15, x: 1, y: 1 }, 0.5, 0.5, 0.5],
    [t(17, 7, 5), { z: 15, x: 1, y: 1 }, 0.75, 0.25, 0.25],
  ])('%j reads a sub-square of the z15 DEM', (tile, dem, ox, oy, s) => {
    expect(demWindow(tile)).toEqual({ dem, offsetX: ox, offsetY: oy, scale: s });
  });
  it('ancestor windows nest', () => {
    const w = demWindowAt(t(10, 513, 770), 8);
    expect(w.dem).toEqual({ z: 8, x: 128, y: 192 });
    expect(w.scale).toBe(0.25);
    expect(w.offsetX).toBe(0.25);
    expect(w.offsetY).toBe(0.5);
    expect(demWindowAt(t(3, 1, 1), 9).dem).toEqual({ z: 3, x: 1, y: 1 });
    expect(demWindowAt(t(3, 7, 1), -1).dem).toEqual({ z: 0, x: 0, y: 0 });
  });
});

describe('wrapping and neighbours', () => {
  it.each([
    [-1, 3, 7, -1],
    [8, 3, 0, 1],
    [5, 3, 5, 0],
    [-9, 3, 7, -2],
  ])('wrapTileX(%p, z%p) = x %p wrap %p', (x, z, wx, w) => {
    expect(wrapTileX(x, z)).toEqual({ x: wx, wrap: w });
  });
  it('neighbours wrap across the antimeridian', () => {
    expect(demNeighbor({ z: 3, x: 7, y: 2 }, 1, 0)).toEqual({ z: 3, x: 0, y: 2 });
    expect(demNeighbor({ z: 3, x: 0, y: 2 }, -1, 1)).toEqual({ z: 3, x: 7, y: 3 });
  });
  it('there is nothing past a pole', () => {
    expect(demNeighbor({ z: 3, x: 2, y: 0 }, 0, -1)).toBeNull();
    expect(demNeighbor({ z: 3, x: 2, y: 7 }, 1, 1)).toBeNull();
  });
});
