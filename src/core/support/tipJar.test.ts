import {
  TIP_JAR_WOBBLE,
  TIP_JAR_WOBBLE_INTERVAL_MS,
  tipJarAnimates,
  tipJarVisible,
  wobbleDurationMs,
} from './tipJar';

describe('tip jar wobble', () => {
  it('runs every 15 s and lasts under a second', () => {
    expect(TIP_JAR_WOBBLE_INTERVAL_MS).toBe(15_000);
    expect(wobbleDurationMs()).toBeLessThan(1000);
    expect(wobbleDurationMs([])).toBe(0);
  });

  it('stays gentle (at most 3°) and comes back to rest', () => {
    for (const step of TIP_JAR_WOBBLE) expect(Math.abs(step.deg)).toBeLessThanOrEqual(3);
    expect(TIP_JAR_WOBBLE[TIP_JAR_WOBBLE.length - 1]?.deg).toBe(0);
  });

  it('never animates with reduced motion or after a tip', () => {
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: false })).toBe(true);
    expect(tipJarAnimates({ reduceMotion: true, hasTipped: false })).toBe(false);
    expect(tipJarAnimates({ reduceMotion: false, hasTipped: true })).toBe(false);
  });
});

describe('tipJarVisible', () => {
  const base = { enabled: true, recording: false, navigating: false, blocked: false };

  it('shows by default', () => {
    expect(tipJarVisible(base)).toBe(true);
  });

  it.each([
    ['switched off', { enabled: false }],
    ['recording', { recording: true }],
    ['following a destination', { navigating: true }],
    ['the corner is taken', { blocked: true }],
  ])('hides when %s', (_label, patch) => {
    expect(tipJarVisible({ ...base, ...patch })).toBe(false);
  });
});
