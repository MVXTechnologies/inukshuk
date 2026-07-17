import { shouldPersistPosition } from '@core/geo/lastKnownPosition';
import type { LatLng, TrackPoint } from '@core/models';
import { isBackgroundFeedConfirmed, toTrackPoint } from '@lib/backgroundLocation';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type LocationPermission = 'undetermined' | 'granted' | 'denied';

/** How long to wait before retrying a failed watch start. Without a retry, a
 * transient rejection (activity mid-transition after a permission round-trip,
 * device location briefly off) left the watch dead until the next foreground —
 * and, while recording, the auto-pause saw a permanent "location lost". */
export const WATCH_RETRY_MS = 5000;

/**
 * Persist `pos` as the settings store's last known map position (the cold-start
 * camera seed — see `@core/geo/lastKnownPosition`). Returns whether the update
 * was accepted: before hydration it must be refused, because `set()` snapshots
 * the whole settings state and a pre-hydration write would clobber
 * settings.json with DEFAULTS. An unchanged position is "accepted" without a
 * disk write. Callers throttle how often this runs — never call it per-fix.
 */
function persistLastKnownPosition(pos: LatLng): boolean {
  const settings = useSettingsStore.getState();
  if (!settings.hydrated) return false;
  const prev = settings.lastKnownPosition;
  if (prev && prev.latitude === pos.latitude && prev.longitude === pos.longitude) return true;
  settings.set('lastKnownPosition', pos);
  return true;
}

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
 * the live on-screen marker. It also feeds the recorder (the store ignores
 * points unless its status is 'recording', so feeding it unconditionally is
 * safe) — UNLESS the background task (see `@lib/backgroundLocation`, started
 * by `useBackgroundRecording`) is CONFIRMED to be delivering fixes itself, in
 * which case this watch only drives the marker. Confirmation is per-delivery
 * and decays: a background task that stops delivering hands the feed straight
 * back to this watch (double points are deduped by timestamp; missing points
 * are gone forever).
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
  // Last-known-position write throttle (cold-start camera seed). The ref holds
  // when we last wrote so the foreground path writes at most once per interval;
  // backgrounding flushes the freshest fix unconditionally (one write).
  const lastPositionWriteAtRef = useRef<number | null>(null);
  const locationRef = useRef<LatLng | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setRecheck((n) => n + 1);
      // Going to background/inactive: flush the latest fix so the next cold
      // start opens the map where the user last was (not null island).
      if ((state === 'background' || state === 'inactive') && locationRef.current) {
        if (persistLastKnownPosition(locationRef.current)) {
          lastPositionWriteAtRef.current = Date.now();
        }
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    (async () => {
      // The whole watch setup is guarded: with permission granted but device
      // location switched off, watchPositionAsync REJECTS ("Location request
      // failed due to unsatisfied device settings"). Unguarded, that became an
      // unhandled rejection at every launch — invisible before the error
      // reporter existed, and afterwards it queued a report on each launch.
      // Surface it as state the map can show instead.
      try {
        // Only the FIRST run may show the system permission prompt. Re-runs
        // (every foreground, and the retry below) must passively re-CHECK:
        // request()ing on each foreground re-prompted a denied-but-askable
        // user on every app switch, and the prompt itself churns AppState —
        // prompt → background → active → recheck → prompt again.
        const { status } =
          recheck === 0
            ? await Location.requestForegroundPermissionsAsync()
            : await Location.getForegroundPermissionsAsync();
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
            const pos = { latitude: fix.latitude, longitude: fix.longitude };
            locationRef.current = pos;
            setLocation(pos);
            setLastFix(fix);
            // Foreground last-position persistence, throttled: the first fix
            // of the session writes immediately (survives a later crash/kill),
            // then at most one write per interval while fixes keep flowing.
            const now = Date.now();
            if (
              shouldPersistPosition(lastPositionWriteAtRef.current, now) &&
              persistLastKnownPosition(pos)
            ) {
              lastPositionWriteAtRef.current = now;
            }
            // Recorder filters by status internally. Only while the background
            // task is CONFIRMED delivering does the watch stand down to just
            // driving the marker — a started-but-silent task must never mute
            // the only working feeder (the v1.0.2 no-points regression).
            if (!isBackgroundFeedConfirmed()) useRecorderStore.getState().addPoint(fix);
          },
        );
        if (cancelled) {
          sub.remove();
          return;
        }
        // The watch is live again — clear any stale failure NOW instead of on
        // the first fix. With a distance filter a stationary user may not get
        // a fix for minutes, and #116's auto-pause reads this as "location
        // still lost", instantly re-pausing every resume.
        setUnavailableReason(null);
      } catch (err) {
        if (cancelled) return;
        setUnavailableReason(
          err instanceof Error && /device settings/i.test(err.message)
            ? 'Location is turned off — switch it on to see your position.'
            : "Couldn't start location updates.",
        );
        // Keep trying: device location can come back without an AppState
        // change (quick-settings toggle), and a recording that auto-paused on
        // the loss needs the watch alive again before resume can stick.
        retryTimer = setTimeout(() => setRecheck((n) => n + 1), WATCH_RETRY_MS);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sub?.remove();
    };
  }, [minDisplacement, recheck]);

  return { location, lastFix, permission, unavailableReason };
}
