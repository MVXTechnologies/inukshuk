import { PLACE_TYPES, placeTypeOf, type PlaceType } from './placeTypes';

describe('placeTypeOf', () => {
  it.each<[string, string, string | undefined, PlaceType]>([
    ['place', 'city', 'city', 'city'],
    ['place', 'town', 'city', 'town'],
    ['place', 'village', 'city', 'village'],
    ['place', 'hamlet', 'city', 'hamlet'],
    ['place', 'isolated_dwelling', undefined, 'hamlet'],
    ['place', 'island', 'other', 'island'],
    ['tourism', 'camp_site', 'house', 'campground'],
    ['tourism', 'caravan_site', 'house', 'campground'],
    ['natural', 'peak', 'other', 'peak'],
    ['natural', 'volcano', 'other', 'volcano'],
    ['natural', 'massif', 'other', 'mountain'],
    ['natural', 'mountain_range', 'other', 'range'],
    ['route', 'hiking', 'other', 'trail'],
    ['route', 'mtb', 'other', 'trail'],
    ['highway', 'path', 'street', 'trail'],
    ['highway', 'track', 'street', 'trail'],
    ['highway', 'footway', 'street', 'trail'],
    ['natural', 'saddle', 'other', 'pass'],
    ['mountain_pass', 'yes', 'other', 'pass'],
    ['natural', 'water', 'other', 'lake'],
    ['water', 'reservoir', 'other', 'lake'],
    ['waterway', 'river', 'street', 'river'],
    ['waterway', 'waterfall', 'other', 'waterfall'],
    ['natural', 'bay', 'other', 'bay'],
    ['natural', 'glacier', 'other', 'glacier'],
    ['leisure', 'nature_reserve', 'other', 'park'],
    ['boundary', 'national_park', 'other', 'park'],
    ['boundary', 'protected_area', 'other', 'park'],
    ['highway', 'trailhead', 'house', 'trailhead'],
    ['tourism', 'alpine_hut', 'house', 'hut'],
    ['tourism', 'wilderness_hut', 'house', 'hut'],
    ['amenity', 'shelter', 'house', 'shelter'],
    ['tourism', 'viewpoint', 'house', 'viewpoint'],
    ['boundary', 'administrative', 'state', 'region'],
  ])('%s=%s (%s) → %s', (key, value, layer, expected) => {
    expect(placeTypeOf(key, value, layer)).toBe(expected);
  });

  it('falls back on key-wide rules', () => {
    expect(placeTypeOf('waterway', 'brook')).toBe('river');
    expect(placeTypeOf('highway', 'residential', 'street')).toBe('road');
    expect(placeTypeOf('mountain_pass', 'no')).toBe('pass');
  });

  it("falls back on Photon's layer, then a generic place", () => {
    expect(placeTypeOf('foo', 'bar', 'city')).toBe('city');
    expect(placeTypeOf('foo', 'bar', 'county')).toBe('region');
    expect(placeTypeOf('foo', 'bar', 'street')).toBe('road');
    expect(placeTypeOf('tourism', 'hotel', 'house')).toBe('poi');
    expect(placeTypeOf('', '')).toBe('poi');
  });

  it('favours outdoor places over streets and shops', () => {
    for (const t of ['peak', 'lake', 'campground', 'park', 'trailhead', 'village'] as const) {
      expect(PLACE_TYPES[t].boost).toBeGreaterThan(PLACE_TYPES.poi.boost);
      expect(PLACE_TYPES[t].boost).toBeGreaterThan(PLACE_TYPES.road.boost);
    }
  });

  it('zooms cities out and peaks/campgrounds in', () => {
    expect(PLACE_TYPES.city.zoom).toBe(12);
    expect(PLACE_TYPES.village.zoom).toBe(14);
    expect(PLACE_TYPES.peak.zoom).toBeGreaterThanOrEqual(14);
    expect(PLACE_TYPES.campground.zoom).toBeLessThanOrEqual(15);
    expect(PLACE_TYPES.lake.fitBounds).toBe(true);
  });
});
