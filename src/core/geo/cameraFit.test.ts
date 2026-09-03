import type { BoundingBox } from '@core/models';
import { CAROUSEL_FIT_MARGIN_PX, carouselFitPadding, fitBoundsCamera } from './cameraFit';
import { unionBoundingBoxes } from './geomath';

/** iPhone-15-class portrait viewport in logical points, and its status-bar inset. */
const VIEWPORT = { width: 393, height: 852 };
const TOP_INSET = 59;

/**
 * The carousel's own footprint (see `HeatPointCarousel`'s styles): a 168-px
 * deck 8 px off the right edge, ~194 px tall, sitting 8 px below the top
 * inset. Referenced here only to prove the fit does NOT pay for it.
 */
const DECK_W = 168 + 8;
const DECK_H = 194 + 8;

/**
 * Three Québec City runs that overlap on one heat spot: a Plains of Abraham
 * loop, a longer run out to Old Québec, and a river path. Their union is
 * ~5.3 km × 4.7 km — the shape the carousel fit has to frame.
 */
const QUEBEC_RUNS: BoundingBox[] = [
  { minLat: 46.795, maxLat: 46.815, minLng: -71.235, maxLng: -71.205 },
  { minLat: 46.795, maxLat: 46.822, minLng: -71.24, maxLng: -71.19 },
  { minLat: 46.78, maxLat: 46.81, minLng: -71.26, maxLng: -71.2 },
];

const union = (boxes: readonly BoundingBox[]): BoundingBox => {
  const u = unionBoundingBoxes(boxes);
  if (!u) throw new Error('fixture produced no union');
  return u;
};

describe('carouselFitPadding', () => {
  it('is a bare margin on every edge, with only the status bar added on top', () => {
    expect(carouselFitPadding(TOP_INSET)).toEqual({
      top: TOP_INSET + CAROUSEL_FIT_MARGIN_PX,
      right: CAROUSEL_FIT_MARGIN_PX,
      bottom: CAROUSEL_FIT_MARGIN_PX,
      left: CAROUSEL_FIT_MARGIN_PX,
    });
  });

  it('reserves no room for the carousel deck — content under it is accepted', () => {
    const pad = carouselFitPadding(TOP_INSET);
    expect(pad.right).toBeLessThan(DECK_W);
    expect(pad.top - TOP_INSET).toBeLessThan(DECK_H);
  });

  it('treats a missing/negative inset as no inset', () => {
    expect(carouselFitPadding(0)).toEqual(carouselFitPadding(-20));
  });
});

