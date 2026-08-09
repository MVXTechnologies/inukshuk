/**
 * Self-throttling for the wind particle overlay (weather M3 perf gates):
 * the render loop feeds executed-frame times into a pure ladder that first
 * sheds particles in 25% steps and, only at the floor, flips to a static
 * streak render. All decisions are pure so Jest can pin the ladder; the GL
 * component just applies the returned state.
 *
 * Gate numbers come from the design doc (§2.5): sustain ≥ 28 fps at 2,000
 * particles on the Android target; recovery after a gesture ≤ 400 ms.
 */

/** Design-doc target particle count (Android gate). */
export const TARGET_PARTICLES = 2000;
/** Floor before giving up on animation entirely. */
export const MIN_PARTICLES = 500;
/** Below this sustained fps the ladder degrades. */
export const DEGRADE_FPS = 28;
/** Above this sustained fps a previously-degraded ladder climbs back. */
export const RESTORE_FPS = 45;
/** Frames a change must "settle" before the ladder re-evaluates. */
export const PERF_WINDOW_FRAMES = 45;
/** Render-loop frame cap (~30 fps — the Windy mobile cadence). */
export const FRAME_INTERVAL_MS = 33;
/** Gesture settle: re-seed + fade back in this long after the last move. */
export const GESTURE_SETTLE_MS = 400;
/** Overlay fade duration for gesture/pitch transitions. */
export const OVERLAY_FADE_MS = 150;

/** Exponential moving average over frame times (ms). */
export function emaUpdate(prev: number | null, sampleMs: number, alpha = 0.15): number {
  if (prev === null) return sampleMs;
  return prev + alpha * (sampleMs - prev);
}

export interface WindPerfState {
  /** Particles the renderer should currently run. */
  particleCount: number;
  /** True once even MIN_PARTICLES can't hold the fps gate: render static streaks. */
  staticMode: boolean;
  /** Frame-time EMA, ms (null until the first frame). */
  emaFrameMs: number | null;
  /** Frames since the last ladder change (hysteresis window). */
  framesSinceChange: number;
}

export function initialPerfState(target = TARGET_PARTICLES): WindPerfState {
  return { particleCount: target, staticMode: false, emaFrameMs: null, framesSinceChange: 0 };
}

/**
 * Advance the ladder by one executed frame. Degrades 25% per window while
 * the EMA fps sits under DEGRADE_FPS, flips to staticMode at the floor, and
 * climbs back (never past TARGET) when fps recovers. staticMode is sticky —
 * only a reset (new field / layer toggle) re-arms animation.
 */
export function perfStep(state: WindPerfState, frameMs: number): WindPerfState {
  const emaFrameMs = emaUpdate(state.emaFrameMs, frameMs);
  const framesSinceChange = state.framesSinceChange + 1;
  const next: WindPerfState = { ...state, emaFrameMs, framesSinceChange };
  if (state.staticMode || framesSinceChange < PERF_WINDOW_FRAMES) return next;
  const fps = 1000 / emaFrameMs;
  if (fps < DEGRADE_FPS) {
    if (state.particleCount > MIN_PARTICLES) {
      return {
        ...next,
        particleCount: Math.max(MIN_PARTICLES, Math.round(state.particleCount * 0.75)),
        framesSinceChange: 0,
      };
    }
    return { ...next, staticMode: true, framesSinceChange: 0 };
  }
  if (fps > RESTORE_FPS && state.particleCount < TARGET_PARTICLES) {
    return {
      ...next,
      particleCount: Math.min(TARGET_PARTICLES, Math.round(state.particleCount / 0.75)),
      framesSinceChange: 0,
    };
  }
  return next;
}

/**
 * Linear opacity fade toward a target, dt-scaled so the fade takes
 * OVERLAY_FADE_MS regardless of frame rate. Pure; clamped to [0, 1].
 */
export function fadeStep(
  current: number,
  target: number,
  dtMs: number,
  fadeMs = OVERLAY_FADE_MS,
): number {
  const step = dtMs / Math.max(fadeMs, 1);
  const next = current + Math.sign(target - current) * step;
  if (target > current) return Math.min(target, Math.max(0, next));
  return Math.max(target, Math.min(1, next));
}
