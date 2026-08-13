import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  ensureStorage: jest.fn(),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  readIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  readIndex: jest.Mock;
};

const index = {
  schemaVersion: LIBRARY_SCHEMA_VERSION,
  maps: [],
  tracks: [],
  folders: [
    { id: 'f1', name: 'TripA', createdAt: 1 },
    { id: 'f2', name: 'TripB', createdAt: 2 },
  ],
  mapVisibilityMode: 'type' as const,
  visibleFolderIds: [],
  activeMapId: null,
  activeTrackIds: [],
  customCategories: [],
  waypoints: [],
};

beforeAll(async () => {
  storage.readIndex.mockResolvedValue(index);
  await useLibraryStore.getState().hydrate();
});

beforeEach(() => {
  storage.writeIndex.mockClear();
  useLibraryStore.setState({ mapVisibilityMode: 'type', visibleFolderIds: [] });
});

/** Every state the store published while `run` executed, in order. */
function snapshots(run: () => void): { mode: string; ids: readonly string[] }[] {
  const seen: { mode: string; ids: readonly string[] }[] = [];
  const unsub = useLibraryStore.subscribe((s) =>
    seen.push({ mode: s.mapVisibilityMode, ids: s.visibleFolderIds }),
  );
  try {
    run();
  } finally {
    unsub();
  }
  return seen;
}

it('one folder tap costs exactly one index write', () => {
  useLibraryStore.getState().showFolder('f1');
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      mapVisibilityMode: 'folders',
      visibleFolderIds: ['f1'],
    }),
  );
});

it('never publishes a folders-mode state with nothing visible', () => {
  // The old two-call handler passed through {mode: 'folders', ids: []} — an
  // empty map — between its two writes.
  const seen = snapshots(() => useLibraryStore.getState().showFolder('f1'));
  expect(seen).toHaveLength(1);
  for (const s of seen) expect(s.mode === 'folders' && s.ids.length === 0).toBe(false);
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f1']);
});

it('re-picking a folder after "Everything" shows it instead of hiding it', () => {
  useLibraryStore.getState().showFolder('f1');
  useLibraryStore.getState().setMapVisibilityMode('type'); // the "Everything" row
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f1']); // stale leftover
  useLibraryStore.getState().showFolder('f1');
  expect(useLibraryStore.getState().mapVisibilityMode).toBe('folders');
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f1']);
});

it('a second tap inside folder mode hides the folder again', () => {
  useLibraryStore.getState().showFolder('f1');
  useLibraryStore.getState().showFolder('f2');
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f1', 'f2']);
  useLibraryStore.getState().showFolder('f1');
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f2']);
  expect(storage.writeIndex).toHaveBeenCalledTimes(3); // one write per tap
});
