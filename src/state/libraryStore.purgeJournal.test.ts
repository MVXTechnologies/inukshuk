/**
 * The Library's purge journal (#711 follow-up): a bulk delete with Undo
 * writes its journal entry in the same index write; Undo and the purge drop
 * it; and an app killed inside the Undo window purges the leftovers at the
 * next launch — the items stay deleted, their files go, nothing is
 * resurrected or left half-deleted.
 *
 * Each "launch" is a fresh module registry (hydration is once per JS
 * lifetime); the storage mocks are shared across them, as the disk is.
 */
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import type { TrackSummary, Waypoint } from '@core/models';

type Store = typeof import('./libraryStore');

const mockDisk: { index: unknown } = { index: null };
const mockStorage = {
  ensureStorage: jest.fn(),
  newId: jest.fn(() => 'n_' + Math.random().toString(36).slice(2, 8)),
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn((value: unknown) => {
    mockDisk.index = JSON.parse(JSON.stringify(value));
  }),
  readIndex: jest.fn(async () => mockDisk.index),
};
const mockPhotos = { deleteTrailPhotoFolder: jest.fn() };

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ...mockStorage,
}));
jest.mock('@data/photos/trailFolder', () => mockPhotos);
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const DOC = 'file:///doc';

const track = (id: string, photo?: string): TrackSummary =>
  ({
    id,
    name: id,
    fileUri: `${DOC}/tracks/${id}.gpx`,
    startedAt: 1,
    stats: {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 0,
    },
    ...(photo
      ? { notes: [{ id: 'n1', distanceM: 0, text: '', createdAt: 1, photoUri: photo }] }
      : {}),
  }) as TrackSummary;
const waypoint = (id: string): Waypoint => ({
  id,
  label: id,
  latitude: 47,
  longitude: -71,
  createdAt: 1,
  photoUri: `${DOC}/photos/${id}.jpg`,
});

/** A fresh app launch: a new store module, hydrated from the mocked disk. */
async function launch(): Promise<Store['useLibraryStore']> {
  let store!: Store;
  jest.isolateModules(() => {
    store = jest.requireActual<Store>('./libraryStore');
  });
  await store.useLibraryStore.getState().hydrate();
  return store.useLibraryStore;
}

const onDisk = () => mockDisk.index as { tracks: TrackSummary[]; pendingPurges?: unknown };

beforeEach(() => {
  mockDisk.index = {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps: [],
    tracks: [
      track('t1', `${DOC}/photos/t1.jpg`),
      track('t2'),
      { ...track('t3'), fileUri: 'tracks/t3.gpx' },
    ],
    folders: [],
    mapVisibilityMode: 'type',
    visibleFolderIds: [],
    activeMapId: null,
    activeTrackIds: ['t1'],
    customCategories: [],
    waypoints: [waypoint('w1')],
    areas: [],
  };
  jest.clearAllMocks();
});

it('the delete and its journal entry are one write, in document-relative paths', async () => {
  const lib = await launch();
  lib.getState().removeItemsForUndo([
    { kind: 'track', id: 't1' },
    { kind: 'waypoint', id: 'w1' },
  ]);
  expect(mockStorage.writeIndex).toHaveBeenCalledTimes(1);
  expect(onDisk().tracks.map((t) => t.id)).toEqual(['t2', 't3']);
  expect(onDisk().pendingPurges).toEqual([
    {
      id: expect.any(String),
      fileUris: ['tracks/t1.gpx', 'photos/t1.jpg', 'photos/w1.jpg'],
      trackIds: ['t1'],
    },
  ]);
  expect(mockStorage.deleteFileAt).not.toHaveBeenCalled();
});

it('Undo puts the items back and drops the entry in the same write', async () => {
  const lib = await launch();
  const removed = lib.getState().removeItemsForUndo([{ kind: 'track', id: 't1' }]);
  lib.getState().restoreRemovedItems(removed);
  expect(mockStorage.writeIndex).toHaveBeenCalledTimes(2);
  expect(onDisk().tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  expect(onDisk().pendingPurges).toBeUndefined();
});

it('the purge deletes the files, then drops the entry; other entries stay', async () => {
  const lib = await launch();
  const first = lib.getState().removeItemsForUndo([{ kind: 'track', id: 't1' }]);
  lib.getState().removeItemsForUndo([{ kind: 'track', id: 't2' }]);
  lib.getState().purgeRemovedItems(first);
  expect(mockStorage.deleteFileAt.mock.calls.map((c) => c[0])).toEqual([
    `${DOC}/tracks/t1.gpx`,
    `${DOC}/photos/t1.jpg`,
  ]);
  expect(mockPhotos.deleteTrailPhotoFolder).toHaveBeenCalledWith('t1');
  expect(onDisk().pendingPurges).toEqual([
    { id: expect.any(String), fileUris: ['tracks/t2.gpx'], trackIds: ['t2'] },
  ]);
  // A second purge of the same delete changes nothing on disk.
  const writes = mockStorage.writeIndex.mock.calls.length;
  lib.getState().purgeRemovedItems(first);
  expect(mockStorage.writeIndex).toHaveBeenCalledTimes(writes);
});

it('killed inside the Undo window: the next launch purges, the items stay deleted', async () => {
  const first = await launch();
  first.getState().removeItemsForUndo([
    { kind: 'track', id: 't1' },
    { kind: 'waypoint', id: 'w1' },
  ]);
  // The app dies here: no Undo, no purge.
  jest.clearAllMocks();

  const next = await launch();
  expect(next.getState().tracks.map((t) => t.id)).toEqual(['t2', 't3']);
  expect(next.getState().waypoints).toEqual([]);
  expect(next.getState().activeTrackIds).toEqual([]);
  expect(mockStorage.deleteFileAt.mock.calls.map((c) => c[0])).toEqual([
    `${DOC}/tracks/t1.gpx`,
    `${DOC}/photos/t1.jpg`,
    `${DOC}/photos/w1.jpg`,
  ]);
  expect(mockPhotos.deleteTrailPhotoFolder).toHaveBeenCalledWith('t1');
  // The journal is cleared on disk and in memory.
  expect(onDisk().pendingPurges).toBeUndefined();
  expect(next.getState().pendingPurges).toBeUndefined();

  // A third launch has nothing left to do.
  jest.clearAllMocks();
  await launch();
  expect(mockStorage.deleteFileAt).not.toHaveBeenCalled();
  expect(mockStorage.writeIndex).not.toHaveBeenCalled();
});

it('a journal naming a file the index still holds never deletes it', async () => {
  // As if the journal landed but the items are (still or again) in the index.
  (mockDisk.index as { pendingPurges: unknown }).pendingPurges = [
    { id: 'd1', fileUris: ['tracks/t2.gpx', 'photos/gone.jpg'], trackIds: ['t2', 'tGone'] },
  ];
  const lib = await launch();
  expect(lib.getState().tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  expect(mockStorage.deleteFileAt.mock.calls.map((c) => c[0])).toEqual([`${DOC}/photos/gone.jpg`]);
  expect(mockPhotos.deleteTrailPhotoFolder.mock.calls.map((c) => c[0])).toEqual(['tGone']);
  expect(onDisk().pendingPurges).toBeUndefined();
});
