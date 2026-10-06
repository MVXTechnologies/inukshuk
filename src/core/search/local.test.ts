import { searchLocal, type LocalSearchSources } from './local';

const EMPTY: LocalSearchSources = {
  waypoints: [],
  tracks: [],
  maps: [],
  catalog: [],
  longTrails: [],
};

const SOURCES: LocalSearchSources = {
  waypoints: [
    { id: 'w1', label: 'Camp du lac Sainte-Anne', latitude: 47.1, longitude: -70.9 },
    { id: 'w2', label: 'Car', latitude: 46.8, longitude: -71.2 },
  ],
  tracks: [
    {
      id: 't1',
      name: 'Sentier des Caps',
      bbox: { minLat: 47.1, minLng: -70.8, maxLat: 47.2, maxLng: -70.6 },
    },
    { id: 't2', name: 'Caps without geometry' },
  ],
  maps: [
    {
      id: 'm1',
      name: 'Mont-Sainte-Anne été',
      bbox: { minLat: 47, minLng: -71, maxLat: 47.2, maxLng: -70.8 },
    },
  ],
  catalog: [
    { id: 'c1', title: 'Mont-Sainte-Anne', bbox: [-71, 47, -70.75, 47.25], region: 'CA-QC' },
    { id: 'c2', title: 'Sainte-Anne-des-Monts' },
    { id: 'c3', title: 'Lac Sainte-Anne', bbox: [-114.5, 53.5, -114, 53.8] },
  ],
  longTrails: [
    {
      id: 'r1',
      name: 'Sentier international des Appalaches',
      nameEn: 'International Appalachian Trail',
      bbox: [-70, 45, -64, 49],
      mid: [-66, 48],
      region: 'Québec',
    },
    {
      id: 'r2',
      name: 'Traversée de Charlevoix',
      bbox: [-70.9, 47.4, -70.4, 47.7],
      mid: [-70.6, 47.5],
    },
  ],
};

const opts = { lang: 'fr' as const, origin: { latitude: 47.08, longitude: -70.93 } };

describe('searchLocal', () => {
  it('finds nothing for an empty query', () => {
    expect(searchLocal('  ', SOURCES, opts)).toEqual([]);
  });

  it('searches waypoints, maps and catalog sheets, accent- and order-insensitively', () => {
    const ids = searchLocal('sainte anne', SOURCES, opts).map((r) => r.place.id);
    expect(ids).toEqual(
      expect.arrayContaining(['waypoint:w1', 'map:m1', 'catalog:c1', 'catalog:c3']),
    );
    // A sheet with no footprint cannot be flown to.
    expect(ids).not.toContain('catalog:c2');
    expect(searchLocal('anne mont ete', SOURCES, opts)[0]?.place.id).toBe('map:m1');
  });

  it('frames trails and maps by their bounds', () => {
    const [trail] = searchLocal('caps', SOURCES, opts);
    expect(trail?.place).toMatchObject({
      id: 'track:t1',
      type: 'track',
      bbox: [-70.8, 47.1, -70.6, 47.2],
      latitude: expect.closeTo(47.15, 5) as number,
      context: 'Your trail',
    });
    expect(searchLocal('caps', SOURCES, opts)).toHaveLength(1);
  });

  it('finds long trails by any of their names, shown in the user language', () => {
    const [fr] = searchLocal('appalachian', SOURCES, opts);
    expect(fr?.place).toMatchObject({
      id: 'longTrail:r1',
      name: 'Sentier international des Appalaches',
      altName: 'International Appalachian Trail',
      context: 'Long trail · Québec',
      latitude: 48,
      longitude: -66,
    });
    const [en] = searchLocal('appalaches', SOURCES, { ...opts, lang: 'en' });
    expect(en?.place.name).toBe('International Appalachian Trail');
    expect(en?.place.altName).toBeUndefined();
    const [plain] = searchLocal('charlevoix', SOURCES, { ...opts, lang: 'en' });
    expect(plain?.place).toMatchObject({ name: 'Traversée de Charlevoix', context: 'Long trail' });
  });

  it('labels catalog sheets and caps the list', () => {
    const sheet = searchLocal('lac sainte', SOURCES, opts).find((r) => r.place.id === 'catalog:c3');
    expect(sheet?.place).toMatchObject({ type: 'map', context: 'Map sheet' });
    const many: LocalSearchSources = {
      ...EMPTY,
      waypoints: Array.from({ length: 30 }, (_, i) => ({
        id: `w${i}`,
        label: `Cairn ${i}`,
        latitude: 47,
        longitude: -71,
      })),
    };
    expect(searchLocal('cairn', many, { ...opts, max: 4 })).toHaveLength(4);
    expect(searchLocal('cairn', many, opts)).toHaveLength(10);
  });

  it('labels a sheet with its region', () => {
    const [sheet] = searchLocal('mont sainte anne', { ...EMPTY, catalog: SOURCES.catalog }, opts);
    expect(sheet?.place.context).toBe('Map sheet · CA-QC');
  });
});

describe('climbing crags', () => {
  it('finds crags by folded name, as climbing crags', () => {
    const out = searchLocal(
      'belair',
      {
        ...EMPTY,
        crags: [
          { uid: 'ob-1', name: 'Val-Bélair', lng: -71.5, lat: 46.85, region: 'Portneuf' },
          { uid: 'ob-2', name: 'Weir', folded: 'weir', lng: -74.5, lat: 45.9 },
        ],
      },
      { lang: 'en', origin: null },
    );
    expect(out.map((r) => [r.place.id, r.place.type, r.place.context])).toEqual([
      ['crag:ob-1', 'crag', 'Portneuf'],
    ]);
  });

  it('caps a common word before ranking', () => {
    const crags = Array.from({ length: 200 }, (_, i) => ({
      uid: `c${i}`,
      name: `Lac ${i}`,
      lng: 0,
      lat: 0,
    }));
    expect(
      searchLocal('lac', { ...EMPTY, crags }, { lang: 'en', origin: null, max: 100 }),
    ).toHaveLength(50);
  });
});
