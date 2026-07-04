import type { LatLng, TrackPoint } from '@core/models';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

export type LocationPermission = 'undetermined' | 'granted' | 'denied';

export interface LocationTracking {
  location: LatLng | null;
  /** Latest full fix, including altitude/accuracy. */
  lastFix: TrackPoint | null;
  permission: LocationPermission;
}

function toTrackPoint(loc: Location.LocationObject): TrackPoint {
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

// ---------------------------------------------------------------------------
// Background recording (foreground service)
//
// A plain watchPositionAsync dies with the activity: pocket the phone and the
// track stops accruing — the #1 product gap. While a recording is live we run
// Location.startLocationUpdatesAsync with an Android foreground service (the
// persistent notification), which keeps fixes flowing with only while-in-use
// permission — no ACCESS_BACKGROUND_LOCATION, so Play review stays simple.
//
// OTA guard: production binaries built before expo-task-manager shipped have
// neither the native module nor the FOREGROUND_SERVICE_LOCATION permission.
// The require() below throws there, taskManager stays null, and recording
// falls back to today's foreground-only watch — no user-facing change until
// the next store build.

const RECORDING_TASK = 'inukshuk-trail-recording';

/** True while the foreground-service task is feeding the recorder — the
 * foreground watch then only drives the on-screen marker (no double points). */
let bgServiceActive = false;

type TaskManagerModule = typeof import('expo-task-manager');

const taskManager: TaskManagerModule | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null; // old binary: native module absent — foreground-only fallback
  }
})();

// defineTask must run in module scope (the task can wake the app headless).
if (taskManager) {
  try {
    taskManager.defineTask(RECORDING_TASK, async ({ data, error }) => {
      if (error || !data) return;
      const { locations } = data as { locations?: Location.LocationObject[] };
      const recorder = useRecorderStore.getState();
      // addPoint gates by status and by the GPS filter (which also drops
      // near-duplicate timestamps if the watch delivered the same fix).
      for (const loc of locations ?? []) recorder.addPoint(toTrackPoint(loc));
    });
  } catch {
    /* defineTask failed — recording falls back to the foreground watch */
  }
}

async function startBackgroundUpdates(minDisplacement: number): Promise<boolean> {
  if (!taskManager) return false;
  try {
    await Location.startLocationUpdatesAsync(RECORDING_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,
      distanceInterval: Math.max(1, minDisplacement),
      foregroundService: {
        notificationTitle: 'Inukshuk is recording your trail',
        notificationBody: 'Recording continues while the screen is off or you use another app.',
        // The recording cannot survive the process anyway (state is in JS), so
        // don't leave an orphaned service behind if the app is swiped away.
        killServiceOnDestroy: true,
      },
    });
    return true;
  } catch {
    // Old binary (no FOREGROUND_SERVICE_LOCATION / native task module) or a
    // denied permission: silently keep the foreground-only watch.
    return false;
  }
}

async function stopBackgroundUpdates(): Promise<void> {
  if (!taskManager) return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RECORDING_TASK)) {
      await Location.stopLocationUpdatesAsync(RECORDING_TASK);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Runs the foreground-service location task for the lifetime of an active
 * recording: started on 'recording', stopped on pause/stop/unmount. Mount this
 * once (the recording session hook owns it).
 */
export function useBackgroundRecording(): void {
  const status = useRecorderStore((s) => s.status);
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);

  useEffect(() => {
    if (status !== 'recording') return;
    let cancelled = false;
    void startBackgroundUpdates(minDisplacement).then((started) => {
      if (!started) return;
      if (cancelled) {
        // Recording ended before the service finished starting — tear it down.
        void stopBackgroundUpdates();
        return;
      }
      bgServiceActive = true;
    });
    return () => {
      cancelled = true;
      bgServiceActive = false;
      void stopBackgroundUpdates();
    };
  }, [status, minDisplacement]);

  // A previous crash can leave the OS-side task registered. If we mount with
  // no live recording, clear it so it doesn't feed a dead session.
  useEffect(() => {
    if (useRecorderStore.getState().status === 'idle') void stopBackgroundUpdates();
  }, []);
}

/**
 * Requests foreground location permission and watches the device position.
 * A single watch drives the on-screen marker and (when the recorder is active
 * and the background service is NOT running) the recorded trail — the recorder
 * store ignores points unless its status is 'recording', so feeding it
 * unconditionally is safe. When the foreground service is active it is the
 * sole feeder; the watch only updates the marker.
 */
export function useLocationTracking(): LocationTracking {
  const [location, setLocation] = useState<LatLng | null>(null);
  const [lastFix, setLastFix] = useState<TrackPoint | null>(null);
  const [permission, setPermission] = useState<LocationPermission>('undetermined');
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        setPermission('denied');
        return;
      }
      setPermission('granted');
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: Math.max(1, minDisplacement),
        },
        (loc) => {
          const fix = toTrackPoint(loc);
          setLocation({ latitude: fix.latitude, longitude: fix.longitude });
          setLastFix(fix);
          // Recorder filters by status internally. While the foreground
          // service feeds the track, the watch only drives the marker.
          if (!bgServiceActive) useRecorderStore.getState().addPoint(fix);
        },
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [minDisplacement]);

  return { location, lastFix, permission };
}
