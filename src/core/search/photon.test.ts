import { parseElevation, parsePhotonResponse } from './photon';

/** Trimmed from a real `photon.komoot.io/api?q=Mont-Sainte-Anne&lang=fr` answer. */
const MONT_SAINTE_ANNE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-70.9260678, 47.0877219] },
      properties: {
        osm_type: 'W',
        osm_id: 391681261,
        osm_key: 'leisure',
        osm_value: 'sports_centre',
        type: 'house',
        name: 'Mont-Sainte-Anne',
        city: 'Beaupré',
        county: 'La Côte-de-Beaupré',
        state: 'Québec',
        country: 'Canada',
        countrycode: 'CA',
        extent: [-70.9476349, 47.1014134, -70.9040043, 47.0732894],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-70.9320238, 47.0874373] },
      properties: {
        osm_type: 'N',
        osm_id: 1206506570,
        osm_key: 'natural',
        osm_value: 'peak',
        type: 'other',
        name: 'Mont Sainte-Anne',
        alt_name: 'Mount Sainte-Anne',
        city: 'Beaupré',
        state: 'Québec',
        country: 'Canada',
        extra: { ele: '800' },
      },
    },
  ],
};

describe('parsePhotonResponse', () => {
  it('maps features to places', () => {
    const [centre, peak] = parsePhotonResponse(MONT_SAINTE_ANNE);
    expect(centre).toEqual({
      id: 'osm:W391681261',
      source: 'index',
      type: 'poi',
      name: 'Mont-Sainte-Anne',
      latitude: 47.0877219,
      longitude: -70.9260678,
      // extent is [minLon, maxLat, maxLon, minLat]; bbox is [w, s, e, n].
      bbox: [-70.9476349, 47.0732894, -70.9040043, 47.1014134],
      context: 'Beaupré, Québec, Canada',
    });
    expect(peak).toMatchObject({
      id: 'osm:N1206506570',
      type: 'peak',
      name: 'Mont Sainte-Anne',
      altName: 'Mount Sainte-Anne',
      elevationM: 800,
    });
    expect(peak?.bbox).toBeUndefined();
  });

  it('does not repeat the name in the context, nor a part twice', () => {
    const [city] = parsePhotonResponse({
      features: [
        {
          geometry: { coordinates: [-71.2, 46.8] },
          properties: {
            osm_key: 'place',
            osm_value: 'city',
            name: 'Québec',
            city: 'Québec',
            state: 'Québec',
            country: 'Canada',
          },
        },
      ],
    });
    expect(city?.context).toBe('Canada');
    expect(city?.type).toBe('city');
    expect(city?.id).toBe('osm:Québec@46.8000,-71.2000');
  });

  it('drops an alt name equal to the name, and elevation on non-summits', () => {
    const [lake] = parsePhotonResponse({
      features: [
        {
          geometry: { coordinates: [-72, 48.6] },
          properties: {
            osm_type: 'R',
            osm_id: 1,
            osm_key: 'natural',
            osm_value: 'water',
            name: 'Lac Saint-Jean',
            alt_name: 'Lac Saint-Jean',
            extra: { ele: '101' },
          },
        },
      ],
    });
    expect(lake?.altName).toBeUndefined();
    expect(lake?.elevationM).toBeUndefined();
    expect(lake?.context).toBeUndefined();
  });

  it('skips malformed features and junk bodies', () => {
    expect(parsePhotonResponse(null)).toEqual([]);
    expect(parsePhotonResponse('nope')).toEqual([]);
    expect(parsePhotonResponse({ features: 'x' })).toEqual([]);
    const places = parsePhotonResponse({
      features: [
        null,
        { properties: null },
        { geometry: { coordinates: [0, 0] }, properties: { name: '  ' } },
        { geometry: { coordinates: [0, 95] }, properties: { name: 'Off the globe' } },
        { geometry: null, properties: { name: 'No geometry' } },
        {
          geometry: { coordinates: [1, 2] },
          properties: { name: 'Bad extent', extent: [1, 1, 2] },
        },
        {
          geometry: { coordinates: [1, 2] },
          properties: { name: 'Upside down', extent: [0, 1, 2, 3], extra: null },
        },
      ],
    });
    expect(places.map((p) => p.name)).toEqual(['Bad extent', 'Upside down']);
    expect(places.every((p) => p.bbox === undefined)).toBe(true);
  });
});

describe('parseElevation', () => {
  it.each<[unknown, number | undefined]>([
    [1234, 1234],
    ['1234', 1234],
    ['1 234 m', 1234],
    ['1606.5', 1607],
    ['1606,5 m', 1607],
    ['5267 ft', 1605],
    ["5267'", 1605],
    ['approx 800', undefined],
    ['', undefined],
    [null, undefined],
    [Number.NaN, undefined],
  ])('%p → %p', (input, expected) => {
    expect(parseElevation(input)).toBe(expected);
  });
});
