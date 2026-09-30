import { quietImportMessage } from '@core/import/auto';
import { isResumable, newImportJob, type ImportJob } from '@core/import/job';
import { sourceLabel } from '@core/import/origin';
import {
  rangeStart,
  type ActivitySource,
  type ActivitySourceId,
  type ImportRange,
  type RemoteActivity,
} from '@core/import/sources';
import * as storage from '@data/storage';
import { primeTrackGeometry } from '@data/trackGeometry';
import { reportError } from '@lib/errorReporting';
import { healthSource } from '@lib/health';
import { createStravaSource } from '@lib/stravaSource';
import { useImportFeedbackStore } from '@state/importFeedbackStore';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { AppState, type NativeEventSubscription } from 'react-native';

import { runSourceImport } from './runSourceImport';

/**
 * Owns the one running connected-source import: starts it, stops it, resumes
 * it, and pauses a Health import when the app leaves the foreground (Health
 * reads only run in the foreground) — resuming it when the app comes back.
 * The job's state lives in `@state/importStore`; the work in
 * {@link runSourceImport}.
 */

let active: { controller: AbortController; reason: 'stop' | 'background' } | null = null;
let stravaSource: ActivitySource | null = null;
let appStateSub: NativeEventSubscription | null = null;

/** The source behind an id on this device, or null (Health on the other platform). */
export function sourceFor(id: ActivitySourceId): ActivitySource | null {
  if (id === 'strava') {
    stravaSource ??= createStravaSource();
    return stravaSource;
  }
  const health = healthSource();
  return health && health.id === id ? health : null;
}

export function isImportRunning(): boolean {
  return active !== null;
}

function watchAppState(): void {
  if (appStateSub) return;
  appStateSub = AppState.addEventListener('change', (state) => {
    const job = useImportStore.getState().job;
    if (!job || job.source === 'strava') return;
    if (state === 'background' && active) {
      active.reason = 'background';
      active.controller.abort();
    } else if (
      state === 'active' &&
      !active &&
      job.status === 'paused' &&
      job.pausedReason === 'background'
    ) {
      void resumeSourceImport();
    }
  });
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function run(job: ImportJob, listed?: readonly RemoteActivity[]): Promise<void> {
  const store = useImportStore.getState();
  const source = sourceFor(job.source);
  if (!source) {
    store.setJob({
      ...job,
      status: 'error',
      errorKind: 'other',
      message: `${sourceLabel(job.source)} isn’t available on this phone`,
    });
    return;
  }
  const controller = new AbortController();
  const current = { controller, reason: 'stop' as 'stop' | 'background' };
  active = current;
  watchAppState();
  try {
    const final = await runSourceImport(
      job,
      {
        source,
        libraryTracks: () => useLibraryStore.getState().tracks,
        addTracks: (items) => useLibraryStore.getState().addTracks(items),
        writeGpx: storage.writeTrackGpx,
        onTrackSaved: primeTrackGeometry,
        newId: storage.newId,
        now: () => Date.now(),
        yieldToUi,
        onUpdate: (next, persist) => useImportStore.getState().setJob(next, { persist }),
      },
      controller.signal,
      { listed, interruption: () => current.reason },
    );
    const imports = useImportStore.getState();
    if (final.status === 'done') imports.markImported(final.source, final.startedAt);
    const otherError = final.status === 'error' && final.errorKind === 'other';
    if (final.quiet && (final.status === 'done' || otherError)) {
      // An automatic import ends with a line, not a card — and one that
      // failed (offline, most likely) says nothing: the next check retries.
      imports.setJob(null);
      if (final.status === 'done' && final.imported > 0) {
        useImportFeedbackStore
          .getState()
          .show(quietImportMessage(final.imported, sourceLabel(final.source)));
      }
      return;
    }
    if (otherError) {
      reportError(new Error(final.message ?? 'import failed'), `import-${final.source}`);
    }
  } catch (err) {
    // runSourceImport never throws; a store write might.
    reportError(err, `import-${job.source}`);
  } finally {
    if (active === current) active = null;
  }
}

/**
 * Start importing `range` from `source`. `listed` is the Import sheet's
 * preview listing, reused so nothing is listed twice. No-op while another
 * import runs.
 */
export async function startSourceImport(args: {
  source: ActivitySourceId;
  range: ImportRange;
  listed?: readonly RemoteActivity[];
  /** An automatic import: no card unless there is something new. */
  quiet?: boolean;
}): Promise<void> {
  if (active) return;
  const now = Date.now();
  const job = newImportJob({
    source: args.source,
    range: args.range,
    since: rangeStart(args.range, now),
    now,
    quiet: args.quiet,
  });
  await run(job, args.listed);
}

/** Pick a paused or stopped job back up (re-lists; planning skips what is done). */
export async function resumeSourceImport(): Promise<void> {
  const job = useImportStore.getState().job;
  if (active || !job || !isResumable(job)) return;
  await run(job);
}

/** Stop the running import (or give up on a paused one). Resumable later. */
export function stopSourceImport(): void {
  if (active) {
    active.reason = 'stop';
    active.controller.abort();
    return;
  }
  const job = useImportStore.getState().job;
  if (job?.status === 'paused') {
    useImportStore.getState().setJob({ ...job, status: 'stopped', pausedReason: null });
  }
}

/** Put away a finished, stopped or failed job's card. */
export function dismissImportJob(): void {
  const job = useImportStore.getState().job;
  if (!job || job.status === 'running' || active) return;
  useImportStore.getState().setJob(null);
}

/** Test seam: forget the running import and the cached Strava source. */
export function resetImportControllerForTests(): void {
  active = null;
  stravaSource = null;
  appStateSub?.remove();
  appStateSub = null;
}
