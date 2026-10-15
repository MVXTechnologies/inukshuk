import UPNG from 'upng-js';
import { sampleGridBilinear } from './terrain';
import { asWorkletRuntime } from './workletRealm.testUtils';
import { slopeOverlayMercator } from './terrainAnalysis';
import {
  clearDemTileCache,
  DEM_TILE_CACHE_SIZE,
  runTerrainJob,
  slopeStepFor,
  terrariumMosaic,
} from './terrainJob';

const ab = (u: Uint8Array) =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Terrarium-encode an elevation function over a cols×rows block of 256-px tiles. */
function terrariumTiles(cols: number, rows: number, elev: (x: number, y: number) => number) {
  const tiles: Uint8Array[] = [];
  const want = new Float32Array(cols * 256 * rows * 256);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const rgba = new Uint8Array(256 * 256 * 4);
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const gx = tx * 256 + x;
          const gy = ty * 256 + y;
          const v = Math.round((elev(gx, gy) + 32768) * 256);
          const i = (y * 256 + x) * 4;
          rgba[i] = v >> 16;
          rgba[i + 1] = (v >> 8) & 255;
          rgba[i + 2] = v & 255;
          rgba[i + 3] = 255;
          want[gy * cols * 256 + gx] = v / 256 - 32768;
        }
      }
      tiles.push(new Uint8Array(UPNG.encode([ab(rgba)], 256, 256, 0)));
    }
  }
  return { tiles, want };
}

// A bumpy hillside near 47° N at z14 (~6.5 m pixels): slopes 0–60°.
const Z = 14;
const TOP = 5800 * 256;
const hill = (x: number, y: number) =>
  400 + 3.2 * x + 40 * Math.sin(x / 9) * Math.cos(y / 13) + 0.004 * (y - 200) ** 2;

describe('slopeStepFor', () => {
  it('picks the smallest power of two fitting the budget', () => {
    expect(slopeStepFor(1024, 512, 1024)).toBe(1);
    expect(slopeStepFor(2048, 1792, 1024)).toBe(2);
    expect(slopeStepFor(1280, 256, 1024)).toBe(2);
    expect(slopeStepFor(4096, 256, 1024)).toBe(4);
  });

  it('always divides a tile-multiple mosaic (image stays on the mosaic corners)', () => {
    for (let n = 1; n <= 8; n++) {
      const s = slopeStepFor(n * 256, 256, 1024);
      expect((n * 256) % s).toBe(0);
    }
  });
});

describe('runTerrainJob', () => {
  const { tiles, want } = terrariumTiles(2, 2, hill);

  it('decodes the Terrarium tiles into the exact mosaic', () => {
    const m = terrariumMosaic(tiles, 2, 2);
    expect(Buffer.compare(Buffer.from(m.buffer), Buffer.from(want.buffer))).toBe(0);
  });

  it('draws the same slope overlay as the reference RGBA path', () => {
    const out = runTerrainJob({
      tiles,
      cols: 2,
      rows: 2,
      z: Z,
      topRow: TOP,
      slope: { minDeg: 27, maxDeg: 90, step: 2 },
      heightmapGrid: 0,
    });
    expect([out.slopeWidth, out.slopeHeight]).toEqual([256, 256]);
    const ref = slopeOverlayMercator(want, 512, 512, Z, TOP, 27, 90, 2);
    const got = new Uint8Array(UPNG.toRGBA8(UPNG.decode(ab(out.slopePng!)))[0]!);
    let painted = 0;
    let mismatches = 0;
    for (let i = 0; i < ref.rgba.length; i += 4) {
      // UPNG zeroes the colour of fully transparent pixels: compare alpha
      // everywhere, colour where drawn.
      const n = ref.rgba[i + 3]! > 0 ? 4 : 1;
      if (n === 4) painted++;
      for (let c = 4 - n; c < 4; c++) if (got[i + c] !== ref.rgba[i + c]) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(painted).toBeGreaterThan(1000); // the fixture really has steep ground
    expect(out.heightmap).toBeNull();
  });

  it('builds the contour heightmap exactly like the bilinear resample', () => {
    const out = runTerrainJob({
      tiles,
      cols: 2,
      rows: 2,
      z: Z,
      topRow: TOP,
      slope: null,
      heightmapGrid: 33,
    });
    expect(out.slopePng).toBeNull();
    const hm = out.heightmap!;
    expect(hm.grid).toBe(33);
    let min = Infinity;
    let max = -Infinity;
    for (let gy = 0; gy < 33; gy++) {
      for (let gx = 0; gx < 33; gx++) {
        const h = sampleGridBilinear(want, 512, 512, gx / 32, gy / 32);
        expect(hm.data[gy * 33 + gx]).toBeCloseTo(h, 3);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    }
    expect(hm.minH).toBeCloseTo(min, 3);
    expect(hm.maxH).toBeCloseTo(max, 3);
  });

  it('runs as a worklet: fresh realm, captured closure only — same bytes as a direct call', () => {
    const job = asWorkletRuntime(runTerrainJob);
    for (const filter of [
      undefined,
      { aspectMask: 0b0100_0100, minAltM: 450, maxAltM: null },
    ] as const) {
      const input = {
        tiles,
        tileKeys: ['a', 'b', 'c', 'd'],
        cols: 2,
        rows: 2,
        z: Z,
        topRow: TOP,
        slope: { minDeg: 27, maxDeg: 50, step: 2, filter },
        heightmapGrid: 9,
      };
      const viaWorklet = job(input);
      const direct = runTerrainJob(input);
      expect(Buffer.compare(Buffer.from(viaWorklet.slopePng!), Buffer.from(direct.slopePng!))).toBe(
        0,
      );
      expect(Array.from(viaWorklet.heightmap!.data)).toEqual(Array.from(direct.heightmap!.data));
    }
  });

  it('re-uses decoded tiles by key, least-recently-used out first', () => {
    clearDemTileCache();
    const keys = ['14/0/0', '14/1/0', '14/0/1', '14/1/1'];
    const first = terrariumMosaic(tiles, 2, 2, keys);
    // Same keys, unreadable bytes: only a cache hit can succeed.
    const junk = tiles.map(() => new Uint8Array(8));
    const again = terrariumMosaic(junk, 2, 2, keys);
    expect(Buffer.compare(Buffer.from(again.buffer), Buffer.from(first.buffer))).toBe(0);
    // Push '14/0/0' out with DEM_TILE_CACHE_SIZE newer tiles (keep 14/1/0 warm).
    for (let k = 0; k < DEM_TILE_CACHE_SIZE - 1; k++) {
      terrariumMosaic([tiles[0]!, tiles[1]!], 2, 1, [`13/${k}/0`, '14/1/0']);
    }
    expect(() => terrariumMosaic([junk[0]!], 1, 1, ['14/0/0'])).toThrow(/signature/);
    expect(() => terrariumMosaic([junk[1]!], 1, 1, ['14/1/0'])).not.toThrow();
    clearDemTileCache();
    expect(() => terrariumMosaic([junk[1]!], 1, 1, ['14/1/0'])).toThrow();
  });

  it('rejects a tile count that does not match the grid, and non-256 tiles', () => {
    expect(() =>
      runTerrainJob({ tiles, cols: 3, rows: 2, z: Z, topRow: TOP, slope: null, heightmapGrid: 0 }),
    ).toThrow(/count/);
    const small = new Uint8Array(UPNG.encode([ab(new Uint8Array(16 * 4))], 4, 4, 0));
    expect(() => terrariumMosaic([small], 1, 1)).toThrow(/256/);
  });
});
