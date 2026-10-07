import { autoPauseMessage, type LocationLossKind } from '@core/recording/locationWatchdog';
import { useRecorderStore } from '@state/recorderStore';
import { useEffect } from 'react';

/** How long location must stay lost before the recording is auto-paused. */
export const LOCATION_LOST_PAUSE_DELAY_MS = 5000;

/**
 * #90/#116 — auto-pause the recording when location is lost mid-recording, so
 * the UI stops implying we're still tracking (the denied/unavailable Banner on
 * the map explains how to recover, and the snackbar says what happened).
 * `loss` is `'denied'` for a revoked permission, otherwise what
 * `useLocationTracking` reports (location off, no GPS signal — see #324 — or a
 * watch the OS refused), and null while location is fine.
 *
 * The pause is DEBOUNCED: a loss flips on transiently while the position watch
 * is torn down and re-established — every foreground re-check, and especially
 * the AppState churn caused by the background-permission settings round-trip
 * on record start. v1.0.2 paused instantly on any blip, which could freeze a
 * brand-new recording moments after it started (and re-pause every resume
 * until a fix happened to arrive). Only a loss sustained for
 * {@link LOCATION_LOST_PAUSE_DELAY_MS} pauses; a recovery in the meantime
 * cancels the timer. NB: feedback is a timed snackbar + Banner, never a
 * Portal/Dialog (see #108).
 */
export function useAutoPauseOnLocationLoss(
  loss: LocationLossKind | 'denied' | null,
  showSnack: (message: string) => void,
): void {
  const status = useRecorderStore((s) => s.status);
  const pause = useRecorderStore((s) => s.pause);

  useEffect(() => {
    if (loss === null || status !== 'recording') return;
    const timer = setTimeout(() => {
      pause();
      showSnack(autoPauseMessage(loss));
    }, LOCATION_LOST_PAUSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loss, status, pause, showSnack]);
}
