import type { LibraryIndex } from '@core/library/migrations';
import type { Track } from '@core/models';
import * as storage from '@data/storage';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(async () => null),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
}));

/**
 * #247 — the library index on disk must never carry an absolute path.
 *
 * iOS hands the app data container a new UUID on every app update, so an
 * absolute `file:///…/Application/<UUID>/Documents/tracks/x.gpx` written by
 * the build the user is updating FROM points at nothing afterwards, while the
 * file itself sits intact in the new container. That is what "22 GPX files
 * present, 0 openable" looked like.
 *
 * The store keeps absolute uris in memory (every consumer — `<Image>`,
 * `Sharing`, the GPX reader — wants one) and translates at the persistence
 * boundary: relative out, absolute back in, healing whatever it finds.
 *
 * The mocked document directory is `file:///doc` (see `@data/storageTestMock`).
 */

const OLD_CONTAINER =
  'file:///var/mobile/Containers/Data/Application/11111111-2222-3333-4444-555555555555/Documents';

const stats: Track['stats'] = {
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  pointCount: 1,
};

const track: Track = {
  id: 't1',
  name: 'Mont Wright loop',
  startedAt: 1,
  status: 'finished',
  points: [{ latitude: 46.8, longitude: -71.2, time: 0 }],
  stats,
};

/** The last index handed to `writeIndex`. */
const lastWritten = (): LibraryIndex =>
  (storage.writeIndex as jest.Mock).mock.calls.at(-1)?.[0] as LibraryIndex;

/** A `library.json` as an iPhone finds it right after an app update. */
const strandedIndex = () => ({
  schemaVersion: 5,
  maps: [
    {
      id: 'm1',
      name: 'Sentiers',
      fileUri: `${OLD_CONTAINER}/maps/m1.pdf`,
      importedAt: 5,
      pageCount: 1,
      georeferences: [],
      activePages: [],
    },
  ],
  tracks: [
    {
      id: 'saved',
      name: 'Saved trail',
      startedAt: 1,
      stats,
      fileUri: `${OLD_CONTAINER}/tracks/saved.gpx`,
      notes: [
        {
          id: 'n1',
          distanceM: 10,
          text: 'Bridge out',
          createdAt: 2,
          photoUri: `${OLD_CONTAINER}/photos/p1.jpg`,
        },
      ],
    },
  ],
  folders: [],
  mapVisibilityMode: 'type',
  visibleFolderIds: [],
  activeMapId: 'm1',
  activeTrackIds: ['saved'],
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

// Hydration is a module-level single-flight (one hydrate per JS lifetime), so
// these tests share module state and run in order.

it('hydrate rehomes a stranded index onto the CURRENT container', async () => {
  (storage.readIndex as jest.Mock).mockResolvedValueOnce(strandedIndex());
  await useLibraryStore.getState().hydrate();

  const s = useLibraryStore.getState();
  // Nothing was dropped — the index was never the problem, the paths were.
  expect(s.tracks.map((t) => t.id)).toEqual(['saved']);
  expect(s.maps[0]?.fileUri).toBe('file:///doc/maps/m1.pdf');
  expect(s.tracks[0]?.fileUri).toBe('file:///doc/tracks/saved.gpx');
  expect(s.tracks[0]?.notes?.[0]?.photoUri).toBe('file:///doc/photos/p1.jpg');
  expect(s.waypoints[0]?.photoUri).toBe('file:///doc/photos/p2.jpg');
});

it('persists every path document-relative — no absolute uri reaches disk', () => {
  useLibraryStore
    .getState()
    .addTrack(track, 'file:///doc/tracks/t1.gpx', [
      { distanceM: 5, text: 'Beaver dam', photoUri: 'file:///doc/photos/p3.jpg' },
    ]);

  const written = lastWritten();
  expect(written.tracks[0]?.fileUri).toBe('tracks/t1.gpx');
  expect(written.tracks[0]?.notes?.[0]?.photoUri).toBe('photos/p3.jpg');
  // The trail that came out of the stranded index is written back relative too.
  expect(written.tracks[1]?.fileUri).toBe('tracks/saved.gpx');
  expect(written.maps[0]?.fileUri).toBe('maps/m1.pdf');
  expect(written.waypoints[0]?.photoUri).toBe('photos/p2.jpg');

  // The blanket guard: the whole document, every field, at any depth (#247).
  expect(JSON.stringify(written)).not.toContain('file://');
});

it('keeps the in-memory state absolute, so consumers are unaffected', () => {
  // <Image source>, Sharing.shareAsync and the storage readers all want a real
  // uri; only the on-disk form is relative.
  const t = useLibraryStore.getState().tracks.find((x) => x.id === 't1');
  expect(t?.fileUri).toBe('file:///doc/tracks/t1.gpx');
  expect(t?.notes?.[0]?.photoUri).toBe('file:///doc/photos/p3.jpg');
});

it('round-trips: what persist writes, hydrate reads back identically', () => {
  // `clearMocks` wipes recorded calls between tests, so provoke a write here.
  useLibraryStore.getState().renameTrack('t1', 'Mont Wright loop (2)');
  const written = lastWritten();
  // Feeding the persisted document back through the same translation the
  // hydrate path applies reproduces the in-memory state exactly.
  const { migrateLibraryIndex, mapLibraryIndexPaths } = jest.requireActual<
    typeof import('@core/library/migrations')
  >('@core/library/migrations');
  const rehydrated = mapLibraryIndexPaths(
    migrateLibraryIndex(written, storage.documentDirUri()),
    storage.resolveDocumentPath,
  );
  expect(rehydrated.tracks.map((t) => t.fileUri)).toEqual(
    useLibraryStore.getState().tracks.map((t) => t.fileUri),
  );
});

it('waypoint photos added after hydration persist relative as well', () => {
  const id = useLibraryStore.getState().addWaypoint(46.9, -71.3);
  useLibraryStore.getState().updateWaypoint(id, { photoUri: 'file:///doc/photos/p4.jpg' });

  const written = lastWritten();
  expect(written.waypoints.find((w) => w.id === id)?.photoUri).toBe('photos/p4.jpg');
  expect(JSON.stringify(written)).not.toContain('file://');
});
