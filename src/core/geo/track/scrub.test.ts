import type { TrackPoint } from '@core/models';
import { buildElevationProfile } from './elevationProfile';
import { scrubProfileAtRatio } from './scrub';

const pt = (latitude: number, longitude: number, altitude?: number): TrackPoint => ({
  latitude,
  longitude,
  time: 0,
  altitude,
});

// A straight ~157 m/step track along longitude at 45° lat, with elevation.
const track = [pt(45, -73, 100), pt(45, -72.998, 150), pt(45, -72.996, 200), pt(45, -72.994, 250)];
const profile = buildElevationProfile(track);

describe('scrubProfileAtRatio', () => {
  it('returns null for an empty profile or empty track', () => {
    expect(scrubProfileAtRatio(track, [], 0.5)).toBeNull();
    expect(scrubProfileAtRatio([], profile.samples, 0.5)).toBeNull();
  });

  it('returns null for a non-finite ratio', () => {
    expect(scrubProfileAtRatio(track, profile.samples, NaN)).toBeNull();
    expect(scrubProfileAtRatio(track, profile.samples, Infinity)).toBeNull();
  });

  it('maps ratio 0 to the first sample at the track start', () => {
    const r = scrubProfileAtRatio(track, profile.samples, 0)!;
    expect(r.sampleIndex).toBe(0);
    expect(r.at.latitude).toBeCloseTo(45, 6);
    expect(r.at.longitude).toBeCloseTo(-73, 6);
    expect(r.at.distanceM).toBeCloseTo(0, 3);
  });

  it('maps ratio 1 to the last sample at the track end', () => {
    const r = scrubProfileAtRatio(track, profile.samples, 1)!;
    expect(r.sampleIndex).toBe(profile.samples.length - 1);
    expect(r.at.longitude).toBeCloseTo(-72.994, 6);
    expect(r.at.distanceM).toBeCloseTo(profile.totalDistanceM, 1);
  });

  it('maps the midpoint ratio to an interpolated on-trail position', () => {
    const r = scrubProfileAtRatio(track, profile.samples, 0.5)!;
    // Near halfway along the track (the nearest sample, so within one sample step).
    const step = profile.totalDistanceM / (profile.samples.length - 1);
    expect(Math.abs(r.at.distanceM - profile.totalDistanceM / 2)).toBeLessThanOrEqual(step);
    expect(r.at.latitude).toBeCloseTo(45, 6);
    // Elevation rises linearly 100→250 along this track; the interpolated
    // elevation must agree with the interpolated distance.
    const expected = 100 + 150 * (r.at.distanceM / profile.totalDistanceM);
    expect(r.at.elevation).toBeCloseTo(expected, 0);
  });

  it('clamps out-of-range ratios instead of overflowing the samples', () => {
    expect(scrubProfileAtRatio(track, profile.samples, -3)!.sampleIndex).toBe(0);
    expect(scrubProfileAtRatio(track, profile.samples, 42)!.sampleIndex).toBe(
      profile.samples.length - 1,
    );
  });

  it('scrubbing monotonically increases the distance along the track', () => {
    let prev = -1;
    for (let r = 0; r <= 1; r += 0.1) {
      const s = scrubProfileAtRatio(track, profile.samples, r)!;
      expect(s.at.distanceM).toBeGreaterThanOrEqual(prev);
      prev = s.at.distanceM;
    }
  });
});
