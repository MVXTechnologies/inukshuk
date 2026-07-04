import type { TrackPoint } from '@core/models';
import { MAX_ACCURACY_M, MIN_INTERVAL_MS, shouldAcceptFix } from './gpsFilter';

const pt = (over: Partial<TrackPoint> = {}): TrackPoint => ({
  latitude: 46.8,
  longitude: -71.2,
  time: 1_000_000,
  ...over,
});

describe('shouldAcceptFix', () => {
  it('accepts the first point of a track (no prev)', () => {
    expect(shouldAcceptFix(undefined, pt({ accuracy: 10 }))).toBe(true);
  });

  it('rejects a first point with bad accuracy', () => {
    expect(shouldAcceptFix(undefined, pt({ accuracy: MAX_ACCURACY_M + 1 }))).toBe(false);
  });

  it('rejects fixes with accuracy worse than the threshold', () => {
    const prev = pt({ accuracy: 8 });
    const next = pt({ time: prev.time + 2000, latitude: 46.8001, accuracy: 60 });
    expect(shouldAcceptFix(prev, next)).toBe(false);
  });

  it('accepts fixes at exactly the accuracy threshold', () => {
    const prev = pt();
    const next = pt({ time: prev.time + 2000, latitude: 46.8001, accuracy: MAX_ACCURACY_M });
    expect(shouldAcceptFix(prev, next)).toBe(true);
  });

  it('accepts fixes without accuracy (old data / platforms that omit it)', () => {
    const prev = pt();
    const next = pt({ time: prev.time + 2000, latitude: 46.8001 });
    expect(next.accuracy).toBeUndefined();
    expect(shouldAcceptFix(prev, next)).toBe(true);
  });

  it('rejects teleport outliers (implied speed above the cap)', () => {
    const prev = pt();
    // ~1.1 km of latitude in 2 s => ~555 m/s.
    const next = pt({ time: prev.time + 2000, latitude: 46.81, accuracy: 5 });
    expect(shouldAcceptFix(prev, next)).toBe(false);
  });

  it('accepts a normal walking pace', () => {
    const prev = pt();
    // ~1.4 m of latitude movement per second over 2 s — brisk walk.
    const next = pt({ time: prev.time + 2000, latitude: 46.800025, accuracy: 12 });
    expect(shouldAcceptFix(prev, next)).toBe(true);
  });

  it('rejects near-duplicate timestamps (double delivery)', () => {
    const prev = pt();
    const next = pt({ time: prev.time, accuracy: 5 });
    expect(shouldAcceptFix(prev, next)).toBe(false);
    const almost = pt({ time: prev.time + MIN_INTERVAL_MS - 1, accuracy: 5 });
    expect(shouldAcceptFix(prev, almost)).toBe(false);
  });

  it('rejects out-of-order timestamps', () => {
    const prev = pt();
    const next = pt({ time: prev.time - 5000, latitude: 46.8001, accuracy: 5 });
    expect(shouldAcceptFix(prev, next)).toBe(false);
  });

  it('honours option overrides', () => {
    const prev = pt();
    const next = pt({ time: prev.time + 1000, latitude: 46.80002, accuracy: 30 });
    expect(shouldAcceptFix(prev, next, { maxAccuracyM: 20 })).toBe(false);
    expect(shouldAcceptFix(prev, next, { maxAccuracyM: 30 })).toBe(true);
    expect(shouldAcceptFix(prev, next, { maxSpeedMps: 0.001 })).toBe(false);
    expect(shouldAcceptFix(prev, next, { minIntervalMs: 1500 })).toBe(false);
  });
});
