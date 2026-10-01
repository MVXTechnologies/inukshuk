import type { LngLat } from '@core/models';

import { drawReducer, initialDrawState, type DrawAction, type DrawState } from './editor';
import { polylineLengthM } from './geometry';
import {
  anchorLeg,
  capResults,
  failedLegs,
  fitModes,
  halfwayAlong,
  isLegMode,
  isRoutedMode,
  legKey,
  legMidpointHandles,
  legViews,
  mergeLegs,
  pendingLegs,
  routeLengthM,
  seedResultsFromLine,
  withoutFailures,
  type LegMode,
  type LegResult,
} from './legs';

// Mont-Sainte-Anne-ish, a few hundred metres apart.
const A: LngLat = [-70.9065, 47.0753];
const B: LngLat = [-70.912, 47.078];
const C: LngLat = [-70.92, 47.081];
const D: LngLat = [-70.93, 47.085];

/** A fake routed leg: a dog-leg through a point beside the chord. */
const bend = (from: LngLat, to: LngLat): LngLat[] => [
  [from[0] + 0.00001, from[1]],
  [(from[0] + to[0]) / 2, to[1]],
  [to[0], to[1] + 0.00001],
];
const routed = (from: LngLat, to: LngLat): LegResult => ({
  status: 'routed',
  coords: bend(from, to),
});

const run = (state: DrawState, ...actions: DrawAction[]) => actions.reduce(drawReducer, state);
const add = (at: LngLat): DrawAction => ({ type: 'add', at });
const mode = (m: LegMode): DrawAction => ({ type: 'mode', mode: m });

describe('leg keys and anchoring', () => {
  it('keys a leg by mode and both ends to ~0.1 m', () => {
    expect(legKey('trails', A, B)).toBe('trails|-70.906500,47.075300|-70.912000,47.078000');
    expect(legKey('trails', A, B)).toBe(legKey('trails', [A[0] + 1e-8, A[1]], B));
    expect(legKey('roads', A, B)).not.toBe(legKey('trails', A, B));
    expect(legKey('trails', B, A)).not.toBe(legKey('trails', A, B));
  });

  it('ties the routed line to the control points, without doubling a point already there', () => {
    const line = anchorLeg(A, [A, [-70.909, 47.076], B], B);
    expect(line).toEqual([A, [-70.909, 47.076], B]);
    // Snapped ends a few metres off: short connectors to the points placed.
    const off = anchorLeg(
      A,
      [
        [-70.9066, 47.0754],
        [-70.9119, 47.0779],
      ],
      B,
    );
    expect(off[0]).toEqual(A);
    expect(off[off.length - 1]).toEqual(B);
    expect(off).toHaveLength(4);
  });

  it('knows its modes', () => {
    expect(isLegMode('trails')).toBe(true);
    expect(isLegMode('boat')).toBe(false);
    expect(isRoutedMode('freehand')).toBe(false);
    expect(isRoutedMode('roads')).toBe(true);
    expect(fitModes(['trails', 'nope'], 4)).toEqual(['trails', 'freehand', 'freehand']);
    expect(fitModes(undefined, 3, 'roads')).toEqual(['roads', 'roads']);
    expect(fitModes(['trails'], 0)).toEqual([]);
  });
});

