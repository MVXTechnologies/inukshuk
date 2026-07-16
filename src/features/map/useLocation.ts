import type { LatLng, TrackPoint } from '@core/models';
import { isBackgroundLocationActive, toTrackPoint } from '@lib/backgroundLocation';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export type LocationPermission = 'undetermined' | 'granted' | 'denied';

export interface LocationTracking {
  location: LatLng | null;
  /** Latest full fix, including altitude/accuracy. */
  lastFix: TrackPoint | null;
  permission: LocationPermission;
  /**
   * Set when the OS refused to start the position watch even though permission
   * was granted — in practice "device location is switched off" (expo-location
   * rejects with "unsatisfied device settings"). null while the watch is fine.
   */
  unavailableReason: string | null;
}

/**
 * Requests foreground location permission and watches the device position for
 * the live on-screen marker. While no background task is running it also feeds
 * the recorder (the store ignores points unless its status is 'recording', so
 * feeding it unconditionally is safe); once the background task is active —
 * see `@lib/backgroundLocation`, started by `useBackgroundRecording` — the
 * task is the sole recorder feeder and this watch only drives the marker.
 */
export function useLocationTracking(): LocationTracking {
  const [location, setLocation] = useState<LatLng | null>(null);
  const [lastFix, setLastFix] = useState<TrackPoint | null>(null);
  const [permission, setPermission] = useState<LocationPermission>('undetermined');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);
  // Bumped on every foreground so permission + device-location availability are
  // re-checked and the position watch is re-established. #90: permission or
  // device location revoked mid-recording used to go undetected — the watch
  // stopped delivering with no error, so the recorder kept 'recording' while no
  // points accrued. Re-establishing on foreground makes that a granted→denied
  // (or device-off) transition the map can surface and the recorder can pause.
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setRecheck((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    let cancelled = false;

    (async () => {
      // The whole watch setup is guarded: with permission granted but device
      // location switched off, watchPositionAsync REJECTS ("Location request
      // failed due to unsatisfied device settings"). Unguarded, that became an
      // unhandled rejection at every launch — invisible before the error
      // reporter existed, and afterwards it queued a report on each launch.
      // Surface it as state the map can show instead.
      try {
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
            setUnavailableReason(null);
            setLocation({ latitude: fix.latitude, longitude: fix.longitude });
            setLastFix(fix);
            // Recorder filters by status internally. While the background task
            // feeds the track, the watch only drives the marker.
            if (!isBackgroundLocationActive()) useRecorderStore.getState().addPoint(fix);
          },
        );
        if (cancelled) sub.remove();
      } catch (err) {
        if (cancelled) return;
        setUnavailableReason(
          err instanceof Error && /device settings/i.test(err.message)
            ? 'Location is turned off — switch it on to see your position.'
            : "Couldn't start location updates.",
        );
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [minDisplacement, recheck]);

  return { location, lastFix, permission, unavailableReason };
}
