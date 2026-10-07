import { shouldPersistPosition } from '@core/geo/lastKnownPosition';
import type { LatLng, TrackPoint } from '@core/models';
import {
  SIGNAL_PROBE_TIMEOUT_MS,
  WATCHDOG_TICK_MS,
  classifyLocationProbe,
  isDeviceSettingsRejection,
  isFreshFix,
  isWatchSilent,
  locationLossMessage,
  needsSignalProbe,
  type LocationLossKind,
} from '@core/recording/locationWatchdog';
import { isBackgroundFeedConfirmed, toTrackPoint } from '@lib/backgroundLocation';
import { reportError } from '@lib/errorReporting';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type LocationPermission = 'undetermined' | 'granted' | 'denied';

/** How long to wait before retrying a failed watch start. Without a retry, a
 * transient rejection (activity mid-transition after a permission round-trip,
 * device location briefly off) left the watch dead until the next foreground —
 * and, while recording, the auto-pause saw a permanent "location lost". */
export const WATCH_RETRY_MS = 5000;

/**
 * Persist `pos` as the settings store's last known map position (the cold-start
 * camera seed — see `@core/geo/lastKnownPosition`). Before hydration the write
 * is deferred: the store would only hold it until settings.json is read (it
 * never writes DEFAULTS over the file — see settingsStore's pendingWrites),
 * and 'deferred' keeps this caller's throttle retrying instead of counting a
 * write that has not happened. An unchanged position is "accepted" without a
 * disk write. Failures count toward the caller's throttle too, so a full disk
 * cannot cause a write and an error report on every GPS fix.
 */
function persistLastKnownPosition(pos: LatLng): 'deferred' | 'saved' | 'failed' {
  const settings = useSettingsStore.getState();
  if (!settings.hydrated) return 'deferred';
  const prev = settings.lastKnownPosition;
  if (prev && prev.latitude === pos.latitude && prev.longitude === pos.longitude) return 'saved';
  try {
    settings.set('lastKnownPosition', pos);
  } catch (err) {
    // Settings publishes memory before writing. Roll back this camera seed so
    // an unchanged fix can retry after backoff instead of looking already saved.
    useSettingsStore.setState({ lastKnownPosition: prev });
    reportError(err, 'last-known-position');
    return 'failed';
  }
  return 'saved';
}

export interface LocationTracking {
  location: LatLng | null;
  /** Latest full fix, including altitude/accuracy. */
  lastFix: TrackPoint | null;
  permission: LocationPermission;
  /**
   * Why location is unavailable although permission is granted: device
   * location switched off, no GPS signal while recording, or the OS refusing
   * the watch. null while location is fine. See `@core/recording/locationWatchdog`.
   */
  unavailableKind: LocationLossKind | null;
  /** The banner text for {@link unavailableKind}; null while location is fine. */
  unavailableReason: string | null;
}

