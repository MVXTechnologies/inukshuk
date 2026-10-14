/**
 * Chart scrubbing: where along a plot a finger is, as a 0..1 ratio.
 *
 * `x` must be in the plot's own frame (the gesture's view-relative x, never a
 * page coordinate). The plot starts `start` px into that frame and spans
 * `length` px; a finger left of it reads 0 and right of it reads 1, so a
 * scrub dragged past either end pins the cursor there instead of jumping.
 */
export function scrubRatio(x: number, start: number, length: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(start) || !(length > 0)) return null;
  return Math.min(1, Math.max(0, (x - start) / length));
}
