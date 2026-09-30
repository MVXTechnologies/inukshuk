import {
  COFFEE_CYCLE_MS,
  COFFEE_PHASES,
  DEFAULT_TIP_BUTTON_VARIANT,
  motionDurationMs,
  TIP_BUTTON_MOTION,
  TIP_BUTTON_VARIANTS,
  TIP_JAR_REST_MS,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
} from './tipJar';

describe('tip button variants', () => {
  it('offers the five mockup ideas; the owner picked the coffee mug', () => {
    expect(TIP_BUTTON_VARIANTS).toHaveLength(5);
    expect(DEFAULT_TIP_BUTTON_VARIANT).toBe('coffeeSteam');
  });

  it('runs the coffee scene: ~4 s of steam, then a heart held ~0.5 s', () => {
    expect(motionDurationMs(TIP_BUTTON_MOTION.coffeeSteam)).toBe(COFFEE_CYCLE_MS);
    expect(COFFEE_PHASES.steamEnd * COFFEE_CYCLE_MS).toBeCloseTo(4000);
    expect((COFFEE_PHASES.heartHoldEnd - COFFEE_PHASES.heartFormed) * COFFEE_CYCLE_MS).toBeCloseTo(
      500,
    );
    expect(COFFEE_PHASES.heartFormed).toBeGreaterThan(COFFEE_PHASES.steamEnd);
    expect(COFFEE_PHASES.heartHoldEnd).toBeLessThan(1);
    expect(COFFEE_PHASES.wisps).toBeGreaterThanOrEqual(2);
    // The scene fits well inside the 15 s period.
    expect(COFFEE_CYCLE_MS).toBeLessThan(TIP_JAR_WOBBLE_INTERVAL_MS);
  });

  it.each(TIP_BUTTON_VARIANTS)('%s comes back to rest', (v) => {
    const steps = TIP_BUTTON_MOTION[v];
    // The four unused ideas keep their short, under-a-second motions.
    if (v !== 'coffeeSteam') expect(motionDurationMs(steps)).toBeLessThan(1000);
    const last = steps[steps.length - 1]?.to;
    expect(last === 0 || last === 1).toBe(true);
  });

  it('keeps the rotations gentle (at most 3°)', () => {
    for (const s of TIP_BUTTON_MOTION.jarCoin) expect(Math.abs(s.to)).toBeLessThanOrEqual(3);
  });

  it('moves once every 15 s', () => {
    expect(TIP_JAR_WOBBLE_INTERVAL_MS).toBe(15_000);
  });

  it('never animates with reduced motion or after a tip', () => {
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: false })).toBe(true);
    expect(tipJarAnimates({ reduceMotion: true, hasTipped: false })).toBe(false);
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: true })).toBe(false);
  });
});

describe('tipJarVisible', () => {
  const NOW = 10 * TIP_JAR_REST_MS;
  const base = {
    enabled: true,
    recording: false,
    navigating: false,
    blocked: false,
    restingUntil: 0,
    now: NOW,
  };

  it('shows by default', () => {
    expect(tipJarVisible(base)).toBe(true);
  });

  it.each([
    ['switched off', { enabled: false }],
    ['recording', { recording: true }],
    ['following a destination', { navigating: true }],
    ['the corner is taken', { blocked: true }],
    ['resting after a tip or a verified donation', { restingUntil: NOW + 1 }],
  ])('hides when %s', (_label, patch) => {
    expect(tipJarVisible({ ...base, ...patch })).toBe(false);
  });

  it('comes back once the 12 months are over', () => {
    expect(tipJarVisible({ ...base, restingUntil: NOW })).toBe(true);
  });
});
