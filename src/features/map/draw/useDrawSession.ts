import {
  drawReducer,
  initialDrawState,
  type DrawAction,
  type DrawKind,
  type DrawState,
} from '@core/draw/editor';
import { midpointHandles, type MidpointHandle } from '@core/draw/geometry';
import type { HandleHit } from '@core/draw/hitTest';
import type { LegMode } from '@core/draw/legs';
import type { LngLat } from '@core/models';
import { useCallback, useMemo, useState } from 'react';

/**
 * What a drawing session is for: a new shape, or a saved route/area being
 * edited (its id, so Save updates it instead of adding a copy).
 */
export type DrawTarget = { kind: 'route'; trackId?: string } | { kind: 'area'; areaId?: string };

/** A vertex mid-drag: the shape follows it before the drag commits. */
interface DragPreview {
  index: number;
  at: LngLat;
}

export interface DrawSession {
  /** Null while no drawing tool is open. */
  state: DrawState | null;
  target: DrawTarget | null;
  /** The vertices to draw, with an in-flight drag applied. */
  shown: readonly LngLat[];
  /** Open a tool; a route may reopen with its legs' modes and the chip it was on. */
  start: (
    target: DrawTarget,
    vertices?: readonly LngLat[],
    modes?: readonly LegMode[],
    mode?: LegMode,
  ) => void;
  exit: () => void;
  dispatch: (action: DrawAction) => void;
  /**
   * A map tap: on a vertex it toggles that vertex's selection; on a
   * midpoint it inserts a vertex there (selected, ready to drag); elsewhere
   * it deselects, or — with nothing selected — adds a vertex. `mids` are the
   * midpoint handles the hit was tested against (a routed leg's sits on its
   * line); without them, the straight segments' middles.
   */
  tap: (at: LngLat, hit: HandleHit | null, mids?: readonly MidpointHandle[]) => void;
  /** The selected vertex follows the finger (not yet an edit). */
  dragTo: (index: number, at: LngLat) => void;
  /** The drag ended: one undoable move (null = cancelled). */
  dragEnd: (index: number, at: LngLat | null) => void;
}

/** The route chip last chosen: the next route opens on it (session memory). */
let lastMode: LegMode = 'freehand';

/** Test hook: forget the remembered chip. */
export function resetRouteModeMemory(): void {
  lastMode = 'freehand';
}

/**
 * The map screen's drawing-tool session (#502/#503): the pure editor
 * (`@core/draw/editor`) plus what only exists on screen — which saved item is
 * being edited, and the live drag preview.
 */
export function useDrawSession(): DrawSession {
  const [state, setState] = useState<DrawState | null>(null);
  const [target, setTarget] = useState<DrawTarget | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);

  const dispatch = useCallback((action: DrawAction) => {
    if (action.type === 'mode') lastMode = action.mode;
    setState((s) => (s === null ? s : drawReducer(s, action)));
  }, []);

  const start = useCallback(
    (
      next: DrawTarget,
      vertices: readonly LngLat[] = [],
      modes?: readonly LegMode[],
      mode?: LegMode,
    ) => {
      setTarget(next);
      setPreview(null);
      setState((s) =>
        // A new route keeps the chip the last one used.
        initialDrawState(next.kind as DrawKind, vertices, modes, mode ?? s?.mode ?? lastMode),
      );
    },
    [],
  );

  const exit = useCallback(() => {
    setState(null);
    setTarget(null);
    setPreview(null);
  }, []);

  const tap = useCallback((at: LngLat, hit: HandleHit | null, mids?: readonly MidpointHandle[]) => {
    setState((s) => {
      if (s === null) return s;
      if (hit?.kind === 'vertex') {
        return drawReducer(s, {
          type: 'select',
          index: s.selected === hit.index ? null : hit.index,
        });
      }
      if (hit?.kind === 'midpoint') {
        const m = (mids ?? midpointHandles(s.vertices, s.kind === 'area'))[hit.index];
        if (m === undefined) return s;
        const inserted = drawReducer(s, { type: 'insert', index: m.insertAt, at: m.at });
        return drawReducer(inserted, { type: 'select', index: m.insertAt });
      }
      if (s.selected !== null) return drawReducer(s, { type: 'select', index: null });
      return drawReducer(s, { type: 'add', at });
    });
  }, []);

  const dragTo = useCallback((index: number, at: LngLat) => setPreview({ index, at }), []);

  const dragEnd = useCallback((index: number, at: LngLat | null) => {
    setPreview(null);
    if (at === null) return;
    setState((s) => {
      if (s === null) return s;
      const moved = drawReducer(s, { type: 'move', index, at });
      // Keep the point selected: a second nudge is the common next step.
      return moved === s ? s : { ...moved, selected: index };
    });
  }, []);

  const shown = useMemo(() => {
    const vertices = state?.vertices ?? [];
    if (preview === null || preview.index >= vertices.length) return vertices;
    const next = [...vertices];
    next[preview.index] = preview.at;
    return next;
  }, [state?.vertices, preview]);

  return { state, target, shown, start, exit, dispatch, tap, dragTo, dragEnd };
}
