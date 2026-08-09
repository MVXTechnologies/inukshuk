import { nearestFrameIndex, type WeatherTimeline } from '@core/geo/weatherTimeline';
import { msForTrackRatio } from './modelTimeline';

/**
 * Scrubber drag state (weather wave A, field item 4). The field bug: while a
 * drag was in flight the thumb/chip position was driven by the COMMITTED
 * selection, and the per-move index came from `locationX` — which React
 * Native reports relative to whichever child view the touch is over. The
 * accent chip rides the selection, so the moment the finger crossed it the
 * "track x" collapsed to a chip-local 0..84 px value and the thumb snapped
 * toward the start; meanwhile the playback tick and throttled TIME re-render
 * kept yanking the committed position back to "now" mid-drag.
 *
 * The fix, in two pure halves used by WeatherTimeScrubber:
 * - {@link dragIndexForPageX}: the frame under the finger from the touch's
 *   *page* x and the track's measured window origin — child-view-independent.
 * - a tiny drag reducer: while `dragIdx` is non-null the UI renders it
 *   EXCLUSIVELY (external updates — playback, refetch re-keys — are ignored);
 *   release commits exactly once via {@link scrubDragEnd}.
 */

export interface ScrubDragState {
  /** Frame index under the finger, or null when no drag is in flight. */
  dragIdx: number | null;
}

export const SCRUB_DRAG_IDLE: ScrubDragState = { dragIdx: null };

/**
 * The timeline frame under a touch, from its pageX and the track's measured
 * window-space geometry. Time-linear like the track itself; the ratio clamps
 * to [0, 1] so overshooting either end pins to the first/last frame.
 */
export function dragIndexForPageX(
  timeline: WeatherTimeline,
  pageX: number,
  trackLeftPageX: number,
  trackPad: number,
  innerWidth: number,
): number {
  const ratio = (pageX - trackLeftPageX - trackPad) / Math.max(innerWidth, 1);
  return nearestFrameIndex(timeline, msForTrackRatio(timeline.framesMs, ratio));
}

/** Grant/move: the finger owns the position. */
export function scrubDragMove(state: ScrubDragState, idx: number): ScrubDragState {
  return state.dragIdx === idx ? state : { dragIdx: idx };
}

/** Release/terminate: back to idle, committing the final position (if any) once. */
export function scrubDragEnd(state: ScrubDragState): {
  state: ScrubDragState;
  commitIdx: number | null;
} {
  return { state: SCRUB_DRAG_IDLE, commitIdx: state.dragIdx };
}

/**
 * What the thumb/chip render: the local drag position while a drag is in
 * flight (external updates suspended), else the committed selection. Clamped
 * to the current frame count — the timeline can re-key mid-drag (a
 * GetCapabilities refine landing) and the stale index must never read past
 * the new frame list.
 */
export function displayedScrubIndex(
  state: ScrubDragState,
  committedIdx: number,
  frameCount: number,
): number {
  const idx = state.dragIdx ?? committedIdx;
  return Math.max(0, Math.min(idx, Math.max(frameCount - 1, 0)));
}