describe('legViews', () => {
  it('draws freehand legs straight, routed legs from results, the rest loading', () => {
    const results = new Map<string, LegResult>([[legKey('trails', A, B), routed(A, B)]]);
    const views = legViews([A, B, C, D], ['trails', 'trails', 'freehand'], results);
    expect(views.map((v) => v.status)).toEqual(['routed', 'loading', 'straight']);
    expect(views[0]!.coords[0]).toEqual(A);
    expect(views[0]!.coords[views[0]!.coords.length - 1]).toEqual(B);
    expect(views[1]!.coords).toEqual([B, C]); // a straight placeholder while loading
    expect(pendingLegs(views)).toEqual([
      { key: legKey('trails', B, C), mode: 'trails', from: B, to: C },
    ]);
  });

  it('falls back to a straight line, flagged, when routing failed', () => {
    const results = new Map<string, LegResult>([
      [legKey('roads', A, B), { status: 'failed', reason: 'offline' }],
    ]);
    const views = legViews([A, B], ['roads'], results);
    expect(views[0]).toMatchObject({ status: 'failed', reason: 'offline', coords: [A, B] });
    expect(failedLegs(views)).toHaveLength(1);
    expect(pendingLegs(views)).toEqual([]);
    // Retry: the failure is forgotten, so the leg is asked again.
    const retried = legViews([A, B], ['roads'], withoutFailures(results, views));
    expect(retried[0]!.status).toBe('loading');
  });

  it('treats a missing mode as freehand and needs two points for a leg', () => {
    expect(legViews([A, B], [], new Map())[0]!.status).toBe('straight');
    expect(legViews([A], ['trails'], new Map())).toEqual([]);
  });

  it('asks once for two identical legs (an out-and-back retraced)', () => {
    const views = legViews([A, B, A, B], ['trails', 'trails', 'trails'], new Map());
    expect(pendingLegs(views).map((p) => p.key)).toEqual([
      legKey('trails', A, B),
      legKey('trails', B, A),
    ]);
  });
});

describe('merging and measuring', () => {
  it('joins the legs into one polyline, each joint once', () => {
    const results = new Map<string, LegResult>([
      [legKey('trails', A, B), routed(A, B)],
      [legKey('trails', B, C), routed(B, C)],
    ]);
    const views = legViews([A, B, C, D], ['trails', 'trails', 'freehand'], results);
    const line = mergeLegs(views);
    const count = views.reduce((n, v) => n + v.coords.length, 0) - (views.length - 1);
    expect(line).toHaveLength(count);
    expect(line.filter((p) => p === B)).toHaveLength(1);
    expect(line[line.length - 1]).toEqual(D);
    // The stats measure what is drawn: the bends make it longer than the chords.
    expect(routeLengthM(views)).toBeCloseTo(polylineLengthM(line), 6);
    expect(routeLengthM(views)).toBeGreaterThan(polylineLengthM([A, B, C, D]));
    expect(mergeLegs([])).toEqual([]);
  });

  it('puts insert handles halfway along each drawn leg', () => {
    const results = new Map<string, LegResult>([[legKey('trails', A, C), routed(A, C)]]);
    const views = legViews([A, C, D], ['trails', 'freehand'], results);
    const handles = legMidpointHandles(views);
    expect(handles.map((h) => h.insertAt)).toEqual([1, 2]);
    // The routed leg's handle lies on the bend, not on the straight chord's middle.
    const chordMid: LngLat = [(A[0] + C[0]) / 2, (A[1] + C[1]) / 2];
    expect(handles[0]!.at).not.toEqual(chordMid);
    expect(handles[1]!.at[0]).toBeCloseTo((C[0] + D[0]) / 2, 6);
    expect(halfwayAlong([])).toBeNull();
    expect(halfwayAlong([A])).toEqual(A);
  });

  it('caps the result memory to the newest entries', () => {
    const m = new Map<string, LegResult>([
      ['a', { status: 'failed', reason: 'busy' }],
      ['b', { status: 'failed', reason: 'busy' }],
      ['c', { status: 'failed', reason: 'busy' }],
    ]);
    expect([...capResults(m, 2).keys()]).toEqual(['b', 'c']);
    expect(capResults(m, 5).size).toBe(3);
  });
});

