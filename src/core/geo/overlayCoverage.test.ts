import type { BoundingBox } from '../models';
import { coverageScaleChanged, padBounds, viewStillCovered } from './overlayCoverage';

const VIEW: BoundingBox = { minLng: -71.22, minLat: 46.8, maxLng: -71.2, maxLat: 46.82 };

describe('padBounds', () => {
  it('grows every side by the fraction of the span', () => {
    const p = padBounds(VIEW, 0.5);
    expect(p.minLng).toBeCloseTo(-71.23, 10);
    expect(p.maxLng).toBeCloseTo(-71.19, 10);
    expect(p.minLat).toBeCloseTo(46.79, 10);
    expect(p.maxLat).toBeCloseTo(46.83, 10);
  });

  it('is the identity at zero', () => {
    expect(padBounds(VIEW, 0)).toEqual(VIEW);
  });
});

describe('viewStillCovered', () => {
  const covered = padBounds(VIEW, 0.5);

  it('is false before anything was computed', () => {
    expect(viewStillCovered(VIEW, null, 0.1)).toBe(false);
  });

  it('keeps the result for the view it was computed for', () => {
    expect(viewStillCovered(VIEW, covered, 0.1)).toBe(true);
  });

  it('keeps it after a small pan', () => {
    const panned = { ...VIEW, minLng: VIEW.minLng + 0.004, maxLng: VIEW.maxLng + 0.004 };
    expect(viewStillCovered(panned, covered, 0.1)).toBe(true);
  });

  it('asks for a recompute when the view nears the covered edge', () => {
    const panned = { ...VIEW, minLng: VIEW.minLng + 0.009, maxLng: VIEW.maxLng + 0.009 };
    expect(viewStillCovered(panned, covered, 0.1)).toBe(false);
  });

  it('asks for a recompute when the view leaves the covered area', () => {
    const away = { minLng: -70, minLat: 47, maxLng: -69.98, maxLat: 47.02 };
    expect(viewStillCovered(away, covered, 0.1)).toBe(false);
  });
});

describe('coverageScaleChanged', () => {
  const covered = padBounds(VIEW, 0.5);

  it('is false for the same zoom', () => {
    expect(coverageScaleChanged(VIEW, covered, 0.5)).toBe(false);
  });

  it('is true after zooming far in (the result is too coarse)', () => {
    const zoomedIn = padBounds(VIEW, -0.4); // a fifth of the width
    expect(coverageScaleChanged(zoomedIn, covered, 0.5)).toBe(true);
  });

  it('is true after zooming out (the result is too small)', () => {
    expect(coverageScaleChanged(padBounds(VIEW, 1), covered, 0.5)).toBe(true);
  });
});
