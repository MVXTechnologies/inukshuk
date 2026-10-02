/**
 * The contour tile end to end — DEM fetch, decode budget, partial then full —
 * under the app's jest, with `fetch` answering synthetic Terrarium PNGs.
 * fast-png (the fallback decoder) is not installed at the repo root.
 */
import { deflateSync, inflateSync } from 'zlib';

import { contourTile, resetContourCaches } from './contours';

jest.mock('fast-png', () => ({ decode: jest.fn() }), { virtual: true });

// --- A world of synthetic DEM tiles ----------------------------------------------

/** Rolling ground, continuous across DEM tiles: metres at a world pixel of zoom `z`. */
function ground(z: number, wx: number, wy: number): number {
  // In units of a z12 pixel, so every zoom sees the same hills.
  const s = 2 ** (12 - z);
  const x = wx * s;
  const y = wy * s;
  return 420 + 90 * Math.sin(x / 37) + 70 * Math.cos(y / 29) + 25 * Math.sin((x + y) / 11);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out; // the decoder does not check CRCs
}

/** An unfiltered 256 × 256 RGB Terrarium PNG of DEM tile z/x/y. */
function demPng(z: number, x: number, y: number): Uint8Array {
  const size = 256;
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const v = Math.round((ground(z, x * size + px, y * size + py) + 32768) * 256);
      const o = py * (size * 3 + 1) + 1 + px * 3;
      raw[o] = v >> 16;
      raw[o + 1] = (v >> 8) & 255;
      raw[o + 2] = v & 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** DEM tiles fetched since the last reset, as `z/x/y`. */
let fetched: string[] = [];
/** DEM tiles whose fetch fails. */
let broken = new Set<string>();

const realFetch = globalThis.fetch;
const realDecompressionStream = globalThis.DecompressionStream;
const realBlob = globalThis.Blob;
const realResponse = globalThis.Response;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    const [, z, x, y] = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(String(input)) ?? [];
    const key = `${z}/${x}/${y}`;
    fetched.push(key);
    const ok = !broken.has(key);
    const bytes = ok ? demPng(Number(z), Number(x), Number(y)) : new Uint8Array(0);
    return {
      ok,
      status: ok ? 200 : 503,
      arrayBuffer: async () => bytes.buffer,
    };
  }) as unknown as typeof fetch;
  // The Worker inflates with the runtime's stream; any inflate will do here.
  // contours.ts only pipes a Blob's stream through it into a Response.
  class FakeDecompressionStream {
    constructor(readonly format: string) {}
  }
  globalThis.DecompressionStream = FakeDecompressionStream as unknown as typeof DecompressionStream;
  const blobs = new WeakMap<object, Uint8Array>();
  globalThis.Blob = class {
    constructor(private readonly parts: Uint8Array[]) {}
    stream() {
      const piped = {};
      blobs.set(piped, this.parts[0]!);
      return { pipeThrough: () => piped };
    }
  } as unknown as typeof Blob;
  globalThis.Response = class {
    constructor(private readonly body: object) {}
    async arrayBuffer() {
      const out = inflateSync(blobs.get(this.body)!);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
  } as unknown as typeof Response;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.DecompressionStream = realDecompressionStream;
  globalThis.Blob = realBlob;
  globalThis.Response = realResponse;
});

beforeEach(() => {
  resetContourCaches();
  fetched = [];
  broken = new Set();
});

// z13 tile in the top-right quadrant of DEM tile 12/1285/1371; its region is 11/642/685.
const TILE = [13, 2571, 2742] as const;
const OWN = '12/1285/1371';
const REGION = '11/642/685';
const NEIGHBOURS = ['12/1285/1370', '12/1286/1371', '12/1286/1370'];

