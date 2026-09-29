import { buildGpx } from '@core/geo/gpx';
import { buildImportedTrack } from '@core/geo/track';
import type { ImportJob } from '@core/import/job';
import { libraryDuplicateIndex, planImport, remoteActivityName } from '@core/import/plan';
import {
  SourceStopError,
  type ActivityRoute,
  type ActivitySource,
  type ImportPause,
  type RemoteActivity,
} from '@core/import/sources';
import type { TrackSummary } from '@core/models';

import type { ImportedTrack } from '../library/importGpx';

/**
 * The connected-source importer (#432/#435): list → plan (drop what is
 * already here or has no GPS) → fetch each route → save it as a trail with
 * its origin. One activity at a time, yielding to the UI between them; the
 * job object is the whole state and every step reports it, so the store can
 * show it and persist it. Stopping, pausing and resuming are all "abort, and
 * run again later from `job.remaining`" — planning dedupes by origin, so a
 * resumed job never imports anything twice.
 */

export interface SourceImportDeps {
  source: ActivitySource;
  /** The Library's trails right now (dedupe; read once per run). */
  libraryTracks: () => readonly TrackSummary[];
  /** Commit trails to the Library (one index write per call). */
  addTracks: (items: readonly ImportedTrack[]) => void;
  /** Write a trail's GPX; returns its file uri. */
  writeGpx: (id: string, gpx: string) => string;
  newId: () => string;
  now: () => number;
  /** Hand the JS thread back to the UI between activities. */
  yieldToUi: () => Promise<void>;
  /**
   * Every change to the job. `persist` is true at flush points: the Library
   * write for the trails so far has happened, so the job may be saved with
   * them marked done.
   */
  onUpdate: (job: ImportJob, persist: boolean) => void;
  /** Commit to the Library every this many new trails (default 10). */
  flushEvery?: number;
  /** Or at least this often, in ms (default 3 s). */
  flushIntervalMs?: number;
}

export interface SourceImportOptions {
  /** A listing the Import sheet already made for its preview (skips listing). */
  listed?: readonly RemoteActivity[];
  /** Why the signal was aborted: the user stopped it, or the app left the foreground. */
  interruption: () => 'stop' | 'background';
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'AbortError');
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong';
}

/**
 * Run (or resume) `job` to completion, a pause, a stop or an error, and
 * return where it ended. Never throws: every outcome is a job status.
 */
