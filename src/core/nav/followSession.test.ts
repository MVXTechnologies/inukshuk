import { haversineMeters, initialBearingDeg } from '@core/geo/geomath';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import {
  buildFollowTargets,
  createFollowSession,
  lookaheadBearingDeg,
  LOOKAHEAD_M,
  prepareTrail,
  TURN_BACK_M,
} from '@core/nav';
import { at, noise, offset, polyline, switchbacks } from './__fixtures__/paths';

const near = (a: number, b: number, tol: number) => Math.abs(((a - b + 540) % 360) - 180) <= tol;

describe('lookaheadBearingDeg', () => {
  const trail = prepareTrail(
    polyline(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      5,
    ),
  )!;

  it('points at the point LOOKAHEAD_M ahead along the trail', () => {
    // At along 80, 40 m ahead is 20 m up the northbound leg.
    const from = at(80, 0);
    const b = lookaheadBearingDeg(trail, from, 80)!;
    expect(near(b, initialBearingDeg(from, at(100, 20)), 0.5)).toBe(true);
  });

  it('uses the final direction at the very end', () => {
    const b = lookaheadBearingDeg(trail, at(100, 100), trail.lengthM)!;
    expect(near(b, 0, 0.5)).toBe(true);
  });

  it('is null for a zero-length trail', () => {
    expect(lookaheadBearingDeg(prepareTrail([at(0, 0)])!, at(5, 5), 0)).toBeNull();
  });
});

describe('createFollowSession', () => {
  it('reads On trail and points the bar along the trail', () => {
    const trail = prepareTrail(
      polyline(
        [
          [0, 0],
          [1000, 0],
        ],
        5,
      ),
    )!;
    const s = createFollowSession(trail, buildFollowTargets(trail, [], []));
    const r = s.update(at(200, 3));
    expect(r.onTrail).toBe(true);
    expect(r.crossTrackM).toBeCloseTo(3, 0);
    expect(near(r.trailBearingDeg!, 90, 6)).toBe(true);
    expect(r.target.kind).toBe('end');
    expect(r.targetDistanceM).toBeCloseTo(803, -1);
  });

  it('latches Off trail past 30 m and back on within 20 m', () => {
    const trail = prepareTrail(
      polyline(
        [
          [0, 0],
          [1000, 0],
        ],
        5,
      ),
    )!;
    const s = createFollowSession(trail, buildFollowTargets(trail, [], []));
    const seq: [number, boolean][] = [
      [25, true], // starts on: 25 m is not past 30
      [31, false],
      [25, false], // hysteresis: still off between 20 and 30
      [21, false],
      [19, true],
      [29, true],
    ];
    for (const [y, expected] of seq) expect(s.update(at(300, y)).onTrail).toBe(expected);
  });

  it('off the trail, the bar points to the nearest point of the trail', () => {
    const trail = prepareTrail(
      polyline(
        [
          [0, 0],
          [1000, 0],
        ],
        5,
      ),
    )!;
    const s = createFollowSession(trail, buildFollowTargets(trail, [], []));
    const r = s.update(at(300, 62));
    expect(r.onTrail).toBe(false);
    expect(r.crossTrackM).toBeCloseTo(62, 0);
    expect(near(r.trailBearingDeg!, 180, 1)).toBe(true);
    expect(haversineMeters(r.nearest, at(300, 0))).toBeLessThan(1);
  });

  it('never measures the target closer than the straight line', () => {
    const trail = prepareTrail(
      polyline(
        [
          [0, 0],
          [1000, 0],
        ],
        5,
      ),
    )!;
    // A waypoint 45 m off the trail, right beside you along.
    const targets = buildFollowTargets(trail, [{ id: 'w', label: 'Hut', ...at(520, 45) }], []);
    const r = createFollowSession(trail, targets).update(at(505, 0));
    expect(r.target.name).toBe('Hut');
    expect(r.targetDistanceM).toBeCloseTo(haversineMeters(at(505, 0), at(520, 45)), 3);
  });

  it('walks a switchback climb with noisy fixes, visiting every waypoint in order', () => {
    const pts = switchbacks(8, 180, 18, 3);
    const trail = prepareTrail(pts)!;
    // A waypoint mid-way along each leg.
    const wps = Array.from({ length: 8 }, (_, i) => ({
      id: `leg${i}`,
      label: `Leg ${i}`,
      ...at(90, i * 18 + 1),
    }));
    const s = createFollowSession(trail, buildFollowTargets(trail, wps, []));
    const r = noise(5);
    const seen: string[] = [];
    for (let k = 0; k * 1.4 <= trail.lengthM; k++) {
      const truth = pointAtFraction(pts, (k * 1.4) / trail.lengthM);
      const out = s.update(offset(truth, r() * 5, r() * 5));
      if (seen[seen.length - 1] !== out.target.id) seen.push(out.target.id);
    }
    expect(seen).toEqual([...wps.map((w) => w.id), 'end']);
  });

  it('follows a long Québec activity at constant per-fix work', () => {
    const lib = largeLibrary(10, { stepSec: 1 });
    const pts = lib.points(9);
    const trail = prepareTrail(pts)!;
    const s = createFollowSession(trail, buildFollowTargets(trail, [], []));
    let maxWork = 0;
    let offTrail = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const out = s.update(pts[i]!);
      if (i > 0) maxWork = Math.max(maxWork, out.cost.segments);
      if (!out.onTrail) offTrail++;
    }
    // Riding the recording itself never reads Off trail.
    expect(offTrail).toBe(0);
    // Measured ~25 segments per fix on a 7 k-point trail.
    expect(maxWork).toBeLessThan(100);
    expect(trail.n).toBeGreaterThan(5000);
  });

  it('turning around brings the targets back with you', () => {
    const trail = prepareTrail(
      polyline(
        [
          [0, 0],
          [1000, 0],
        ],
        5,
      ),
    )!;
    const targets = buildFollowTargets(trail, [{ id: 'w', label: 'Hut', ...at(300, 0) }], []);
    const s = createFollowSession(trail, targets);
    for (let x = 0; x <= 320; x += 2) s.update(at(x, 0));
    expect(s.update(at(320, 0)).target.kind).toBe('end');
    // A few metres of noise behind: still past the hut.
    expect(s.update(at(300, 0)).target.kind).toBe('end');
    // Walked back 70 m (past TURN_BACK_M): the hut is the next target again.
    for (let x = 318; x >= 250; x -= 2) s.update(at(x, 0));
    expect(s.update(at(250, 0)).target.id).toBe('w');
  });

  it('constants are the agreed ones', () => {
    expect(LOOKAHEAD_M).toBe(40);
    expect(TURN_BACK_M).toBe(30);
  });
});

/** The point a fraction of the way along a polyline (by vertex count; fine for even spacing). */
function pointAtFraction(pts: { latitude: number; longitude: number }[], f: number) {
  const i = Math.min(pts.length - 1, Math.max(0, Math.round(f * (pts.length - 1))));
  return pts[i]!;
}