describe('contourTile', () => {
  it('makes the full tile in one request when the budget allows', async () => {
    const tile = await contourTile(...TILE, { decodeBudget: 9 });
    expect(tile.partial).toBe(false);
    expect(tile.levels).toEqual([10, 50]);
    expect(tile.mvt.length).toBeGreaterThan(500);
    expect([...fetched].sort()).toEqual([OWN, REGION, ...NEIGHBOURS].sort());
  });

  it('decodes at most its budget, answering a partial tile it can afford', async () => {
    const tile = await contourTile(...TILE);
    expect(tile.partial).toBe(true);
    // Its own DEM first, then the region's: the right interval before the borders.
    expect(fetched).toEqual([OWN, REGION]);
    expect(tile.levels).toEqual([10, 50]);
    expect(tile.mvt.length).toBeGreaterThan(500);
  });

  it('finishes over the next requests, and ends with the same bytes', async () => {
    const full = await contourTile(...TILE, { decodeBudget: 9 });
    resetContourCaches();
    fetched = [];
    const first = await contourTile(...TILE);
    const second = await contourTile(...TILE);
    const third = await contourTile(...TILE);
    expect([first.partial, second.partial, third.partial]).toEqual([true, true, false]);
    // Two decodes a request, none twice.
    expect(fetched).toHaveLength(5);
    expect(new Set(fetched).size).toBe(5);
    expect(Buffer.from(third.mvt).equals(Buffer.from(full.mvt))).toBe(true);
    expect(Buffer.from(first.mvt).equals(Buffer.from(full.mvt))).toBe(false);
    // Everything is in the isolate now: a fourth request decodes nothing.
    await contourTile(...TILE);
    expect(fetched).toHaveLength(5);
  });

  it('a partial tile differs from the full one only along the missing borders', async () => {
    const full = await contourTile(...TILE, { decodeBudget: 9 });
    resetContourCaches();
    const partial = await contourTile(...TILE);
    // Same interval, nearly the same lines: within a few percent in size.
    expect(partial.levels).toEqual(full.levels);
    expect(Math.abs(partial.mvt.length - full.mvt.length)).toBeLessThan(full.mvt.length * 0.1);
  });

  it('shares decoded DEM tiles between neighbouring contour tiles and concurrent requests', async () => {
    // The four quadrants of one DEM tile, at once, into a cold isolate.
    const quad = [
      [13, 2570, 2742],
      [13, 2571, 2742],
      [13, 2570, 2743],
      [13, 2571, 2743],
    ] as const;
    const tiles = await Promise.all(quad.map(([z, x, y]) => contourTile(z, x, y)));
    // Their own DEM and the region's are decoded once, not four times.
    expect(fetched.filter((k) => k === OWN)).toHaveLength(1);
    expect(fetched.filter((k) => k === REGION)).toHaveLength(1);
    // No request started more than its two.
    expect(fetched.length).toBeLessThanOrEqual(quad.length * 2);
    expect(tiles.every((t) => t.mvt.length > 500)).toBe(true);
  });

  it('guesses the interval from its own relief when the region is not decoded yet', async () => {
    const tile = await contourTile(...TILE, { decodeBudget: 1 });
    expect(fetched).toEqual([OWN]);
    expect(tile.partial).toBe(true);
    expect(tile.levels).toEqual([10, 50]);
  });

  it('answers a partial tile when a neighbour’s DEM cannot be fetched', async () => {
    broken.add(NEIGHBOURS[0]!);
    const tile = await contourTile(...TILE, { decodeBudget: 9 });
    expect(tile.partial).toBe(true);
    expect(tile.mvt.length).toBeGreaterThan(500);
    // The failure is not remembered: once it is back, the tile is full.
    broken.clear();
    expect((await contourTile(...TILE, { decodeBudget: 9 })).partial).toBe(false);
  });

  it('fails when the tile’s own DEM cannot be fetched', async () => {
    broken.add(OWN);
    await expect(contourTile(...TILE)).rejects.toThrow('DEM 503');
    // One retry, then give up.
    expect(fetched.filter((k) => k === OWN)).toHaveLength(2);
  });

  it('draws the whole world at z0 from its one DEM tile', async () => {
    const tile = await contourTile(0, 0, 0);
    expect(fetched).toEqual(['0/0/0']);
    expect(tile.partial).toBe(false);
  });
});
