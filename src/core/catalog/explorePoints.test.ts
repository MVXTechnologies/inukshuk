import { filterExploreItems, type ExploreFilter, type ItemFacets } from './exploreFacets';
import type { ExploreBounds } from './exploreMap';
import {
  countPlaceFacets,
  cullPoints,
  cullWindow,
  EXPLORE_CULL_THRESHOLD,
  exploreEmptyState,
  explorePointCollection,
  explorePoints,
  inAreaLabel,
  mapSheetPoints,
  matchesPlaceFilter,
  nearestPointsView,
  placePointKey,
  placePoints,
  pointDistanceMeters,
  pointsInBounds,
  pointsInSheetView,
  sortPointsByDistance,
  tappedPointOf,
} from './explorePoints';
import type { CatalogItem } from './schema';
import type { CatalogActivity, LinkOutCollection, LinkOutPlace } from './taxonomy';

const QUEBEC = { latitude: 46.8139, longitude: -71.2082 };

const item = (id: string, lat: number, lon: number, activities: CatalogActivity[] = []) =>
  ({
    id,
    sourceId: 'src',
    title: id,
    category: 'topo',
    bbox: [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1],
    format: 'geopdf',
    packaging: 'none',
    url: `https://example.test/${id}.pdf`,
    activities,
  }) as CatalogItem;

const facetsOf = (i: CatalogItem): ItemFacets => ({
  kind: 'topo',
  activities: i.activities ?? [],
  terrain: [],
});

const place = (
  id: string,
  type: string,
  lat: number,
  lon: number,
  activities?: CatalogActivity[],
): LinkOutPlace => ({
  id,
  name: `Place ${id}`,
  type,
  latitude: lat,
  longitude: lon,
  url: `https://example.test/${id}/`,
  ...(activities ? { activities } : {}),
});

const sepaq: LinkOutCollection = {
  id: 'sepaq',
  name: 'Parcs Québec',
  publisher: 'Sépaq',
  blurb: 'Maps on sepaq.com',
  homepage: 'https://www.sepaq.com',
  places: [
    place('jac', 'National park', 47.29, -71.35),
    place('ssl', 'Marine park', 48.02, -70.0),
    place('lau', 'Wildlife reserve', 47.7, -71.38),
  ],
};
const zecs: LinkOutCollection = {
  id: 'zecs',
  name: 'Zecs du Québec',
  publisher: 'Réseau Zec',
  blurb: 'Maps from Réseau Zec',
  homepage: 'https://reseauzec.com/cartotheque/',
  places: [
    place('batiscan', 'ZEC', 47.13, -71.85),
    place('martin-valin', 'ZEC', 48.63, -70.56, ['paddling', 'hunting', 'fishing', 'camping']),
  ],
};
const collections = [sepaq, zecs];

const items = [
  item('hike', 47.0, -71.3, ['hiking']),
  item('paddle', 48.2, -70.1, ['paddling']),
  { ...item('nowhere', 0, 0, ['hiking']), bbox: undefined } as CatalogItem,
];

/** What the screen does: filter the catalog, then add the matching places. */
const pointsFor = (filter: ExploreFilter) =>
  explorePoints(filterExploreItems(items, filter, facetsOf), collections, filter);
const keys = (filter: ExploreFilter) => pointsFor(filter).map((p) => p.key);

