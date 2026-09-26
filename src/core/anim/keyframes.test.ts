import { applyEase, cubicBezier, EASE, sampleTrack, type Track } from './keyframes';

describe('cubicBezier', () => {
  it('is the identity for the linear control points', () => {
    for (const x of [0.1, 0.25, 0.5, 0.9]) {
      expect(cubicBezier(0, 0, 1, 1, x)).toBeCloseTo(x, 6);
    }
  });

  it('matches CSS `ease` at known points', () => {
    // Reference values from the CSS cubic-bezier(0.25, 0.1, 0.25, 1) curve.
    expect(cubicBezier(...EASE, 0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(...EASE, 0.25)).toBeCloseTo(0.4085, 3);
  });

  it('clamps outside [0, 1] and hits both ends exactly', () => {
    expect(cubicBezier(0.55, 0, 1, 0.45, -1)).toBe(0);
    expect(cubicBezier(0.55, 0, 1, 0.45, 0)).toBe(0);
    expect(cubicBezier(0.55, 0, 1, 0.45, 1)).toBe(1);
    expect(cubicBezier(0.55, 0, 1, 0.45, 2)).toBe(1);
  });

  it('lets back-type curves overshoot, as CSS does', () => {
    const peak = Math.max(
      ...Array.from({ length: 99 }, (_, i) => cubicBezier(0.34, 1.56, 0.64, 1, (i + 1) / 100)),
    );
    expect(peak).toBeGreaterThan(1.05);
  });

  it('is monotonic in x for a gravity curve (ease-in)', () => {
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const y = cubicBezier(0.55, 0, 1, 0.45, i / 100);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('converges on steep curves where Newton alone would wander', () => {
    // x2 = 1, y2 = 0 is flat at the start and vertical at the end.
    const y = cubicBezier(1, 0, 1, 0, 0.999);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1);
  });
});

describe('applyEase', () => {
  it('handles linear and step', () => {
    expect(applyEase('linear', 0.3)).toBe(0.3);
    expect(applyEase('step', 0.99)).toBe(0);
  });
});

describe('sampleTrack', () => {
  const track: Track = [
    { t: 100, v: [0, 10], ease: 'linear' },
    { t: 200, v: [10, 10], ease: 'step' },
    { t: 300, v: [20, 0], ease: 'linear' },
  ];

  it('holds the first value before the track starts and the last after it ends', () => {
    expect(sampleTrack(track, 0, 0)).toBe(0);
    expect(sampleTrack(track, 1000, 0)).toBe(20);
    expect(sampleTrack(track, 1000, 1)).toBe(0);
  });

  it('interpolates with the easing of the keyframe it leaves', () => {
    expect(sampleTrack(track, 150, 0)).toBeCloseTo(5);
    // step: holds 10 until 300, then jumps.
    expect(sampleTrack(track, 299, 0)).toBe(10);
    expect(sampleTrack(track, 300, 0)).toBe(20);
  });

  it('samples each channel independently', () => {
    expect(sampleTrack(track, 150, 1)).toBe(10);
  });

  it('is safe on an empty track and a missing channel', () => {
    expect(sampleTrack([], 10, 0)).toBe(0);
    expect(sampleTrack(track, 150, 7)).toBe(0);
  });

  it('treats coincident keyframes as an instant change', () => {
    const jump: Track = [
      { t: 0, v: [0], ease: 'linear' },
      { t: 50, v: [1], ease: 'linear' },
      { t: 50, v: [5], ease: 'linear' },
    ];
    expect(sampleTrack(jump, 25, 0)).toBeCloseTo(0.5);
    expect(sampleTrack(jump, 50, 0)).toBe(5);
  });
});
