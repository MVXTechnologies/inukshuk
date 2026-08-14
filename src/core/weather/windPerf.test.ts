import {
  DEGRADE_FPS,
  DEFAULT_PARTICLES,
  FRAME_INTERVAL_STEPS,
  RESOLUTION_STEPS,
  emaUpdate,
  fadeStep,
  FRAME_CAP_FPS,
  FRAME_INTERVAL_MS,
  initialPerfState,
  MIN_PARTICLES,
  PARTICLE_SHED_FACTOR,
  PERF_WINDOW_FRAMES,
  perfStep,
  RESTORE_FPS,
  TARGET_PARTICLES,
  type WindPerfState,
} from './windPerf';

function run(state: WindPerfState, frameMs: number, frames: number): WindPerfState {
  let s = state;
  for (let i = 0; i < frames; i++) s = perfStep(s, frameMs);
  return s;
}

describe('emaUpdate', () => {
  it('seeds on the first sample and smooths afterwards', () => {
    expect(emaUpdate(null, 33)).toBe(33);
    const next = emaUpdate(33, 66);
    expect(next).toBeGreaterThan(33);
    expect(next).toBeLessThan(66);
  });
});

describe('perfStep ladder', () => {
  it('holds the target count while fps stays healthy', () => {
    const s = run(initialPerfState(), 33, 200); // ~30 fps
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
    expect(s.resolutionScale).toBe(1);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_MS);
  });

  it('sheds 25% after a sustained slow window', () => {
    const s = run(initialPerfState(), 50, PERF_WINDOW_FRAMES + 5); // 20 fps
    expect(s.particleCount).toBe(Math.round(DEFAULT_PARTICLES * PARTICLE_SHED_FACTOR));
    expect(s.resolutionScale).toBe(1);
  });

  it('waits out the hysteresis window before acting', () => {
    const s = run(initialPerfState(), 50, PERF_WINDOW_FRAMES - 1);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  it('degrades particles, then resolution, then cadence — in that order', () => {
    let s = initialPerfState();
    // One 25%-shed rung per window until the floor; derive the count from the
    // constants so retuning DEFAULT_PARTICLES can't silently break this.
    const rungs = Math.ceil(
      Math.log(MIN_PARTICLES / DEFAULT_PARTICLES) / Math.log(PARTICLE_SHED_FACTOR),
    );
    s = run(s, 60, PERF_WINDOW_FRAMES * rungs + 2);
    expect(s.particleCount).toBe(MIN_PARTICLES);
    expect(s.resolutionScale).toBe(1);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_MS);
    // Only once particles bottom out does resolution give way...
    s = run(s, 60, PERF_WINDOW_FRAMES);
    expect(s.resolutionScale).toBe(RESOLUTION_STEPS[1]);
    s = run(s, 60, PERF_WINDOW_FRAMES);
    expect(s.resolutionScale).toBe(RESOLUTION_STEPS[2]);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_MS);
    // ...and only then the frame rate.
    s = run(s, 60, PERF_WINDOW_FRAMES);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_STEPS[1]);
  });

  it('never stops animating, however hopeless the frame rate', () => {
    // The shipped ladder ended in a sticky "static" mode that froze the
    // overlay for the rest of the session — indistinguishable, to the user,
    // from the feature being broken. The bottom rung must still animate.
    const s = run(initialPerfState(), 500, 5000);
    expect(s.particleCount).toBe(MIN_PARTICLES);
    expect(s.resolutionScale).toBe(RESOLUTION_STEPS[RESOLUTION_STEPS.length - 1]);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_STEPS[FRAME_INTERVAL_STEPS.length - 1]);
    expect(Number.isFinite(s.frameIntervalMs)).toBe(true);
  });

  it('climbs all the way back after a stall, cadence first', () => {
    let s = run(initialPerfState(), 500, 5000); // bottom of the ladder
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_STEPS[2]);
    s = run(s, FRAME_INTERVAL_MS, PERF_WINDOW_FRAMES + 5);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_STEPS[1]);
    s = run(s, FRAME_INTERVAL_MS, 4000);
    expect(s.frameIntervalMs).toBe(FRAME_INTERVAL_MS);
    expect(s.resolutionScale).toBe(1);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  it('climbs back toward the target when fps recovers before the floor', () => {
    let s = run(initialPerfState(), 60, PERF_WINDOW_FRAMES + 5);
    const reduced = s.particleCount;
    expect(reduced).toBeLessThan(DEFAULT_PARTICLES);
    // Recovery has to be provable at a rate the CAPPED loop can actually
    // produce — see the FRAME_CAP_FPS invariants below.
    s = run(s, FRAME_INTERVAL_MS, 400);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  it('never exceeds the target when climbing back', () => {
    const s = run(initialPerfState(), 10, 1000);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  // --- Ladder thresholds vs the loop's own frame cap (the M3 regression) ---

  it('can reach the restore threshold under the frame cap', () => {
    // RESTORE_FPS above the cap makes the ladder a one-way ratchet into the
    // sticky static mode: it degrades on jitter and can never climb back.
    expect(RESTORE_FPS).toBeLessThan(FRAME_CAP_FPS);
    expect(DEGRADE_FPS).toBeLessThan(RESTORE_FPS);
  });

  it('leaves real headroom between the cap and the degrade gate', () => {
    // A loop pinned at its cap must not sit within noise of degrading.
    expect(FRAME_CAP_FPS - DEGRADE_FPS).toBeGreaterThan(5);
  });

  it('does not degrade a loop running at the cap with ordinary jitter', () => {
    // The shipped ladder degraded here: every third frame slipping a vsync
    // pulled the EMA under a 28 fps gate that sat 2 fps below the cap.
    let s = initialPerfState();
    for (let i = 0; i < 600; i++) {
      s = perfStep(s, i % 3 === 0 ? FRAME_INTERVAL_MS + 17 : FRAME_INTERVAL_MS);
    }
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  it('recovers to the target after a transient stall ends', () => {
    let s = run(initialPerfState(), 70, PERF_WINDOW_FRAMES + 5);
    expect(s.particleCount).toBeLessThan(DEFAULT_PARTICLES);
    s = run(s, FRAME_INTERVAL_MS, 1000);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });
});

describe('perf gate vs visual density', () => {
  it('never seeds above the count the perf gate was measured at', () => {
    // TARGET_PARTICLES is the §2.5 acceptance criterion (≥ 28 fps @ 2,000 on
    // the Android target), NOT a look knob. Seeding above it would ship a
    // load nobody measured; seeding below is a visual choice and safe.
    expect(DEFAULT_PARTICLES).toBeLessThanOrEqual(TARGET_PARTICLES);
    expect(DEFAULT_PARTICLES).toBeGreaterThan(MIN_PARTICLES);
  });

  it('recovery stops at the seeded density, not at the gate', () => {
    // Regression: while recovery clamped to TARGET_PARTICLES, a state seeded
    // below the gate read as "degraded" from frame one, so a healthy device
    // silently re-densified the overlay back to the gate within a couple of
    // windows — undoing the visual tuning everywhere it mattered.
    const s = run(initialPerfState(), FRAME_INTERVAL_MS, PERF_WINDOW_FRAMES * 6);
    expect(s.particleCount).toBe(DEFAULT_PARTICLES);
  });

  it('honours an explicit seed as the recovery ceiling', () => {
    let s = run(initialPerfState(900), 60, PERF_WINDOW_FRAMES + 5);
    expect(s.particleCount).toBeLessThan(900);
    s = run(s, FRAME_INTERVAL_MS, 1000);
    expect(s.particleCount).toBe(900);
  });
});

describe('fadeStep', () => {
  it('reaches the target in ~OVERLAY_FADE_MS worth of frames', () => {
    let o = 1;
    for (let i = 0; i < 10; i++) o = fadeStep(o, 0, 16, 150);
    expect(o).toBeCloseTo(0, 1);
  });

  it('clamps at the target without overshoot in both directions', () => {
    expect(fadeStep(0.05, 0, 100, 150)).toBe(0);
    expect(fadeStep(0.95, 1, 100, 150)).toBe(1);
  });

  it('is a no-op at the target', () => {
    expect(fadeStep(1, 1, 16)).toBe(1);
    expect(fadeStep(0, 0, 16)).toBe(0);
  });
});
