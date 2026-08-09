import {
  DEGRADE_FPS,
  emaUpdate,
  fadeStep,
  initialPerfState,
  MIN_PARTICLES,
  PERF_WINDOW_FRAMES,
  perfStep,
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
    expect(s.particleCount).toBe(TARGET_PARTICLES);
    expect(s.staticMode).toBe(false);
  });

  it('sheds 25% after a sustained slow window', () => {
    const s = run(initialPerfState(), 50, PERF_WINDOW_FRAMES + 5); // 20 fps
    expect(s.particleCount).toBe(Math.round(TARGET_PARTICLES * 0.75));
    expect(s.staticMode).toBe(false);
  });

  it('waits out the hysteresis window before acting', () => {
    const s = run(initialPerfState(), 50, PERF_WINDOW_FRAMES - 1);
    expect(s.particleCount).toBe(TARGET_PARTICLES);
  });

  it('degrades stepwise to the floor, then flips to static mode', () => {
    let s = initialPerfState();
    s = run(s, 60, 1000); // hopeless fps — walk the whole ladder
    expect(s.particleCount).toBe(MIN_PARTICLES);
    expect(s.staticMode).toBe(true);
  });

  it('static mode is sticky (no oscillation once given up)', () => {
    let s = run(initialPerfState(), 60, 1000);
    expect(s.staticMode).toBe(true);
    s = run(s, 10, 200); // fps recovers — too late by design
    expect(s.staticMode).toBe(true);
    expect(s.particleCount).toBe(MIN_PARTICLES);
  });

  it('climbs back toward the target when fps recovers before the floor', () => {
    let s = run(initialPerfState(), 50, PERF_WINDOW_FRAMES + 5);
    const reduced = s.particleCount;
    expect(reduced).toBeLessThan(TARGET_PARTICLES);
    s = run(s, 15, 400); // ~66 fps
    expect(s.particleCount).toBe(TARGET_PARTICLES);
    expect(s.staticMode).toBe(false);
  });

  it('never exceeds the target when climbing back', () => {
    const s = run(initialPerfState(), 10, 1000);
    expect(s.particleCount).toBe(TARGET_PARTICLES);
  });

  it('the degrade threshold matches the design-doc gate', () => {
    expect(DEGRADE_FPS).toBe(28);
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
