/**
 * When is location "lost" while the position watch is still subscribed? (#324)
 *
 * The map used to learn about a loss only from `watchPositionAsync`
 * REJECTING. In practice a live watch rarely rejects:
 *
 * - switching device location off (or losing the sky) leaves the watch
 *   subscribed and simply silent, so the next fix bridged the gap;
 * - on Play-services phones a rejection only comes out of the "turn on
 *   device location" dialog, and the AppState churn that dialog causes
 *   superseded the watch, so its rejection was dropped.
 *
 * Silence alone is not a loss: the watch has a distance filter, so a hiker
 * standing at a viewpoint gets no fixes either. A silent watch is therefore
 * only a reason to ASK — first whether device location is on at all (cheap),
 * then, while recording, for one fresh fix. This module is that policy, pure;
 * `useLocationTracking` performs the probes.
 */

/** What is wrong with location, as the map banner and the auto-pause see it. */
export type LocationLossKind =
  /** Device location (location services) is switched off. */
  | 'off'
  /** Location is on, but no fix could be obtained (tunnel, dense canopy, indoors). */
  | 'no-signal'
  /** The OS refused to start the watch for another reason. */
  | 'error';

/** No fix (and no proof of life) for this long makes the watch suspect. */
export const FIX_STALE_MS = 20_000;
/** How often a suspect watch is re-checked. */
export const WATCHDOG_TICK_MS = 5_000;
/** How long the one-fix signal probe may take before it counts as "no signal". */
export const SIGNAL_PROBE_TIMEOUT_MS = 15_000;

/** True when the watch has been live but silent for `staleMs` or longer. */
export function isWatchSilent(
  lastAliveAt: number | null,
  now: number,
  staleMs: number = FIX_STALE_MS,
): boolean {
  return lastAliveAt !== null && now - lastAliveAt >= staleMs;
}

/**
 * Must the (more expensive) one-fix signal probe run? Only while recording —
 * that is where a dropout matters — or to clear a standing `no-signal` once
 * the sky is back, so a paused recording is not re-paused on resume.
 */
export function needsSignalProbe(recording: boolean, current: LocationLossKind | null): boolean {
  return recording || current === 'no-signal';
}

export interface LocationProbe {
  /** Device location switched on (`getProviderStatusAsync().locationServicesEnabled`). */
  servicesEnabled: boolean;
  /**
   * Result of the one-fix probe: `true` a fresh fix came back, `false` none
   * within {@link SIGNAL_PROBE_TIMEOUT_MS}, `null` it was not run.
   */
  freshFix: boolean | null;
}

/** The loss a probe proves, or null when location is fine. */
export function classifyLocationProbe(probe: LocationProbe): LocationLossKind | null {
  if (!probe.servicesEnabled) return 'off';
  if (probe.freshFix === false) return 'no-signal';
  return null;
}

/** Is a fix stamped `fixTime` fresh enough to prove the signal at `now`? */
export function isFreshFix(fixTime: number, now: number, staleMs: number = FIX_STALE_MS): boolean {
  return Number.isFinite(fixTime) && now - fixTime < staleMs;
}

/** True for expo-location's "Location request failed due to unsatisfied device settings". */
export function isDeviceSettingsRejection(err: unknown): boolean {
  return err instanceof Error && /device settings/i.test(err.message);
}

/** The map banner's text for a loss. */
export function locationLossMessage(kind: LocationLossKind): string {
  switch (kind) {
    case 'off':
      return 'Location is turned off — switch it on to see your position.';
    case 'no-signal':
      return 'No GPS signal — waiting for a fix.';
    case 'error':
      return "Couldn't start location updates.";
  }
}

/** The snackbar shown when a sustained loss auto-pauses the recording. */
export function autoPauseMessage(kind: LocationLossKind | 'denied'): string {
  return kind === 'no-signal'
    ? 'No GPS signal — recording paused. Resume when you have a signal again.'
    : 'Location lost — recording paused. Re-enable location to continue.';
}
