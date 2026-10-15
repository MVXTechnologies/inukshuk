import UPNG from 'upng-js';
import { runOnRuntimeAsync } from 'react-native-worklets';
import { computeTerrain, terrainRuns } from './terrainWorker';

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
