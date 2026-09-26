import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import type { Track, TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';

import { LibraryNotHydratedError, useLibraryStore } from './libraryStore';

jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(async () => null),
  writeIndex: jest.fn(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
}));

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
  name: 'T',
  startedAt: 1,
  status: 'finished',
  points: [{ latitude: 0, longitude: 0, time: 0 }],
  stats,
};

const persisted: TrackSummary = {
  id: 'saved',
  name: 'Saved trail',
  startedAt: 1,
  stats,
  fileUri: 'file://saved.gpx',
};

// These tests intentionally share module state and run in order: hydration is
// a module-level single-flight (one hydrate per JS lifetime), so the
// pre-hydration guard must be exercised before hydrate() runs and the
// persistence contract after it.

it('persist() is a no-op before hydration (anti-clobber guard)', () => {
  const persisted = useLibraryStore.getState().addTrack(track, 'file://t1.gpx');

  // The mutation lands in memory but never reaches disk: persisting the
  // near-empty pre-hydration state would wipe the on-disk library.
  expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['t1']);
  expect(storage.writeIndex).not.toHaveBeenCalled();
  // ...and it is no longer silent: the caller is told, and so are we.
  expect(persisted).toBe(false);
  expect(reportError).toHaveBeenCalledWith(
    expect.any(LibraryNotHydratedError),
    'library-persist-before-hydration',
  );
});

it('deletes no files for a removal it could not commit before hydration', () => {
  useLibraryStore.getState().removeTrack('t1');

  // The on-disk index still references the GPX: deleting it would leave the
  // library pointing at nothing once it loads.
  expect(storage.writeIndex).not.toHaveBeenCalled();
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
  expect(reportError).toHaveBeenCalledTimes(1);
});

it('allows hydration retry after an initial read failure without persisting partial state', async () => {
  jest.mocked(storage.readIndex).mockRejectedValueOnce(new Error('Read denied'));
  await expect(useLibraryStore.getState().hydrate()).rejects.toThrow('Read denied');
  expect(useLibraryStore.getState().hydrated).toBe(false);
  expect(storage.writeIndex).not.toHaveBeenCalled();
  jest.mocked(storage.readIndex).mockResolvedValueOnce({ tracks: [persisted] });
  await expect(useLibraryStore.getState().hydrate()).resolves.toBeUndefined();
  expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['saved']);
  expect(storage.writeIndex).not.toHaveBeenCalled();
  useLibraryStore.setState({ hydrated: false });
});

it('hydrate is single-flight: concurrent calls read the index once', async () => {
  let resolveRead: (value: unknown) => void = () => {};
  (storage.readIndex as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      resolveRead = resolve;
    }),
  );

  // RootLayout's effect and a cold-start "Open with" intent racing each other.
  const first = useLibraryStore.getState().hydrate();
  const second = useLibraryStore.getState().hydrate();
  expect(storage.readIndex).toHaveBeenCalledTimes(1);

  resolveRead({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps: [],
    tracks: [persisted],
    folders: [],
    activeMapId: null,
    activeTrackIds: ['saved'],
  });
  await Promise.all([first, second]);

  const state = useLibraryStore.getState();
  expect(state.hydrated).toBe(true);
  expect(state.tracks.map((t) => t.id)).toEqual(['saved']);
  expect(state.activeTrackIds).toEqual(['saved']);
});

it('hydrate resolves without re-reading once hydrated', async () => {
  await useLibraryStore.getState().hydrate();
  expect(storage.readIndex).not.toHaveBeenCalled(); // clearMocks reset the count
});

it('post-hydration mutations persist with the current schemaVersion', () => {
  expect(useLibraryStore.getState().addTrack({ ...track, id: 't2' }, 'file://t2.gpx')).toBe(true);

  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(reportError).not.toHaveBeenCalled();
  const written = (storage.writeIndex as jest.Mock).mock.calls[0]?.[0] as {
    schemaVersion: number;
    tracks: { id: string }[];
  };
  expect(written.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
  // The new track is prepended and the hydrated content is retained.
  expect(written.tracks.map((t) => t.id)).toEqual(['t2', 'saved']);
});
