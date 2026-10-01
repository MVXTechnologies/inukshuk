/**
 * "Is the person moving the map?" for the tip mug (#476), robust to the
 * native map's event quirks.
 *
 * The map reports a camera move as `regionWillChange` (with a
 * `userInteraction` flag) then `regionDidChange`. Two traps, both seen in the
 * MapLibre iOS source (MLRNMapView.m):
 *
 * - `userInteraction` is `reason & ~Programmatic`, so a TAP that cancels an
 *   in-flight camera animation (follow-my-location animates on every fix)
 *   reads as a user move;
 * - `regionDidChange` is dropped when the reason is "transition cancelled"
 *   without a pan — so that tap's "will" never gets its "did".
 *
 * Trusting the pair left the mug paused for good after one tap. Here:
 * - only a user move pauses; programmatic moves never do;
 * - a settled camera, or a tap (the map's `onPress`), ends the pause at once;
 * - and whatever the map forgets to send, the pause clears itself after
 *   {@link GESTURE_PAUSE_MAX_MS} with no further move events.
 *
 * Pure: plain timers, no React Native.
 */

/** A pause with no further move events clears itself after this long. */
export const GESTURE_PAUSE_MAX_MS = 3_000;

export interface GesturePause {
  /** `regionWillChange`: pauses only for the person's own move. */
  willChange(userInteraction: boolean): void;
  /** `regionIsChanging` (when wired): the move goes on; keeps the pause alive. */
  isChanging(): void;
  /** `regionDidChange`: the camera settled. */
  didChange(): void;
  /** The map's `onPress` / `onLongPress`: a tap is not a pan or a zoom. */
  tap(): void;
  isPaused(): boolean;
  dispose(): void;
}

export function createGesturePause(
  onChange: (paused: boolean) => void,
  maxMs: number = GESTURE_PAUSE_MAX_MS,
): GesturePause {
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    if (next === paused) return;
    paused = next;
    onChange(next);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    stopTimer();
    timer = setTimeout(() => {
      timer = null;
      set(false);
    }, maxMs);
  };
  const end = () => {
    stopTimer();
    set(false);
  };

  return {
    willChange(userInteraction) {
      if (!userInteraction) return;
      set(true);
      arm();
    },
    isChanging() {
      if (paused) arm();
    },
    didChange: end,
    tap: end,
    isPaused: () => paused,
    dispose: stopTimer,
  };
}
