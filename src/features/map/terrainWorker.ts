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
 * If the runtime cannot be created the job runs inline (the old, laggy
 * behaviour) rather than not at all. `EXPO_PUBLIC_TERRAIN_INLINE=1` forces
 * that path, and `EXPO_PUBLIC_PERF_LOG=1` logs one line per job with the
 * JS-thread stall it caused — the before/after measurement on a device.
 */

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

async function runOnce(input: TerrainJobInput): Promise<TerrainJobOutput> {
  const job: TerrainJobInput = { ...input, tiles: input.tiles.map(tight) };
  // JS-thread heartbeat while the job runs: its lateness is the stall.
  const beats: number[] = [Date.now()];
  const beat = setInterval(() => beats.push(Date.now()), BEAT_MS);
  const t0 = Date.now();
  const rt = terrainRuntime();
  try {
    // Let the heartbeat start before an inline job blocks the thread.
    if (rt === null) await new Promise((r) => setTimeout(r, BEAT_MS));
    const out = rt !== null ? await runOnRuntimeAsync(rt, runTerrainJob, job) : runTerrainJob(job);
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
