import { IMPERIAL, METRIC } from '@core/format';
import { placeDistance, placeKindLine } from './format';
import type { Place } from './place';

const peak: Place = {
  id: 'p',
  source: 'index',
  type: 'peak',
  name: 'Katahdin',
  latitude: 45.9,
  longitude: -68.92,
};

describe('placeKindLine', () => {
  it('is the type label, with the elevation when known', () => {
    expect(placeKindLine({ ...peak, type: 'campground' }, METRIC)).toBe('Campground');
    expect(placeKindLine({ ...peak, elevationM: 1606 }, METRIC)).toMatch(/^Peak · 1.?606 m$/);
    expect(placeKindLine({ ...peak, elevationM: 1606 }, IMPERIAL)).toMatch(/ft$/);
  });
});

describe('placeDistance', () => {
  it('is null without a position', () => {
    expect(placeDistance(null, METRIC)).toBeNull();
    expect(placeDistance(Number.NaN, METRIC)).toBeNull();
  });

  it('is short nearby and whole units far away', () => {
    expect(placeDistance(840, METRIC)).toBe('840 m');
    expect(placeDistance(23_456, METRIC)).toBe('23.5 km');
    expect(placeDistance(1_234_567, METRIC)).toBe('1\u202f235 km');
    expect(placeDistance(23_456, IMPERIAL)).toBe('14.6 mi');
    expect(placeDistance(500_000, IMPERIAL)).toBe('311 mi');
  });
});
