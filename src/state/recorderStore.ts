import type { Track, TrackPoint, TrackStats } from '@core/models';
import { buildGpx } from '@core/geo/gpx';
import {
  accumulateSegmentedElevation,
  beginElevationSegment,
  computeSegmentedTrackStats,
  dropPointsDuringPauses,
  EMPTY_ELEVATION_ACC,
  reduceStatsWith,
  segmentStartsFromPauses,
  startsNewSegment,
  stepElevationGainLoss,
  totalPausedMs,
  type ElevationAccumulator,
  type PauseInterval,
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
  /**
   * Wall time excluded from the elapsed clock so far: completed pauses, plus
   * — after a crash recovery — the time the process was dead. Elapsed =
   * now − startedAt − pausedMs.
   */
  pausedMs: number;
  /** When the current pause began, while status === 'paused'. */
  pausedAt: number | null;
  /**
   * Completed pauses this session, oldest first. A resume opens a new
   * recording segment; nothing (distance, moving time, D±, the map line, the
   * GPX) bridges a pause — see `@core/geo/track/segments`.
   */
  pauses: PauseInterval[];
  /** Indices into `points` at which a new segment begins (derived from `pauses`). */
  segmentStarts: number[];
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
  mergeBackgroundPoints: (incoming: TrackPoint[]) => boolean;
  /** Drop a waypoint at the current position (becomes a numbered note on stop). */
  addWaypoint: () => number;
  /**
   * Edit a live waypoint's name, note text and/or photo (empty photoUri
   * removes it). `label` is the shared editor's Name field (#232): a live
   * waypoint has no library row to rename from, so the rename has to live
   * here. Blank keeps the current label — the auto number is never lost.
   */
  updateWaypoint: (id: string, patch: { label?: string; note?: string; photoUri?: string }) => void;
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
 * An in-flight pause is written as its start time (not folded into pausedMs),
 * so a recording recovered after a crash-while-paused resumes THAT pause and
 * the dead time in between stays excluded from the elapsed clock.
 */
function checkpointOf(s: RecorderState): checkpoint.RecorderCheckpoint | null {
  if (s.status === 'idle' || s.startedAt === null) return null;
  return {
    status: s.status,
    name: s.name,
    ...(s.category !== null ? { category: s.category } : {}),
    startedAt: s.startedAt,
    pausedMs: s.pausedMs,
    pauses: s.pauses,
    ...(s.pausedAt !== null ? { pausedAt: s.pausedAt } : {}),
    savedAt: Date.now(),
    points: s.points,
    waypoints: s.waypoints,
  };
}

/**
 * Fold journaled fixes into the session's point list: fixes stamped inside a
 * pause (completed, or the in-flight one up to `now`) are dropped — the
 * recorder accepts nothing while paused — and the GPS gate treats the first
 * fix after a pause as a segment start (no teleport check against the last
 * pre-pause fix: the user may well have driven away while paused).
 */
function mergeIntoSession(
  points: TrackPoint[],
  incoming: readonly TrackPoint[],
  pauses: readonly PauseInterval[],
  pausedAt: number | null,
  now: number,
): TrackPoint[] {
  const allPauses = pausedAt !== null ? [...pauses, { from: pausedAt, to: now }] : pauses;
  const kept = dropPointsDuringPauses(incoming, allPauses);
  return mergeTrackPoints(points, [...kept], {
    accept: (prev, next) =>
      shouldAcceptFix(startsNewSegment(prev, next, pauses) ? undefined : prev, next),
  });
}

/** Everything the store derives from a (re)built point list and its pauses. */
function segmentedState(points: TrackPoint[], pauses: readonly PauseInterval[]) {
  const segmentStarts = segmentStartsFromPauses(points, pauses);
  const elevationAcc = accumulateSegmentedElevation(points, segmentStarts);
  return {
    points,
    segmentStarts,
    stats: {
      ...computeSegmentedTrackStats(points, segmentStarts),
      ascentM: elevationAcc.ascentM,
      descentM: elevationAcc.descentM,
    },
    elevationAcc,
  };
}

const isPauseInterval = (p: unknown): p is PauseInterval =>
  typeof p === 'object' &&
  p !== null &&
  Number.isFinite((p as PauseInterval).from) &&
  Number.isFinite((p as PauseInterval).to) &&
  (p as PauseInterval).to >= (p as PauseInterval).from;

const finiteOr = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : fallback;

/** Edits are accepted only when their recovery metadata is safely on disk. */
function checkpointWaypointEdit(s: RecorderState, waypoints: PendingWaypoint[]): RecorderState {
  const next = { ...s, waypoints };
  const cp = checkpointOf(next);
  if (cp === null || !checkpoint.writeCheckpoint(cp)) {
    throw new Error('Could not save the waypoint. Free some storage and try again.');
  }
  return next;
}

function deleteUnusedWaypointPhoto(uri: string | undefined, waypoints: PendingWaypoint[]): void {
  if (!uri || waypoints.some((w) => w.photoUri === uri)) return;
  try {
    storage.deleteFileAt(uri);
  } catch {
    // Metadata is already committed; an orphan must not turn success into an error.
  }
}

let sessionGeneration = 0;

/** Ownership token for asynchronous recovery and background-journal reads. */
export const getRecorderSessionGeneration = (): number => sessionGeneration;

export const useRecorderStore = create<RecorderState>((set, get) => ({
  status: 'idle',
  name: '',
  category: null,
  startedAt: null,
  pausedMs: 0,
  pausedAt: null,
  pauses: [],
  segmentStarts: [],
  points: [],
  stats: EMPTY_STATS,
  elevationAcc: EMPTY_ELEVATION_ACC,
  waypoints: [],
  lastFixAt: null,
  lastAccuracyM: null,
  lastSavedTrackId: null,

  start: (name, category) => {
    sessionGeneration += 1;
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
      pauses: [],
      segmentStarts: [],
      points: [],
      stats: EMPTY_STATS,
      elevationAcc: EMPTY_ELEVATION_ACC,
      waypoints: [],
      lastFixAt: null,
      lastAccuracyM: null,
    });
  },

  addPoint: (point) => {
    const { status, points, stats, elevationAcc, pauses, segmentStarts } = get();
    if (status !== 'recording') return;
    const last = points[points.length - 1];
    // The first fix after a pause opens a new segment: it has no predecessor
    // to measure from, so the pause bridges nothing — not distance, moving
    // time or D±, and not the teleport gate either (the user may have driven
    // 1 km while paused; that is a new leg, not an outlier).
    const newSegment = startsNewSegment(last, point, pauses);
    const prev = newSegment ? undefined : last;
    // Gate raw fixes: bad-accuracy and teleport outliers inflate distance/D±,
    // and near-duplicate timestamps guard against double-feeding when both the
    // background task and the foreground watch deliver the same fix.
    if (!shouldAcceptFix(prev, point)) return;
    // True live D+/D- hysteresis: fold this fix into the persisted-reference
    // accumulator (matches computeTrackStats's batch hysteresis exactly,
    // incrementally) and overwrite reduceStatsWith's own per-step
    // ascentM/descentM approximation with it — see reduceStatsWith's doc
    // comment and ElevationAccumulator.
    const nextElevationAcc = stepElevationGainLoss(
      newSegment ? beginElevationSegment(elevationAcc) : elevationAcc,
      point.altitude,
    );
    const foldedStats = reduceStatsWith(stats, prev, point);
    set({
      points: [...points, point],
      segmentStarts: newSegment ? [...segmentStarts, points.length] : segmentStarts,
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
    const { status, points, pauses, pausedAt } = get();
    if (status === 'idle') return false;
    const merged = mergeIntoSession(points, incoming, pauses, pausedAt, Date.now());
    if (merged === points) {
      // A previous merge may have updated memory but failed to save. Retry
      // durability even when this snapshot contains no new points.
      const cp = checkpointOf(get());
      return cp !== null && checkpoint.writeCheckpoint(cp);
    }
    const newest = merged[merged.length - 1];
    // Out-of-order inserts invalidate the incremental stats fold, the segment
    // boundaries AND the elevation accumulator's running reference —
    // resynchronize all three from the full merged point list, segment by
    // segment, exactly like computeSegmentedTrackStats does for stats.
    set({
      ...segmentedState(merged, pauses),
      // Fold in the newest merged fix's freshness for the HUD's GPS indicator.
      ...(newest ? { lastFixAt: newest.time, lastAccuracyM: newest.accuracy ?? null } : {}),
    });
    // Force a checkpoint: the journal these came from is about to be cleared.
    const cp = checkpointOf(get());
    return cp !== null && checkpoint.writeCheckpoint(cp);
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
    const oldPhoto = get().waypoints.find((w) => w.id === id)?.photoUri;
    set((s) => {
      if (!s.waypoints.some((w) => w.id === id)) return s;
      return checkpointWaypointEdit(
        s,
        s.waypoints.map((w) => {
          if (w.id !== id) return w;
          const next: PendingWaypoint = { ...w };
          // Blank is "leave it alone", exactly as libraryStore.renameWaypoint:
          // a live waypoint's label is also its fallback note text on stop, so
          // clearing it would silently erase the note.
          if (patch.label !== undefined && patch.label.trim() !== '') {
            next.label = patch.label.trim();
          }
          if (patch.note !== undefined) next.note = patch.note;
          if (patch.photoUri !== undefined) {
            if (patch.photoUri) next.photoUri = patch.photoUri;
            else delete next.photoUri;
          }
          return next;
        }),
      );
    });
    deleteUnusedWaypointPhoto(oldPhoto, get().waypoints);
  },

  removeWaypoint: (id) => {
    const oldPhoto = get().waypoints.find((w) => w.id === id)?.photoUri;
    set((s) => {
      if (!s.waypoints.some((w) => w.id === id)) return s;
      return checkpointWaypointEdit(
        s,
        s.waypoints.filter((w) => w.id !== id),
      );
    });
    deleteUnusedWaypointPhoto(oldPhoto, get().waypoints);
  },

  pause: () => {
    const { status, lastFixAt } = get();
    if (status !== 'recording') return;
    // The pause start is the segment boundary (a fix belongs to the leg after
    // every pause that began before it). A fix stamped ahead of the wall
    // clock — GPS time vs a drifting device clock — must still count as
    // pre-pause, so the boundary never sits before the last accepted fix.
    set({ status: 'paused', pausedAt: Math.max(Date.now(), (lastFixAt ?? -Infinity) + 1) });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  resume: () => {
    const { status, pausedMs, pausedAt, pauses } = get();
    if (status !== 'paused') return;
    // Fold the completed pause into pausedMs so the elapsed timer (now -
    // startedAt - pausedMs) resumes where it froze instead of jumping forward
    // by the pause duration — and record it: the next accepted fix opens a
    // new recording segment (see addPoint).
    const pause = pausedAt !== null ? { from: pausedAt, to: Date.now() } : null;
    set({
      status: 'recording',
      pausedMs: pausedMs + (pause ? pause.to - pause.from : 0),
      pausedAt: null,
      pauses: pause ? [...pauses, pause] : pauses,
    });
    const cp = checkpointOf(get());
    if (cp) checkpoint.writeCheckpoint(cp);
  },

  stop: async () => {
    if (get().status === 'idle') return null;
    const generation = sessionGeneration;
    const journaled = await checkpoint.readBackgroundPoints();
    if (generation !== sessionGeneration) return null;
    if (journaled.length > 0) get().mergeBackgroundPoints(journaled);
    const { points, segmentStarts, name, category, startedAt, status, waypoints } = get();
    if (status === 'idle' || startedAt === null) return null;

    // Last checkpoint before finalizing: a crash during the GPX write below
    // still leaves a complete journal to recover from.
    const preStop = checkpointOf(get());
    if (preStop) checkpoint.writeCheckpoint(preStop);

    const endedAt = Date.now();
    const finalStats = computeSegmentedTrackStats(points, segmentStarts);
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
        segmentStarts, // one <trkseg> per leg — a pause is a segment boundary
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
    sessionGeneration += 1;
    checkpoint.clearCheckpoint();
    set({
      status: 'idle',
      name: '',
      category: null,
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      pauses: [],
      segmentStarts: [],
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
    sessionGeneration += 1;
    for (const wp of get().waypoints) if (wp.photoUri) storage.deleteFileAt(wp.photoUri);
    checkpoint.clearCheckpoint();
    set({
      status: 'idle',
      name: '',
      category: null,
      startedAt: null,
      pausedMs: 0,
      pausedAt: null,
      pauses: [],
      segmentStarts: [],
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
  const generation = sessionGeneration;
  const ownsRecovery = () =>
    generation === sessionGeneration && useRecorderStore.getState().status === 'idle';

  // A checkpoint/journal written by a crashed session can be malformed. Recovery
  // runs at launch, so ANY throw here (corrupt JSON, unexpected shape, stats
  // math on bad points) would reject into app startup — the app must never
  // crash-loop over unrecoverable state. On failure, discard the bad
  // checkpoint+journal and start clean.
  try {
    const cp = await checkpoint.readCheckpoint();
    if (!ownsRecovery()) return false;
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
    if (!ownsRecovery()) return false;
    if (useLibraryStore.getState().tracks.some((t) => t.startedAt === cp.startedAt)) {
      checkpoint.clearCheckpoint();
      return false;
    }

    const journaled = await checkpoint.readBackgroundPoints();
    if (!ownsRecovery()) return false;
    const now = Date.now();
    // Old checkpoints carry no pauses: a single-segment recording, as before.
    const pauses = Array.isArray(cp.pauses) ? cp.pauses.filter(isPauseInterval) : [];
    // The recovered session is paused. Which pause?
    // - Killed while PAUSED: the very pause the user started (`pausedAt`), so
    //   the whole dead time — pause, crash, relaunch, and the wait until the
    //   user resumes — is one pause: excluded from the clock, and one segment
    //   boundary. A legacy checkpoint (no `pausedAt`) had that pause folded
    //   into pausedMs at write time; the best it can do is pause at relaunch.
    // - Killed while RECORDING: a pause that starts now (relaunch). Fixes the
    //   OS task journaled while the process was dead predate it and stay in
    //   the recording leg; anything after it is dropped as paused.
    const pausedAt =
      cp.status === 'paused' && typeof cp.pausedAt === 'number' && Number.isFinite(cp.pausedAt)
        ? Math.min(cp.pausedAt, now)
        : now;
    const points = mergeIntoSession(cp.points, journaled, pauses, pausedAt, now);
    if (points.length === 0) return false;

    let pausedMs = finiteOr(cp.pausedMs, totalPausedMs(pauses));
    if (cp.status === 'recording') {
      // Active time can only be vouched for up to the last evidence the
      // recording was alive: the checkpoint write, or the newest fix
      // (background fixes journaled while the JS process was dead extend
      // it — that IS legitimate recording time). The rest, until relaunch,
      // is dead time: excluded like a pause.
      const newestFixAt = points[points.length - 1]?.time ?? cp.startedAt;
      const activeUntil = Math.min(now, Math.max(finiteOr(cp.savedAt, cp.startedAt), newestFixAt));
      pausedMs += Math.max(0, now - activeUntil);
    }

    useRecorderStore.setState({
      status: 'paused',
      name: cp.name,
      // Old checkpoints (pre-categories) simply restore as uncategorized.
      category: typeof cp.category === 'string' ? cp.category : null,
      startedAt: cp.startedAt,
      pausedMs,
      pausedAt,
      pauses,
      // Stats, segment boundaries and the live hysteresis accumulator's
      // running reference are all resynchronized from the recovered points,
      // so addPoint's live D+/D- keeps matching the batch computation after a
      // resume — same reasoning as mergeBackgroundPoints.
      ...segmentedState(points, pauses),
      waypoints: cp.waypoints ?? [],
      lastFixAt: points[points.length - 1]?.time ?? null,
      lastAccuracyM: points[points.length - 1]?.accuracy ?? null,
    });
    // The journal is folded in — re-checkpoint the merged session so a second
    // crash cannot lose the background points, then drop the journal.
    const merged = checkpointOf(useRecorderStore.getState());
    if (merged && checkpoint.writeCheckpoint(merged))
      checkpoint.acknowledgeBackgroundPoints(journaled);
    return true;
  } catch (err) {
    if (generation !== sessionGeneration) return false;
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
