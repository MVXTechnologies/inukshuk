import type { Track, TrackPoint, TrackStats } from '@core/models';
import { buildGpx } from '@core/geo/gpx';
import { computeTrackStats, reduceStatsWith } from '@core/geo/track';
import { shouldAcceptFix } from '@core/geo/track/gpsFilter';
import * as checkpoint from '@data/recorderCheckpoint';
import * as storage from '@data/storage';
import { create } from 'zustand';
import { useLibraryStore } from './libraryStore';

const EMPTY_STATS: TrackStats = {
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  pointCount: 0,
};

export type RecorderStatus = 'idle' | 'recording' | 'paused';

/** A waypoint dropped live during recording — materialized as a trail note on stop. */
export interface PendingWaypoint {
  id: string;
  /** Position captured when dropped, so it can be shown as a live map marker. */
  latitude: number;
  longitude: number;
  distanceM: number;
  /** Auto label ("Waypoint N"); used as the note text if no note is typed. */
  label: string;
  note?: string;
  /** Absolute file:// uri of an attached photo (already copied into storage). */
  photoUri?: string;
}

interface RecorderState {
  status: RecorderStatus;
  name: string;
  startedAt: number | null;
  /** Wall time spent paused so far (completed pauses only). */
  pausedMs: number;
  /** When the current pause began, while status === 'paused'. */
  pausedAt: number | null;
  points: TrackPoint[];
  stats: TrackStats;
  waypoints: PendingWaypoint[];

  start: (name?: string) => void;
  addPoint: (point: TrackPoint) => void;
  /** Drop a waypoint at the current position (becomes a numbered note on stop). */
  addWaypoint: () => number;
  /** Edit a live waypoint's note text and/or photo (empty photoUri removes it). */
  updateWaypoint: (id: string, patch: { note?: string; photoUri?: string }) => void;
  /** Remove a live waypoint and any photo it owns. */
  removeWaypoint: (id: string) => void;
  pause: () => void;
  resume: () => void;
  /** Finalize: compute authoritative stats, persist GPX, index it, reset. */
  stop: () => Promise<Track | null>;
  discard: () => void;
}

function defaultName(now: number): string {
  const d = new Date(now);
  return `Trail ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    .replace(/\s/g, '')}`;
}

/**
 * Snapshot the live recording for the crash journal, or null when idle.
 * An in-flight pause is folded into pausedMs at write time so a recording
 * recovered after a crash-while-paused keeps its frozen elapsed time.
 */
