import { simplifyTrack } from '@core/geo/track/simplify';

import { largeLibrary } from './__fixtures__/quebecLibrary';
import {
  ByteReader,
  ByteWriter,
  decodeTileGrid,
  decodeTileRender,
  emptyManifest,
  encodeTileGrid,
  encodeTileRender,
  hashText,
  HEAT_STORE_VERSION,
  parseManifest,
  serializeManifest,
} from './heatCodec';
import { CellGrid, HEAT_LINE_CELL_M, walkTrackCells } from './heatGrid';
import {
  aggregateTile,
  deriveTileRenders,
  HEAT_TILE_DEG,
  TileGrid,
  TileMapper,
  trackContributions,
} from './heatTiles';

const grid = new CellGrid(HEAT_LINE_CELL_M);
const lib = largeLibrary(6, { stepSec: 10 });
const mapper = new TileMapper(grid);
const tiles = new Map<string, TileGrid>();
lib.tracks.forEach((t, i) => {
  const walk = walkTrackCells(
    { id: t.id, parts: simplifyTrack(lib.points(i), lib.segmentStarts(i)).parts },
    grid,
  );
  for (const [k, c] of trackContributions(walk, mapper)) {
    if (!tiles.has(k)) tiles.set(k, new TileGrid());
    tiles.get(k)!.slots.set(i * 7, c);
  }
});

describe('varints', () => {
  it('round-trips small, large and negative numbers', () => {
    const values = [0, 1, 127, 128, 300, 2 ** 31, 2 ** 41 + 5, -1, -64, -(2 ** 40)];
    const w = new ByteWriter();
    for (const v of values) w.sint(v);
    w.uint(16_384);
    w.byte(0xab);
    const r = new ByteReader(w.bytes());
    expect(values.map(() => r.sint())).toEqual(values);
    expect(r.uint()).toBe(16_384);
    expect(r.byte()).toBe(0xab);
    expect(r.done).toBe(true);
    expect(() => r.byte()).toThrow();
  });

  it('grows past its first buffer', () => {
    const w = new ByteWriter();
    for (let i = 0; i < 5000; i++) w.uint(i);
    const r = new ByteReader(w.bytes());
    for (let i = 0; i < 5000; i++) expect(r.uint()).toBe(i);
  });
});

describe('tile grid bytes', () => {
  it('round-trips every slot exactly', () => {
    for (const tile of tiles.values()) {
      const bytes = encodeTileGrid(tile, 9);
      const back = decodeTileGrid(bytes)!;
      expect(back.rev).toBe(9);
      expect([...back.tile.slots.keys()]).toEqual([...tile.slots.keys()].sort((a, b) => a - b));
      for (const [slot, c] of tile.slots) {
        const d = back.tile.slots.get(slot)!;
        expect([...d.cells]).toEqual([...c.cells]);
        expect([...d.dx]).toEqual([...c.dx]);
        expect([...d.dy]).toEqual([...c.dy]);
        expect([...d.mask]).toEqual([...c.mask]);
        expect([...d.extra]).toEqual([...c.extra]);
      }
      expect(aggregateTile(back.tile, grid)).toEqual(aggregateTile(tile, grid));
    }
  });

  it('round-trips extra steps', () => {
    const t = new TileGrid();
    t.slots.set(3, {
      cells: Float64Array.from([-5, 10]),
      dx: Int32Array.from([1, -2]),
      dy: Int32Array.from([0, 3]),
      mask: Uint8Array.from([0, 255]),
      extra: Float64Array.from([-5, 4_194_310]),
    });
    expect(decodeTileGrid(encodeTileGrid(t, 1))!.tile.slots.get(3)!.extra).toEqual(
      Float64Array.from([-5, 4_194_310]),
    );
  });

  it('is compact: a few bytes per stored cell', () => {
    let cells = 0;
    let bytes = 0;
    for (const tile of tiles.values()) {
      for (const c of tile.slots.values()) cells += c.cells.length;
      bytes += encodeTileGrid(tile, 1).length;
    }
    expect(bytes / cells).toBeLessThan(8);
  });

  it('rejects corrupt, truncated, padded and foreign bytes', () => {
    const tile = [...tiles.values()][0]!;
    const good = encodeTileGrid(tile, 1);
    expect(decodeTileGrid(good.slice(0, good.length - 3))).toBeNull();
    expect(decodeTileGrid(Uint8Array.from([...good, 0]))).toBeNull();
    expect(decodeTileGrid(Uint8Array.from([0x00, 0x47, 1]))).toBeNull();
    const other = Uint8Array.from(good);
    other[2] = HEAT_STORE_VERSION + 1;
    expect(decodeTileGrid(other)).toBeNull();
    expect(decodeTileGrid(new Uint8Array(0))).toBeNull();
  });
});

