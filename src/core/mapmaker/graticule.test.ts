import { graticuleForBbox, formatGratLabel } from './graticule';
import type { BoundingBox } from '@core/models';

const BBOX: BoundingBox = { minLng: -71.35, minLat: 46.75, maxLng: -71.2, maxLat: 46.8 };

describe('graticuleForBbox', () => {
  it('picks a clean interval giving a readable number of lines', () => {
    const g = graticuleForBbox(BBOX);
    // 0.15° of longitude at a 0.025° interval → 5-ish meridians.
    expect(g.intervalDeg).toBeGreaterThan(0);
    expect(g.meridians.length).toBeGreaterThanOrEqual(3);
    expect(g.meridians.length).toBeLessThanOrEqual(9);
    expect(g.parallels.length).toBeGreaterThanOrEqual(1);
    expect(g.parallels.length).toBeLessThanOrEqual(9);
  });

  it('aligns lines to multiples of the interval inside the bbox', () => {
    const g = graticuleForBbox(BBOX);
    for (const lng of g.meridians) {
      expect(lng).toBeGreaterThanOrEqual(BBOX.minLng);
      expect(lng).toBeLessThanOrEqual(BBOX.maxLng);
      expect(Math.abs(lng / g.intervalDeg - Math.round(lng / g.intervalDeg))).toBeLessThan(1e-6);
    }
    for (const lat of g.parallels) {
      expect(lat).toBeGreaterThanOrEqual(BBOX.minLat);
      expect(lat).toBeLessThanOrEqual(BBOX.maxLat);
    }
  });

  it('scales the interval with the region size', () => {
    const tiny: BoundingBox = { minLng: -71.31, minLat: 46.76, maxLng: -71.3, maxLat: 46.77 };
    expect(graticuleForBbox(tiny).intervalDeg).toBeLessThan(graticuleForBbox(BBOX).intervalDeg);
  });
});

describe('formatGratLabel', () => {
  it('formats whole degrees plainly and fractions as minutes', () => {
    expect(formatGratLabel(-71, 'lng')).toBe('71°W');
    expect(formatGratLabel(46.75, 'lat')).toBe("46°45'N");
    expect(formatGratLabel(-71.25, 'lng')).toBe("71°15'W");
    expect(formatGratLabel(0, 'lat')).toBe('0°');
  });
});
