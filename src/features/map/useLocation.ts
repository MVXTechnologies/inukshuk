import type { LatLng, TrackPoint } from '@core/models';
import { isBackgroundLocationActive, toTrackPoint } from '@lib/backgroundLocation';
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
          // Recorder filters by status internally. While the background task
          // feeds the track, the watch only drives the marker.
          if (!isBackgroundLocationActive()) useRecorderStore.getState().addPoint(fix);
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
