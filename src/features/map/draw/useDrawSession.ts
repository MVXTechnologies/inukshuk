import {
  drawReducer,
  initialDrawState,
  type DrawAction,
  type DrawKind,
  type DrawState,
} from '@core/draw/editor';
import type { LngLat } from '@core/models';
import { useCallback, useMemo, useState } from 'react';

import type { DrawHandleCallbacks } from './DrawLayers';

/**
 * What a drawing session is for: a new shape, or a saved route/area being
 * edited (its id, so Save updates it instead of adding a copy).
 */
export type DrawTarget = { kind: 'route'; trackId?: string } | { kind: 'area'; areaId?: string };

/** A handle mid-drag: the shape follows it before the drag commits. */
interface DragPreview {
  index: number;
  at: LngLat;
  /** A midpoint handle: the vertex is inserted at `index`, not moved. */
  insert: boolean;
}

export interface DrawSession {
  /** Null while no drawing tool is open. */
  state: DrawState | null;
  target: DrawTarget | null;
  /** The vertices to draw, with an in-flight drag applied. */
  shown: readonly LngLat[];
  /** Bumped by every commit (re-keys the native handles, see DrawLayers). */
  revision: number;
  start: (target: DrawTarget, vertices?: readonly LngLat[]) => void;
  exit: () => void;
  dispatch: (action: DrawAction) => void;
  handles: DrawHandleCallbacks;
}

/**
 * The map screen's drawing-tool session (#502/#503): the pure editor
 * (`@core/draw/editor`) plus what only exists on screen — which saved item is
 * being edited, the live drag preview, and the handles' revision counter.
 */
export function useDrawSession(): DrawSession {
  const [state, setState] = useState<DrawState | null>(null);
  const [target, setTarget] = useState<DrawTarget | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [revision, setRevision] = useState(0);

  const dispatch = useCallback((action: DrawAction) => {
    setState((s) => (s === null ? s : drawReducer(s, action)));
    setRevision((r) => r + 1);
  }, []);

  const start = useCallback((next: DrawTarget, vertices: readonly LngLat[] = []) => {
    setTarget(next);
    setPreview(null);
    setState(initialDrawState(next.kind as DrawKind, vertices));
    setRevision((r) => r + 1);
  }, []);

  const exit = useCallback(() => {
    setState(null);
    setTarget(null);
    setPreview(null);
  }, []);

  const handles = useMemo<DrawHandleCallbacks>(
    () => ({
      onVertexPress: (index) => {
        setState((s) =>
          s === null
            ? s
            : drawReducer(s, { type: 'select', index: s.selected === index ? null : index }),
        );
        // Android draws each handle as a bitmap: re-key so the ring redraws.
        setRevision((r) => r + 1);
      },
      onVertexDrag: (index, at) => setPreview({ index, at, insert: false }),
      onVertexDragEnd: (index, at) => {
        setPreview(null);
        dispatch({ type: 'move', index, at });
      },
      onMidpointPress: (insertAt, at) => dispatch({ type: 'insert', index: insertAt, at }),
      onMidpointDrag: (insertAt, at) => setPreview({ index: insertAt, at, insert: true }),
      onMidpointDragEnd: (insertAt, at) => {
        setPreview(null);
        dispatch({ type: 'insert', index: insertAt, at });
      },
    }),
    [dispatch],
  );

  const shown = useMemo(() => {
    const vertices = state?.vertices ?? [];
    if (preview === null) return vertices;
    const next = [...vertices];
    if (preview.insert) next.splice(preview.index, 0, preview.at);
    else if (preview.index < next.length) next[preview.index] = preview.at;
    return next;
  }, [state?.vertices, preview]);

  return { state, target, shown, revision, start, exit, dispatch, handles };
}
