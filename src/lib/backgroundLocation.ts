import type { TrackPoint } from '@core/models';
import * as checkpoint from '@data/recorderCheckpoint';
import { useRecorderStore } from '@state/recorderStore';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

/**
 * Background trail recording.
 *
 * A plain `watchPositionAsync` dies with the activity: pocket the phone and the
 * track stops accruing — the #1 product gap. While a recording is live we run
 * `Location.startLocationUpdatesAsync` instead:
 *
 * - **Android**: a foreground service (the persistent notification) keeps
 *   fixes flowing with the screen off using while-in-use permission alone;
 *   "Allow all the time" (requested separately, with a rationale dialog) lets
 *   tracking survive tighter OEM battery management.
 * - **iOS**: `UIBackgroundModes: [location]` + the Always permission keep the
 *   task alive in the background (`pausesUpdatesAutomatically: false` so the
 *   OS never silently stops a slow hike; `activityType: Fitness` for hiking).
 *
 * This module is imported for its side effect from `app/_layout.tsx` so the
 * task is defined at module scope — a headless launch (Android killed and
 * relaunched the JS process mid-recording) re-registers the handler before any
 * UI exists. In that headless case the recorder store is empty, so fixes are
 * journaled durably via the checkpoint layer and merged (deduped by timestamp)
 * into the store on the next foreground/recovery.
 *
 * NOTE: requires the vc44+ binary (ACCESS_BACKGROUND_LOCATION, iOS background
 * mode). The version bump gives this JS its own OTA runtime, so it can never
 * land on older binaries.
 */

export const BACKGROUND_LOCATION_TASK = 'inukshuk-trail-recording';

/** Convert an expo-location fix to the core TrackPoint model. */
export function toTrackPoint(loc: Location.LocationObject): TrackPoint {
  const c = loc.coords;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    altitude: c.altitude ?? undefined,
    accuracy: c.accuracy ?? undefined,
    altitudeAccuracy: c.altitudeAccuracy ?? undefined,
    speed: c.speed ?? undefined,
    time: loc.timestamp,
  };
}

/** True while the OS task is feeding the recorder — the foreground watch then
 * only drives the on-screen marker (no double points). */
let active = false;

/** Headless-context decision cache: is there an interrupted recording on disk
 * worth journaling for, or is this task a stale leftover to shut down? */
let headlessDecision: 'journal' | 'stop' | null = null;

export function isBackgroundLocationActive(): boolean {
  return active;
}

// defineTask must run at module scope (the task can wake the app headless).
// Guarded so an unexpected native-module absence degrades to foreground-only
// recording instead of crashing the bundle at import time.
try {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
    if (locations.length === 0) return;

    const recorder = useRecorderStore.getState();
    if (recorder.status === 'recording') {
      // Live JS: feed the store directly. addPoint gates via the GPS filter
      // (accuracy/teleport/near-duplicate) and checkpoints on a throttle.
      for (const loc of locations) recorder.addPoint(toTrackPoint(loc));
      return;
    }
    // The user paused — drop fixes while the service winds down.
    if (recorder.status === 'paused') return;

    // status === 'idle': the JS process restarted underneath a live OS task
    // (headless relaunch, or app reopened before crash recovery ran).
    if (headlessDecision === null) {
      const cp = await checkpoint.readCheckpoint();
      if (cp?.status === 'recording') {
        headlessDecision = 'journal';
      } else {
        // No interrupted recording to feed — the task outlived its session.
        await stopBackgroundLocationUpdates();
        headlessDecision = 'stop';
      }
    }
    if (headlessDecision === 'journal') {
      await checkpoint.appendBackgroundPoints(locations.map(toTrackPoint));
    }
  });
} catch {
  /* task module unavailable — recording falls back to the foreground watch */
}

/**
 * Start OS-level location updates for the recording task. Returns false when
 * updates could not be started (missing permission/manifest entry) — the
 * foreground watch then remains the only feeder.
 */
export async function startBackgroundLocationUpdates(minDisplacementM: number): Promise<boolean> {
  headlessDecision = null; // a fresh session invalidates any cached decision
  try {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      // Mirror the foreground watch so the track quality does not change when
      // the feeder switches.
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: Math.max(1, minDisplacementM),
      foregroundService: {
        notificationTitle: 'Inukshuk is recording your track',
        notificationBody: 'Recording continues while the screen is off.',
        // Keep the service if Android destroys the activity: the headless task
        // journals fixes and the checkpoint recovers the session on relaunch.
        killServiceOnDestroy: false,
      },
      // iOS: hiking is a fitness activity; never let the OS pause updates on a
      // slow climb, and show the standard background-location status pill.
      activityType: Location.LocationActivityType.Fitness,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
    active = true;
    return true;
  } catch {
    active = false;
    return false;
  }
}

/** Stop the recording task (recording stopped/paused, or a stale task). */
export async function stopBackgroundLocationUpdates(): Promise<void> {
  active = false;
  headlessDecision = null;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {
    /* best effort */
  }
}

export type BackgroundPermissionOutcome = 'granted' | 'denied' | 'skipped';

// Session-scoped: once the user waves off the rationale, don't nag again on
// every subsequent recording start in this app run.
let rationaleDeclinedThisSession = false;

/**
 * Ensure the permissions background recording wants, in the order Android 11+
 * mandates: foreground ("while using the app") first, then background ("Allow
 * all the time") as a separate request. `askRationale` shows the explanation UI
 * and resolves with whether the user wants to proceed to the system prompt.
 *
 * Denial is not fatal: on Android the foreground-service task still records
 * with while-in-use permission; callers decide what to warn about.
 */
export async function ensureBackgroundLocationPermission(
  askRationale: () => Promise<boolean>,
): Promise<BackgroundPermissionOutcome> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) {
      const req = await Location.requestForegroundPermissionsAsync();
      if (!req.granted) return 'denied';
    }
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.granted) return 'granted';
    if (!bg.canAskAgain || rationaleDeclinedThisSession) return 'denied';
    if (!(await askRationale())) {
      rationaleDeclinedThisSession = true;
      return 'skipped';
    }
    const res = await Location.requestBackgroundPermissionsAsync();
    return res.granted ? 'granted' : 'denied';
  } catch {
    // e.g. ACCESS_BACKGROUND_LOCATION absent from an older binary's manifest.
    return 'denied';
  }
}

/**
 * Fold any journaled background points into the live recorder session (deduped
 * by timestamp). Called when the app returns to the foreground; the idle case
 * (crashed session) is handled by recorder recovery instead, which reads the
 * journal itself.
 */
export async function mergeJournaledBackgroundPoints(): Promise<void> {
  const recorder = useRecorderStore.getState();
  if (recorder.status === 'idle') return;
  const journaled = await checkpoint.readBackgroundPoints();
  if (journaled.length === 0) return;
  recorder.mergeBackgroundPoints(journaled);
  checkpoint.clearBackgroundPoints();
}
