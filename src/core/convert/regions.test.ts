import reference from './fixtures/reference.json';
import {
  cdBreakBetween,
  CONUS_OUTLINE,
  distanceM,
  inPolygon,
  inRegion,
  placeName,
} from './regions';
import type { Suite } from './suite';

const suite = reference as unknown as Suite;
const lonLatPoints = (prefix: string) =>
  suite.pairs
    .filter((p) => p.id.startsWith(prefix) && p.io.input[0] === 'lon_deg')
    .flatMap((p) =>
      p.points.map((q) => [q.input[0] as number, q.input[1] as number, `${p.id}/${q.id}`] as const),
    );

describe('CONUS outline (TRAP 5 guard)', () => {
  it('contains every US reference mark', () => {
    const out = lonLatPoints('US-').filter(([lon, lat]) => !inPolygon(CONUS_OUTLINE, lon, lat));
    expect(out).toEqual([]);
  });
  it('excludes every Canadian reference mark', () => {
    const inside = lonLatPoints('CA-').filter(([lon, lat]) => inPolygon(CONUS_OUTLINE, lon, lat));
    expect(inside).toEqual([]);
  });
  it('excludes Québec City and the Eastern Townships, includes Maine and Vermont', () => {
    expect(inRegion('conus', -71.2, 46.8)).toBe(false);
    expect(inRegion('conus', -71.9, 45.4)).toBe(false); // Sherbrooke
    expect(inRegion('conus', -69.8, 44.3)).toBe(true); // Augusta
    expect(inRegion('conus', -73.2, 44.5)).toBe(true); // Burlington
    expect(inRegion([0, 0, 1, 1], 0.5, 0.5)).toBe(true);
  });
});

describe('regions', () => {
  it('names places', () => {
    expect(placeName(-71.2, 46.8)).toBe('Québec');
    expect(placeName(2.35, 48.85)).toBe('France');
    expect(placeName(-150, -40)).toBeNull();
  });
  it('measures distance', () => {
    expect(distanceM(-71.2, 46.8, -71.2, 46.9)).toBeCloseTo(11119.5, -1);
  });
  it('finds the Portneuf break only between the two sides', () => {
    expect(cdBreakBetween({ lon: -72.3, lat: 46.7 }, { lon: -72.1, lat: 46.7 })?.name).toMatch(
      /Portneuf/,
    );
    expect(cdBreakBetween({ lon: -71.3, lat: 46.8 }, { lon: -71.2, lat: 46.8 })).toBeNull();
  });
});
