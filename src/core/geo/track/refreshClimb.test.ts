import { parseGpx } from '@core/geo/gpx';
import type { TrackStats } from '@core/models';

import { garminCourseGpx } from './__fixtures__/garminCourse';
import { CLIMB_MODEL_KEY } from './elevationSmoothing';
import { computeSegmentedTrackStats } from './index';
import { refreshClimbStats } from './refreshClimb';

const { points } = parseGpx(garminCourseGpx());

/** What 2.1.0 stored for the course: the inflated climb, no stamp. */
function legacy(): TrackStats {
  const s = computeSegmentedTrackStats(points, [], { category: 'navigation' });
  delete s.climbModel;
  return s;
}

describe('refreshClimbStats', () => {
  it('recomputes the climb of a trail saved before the climb rule', () => {
    const old = legacy();
    const next = refreshClimbStats(old, points, []);
    expect(next).not.toBeNull();
    expect(next!.climbModel).toBe(CLIMB_MODEL_KEY);
    expect(next!.ascentM).toBeLessThan(old.ascentM * 0.75);
    expect(next!.descentM).toBeLessThan(old.descentM * 0.75);
    // Everything else is the stored stats, untouched.
    expect({ ...next!, ascentM: 0, descentM: 0, climbModel: undefined }).toEqual({
      ...old,
      ascentM: 0,
      descentM: 0,
      climbModel: undefined,
    });
  });

  it('is a no-op for a current stamp', () => {
    const current = computeSegmentedTrackStats(points, [], { robustClimb: true });
    expect(refreshClimbStats(current, points, [])).toBeNull();
  });

  it('ignores a point list that is not the stored trail', () => {
    expect(refreshClimbStats(legacy(), points.slice(10), [])).toBeNull();
  });
});
