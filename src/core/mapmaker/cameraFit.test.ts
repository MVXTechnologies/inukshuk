import {
  cameraChanged,
  clampZoom,
  MERCATOR_M_PER_PX_Z0,
  metersPerPixel,
  scaleDenomForZoom,
  zoomForGroundSpan,
} from './cameraFit';
import { coverageMeters, pageGeometry } from './pageSpec';

describe('metersPerPixel', () => {
  it('matches the Web Mercator resolution at the equator', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(MERCATOR_M_PER_PX_Z0, 6);
    expect(metersPerPixel(1, 0)).toBeCloseTo(MERCATOR_M_PER_PX_Z0 / 2, 6);
  });

  it('shrinks with the cosine of the latitude', () => {
    expect(metersPerPixel(10, 60)).toBeCloseTo(metersPerPixel(10, 0) * Math.cos(Math.PI / 3), 6);
  });

  it('does not divide by zero at the pole', () => {
    expect(Number.isFinite(metersPerPixel(10, 90))).toBe(true);
    expect(metersPerPixel(10, 90)).toBeGreaterThan(0);
  });
});

describe('zoomForGroundSpan', () => {
  it('inverts metersPerPixel exactly', () => {
    const zoom = zoomForGroundSpan(5000, 300, 46.8);
    expect(metersPerPixel(zoom, 46.8) * 300).toBeCloseTo(5000, 6);
  });

  it('zooms in by one level when the same pixels must show half the ground', () => {
    const a = zoomForGroundSpan(5000, 300, 46.8);
    const b = zoomForGroundSpan(2500, 300, 46.8);
    expect(b - a).toBeCloseTo(1, 9);
  });

  it('is safe on a zero-sized layout', () => {
    expect(zoomForGroundSpan(0, 300, 46.8)).toBe(0);
    expect(zoomForGroundSpan(5000, 0, 46.8)).toBe(0);
  });
});

describe('scaleDenomForZoom', () => {
  // The editor's whole contract: put the sheet on screen at a scale, read the
  // camera back, and get the same scale. A pinch then simply moves along it.
  it('round-trips with the zoom the sheet was pinned at', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const windowPx = 312;
    for (const denom of [10000, 25000, 50000, 100000]) {
      const cov = coverageMeters(g, denom);
      const zoom = zoomForGroundSpan(cov.widthM, windowPx, 46.8);
      expect(scaleDenomForZoom(zoom, windowPx, 46.8, g.mapRect.w)).toBeCloseTo(denom, 6);
    }
  });

  it('doubles the denominator when the camera zooms out one level', () => {
    const g = pageGeometry({ preset: 'a4', orientation: 'portrait' });
    const a = scaleDenomForZoom(14, 312, 46.8, g.mapRect.w);
    const b = scaleDenomForZoom(13, 312, 46.8, g.mapRect.w);
    expect(b / a).toBeCloseTo(2, 9);
  });
});

describe('clampZoom', () => {
  it('holds the camera inside what the tile sources can show', () => {
    expect(clampZoom(25)).toBe(18);
    expect(clampZoom(-4)).toBe(1);
    expect(clampZoom(12)).toBe(12);
  });
});

describe('cameraChanged', () => {
  const at = (lng: number, lat: number, zoom: number) => ({
    center: [lng, lat] as [number, number],
    zoom,
  });

  it('ignores the float noise a bridge round-trip introduces', () => {
    expect(cameraChanged(at(-71.25, 46.81, 13), at(-71.25 + 1e-9, 46.81, 13 + 1e-9))).toBe(false);
  });

  it('sees a real pan or zoom', () => {
    expect(cameraChanged(at(-71.25, 46.81, 13), at(-71.2, 46.81, 13))).toBe(true);
    expect(cameraChanged(at(-71.25, 46.81, 13), at(-71.25, 46.9, 13))).toBe(true);
    expect(cameraChanged(at(-71.25, 46.81, 13), at(-71.25, 46.81, 14))).toBe(true);
  });
});
