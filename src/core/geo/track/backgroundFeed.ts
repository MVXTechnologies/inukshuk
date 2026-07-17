/**
 * Pure decision logic for the recorder's feeder handoff.
 *
 * While a recording is live, two potential feeders exist: the foreground
 * position watch and the OS-level background location task. The foreground
 * watch must keep feeding the recorder UNLESS the background task is confirmed
 * to be actually delivering fixes — "the OS accepted startLocationUpdatesAsync"
 * is NOT confirmation. On some devices (notably Samsung One UI) the start call
 * resolves but the task never fires (foreground-service deferral, battery
 * management, the service dying after start); gating the foreground feed on the
 * start call alone then leaves NOBODY feeding the recorder and the track stays
 * empty (the v1.0.2 "record doesn't track anymore" regression).
 *
 * Fail-safe direction: double-feeding is harmless — the same fix delivered by
 * both feeders is deduped by the GPS filter's near-duplicate timestamp gate and
 * the timestamp merge (`mergePoints`). Zero-feeding loses the hike. So the
 * background feed is only considered live while its deliveries are FRESH, and
 * the foreground watch resumes feeding as soon as they go stale.
 */

/**
 * How recently the background task must have delivered for the foreground
 * watch to stand down. Fixes flow every ~1 s while moving (both feeders use
 * the same timeInterval), so 10 s of silence means the task is not delivering;
 * when the user is stationary (distanceInterval gating), BOTH feeders go
 * silent, so the expiry merely re-arms the foreground feed — the next fix is
 * then delivered by both and deduped.
 */
export const BACKGROUND_FEED_FRESH_MS = 10_000;

/**
 * True while the background task's last delivery is recent enough to trust it
 * as the recorder's sole feeder.
 *
 * @param lastDeliveryAt Epoch ms of the task's last delivery to the live
 *   session, or null when it has not delivered since (re)starting.
 * @param now Current epoch ms.
 */
export function isBackgroundFeedFresh(
  lastDeliveryAt: number | null,
  now: number,
  freshMs: number = BACKGROUND_FEED_FRESH_MS,
): boolean {
  return lastDeliveryAt !== null && now - lastDeliveryAt <= freshMs;
}