describe('tile render text', () => {
  const aggs = new Map([...tiles].map(([k, t]) => [k, aggregateTile(t, grid)]));
  const renders = deriveTileRenders(grid, aggs, aggs.keys());

  it('round-trips lines and glow (to their stored precision)', () => {
    for (const r of renders.values()) {
      const back = decodeTileRender(encodeTileRender(r, 4))!;
      expect(back.rev).toBe(4);
      expect(back.render.lines.features.map((f) => f.properties.count)).toEqual(
        r.lines.features.map((f) => f.properties.count),
      );
      back.render.lines.features.forEach((f, i) => {
        const src = r.lines.features[i]!.geometry.coordinates;
        f.geometry.coordinates.forEach((line, j) =>
          line.forEach((p, k) => {
            expect(p[0]).toBeCloseTo(src[j]![k]![0]!, 5);
            expect(p[1]).toBeCloseTo(src[j]![k]![1]!, 5);
          }),
        );
      });
      expect(back.render.glow.features.length).toBe(r.glow.features.length);
      back.render.glow.features.forEach((f, i) => {
        const src = r.glow.features[i]!;
        expect(f.properties.count).toBe(src.properties.count);
        expect(f.geometry.coordinates[0]).toBeCloseTo(src.geometry.coordinates[0]!, 6);
      });
    }
  });

  it('rejects anything malformed', () => {
    const good = JSON.parse(encodeTileRender([...renders.values()][0]!, 1));
    const bad = [
      'not json',
      'null',
      JSON.stringify({ ...good, v: HEAT_STORE_VERSION + 1 }),
      JSON.stringify({ ...good, rev: 1.5 }),
      JSON.stringify({ ...good, g: [1, 2] }),
      JSON.stringify({ ...good, g: [1, 2, 'x'] }),
      JSON.stringify({ ...good, l: [['x', []]] }),
      JSON.stringify({ ...good, l: [[1, [[1, 2, 3]]]] }),
      JSON.stringify({ ...good, l: [[1, [[1, 'y']]]] }),
      JSON.stringify({ ...good, l: [[1, ['z']]] }),
    ];
    for (const text of bad) expect(decodeTileRender(text)).toBeNull();
  });
});

describe('manifest', () => {
  const m = emptyManifest(HEAT_LINE_CELL_M, HEAT_TILE_DEG);
  m.nextSlot = 3;
  m.tiles.set('100_200', 4);
  m.tiles.set('101_200', 1);
  m.tracks.set('a', { slot: 0, hash: 'deadbeef', tiles: ['100_200', '101_200'] });
  m.tracks.set('b', { slot: 2, hash: '00000001', tiles: [] });

  it('round-trips', () => {
    expect(parseManifest(serializeManifest(m), HEAT_LINE_CELL_M, HEAT_TILE_DEG)).toEqual(m);
  });

  it('is missing (→ rebuild) when absent, corrupt, foreign or inconsistent', () => {
    const doc = JSON.parse(serializeManifest(m));
    const parse = (x: unknown) =>
      parseManifest(typeof x === 'string' ? x : JSON.stringify(x), HEAT_LINE_CELL_M, HEAT_TILE_DEG);
    expect(parseManifest(null, HEAT_LINE_CELL_M, HEAT_TILE_DEG)).toBeNull();
    expect(parse('{"v":')).toBeNull();
    expect(parse('7')).toBeNull();
    expect(parse({ ...doc, v: HEAT_STORE_VERSION + 1 })).toBeNull();
    expect(parseManifest(serializeManifest(m), 25, HEAT_TILE_DEG)).toBeNull();
    expect(parse({ ...doc, nextSlot: -1 })).toBeNull();
    expect(parse({ ...doc, tracks: null })).toBeNull();
    expect(parse({ ...doc, tiles: { nope: 1 } })).toBeNull();
    // A trail in a tile the manifest does not list, a reused or out-of-range slot.
    expect(parse({ ...doc, tracks: { a: [0, 'x', ['9_9']] } })).toBeNull();
    expect(parse({ ...doc, tracks: { a: [0, 'x', []], b: [0, 'y', []] } })).toBeNull();
    expect(parse({ ...doc, tracks: { a: [3, 'x', []] } })).toBeNull();
    expect(parse({ ...doc, tracks: { a: [0, 1, []] } })).toBeNull();
    expect(parse({ ...doc, tracks: { a: [0, 'x'] } })).toBeNull();
  });
});

it('hashes revisions stably', () => {
  expect(hashText('trk-1|100|2000|5')).toBe(hashText('trk-1|100|2000|5'));
  expect(hashText('trk-1|100|2000|5')).not.toBe(hashText('trk-1|101|2000|5'));
  expect(hashText('')).toMatch(/^[0-9a-f]{8}$/);
});
