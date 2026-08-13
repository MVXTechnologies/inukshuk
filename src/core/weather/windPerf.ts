/**
 * Self-throttling for the wind particle overlay (weather M3 perf gates): the
 * render loop feeds executed-frame times into a pure ladder that sheds
 * particles, then render resolution, then frame rate. All decisions are pure
 * so Jest can pin the ladder; the GL component just applies the state.
 *
 * Gate numbers come from the design doc (§2.5): sustain ≥ 28 fps at 2,000
 * particles on the Android target; recovery after a gesture ≤ 400 ms. The
 * thresholds below are stated against FRAME_CAP_FPS rather than as absolute
 * fps, because the loop throttles itself and can never measure faster.
 *
 * Note the split between TARGET_PARTICLES (the gate — what the device must
 * sustain) and DEFAULT_PARTICLES (what we choose to draw). Visual-density
 * complaints move the latter; the gate only moves when the perf contract
 * itself changes.
 */

/**
 * Design-doc target particle count — a PERFORMANCE GATE, not a visual knob.
 * It states what the Android target must be able to sustain (§2.5: ≥ 28 fps
 * at 2,000 particles), so it must never be lowered to make the overlay look
 * lighter: that would silently relax the acceptance criterion instead of
 * changing the design. Draw fewer by moving DEFAULT_PARTICLES.
 */
export const TARGET_PARTICLES = 2000;
/**
 * Particles the overlay actually SEEDS with — the visual density knob. The
 * gate above proves the device could sustain more; we deliberately draw
 * fewer so the map reads through the flow (owner, 2026-08-10). Keep it at or
 * below TARGET_PARTICLES: the ladder treats the seed as its ceiling, so a
 * value above the gate would let the overlay climb past what was measured.
 */
export const DEFAULT_PARTICLES = 1700;
/** Floor before giving up on animation entirely. */
export const MIN_PARTICLES = 500;
/** Fraction of the particle count each degrade rung keeps (25% shed). */
export const PARTICLE_SHED_FACTOR = 0.75;
/** Render-loop frame cap (~30 fps — the Windy mobile cadence). */
export const FRAME_INTERVAL_MS = 33;
/**
 * The fps the loop can reach AT BEST: it sleeps to FRAME_INTERVAL_MS, so no
 * measurement can ever exceed this. Every ladder threshold must be read
 * against this ceiling, not against an imagined 60 fps.
 */
export const FRAME_CAP_FPS = 1000 / FRAME_INTERVAL_MS;
/**
 * Below this sustained fps the ladder degrades. It must sit well UNDER the
 * cap: the loop's own throttle already pins the measured rate at ~30 fps, so
 * a threshold just below the cap (the shipped 28) fires on ordinary jitter —
 * one slipped vsync is a 50 ms sample (20 fps) and drags the EMA under. The
 * M3 overlay ratcheted itself down to the particle floor and then into the
 * sticky static mode within seconds on a busy device, which reads to the
 * user as "the wind never animates". 22 fps ≈ 45 ms means three vsyncs per
 * frame — a real stall, not noise.
 */
export const DEGRADE_FPS = 22;
/**
 * Above this sustained fps a previously-degraded ladder climbs back. MUST be
 * below FRAME_CAP_FPS or recovery is unreachable and the ladder becomes a
 * one-way ratchet to static mode (the shipped value was 45 — impossible
 * under a 33 ms cap, so nothing ever climbed back).
 */
export const RESTORE_FPS = 27;
/** Frames a change must "settle" before the ladder re-evaluates. */
export const PERF_WINDOW_FRAMES = 45;
/** Gesture settle: re-seed + fade back in this long after the last move. */
export const GESTURE_SETTLE_MS = 400;
/** Overlay fade duration for gesture/pitch transitions. */
export const OVERLAY_FADE_MS = 150;

/** Exponential moving average over frame times (ms). */
export function emaUpdate(prev: number | null, sampleMs: number, alpha = 0.15): number {
  if (prev === null) return sampleMs;
  return prev + alpha * (sampleMs - prev);
}

/**
 * Render scales for the trail buffers, worst last. Shedding particles barely
 * moves the needle when the cost is the three FULLSCREEN passes per frame
 * (fade, composite, advect) — measured on the iOS simulator, the frame time
 * held at ~90 ms while the ladder cut 2000 particles to 500. Halving the
 * buffer is a 4x cut in that fill cost, so it is the lever that pays.
 */
