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
