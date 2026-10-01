import { walk } from './__fixtures__/walk';
import { detectStops, findElevationExtremes, findSteepestStretches } from './highlights';
import { classifySegmentedSteps, STEP_GAP, STEP_MOVING } from './movingTime';
import { buildTrackAxis } from './trackAxis';

describe('detectStops', () => {
  it('lists a stop of 3 min or more and skips a short one', () => {
    const pts = walk([
      { m: 500, s: 500 },
      { m: 0, s: 60 }, // 1 min: too short to list
      { m: 500, s: 500 },
      { m: 0, s: 600 }, // 10 min
      { m: 500, s: 500 },
    ]);
    const stops = detectStops(pts, classifySegmentedSteps(pts, []));
    expect(stops).toHaveLength(1);
    expect(stops[0]!.kind).toBe('stop');
    // The smoothing window eats a few seconds at each edge.
    expect(stops[0]!.durationS).toBeGreaterThan(540);
    expect(stops[0]!.durationS).toBeLessThanOrEqual(600);
    expect(pts[stops[0]!.startIndex]!.time).toBeGreaterThan(pts[0]!.time + 1_000_000);
  });

  it('honours a custom minimum', () => {
    const pts = walk([
      { m: 300, s: 300 },
      { m: 0, s: 90 },
      { m: 300, s: 300 },
    ]);
    expect(detectStops(pts, classifySegmentedSteps(pts, []), { minStopS: 60 })).toHaveLength(1);
  });

  it('reports a long recording pause, and never a short one', () => {
    const a = walk([{ m: 300, s: 300 }]);
    const t = a[a.length - 1]!.time;
    const b = walk([{ m: 300, s: 300 }], { t0: t + 20 * 60_000 });
    const c = walk([{ m: 300, s: 300 }], { t0: b[b.length - 1]!.time + 60_000 });
    const pts = [...a, ...b, ...c];
    const steps = classifySegmentedSteps(pts, [a.length, a.length + b.length]);
    const stops = detectStops(pts, steps);
    expect(stops).toEqual([
      { kind: 'pause', startIndex: a.length - 1, endIndex: a.length, durationS: 20 * 60 },
    ]);
  });

  it('counts a fix gap as a stop only when the trail barely moved across it', () => {
    const pts = walk([
      { m: 300, s: 300 },
      { m: 5, s: 400 }, // one 400 s gap, 5 m on: standing still
      { m: 300, s: 300 },
      { m: 800, s: 400 }, // a 400 s gap covering 800 m: kept walking
      { m: 300, s: 300 },
    ]);
    // Rebuild with the gaps as single steps.
    const thin = pts.filter((_, i) => !(i > 60 && i < 140) && !(i > 200 && i < 280));
    const steps = classifySegmentedSteps(thin, []);
    expect(Array.from(steps).filter((v) => v === STEP_GAP).length).toBe(2);
    const stops = detectStops(thin, steps);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.durationS).toBeCloseTo(400, -1);
  });

  it('finds nothing on a steady walk', () => {
    const pts = walk([{ m: 2000, s: 2000 }]);
    const steps = classifySegmentedSteps(pts, []);
    expect(steps.slice(1).every((v) => v === STEP_MOVING)).toBe(true);
    expect(detectStops(pts, steps)).toEqual([]);
  });
});

describe('findSteepestStretches', () => {
  it('finds the steep climb and reports its grade and full length', () => {
    const pts = walk(
      [
        { m: 1000, s: 1000, rise: 20 },
        { m: 400, s: 800, rise: 96 }, // 24 % over 400 m
        { m: 1000, s: 1000, rise: 10 },
      ],
      { stepS: 10 },
    );
    const axis = buildTrackAxis(pts);
    const { climb, descent } = findSteepestStretches(pts, axis);
    // Smoothing rounds the corners a little.
    expect(climb!.gradePct).toBeGreaterThan(19);
    expect(climb!.gradePct).toBeLessThan(24.5);
    expect(climb!.lengthM).toBeGreaterThan(330);
    expect(climb!.lengthM).toBeLessThan(500);
    expect(axis.cumM[climb!.startIndex]!).toBeGreaterThan(900);
    expect(descent).toBeNull();
  });

  it('reports the steepest descent separately, with its sign', () => {
    const pts = walk(
      [
        { m: 500, s: 500, rise: 50 },
        { m: 400, s: 400, rise: -100 },
        { m: 300, s: 300 },
      ],
      { stepS: 10 },
    );
    const { climb, descent } = findSteepestStretches(pts, buildTrackAxis(pts));
    expect(descent!.gradePct).toBeLessThan(-18);
    expect(descent!.gradePct).toBeGreaterThan(-25.5);
    expect(climb!.gradePct).toBeGreaterThan(5);
  });

  it('ignores a DEM cliff edge: one sample 150 m off does not make a −51 % stretch', () => {
    const pts = walk([{ m: 3000, s: 3000, rise: 150 }], { stepS: 10 });
    const spiked = pts.map((p, i) => (i === 150 ? { ...p, altitude: (p.altitude ?? 0) - 150 } : p));
    const { climb, descent } = findSteepestStretches(spiked, buildTrackAxis(spiked));
    expect(descent === null || descent.gradePct > -20).toBe(true);
    expect(climb === null || climb.gradePct < 20).toBe(true);
  });

  it('discards grades past the cap as noise', () => {
    const pts = walk(
      [
        { m: 500, s: 500 },
        { m: 300, s: 600, rise: 240 }, // 80 %: not a trail
        { m: 500, s: 500 },
      ],
      { stepS: 10 },
    );
    const { climb } = findSteepestStretches(pts, buildTrackAxis(pts), { smoothHalfWindowM: 0 });
    expect(climb === null || climb.gradePct <= 60).toBe(true);
  });

  it('returns nothing on flat or short or elevation-less trails', () => {
    const none = { climb: null, descent: null };
    const flat = walk([{ m: 2000, s: 2000, rise: 10 }]);
    expect(findSteepestStretches(flat, buildTrackAxis(flat))).toEqual(none);
    const short = walk([{ m: 150, s: 150, rise: 50 }]);
    expect(findSteepestStretches(short, buildTrackAxis(short))).toEqual(none);
    const noAlt = walk([{ m: 1000, s: 1000, rise: 200 }]).map((p) => ({
      ...p,
      altitude: undefined,
    }));
    expect(findSteepestStretches(noAlt, buildTrackAxis(noAlt))).toEqual(none);
  });

  it('never measures across a pause', () => {
    const a = walk([{ m: 150, s: 150 }], { startAlt: 100 });
    const b = walk([{ m: 150, s: 150 }], { startAlt: 140, t0: a[a.length - 1]!.time + 1e6 }).map(
      (p) => ({ ...p, latitude: p.latitude + 0.0014 }),
    );
    const pts = [...a, ...b];
    const axis = buildTrackAxis(pts);
    expect(findSteepestStretches(pts, axis, { segmentStarts: [a.length] }).climb).toBeNull();
    expect(findSteepestStretches(pts, axis).climb).not.toBeNull();
  });
});

describe('findElevationExtremes', () => {
  it('finds the high and low points', () => {
    const pts = walk([
      { m: 500, s: 500, rise: 300 },
      { m: 500, s: 500, rise: -400 },
    ]);
    const x = findElevationExtremes(pts)!;
    expect(x.highM).toBeCloseTo(500, 6);
    expect(x.lowM).toBeCloseTo(100, 6);
    expect(x.highIndex).toBeLessThan(x.lowIndex);
  });

  it('is null without altitude', () => {
    expect(findElevationExtremes([])).toBeNull();
  });
});
