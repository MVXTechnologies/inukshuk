import type { WeatherTimeline } from '@core/geo/weatherTimeline';
import {
  displayedScrubIndex,
  dragIndexForPageX,
  SCRUB_DRAG_IDLE,
  scrubDragEnd,
  scrubDragMove,
} from './scrubDrag';

const HOUR = 3_600_000;

function timeline(frames: number): WeatherTimeline {
  return {
    kind: 'forecast',
    framesMs: Array.from({ length: frames }, (_, i) => i * HOUR),
    fromCapabilities: true,
  };
}

describe('dragIndexForPageX', () => {
  const tl = timeline(25); // 0..24 h
  const trackLeft = 100;
  const pad = 8;
  const inner = 240; // 10 px per hour

  it('maps the finger position to the nearest frame in window space', () => {
    expect(dragIndexForPageX(tl, trackLeft + pad, trackLeft, pad, inner)).toBe(0);
    expect(dragIndexForPageX(tl, trackLeft + pad + 120, trackLeft, pad, inner)).toBe(12);
    expect(dragIndexForPageX(tl, trackLeft + pad + inner, trackLeft, pad, inner)).toBe(24);
  });

  it('is independent of which child view the touch lands on (pageX, not locationX)', () => {
    // Same pageX must yield the same frame regardless of any child-local
    // coordinate the native event might also carry — the function only ever
    // sees page space.
    const x = trackLeft + pad + 57;
    expect(dragIndexForPageX(tl, x, trackLeft, pad, inner)).toBe(
      dragIndexForPageX(tl, x, trackLeft, pad, inner),
    );
    expect(dragIndexForPageX(tl, x, trackLeft, pad, inner)).toBe(6);
  });

  it('clamps overshoot on both ends to the first/last frame', () => {
    expect(dragIndexForPageX(tl, trackLeft - 500, trackLeft, pad, inner)).toBe(0);
    expect(dragIndexForPageX(tl, trackLeft + 10_000, trackLeft, pad, inner)).toBe(24);
  });

  it('survives a degenerate zero-width track', () => {
    expect(dragIndexForPageX(tl, 123, trackLeft, pad, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('scrub drag reducer', () => {
  it('grant/move puts the finger in charge', () => {
    const s = scrubDragMove(SCRUB_DRAG_IDLE, 7);
    expect(s.dragIdx).toBe(7);
    expect(scrubDragMove(s, 9).dragIdx).toBe(9);
  });

  it('keeps state identity when the index does not change (no re-render churn)', () => {
    const s = scrubDragMove(SCRUB_DRAG_IDLE, 7);
    expect(scrubDragMove(s, 7)).toBe(s);
  });

  it('release commits the final position exactly once and returns to idle', () => {
    const { state, commitIdx } = scrubDragEnd(scrubDragMove(SCRUB_DRAG_IDLE, 11));
    expect(commitIdx).toBe(11);
    expect(state.dragIdx).toBeNull();
    // A release with no drag in flight commits nothing.
    expect(scrubDragEnd(state).commitIdx).toBeNull();
  });

  it('while dragging, the displayed index ignores external (committed) updates', () => {
    const dragging = scrubDragMove(SCRUB_DRAG_IDLE, 20);
    // Playback tick / refetch moved the committed selection — display holds.
    expect(displayedScrubIndex(dragging, 3, 49)).toBe(20);
    expect(displayedScrubIndex(dragging, 45, 49)).toBe(20);
  });

  it('idle display follows the committed selection', () => {
    expect(displayedScrubIndex(SCRUB_DRAG_IDLE, 14, 49)).toBe(14);
  });

  it('clamps a stale drag index when the timeline re-keys shorter mid-drag', () => {
    const dragging = scrubDragMove(SCRUB_DRAG_IDLE, 80);
    expect(displayedScrubIndex(dragging, 0, 31)).toBe(30);
    expect(displayedScrubIndex(dragging, 0, 0)).toBe(0);
  });
});
