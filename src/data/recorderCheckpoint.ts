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
const BG_POINTS_FILE = 'recorder-bgpoints.json';

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
 * could otherwise resurrect a recording the user already saved. The background
 * points journal belongs to the same session, so it is cleared too.
 */
export function clearCheckpoint(): void {
  pointsSinceWrite = 0;
  lastWriteAt = 0;
  deleteJournalFiles(CHECKPOINT_FILE);
  clearBackgroundPoints();
}

function deleteJournalFiles(baseName: string): void {
  for (const name of [baseName, `${baseName}.tmp`]) {
    try {
      const file = new File(Paths.document, name);
      if (file.exists) file.delete();
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Background points journal
//
// While the phone screen is off, fixes come from the OS-level background
// location task rather than the foreground watch. If the JS process was killed
// and relaunched headless, the recorder store has no live session to feed —
// the task appends its fixes here instead, and they are merged (deduped by
// timestamp) into the store on the next foreground/recovery. Same durability
// contract as the checkpoint: atomic writes, throttled cadence, failures never
// break the recording.

/** In-memory mirror of the journal; unflushed tail included. Lazily loaded. */
let bgPoints: TrackPoint[] | null = null;
let bgPointsSinceWrite = 0;
let bgLastWriteAt = 0;

function isValidPoint(p: unknown): p is TrackPoint {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  return (
    typeof q.latitude === 'number' &&
    Number.isFinite(q.latitude) &&
    typeof q.longitude === 'number' &&
    Number.isFinite(q.longitude) &&
    typeof q.time === 'number' &&
    Number.isFinite(q.time)
  );
}

async function readBgPointsFile(): Promise<TrackPoint[]> {
  try {
    const raw = await storage.readJson<unknown>(BG_POINTS_FILE);
    return Array.isArray(raw) ? raw.filter(isValidPoint) : [];
  } catch {
    return [];
  }
}

/**
 * Durably append fixes delivered by the background location task while no live
 * recorder session exists in this JS context. The first append after a (re)load
 * flushes immediately; later appends flush every
 * {@link CHECKPOINT_EVERY_N_POINTS} points or {@link CHECKPOINT_EVERY_MS} —
 * the same loss window the checkpoint itself accepts.
 */
export async function appendBackgroundPoints(points: TrackPoint[]): Promise<void> {
  if (points.length === 0) return;
  try {
    if (bgPoints === null) {
      bgPoints = await readBgPointsFile();
      // Force the first append in this JS context to flush, so even a short
      // background stint leaves a durable trace.
      bgLastWriteAt = Number.NEGATIVE_INFINITY;
    }
    bgPoints.push(...points);
    bgPointsSinceWrite += points.length;
    if (
      bgPointsSinceWrite >= CHECKPOINT_EVERY_N_POINTS ||
      Date.now() - bgLastWriteAt >= CHECKPOINT_EVERY_MS
    ) {
      storage.writeJson(BG_POINTS_FILE, bgPoints);
      bgPointsSinceWrite = 0;
      bgLastWriteAt = Date.now();
    }
  } catch {
    /* best effort — never take down the location task */
  }
}

/**
 * All journaled background points, including any unflushed in-memory tail.
 * Corrupt/foreign entries are dropped rather than poisoning a merge.
 */
export async function readBackgroundPoints(): Promise<TrackPoint[]> {
  if (bgPoints !== null) return bgPoints.slice();
  return readBgPointsFile();
}

/** Drop the journal (merged into the store, or the session ended). */
export function clearBackgroundPoints(): void {
  bgPoints = null;
  bgPointsSinceWrite = 0;
  bgLastWriteAt = 0;
  deleteJournalFiles(BG_POINTS_FILE);
}
