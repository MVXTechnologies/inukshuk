import type { LngLat, RouteFinish } from '@core/models';

import { fitModes, type LegMode } from './legs';

/**
 * The drawing tools' state machine (#502 routes, #503 areas): one list of
 * vertices and an undo history. Every edit — add, move, insert, delete and
 * clear — is one undo step, so Undo walks back exactly what the finger did,
 * and a Clear by mistake is one Undo away.
 *
 * A route also carries one mode per leg (#515: Trails, Roads or Freehand —
 * `modes[i]` is the leg from vertex i to i+1) and the mode new legs get (the
 * selected chip). Leg modes are part of every undo step; switching the chip
 * is not an edit (it changes no line already drawn).
 *
 * Pure: the map screen feeds it taps and drags, and renders what it holds.
 */

export type DrawKind = 'route' | 'area';

/** One undoable shape: the vertices and the mode of each leg between them. */
export interface DrawSnapshot {
  vertices: readonly LngLat[];
  modes: readonly LegMode[];
}

export interface DrawState {
  kind: DrawKind;
  vertices: readonly LngLat[];
  /** Per leg (`vertices.length - 1` of them): how it is drawn. Areas: all Freehand. */
  modes: readonly LegMode[];
  /** The mode the next leg gets (the selected chip). */
  mode: LegMode;
  /**
   * How the route ends: one way, back & forth (the outbound reversed back to
   * the start) or a loop (a closing leg from the last point to the first).
   * Both are derived, never edited — only the placed vertices are. A setting
   * like the chip, not an undo step.
   */
  finish: RouteFinish;
  /** Earlier shapes, newest last (capped at {@link MAX_UNDO}). */
  past: readonly DrawSnapshot[];
  /** The tapped vertex (its delete button shows), or null. */
  selected: number | null;
}

export type DrawAction =
  | { type: 'add'; at: LngLat }
  | { type: 'move'; index: number; at: LngLat }
  | { type: 'insert'; index: number; at: LngLat }
  | { type: 'remove'; index: number }
  | { type: 'select'; index: number | null }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'mode'; mode: LegMode }
  | { type: 'finish'; finish: RouteFinish }
  | { type: 'load'; vertices: readonly LngLat[]; modes?: readonly LegMode[] };

/** Undo depth: plenty for a hand-drawn line, bounded so memory is too. */
export const MAX_UNDO = 100;

/** Fewest vertices that make something worth saving. */
export const MIN_VERTICES: Record<DrawKind, number> = { route: 2, area: 3 };

export function initialDrawState(
  kind: DrawKind,
  vertices: readonly LngLat[] = [],
  modes?: readonly LegMode[],
  mode: LegMode = 'freehand',
  finish: RouteFinish = 'oneway',
): DrawState {
  return {
    kind,
    vertices: [...vertices],
    modes: kind === 'route' ? fitModes(modes, vertices.length) : fitModes([], vertices.length),
    mode,
    finish: kind === 'route' ? finish : 'oneway',
    past: [],
    selected: null,
  };
}

const finite = (p: LngLat): boolean =>
  Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;

/** Commit a new shape as one undoable step. */
function commit(
  state: DrawState,
  vertices: LngLat[],
  modes: LegMode[],
  selected: number | null,
): DrawState {
  const past = [...state.past, { vertices: state.vertices, modes: state.modes }];
  return {
    ...state,
    vertices,
    modes,
    past: past.length > MAX_UNDO ? past.slice(past.length - MAX_UNDO) : past,
    selected,
  };
}

/** The leg modes after removing vertex `index`: an inner vertex merges its two legs. */
function modesWithout(modes: readonly LegMode[], index: number, count: number): LegMode[] {
  if (count <= 1) return [];
  if (index === 0) return modes.slice(1);
  if (index >= count - 1) return modes.slice(0, count - 2);
  // Legs index-1 and index become one, made the way the first of them was.
  return [...modes.slice(0, index), ...modes.slice(index + 1)];
}