describe('explorePoints — what an activity puts on the map', () => {
  it('no filter: every placeable sheet and every place', () => {
    expect(keys({})).toEqual([
      'hike',
      'paddle',
      'place:sepaq/jac',
      'place:sepaq/ssl',
      'place:sepaq/lau',
      'place:zecs/batiscan',
      'place:zecs/martin-valin',
    ]);
  });

  it('hunting: the reserve and the zecs (by type default or own tags), no sheet', () => {
    expect(keys({ activity: 'hunting' })).toEqual([
      'place:sepaq/lau',
      'place:zecs/batiscan',
      'place:zecs/martin-valin',
    ]);
    expect(keys({ activity: 'fishing' })).toEqual(keys({ activity: 'hunting' }));
  });

  it('paddling: the paddling sheet AND the places tagged for it', () => {
    expect(keys({ activity: 'paddling' })).toEqual([
      'paddle',
      'place:sepaq/ssl',
      'place:zecs/martin-valin',
    ]);
  });

  it('hiking: sheets and national parks; an item without a bbox is never a point', () => {
    expect(keys({ activity: 'hiking' })).toEqual(['hike', 'place:sepaq/jac']);
  });

  it('an activity nothing carries yields no points', () => {
    expect(keys({ activity: 'ski' })).toEqual([]);
  });

  it('Type reaches places through their type; terrain and source leave places out', () => {
    expect(placePoints(collections, { kind: 'hunting-fishing' }).map((p) => p.place.id)).toEqual([
      'lau',
      'batiscan',
      'martin-valin',
    ]);
    expect(placePoints(collections, { kind: 'park' }).map((p) => p.place.id)).toEqual([
      'jac',
      'ssl',
    ]);
    expect(placePoints(collections, { kind: 'topo' })).toEqual([]);
    expect(placePoints(collections, { terrain: 'water' })).toEqual([]);
    expect(placePoints(collections, { sourceId: 'src' })).toEqual([]);
  });

  it('text matches name, type, publisher or collection, diacritic-folded', () => {
    const jac = sepaq.places[0] as LinkOutPlace;
    expect(matchesPlaceFilter(jac, sepaq, { text: 'sepaq national' })).toBe(true);
    expect(matchesPlaceFilter(jac, sepaq, { text: 'zec' })).toBe(false);
    expect(placePoints(collections, { text: 'reseau' }).map((p) => p.place.id)).toEqual([
      'batiscan',
      'martin-valin',
    ]);
  });

  it('drops a duplicated place and one without finite coordinates', () => {
    const odd: LinkOutCollection = {
      ...zecs,
      places: [
        place('a', 'ZEC', 47, -71),
        place('a', 'ZEC', 48, -72),
        place('b', 'ZEC', Number.NaN, -71),
      ],
    };
    const out = placePoints([odd]);
    expect(out.map((p) => p.key)).toEqual([placePointKey('zecs', 'a')]);
    expect(out[0]?.latitude).toBe(47);
  });

  it('a sheet sits at its footprint centre', () => {
    const [first] = mapSheetPoints(items);
    expect(first).toMatchObject({ kind: 'map', key: 'hike' });
    expect(first?.latitude).toBeCloseTo(47.0);
    expect(first?.longitude).toBeCloseTo(-71.3);
  });
});

describe('explorePointCollection — the clustered source input', () => {
  it('one feature per point, carrying its key and kind', () => {
    const fc = explorePointCollection(pointsFor({ activity: 'paddling' }));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.map((f) => f.properties)).toEqual([
      { id: 'paddle', kind: 'map' },
      { id: 'place:sepaq/ssl', kind: 'place' },
      { id: 'place:zecs/martin-valin', kind: 'place' },
    ]);
    expect(fc.features[1]?.geometry).toEqual({ type: 'Point', coordinates: [-70.0, 48.02] });
    expect(new Set(fc.features.map((f) => f.id)).size).toBe(3);
  });

  it('reads a tapped feature back; a cluster is not a point', () => {
    expect(tappedPointOf({ properties: { id: 'place:zecs/batiscan', kind: 'place' } })).toEqual({
      kind: 'place',
      key: 'place:zecs/batiscan',
    });
    // A feature from before `kind` existed is a map sheet.
    expect(tappedPointOf({ properties: { id: 'hike' } })).toEqual({ kind: 'map', key: 'hike' });
    expect(tappedPointOf({ properties: { cluster: true, cluster_id: 3, id: 'x' } })).toBeNull();
    expect(tappedPointOf({ properties: { id: '' } })).toBeNull();
    expect(tappedPointOf({ properties: null })).toBeNull();
  });
});

describe('view helpers', () => {
  const all = pointsFor({});
  const view: ExploreBounds = [-72, 46.5, -71, 47.5];

  it('keeps the points on screen, and above the sheet', () => {
    expect(pointsInBounds(all, view).map((p) => p.key)).toEqual([
      'hike',
      'place:sepaq/jac',
      'place:zecs/batiscan',
    ]);
    // The bottom 60% is under the sheet: only what is north of 47.1°N shows.
    expect(pointsInSheetView(all, view, 0.6).map((p) => p.key)).toEqual([
      'place:sepaq/jac',
      'place:zecs/batiscan',
    ]);
  });

  it('sorts nearest-first, and leaves the order alone without an origin', () => {
    expect(sortPointsByDistance(all, QUEBEC).map((p) => p.key)[0]).toBe('hike');
    expect(sortPointsByDistance(all, QUEBEC).at(-1)?.key).toBe('place:zecs/martin-valin');
    expect(sortPointsByDistance(all, null).map((p) => p.key)).toEqual(all.map((p) => p.key));
  });

  it('frames the user and the nearest points', () => {
    const box = nearestPointsView(QUEBEC, all, 2);
    // The two nearest are the hike sheet (47.0) and Jacques-Cartier (47.29).
    expect(box?.[1]).toBeCloseTo(QUEBEC.latitude);
    expect(box?.[3]).toBeCloseTo(47.29);
    expect(box?.[0]).toBeCloseTo(-71.35);
    expect(box?.[2]).toBeCloseTo(QUEBEC.longitude);
    expect(nearestPointsView(null, all)).toBeNull();
    expect(nearestPointsView(QUEBEC, [])).toBeNull();
  });

  it('measures the distance to a point', () => {
    const d = pointDistanceMeters({ latitude: 47.13, longitude: -71.85 }, QUEBEC);
    expect(d).toBeGreaterThan(55_000);
    expect(d).toBeLessThan(65_000);
    expect(pointDistanceMeters(QUEBEC, null)).toBeNull();
  });

  it('labels what is in the area', () => {
    expect(inAreaLabel([])).toBe('0 maps in this area');
    expect(inAreaLabel([{ kind: 'map' }])).toBe('1 map in this area');
    expect(inAreaLabel([{ kind: 'place' }])).toBe('1 place in this area');
    expect(inAreaLabel(all)).toBe('2 maps · 5 places in this area');
  });
});

