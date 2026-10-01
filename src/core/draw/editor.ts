import type { LngLat } from '@core/models';

/**
 * The drawing tools' state machine (#502 routes, #503 areas): one list of
 * vertices and an undo history. Every edit — add, move, insert, delete and
 * clear — is one undo step, so Undo walks back exactly what the finger did,
 * and a Clear by mistake is one Undo away.
 *
 * Pure: the map screen feeds it taps and drags, and renders what it holds.
 */

export type DrawKind = 'route' | 'area';

export interface DrawState {
  kind: DrawKind;
  vertices: readonly LngLat[];
  /** Earlier vertex lists, newest last (capped at {@link MAX_UNDO}). */
  past: readonly (readonly LngLat[])[];
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
  | { type: 'load'; vertices: readonly LngLat[] };

/** Undo depth: plenty for a hand-drawn line, bounded so memory is too. */
export const MAX_UNDO = 100;

/** Fewest vertices that make something worth saving. */
export const MIN_VERTICES: Record<DrawKind, number> = { route: 2, area: 3 };

export function initialDrawState(kind: DrawKind, vertices: readonly LngLat[] = []): DrawState {
  return { kind, vertices: [...vertices], past: [], selected: null };
}

const finite = (p: LngLat): boolean =>
  Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;

/** Commit a new vertex list as one undoable step. */
function commit(state: DrawState, vertices: LngLat[], selected: number | null): DrawState {
  const past = [...state.past, state.vertices];
  return {
    ...state,
    vertices,
    past: past.length > MAX_UNDO ? past.slice(past.length - MAX_UNDO) : past,
    selected,
  };
}

const inRange = (state: DrawState, index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < state.vertices.length;

export function drawReducer(state: DrawState, action: DrawAction): DrawState {
  switch (action.type) {
    case 'add':
      if (!finite(action.at)) return state;
      return commit(state, [...state.vertices, action.at], null);
    case 'move': {
      if (!inRange(state, action.index) || !finite(action.at)) return state;
      const current = state.vertices[action.index];
      // A drag that ended where it began is not an edit (no empty undo step).
      if (current !== undefined && current[0] === action.at[0] && current[1] === action.at[1]) {
        return state;
      }
      const next = [...state.vertices];
      next[action.index] = action.at;
      return commit(state, next, state.selected);
    }
    case 'insert': {
      const { index } = action;
      if (!Number.isInteger(index) || index < 0 || index > state.vertices.length) return state;
      if (!finite(action.at)) return state;
      const next = [...state.vertices];
      next.splice(index, 0, action.at);
      return commit(state, next, null);
    }
    case 'remove': {
      if (!inRange(state, action.index)) return state;
      const next = state.vertices.filter((_, i) => i !== action.index);
      return commit(state, next, null);
    }
    case 'select':
      if (action.index !== null && !inRange(state, action.index)) return state;
      return state.selected === action.index ? state : { ...state, selected: action.index };
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return { ...state, vertices: previous, past: state.past.slice(0, -1), selected: null };
    }
    case 'clear':
      if (state.vertices.length === 0) return state;
      return commit(state, [], null);
    case 'load':
      return initialDrawState(state.kind, action.vertices.filter(finite));
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
    if (n === 1) return 'Tap to add the next point; straight lines between them';
    return 'Drag a point to move it, a midpoint to add one; tap a point to delete it';
  }
  if (n === 0) return 'Tap the map to place the first corner';
  if (n < 3) return `Tap ${3 - n} more corner${3 - n === 1 ? '' : 's'} to close the area`;
  return 'Drag a corner to move it, a midpoint to add one; tap a corner to delete it';
}
