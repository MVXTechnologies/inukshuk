import type { TrackPoint } from '@core/models';
import { haversineMeters } from '@core/geo/geomath';
import { liveSpeed } from './liveSpeed';

const pt = (over: Partial<TrackPoint> & { time: number }): TrackPoint => ({
  latitude: 46.8,
  longitude: -71.2,
  ...over,
});

describe('liveSpeed', () => {
  it('returns 0 for an empty track', () => {
    expect(liveSpeed([])).toBe(0);
  });

  it("prefers the latest fix's own GPS speed when present", () => {
    // 110 km/h cruise: the fix reports its own instantaneous speed in m/s.
    // A distance/time fallback over stale history must NOT be used here.
    const points = [
      pt({ time: 0, latitude: 46.8, speed: 5 }),
      pt({ time: 60_000, latitude: 46.9, speed: 5 }), // ~1 minute of much slower travel
      pt({ time: 61_000, latitude: 46.9002, speed: 30.56 }), // 110 km/h fix
    ];
    expect(liveSpeed(points)).toBeCloseTo(30.56, 6);
  });

  it('ignores a negative sentinel speed and falls back to the window', () => {
    const a = pt({ time: 0, latitude: 46.8, longitude: -71.2 });
    const b = pt({ time: 2000, latitude: 46.801, longitude: -71.2, speed: -1 });
    const expected = haversineMeters(a, b) / 2;
    expect(liveSpeed([a, b])).toBeCloseTo(expected, 6);
  });

  it('ignores a non-finite speed and falls back to the window', () => {
    const a = pt({ time: 0, latitude: 46.8, longitude: -71.2 });
    const b = pt({ time: 2000, latitude: 46.801, longitude: -71.2, speed: NaN });
    const expected = haversineMeters(a, b) / 2;
    expect(liveSpeed([a, b])).toBeCloseTo(expected, 6);
  });

  it('falls back to a rolling window when speed is absent', () => {
    // 3 points, 1 s apart, each ~11.1 m (0.0001 deg lat) — well inside the
    // default 5 s window, so the fallback should average over ALL of them,
    // not just the last segment.
    const points = [
      pt({ time: 0, latitude: 46.8 }),
      pt({ time: 1000, latitude: 46.8001 }),
      pt({ time: 2000, latitude: 46.8002 }),
    ];
    const expected = haversineMeters(points[0]!, points[2]!) / 2;
    expect(liveSpeed(points)).toBeCloseTo(expected, 6);
  });

  it('excludes points older than the window from the fallback average', () => {
    const points = [
      pt({ time: 0, latitude: 40 }), // far away, way outside the window
      pt({ time: 10_000, latitude: 46.8 }), // window starts here (cutoff = 15000 - 5000)
      pt({ time: 15_000, latitude: 46.801 }),
    ];
    const expected = haversineMeters(points[1]!, points[2]!) / 5;
    expect(liveSpeed(points, { windowMs: 5000 })).toBeCloseTo(expected, 6);
  });

  it('returns 0 when the window contains only the latest point', () => {
    const points = [
      pt({ time: 0, latitude: 46.8 }),
      pt({ time: 20_000, latitude: 46.9 }), // 20 s later, outside a 5 s window
    ];
    expect(liveSpeed(points, { windowMs: 5000 })).toBe(0);
  });

  it('returns a value in m/s consistent with a known speed (unit sanity)', () => {
    // ~10 m/s (36 km/h) over 2 points, 10 s apart along a north-south line
    // (1 deg lat ~= 111,320 m, so 10 m/s * 10 s = 100 m ~= 0.000898 deg).
    const a = pt({ time: 0, latitude: 45, longitude: -73 });
    const b = pt({ time: 10_000, latitude: 45.000898, longitude: -73 });
    const mps = liveSpeed([a, b], { windowMs: 15_000 });
    expect(mps).toBeCloseTo(10, 0);
    expect(mps * 3.6).toBeCloseTo(36, 0); // km/h, the HUD's display unit
  });

  it('a single point with no speed returns 0 (no window to fall back on)', () => {
    expect(liveSpeed([pt({ time: 0 })])).toBe(0);
  });

  it('returns 0 for out-of-order/duplicate timestamps within the window (dt <= 0)', () => {
    const a = pt({ time: 2000, latitude: 46.8 });
    const b = pt({ time: 2000, latitude: 46.801 }); // same timestamp as a
    expect(liveSpeed([a, b])).toBe(0);
  });
});