export async function runSourceImport(
  start: ImportJob,
  deps: SourceImportDeps,
  signal: AbortSignal,
  options: SourceImportOptions,
): Promise<ImportJob> {
  const flushEvery = deps.flushEvery ?? 10;
  const flushIntervalMs = deps.flushIntervalMs ?? 3000;
  let job: ImportJob = {
    ...start,
    status: 'running',
    pause: null,
    pausedReason: null,
    resumeAt: null,
    message: null,
    errorKind: null,
  };
  const emit = (persist = false) => deps.onUpdate(job, persist);
  const onPause = (pause: ImportPause) => {
    job = { ...job, pause };
    emit();
  };

  const interrupted = (): ImportJob => {
    const reason = options.interruption();
    return reason === 'background'
      ? { ...job, status: 'paused', pausedReason: 'background', pause: null }
      : { ...job, status: 'stopped', pause: null };
  };

  const stopped = (err: unknown): ImportJob => {
    if (isAbort(err, signal)) return interrupted();
    if (err instanceof SourceStopError) {
      return err.kind === 'daily-limit'
        ? {
            ...job,
            status: 'paused',
            pausedReason: 'daily-limit',
            resumeAt: err.resumeAt,
            pause: null,
          }
        : { ...job, status: 'error', errorKind: 'auth', message: err.message, pause: null };
    }
    return { ...job, status: 'error', errorKind: 'other', message: errorMessage(err), pause: null };
  };

  emit(true);

  // 1. List (unless the sheet already did), then plan.
  const resuming = !job.listing;
  let listed: readonly RemoteActivity[];
  try {
    listed = options.listed ?? (await deps.source.list(job.since, signal, onPause));
  } catch (err) {
    job = stopped(err);
    emit(true);
    return job;
  }
  if (signal.aborted) {
    job = interrupted();
    emit(true);
    return job;
  }
  const library = deps.libraryTracks();
  const plan = planImport(listed, library, resuming ? new Set(job.remaining) : undefined);
  const index = libraryDuplicateIndex(library);
  job = resuming
    ? {
        ...job,
        // What the resumed listing no longer holds, or now finds already here,
        // is done too.
        done: Math.max(job.done, job.total - plan.toFetch.length),
        skippedDuplicates: job.skippedDuplicates + plan.alreadyHere,
        noGps: job.noGps + plan.noGps,
        remaining: plan.toFetch.map((a) => a.origin.externalId),
      }
    : {
        ...job,
        listing: false,
        total: plan.toFetch.length,
        done: 0,
        skippedDuplicates: job.skippedDuplicates + plan.alreadyHere,
        noGps: job.noGps + plan.noGps,
        remaining: plan.toFetch.map((a) => a.origin.externalId),
      };
  emit(true);

  // 2. Fetch and save, one by one. Trails are committed to the Library in
  // batches; the job is persisted right after each commit, so what it marks
  // done is always on disk.
  let pending: ImportedTrack[] = [];
  let lastFlush = deps.now();
  const handled = new Set<string>();
  const flush = () => {
    if (pending.length > 0) deps.addTracks(pending);
    pending = [];
    lastFlush = deps.now();
    job = { ...job, remaining: job.remaining.filter((id) => !handled.has(id)) };
    emit(true);
  };
  const finish = (next: ImportJob): ImportJob => {
    job = next;
    flush();
    return job;
  };

  for (const activity of plan.toFetch) {
    if (signal.aborted) return finish(interrupted());
    await deps.yieldToUi();
    if (signal.aborted) return finish(interrupted());

    const externalId = activity.origin.externalId;
    let route: ActivityRoute;
    try {
      route = await deps.source.fetchRoute(activity, signal, onPause);
    } catch (err) {
      if (isAbort(err, signal) || err instanceof SourceStopError) return finish(stopped(err));
      handled.add(externalId);
      job = { ...job, failed: job.failed + 1, done: job.done + 1 };
      emit();
      continue;
    }
    handled.add(externalId);
    const { points, segmentStarts } = route;
    if (points.length === 0) {
      job = { ...job, noGps: job.noGps + 1, done: job.done + 1 };
      emit();
      continue;
    }

    const id = deps.newId();
    const name = remoteActivityName(activity);
    const track = buildImportedTrack({
      id,
      points,
      segmentStarts,
      name,
      fallbackName: name,
      fallbackTime: activity.startedAt,
    });
    const fingerprint = { startedAt: track.startedAt, distanceM: track.stats.distanceM };
    if (index.has(fingerprint)) {
      job = { ...job, skippedDuplicates: job.skippedDuplicates + 1, done: job.done + 1 };
      emit();
      continue;
    }
    index.add(fingerprint);
    if (activity.category) track.category = activity.category;
    track.origin = activity.origin;
    try {
      const gpx = buildGpx({
        points,
        segmentStarts,
        metadata: { name: track.name, time: track.startedAt },
      });
      const fileUri = deps.writeGpx(id, gpx);
      pending.push({ track: { ...track, points: [] }, fileUri, notes: [] });
    } catch {
      // A GPX that couldn't be written (disk full): count it, keep going.
      job = { ...job, failed: job.failed + 1, done: job.done + 1 };
      emit();
      continue;
    }
    job = {
      ...job,
      imported: job.imported + 1,
      done: job.done + 1,
      distanceM: job.distanceM + track.stats.distanceM,
      ascentM: job.ascentM + track.stats.ascentM,
      importedTrackIds: [...job.importedTrackIds, id],
    };
    if (pending.length >= flushEvery || deps.now() - lastFlush >= flushIntervalMs) flush();
    else emit();
  }

  return finish({ ...job, status: 'done', done: job.total, pause: null, remaining: [] });
}
