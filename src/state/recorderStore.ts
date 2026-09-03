import type { Track, TrackPoint, TrackStats } from '@core/models';
import { buildGpx } from '@core/geo/gpx';
import {
  accumulateElevationGainLoss,
  computeTrackStats,
  EMPTY_ELEVATION_ACC,
  reduceStatsWith,
  stepElevationGainLoss,
  type ElevationAccumulator,
} from '@core/geo/track';
import { shouldAcceptFix } from '@core/geo/track/gpsFilter';
import { mergeTrackPoints } from '@core/geo/track/mergePoints';
import { findCategory } from '@core/library/categories';
import * as checkpoint from '@data/recorderCheckpoint';
import * as storage from '@data/storage';
import * as Location from 'expo-location';
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
  /** Activity category id chosen at record start (see `@core/library/categories`). */
  category: string | null;
  startedAt: number | null;
  /** Wall time spent paused so far (completed pauses only). */
  pausedMs: number;
  /** When the current pause began, while status === 'paused'. */
  pausedAt: number | null;
  points: TrackPoint[];
  stats: TrackStats;
  /**
   * Live D+/D- hysteresis state, threaded across `addPoint` calls so the
   * running HUD accumulates elevation gain/loss with a real persisted
   * "reference" elevation — exactly matching `computeTrackStats`'s batch
   * hysteresis, incrementally, instead of the old per-step approximation
   * (which compared only to the immediately preceding point and under-counted
   * slow, sustained climbs to the point of looking broken). Internal
   * bookkeeping only; `stats.ascentM`/`descentM` are what the UI reads.
   */
  elevationAcc: ElevationAccumulator;
  waypoints: PendingWaypoint[];
  /**
   * Epoch ms of the most recently ACCEPTED fix (null until the first one), and
   * that fix's reported horizontal accuracy in metres (null when unknown). The
   * HUD turns these into a GPS-quality warning: the filter silently drops
   * bad/teleport fixes, so a stalled track otherwise looks identical to a
   * healthy one. See `@core/geo/track/gpsQuality`.
   */
  lastFixAt: number | null;
  lastAccuracyM: number | null;
  /**
   * Id of the most recently stopped-AND-saved recording, until a consumer
   * acknowledges it. Observed by the Strava push prompt (features/strava) so
   * end-of-recording integrations never have to touch the stop path itself.
   */
  lastSavedTrackId: string | null;

  start: (name?: string, category?: string) => void;
  addPoint: (point: TrackPoint) => void;
  /**
   * Fold points journaled by the background location task into the live
   * session: deduped by timestamp, gated by the GPS filter, stats recomputed.
   * No-op while idle (crash recovery owns that case).
   */
  mergeBackgroundPoints: (incoming: TrackPoint[]) => void;
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
  /** Consume {@link lastSavedTrackId} (one prompt per save). */
  acknowledgeSavedTrack: () => void;
  discard: () => void;
}

function defaultName(now: number): string {
  const d = new Date(now);
  return `Trail ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    .replace(/\s/g, '')}`;
}

