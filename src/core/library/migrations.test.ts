import type { GeoReference } from '@core/models';
import {
  LIBRARY_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  migrateLibraryIndex,
  migrateSettings,
  type LibraryIndex,
} from './migrations';

const geoRef = (pageIndex: number): GeoReference => ({
  pageIndex,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: 612, y1: 792 },
    corners: {
      topLeft: [-71, 47],
      topRight: [-70, 47],
      bottomRight: [-70, 46],
      bottomLeft: [-71, 46],
    },
  },
  bbox: { minLat: 46, maxLat: 47, minLng: -71, maxLng: -70 },
});

const track = (id: string) => ({
  id,
  name: id,
  startedAt: 1,
  stats: {
    distanceM: 0,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 1,
  },
  fileUri: `file://${id}.gpx`,
});

describe('migrateLibraryIndex', () => {
  it('migrates a legacy unversioned index with single-georeference maps', () => {
    const legacy = {
      maps: [
        {
          id: 'm1',
          name: 'Old map',
          fileUri: 'file://m1.pdf',
          importedAt: 123,
          pageCount: 3,
          georeference: geoRef(1), // pre-array shape, no activePages
        },
      ],
      tracks: [track('t1')],
      bundles: [],
      folders: [],
      activeMapId: 'm1',
    };
    const index = migrateLibraryIndex(legacy);
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.maps[0]?.georeferences).toEqual([geoRef(1)]);
    // activePages defaults to every georeferenced page so overlays stay on.
    expect(index.maps[0]?.activePages).toEqual([1]);
    expect(index.maps[0]).not.toHaveProperty('georeference');
    expect(index.activeTrackIds).toEqual([]); // older indexes never stored it
    expect(index.activeMapId).toBe('m1');
  });

  it('upgrades a v2 index: custom categories start empty, everything else kept', () => {
    const v2 = {
      schemaVersion: 2,
      maps: [],
      tracks: [track('t1'), { ...track('t2'), category: 'hike' }],
      bundles: [],
      folders: [],
      activeMapId: null,
      activeTrackIds: ['t1'],
    };
    const index = migrateLibraryIndex(v2);
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.customCategories).toEqual([]);
    expect(index.activeTrackIds).toEqual(['t1']);
    // Per-track categories ride along untouched (absent = uncategorized).
    expect(index.tracks[0]).not.toHaveProperty('category');
    expect(index.tracks[1]?.category).toBe('hike');
  });

  // Builds before the primary-viewport fix stored one activePages entry per
  // VIEWPORT, so a three-viewport US Topo / AUSTopo sheet persisted [0, 0, 0].
  // The overlay pipeline drew that as three stacked copies of the same raster
  // and the Library read "1 page(s) · 3/1 shown".
  it('heals activePages persisted once per viewport instead of once per page', () => {
    const index = migrateLibraryIndex({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      maps: [
        {
          id: 'm1',
          name: 'Grand Canyon — US Topo',
          fileUri: 'file://m1.pdf',
          importedAt: 5,
          pageCount: 1,
          georeferences: [geoRef(0)],
          activePages: [0, 0, 0],
        },
      ],
    });
    expect(index.maps[0]?.activePages).toEqual([0]);
  });

  it('sorts activePages and drops entries that cannot index a page', () => {
    const index = migrateLibraryIndex({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      maps: [
        {
          id: 'm1',
          name: 'Map',
          fileUri: 'file://m1.pdf',
          importedAt: 5,
          pageCount: 3,
          georeferences: [geoRef(0), geoRef(1), geoRef(2)],
          activePages: [2, 0, 2, '1', -1, 1.5, null, Number.NaN, 1],
        },
      ],
    });
    expect(index.maps[0]?.activePages).toEqual([0, 1, 2]);
  });

  it('passes a current-version index through unchanged', () => {
    const current: LibraryIndex = {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      maps: [
        {
          id: 'm1',
          name: 'Map',
          fileUri: 'maps/m1.pdf',
          importedAt: 5,
          pageCount: 2,
          georeferences: [geoRef(0), geoRef(1)],
          activePages: [1],
          folderId: 'f1',
          sourceItemId: 'cantopo-021l14',
          sourceUpdatedAt: '2019-07-24',
        },
      ],
      tracks: [{ ...track('t1'), fileUri: 'tracks/t1.gpx', folderId: 'f1', category: 'cat1' }],
      folders: [{ id: 'f1', name: 'F', createdAt: 8 }],
      mapVisibilityMode: 'folders',
      visibleFolderIds: ['f1'],
      activeMapId: 'm1',
      activeTrackIds: ['t1'],
      customCategories: [{ id: 'cat1', name: 'Canoe', color: '#C74FA0', createdAt: 10 }],
      waypoints: [
        { id: 'w1', latitude: 46.5, longitude: -70.5, label: 'Waypoint 1', createdAt: 10 },
      ],
    };
    expect(migrateLibraryIndex(current)).toEqual(current);
  });

  it('v4 → v5 stamps the version; maps stay untouched (no provenance yet)', () => {
    const v4 = {
      schemaVersion: 4,
      maps: [
        {
          id: 'm1',
          name: 'Map',
          fileUri: 'file://m1.pdf',
          importedAt: 5,
          pageCount: 1,
          georeferences: [geoRef(0)],
          activePages: [0],
        },
      ],
      tracks: [],
      folders: [],
      mapVisibilityMode: 'type',
      visibleFolderIds: [],
      activeMapId: 'm1',
      activeTrackIds: [],
      customCategories: [],
      waypoints: [],
    };
    const index = migrateLibraryIndex(v4);
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.maps[0]).not.toHaveProperty('sourceItemId');
    expect(index.maps[0]).not.toHaveProperty('sourceUpdatedAt');
    expect(index.activeMapId).toBe('m1');
  });

  it('drops wrong-typed catalog-provenance fields instead of keeping junk', () => {
    const index = migrateLibraryIndex({
      schemaVersion: 5,
      maps: [
        {
          id: 'm1',
          fileUri: 'maps/m1.pdf',
          georeferences: [geoRef(0)],
          sourceItemId: 42,
          sourceUpdatedAt: { when: 'yesterday' },
        },
      ],
    });
    expect(index.maps[0]).not.toHaveProperty('sourceItemId');
    expect(index.maps[0]).not.toHaveProperty('sourceUpdatedAt');
  });

  it('upgrades a v2 index: waypoints start empty', () => {
    const v2 = {
      schemaVersion: 2,
      maps: [],
      tracks: [track('t1')],
      bundles: [],
      folders: [],
      activeMapId: null,
      activeTrackIds: ['t1'],
    };
    const index = migrateLibraryIndex(v2);
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.waypoints).toEqual([]);
    expect(index.activeTrackIds).toEqual(['t1']); // v2 content is retained
  });

  it('drops junk fields and entries without throwing', () => {
    const index = migrateLibraryIndex({
      schemaVersion: 2,
      maps: [null, 42, { id: 'm1', fileUri: 'maps/m1.pdf', georeferences: [geoRef(0)] }],
      tracks: [track('t1'), 'not a track', { name: 'no id' }],
      bundles: 'nope',
      folders: [{ id: 'f1', name: 'F', createdAt: 1 }],
      activeMapId: 7,
      activeTrackIds: ['t1', 't-deleted', 3, null],
      customCategories: [
        { id: 'c1', name: 'Canoe', color: '#C74FA0', createdAt: 1 },
        { id: 'c2', name: '   ', color: '#C74FA0' }, // blank name → dropped
        { id: 'c3', name: 'No color' }, // missing color → dropped
        { name: 'no id' },
        null,
      ],
      waypoints: [
        { id: 'w1', latitude: 46, longitude: -70, label: 'Waypoint 1', createdAt: 1 },
        { id: 'w-bad-coord', latitude: 'north', longitude: -70 },
        { latitude: 46, longitude: -70 }, // no id
        'not a waypoint',
      ],
      totallyUnknownField: { deep: true },
    });
    expect(index.maps).toHaveLength(1);
    expect(index.maps[0]?.activePages).toEqual([0]); // defaulted from georeferences
    expect(index.tracks.map((t) => t.id)).toEqual(['t1']);
    expect(index).not.toHaveProperty('bundles');
    expect(index.folders).toHaveLength(1);
    expect(index.activeMapId).toBeNull();
    // Dangling / non-string overlay ids are pruned.
    expect(index.activeTrackIds).toEqual(['t1']);
    expect(index.customCategories.map((c) => c.id)).toEqual(['c1']);
    // Waypoints without an id or a finite coordinate are dropped.
    expect(index.waypoints.map((w) => w.id)).toEqual(['w1']);
    expect(index).not.toHaveProperty('totallyUnknownField');
  });

  it('v3 → v4 drops bundles and seeds the folder-visibility fields', () => {
    const v3 = {
      schemaVersion: 3,
      maps: [],
      tracks: [track('t1')],
      bundles: [{ id: 'b1', name: 'Trip', mapIds: [], trackIds: ['t1'], createdAt: 1 }],
      folders: [{ id: 'f1', name: 'Alps', createdAt: 1 }],
      activeMapId: null,
      activeTrackIds: [],
      waypoints: [],
      customCategories: [],
    };
    const index = migrateLibraryIndex(v3);
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index).not.toHaveProperty('bundles');
    expect(index.mapVisibilityMode).toBe('type');
    expect(index.visibleFolderIds).toEqual([]);
    expect(index.folders).toEqual([{ id: 'f1', name: 'Alps', createdAt: 1 }]);
  });

  it('sanitizes junk visibility fields to safe defaults', () => {
    const junk = {
      schemaVersion: 4,
      mapVisibilityMode: 'everything',
      visibleFolderIds: ['f1', 7, null, 'ungrouped'],
    };
    const index = migrateLibraryIndex(junk);
    expect(index.mapVisibilityMode).toBe('type');
    expect(index.visibleFolderIds).toEqual(['f1', 'ungrouped']);
  });

  it('keeps a valid folder visibility selection through migration', () => {
    const v4 = {
      schemaVersion: 4,
      mapVisibilityMode: 'folders',
      visibleFolderIds: ['f1'],
    };
    const index = migrateLibraryIndex(v4);
    expect(index.mapVisibilityMode).toBe('folders');
    expect(index.visibleFolderIds).toEqual(['f1']);
  });

  it('prunes an activeMapId that no longer matches a map', () => {
    const index = migrateLibraryIndex({ schemaVersion: 2, maps: [], activeMapId: 'gone' });
    expect(index.activeMapId).toBeNull();
  });

  it('returns an empty index for non-object input', () => {
    for (const junk of [null, undefined, 'hi', 12, [1, 2]]) {
      const index = migrateLibraryIndex(junk);
      expect(index).toEqual({
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        maps: [],
        tracks: [],
        folders: [],
        mapVisibilityMode: 'type',
        visibleFolderIds: [],
        activeMapId: null,
        activeTrackIds: [],
        customCategories: [],
        waypoints: [],
      });
    }
  });

  it('sanitizes an index from an unknown future version instead of rejecting it', () => {
    const index = migrateLibraryIndex({
      schemaVersion: 99,
      tracks: [track('t1')],
      activeTrackIds: ['t1'],
      fieldFromTheFuture: true,
    });
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.activeTrackIds).toEqual(['t1']);
    expect(index).not.toHaveProperty('fieldFromTheFuture');
  });

  // --- #247: absolute paths under a rotated iOS container -------------------
  //
  // iOS gives the app data container a new UUID on every app update. An index
  // written by 1.5.0 (5) names its files under the OLD one; after the update
  // the files are all still there, under the NEW one, and every persisted path
  // is dead. `rotatedIndex()` is exactly the bytes that state leaves on disk.

  const OLD_CONTAINER =
    'file:///var/mobile/Containers/Data/Application/11111111-2222-3333-4444-555555555555/Documents';
  const NEW_CONTAINER =
    'file:///var/mobile/Containers/Data/Application/99999999-8888-7777-6666-555555555555/Documents';

  const rotatedIndex = () => ({
    schemaVersion: 5,
    maps: [
      {
        id: 'm1',
        name: 'Map',
        fileUri: `${OLD_CONTAINER}/maps/m1.pdf`,
        importedAt: 5,
        pageCount: 1,
        georeferences: [geoRef(0)],
        activePages: [0],
      },
    ],
    tracks: [
      {
        ...track('t1'),
        fileUri: `${OLD_CONTAINER}/tracks/t1.gpx`,
        notes: [
          {
            id: 'n1',
            distanceM: 100,
            text: 'Beaver dam',
            createdAt: 20,
            photoUri: `${OLD_CONTAINER}/photos/p1.jpg`,
          },
          { id: 'n2', distanceM: 200, text: 'No photo here', createdAt: 21 },
        ],
      },
    ],
    folders: [],
    mapVisibilityMode: 'type',
    visibleFolderIds: [],
    activeMapId: 'm1',
    activeTrackIds: ['t1'],
    customCategories: [],
    waypoints: [
      {
        id: 'w1',
        latitude: 46.5,
        longitude: -70.5,
        label: 'Waypoint 1',
        createdAt: 10,
        photoUri: `${OLD_CONTAINER}/photos/p2.jpg`,
      },
    ],
  });

  it('relativises every path an update-rotated container stranded (#247)', () => {
    const index = migrateLibraryIndex(rotatedIndex(), NEW_CONTAINER);

    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.maps[0]?.fileUri).toBe('maps/m1.pdf');
    expect(index.tracks[0]?.fileUri).toBe('tracks/t1.gpx');
    expect(index.tracks[0]?.notes?.[0]?.photoUri).toBe('photos/p1.jpg');
    expect(index.waypoints[0]?.photoUri).toBe('photos/p2.jpg');
    // A note without a photo gains no photoUri key.
    expect(index.tracks[0]?.notes?.[1]).not.toHaveProperty('photoUri');
  });

  it('heals a stranded index with no document directory to compare against', () => {
    // The `/Documents/` landmark carries it alone; the prefix rule is only an
    // extra for the same-container and Android cases.
    const index = migrateLibraryIndex(rotatedIndex());
    expect(index.tracks[0]?.fileUri).toBe('tracks/t1.gpx');
    expect(index.waypoints[0]?.photoUri).toBe('photos/p2.jpg');
  });

  it('is idempotent: migrating the already-relative result changes nothing', () => {
    const once = migrateLibraryIndex(rotatedIndex(), NEW_CONTAINER);
    expect(migrateLibraryIndex(once, NEW_CONTAINER)).toEqual(once);
  });

  it('strips the CURRENT container prefix too (a same-container legacy index)', () => {
    const index = migrateLibraryIndex(
      {
        ...rotatedIndex(),
        tracks: [{ ...track('t1'), fileUri: `${NEW_CONTAINER}/tracks/t1.gpx` }],
      },
      NEW_CONTAINER,
    );
    expect(index.tracks[0]?.fileUri).toBe('tracks/t1.gpx');
  });

  it('leaves an absolute path under no document directory alone', () => {
    // Not ours to rewrite — a cache file, or a path from another app. The
    // store logs these rather than guessing at a relative form for them.
    const foreign = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/a.gpx';
    const index = migrateLibraryIndex(
      { ...rotatedIndex(), tracks: [{ ...track('t1'), fileUri: foreign }] },
      NEW_CONTAINER,
    );
    expect(index.tracks[0]?.fileUri).toBe(foreign);
  });

  it('keeps a map whose corners were persisted in projected metres (#243)', () => {
    // The CanTopo shape a build before the CRS fix wrote to disk: real
    // georeferencing whose corners are UTM easting/northing, and no record of
    // which projection they are in.
    //
    // Hydrate deliberately does NOT try to heal these. Re-deriving needs the
    // native CRS, which was never persisted; the metres alone cannot name it.
    // So the entry is kept verbatim — dropping it would make the card claim
    // "No georeferencing found", which is false and hides the real cause — and
    // `georeferenceNotice` explains the projection while the map waits to be
    // re-imported (or re-downloaded from the Search tab).
    const metres: GeoReference = {
      ...geoRef(0),
      source: 'lgidict',
      viewport: {
        rect: { x0: 338, y0: 214, x1: 2822, y1: 1892 },
        corners: {
          topLeft: [300848, 5236961],
          topRight: [351625, 5236961],
          bottomRight: [351625, 5202313],
          bottomLeft: [300848, 5202313],
        },
      },
      bbox: { minLng: 300848, minLat: 5202313, maxLng: 351625, maxLat: 5236961 },
    };
    const index = migrateLibraryIndex({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      maps: [
        {
          id: 'm1',
          name: 'CanTopo 021G14',
          fileUri: 'file://m1.pdf',
          importedAt: 1,
          pageCount: 1,
          georeferences: [metres],
          activePages: [0],
        },
      ],
    });
    expect(index.maps[0]?.georeferences).toEqual([metres]);
    expect(index.maps[0]?.activePages).toEqual([0]);
  });

  it('v7 → v8 stamps the version and leaves georeferences without a page box alone (#287)', () => {
    // A pre-v8 georeference never recorded its rendered page box. It must NOT
    // be invented here: absent means "placed the old way, re-import to
    // reprocess", and only the parser can know whether the page was cropped.
    const v7 = {
      schemaVersion: 7,
      maps: [{ id: 'm1', fileUri: 'maps/m1.pdf', georeferences: [geoRef(0)], activePages: [0] }],
    };
    const index = migrateLibraryIndex(v7);
    // The ladder always walks all the way to the current version.
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.maps[0]?.georeferences[0]).toEqual(geoRef(0));
    expect('pageBox' in (index.maps[0]?.georeferences[0] ?? {})).toBe(false);
  });

  it('carries a valid rendered page box through hydration (#287)', () => {
    const cropped: GeoReference = {
      ...geoRef(0),
      pageWidthPt: 100,
      pageHeightPt: 50,
      pageBox: { x0: 50, y0: 25, x1: 150, y1: 75 },
      viewport: { ...geoRef(0).viewport, rect: { x0: 50, y0: 25, x1: 150, y1: 75 } },
    };
    const index = migrateLibraryIndex({
      schemaVersion: 8,
      maps: [{ id: 'm1', fileUri: 'maps/m1.pdf', georeferences: [cropped], activePages: [0] }],
    });
    expect(index.maps[0]?.georeferences[0]).toEqual(cropped);
  });

  it('drops a junk rendered page box rather than dividing by its zero extent (#287)', () => {
    const junk = [
      { x0: 50, y0: 25, x1: 50, y1: 75 },
      { x0: 0, y0: 0, x1: Number.NaN, y1: 75 },
      { x0: '0', y0: 0, x1: 100, y1: 75 },
      'nope',
      null,
    ];
    for (const pageBox of junk) {
      const index = migrateLibraryIndex({
        schemaVersion: 8,
        maps: [
          {
            id: 'm1',
            fileUri: 'maps/m1.pdf',
            georeferences: [{ ...geoRef(0), pageBox }],
            activePages: [0],
          },
        ],
      });
      expect(index.maps[0]?.georeferences).toHaveLength(1);
      expect('pageBox' in (index.maps[0]?.georeferences[0] ?? {})).toBe(false);
    }
  });

  it('carries a georeference sourceCrs through hydration', () => {
    const withCrs: GeoReference = {
      ...geoRef(0),
      source: 'lgidict',
      sourceEpsg: 26919,
      sourceCrs: 'NAD83 / UTM zone 19N (EPSG:26919)',
    };
    const index = migrateLibraryIndex({
      maps: [{ id: 'm1', fileUri: 'maps/m1.pdf', georeferences: [withCrs], activePages: [0] }],
    });
    expect(index.maps[0]?.georeferences[0]?.sourceCrs).toBe('NAD83 / UTM zone 19N (EPSG:26919)');
  });
});