/** Resolve `promise`, or null after `ms` (the promise is left to settle on its own). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
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
  const [unavailableKind, setUnavailableKind] = useState<LocationLossKind | null>(null);
  // Mirrors `unavailableKind` for the watchdog, which runs outside render.
  const lossRef = useRef<LocationLossKind | null>(null);
  const setLoss = useCallback((kind: LocationLossKind | null) => {
    lossRef.current = kind;
    setUnavailableKind(kind);
  }, []);
  // #324 — when the watch last proved itself alive (went live, delivered a
  // fix, or a probe got a fresh fix); null while no watch is live. The
  // watchdog below probes a watch that has been silent for too long.
  const lastAliveAtRef = useRef<number | null>(null);
  const probingRef = useRef(false);
  const mountedRef = useRef(true);
  // The watchdog only judges the foreground watch while it is in front; in
  // the background the recording is fed by the background task.
  const foregroundRef = useRef(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  // The watchdog probe, reachable from the watch effect (declared below it).
  const probeRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);
  // Bumped on every foreground so permission + device-location availability are
  // re-checked and the position watch is re-established. #90: permission or
  // device location revoked mid-recording used to go undetected — the watch
  // stopped delivering with no error, so the recorder kept 'recording' while no
  // points accrued. Re-establishing on foreground makes that a granted→denied
  // (or device-off) transition the map can surface and the recorder can pause.
  const [recheck, setRecheck] = useState(0);
  // Last-known-position write throttle (cold-start camera seed). The ref holds
  // when we last attempted a write so failures also back off for one interval;
  // backgrounding flushes the freshest fix unconditionally (one write).
  const lastPositionAttemptAtRef = useRef<number | null>(null);
  const lastPositionFailureAtRef = useRef<number | null>(null);
  const locationRef = useRef<LatLng | null>(null);

  const persistPosition = useCallback((pos: LatLng) => {
    const now = Date.now();
    // A normal background flush bypasses the periodic write throttle, but a
    // failed write must also back off across iOS's inactive → background pair.
    if (!shouldPersistPosition(lastPositionFailureAtRef.current, now)) return;
    const outcome = persistLastKnownPosition(pos);
    if (outcome === 'deferred') return;
    lastPositionAttemptAtRef.current = now;
    lastPositionFailureAtRef.current = outcome === 'failed' ? now : null;
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      foregroundRef.current = state === 'active';
      if (state === 'active') setRecheck((n) => n + 1);
      // Going to background/inactive: flush the latest fix so the next cold
      // start opens the map where the user last was (not null island).
      if ((state === 'background' || state === 'inactive') && locationRef.current) {
        persistPosition(locationRef.current);
      }
    });
    return () => sub.remove();
  }, [persistPosition]);

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
        // High accuracy first, degrading on "unsatisfied device settings":
        // that rejection doesn't always mean location is off — Play services'
        // settings gate also fails it when the device can't satisfy the
        // HIGH_ACCURACY criteria (no network provider, stale/absent GMS — CI
        // emulator images, de-Googled phones). A Balanced watch still gets
        // GPS fixes there, which beats banner-and-nothing.
        //
        // Play services' "turn on device location" dialog is offered once:
        // the first watch of the first run. Neither the fallback nor a re-run
        // (each foreground, each retry) raises it again (#324): the dialog
        // churns AppState, whose `active` re-ran this effect, which raised the
        // dialog again and superseded the watch that would have reported the
        // refusal. With location off, a dialog-less watch subscribes and stays
        // silent; the watchdog below asks the device whether location is on.
        const watch = async (accuracy: Location.Accuracy, mayShowUserSettingsDialog: boolean) =>
          Location.watchPositionAsync(
            {
              accuracy,
              timeInterval: 1000,
              distanceInterval: Math.max(1, minDisplacement),
              mayShowUserSettingsDialog,
            },
            (loc) => onFix(loc),
          );
        const onFix = (loc: Location.LocationObject) => {
          const fix = toTrackPoint(loc);
          lastAliveAtRef.current = Date.now();
          setLoss(null);
          const pos = { latitude: fix.latitude, longitude: fix.longitude };
          locationRef.current = pos;
          setLocation(pos);
          setLastFix(fix);
          // Recorder filters by status internally. Only while the background
          // task is CONFIRMED delivering does the watch stand down to just
          // driving the marker — a started-but-silent task must never mute
          // the only working feeder (the v1.0.2 no-points regression).
          if (!isBackgroundFeedConfirmed()) useRecorderStore.getState().addPoint(fix);
          // Foreground last-position persistence, throttled: the first fix
          // of the session writes immediately (survives a later crash/kill),
          // then at most one write per interval while fixes keep flowing.
          const now = Date.now();
          if (shouldPersistPosition(lastPositionAttemptAtRef.current, now)) {
            persistPosition(pos);
          }
        };
        let settingsRefused = false;
        try {
          sub = await watch(Location.Accuracy.BestForNavigation, recheck === 0);
        } catch (err) {
          // A superseded rejection goes to the outer handler (see there).
          if (cancelled || !isDeviceSettingsRejection(err)) throw err;
          settingsRefused = true;
          sub = await watch(Location.Accuracy.Balanced, false);
        }
        if (cancelled) {
          sub.remove();
          return;
        }
        // The watch is live again — clear any stale failure NOW instead of on
        // the first fix. With a distance filter a stationary user may not get
        // a fix for minutes, and #116's auto-pause reads this as "location
        // still lost", instantly re-pausing every resume. Silence from here
        // on is the watchdog's to judge.
        lastAliveAtRef.current = Date.now();
        setLoss(null);
        // The dialog was refused (or could not be satisfied): say at once
        // whether that left location off, rather than after a silent spell.
        if (settingsRefused) void probeRef.current(true);
      } catch (err) {
        if (cancelled) {
          // #324: a re-run superseded this watch while it waited, typically
          // on Play services' location dialog, whose own AppState churn
          // caused the re-run. Its refusal used to be dropped here, so a
          // switched-off location was never reported. It may be stale by
          // now, so it is not trusted as is: ask the device instead.
          if (isDeviceSettingsRejection(err)) void probeRef.current(true);
          return;
        }
        lastAliveAtRef.current = null;
        setLoss(isDeviceSettingsRejection(err) ? 'off' : 'error');
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
  }, [minDisplacement, recheck, persistPosition, setLoss]);

  /**
   * #324 — the watchdog. A subscribed watch that has gone silent is probed:
   * device location off → `off`; on, but no fresh fix within the probe
   * timeout while recording → `no-signal`. A stationary user (the distance
   * filter withholds their fixes) passes the probe and is left alone. `force`
   * asks about device location even when the watch is not known to be silent
   * (a superseded watch rejection).
   */
  const probe = useCallback(
    async (force = false) => {
      if (probingRef.current || !mountedRef.current) return;
      if (!foregroundRef.current) return;
      const current = lossRef.current;
      const silent = isWatchSilent(lastAliveAtRef.current, Date.now());
      if (!force && !silent && current !== 'off') return;
      probingRef.current = true;
      try {
        const { locationServicesEnabled } = await Location.getProviderStatusAsync();
        if (!mountedRef.current) return;
        if (!locationServicesEnabled) {
          setLoss('off');
          return;
        }
        if (current === 'off') {
          // Back on: re-establish the watch; its go-live clears the loss.
          setRecheck((n) => n + 1);
          return;
        }
        const recording = useRecorderStore.getState().status === 'recording';
        if (!silent || !needsSignalProbe(recording, current)) return;
        const startedAt = Date.now();
        const loc = await withTimeout(
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
            mayShowUserSettingsDialog: false,
          }).catch(() => null),
          SIGNAL_PROBE_TIMEOUT_MS,
        );
        if (!mountedRef.current) return;
        // A fix the watch delivered meanwhile has already settled it.
        if ((lastAliveAtRef.current ?? 0) > startedAt) return;
        const freshFix = loc !== null && isFreshFix(loc.timestamp, Date.now());
        if (freshFix) lastAliveAtRef.current = Date.now();
        setLoss(classifyLocationProbe({ servicesEnabled: true, freshFix }));
      } catch {
        // A failed status query proves nothing either way.
      } finally {
        probingRef.current = false;
      }
    },
    [setLoss],
  );
  useEffect(() => {
    probeRef.current = probe;
  }, [probe]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (permission !== 'granted') return;
    const timer = setInterval(() => void probeRef.current(), WATCHDOG_TICK_MS);
    return () => clearInterval(timer);
  }, [permission]);

  const unavailableReason = unavailableKind === null ? null : locationLossMessage(unavailableKind);
  return { location, lastFix, permission, unavailableKind, unavailableReason };
}
