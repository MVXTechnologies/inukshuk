import {
  compressedStreakSpeedMps,
  streakAlpha,
  streakLengthPx,
  STREAK_ALPHA_CEIL,
  STREAK_ALPHA_FLOOR,
  STREAK_KNEE_MPS,
  STREAK_MAX_MPS,
  TRAIL_FADE_OPACITY,
  WIND_DRAPE_OPACITY,
} from './windLook';

/** Gust boost applied to ~20% of particles (GUST_SCALE / GUST_RATIO_MAX). */
const GUST = 3;
const KMH = 1 / 3.6;

describe('streak length compression', () => {
  it('leaves calm air exactly alone — the case the owner signed off on', () => {
    // Light-theme low wind (9 km/h ≈ 2.5 m/s) is the one approved capture;
    // its base flow must not move by so much as a rounding error.
    for (const mps of [0, 0.5, 1, 2.5, 4, STREAK_KNEE_MPS]) {
      expect(compressedStreakSpeedMps(mps)).toBeCloseTo(mps, 10);
    }
  });

  it('is continuous at the knee and never decreases', () => {
    let prev = -1;
    for (let mps = 0; mps <= 60; mps += 0.1) {
      const v = compressedStreakSpeedMps(mps);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(compressedStreakSpeedMps(STREAK_KNEE_MPS + 1e-6)).toBeCloseTo(STREAK_KNEE_MPS, 5);
  });

  it('saturates so no wind speed can smear across the frame', () => {
    for (const mps of [20, 50, 100, 1000]) {
      expect(compressedStreakSpeedMps(mps)).toBeLessThanOrEqual(STREAK_MAX_MPS);
    }
    // The owner's stated worst case: a 60 km/h particle, gust-boosted.
    expect(compressedStreakSpeedMps(60 * KMH * GUST)).toBe(STREAK_MAX_MPS);
  });

  it('cuts the high-wind gust smear hardest and the base flow least', () => {
    const cut = (mps: number): number => 1 - compressedStreakSpeedMps(mps) / mps;
    // 24 km/h base flow: trimmed a little.
    expect(cut(24 * KMH)).toBeCloseTo(0.19, 2);
    // 24 km/h in a gust — the streak that dragged across the capture.
    expect(cut(24 * KMH * GUST)).toBeCloseTo(0.56, 2);
    // A gust at 24 km/h is cut far harder than the base flow at 24 km/h.
    expect(cut(24 * KMH * GUST)).toBeGreaterThan(cut(24 * KMH) * 2);
  });
});

describe('streak length in px (the budget the tuning is stated in)', () => {
  const px = (mps: number): number => streakLengthPx(compressedStreakSpeedMps(mps));

  it('keeps every streak inside the ~37 px dash budget', () => {
    for (const mps of [2.5, 7.5, 6.67, 20, 50]) {
      expect(px(mps)).toBeLessThan(38);
    }
  });

  it('pins the reference points quoted in the module doc', () => {
    expect(px(2.5)).toBeCloseTo(10.4, 1); // 9 km/h base — untouched
    expect(px(7.5)).toBeCloseTo(23.4, 1); // 9 km/h gust  (was 31.2)
    expect(px(24 * KMH)).toBeCloseTo(22.6, 1); // 24 km/h base (was 27.8)
    expect(px(24 * KMH * GUST)).toBeCloseTo(36.5, 1); // 24 km/h gust (was 83.3)
    expect(px(60 * KMH * GUST)).toBeCloseTo(37.5, 1); // 60 km/h gust (was 208.3)
  });

  it('shows the regression it fixes: uncompressed, a gust crossed the frame', () => {
    // Roughly a fifth of a 411 dp phone screen at 24 km/h, and half of it at
    // 60 km/h — this is what "smeared diagonally across the frame" was.
    expect(streakLengthPx(24 * KMH * GUST)).toBeGreaterThan(80);
    expect(streakLengthPx(60 * KMH * GUST)).toBeGreaterThan(200);
  });
});

describe('streak alpha ramp', () => {
  it('holds the approved floor at rest', () => {
    expect(streakAlpha(0)).toBe(STREAK_ALPHA_FLOOR);
  });

  it('flattens at the top instead of compounding with length', () => {
    expect(streakAlpha(1)).toBe(STREAK_ALPHA_CEIL);
    expect(streakAlpha(0.8)).toBe(STREAK_ALPHA_CEIL);
    // The rejected captures peaked at 0.28 + 0.38 = 0.66.
    expect(streakAlpha(1)).toBeLessThan(0.66);
  });

  it('is monotonic and clamped for any input', () => {
    let prev = -1;
    for (let t = -0.5; t <= 1.5; t += 0.01) {
      const a = streakAlpha(t);
      expect(a).toBeGreaterThanOrEqual(STREAK_ALPHA_FLOOR);
      expect(a).toBeLessThanOrEqual(STREAK_ALPHA_CEIL);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe('drape', () => {
  it('runs below the 0.62 shared weather default, deliberately', () => {
    expect(WIND_DRAPE_OPACITY).toBeLessThan(0.62);
    expect(WIND_DRAPE_OPACITY).toBe(0.3);
  });
});

describe('trail persistence', () => {
  it('keeps the ~17-frame budget that calm air needs', () => {
    expect(1 / (1 - TRAIL_FADE_OPACITY)).toBeCloseTo(16.7, 1);
  });
});
