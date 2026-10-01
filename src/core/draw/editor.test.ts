import type { LngLat } from '@core/models';

import {
  canSave,
  canUndo,
  drawHint,
  drawReducer,
  initialDrawState,
  MAX_UNDO,
  type DrawAction,
  type DrawState,
} from './editor';

const A: LngLat = [-71.21, 46.81];
const B: LngLat = [-71.2, 46.815];
const C: LngLat = [-71.19, 46.82];
const D: LngLat = [-71.18, 46.818];

const run = (state: DrawState, ...actions: DrawAction[]) => actions.reduce(drawReducer, state);
const add = (at: LngLat): DrawAction => ({ type: 'add', at });

describe('drawReducer', () => {
  it('adds vertices in order, each one undoable', () => {
    const s = run(initialDrawState('route'), add(A), add(B), add(C));
    expect(s.vertices).toEqual([A, B, C]);
    expect(s.past).toHaveLength(3);
    expect(run(s, { type: 'undo' }).vertices).toEqual([A, B]);
  });

  it('moves a vertex (one undo step) and ignores a no-op drag', () => {
    const s = run(initialDrawState('route'), add(A), add(B));
    const moved = drawReducer(s, { type: 'move', index: 1, at: C });
    expect(moved.vertices).toEqual([A, C]);
    expect(drawReducer(moved, { type: 'undo' }).vertices).toEqual([A, B]);
    expect(drawReducer(s, { type: 'move', index: 1, at: [...B] as LngLat })).toBe(s);
  });

  it('inserts at a midpoint index', () => {
    const s = run(initialDrawState('route'), add(A), add(C));
    expect(drawReducer(s, { type: 'insert', index: 1, at: B }).vertices).toEqual([A, B, C]);
    // The closing segment of an area inserts at the end.
    expect(drawReducer(s, { type: 'insert', index: 2, at: D }).vertices).toEqual([A, C, D]);
  });

  it('removes a vertex and clears the selection', () => {
    const s = run(initialDrawState('area'), add(A), add(B), add(C), {
      type: 'select',
      index: 1,
    });
    expect(s.selected).toBe(1);
    const removed = drawReducer(s, { type: 'remove', index: 1 });
    expect(removed.vertices).toEqual([A, C]);
    expect(removed.selected).toBeNull();
  });

  it('clear empties the line and is itself undoable', () => {
    const s = run(initialDrawState('route'), add(A), add(B), { type: 'clear' });
    expect(s.vertices).toEqual([]);
    expect(drawReducer(s, { type: 'undo' }).vertices).toEqual([A, B]);
    // Clearing nothing is not a step.
    const empty = initialDrawState('route');
    expect(drawReducer(empty, { type: 'clear' })).toBe(empty);
  });

  it('undo with no history is a no-op', () => {
    const s = initialDrawState('route');
    expect(drawReducer(s, { type: 'undo' })).toBe(s);
    expect(canUndo(s)).toBe(false);
  });

  it('rejects out-of-range indices and non-finite points', () => {
    const s = run(initialDrawState('route'), add(A));
    expect(drawReducer(s, { type: 'move', index: 5, at: B })).toBe(s);
    expect(drawReducer(s, { type: 'remove', index: -1 })).toBe(s);
    expect(drawReducer(s, { type: 'insert', index: 3, at: B })).toBe(s);
    expect(drawReducer(s, { type: 'insert', index: 0, at: [Number.NaN, 0] })).toBe(s);
    expect(drawReducer(s, { type: 'move', index: 0, at: [0, 95] })).toBe(s);
    expect(drawReducer(s, add([Number.POSITIVE_INFINITY, 0]))).toBe(s);
    expect(drawReducer(s, { type: 'select', index: 4 })).toBe(s);
  });

  it('select toggles which vertex shows its delete button', () => {
    const s = run(initialDrawState('route'), add(A), add(B));
    const selected = drawReducer(s, { type: 'select', index: 0 });
    expect(selected.selected).toBe(0);
    expect(drawReducer(selected, { type: 'select', index: 0 })).toBe(selected);
    expect(drawReducer(selected, { type: 'select', index: null }).selected).toBeNull();
    // Selecting is not an edit.
    expect(selected.past).toHaveLength(2);
  });

  it('load replaces the vertices with a fresh history ("Edit route")', () => {
    const s = run(initialDrawState('route'), add(A));
    const loaded = drawReducer(s, { type: 'load', vertices: [B, C, [Number.NaN, 1]] });
    expect(loaded.vertices).toEqual([B, C]);
    expect(loaded.past).toEqual([]);
    expect(loaded.kind).toBe('route');
  });

  it('caps the undo history', () => {
    let s = initialDrawState('route');
    for (let i = 0; i < MAX_UNDO + 20; i++) s = drawReducer(s, add([i * 0.001, 46]));
    expect(s.past).toHaveLength(MAX_UNDO);
    expect(s.vertices).toHaveLength(MAX_UNDO + 20);
  });
});

describe('canSave', () => {
  it('a route needs two points, an area three', () => {
    expect(canSave(run(initialDrawState('route'), add(A)))).toBe(false);
    expect(canSave(run(initialDrawState('route'), add(A), add(B)))).toBe(true);
    expect(canSave(run(initialDrawState('area'), add(A), add(B)))).toBe(false);
    expect(canSave(run(initialDrawState('area'), add(A), add(B), add(C)))).toBe(true);
  });
});

describe('drawHint', () => {
  it('walks the user through each stage', () => {
    expect(drawHint(initialDrawState('route'))).toMatch(/start your route/);
    expect(drawHint(run(initialDrawState('route'), add(A)))).toMatch(/straight lines/);
    expect(drawHint(run(initialDrawState('route'), add(A), add(B)))).toMatch(/Drag a point/);
    expect(drawHint(initialDrawState('area'))).toMatch(/first corner/);
    expect(drawHint(run(initialDrawState('area'), add(A)))).toBe(
      'Tap 2 more corners to close the area',
    );
    expect(drawHint(run(initialDrawState('area'), add(A), add(B)))).toBe(
      'Tap 1 more corner to close the area',
    );
    expect(drawHint(run(initialDrawState('area'), add(A), add(B), add(C)))).toMatch(
      /Drag a corner/,
    );
  });
});
