/**
 * The timings of a deliberate team alert (#708). Pure; every function takes
 * the clock reading, so the UI's timers and the tests share one model.
 *
 * - **SOS:** hold the button {@link SOS_HOLD_MS} (the ring fills, a tick per
 *   second), then an {@link UNDO_MS} countdown with Undo. Nothing leaves the
 *   phone until the countdown ends; letting go early, or Undo, sends nothing.
 *   The countdown starts when the finger lifts (QA 2.6.1): Undo cannot be
 *   tapped while the thumb still holds the SOS button, so a countdown running
 *   under it shortened the undo by every second held too long. A hold that
 *   never lets go starts it {@link SOS_ARMED_MAX_MS} after the 2 s mark: a
 *   resting finger never blocks a real SOS.
 * - **Rally here:** one tap starts the same countdown at my position.
 */

/** How long the SOS button is held before the countdown starts. */
export const SOS_HOLD_MS = 2_000;
/** The longest an armed SOS (held past {@link SOS_HOLD_MS}) waits for the finger to lift. */
export const SOS_ARMED_MAX_MS = 5_000;

/** How long Undo stays offered before an SOS or a rally point is sent. */
export const UNDO_MS = 5_000;

/** The longest undo window an E2E build may ask for. */
export const MAX_E2E_UNDO_MS = 60_000;

/**
 * The undo window this build uses: {@link UNDO_MS}, unless an E2E build
 * stretches it (`EXPO_PUBLIC_E2E_UNDO_MS`, set only by the E2E workflow).
 * Maestro's press-to-press time on a loaded CI emulator reached 5.4 s
 * (run 38750352646) and 6.8 s locally, so an E2E Undo raced the real 5 s
 * and sometimes lost: the flow cannot control time, so the build gives it
 * room. Never shorter than the real window; anything malformed is ignored.
 */
export function undoWindowMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return UNDO_MS;
  const ms = Number(raw);
  return ms >= UNDO_MS && ms <= MAX_E2E_UNDO_MS ? ms : UNDO_MS;
}

/** How far a hold that began at `startedAt` is, 0 → 1. */
export function holdProgress(startedAt: number, now: number, holdMs = SOS_HOLD_MS): number {
  if (holdMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / holdMs));
}

/** Whole seconds held so far (a tick per second while holding). */
export function holdTicks(startedAt: number, now: number, holdMs = SOS_HOLD_MS): number {
  return Math.floor(holdProgress(startedAt, now, holdMs) * (holdMs / 1000));
}

export interface Countdown {
  startedAt: number;
  durationMs: number;
}

export function countdown(startedAt: number, durationMs = UNDO_MS): Countdown {
  return { startedAt, durationMs };
}

/** Milliseconds left (never negative). */
export function countdownLeft(c: Countdown, now: number): number {
  return Math.max(0, c.startedAt + c.durationMs - now);
}

/** The number on the countdown ring: 5, 4, … 1 (0 once it is done). */
export function countdownSeconds(c: Countdown, now: number): number {
  return Math.ceil(countdownLeft(c, now) / 1000);
}

/** The ring's remaining fraction, 1 → 0. */
export function countdownFraction(c: Countdown, now: number): number {
  return c.durationMs <= 0 ? 0 : countdownLeft(c, now) / c.durationMs;
}

export function countdownDone(c: Countdown, now: number): boolean {
  return countdownLeft(c, now) === 0;
}
