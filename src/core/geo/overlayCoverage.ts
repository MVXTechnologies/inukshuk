import type { BoundingBox } from '../models';

/**
 * Coverage bookkeeping for overlays computed over an area larger than the
 * screen (2D contours and slope): compute generously once, then keep the
 * result while the viewport stays well inside it, so panning never reveals
 * an edge and small pans cost nothing. Pure.
 */

/** `bounds` grown by `pad` × its own width/height on every side. */
export function padBounds(bounds: BoundingBox, pad: number): BoundingBox {
  const padLng = (bounds.maxLng - bounds.minLng) * pad;
  const padLat = (bounds.maxLat - bounds.minLat) * pad;
  return {
    minLng: bounds.minLng - padLng,
    minLat: bounds.minLat - padLat,
    maxLng: bounds.maxLng + padLng,
    maxLat: bounds.maxLat + padLat,
  };
}

/**
 * Whether `view` still sits inside `covered` with at least `margin` × the
 * view's own size to spare on every side — i.e. the next pan of that size
 * would not reach the edge of what has been computed. False when nothing is
 * covered yet.
 */
export function viewStillCovered(
  view: BoundingBox,
  covered: BoundingBox | null,
  margin: number,
): boolean {
  if (covered === null) return false;
  const needLng = (view.maxLng - view.minLng) * margin;
  const needLat = (view.maxLat - view.minLat) * margin;
  return (
    view.minLng - needLng >= covered.minLng &&
    view.maxLng + needLng <= covered.maxLng &&
    view.minLat - needLat >= covered.minLat &&
    view.maxLat + needLat <= covered.maxLat
  );
}

/**
 * Whether the view zoomed so far out (or in) that the covered result's detail
 * no longer suits it: its area differs from the view's padded area by more
 * than `factor` either way.
 */
export function coverageScaleChanged(
  view: BoundingBox,
  covered: BoundingBox,
  pad: number,
  factor = 2.5,
): boolean {
  const area = (b: BoundingBox) => (b.maxLng - b.minLng) * (b.maxLat - b.minLat);
  const wanted = area(padBounds(view, pad));
  const have = area(covered);
  if (wanted <= 0 || have <= 0) return true;
  const ratio = have / wanted;
  return ratio > factor || ratio < 1 / factor;
}
