/**
 * The pin hit-test (#343).
 *
 * The bug this file exists for: `MapScreen` projected every pin with
 * `Promise.all` and returned on rejection, so ONE stored waypoint the
 * projector refused killed every map tap — silently, and across restarts,
 * because the waypoint is persisted. These cases pin the two properties that
 * prevent it: a bad coordinate never reaches the projector, and a projection
 * that fails anyway costs only that pin.
 */
import { nearestPinAt, projectablePins, unprojectablePins, type ProjectedPin } from './pinHitTest';

const pin = (id: string, longitude: number, latitude: number) => ({ id, longitude, latitude });

const GOOD = [pin('a', -71.2, 46.8), pin('b', -71.1, 46.9)];

describe('projectablePins', () => {
  it('keeps real places, with the index they came from', () => {
    expect(projectablePins(GOOD)).toEqual([
      { index: 0, lngLat: [-71.2, 46.8] },
      { index: 1, lngLat: [-71.1, 46.9] },
    ]);
  });

  it.each([
    ['NaN latitude', pin('x', -71, Number.NaN)],
    ['infinite longitude', pin('x', Number.POSITIVE_INFINITY, 46)],
    ['latitude past the pole', pin('x', -71, 91)],
    ['longitude past the antimeridian', pin('x', 181, 46)],
  ])('never asks the projector about a pin with %s', (_label, bad) => {
    expect(projectablePins([bad])).toEqual([]);
    expect(unprojectablePins([bad])).toEqual([bad]);
  });

  it('keeps the good pins in a list that also holds a bad one', () => {
    const pins = [GOOD[0]!, pin('bad', Number.NaN, Number.NaN), GOOD[1]!];
    expect(projectablePins(pins).map((p) => p.index)).toEqual([0, 2]);
    expect(unprojectablePins(pins).map((p) => p.id)).toEqual(['bad']);
  });

  it('accepts the exact edges rather than nudging them away', () => {
    expect(projectablePins([pin('edge', 180, 90), pin('edge2', -180, -90)])).toHaveLength(2);
  });
});

describe('nearestPinAt', () => {
  const projected = (...points: ProjectedPin[]): ProjectedPin[] => points;

  it('picks the closest pin inside the radius, allowing for the badge offset', () => {
    // Pin drawn 18 px above its anchor, so a tap at the anchor is 0 px away.
    const hit = nearestPinAt(GOOD, projected([100, 118], [400, 400]), [100, 100], 30, 18);
    expect(hit?.id).toBe('a');
  });

  it('returns null when the tap is outside every pin', () => {
    expect(nearestPinAt(GOOD, projected([100, 100], [400, 400]), [250, 250], 30, 0)).toBeNull();
  });

  // The property the whole fix is about.
  it('still finds a pin when a NEIGHBOUR could not be projected', () => {
    const pins = [pin('unprojectable', -71, 46), GOOD[0]!];
    const hit = nearestPinAt(pins, projected(null, [100, 100]), [100, 100], 30, 0);
    expect(hit?.id).toBe('a');
  });

  it('returns null, not a throw, when NOTHING could be projected', () => {
    expect(nearestPinAt(GOOD, projected(null, null), [100, 100], 30, 0)).toBeNull();
  });

  it('copes with fewer projections than pins', () => {
    expect(nearestPinAt(GOOD, projected([100, 100]), [100, 100], 30, 0)?.id).toBe('a');
  });

  it('prefers the nearer of two pins under the tap', () => {
    const hit = nearestPinAt(GOOD, projected([110, 100], [102, 100]), [100, 100], 30, 0);
    expect(hit?.id).toBe('b');
  });
});