describe('editing a routed route', () => {
  /** Simulate the proxy answering every pending leg. */
  const answer = (state: DrawState, results: Map<string, LegResult>) => {
    const asked: string[] = [];
    for (const p of pendingLegs(legViews(state.vertices, state.modes, results))) {
      asked.push(p.key);
      results.set(p.key, routed(p.from, p.to));
    }
    return asked;
  };

  it('routes each new leg once; a drag re-routes only the legs touching the point', () => {
    const results = new Map<string, LegResult>();
    let s = run(initialDrawState('route'), mode('trails'), add(A), add(B), add(C), add(D));
    expect(s.modes).toEqual(['trails', 'trails', 'trails']);
    expect(answer(s, results)).toHaveLength(3);
    expect(answer(s, results)).toHaveLength(0);

    s = drawReducer(s, { type: 'move', index: 2, at: [-70.921, 47.082] });
    const asked = answer(s, results);
    expect(asked).toEqual([
      legKey('trails', B, [-70.921, 47.082]),
      legKey('trails', [-70.921, 47.082], D),
    ]);
  });

  it('inserting a point splits one leg into two of the same mode; only those are routed', () => {
    const results = new Map<string, LegResult>();
    let s = run(initialDrawState('route'), mode('roads'), add(A), add(C), mode('freehand'), add(D));
    expect(s.modes).toEqual(['roads', 'freehand']);
    answer(s, results);
    s = drawReducer(s, { type: 'insert', index: 1, at: B });
    expect(s.modes).toEqual(['roads', 'roads', 'freehand']);
    expect(answer(s, results)).toEqual([legKey('roads', A, B), legKey('roads', B, C)]);
  });

  it('undo restores earlier legs from memory, with no new request', () => {
    const results = new Map<string, LegResult>();
    let s = run(initialDrawState('route'), mode('trails'), add(A), add(B), add(C));
    answer(s, results);
    s = drawReducer(s, { type: 'move', index: 1, at: [-70.915, 47.079] });
    answer(s, results);
    s = drawReducer(s, { type: 'undo' });
    expect(s.vertices).toEqual([A, B, C]);
    expect(answer(s, results)).toEqual([]);
    expect(legViews(s.vertices, s.modes, results).every((v) => v.status === 'routed')).toBe(true);
  });

  it('switching the chip keeps the legs already drawn', () => {
    const s = run(initialDrawState('route'), mode('trails'), add(A), add(B), mode('roads'), add(C));
    expect(s.modes).toEqual(['trails', 'roads']);
    expect(s.mode).toBe('roads');
    // Switching is not an undo step.
    expect(s.past).toHaveLength(3);
  });

  it('removing an inner point merges its legs in the first leg’s mode; an end drops its leg', () => {
    const s = run(
      initialDrawState('route'),
      mode('trails'),
      add(A),
      add(B),
      mode('roads'),
      add(C),
      mode('freehand'),
      add(D),
    );
    expect(drawReducer(s, { type: 'remove', index: 1 }).modes).toEqual(['trails', 'freehand']);
    expect(drawReducer(s, { type: 'remove', index: 0 }).modes).toEqual(['roads', 'freehand']);
    expect(drawReducer(s, { type: 'remove', index: 3 }).modes).toEqual(['trails', 'roads']);
  });
});

describe('seedResultsFromLine', () => {
  it('cuts a saved line at the control points into routed legs (Edit route offline)', () => {
    const results = new Map<string, LegResult>([
      [legKey('trails', A, B), routed(A, B)],
      [legKey('trails', B, C), routed(B, C)],
    ]);
    const vertices = [A, B, C, D];
    const modes: LegMode[] = ['trails', 'trails', 'freehand'];
    const line = mergeLegs(legViews(vertices, modes, results));
    const seeded = seedResultsFromLine(line, vertices, modes);
    expect([...seeded.keys()]).toEqual([legKey('trails', A, B), legKey('trails', B, C)]);
    const views = legViews(vertices, modes, seeded);
    expect(views.map((v) => v.status)).toEqual(['routed', 'routed', 'straight']);
    expect(routeLengthM(views)).toBeCloseTo(polylineLengthM(line), 3);
  });

  it('seeds nothing from too little', () => {
    expect(seedResultsFromLine([A], [A, B], ['trails']).size).toBe(0);
    expect(seedResultsFromLine([A, B], [A], []).size).toBe(0);
  });
});
