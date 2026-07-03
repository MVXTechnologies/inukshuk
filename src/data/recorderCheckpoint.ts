import type { TrackPoint } from '@core/models';
import { File, Paths } from 'expo-file-system';
import * as storage from './storage';

/**
 * Crash-safe checkpoint for an in-progress recording. The recorder store holds
 * the whole hike in memory; if Android kills the process (or the app crashes),
 * hours of track + waypoints are gone. This journal persists a snapshot to the
 * document dir via the atomic writeJson (stage-to-.tmp-then-swap), and the map
 * screen restores it on next launch.
 *
 * Writes are throttled: points arrive ~1/s, and rewriting a multi-hour track's
 * JSON every second would be needless I/O. A snapshot lands every
 * {@link CHECKPOINT_EVERY_N_POINTS} points or {@link CHECKPOINT_EVERY_MS},
 * whichever comes first; waypoint edits and pause/stop checkpoints bypass the
 * throttle (they're rare and high-value).
 */

const CHECKPOINT_FILE = 'recorder-checkpoint.json';

export const CHECKPOINT_EVERY_N_POINTS = 20;
export const CHECKPOINT_EVERY_MS = 30_000;

/** Snapshot of everything needed to resurrect an interrupted recording. */
export interface RecorderCheckpoint {
  status: 'recording' | 'paused';
  name: string;
  startedAt: number;
  /** Wall time spent paused, with any in-flight pause folded in at write time. */
  pausedMs: number;
  points: TrackPoint[];
  waypoints: {
    id: string;
    latitude: number;
    longitude: number;
    distanceM: number;
    label: string;
    note?: string;
    photoUri?: string;
  }[];
}

let pointsSinceWrite = 0;
let lastWriteAt = 0;

/** Persist a checkpoint immediately (atomic swap). Failures are swallowed —
 * checkpointing must never take down the recording it protects. */
export function writeCheckpoint(cp: RecorderCheckpoint): void {
  try {
    storage.writeJson(CHECKPOINT_FILE, cp);
    pointsSinceWrite = 0;
    lastWriteAt = Date.now();
  } catch {
    /* best effort — keep recording */
  }
}

/**
 * Point-cadence write: persists only when enough points or time have
 * accumulated since the last write. Call once per accepted GPS fix.
 */
export function maybeWriteCheckpoint(cp: RecorderCheckpoint): void {
  pointsSinceWrite += 1;
  if (
    pointsSinceWrite >= CHECKPOINT_EVERY_N_POINTS ||
    Date.now() - lastWriteAt >= CHECKPOINT_EVERY_MS
  ) {
    writeCheckpoint(cp);
  }
}

/** Read the persisted checkpoint, or null if none/corrupt. */
export async function readCheckpoint(): Promise<RecorderCheckpoint | null> {
  try {
    return await storage.readJson<RecorderCheckpoint>(CHECKPOINT_FILE);
  } catch {
    return null;
  }
}

/**
 * Remove the checkpoint (recording saved or discarded). Also removes the
 * `.tmp` staging file — readJson recovers from it, so a stale staging file
 * could otherwise resurrect a recording the user already saved.
 */
export function clearCheckpoint(): void {
  pointsSinceWrite = 0;
  lastWriteAt = 0;
  for (const name of [CHECKPOINT_FILE, `${CHECKPOINT_FILE}.tmp`]) {
    try {
      const file = new File(Paths.document, name);
      if (file.exists) file.delete();
    } catch {
      /* best effort */
    }
  }
}
