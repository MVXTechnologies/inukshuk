/**
 * Loop (#515): a closing leg from the last point back to the first, in the
 * last leg's mode — routed, measured and saved like any leg, re-routed only
 * when the first or last point (or that mode) changes, never edited directly.
 */
import type { LngLat } from '@core/models';
import { haversineM } from '@core/trails/geometry';

import { drawReducer, initialDrawState } from './editor';
import { polylineLengthM } from './geometry';
import { hitHandle, START_HIT_PX } from './hitTest';
import {
  canLoop,
  LOOP_HINT_M,
  LOOP_MIN_GAP_M,
  legKey,
  legMidpointHandles,
  legViews,
  mergeLegs,
  nearStart,
  pendingLegs,
  routeLengthM,
  seedResultsFromLine,
  withoutFailures,
  type LegResult,
} from './legs';

const A: LngLat = [-70.9065, 47.0753];
const B: LngLat = [-70.912, 47.078];
const C: LngLat = [-70.92, 47.081];
const D: LngLat = [-70.915, 47.075];

const bend = (from: LngLat, to: LngLat): LegResult => ({
  status: 'routed',
  coords: [from, [(from[0] + to[0]) / 2, to[1]], to],
});

describe('the closing leg', () => {
  it('runs last → first in the last leg’s mode, tagged, after the others', () => {
    const views = legViews([A, B, C], ['freehand', 'trails'], new Map(), { loop: true });
    expect(views).toHaveLength(3);
    const closing = views[2]!;
    expect(closing).toMatchObject({ index: 2, mode: 'trails', from: C, to: A, closing: true });
    expect(closing.status).toBe('loading');
    expect(pendingLegs(views).map((p) => p.key)).toEqual([
      legKey('trails', B, C),
      legKey('trails', C, A),
    ]);
    // Without loop: no closing leg.
    expect(legViews([A, B, C], ['freehand', 'trails'], new Map())).toHaveLength(2);
  });

  it('a Freehand last leg closes with a straight line (no request)', () => {
    const views = legViews([A, B, C], ['trails', 'freehand'], new Map(), { loop: true });
    expect(views[2]).toMatchObject({ status: 'straight', coords: [C, A], closing: true });
  });

  it('routed: merged into the line, which ends at the start; measured too', () => {
    const results = new Map<string, LegResult>([
      [legKey('trails', A, B), bend(A, B)],
      [legKey('trails', B, C), bend(B, C)],
      [legKey('trails', C, A), bend(C, A)],
    ]);
    const views = legViews([A, B, C], ['trails', 'trails'], results, { loop: true });
    expect(views.every((v) => v.status === 'routed')).toBe(true);
    const line = mergeLegs(views);
    expect(line[0]).toEqual(A);
    expect(line[line.length - 1]).toEqual(A);
    const open = legViews([A, B, C], ['trails', 'trails'], results);
    expect(routeLengthM(views)).toBeCloseTo(
      routeLengthM(open) + polylineLengthM([C, [(C[0] + A[0]) / 2, A[1]], A]),
      3,
    );
  });

  it('failed falls back straight, and Retry asks again', () => {
    const results = new Map<string, LegResult>([
      [legKey('roads', C, A), { status: 'failed', reason: 'offline' }],
    ]);
    const views = legViews([A, B, C], ['freehand', 'roads'], results, { loop: true });
    expect(views[2]).toMatchObject({ status: 'failed', coords: [C, A], closing: true });
    const retried = legViews([A, B, C], ['freehand', 'roads'], withoutFailures(results, views), {
      loop: true,
    });
    expect(retried[2]!.status).toBe('loading');
  });

  it('is re-routed only when the first or last point, or the last leg’s mode, changes', () => {
    const key = (vs: LngLat[], modes: ('trails' | 'roads' | 'freehand')[]) =>
      legViews(vs, modes, new Map(), { loop: true }).find((v) => v.closing)!;
    const closingKey = (vs: LngLat[], modes: ('trails' | 'roads' | 'freehand')[]) => {
      const c = key(vs, modes);
      return legKey(c.mode, c.from, c.to);
    };
    const base = closingKey([A, B, C], ['trails', 'trails']);
    // A middle point moved, or a middle leg's mode changed: same closing leg.
    expect(closingKey([A, D, C], ['trails', 'trails'])).toBe(base);
    expect(closingKey([A, B, C], ['roads', 'trails'])).toBe(base);
    // First point, last point, or the last leg's mode: a new closing leg.
    expect(closingKey([D, B, C], ['trails', 'trails'])).not.toBe(base);
    expect(closingKey([A, B, D], ['trails', 'trails'])).not.toBe(base);
    expect(closingKey([A, B, C], ['trails', 'roads'])).not.toBe(base);
  });

  it('takes no insert handle (it is never edited directly)', () => {
    const views = legViews([A, B, C], ['freehand', 'freehand'], new Map(), { loop: true });
    expect(legMidpointHandles(views).map((h) => h.insertAt)).toEqual([1, 2]);
  });

  it('"Edit route" rebuilds the closing leg from the saved line', () => {
    const results = new Map<string, LegResult>([
      [legKey('trails', A, B), bend(A, B)],
      [legKey('trails', B, C), bend(B, C)],
      [legKey('trails', C, A), bend(C, A)],
    ]);
    const saved = mergeLegs(legViews([A, B, C], ['trails', 'trails'], results, { loop: true }));
    const seeded = seedResultsFromLine(saved, [A, B, C, A], ['trails', 'trails', 'trails']);
    const reopened = legViews([A, B, C], ['trails', 'trails'], seeded, { loop: true });
    expect(reopened.map((v) => v.status)).toEqual(['routed', 'routed', 'routed']);
    expect(mergeLegs(reopened)).toEqual(saved);
  });
});

