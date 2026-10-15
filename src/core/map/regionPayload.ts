/**
 * The camera view MapLibre reports (region events and `getViewState()`),
 * parsed once at the boundary into a shape every handler can trust.
 *
 * ## Why a parser
 *
 * The payload is not always whole, and not always there:
 *
 * - **Absent** (`nativeEvent` null): React Native's renderer still POOLS
 *   synthetic events — after a handler returns, the event's `destructor()`
 *   sets `nativeEvent` to null and the object is reused for the next event
 *   (`ReactFabric-prod.js`, `releasePooledEvent`). Anything that keeps the
 *   event for later (a throttle's trailing call) reads null — 2.6.1 QA's
 *   white screen, "Cannot read property 'bounds' of null" in heading-up,
 *   where the compass follow streams settles that get deferred. Keep the
 *   PARSED payload, never the event.
 * - **Empty**: maplibre-react-native's `makeViewState` (Android) returns an
 *   empty map when the camera has no target yet.
 * - **Without bounds**: the same code drops `bounds` when the projection
 *   throws (logged natively, the event still sent).
 *
 * So: no centre, zoom, bearing or pitch → null (nothing to act on); bounds
 * missing or malformed → `bounds: null`, and each handler skips only what
 * needs them. Pure; O(1).
 */

/** `[longitude, latitude]`. */
export type LngLatPair = readonly [number, number];
/** `[west, south, east, north]`. */
export type BoundsTuple = readonly [number, number, number, number];

export interface RegionPayload {
  center: LngLatPair;
  zoom: number;
  bearing: number;
  pitch: number;
  /** Null when MapLibre could not compute the visible region. */
  bounds: BoundsTuple | null;
  /** A person's gesture moved the camera (false when unknown). */
  userInteraction: boolean;
  /** The move was animated (false when unknown). */
  animated: boolean;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function tupleOf(v: unknown, length: number): number[] | null {
  if (!Array.isArray(v) || v.length < length) return null;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const n: unknown = v[i];
    if (!isNum(n)) return null;
    out.push(n);
  }
  return out;
}

/** Parse a region event's `nativeEvent` (or a `getViewState()` result); null if unusable. */
export function parseRegionPayload(raw: unknown): RegionPayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const center = tupleOf(r.center, 2);
  const { zoom, bearing, pitch } = r;
  if (center === null || !isNum(zoom) || !isNum(bearing) || !isNum(pitch)) return null;
  const bounds = tupleOf(r.bounds, 4);
  return {
    center: [center[0] ?? 0, center[1] ?? 0],
    zoom,
    bearing,
    pitch,
    bounds:
      bounds === null ? null : [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0],
    userInteraction: r.userInteraction === true,
    animated: r.animated === true,
  };
}

/** The bounds as a named box (the wind layer's and the marine chart's shape), or null. */
export function regionBox(
  p: Pick<RegionPayload, 'bounds'>,
): { west: number; south: number; east: number; north: number } | null {
  if (p.bounds === null) return null;
  const [west, south, east, north] = p.bounds;
  return { west, south, east, north };
}
