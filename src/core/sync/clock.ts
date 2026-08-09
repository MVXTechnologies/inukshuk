/**
 * Timestamp discipline for the sync engine. LWW compares client-clock stamps
 * (epoch ms), so two properties matter and are enforced here:
 *
 * 1. **Per-item monotonicity** — a device must never stamp a change earlier
 *    than a stamp it has already seen for that item, or its own edit would
 *    lose to history when the wall clock steps backwards (NTP correction,
 *    timezone fumble, cold RTC).
 * 2. **Bounded future skew** — a device with a runaway-fast clock must not be
 *    able to stamp so far into the future that every other device's genuine
 *    edits lose forever. Far-future stamps are clamped at merge time.
 */

/**
 * How far into the future a stamp may plausibly sit before it is treated as a
 * broken clock and clamped. Generous on purpose: ordinary NTP/timezone skew is
 * minutes, so a full day only catches genuinely wrong clocks — within the
 * window, plain LWW applies unchanged.
 */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Next LWW stamp for an item: the current wall clock, bumped just past
 * `lastStamp` when the clock lags what we've already recorded (so re-edits
 * always advance). Total: junk `now` degrades to `lastStamp + 1`.
 */
export function nextStamp(now: number, lastStamp = 0): number {
  const wall = Number.isFinite(now) && now > 0 ? now : 0;
  const floor = Number.isFinite(lastStamp) && lastStamp > 0 ? lastStamp + 1 : 0;
  return Math.max(wall, floor);
}

/**
 * Clamp one stamp into the plausible window `[0, now + maxFutureMs]`.
 * Non-finite or negative stamps (persisted junk) collapse to 0, which loses
 * every LWW comparison — the safe default for garbage.
 */
export function clampStamp(stamp: number, now: number, maxFutureMs = MAX_FUTURE_SKEW_MS): number {
  if (!Number.isFinite(stamp) || stamp <= 0) return 0;
  const ceiling = (Number.isFinite(now) && now > 0 ? now : 0) + maxFutureMs;
  return Math.min(stamp, ceiling);
}