describe('viewport culling', () => {
  const view: ExploreBounds = [-72, 46, -70, 48];

  it('pads the view by one view-size on every side', () => {
    expect(cullWindow(view, null)).toEqual([-74, 44, -68, 50]);
  });

  it('returns the SAME window while the view pans inside it', () => {
    const first = cullWindow(view, null);
    expect(cullWindow([-73, 45, -71, 47], first)).toBe(first);
    expect(cullWindow(view, first)).toBe(first);
  });

  it('moves the window once the view leaves it', () => {
    const first = cullWindow(view, null);
    const next = cullWindow([-69, 46, -67, 48], first);
    expect(next).toEqual([-71, 44, -65, 50]);
  });

  it('tightens after a deep zoom-in, and widens after a zoom-out', () => {
    const first = cullWindow(view, null);
    const deep = cullWindow([-71.1, 46.9, -71.0, 47.0], first);
    expect(deep[2] - deep[0]).toBeCloseTo(0.3);
    const wide = cullWindow([-80, 40, -60, 55], deep);
    expect(wide).toEqual([-100, 25, -40, 70]);
  });

  it('gives the whole world to a world view or one across the antimeridian', () => {
    const world = cullWindow([-170, -60, 170, 70], null);
    expect(world).toEqual([-180, -90, 180, 90]);
    expect(cullWindow([170, -20, -170, 20], world)).toBe(world);
    // …and lets go of it when the view comes back down to a region.
    expect(cullWindow(view, world)).toEqual([-74, 44, -68, 50]);
  });

  it('hands over every point while they are few (same array), a window of them past the threshold', () => {
    const few = pointsFor({});
    expect(cullPoints(few, cullWindow(view, null))).toBe(few);
    expect(cullPoints(few, null, 0)).toBe(few);

    // A 100 × 100 grid over 20° × 20°: 10 000 sheets, like a loaded continent.
    const many = [];
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) many.push({ latitude: 40 + i * 0.2, longitude: -80 + j * 0.2 });
    }
    expect(many.length).toBeGreaterThan(EXPLORE_CULL_THRESHOLD);
    const kept = cullPoints(many, cullWindow(view, null));
    expect(kept.length).toBeLessThan(many.length / 5);
    // Everything on screen survives the cull.
    expect(pointsInBounds(kept, view)).toHaveLength(pointsInBounds(many, view).length);
  });
});

describe('chips and the empty state', () => {
  it('counts the places each Type and Activity adds', () => {
    expect(countPlaceFacets(collections)).toEqual({
      kinds: { park: 2, 'hunting-fishing': 3 },
      activities: { hiking: 1, camping: 2, paddling: 2, hunting: 3, fishing: 3 },
    });
    expect(countPlaceFacets([])).toEqual({ kinds: {}, activities: {} });
  });

  it('says why an activity draws nothing — and stays quiet otherwise', () => {
    const base = { activity: 'ski' as const, pointCount: 0, searchable: false, loading: false };
    expect(exploreEmptyState(base)).toBe('none');
    expect(exploreEmptyState({ ...base, searchable: true })).toBe('searchable');
    expect(exploreEmptyState({ ...base, loading: true })).toBeNull();
    expect(exploreEmptyState({ ...base, pointCount: 3 })).toBeNull();
    expect(exploreEmptyState({ ...base, activity: null })).toBeNull();
    expect(exploreEmptyState({ ...base, activity: undefined })).toBeNull();
  });
});
