import type { TrackPoint } from '@core/models';
import { interpolateTrackAtDistance } from './interpolate';

const pt = (latitude: number, longitude: number, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  latitude,
  longitude,
  time: 0,
  ...extra,
});

describe('interpolateTrackAtDistance', () => {
  it('returns null for empty input', () => {
    expect(interpolateTrackAtDistance([], 0)).toBeNull();
  });

  it('returns the lone point for a single-point track', () => {
    const r = interpolateTrackAtDistance([pt(45, -73, { altitude: 100 })], 50);
    expect(r).toMatchObject({ latitude: 45, longitude: -73, distanceM: 0, elevation: 100 });
  });

  it('interpolates lat/lng/elevation/speed at the segment midpoint', () => {
    // Two points ~157 m apart along longitude at 45° lat.
    const pts = [
      pt(45, -73, { altitude: 100, speed: 0, time: 1000 }),
      pt(45, -72.998, { altitude: 200, speed: 4, time: 3000 }),
    ];
    const full = interpolateTrackAtDistance(pts, 1e9)!; // clamps to end → total length
    const mid = interpolateTrackAtDistance(pts, full.distanceM / 2)!;
    expect(mid.longitude).toBeCloseTo(-72.999, 4);
    expect(mid.elevation).toBeCloseTo(150, 1);
    expect(mid.speed).toBeCloseTo(2, 1);
    expect(mid.time).toBeCloseTo(2000, 0);
  });

  it('clamps to start at distance 0 and to the end beyond total length', () => {
    const pts = [pt(45, -73), pt(45.001, -73), pt(45.002, -73)];
    expect(interpolateTrackAtDistance(pts, 0)).toMatchObject({ latitude: 45 });
    const end = interpolateTrackAtDistance(pts, 1e9)!;
    expect(end.latitude).toBeCloseTo(45.002, 6);
  });

  it('interpolates heart rate at the segment midpoint', () => {
    const pts = [pt(45, -73, { heartRateBpm: 120 }), pt(45, -72.998, { heartRateBpm: 140 })];
    const full = interpolateTrackAtDistance(pts, 1e9)!;
    const mid = interpolateTrackAtDistance(pts, full.distanceM / 2)!;
    expect(mid.heartRateBpm).toBeCloseTo(130, 1);
  });

  it('carries elevation through a segment when only one endpoint has it', () => {
    const pts = [pt(45, -73, { altitude: 100 }), pt(45, -72.999)];
    const full = interpolateTrackAtDistance(pts, 1e9)!;
    // Mid-segment: the undefined endpoint falls back to the defined neighbour.
    const mid = interpolateTrackAtDistance(pts, full.distanceM / 2)!;
    expect(mid.elevation).toBe(100);
  });
});

it('does not fabricate timestamps while scrubbing untimed imported fixes', () => {
  const points = [pt(45, -73, { hasTime: false }), pt(45.001, -73, { time: 1704067200000 })];
  expect(interpolateTrackAtDistance(points, 50)?.time).toBeUndefined();
  expect(interpolateTrackAtDistance([points[0]!], 0)?.time).toBeUndefined();
  expect(interpolateTrackAtDistance([...points].reverse(), 1e9)?.time).toBeUndefined();
});

describe('interpolateTrackAtDistance — antimeridian (audit A17)', () => {
  // A ~222 m segment straddling ±180°. The raw longitude lerp walked the long
  // way round and put the scrub cursor at Greenwich (longitude 0).
  const eastbound = [pt(0, 179.999), pt(0, -179.999)];
  const westbound = [pt(0, -179.999), pt(0, 179.999)];

  it('keeps the cursor on the seam at the midpoint of an eastbound crossing', () => {
    const full = interpolateTrackAtDistance(eastbound, 1e9)!;
    expect(full.distanceM).toBeGreaterThan(200);
    expect(full.distanceM).toBeLessThan(250);
    const mid = interpolateTrackAtDistance(eastbound, full.distanceM / 2)!;
    expect(Math.abs(mid.longitude)).toBeCloseTo(180, 6);
    const quarter = interpolateTrackAtDistance(eastbound, full.distanceM / 4)!;
    expect(quarter.longitude).toBeCloseTo(179.9995, 6);
  });

  it('keeps the cursor on the seam for a westbound crossing', () => {
    const full = interpolateTrackAtDistance(westbound, 1e9)!;
    const mid = interpolateTrackAtDistance(westbound, full.distanceM / 2)!;
    expect(Math.abs(mid.longitude)).toBeCloseTo(180, 6);
    const quarter = interpolateTrackAtDistance(westbound, full.distanceM / 4)!;
    expect(quarter.longitude).toBeCloseTo(-179.9995, 6);
    const threeQuarter = interpolateTrackAtDistance(westbound, (3 * full.distanceM) / 4)!;
    expect(threeQuarter.longitude).toBeCloseTo(179.9995, 6);
  });

  it('returns the endpoints verbatim and always a longitude in [-180, 180]', () => {
    for (const pts of [eastbound, westbound]) {
      const full = interpolateTrackAtDistance(pts, 1e9)!;
      expect(interpolateTrackAtDistance(pts, 0)!.longitude).toBe(pts[0]!.longitude);
      expect(full.longitude).toBe(pts[1]!.longitude);
      for (let f = 0; f <= 1; f += 0.05) {
        const { longitude } = interpolateTrackAtDistance(pts, full.distanceM * f)!;
        expect(longitude).toBeGreaterThanOrEqual(-180);
        expect(longitude).toBeLessThanOrEqual(180);
      }
    }
  });

  it('leaves ordinary segments unchanged', () => {
    const pts = [pt(45, -73, { altitude: 0 }), pt(45, -72.998, { altitude: 100 })];
    const full = interpolateTrackAtDistance(pts, 1e9)!;
    const mid = interpolateTrackAtDistance(pts, full.distanceM / 2)!;
    expect(mid.longitude).toBeCloseTo(-72.999, 6);
  });
});
