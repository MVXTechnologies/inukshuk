/**
 * Which drawing handle a tap landed on (#502/#503), from the handles' screen
 * positions (the map projects them; this stays pure). Vertices win over
 * midpoints — they are bigger and drawn on top — and within each kind the
 * nearest one inside the radius wins.
 *
 * The handles are GeoJSON circles, not native annotations: a native draggable
 * annotation never saw the finger on Android (the map's own gestures took
 * it), so taps are hit-tested here, the same idiom as the waypoint pins.
 */

export type ScreenPoint = readonly [number, number];

export type HandleHit = { kind: 'vertex'; index: number } | { kind: 'midpoint'; index: number };

/** Finger-sized tolerance (px) around a vertex; midpoints get a little less. */
export const VERTEX_HIT_PX = 26;
export const MIDPOINT_HIT_PX = 20;

function nearest(
  points: readonly (ScreenPoint | null)[],
  tap: ScreenPoint,
  radius: number,
): number | null {
  let best: number | null = null;
  let bestD = radius;
  points.forEach((p, i) => {
    if (p === null) return;
    const d = Math.hypot(p[0] - tap[0], p[1] - tap[1]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * The handle under `tap`, or null. `vertices[i]` / `midpoints[i]` are screen
 * positions (null where projection failed); a midpoint's index is its
 * position in `midpointHandles` order.
 */
export function hitHandle(
  vertices: readonly (ScreenPoint | null)[],
  midpoints: readonly (ScreenPoint | null)[],
  tap: ScreenPoint,
): HandleHit | null {
  const v = nearest(vertices, tap, VERTEX_HIT_PX);
  if (v !== null) return { kind: 'vertex', index: v };
  const m = nearest(midpoints, tap, MIDPOINT_HIT_PX);
  return m === null ? null : { kind: 'midpoint', index: m };
}
