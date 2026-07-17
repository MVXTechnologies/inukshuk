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

  it('passes a current v3 index through unchanged', () => {
    const v3: LibraryIndex = {
      schemaVersion: 3,
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
        },
      ],
      tracks: [{ ...track('t1'), folderId: 'f1', category: 'cat1' }],
      bundles: [{ id: 'b1', name: 'B', mapIds: ['m1'], trackIds: ['t1'], createdAt: 9 }],
      folders: [{ id: 'f1', name: 'F', createdAt: 8 }],
      activeMapId: 'm1',
      activeTrackIds: ['t1'],
      customCategories: [{ id: 'cat1', name: 'Canoe', color: '#C74FA0', createdAt: 10 }],
      waypoints: [
        { id: 'w1', latitude: 46.5, longitude: -70.5, label: 'Waypoint 1', createdAt: 10 },
      ],
    };
    expect(migrateLibraryIndex(v3)).toEqual(v3);
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
    expect(index.schemaVersion).toBe(3);
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
    expect(index.bundles).toEqual([]);
    expect(index.folders).toHaveLength(1);
    expect(index.activeMapId).toBeNull();
    // Dangling / non-string overlay ids are pruned.
    expect(index.activeTrackIds).toEqual(['t1']);
    expect(index.customCategories.map((c) => c.id)).toEqual(['c1']);
    // Waypoints without an id or a finite coordinate are dropped.
    expect(index.waypoints.map((w) => w.id)).toEqual(['w1']);
    expect(index).not.toHaveProperty('totallyUnknownField');
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
        bundles: [],
        folders: [],
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
