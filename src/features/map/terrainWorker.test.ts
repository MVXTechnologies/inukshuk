import UPNG from 'upng-js';
import { runOnRuntimeAsync } from 'react-native-worklets';
import { asWorkletRuntime } from '@core/geo/workletRealm.testUtils';
import { computeTerrain, fromWire, terrainRuns, wireJob } from './terrainWorker';

jest.mock('react-native-worklets', () => ({
  createWorkletRuntime: jest.fn(() => ({ name: 'inukshuk-terrain' })),
  runOnRuntimeAsync: jest.fn(
    async (_rt: unknown, fn: (...a: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
  ),
}));

/** One flat Terrarium tile at 100 m, inside a larger buffer (a subarray view). */
function tileView(): Uint8Array {
  const rgba = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128;
    rgba[i + 1] = 100;
    rgba[i + 3] = 255;
  }
  const png = new Uint8Array(UPNG.encode([rgba.buffer], 256, 256, 0));
  const big = new Uint8Array(png.length + 64);
  big.set(png, 32);
  return big.subarray(32, 32 + png.length);
}

describe('fromWire (what crosses back from the worker runtime)', () => {
  const timings = { decode: 0, slope: 0, encode: 0, heightmap: 0 };
  it('rebuilds the heightmap from its ArrayBuffer', () => {
    const data = new Float32Array([1, 2, 3, 4]);
    const r = fromWire({
      ok: true,
      png64: 'AQID',
      slopeWidth: 1,
      slopeHeight: 1,
      hm: { buf: data.buffer, grid: 2, minH: 1, maxH: 4 },
      timings,
    });
    expect(Array.from(r.heightmap!.data)).toEqual([1, 2, 3, 4]);
    expect(r.slopePngBase64).toBe('AQID');
  });

  it('refuses what a broken transport delivers instead of drawing it', () => {
    // On Android release a returned typed array arrived as a plain object.
    expect(() =>
      fromWire({
        ok: true,
        png64: {} as unknown as string,
        slopeWidth: 1,
        slopeHeight: 1,
        hm: null,
        timings,
      }),
    ).toThrow(/string/);
    expect(() =>
      fromWire({
        ok: true,
        png64: null,
        slopeWidth: 0,
        slopeHeight: 0,
        hm: { buf: {} as ArrayBuffer, grid: 2, minH: 0, maxH: 0 },
        timings,
      }),
    ).toThrow(/ArrayBuffer/);
    expect(() => fromWire({ ok: false, error: 'png: bad signature' })).toThrow(
      'png: bad signature',
    );
  });
});

describe('wireJob on a worklet runtime (fresh realm, captured closure only)', () => {
  it('returns the PNG as base64 and the heightmap as a bare ArrayBuffer', () => {
    const res = asWorkletRuntime(wireJob)({
      tiles: [tileView().slice()],
      cols: 1,
      rows: 1,
      z: 14,
      topRow: 5800 * 256,
      slope: { minDeg: 27, maxDeg: 90, step: 1 },
      heightmapGrid: 3,
    });
    expect(res.ok).toBe(true);
    const r = fromWire(res);
    expect(typeof r.slopePngBase64).toBe('string');
    expect(r.slopePngBase64!.startsWith('iVBORw0KGgo')).toBe(true); // PNG signature
    expect(Array.from(r.heightmap!.data)).toEqual(new Array(9).fill(100));
  });

  it('reports a failure as a message string, not a thrown Error', () => {
    const res = asWorkletRuntime(wireJob)({
      tiles: [new Uint8Array(8)],
      cols: 1,
      rows: 1,
      z: 14,
      topRow: 0,
      slope: null,
      heightmapGrid: 0,
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/png: bad signature/) });
  });
});

describe('terrainWorker', () => {
  it('runs the job on the worklet runtime with tight tile buffers, and records it', async () => {
    const spy = jest.mocked(runOnRuntimeAsync);
    const before = terrainRuns.length;
    const out = await computeTerrain({
      tiles: [tileView()],
      cols: 1,
      rows: 1,
      z: 14,
      topRow: 5800 * 256,
      slope: { minDeg: 27, maxDeg: 90, step: 1 },
      heightmapGrid: 3,
    });
    expect(out).not.toBeNull();
    expect(out!.heightmap!.minH).toBe(100);
    expect(out!.slopeWidth).toBe(256);
    // The serializer clones a view's whole buffer: what crosses must be tight.
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]![2] as unknown as { tiles: Uint8Array[] };
    expect(sent.tiles[0]!.byteOffset).toBe(0);
    expect(sent.tiles[0]!.byteLength).toBe(sent.tiles[0]!.buffer.byteLength);
    expect(terrainRuns.length).toBe(before + 1);
    expect(terrainRuns.at(-1)!.offThread).toBe(true);
    expect(terrainRuns.at(-1)!.stall.beats).toBeGreaterThan(0);
  });
});