describe('when a loop is possible, and when to suggest it', () => {
  it('needs 3 points, or 2 more than 50 m apart', () => {
    expect(canLoop([A])).toBe(false);
    expect(canLoop([A, B])).toBe(haversineM(A, B) > LOOP_MIN_GAP_M);
    expect(canLoop([A, [A[0] + 0.0001, A[1]]])).toBe(false); // ~8 m
    expect(canLoop([A, B, C])).toBe(true);
    // A closed loop on two points too close is just not drawn.
    expect(
      legViews([A, [A[0] + 0.0001, A[1]]], ['freehand'], new Map(), { loop: true }),
    ).toHaveLength(1);
  });

  it('suggests tapping the start when the last of 3+ points is within 150 m of it', () => {
    const near: LngLat = [A[0] + 0.001, A[1]]; // ~76 m
    expect(haversineM(A, near)).toBeLessThan(LOOP_HINT_M);
    expect(nearStart([A, B, near])).toBe(true);
    expect(nearStart([A, near])).toBe(false);
    expect(nearStart([A, B, C])).toBe(false);
  });
});

describe('the start point’s target', () => {
  it('wins within its larger radius when it can close a loop, ahead of the last point', () => {
    const v = [[100, 100] as const, [300, 100] as const, [130, 100] as const];
    // 28 px from the start, 2 px from the last point placed.
    expect(hitHandle(v, [], [128, 100])).toEqual({ kind: 'vertex', index: 2 });
    expect(hitHandle(v, [], [128, 100], { startFirst: true })).toEqual({
      kind: 'vertex',
      index: 0,
    });
    expect(hitHandle(v, [], [100 + START_HIT_PX + 1, 100], { startFirst: true })).toEqual({
      kind: 'vertex',
      index: 2,
    });
  });
});

describe('the editor', () => {
  it('Loop is a setting: kept through edits and undo', () => {
    let s = initialDrawState('route', [A, B, C]);
    s = drawReducer(s, { type: 'finish', finish: 'loop' });
    s = drawReducer(s, { type: 'add', at: D });
    expect(s.finish).toBe('loop');
    expect(drawReducer(s, { type: 'undo' }).finish).toBe('loop');
  });
});