const inRange = (state: DrawState, index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < state.vertices.length;

export function drawReducer(state: DrawState, action: DrawAction): DrawState {
  switch (action.type) {
    case 'add':
      if (!finite(action.at)) return state;
      return commit(
        state,
        [...state.vertices, action.at],
        state.vertices.length > 0 ? [...state.modes, state.mode] : [],
        null,
      );
    case 'move': {
      if (!inRange(state, action.index) || !finite(action.at)) return state;
      const current = state.vertices[action.index];
      // A drag that ended where it began is not an edit (no empty undo step).
      if (current !== undefined && current[0] === action.at[0] && current[1] === action.at[1]) {
        return state;
      }
      const next = [...state.vertices];
      next[action.index] = action.at;
      return commit(state, next, [...state.modes], state.selected);
    }
    case 'insert': {
      const { index } = action;
      if (!Number.isInteger(index) || index < 0 || index > state.vertices.length) return state;
      if (!finite(action.at)) return state;
      const next = [...state.vertices];
      next.splice(index, 0, action.at);
      const n = state.vertices.length;
      // Inside a leg: both halves keep its mode. At either end: a new leg.
      const modes = [...state.modes];
      if (n === 0) modes.length = 0;
      else if (index === 0) modes.unshift(state.mode);
      else if (index === n) modes.push(state.mode);
      else modes.splice(index - 1, 0, state.modes[index - 1] ?? state.mode);
      return commit(state, next, modes, null);
    }
    case 'remove': {
      if (!inRange(state, action.index)) return state;
      const next = state.vertices.filter((_, i) => i !== action.index);
      return commit(
        state,
        next,
        modesWithout(state.modes, action.index, state.vertices.length),
        null,
      );
    }
    case 'select':
      if (action.index !== null && !inRange(state, action.index)) return state;
      return state.selected === action.index ? state : { ...state, selected: action.index };
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        ...state,
        vertices: previous.vertices,
        modes: previous.modes,
        past: state.past.slice(0, -1),
        selected: null,
      };
    }
    case 'clear':
      if (state.vertices.length === 0) return state;
      return commit(state, [], [], null);
    case 'mode':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'finish':
      if (state.kind !== 'route' || state.finish === action.finish) return state;
      return { ...state, finish: action.finish };
    case 'load': {
      // Drop junk vertices together with the legs they start.
      const kept = action.vertices.map((v, i) => ({ v, m: action.modes?.[i] }));
      const ok = kept.filter((k) => finite(k.v));
      return initialDrawState(
        state.kind,
        ok.map((k) => k.v),
        ok.slice(0, -1).map((k) => k.m ?? 'freehand'),
        state.mode,
        state.finish,
      );
    }
  }
}

export const canUndo = (state: DrawState): boolean => state.past.length > 0;

/** Enough vertices to save: 2 for a route, 3 for an area. */
export const canSave = (state: DrawState): boolean =>
  state.vertices.length >= MIN_VERTICES[state.kind];

/** The one-line hint under the mode chips / in the panel for the current state. */
export function drawHint(state: DrawState): string {
  const n = state.vertices.length;
  if (state.kind === 'route') {
    if (n === 0) return 'Tap the map to start your route';
    if (n === 1) {
      if (state.mode === 'trails') return 'Tap to add the next point; the line follows trails';
      if (state.mode === 'roads') return 'Tap to add the next point; the line follows roads';
      return 'Tap to add the next point; straight lines between them';
    }
    return 'Tap a point to drag or delete it; tap a midpoint to add one';
  }
  if (n === 0) return 'Tap the map to place the first corner';
  if (n < 3) return `Tap ${3 - n} more corner${3 - n === 1 ? '' : 's'} to close the area`;
  return 'Tap a corner to drag or delete it; tap a midpoint to add one';
}