describe('migrateSettings', () => {
  const defaults = { tileUrl: 'https://tiles/{z}', offlineOnly: false, minDisplacementM: 5 };

  it('merges a legacy unversioned settings file over defaults', () => {
    const settings = migrateSettings({ offlineOnly: true }, defaults);
    expect(settings).toEqual({
      tileUrl: 'https://tiles/{z}',
      offlineOnly: true,
      minDisplacementM: 5,
    });
  });

  it('passes current v2 values through', () => {
    const settings = migrateSettings(
      { schemaVersion: SETTINGS_SCHEMA_VERSION, tileUrl: 'https://mine', minDisplacementM: 10 },
      defaults,
    );
    expect(settings.tileUrl).toBe('https://mine');
    expect(settings.minDisplacementM).toBe(10);
  });

  it('drops junk fields and wrong-typed values', () => {
    const settings = migrateSettings(
      { tileUrl: 42, offlineOnly: 'yes', minDisplacementM: 8, bogus: true },
      defaults,
    );
    expect(settings).toEqual({
      tileUrl: 'https://tiles/{z}',
      offlineOnly: false,
      minDisplacementM: 8,
    });
  });

  it('returns defaults for non-object input', () => {
    for (const junk of [null, undefined, 'x', 3, []]) {
      expect(migrateSettings(junk, defaults)).toEqual(defaults);
    }
  });
});

