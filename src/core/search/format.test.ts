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
    expect(placeKindLine({ ...peak, type: 'campground' }, 'metric')).toBe('Campground');
    expect(placeKindLine({ ...peak, elevationM: 1606 }, 'metric')).toMatch(/^Peak · 1.?606 m$/);
    expect(placeKindLine({ ...peak, elevationM: 1606 }, 'imperial')).toMatch(/ft$/);
  });
});

describe('placeDistance', () => {
  it('is null without a position', () => {
    expect(placeDistance(null, 'metric')).toBeNull();
    expect(placeDistance(Number.NaN, 'metric')).toBeNull();
  });

  it('is short nearby and whole units far away', () => {
    expect(placeDistance(840, 'metric')).toBe('840 m');
    expect(placeDistance(23_456, 'metric')).toBe('23.5 km');
    expect(placeDistance(1_234_567, 'metric')).toBe('1 235 km');
    expect(placeDistance(23_456, 'imperial')).toBe('14.6 mi');
    expect(placeDistance(500_000, 'imperial')).toBe('311 mi');
  });
});
