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

  it('passes a current v5 index through unchanged', () => {
    const v5: LibraryIndex = {
      schemaVersion: 5,
      maps: [
        {
          id: 'm1',
          name: 'Map',
          fileUri: 'file://m1.pdf',
          importedAt: 5,
          pageCount: 2,
          georeferences: [geoRef(0), geoRef(1)],
          activePages: [1],
          folderId: 'f1',
          sourceItemId: 'cantopo-021l14',
          sourceUpdatedAt: '2019-07-24',
        },
      ],
      tracks: [{ ...track('t1'), folderId: 'f1', category: 'cat1' }],
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
    expect(migrateLibraryIndex(v5)).toEqual(v5);
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
    expect(index.schemaVersion).toBe(5);
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
      maps: [null, 42, { id: 'm1', georeferences: [geoRef(0)] }],
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