function checkpointOf(s: RecorderState): checkpoint.RecorderCheckpoint | null {
  if (s.status === 'idle' || s.startedAt === null) return null;
  return {
    status: s.status,
    name: s.name,
    startedAt: s.startedAt,
    pausedMs: s.pausedMs + (s.pausedAt !== null ? Date.now() - s.pausedAt : 0),
    points: s.points,
    waypoints: s.waypoints,
  };
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  status: 'idle',
  name: '',
  startedAt: null,
  pausedMs: 0,
  pausedAt: null,
  points: [],
  stats: EMPTY_STATS,
  waypoints: [],

  start: (name) => {
    const now = Date.now();
    // A fresh session supersedes any stale checkpoint from a previous crash.
    checkpoint.clearCheckpoint();
    set({
      status: 'recording',
      name: name?.trim() || defaultName(now),
      startedAt: now,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      waypoints: [],
    });
  },

  addPoint: (point) => {
    const { status, points, stats } = get();
    if (status !== 'recording') return;
    const prev = points[points.length - 1];
    // Gate raw fixes: bad-accuracy and teleport outliers inflate distance/D±,
    // and near-duplicate timestamps guard against double-feeding when both the
    // background task and the foreground watch deliver the same fix.
    if (!shouldAcceptFix(prev, point)) return;
    set({
      points: [...points, point],
      // Live HUD uses the cheap incremental fold; final stats are recomputed
      // exactly on stop().
      stats: reduceStatsWith(stats, prev, point),
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.maybeWriteCheckpoint(cp); // throttled crash journal
  },

  addWaypoint: () => {
    const { status, stats, waypoints, points } = get();
    if (status !== 'recording') return 0;
    const last = points[points.length - 1];
    if (!last) return 0; // need a fix to anchor the marker
    const n = waypoints.length + 1;
    set({
      waypoints: [
        ...waypoints,
        {
          id: storage.newId(),
          latitude: last.latitude,
          longitude: last.longitude,
          distanceM: stats.distanceM,
          label: `Waypoint ${n}`,
        },
      ],
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp); // waypoints are rare + high-value: write now
    return n;
  },

  updateWaypoint: (id, patch) => {
    set((s) => {
      const old = s.waypoints.find((w) => w.id === id);
      // Replacing or clearing a photo: delete the now-orphaned file.
      if (old?.photoUri && patch.photoUri !== undefined && patch.photoUri !== old.photoUri) {
        storage.deleteFileAt(old.photoUri);
      }
      return {
        waypoints: s.waypoints.map((w) => {
          if (w.id !== id) return w;
          const next: PendingWaypoint = { ...w };
          if (patch.note !== undefined) next.note = patch.note;
          if (patch.photoUri !== undefined) {
            if (patch.photoUri) next.photoUri = patch.photoUri;
            else delete next.photoUri;
          }
          return next;
        }),
      };
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  removeWaypoint: (id) => {
    set((s) => {
      const w = s.waypoints.find((x) => x.id === id);
      if (w?.photoUri) storage.deleteFileAt(w.photoUri);
      return { waypoints: s.waypoints.filter((x) => x.id !== id) };
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  pause: () => {
    if (get().status !== 'recording') return;
    set({ status: 'paused', pausedAt: Date.now() });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  resume: () => {
    const { status, pausedMs, pausedAt } = get();
    if (status !== 'paused') return;
    // Fold the completed pause into pausedMs so the elapsed timer (now -
    // startedAt - pausedMs) resumes where it froze instead of jumping forward
    // by the pause duration.
    set({
      status: 'recording',
      pausedMs: pausedMs + (pausedAt !== null ? Date.now() - pausedAt : 0),
      pausedAt: null,
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  stop: async () => {
    const { points, name, startedAt, status, waypoints } = get();
    if (status === 'idle' || startedAt === null) return null;

    // Last checkpoint before finalizing: a crash during the GPX write below
    // still leaves a complete journal to recover from.
    const preStop = checkpointOf(get());
    if (preStop) checkpoint.writeCheckpoint(preStop);

    const endedAt = Date.now();
    const finalStats = computeTrackStats(points);
    const track: Track = {
      id: storage.newId(),
      name,
      startedAt,
      endedAt,
      status: 'finished',
      points,
      stats: finalStats,
    };

    if (points.length > 0) {
      const gpx = buildGpx({
        points,
        metadata: { name, time: startedAt, creator: 'Inukshuk' },
      });
      const fileUri = storage.writeTrackGpx(track.id, gpx);
      const lib = useLibraryStore.getState();
      lib.addTrack(track, fileUri);
      // Materialize live waypoints as notes on the saved trail (their typed note,
      // or the auto label), carrying any photo, clamped to the final track length.
      for (const wp of waypoints) {
        lib.addTrackNote(
          track.id,
          Math.min(wp.distanceM, finalStats.distanceM),
          wp.note?.trim() || wp.label,
          wp.photoUri,
        );
      }
    } else {
      // Nothing saved — drop any waypoint photos so they don't orphan.
      for (const wp of waypoints) if (wp.photoUri) storage.deleteFileAt(wp.photoUri);
    }

    // The recording is safely persisted (or intentionally empty) — the crash
    // journal is now stale and must not resurrect on next launch.
    checkpoint.clearCheckpoint();
    set({
      status: 'idle',
      name: '',
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      waypoints: [],
    });
    return track;
  },

  discard: () => {
    for (const wp of get().waypoints) if (wp.photoUri) storage.deleteFileAt(wp.photoUri);
    checkpoint.clearCheckpoint();
    set({
      status: 'idle',
      name: '',
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      waypoints: [],
    });
  },
}));

// ---------------------------------------------------------------------------
// Crash recovery

let recoveryAttempted = false;

/**
 * One-shot launch recovery: if a crash left a checkpoint with recorded points,
 * restore it into the store as a PAUSED session (never auto-recording — the
 * user decides whether to resume or stop/save). Returns true when a recording
 * was recovered so the UI can explain what happened.
 *
 * Test-only `reset` escape hatch: the one-shot latch must not leak between
 * jest cases.
 */
export async function initRecorderRecovery(): Promise<boolean> {
  if (recoveryAttempted) return false;
  recoveryAttempted = true;
  // Never clobber a live session (e.g. recovery raced a fast manual start).
  if (useRecorderStore.getState().status !== 'idle') return false;

  const cp = await checkpoint.readCheckpoint();
  if (!cp || !Array.isArray(cp.points) || cp.points.length === 0) return false;

  useRecorderStore.setState({
    status: 'paused',
    name: cp.name,
    startedAt: cp.startedAt,
    pausedMs: cp.pausedMs,
    // Restored paused-at-now: the dead time between crash and relaunch never
    // counts as elapsed, and resume() folds the wait correctly.
    pausedAt: Date.now(),
    points: cp.points,
    stats: computeTrackStats(cp.points),
    waypoints: cp.waypoints ?? [],
  });
  return true;
}

/** Reset the one-shot recovery latch. Exported for tests only. */
export function resetRecorderRecoveryForTests(): void {
  recoveryAttempted = false;
}
