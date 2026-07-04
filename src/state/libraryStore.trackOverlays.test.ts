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

const stats = {
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  pointCount: 1,
};

const track = (id: string) => ({ id, name: id, startedAt: 1, stats, fileUri: `file://${id}.gpx` });

// A legacy (unversioned) on-disk index: no schemaVersion, no activeTrackIds.
const legacyIndex = {
  maps: [],
  tracks: [track('t1'), track('t2')],
  bundles: [{ id: 'b1', name: 'B', mapIds: [], trackIds: ['t1', 't-deleted'], createdAt: 1 }],
  folders: [],
  activeMapId: null,
};

beforeAll(async () => {
  storage.readIndex.mockResolvedValue(legacyIndex);
  await useLibraryStore.getState().hydrate();
});

it('hydrates a legacy index with trail overlays defaulted to none', () => {
  expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
});

it('toggleTrackOverlay toggles and persists the id with the schema version', () => {
  useLibraryStore.getState().toggleTrackOverlay('t2');
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ schemaVersion: 2, activeTrackIds: ['t2'] }),
  );
  useLibraryStore.getState().toggleTrackOverlay('t2');
  expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
});

it('activateBundle turns on member trails itself, skipping deleted ones', () => {
  useLibraryStore.getState().activateBundle('b1');
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t1']);
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeTrackIds: ['t1'] }),
  );
});

it('removeTrack prunes the deleted trail from the overlay set', () => {
  useLibraryStore.getState().setActiveTrackIds(['t1', 't2']);
  useLibraryStore.getState().removeTrack('t1');
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
});
