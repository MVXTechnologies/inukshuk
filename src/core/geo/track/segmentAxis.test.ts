import { haversineMeters } from '@core/geo/geomath';
import { numberNotesOnTrack } from '@core/library/notes';
import type { TrackNote, TrackPoint } from '@core/models';
import { buildElevationProfile } from './elevationProfile';
import { interpolateTrackAtDistance } from './interpolate';
import { scrubProfileAtRatio } from './scrub';
import { computeSegmentedTrackStats } from './segments';
import { snapWaypointsToNotes } from './snapWaypoints';
import { buildTrackAxis, indexAtDistance, interpolateOnAxis } from './trackAxis';

/**
 * #325 — the scenario from the issue: a short walk, a pause, a ~1 km
 * relocation across the water, and a short walk again. Every
 * distance-along-trail consumer must measure the trail the way its distance
 * stat does: the relocation is not part of it.
 */
const pt = (latitude: number, longitude: number, altitude: number, time: number): TrackPoint => ({
  latitude,
  longitude,
  altitude,
  time,
});
const T0 = Date.parse('2026-09-09T10:00:00Z');
// Leg 1: three ~65 m steps east. Leg 2: ~1 km north, three more steps east.
const leg1 = [0, 1, 2, 3].map((i) => pt(46.8, -71.2 + i * 0.00085, 10 + i, T0 + i * 60_000));
const leg2 = [0, 1, 2].map((i) =>
  pt(46.809, -71.2 + i * 0.00085, 200 + i, T0 + 3_600_000 + i * 60_000),
);
const points = [...leg1, ...leg2];
const starts = [leg1.length];
const legM = (leg: readonly TrackPoint[]) => {
  let d = 0;
  for (let i = 1; i < leg.length; i++) d += haversineMeters(leg[i - 1]!, leg[i]!);
  return d;
};
const trailM = legM(leg1) + legM(leg2);
const gapM = haversineMeters(leg1[leg1.length - 1]!, leg2[0]!);

describe('segment-aware distance along the trail (#325)', () => {
  it('fixture sanity: the relocation dwarfs the walk', () => {
    expect(gapM).toBeGreaterThan(900);
    expect(trailM).toBeLessThan(400);
  });

  it('the axis never bridges a pause, and ends at the distance stat', () => {
    const axis = buildTrackAxis(points, starts);
    expect(axis.totalM).toBeCloseTo(trailM, 6);
    expect(axis.totalM).toBeCloseTo(computeSegmentedTrackStats(points, starts).distanceM, 6);
    // The first post-pause fix sits at the same distance as the last pre-pause one.
    expect(axis.cumM[leg1.length]).toBeCloseTo(axis.cumM[leg1.length - 1]!, 9);
    // Without segments it is the plain arc length, gap included (unchanged).
    expect(buildTrackAxis(points).totalM).toBeCloseTo(trailM + gapM, 6);
  });

  it('ignores junk segment starts (0, out of range, fractional)', () => {
    expect(buildTrackAxis(points, [0, -1, 2.5, 99]).totalM).toBeCloseTo(trailM + gapM, 6);
  });

  it('a distance at the gap resolves to the first point after the pause, on both walkers', () => {
    const axis = buildTrackAxis(points, starts);
    const atGap = axis.cumM[leg1.length]!;
    expect(indexAtDistance(axis, atGap)).toBe(leg1.length);
    const walked = interpolateTrackAtDistance(points, atGap, starts);
    const searched = interpolateOnAxis(points, axis, atGap);
    expect(walked).toMatchObject({ latitude: leg2[0]!.latitude, longitude: leg2[0]!.longitude });
    expect(searched).toMatchObject({ latitude: leg2[0]!.latitude, longitude: leg2[0]!.longitude });
  });

  it('the walker and the binary search agree everywhere along the trail', () => {
    const axis = buildTrackAxis(points, starts);
    for (let d = 0; d <= trailM + 10; d += 7) {
      const walked = interpolateTrackAtDistance(points, d, starts)!;
      const searched = interpolateOnAxis(points, axis, d)!;
      expect(walked.latitude).toBeCloseTo(searched.latitude, 9);
      expect(walked.longitude).toBeCloseTo(searched.longitude, 9);
      expect(walked.distanceM).toBeCloseTo(searched.distanceM, 6);
    }
  });

  it("the elevation profile's x axis runs to the trail's length, not across the water", () => {
    const profile = buildElevationProfile(points, { segmentStarts: starts });
    expect(profile.totalDistanceM).toBeCloseTo(trailM, 6);
    const last = profile.samples[profile.samples.length - 1]!;
    expect(last.distanceM).toBeCloseTo(trailM, 6);
    // No sample interpolates elevation between the legs (10–13 m vs 200–202 m).
    for (const s of profile.samples) {
      expect(s.elevationM <= 13 || s.elevationM >= 200).toBe(true);
    }
  });

  it('scrubbing the profile end lands on the last fix', () => {
    const profile = buildElevationProfile(points, { segmentStarts: starts });
    const end = scrubProfileAtRatio(points, profile.samples, 1, starts);
    expect(end?.at).toMatchObject({ latitude: leg2[2]!.latitude, longitude: leg2[2]!.longitude });
  });

  it('a note dropped after the pause sits on the second leg, not early on the first', () => {
    // The recorder anchors a waypoint at its distance stat — segment-aware.
    const afterPauseM = legM(leg1) + legM(leg2.slice(0, 2));
    const note: TrackNote = { id: 'n', distanceM: afterPauseM, text: 'after', createdAt: 0 };
    const [pin] = numberNotesOnTrack(points, [note], starts);
    expect(pin?.latitude).toBeCloseTo(leg2[1]!.latitude, 9);
    expect(pin?.longitude).toBeCloseTo(leg2[1]!.longitude, 9);
    // Bridged (the old axis) it landed out on the water, 65 m into the hop.
    const [old] = numberNotesOnTrack(points, [note]);
    expect(old?.latitude).toBeGreaterThan(46.8);
    expect(old?.latitude).toBeLessThan(46.805);
  });

  it("an imported <wpt> on a later <trkseg> is anchored at the trail's distance", () => {
    const [note] = snapWaypointsToNotes(
      points,
      [{ latitude: leg2[2]!.latitude, longitude: leg2[2]!.longitude, name: 'End' }],
      starts,
    );
    expect(note?.distanceM).toBeCloseTo(trailM, 6);
  });
});