describe('malformed nested library records', () => {
  it('drops invalid georeferences while preserving valid map siblings', () => {
    const index = migrateLibraryIndex({
      maps: [
        { id: 'mixed', fileUri: 'maps/mixed.pdf', georeferences: [null, {}, geoRef(0)] },
        { id: 'legacy', fileUri: 'maps/legacy.pdf', georeference: null },
      ],
    });
    expect(index.maps.map((m) => m.id)).toEqual(['mixed', 'legacy']);
    expect(index.maps[0]?.georeferences).toEqual([geoRef(0)]);
    expect(index.maps[1]?.georeferences).toEqual([]);
  });

  it.each([
    { ...geoRef(0), pageIndex: -1 },
    { ...geoRef(0), pageWidthPt: null },
    { ...geoRef(0), viewport: null },
    { ...geoRef(0), viewport: { ...geoRef(0).viewport, rect: null } },
    { ...geoRef(0), viewport: { ...geoRef(0).viewport, corners: null } },
    {
      ...geoRef(0),
      viewport: {
        ...geoRef(0).viewport,
        corners: { ...geoRef(0).viewport.corners, topLeft: null },
      },
    },
    { ...geoRef(0), bbox: null },
  ])('drops incomplete nested geometry while retaining a usable map', (bad) => {
    const index = migrateLibraryIndex({
      maps: [{ id: 'map', fileUri: 'maps/map.pdf', georeferences: [bad, geoRef(1)] }],
    });
    expect(index.maps[0]?.georeferences).toEqual([geoRef(1)]);
    expect(index.maps[0]?.activePages).toEqual([1]);
  });

  it('drops records without usable file paths and prunes their active ids', () => {
    const index = migrateLibraryIndex({
      maps: [{ id: 'bad-map' }, { id: 'map', fileUri: 'maps/map.pdf' }],
      tracks: [
        { ...track('missing'), fileUri: undefined },
        { ...track('bad'), fileUri: 42 },
        track('good'),
      ],
      activeMapId: 'bad-map',
      activeTrackIds: ['missing', 'bad', 'good'],
    });
    expect(index.maps.map((m) => m.id)).toEqual(['map']);
    expect(index.tracks.map((t) => t.id)).toEqual(['good']);
    expect(index.activeMapId).toBeNull();
    expect(index.activeTrackIds).toEqual(['good']);
  });

  it('sanitizes non-array notes and invalid nested photo paths without losing trails', () => {
    const note = { id: 'note', distanceM: 5, text: 'Saved', createdAt: 1 };
    const index = migrateLibraryIndex({
      tracks: [
        { ...track('non-array'), notes: {} },
        {
          ...track('mixed'),
          notes: [
            null,
            {},
            { ...note, photoUri: 42 },
            { ...note, id: 'photo', photoUri: 'photos/photo.jpg' },
          ],
        },
      ],
      waypoints: [
        { id: 'w', latitude: 46, longitude: -71, label: 'W', createdAt: 1, photoUri: {} },
      ],
    });
    expect(index.tracks.map((t) => t.id)).toEqual(['non-array', 'mixed']);
    expect(index.tracks[0]?.notes).toEqual([]);
    expect(index.tracks[1]?.notes).toEqual([
      note,
      { ...note, id: 'photo', photoUri: 'photos/photo.jpg' },
    ]);
    expect(index.waypoints[0]).not.toHaveProperty('photoUri');
  });

  it('upgrades a v8 index: waypoints keep drawing the default pin (#350)', () => {
    const index = migrateLibraryIndex({
      schemaVersion: 8,
      waypoints: [{ id: 'w1', latitude: 46, longitude: -71, label: 'Waypoint 1', createdAt: 1 }],
    });
    expect(index.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(index.waypoints[0]).not.toHaveProperty('icon');
  });

  it('carries a known waypoint icon through hydration (#350)', () => {
    const index = migrateLibraryIndex({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      waypoints: [
        { id: 'w1', latitude: 46, longitude: -71, label: 'Camp', createdAt: 1, icon: 'camp' },
      ],
    });
    expect(index.waypoints[0]?.icon).toBe('camp');
  });

  it('drops an unknown or junk waypoint icon rather than asking for a glyph that does not exist (#350)', () => {
    for (const icon of ['zipline', '', 'Camp', 42, null, {}, ['camp'], 'toString']) {
      const index = migrateLibraryIndex({
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        waypoints: [{ id: 'w1', latitude: 46, longitude: -71, label: 'W', createdAt: 1, icon }],
      });
      expect(index.waypoints).toHaveLength(1);
      expect(index.waypoints[0]).not.toHaveProperty('icon');
    }
  });
});

it('retains known interrupted-page errors and keeps their pages off during normalization', () => {
  const index = migrateLibraryIndex({
    maps: [
      {
        id: 'm',
        name: 'Map',
        fileUri: 'maps/m.pdf',
        pageCount: 3,
        activePages: [0, 1, 2],
        renderRecoveryErrors: [
          { pageIndex: 1, reason: 'interrupted' },
          { pageIndex: 1, reason: 'interrupted' },
          { pageIndex: -1, reason: 'interrupted' },
          { pageIndex: 4, reason: 'interrupted' },
          { pageIndex: 2, reason: 'unknown' },
          { pageIndex: '0', reason: 'interrupted' },
          null,
        ],
      },
    ],
  });
  expect(index.maps[0]?.renderRecoveryErrors).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
  expect(index.maps[0]?.activePages).toEqual([0, 2]);
  expect(migrateLibraryIndex(index)).toEqual(index);
});

it('bounds persisted render-failed messages and keeps their pages paused', () => {
  const index = migrateLibraryIndex({
    maps: [
      {
        id: 'm',
        name: 'Map',
        fileUri: 'maps/m.pdf',
        pageCount: 1,
        activePages: [0],
        renderRecoveryErrors: [{ pageIndex: 0, reason: 'render-failed', message: 'x'.repeat(900) }],
      },
    ],
  });
  expect(index.maps[0]?.activePages).toEqual([]);
  expect(index.maps[0]?.renderRecoveryErrors).toEqual([
    { pageIndex: 0, reason: 'render-failed', message: 'x'.repeat(400) },
  ]);
});