describe('fitBoundsCamera — the multi-trail carousel fit', () => {
  const bbox = union(QUEBEC_RUNS);
  const fit = fitBoundsCamera(bbox, VIEWPORT, carouselFitPadding(TOP_INSET), { maxZoom: 18 });

  it('unions the raw trail bboxes with no inflation', () => {
    // Pins `unionBoundingBoxes` staying a plain min/max: a re-added bbox
    // inflation would silently widen every fit again.
    expect(bbox).toEqual({ minLat: 46.78, maxLat: 46.822, minLng: -71.26, maxLng: -71.19 });
  });

  it('frames the union border-to-border: ~92% of the viewport width', () => {
    expect(fit.limitedBy).toBe('width');
    // (393 - 16 - 16) / 393 — the horizontal margin is the ENTIRE budget.
    expect(fit.widthFraction).toBeCloseTo(361 / 393, 6);
    expect(fit.widthFraction).toBeGreaterThan(0.9);
    expect(fit.zoom).toBeCloseTo(11.82, 2);
  });

  it('is width-limited, so the deck height could not be paid for anyway', () => {
    // Reserving the whole deck at the top changes nothing: on a portrait
    // phone the vertical padding never reaches the zoom. Any future "just
    // pad the top a bit more" tuning is therefore a no-op, not a fix.
    const reserved = fitBoundsCamera(
      bbox,
      VIEWPORT,
      { ...carouselFitPadding(TOP_INSET), top: TOP_INSET + 8 + DECK_H },
      { maxZoom: 18 },
    );
    expect(reserved.zoom).toBeCloseTo(fit.zoom, 10);
  });

  it('stays border-to-border across tight and sprawling unions', () => {
    const tight = union([
      { minLat: 46.8, maxLat: 46.811, minLng: -71.225, maxLng: -71.205 },
      { minLat: 46.802, maxLat: 46.809, minLng: -71.22, maxLng: -71.208 },
    ]);
    const sprawling = union([
      { minLat: 46.75, maxLat: 46.81, minLng: -71.32, maxLng: -71.2 },
      { minLat: 46.79, maxLat: 46.822, minLng: -71.24, maxLng: -71.16 },
    ]);
    for (const b of [tight, sprawling]) {
      const f = fitBoundsCamera(b, VIEWPORT, carouselFitPadding(TOP_INSET), { maxZoom: 18 });
      expect(f.widthFraction).toBeCloseTo(361 / 393, 6);
    }
  });

  it('beats the pre-2026-08-07 fit by ~1.5 zoom levels', () => {
    // What shipped before: the union inflated 25%, then 40-190 px reserved
    // per edge to clear the deck. Kept here as the regression floor — if a
    // future change lands anywhere near this framing, it is the old bug.
    const inflate = (b: BoundingBox, f: number): BoundingBox => {
      const dLat = ((b.maxLat - b.minLat) * f) / 2;
      const dLng = ((b.maxLng - b.minLng) * f) / 2;
      return {
        minLat: b.minLat - dLat,
        maxLat: b.maxLat + dLat,
        minLng: b.minLng - dLng,
        maxLng: b.maxLng + dLng,
      };
    };
    const old = fitBoundsCamera(
      inflate(bbox, 0.25),
      VIEWPORT,
      { top: TOP_INSET + 90, left: 40, right: 190, bottom: 80 },
      { maxZoom: 18 },
    );
    expect(fit.zoom - old.zoom).toBeGreaterThan(1.4);
    // The old fit left the REAL union (the inflated box minus its 25% skirt)
    // covering barely a third of the screen width.
    expect(old.widthFraction / 1.25).toBeLessThan(0.35);
  });

  it('models a zero-padding fit as exactly filling the viewport', () => {
    // Anchors the projection maths itself: with no padding the limiting axis
    // spans the whole screen, so the fractions above are real screen shares.
    const f = fitBoundsCamera(bbox, VIEWPORT, { top: 0, right: 0, bottom: 0, left: 0 });
    expect(f.widthFraction).toBeCloseTo(1, 6);
    expect(f.heightFraction).toBeLessThan(1);
  });
});

describe('fitBoundsCamera — degenerate inputs', () => {
  const pad = carouselFitPadding(0);

  it('clamps a single-point bbox to maxZoom instead of returning Infinity', () => {
    const point: BoundingBox = { minLat: 46.8, maxLat: 46.8, minLng: -71.2, maxLng: -71.2 };
    const f = fitBoundsCamera(point, VIEWPORT, pad, { maxZoom: 18 });
    expect(f.zoom).toBe(18);
    expect(f.limitedBy).toBe('none');
    expect(f.widthFraction).toBe(0);
  });

  it('clamps a world-spanning bbox to minZoom', () => {
    const world: BoundingBox = { minLat: -80, maxLat: 80, minLng: -180, maxLng: 180 };
    expect(fitBoundsCamera(world, VIEWPORT, pad, { minZoom: 1, maxZoom: 18 }).zoom).toBe(1);
  });

  it('falls back to minZoom when padding swallows the viewport', () => {
    const f = fitBoundsCamera(union(QUEBEC_RUNS), { width: 20, height: 20 }, pad, {
      minZoom: 1,
      maxZoom: 18,
    });
    expect(f.zoom).toBe(1);
    expect(f.limitedBy).toBe('none');
  });

  it('handles a zero-size viewport without NaN', () => {
    const f = fitBoundsCamera(union(QUEBEC_RUNS), { width: 0, height: 0 }, pad);
    expect(f.widthFraction).toBe(0);
    expect(f.heightFraction).toBe(0);
  });

  it('is height-limited for a tall, narrow union', () => {
    const tall: BoundingBox = { minLat: 46.6, maxLat: 46.9, minLng: -71.205, maxLng: -71.2 };
    const f = fitBoundsCamera(tall, VIEWPORT, carouselFitPadding(TOP_INSET), { maxZoom: 18 });
    expect(f.limitedBy).toBe('height');
    expect(f.heightFraction).toBeCloseTo((852 - (TOP_INSET + 16) - 16) / 852, 6);
  });
});
