import { haversineMeters } from '@core/geo/geomath';
import { at, polyline, switchbacks } from './__fixtures__/paths';
import {
  ARRIVE_M,
  buildFollowTargets,
  nextFollowTarget,
  noteTargetName,
  WAYPOINT_CORRIDOR_M,
} from './followTargets';
import { nearestOnTrail, prepareTrail } from './trailIndex';

const wp = (id: string, x: number, y: number, label = id) => ({ id, label, ...at(x, y) });
const note = (id: string, distanceM: number, text = `note ${id}`) => ({ id, text, distanceM });

describe('noteTargetName', () => {
  it('uses the first line, trimmed', () => {
    expect(noteTargetName('  Water here \nsecond line')).toBe('Water here');
  });
  it('names an empty note', () => {
    expect(noteTargetName('   ')).toBe('Trail note');
    expect(noteTargetName('\nonly second')).toBe('Trail note');
  });
  it('cuts a long line with an ellipsis', () => {
    const name = noteTargetName('A'.repeat(80));
    expect(name.length).toBe(32);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('buildFollowTargets', () => {
  const trail = prepareTrail(
    polyline(
      [
        [0, 0],
        [1000, 0],
      ],
      5,
    ),
  )!;

  it('keeps waypoints near the trail, ordered along it', () => {
    const t = buildFollowTargets(
      trail,
      [
        wp('far', 500, WAYPOINT_CORRIDOR_M + 20),
        wp('b', 700, 10, 'Camp lac'),
        wp('a', 200, -30),
        wp('bad', NaN, 0),
      ],
      [],
    );
    expect(t.waypoints.map((w) => w.id)).toEqual(['a', 'b']);
    expect(t.waypoints[1]!.name).toBe('Camp lac');
    expect(t.waypoints[0]!.alongM).toBeCloseTo(200, -1);
    // The flag points at the waypoint itself, not its projection.
    expect(haversineMeters(t.waypoints[0]!.at, at(200, -30))).toBeLessThan(0.01);
  });

  it('names a blank waypoint', () => {
    expect(buildFollowTargets(trail, [wp('x', 10, 0, '  ')], []).waypoints[0]!.name).toBe(
      'Waypoint',
    );
  });

  it('places notes at their distance, clamped to the trail', () => {
    const t = buildFollowTargets(
      trail,
      [],
      [note('late', 5000), note('mid', 400, 'Spring'), note('nan', NaN), note('neg', -3)],
    );
    expect(t.notes.map((n) => n.id)).toEqual(['neg', 'mid', 'late']);
    expect(t.notes[1]!.name).toBe('Spring');
    expect(haversineMeters(t.notes[1]!.at, at(400, 0))).toBeLessThan(1);
    expect(t.notes[2]!.alongM).toBeCloseTo(trail.lengthM, 6);
  });

  it('orders equal distances by id, deterministically', () => {
    const t = buildFollowTargets(trail, [], [note('b', 100), note('a', 100)]);
    expect(t.notes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('ends at the trail end', () => {
    const t = buildFollowTargets(trail, [], []);
    expect(t.end.kind).toBe('end');
    expect(haversineMeters(t.end.at, at(1000, 0))).toBeLessThan(0.5);
  });
});

describe('nextFollowTarget', () => {
  const trail = prepareTrail(
    polyline(
      [
        [0, 0],
        [1000, 0],
      ],
      5,
    ),
  )!;
  const targets = buildFollowTargets(
    trail,
    [wp('w1', 300, 5), wp('w2', 600, 5)],
    [note('n1', 100), note('n2', 800)],
  );

  it('prefers the next waypoint over a nearer note', () => {
    expect(nextFollowTarget(targets, 0).id).toBe('w1');
  });

  it('advances once a waypoint is within ARRIVE_M along', () => {
    const w1 = targets.waypoints[0]!.alongM;
    expect(nextFollowTarget(targets, w1 - ARRIVE_M - 1).id).toBe('w1');
    expect(nextFollowTarget(targets, w1 - ARRIVE_M + 1).id).toBe('w2');
  });

  it('falls back to the next note, then the end', () => {
    expect(nextFollowTarget(targets, 650).id).toBe('n2');
    expect(nextFollowTarget(targets, 900).id).toBe('end');
    expect(nextFollowTarget(targets, 1000).id).toBe('end');
  });

  it('on switchbacks, picks by distance along, not as the crow flies', () => {
    // Legs 200 m long, 20 m apart. "next-leg" is 20 m north of you as the crow
    // flies but ~400 m away on foot; "this-leg" is 150 m ahead on your leg.
    const pts = switchbacks(4, 200, 20, 4);
    const sb = prepareTrail(pts)!;
    const t = buildFollowTargets(sb, [wp('next-leg', 50, 22), wp('this-leg', 180, 0)], []);
    const you = nearestOnTrail(sb, at(30, 0));
    expect(nextFollowTarget(t, you.alongM).id).toBe('this-leg');
  });
});