/** "Morning" / "Afternoon" / "Evening" / "Night" for the auto title. */
function timeOfDay(ms: number): string {
  const h = new Date(ms).getHours();
  if (h >= 5 && h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}

/**
 * Fire-and-forget after a save: upgrade a date-based auto name to
 * "<Time-of-day> <activity> · <place>" via reverse geocoding (Strava idiom —
 * the Library card already shows the date on its own line). Never blocks the
 * save (geocoding needs network); bails if the user has renamed the track in
 * the meantime (the post-save rename prompt races this) or the geocoder is
 * unavailable — the date-based default stands. The place lookup is raced
 * against a timeout: like getHeadingAsync, geocoder calls can hang forever on
 * some devices rather than reject.
 */
async function upgradeAutoName(
  trackId: string,
  expectedName: string,
  startedAt: number,
  categoryId: string | null,
  first: TrackPoint,
): Promise<void> {
  let place: string | null = null;
  try {
    const geo = await Promise.race([
      Location.reverseGeocodeAsync({ latitude: first.latitude, longitude: first.longitude }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    const a = geo?.[0];
    place = a?.city ?? a?.district ?? a?.subregion ?? a?.region ?? null;
  } catch {
    // Offline / no geocoder — still upgrade to the time-of-day title below.
  }
  const lib = useLibraryStore.getState();
  const current = lib.tracks.find((t) => t.id === trackId);
  if (!current || current.name !== expectedName) return;
  const category = findCategory(categoryId ?? undefined, lib.customCategories);
  const activity = category ? category.name.toLowerCase() : 'trail';
  lib.updateTrack(trackId, {
    name: `${timeOfDay(startedAt)} ${activity}${place ? ` · ${place}` : ''}`,
  });
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
    ...(s.category !== null ? { category: s.category } : {}),
    startedAt: s.startedAt,
    pausedMs: s.pausedMs + (s.pausedAt !== null ? Date.now() - s.pausedAt : 0),
    points: s.points,
    waypoints: s.waypoints,
  };
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  status: 'idle',
  name: '',
  category: null,
  startedAt: null,
  pausedMs: 0,
  pausedAt: null,
  points: [],
  stats: EMPTY_STATS,
  elevationAcc: EMPTY_ELEVATION_ACC,
  waypoints: [],
  lastFixAt: null,
  lastAccuracyM: null,
  lastSavedTrackId: null,

  start: (name, category) => {
    const now = Date.now();
    // A fresh session supersedes any stale checkpoint from a previous crash.
    checkpoint.clearCheckpoint();
    set({
      status: 'recording',
      name: name?.trim() || defaultName(now),
      category: category ?? null,
      startedAt: now,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      elevationAcc: EMPTY_ELEVATION_ACC,
      waypoints: [],
      lastFixAt: null,
      lastAccuracyM: null,
    });
  },

  addPoint: (point) => {
    const { status, points, stats, elevationAcc } = get();
    if (status !== 'recording') return;
    const prev = points[points.length - 1];
    // Gate raw fixes: bad-accuracy and teleport outliers inflate distance/D±,
    // and near-duplicate timestamps guard against double-feeding when both the
    // background task and the foreground watch deliver the same fix.
    if (!shouldAcceptFix(prev, point)) return;
    // True live D+/D- hysteresis: fold this fix into the persisted-reference
    // accumulator (matches computeTrackStats's batch hysteresis exactly,
    // incrementally) and overwrite reduceStatsWith's own per-step
    // ascentM/descentM approximation with it — see reduceStatsWith's doc
    // comment and ElevationAccumulator.
    const nextElevationAcc = stepElevationGainLoss(elevationAcc, point.altitude);
    const foldedStats = reduceStatsWith(stats, prev, point);
    set({
      points: [...points, point],
      // Live HUD uses the cheap incremental fold for everything else; final
      // stats are recomputed exactly on stop().
      stats: {
        ...foldedStats,
        ascentM: nextElevationAcc.ascentM,
        descentM: nextElevationAcc.descentM,
      },
      elevationAcc: nextElevationAcc,
      // Freshness/quality signal for the HUD's GPS indicator (using the fix's
      // own timestamp so a late-delivered fix reflects its true age).
      lastFixAt: point.time,
      lastAccuracyM: point.accuracy ?? null,
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.maybeWriteCheckpoint(cp); // throttled crash journal
  },

  mergeBackgroundPoints: (incoming) => {
    const { status, points } = get();
    if (status === 'idle') return;
    const merged = mergeTrackPoints(points, incoming, { accept: shouldAcceptFix });
    if (merged === points) return; // nothing new — keep identity, skip the I/O
    const newest = merged[merged.length - 1];
    // Out-of-order inserts invalidate both the incremental stats fold AND the
    // elevation accumulator's running reference — resynchronize both from the
    // full merged point list, exactly like computeTrackStats does for stats.
    const elevationAcc = accumulateElevationGainLoss(merged.map((p) => p.altitude));
    set({
      points: merged,
      stats: {
        ...computeTrackStats(merged),
        ascentM: elevationAcc.ascentM,
        descentM: elevationAcc.descentM,
      },
      elevationAcc,
      // Fold in the newest merged fix's freshness for the HUD's GPS indicator.
      ...(newest ? { lastFixAt: newest.time, lastAccuracyM: newest.accuracy ?? null } : {}),
    });
    // Force a checkpoint: the journal these came from is about to be cleared.
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
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
    const { points, name, category, startedAt, status, waypoints } = get();
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
      // The chosen activity category rides the Track into the library summary.
      ...(category !== null ? { category } : {}),
    };

    if (points.length > 0) {
      const gpx = buildGpx({
        points,
        metadata: { name, time: startedAt, creator: 'Inukshuk' },
      });
      const fileUri = storage.writeTrackGpx(track.id, gpx);
      const lib = useLibraryStore.getState();
      // Materialize live waypoints as notes on the saved trail (their typed note,
      // or the auto label), carrying any photo, clamped to the final track length
      // — seeded WITH the trail rather than through a per-waypoint
      // `addTrackNote` loop, which serialized and atomically swapped the whole
      // library index once per waypoint (1 + N writes, scaling with the user's
      // library size) at the very end of a hike. One write now, and it is
      // already the complete trail: nothing durable is traded away.
      const notes = waypoints.map((wp) => ({
        distanceM: Math.min(wp.distanceM, finalStats.distanceM),
        text: wp.note?.trim() || wp.label,
        ...(wp.photoUri ? { photoUri: wp.photoUri } : {}),
      }));
      lib.addTrack(track, fileUri, notes);
      // Auto-named recording → try for a friendlier region title, async.
      const first = points[0];
      if (first && name === defaultName(startedAt)) {
        void upgradeAutoName(track.id, name, startedAt, category, first);
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
      category: null,
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      elevationAcc: EMPTY_ELEVATION_ACC,
      waypoints: [],
      // Signal observers (Strava push prompt) that a trail was just saved.
      lastSavedTrackId: points.length > 0 ? track.id : null,
    });
    return track;
  },

  acknowledgeSavedTrack: () => set({ lastSavedTrackId: null }),

  discard: () => {
    for (const wp of get().waypoints) if (wp.photoUri) storage.deleteFileAt(wp.photoUri);
    checkpoint.clearCheckpoint();
    set({
      status: 'idle',
      name: '',
      category: null,
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      points: [],
      stats: EMPTY_STATS,
      elevationAcc: EMPTY_ELEVATION_ACC,
      waypoints: [],
      lastFixAt: null,
      lastAccuracyM: null,
    });
  },
}));

// ---------------------------------------------------------------------------
// Crash recovery

let recoveryAttempted = false;

/**
 * One-shot launch recovery: if a crash left a checkpoint with recorded points,
 * restore it into the store as a PAUSED session (never auto-recording — the
 * user decides whether to resume or stop/save). Points journaled by the
 * background location task while the JS process was dead are folded in
 * (deduped by timestamp, gated by the GPS filter). Returns true when a
 * recording was recovered so the UI can explain what happened.
 *
 * Test-only `reset` escape hatch: the one-shot latch must not leak between
 * jest cases.
 */
export async function initRecorderRecovery(): Promise<boolean> {
  if (recoveryAttempted) return false;
  recoveryAttempted = true;
  // Never clobber a live session (e.g. recovery raced a fast manual start).
  if (useRecorderStore.getState().status !== 'idle') return false;

  // A checkpoint/journal written by a crashed session can be malformed. Recovery
  // runs at launch, so ANY throw here (corrupt JSON, unexpected shape, stats
  // math on bad points) would reject into app startup — the app must never
  // crash-loop over unrecoverable state. On failure, discard the bad
  // checkpoint+journal and start clean.
  try {
    const cp = await checkpoint.readCheckpoint();
    if (!cp || !Array.isArray(cp.points)) return false;

    // Ghost-session guard: clearCheckpoint's delete is best-effort — when it
    // silently fails right after a successful save, the stale checkpoint
    // resurrects the already-saved hike as a paused "ghost" recording on the
    // next launch, and the re-checkpoint below then makes the ghost permanent
    // across every later launch. A saved trail with this exact startedAt is
    // proof the session completed: discard the checkpoint instead of
    // restoring it.
    const lib = useLibraryStore.getState();
    if (!lib.hydrated) {
      try {
        await lib.hydrate();
      } catch {
        /* hydration failure → judge with whatever tracks we have */
      }
    }
    if (useLibraryStore.getState().tracks.some((t) => t.startedAt === cp.startedAt)) {
      checkpoint.clearCheckpoint();
      return false;
    }

    const journaled = await checkpoint.readBackgroundPoints();
    const points = mergeTrackPoints(cp.points, journaled, { accept: shouldAcceptFix });
    if (points.length === 0) return false;

    useRecorderStore.setState({
      status: 'paused',
      name: cp.name,
      // Old checkpoints (pre-categories) simply restore as uncategorized.
      category: typeof cp.category === 'string' ? cp.category : null,
      startedAt: cp.startedAt,
      pausedMs: cp.pausedMs,
      // Restored paused-at-now: the dead time between crash and relaunch never
      // counts as elapsed, and resume() folds the wait correctly.
      pausedAt: Date.now(),
      points,
      stats: computeTrackStats(points),
      // Resynchronize the live hysteresis accumulator's running reference from
      // the recovered points, so addPoint's live D+/D- keeps matching the
      // batch computation after a resume — same reasoning as mergeBackgroundPoints.
      elevationAcc: accumulateElevationGainLoss(points.map((p) => p.altitude)),
      waypoints: cp.waypoints ?? [],
      lastFixAt: points[points.length - 1]?.time ?? null,
      lastAccuracyM: points[points.length - 1]?.accuracy ?? null,
    });
    // The journal is folded in — re-checkpoint the merged session so a second
    // crash cannot lose the background points, then drop the journal.
    const merged = checkpointOf(useRecorderStore.getState());
    if (merged) checkpoint.writeCheckpoint(merged);
    checkpoint.clearBackgroundPoints();
    return true;
  } catch (err) {
    // Unrecoverable state: wipe it so the next launch is clean, and surface it.
    try {
      checkpoint.clearCheckpoint();
      checkpoint.clearBackgroundPoints();
    } catch {
      /* best effort */
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Reset the one-shot recovery latch. Exported for tests only. */
export function resetRecorderRecoveryForTests(): void {
  recoveryAttempted = false;
}
