import { bytesToBase64 } from '@core/encoding/base64';
import { runTerrainJob, type TerrainJobInput, type TerrainJobOutput } from '@core/geo/terrainJob';
import { stallStats, type StallStats } from '@core/perf/stallStats';
import { latestWins } from '@core/tasks/latestWins';
import {
  createWorkletRuntime,
  runOnRuntimeAsync,
  type WorkletRuntime,
} from 'react-native-worklets';

/**
 * Runs the 2D terrain overlays' compute ({@link runTerrainJob}: Terrarium
 * decode, slope, PNG encode, contour heightmap) on a dedicated worklet
 * runtime — its own thread — so the JS thread stays free for touches while a
 * slope computes (#722). At most one job runs; of the requests that pile up
 * meanwhile only the newest runs next (older ones resolve `null`).
 *
 * If the runtime cannot be created, or fails where the same job succeeds
 * inline, the job runs on the JS thread (the old, laggy behaviour) rather
 * than not at all. `EXPO_PUBLIC_TERRAIN_INLINE=1` forces that path, and
 * `EXPO_PUBLIC_PERF_LOG=1` logs one line per job with the JS-thread stall it
 * caused — the before/after measurement on a device.
 */

/** What the overlays need, in a shape that survives the trip between runtimes. */
export interface TerrainResult {
  /** The slope-overlay PNG, base64 (what `storage.writeOverlayPng` takes). */
  slopePngBase64: string | null;
  slopeWidth: number;
  slopeHeight: number;
  heightmap: { data: Float32Array; grid: number; minH: number; maxH: number } | null;
  timings: TerrainJobOutput['timings'];
}

/**
 * The worklet's answer. Measured on Android release (react-native-worklets
 * 0.8): a typed array RETURNED from a worker runtime arrives as a plain
 * object (its bytes lost — MapLibre then failed "bitmap decoding"), and a
 * thrown Error as `{}`. So the PNG crosses as a base64 string, the heightmap
 * as a bare ArrayBuffer, and failures as a message string.
 */
export type WireResult =
  | {
      ok: true;
      png64: string | null;
      slopeWidth: number;
      slopeHeight: number;
      hm: { buf: ArrayBuffer; grid: number; minH: number; maxH: number } | null;
      timings: TerrainJobOutput['timings'];
    }
  | { ok: false; error: string };

export function wireJob(input: TerrainJobInput): WireResult {
  'worklet';
  try {
    const out = runTerrainJob(input);
    const hm = out.heightmap;
    return {
      ok: true,
      png64: out.slopePng !== null ? bytesToBase64(out.slopePng) : null,
      slopeWidth: out.slopeWidth,
      slopeHeight: out.slopeHeight,
      // `data` is a fresh, tight Float32Array: its buffer is exactly the grid.
      hm:
        hm !== null
          ? { buf: hm.data.buffer as ArrayBuffer, grid: hm.grid, minH: hm.minH, maxH: hm.maxH }
          : null,
      timings: out.timings,
    };
  } catch (e) {
    const err = e as { message?: unknown; stack?: unknown };
    return { ok: false, error: `${String(err?.message ?? e)}\n${String(err?.stack ?? '')}` };
  }
}

/** Unwrap and CHECK a wire result (a transport problem must not draw garbage). */
export function fromWire(res: WireResult): TerrainResult {
  if (!res.ok) throw new Error(res.error);
  if (res.png64 !== null && typeof res.png64 !== 'string') {
    throw new Error('terrain worker: slope PNG did not arrive as a string');
  }
  let heightmap: TerrainResult['heightmap'] = null;
  if (res.hm !== null) {
    const { buf, grid } = res.hm;
    // Realm-independent check (instanceof fails across realms).
    const isBuffer = Object.prototype.toString.call(buf) === '[object ArrayBuffer]';
    if (!isBuffer || buf.byteLength !== grid * grid * 4) {
      throw new Error('terrain worker: heightmap did not arrive as an ArrayBuffer');
    }
    heightmap = { data: new Float32Array(buf), grid, minH: res.hm.minH, maxH: res.hm.maxH };
  }
  return {
    slopePngBase64: res.png64,
    slopeWidth: res.slopeWidth,
    slopeHeight: res.slopeHeight,
    heightmap,
    timings: res.timings,
  };
}

function inline(job: TerrainJobInput): TerrainResult {
  const out = runTerrainJob(job);
  return {
    slopePngBase64: out.slopePng !== null ? bytesToBase64(out.slopePng) : null,
    slopeWidth: out.slopeWidth,
    slopeHeight: out.slopeHeight,
    heightmap: out.heightmap,
    timings: out.timings,
  };
}

let runtime: WorkletRuntime | null | undefined;

function terrainRuntime(): WorkletRuntime | null {
  if (runtime === undefined) {
    try {
      runtime =
        process.env.EXPO_PUBLIC_TERRAIN_INLINE === '1'
          ? null
          : createWorkletRuntime({ name: 'inukshuk-terrain' });
    } catch (err) {
      console.warn('terrain worker unavailable, computing on the JS thread', err);
      runtime = null;
    }
  }
  return runtime ?? null;
}

/**
 * A view's bytes in a buffer of their own: the worklet serializer clones a
 * view's WHOLE underlying buffer, so a subarray would arrive with the wrong
 * offset and length.
 */
function tight(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();
}

export interface TerrainRunRecord {
  offThread: boolean;
  /** Dispatch → result, wall clock (ms). */
  wallMs: number;
  job: TerrainJobOutput['timings'];
  stall: StallStats;
}

/** The last runs (newest last), for measurement and the perf log. */
export const terrainRuns: TerrainRunRecord[] = [];
const PERF_LOG = process.env.EXPO_PUBLIC_PERF_LOG === '1';
const BEAT_MS = 16;

async function runOnce(input: TerrainJobInput): Promise<TerrainResult> {
  const job: TerrainJobInput = { ...input, tiles: input.tiles.map(tight) };
  // JS-thread heartbeat while the job runs: its lateness is the stall.
  const beats: number[] = [Date.now()];
  const beat = setInterval(() => beats.push(Date.now()), BEAT_MS);
  const t0 = Date.now();
  let rt = terrainRuntime();
  try {
    let out: TerrainResult | null = null;
    let workletError: unknown = null;
    if (rt !== null) {
      try {
        out = fromWire(await runOnRuntimeAsync(rt, wireJob, job));
      } catch (err) {
        workletError = err;
        rt = null;
      }
    }
    if (out === null) {
      // Let the heartbeat start before an inline job blocks the thread.
      await new Promise((r) => setTimeout(r, BEAT_MS));
      out = inline(job); // a data error throws here too, and propagates
      if (workletError !== null) {
        // Inline worked where the worklet did not: the runtime is at fault.
        const msg = workletError instanceof Error ? workletError.message : String(workletError);
        console.warn(`terrain worker failed, computing on the JS thread: ${msg}`);
        runtime = null;
      }
    }
    await new Promise((r) => setTimeout(r, BEAT_MS)); // one beat after the result lands
    const record: TerrainRunRecord = {
      offThread: rt !== null,
      wallMs: Date.now() - t0,
      job: out.timings,
      stall: stallStats([...beats, Date.now()], BEAT_MS),
    };
    terrainRuns.push(record);
    if (terrainRuns.length > 20) terrainRuns.shift();
    if (PERF_LOG) console.log(`[terrain-perf] ${JSON.stringify(record)}`);
    return out;
  } finally {
    clearInterval(beat);
  }
}

/** Compute the terrain overlays off the JS thread; `null` when superseded. */
export const computeTerrain = latestWins(runOnce);
