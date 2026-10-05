import { parseGpx } from '@core/geo/gpx';
import type { TrackPoint } from '@core/models';

import { garminCourseGpx, garminCourseSamples } from './__fixtures__/garminCourse';
import { buildImportedTrack, CLIMB_MODEL_KEY, computeSegmentedTrackStats } from './index';

/**
 * The "D+ over 4000 m" report (a Garmin Connect course imported on iOS):
 * the GPX reads correctly — no route/track doubling, no waypoint or missing
 * elevations in the series — but a course's elevations are a terrain lookup
 * at the nearest pixel for points a few metres apart, and the 3 m hysteresis
 * alone counted every pixel hop as climb.
 */

function importCourse(xml: string) {
  const doc = parseGpx(xml);
  const track = buildImportedTrack({
    id: 'course',
    points: doc.points,
    segmentStarts: doc.segmentStarts,
    name: doc.metadata.name,
    fallbackName: 'Imported trail',
    fallbackTime: 0,
  });
  return { doc, track };
}

/** The climb of the exact terrain under the course. */
const TRUE_ASCENT_M = (() => {
  const samples = garminCourseSamples();
  const pts: TrackPoint[] = samples.map((s) => ({
    latitude: s.latitude,
    longitude: s.longitude,
    altitude: s.trueEle,
    time: 0,
  }));
  return computeSegmentedTrackStats(pts, []).ascentM;
})();

describe('Garmin Connect course import (D+ inflation)', () => {
  it('the fixture is a long mountain course', () => {
    const { doc, track } = importCourse(garminCourseGpx({ ele: 'true' }));
    expect(track.stats.distanceM).toBeGreaterThan(40_000);
    expect(TRUE_ASCENT_M).toBeGreaterThan(1500);
    expect(TRUE_ASCENT_M).toBeLessThan(2500);
    // A clean profile (the exact terrain, to the decimetre) is measured as it is.
    expect(track.stats.ascentM).toBe(computeSegmentedTrackStats(doc.points, []).ascentM);
    expect(Math.abs(track.stats.ascentM - TRUE_ASCENT_M)).toBeLessThan(TRUE_ASCENT_M * 0.02);
  });

  it('reads the course once: no <rte> doubling, no <wpt> in the series', () => {
    const plain = importCourse(garminCourseGpx()).doc;
    const both = importCourse(garminCourseGpx({ withRoute: true, withCoursePoints: true })).doc;
    expect(both.points).toHaveLength(plain.points.length);
    expect(both.waypoints).toHaveLength(2);
    expect(both.points.every((p) => p.altitude !== undefined)).toBe(true);
  });

  it('the old rule inflated the course climb by well over half', () => {
    const { doc } = importCourse(garminCourseGpx());
    const legacy = computeSegmentedTrackStats(doc.points, doc.segmentStarts);
    expect(legacy.ascentM).toBeGreaterThan(TRUE_ASCENT_M * 1.5);
  });

  it.each([
    ['untimed (a route)', {}],
    ['with virtual-partner times', { times: true }],
    ['with a duplicate <rte> and course points', { withRoute: true, withCoursePoints: true }],
    ['3 m point spacing', { stepM: 3 }],
    ['20 m point spacing', { stepM: 20 }],
  ])('measures a course %s within 15 %% of the terrain', (_label, opts) => {
    const { track } = importCourse(garminCourseGpx(opts));
    expect(track.stats.ascentM).toBeGreaterThan(TRUE_ASCENT_M * 0.9);
    expect(track.stats.ascentM).toBeLessThan(TRUE_ASCENT_M * 1.15);
    expect(track.stats.descentM).toBeLessThan(TRUE_ASCENT_M * 1.15);
    expect(track.stats.climbModel).toBe(CLIMB_MODEL_KEY);
  });

  it('a course without elevations has no climb', () => {
    const { track } = importCourse(garminCourseGpx({ ele: 'none' }));
    expect(track.stats.ascentM).toBe(0);
    expect(track.stats.minAltitudeM).toBeUndefined();
  });

  it('keeps the real highest and lowest points (only the climb is smoothed)', () => {
    const { doc, track } = importCourse(garminCourseGpx());
    const heights = doc.points.map((p) => p.altitude!);
    expect(track.stats.maxAltitudeM).toBe(Math.max(...heights));
    expect(track.stats.minAltitudeM).toBe(Math.min(...heights));
  });

  it('leaves a Garmin ACTIVITY export (barometric, 1 Hz, heart rate) to the metre', () => {
    // The same mountain walked: a barometric altimeter, decimetre jitter.
    const samples = garminCourseSamples(1.2);
    const t0 = Date.UTC(2026, 8, 20, 7);
    const trkpts = samples
      .map((s, i) => {
        const ele = (s.trueEle + 0.3 * Math.sin(i * 1.7)).toFixed(1);
        const time = new Date(t0 + i * 1000).toISOString();
        return `<trkpt lat="${s.latitude.toFixed(7)}" lon="${s.longitude.toFixed(7)}"><ele>${ele}</ele><time>${time}</time><extensions><ns3:TrackPointExtension><ns3:hr>128</ns3:hr></ns3:TrackPointExtension></extensions></trkpt>`;
      })
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><gpx creator="Garmin Connect" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><metadata><time>${new Date(t0).toISOString()}</time></metadata><trk><name>Morning hike</name><type>hiking</type><trkseg>${trkpts}</trkseg></trk></gpx>`;
    const { doc, track } = importCourse(xml);
    const legacy = computeSegmentedTrackStats(doc.points, doc.segmentStarts);
    expect(track.stats.ascentM).toBe(legacy.ascentM);
    expect(track.stats.descentM).toBe(legacy.descentM);
  });
});