export const RESOLUTION_STEPS = [1, 0.7, 0.5] as const;
/**
 * Frame intervals, worst last (30 / 20 / 15 fps). The slowest step still
 * ANIMATES: a frozen overlay is indistinguishable from a broken feature, so
 * the ladder slows down instead of ever giving up.
 */
export const FRAME_INTERVAL_STEPS = [FRAME_INTERVAL_MS, 50, 66] as const;

export interface WindPerfState {
  /** Particles the renderer should currently run. */
  particleCount: number;
  /**
   * Ceiling for recovery — the count this state was seeded with. Recovery
   * climbs back to here, NOT to TARGET_PARTICLES: seeding below the gate is
   * a deliberate visual choice, and without this the ladder would read the
   * gap as "degraded" and re-densify the overlay within a window or two.
   */
  maxParticles: number;
  /** Trail-buffer scale relative to the drawing buffer (1 = full res). */
  resolutionScale: number;
  /** Frame interval the loop should target, ms. */
  frameIntervalMs: number;
  /** Frame-time EMA, ms (null until the first frame). */
  emaFrameMs: number | null;
  /** Frames since the last ladder change (hysteresis window). */
  framesSinceChange: number;
}

export function initialPerfState(target = DEFAULT_PARTICLES): WindPerfState {
  return {
    particleCount: target,
    maxParticles: target,
    resolutionScale: 1,
    frameIntervalMs: FRAME_INTERVAL_MS,
    emaFrameMs: null,
    framesSinceChange: 0,
  };
}

/** How degraded the state is, 0 (pristine) upward — used to order the ladder. */
function stepIndex(steps: readonly number[], value: number): number {
  const i = steps.indexOf(value);
  return i === -1 ? 0 : i;
}

/**
 * Advance the ladder by one executed frame.
 *
 * Degrading order (each step waits out PERF_WINDOW_FRAMES): particles first
 * (cheap and invisible at the top end), then RESOLUTION, then CADENCE. It
 * never stops animating — the M3 design's "static streak" endgame froze the
 * overlay permanently and read to users as a dead feature, which is the
 * behaviour this ladder exists to avoid, not to cause. Recovery walks the
 * same rungs back up in reverse, so a transient stall costs a few seconds of
 * softer rendering rather than the rest of the session.
 */
export function perfStep(state: WindPerfState, frameMs: number): WindPerfState {
  const emaFrameMs = emaUpdate(state.emaFrameMs, frameMs);
  const framesSinceChange = state.framesSinceChange + 1;
  const next: WindPerfState = { ...state, emaFrameMs, framesSinceChange };
  if (framesSinceChange < PERF_WINDOW_FRAMES) return next;
  const fps = 1000 / emaFrameMs;
  const resIdx = stepIndex(RESOLUTION_STEPS, state.resolutionScale);
  const capIdx = stepIndex(FRAME_INTERVAL_STEPS, state.frameIntervalMs);

  if (fps < DEGRADE_FPS) {
    if (state.particleCount > MIN_PARTICLES) {
      return {
        ...next,
        particleCount: Math.max(
          MIN_PARTICLES,
          Math.round(state.particleCount * PARTICLE_SHED_FACTOR),
        ),
        framesSinceChange: 0,
      };
    }
    if (resIdx < RESOLUTION_STEPS.length - 1) {
      return {
        ...next,
        resolutionScale: RESOLUTION_STEPS[resIdx + 1] ?? state.resolutionScale,
        framesSinceChange: 0,
      };
    }
    if (capIdx < FRAME_INTERVAL_STEPS.length - 1) {
      return {
        ...next,
        frameIntervalMs: FRAME_INTERVAL_STEPS[capIdx + 1] ?? state.frameIntervalMs,
        framesSinceChange: 0,
      };
    }
    return next; // bottom rung: slow, low-res, but still moving
  }

  // Recovery, most-degraded rung first.
  if (fps > RESTORE_FPS) {
    if (capIdx > 0) {
      return {
        ...next,
        frameIntervalMs: FRAME_INTERVAL_STEPS[capIdx - 1] ?? state.frameIntervalMs,
        framesSinceChange: 0,
      };
    }
    if (resIdx > 0) {
      return {
        ...next,
        resolutionScale: RESOLUTION_STEPS[resIdx - 1] ?? state.resolutionScale,
        framesSinceChange: 0,
      };
    }
    if (state.particleCount < state.maxParticles) {
      return {
        ...next,
        particleCount: Math.min(
          state.maxParticles,
          Math.round(state.particleCount / PARTICLE_SHED_FACTOR),
        ),
        framesSinceChange: 0,
      };
    }
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
