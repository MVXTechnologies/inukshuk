import type { BoundingBox } from '@core/models';
import {
  BOTTOM_STRIP_PT,
  clampFreeAspect,
  coverageBbox,
  coverageMeters,
  FREE_ASPECT_MAX,
  FREE_ASPECT_MIN,
  FREE_LONG_EDGE_PT,
  MARGIN_PT,
  nearestLadderScale,
  pageGeometry,
  SCALE_LADDER,
  scaleDenomToFit,
} from './pageSpec';

describe('pageGeometry', () => {
  it('insets the map frame by the margins and the legend strip', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    expect(g.page).toEqual({ widthPt: 595.28, heightPt: 841.89 });
    expect(g.mapRect.x).toBe(MARGIN_PT);
    expect(g.mapRect.y).toBe(BOTTOM_STRIP_PT);
    expect(g.mapRect.w).toBeCloseTo(595.28 - 2 * MARGIN_PT, 6);
    expect(g.mapRect.h).toBeCloseTo(841.89 - BOTTOM_STRIP_PT - MARGIN_PT, 6);
  });

  it('swaps the page for landscape', () => {
    const p = pageGeometry({ preset: 'letter', orientation: 'portrait' }).page;
    const l = pageGeometry({ preset: 'letter', orientation: 'landscape' }).page;
    expect(l.widthPt).toBe(p.heightPt);
    expect(l.heightPt).toBe(p.widthPt);
  });

  it('leaves a square page square in both orientations', () => {
    const p = pageGeometry({ preset: 'square', orientation: 'portrait' }).page;
    const l = pageGeometry({ preset: 'square', orientation: 'landscape' }).page;
    expect(p).toEqual(l);
  });

  describe('free', () => {
    it('honours the framed aspect, long edge held at A4', () => {
      const wide = pageGeometry({ preset: 'free', orientation: 'portrait', aspect: 1.5 });
      expect(wide.page.widthPt).toBeCloseTo(FREE_LONG_EDGE_PT, 6);
      expect(wide.page.widthPt / wide.page.heightPt).toBeCloseTo(1.5, 6);

      const tall = pageGeometry({ preset: 'free', orientation: 'portrait', aspect: 0.6 });
      expect(tall.page.heightPt).toBeCloseTo(FREE_LONG_EDGE_PT, 6);
      expect(tall.page.widthPt / tall.page.heightPt).toBeCloseTo(0.6, 6);
    });

    it('ignores orientation — a free sheet already is the shape you framed', () => {
      const a = pageGeometry({ preset: 'free', orientation: 'portrait', aspect: 1.4 });
      const b = pageGeometry({ preset: 'free', orientation: 'landscape', aspect: 1.4 });
      expect(a.page).toEqual(b.page);
    });

    it('clamps absurd aspects rather than printing a banner', () => {
      expect(clampFreeAspect(20)).toBe(FREE_ASPECT_MAX);
      expect(clampFreeAspect(0.01)).toBe(FREE_ASPECT_MIN);
      expect(clampFreeAspect(0)).toBe(1);
      expect(clampFreeAspect(Number.NaN)).toBe(1);
      const g = pageGeometry({ preset: 'free', orientation: 'portrait', aspect: 99 });
      expect(g.page.widthPt / g.page.heightPt).toBeCloseTo(FREE_ASPECT_MAX, 6);
    });
  });
});

describe('coverageMeters', () => {
  // The numbers the scale chips print, and the promise the whole feature makes.
  it('derives the ground a sheet covers from page and scale alone', () => {
    const a4 = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const c = coverageMeters(a4, 25000);
    expect(c.widthM).toBeCloseTo(4721, 0);
    expect(c.heightM).toBeCloseTo(6384, 0);
  });

  it('scales linearly with the denominator — no snapping anywhere', () => {
    const a4 = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const a = coverageMeters(a4, 25000);
    const b = coverageMeters(a4, 50000);
    expect(b.widthM / a.widthM).toBeCloseTo(2, 9);
    expect(b.heightM / a.heightM).toBeCloseTo(2, 9);
  });

  it('covers more ground on the long axis in landscape', () => {
    const l = coverageMeters(pageGeometry({ preset: 'a4', orientation: 'landscape' }), 50000);
    expect(l.widthM).toBeGreaterThan(l.heightM);
  });
});

describe('coverageBbox', () => {
  it('centres the sheet on the camera and matches the requested ground', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const cov = coverageMeters(g, 25000);
    const bbox = coverageBbox([-71.25, 46.81], cov);
    const cosLat = Math.cos((46.81 * Math.PI) / 180);
    expect((bbox.minLng + bbox.maxLng) / 2).toBeCloseTo(-71.25, 9);
    expect((bbox.minLat + bbox.maxLat) / 2).toBeCloseTo(46.81, 9);
    expect((bbox.maxLng - bbox.minLng) * 111320 * cosLat).toBeCloseTo(cov.widthM, 3);
    expect((bbox.maxLat - bbox.minLat) * 111320).toBeCloseTo(cov.heightM, 6);
  });

  it('widens the longitude span towards the poles', () => {
    const cov = { widthM: 10000, heightM: 10000 };
    const equator = coverageBbox([0, 0], cov);
    const north = coverageBbox([0, 70], cov);
    expect(north.maxLng - north.minLng).toBeGreaterThan(equator.maxLng - equator.minLng);
  });
});

describe('scaleDenomToFit', () => {
  it('round-trips with coverageMeters', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const bbox = coverageBbox([-71.25, 46.81], coverageMeters(g, 40000));
    expect(scaleDenomToFit(g, bbox)).toBeCloseTo(40000, 2);
  });

  it('takes the axis that needs the coarser scale so the region always fits', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    // A wide, short box: width is the binding constraint on a portrait sheet.
    const bbox: BoundingBox = { minLng: -71.4, maxLng: -71.0, minLat: 46.8, maxLat: 46.82 };
    const denom = scaleDenomToFit(g, bbox);
    const cov = coverageMeters(g, denom);
    const cosLat = Math.cos((46.81 * Math.PI) / 180);
    expect(cov.widthM).toBeCloseTo(0.4 * 111320 * cosLat, 0);
    expect(cov.heightM).toBeGreaterThan(0.02 * 111320);
  });
});

describe('nearestLadderScale', () => {
  it('picks the rung nearest in ratio, not in absolute difference', () => {
    expect(nearestLadderScale(24000)).toBe(25000);
    expect(nearestLadderScale(11000)).toBe(10000);
    expect(nearestLadderScale(90000)).toBe(100000);
    // 35 000 is 10k nearer to 25k than to 50k in absolute terms, but a scale is
    // a ratio: 35/25 = 1.40 against 50/35 = 1.43, so 25k still wins — barely.
    expect(nearestLadderScale(35000)).toBe(25000);
    expect(nearestLadderScale(36000)).toBe(50000);
  });

  it('saturates at the ends of the ladder', () => {
    expect(nearestLadderScale(1)).toBe(SCALE_LADDER[0]);
    expect(nearestLadderScale(10_000_000)).toBe(SCALE_LADDER[SCALE_LADDER.length - 1]);
  });
});
