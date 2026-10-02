/**
 * Back & forth (#515): the return is the outbound line reversed — derived,
 * never routed — so the stats double, the climb picks up the outbound's
 * descent, the profile mirrors, and the plan round-trips the flag.
 */
import type { LngLat } from '@core/models';

import { drawReducer, initialDrawState } from './editor';
import { ROUTE_SAMPLE_STEP_M } from './elevation';
import { densifyLine, polylineLengthM } from './geometry';
import { legKey, legViews, mergeLegs, outAndBack, outboundOf, seedResultsFromLine } from './legs';
import { buildDrawProfile, scrubProfile } from './profile';
import { buildRoutePlan, sanitizeRoutePlan } from './serialize';
import { elevationGainLoss } from '@core/geo/track';

const A: LngLat = [-70.9065, 47.0753];
const B: LngLat = [-70.912, 47.078];
const C: LngLat = [-70.92, 47.081];

/** A made-up terrain: rises 100 m per km northward (latitude). */
const terrain = (p: LngLat) => 200 + (p[1] - 47) * 111_000 * 0.1;

describe('outAndBack', () => {
  it('appends the reversed line, the turnaround once', () => {
    expect(outAndBack([A, B, C])).toEqual([A, B, C, B, A]);
    expect(outAndBack([A])).toEqual([A]);
    expect(outAndBack([])).toEqual([]);
  });

  it('reverses SNAPPED legs too — the return follows the trail, with no new leg to route', () => {
    const bend: LngLat = [-70.909, 47.079];
    const results = new Map([
      [legKey('trails', A, B), { status: 'routed' as const, coords: [A, bend, B] }],
    ]);
    const out = mergeLegs(legViews([A, B], ['trails'], results));
    expect(outAndBack(out)).toEqual([A, bend, B, bend, A]);
  });

  it('doubles the distance', () => {
    const line = [A, B, C];
    expect(polylineLengthM(outAndBack(line))).toBeCloseTo(2 * polylineLengthM(line), 6);
  });

  it("climbs the outbound's descent on the way back", () => {
    // Up 200 m, down 100 m going out: back, it is up 100 m and down 200 m.
    const out = [100, 300, 200];
    const there = elevationGainLoss(out, { threshold: 1 });
    const both = elevationGainLoss([...out, ...[...out].reverse().slice(1)], { threshold: 1 });
    expect(there).toMatchObject({ ascentM: 200, descentM: 100 });
    expect(both).toMatchObject({ ascentM: 300, descentM: 300 });
  });
});

describe('the out-and-back profile', () => {
  it('mirrors around the turnaround, which sits at half the distance', () => {
    const samples = densifyLine(outAndBack([A, B, C]), ROUTE_SAMPLE_STEP_M);
    const profile = buildDrawProfile(samples, samples.map(terrain))!;
    const n = profile.points.length;
    // The top (C) is the turnaround, half-way along.
    const top = profile.points.reduce((a, b) => (b.elevationM > a.elevationM ? b : a));
    expect(top.distanceM / profile.totalM).toBeCloseTo(0.5, 2);
    expect(profile.points[0]!.elevationM).toBeCloseTo(profile.points[n - 1]!.elevationM, 6);
    // Scrubbing works across both halves: equal elevations at mirrored positions.
    for (const r of [0.1, 0.25, 0.4]) {
      expect(scrubProfile(profile, r)!.elevationM).toBeCloseTo(
        scrubProfile(profile, 1 - r)!.elevationM,
        0,
      );
    }
    expect(scrubProfile(profile, 0.25)!.gradePct).toBeGreaterThan(0);
    expect(scrubProfile(profile, 0.75)!.gradePct).toBeLessThan(0);
  });
});

describe('editing and saving', () => {
  it('is a setting of the route tool, kept by undo and by load, never on an area', () => {
    let s = initialDrawState('route', [A, B]);
    expect(s.finish).toBe('oneway');
    s = drawReducer(s, { type: 'finish', finish: 'backforth' });
    expect(s.finish).toBe('backforth');
    expect(s.past).toHaveLength(0); // not an edit
    expect(drawReducer(s, { type: 'finish', finish: 'backforth' })).toBe(s);
    s = drawReducer(s, { type: 'add', at: C });
    expect(drawReducer(s, { type: 'undo' }).finish).toBe('backforth');
    expect(drawReducer(s, { type: 'load', vertices: [A, B] }).finish).toBe('backforth');
    const area = initialDrawState('area', [A, B, C], undefined, 'freehand', 'loop');
    expect(area.finish).toBe('oneway');
    expect(drawReducer(area, { type: 'finish', finish: 'loop' })).toBe(area);
  });

  it('the plan keeps the finish and the placed points; old plans read as one way', () => {
    const plan = buildRoutePlan([A, B, C], ['trails', 'trails'], 'trails', 'backforth');
    expect(plan).toEqual({
      mode: 'trails',
      vertices: [A, B, C],
      legModes: ['trails', 'trails'],
      finish: 'backforth',
    });
    expect(sanitizeRoutePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const loop = buildRoutePlan([A, B, C], [], 'freehand', 'loop');
    expect(loop).toEqual({ mode: 'freehand', vertices: [A, B, C], finish: 'loop' });
    expect(sanitizeRoutePlan(JSON.parse(JSON.stringify(loop)))).toEqual(loop);
    expect(buildRoutePlan([A, B], [], 'freehand')).not.toHaveProperty('finish');
    expect(buildRoutePlan([A, B], [], 'freehand', 'oneway')).not.toHaveProperty('finish');
    expect(sanitizeRoutePlan({ mode: 'freehand', vertices: [A, B] })).not.toHaveProperty('finish');
    expect(
      sanitizeRoutePlan({ mode: 'freehand', vertices: [A, B], finish: 'spiral' }),
    ).not.toHaveProperty('finish');
  });

  it('reads the older backAndForth: true as back & forth (and nothing else turns it on)', () => {
    expect(sanitizeRoutePlan({ mode: 'freehand', vertices: [A, B], backAndForth: true })).toEqual({
      mode: 'freehand',
      vertices: [A, B],
      finish: 'backforth',
    });
    expect(
      sanitizeRoutePlan({ mode: 'freehand', vertices: [A, B], backAndForth: 'yes' }),
    ).not.toHaveProperty('finish');
    // An explicit finish wins over the legacy flag.
    expect(
      sanitizeRoutePlan({ mode: 'freehand', vertices: [A, B], finish: 'loop', backAndForth: true })
        ?.finish,
    ).toBe('loop');
  });

  it('"Edit route" cuts the saved out-and-back at the turnaround before re-seeding legs', () => {
    const bend: LngLat = [-70.909, 47.079];
    const saved = outAndBack([A, bend, B, C]);
    const outbound = outboundOf(saved, C);
    expect(outbound).toEqual([A, bend, B, C]);
    const seeded = seedResultsFromLine(outbound, [A, B, C], ['trails', 'trails']);
    expect(seeded.get(legKey('trails', A, B))).toEqual({ status: 'routed', coords: [A, bend, B] });
    expect(seeded.get(legKey('trails', B, C))).toEqual({ status: 'routed', coords: [B, C] });
    expect(outboundOf([A], A)).toEqual([A]);
  });
});
