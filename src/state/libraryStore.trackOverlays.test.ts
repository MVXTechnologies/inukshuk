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
  folders: [{ id: 'f1', name: 'Alps', createdAt: 1 }],
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
    expect.objectContaining({ schemaVersion: LIBRARY_SCHEMA_VERSION, activeTrackIds: ['t2'] }),
  );
  useLibraryStore.getState().toggleTrackOverlay('t2');
  expect(useLibraryStore.getState().activeTrackIds).toEqual([]);
});

it('folder visibility mode + selection toggle and persist', () => {
  const s0 = useLibraryStore.getState();
  expect(s0.mapVisibilityMode).toBe('type');
  s0.setMapVisibilityMode('folders');
  expect(useLibraryStore.getState().mapVisibilityMode).toBe('folders');
  useLibraryStore.getState().toggleVisibleFolder('f1');
  useLibraryStore.getState().toggleVisibleFolder('ungrouped');
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['f1', 'ungrouped']);
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({
      mapVisibilityMode: 'folders',
      visibleFolderIds: ['f1', 'ungrouped'],
    }),
  );
  useLibraryStore.getState().toggleVisibleFolder('f1');
  expect(useLibraryStore.getState().visibleFolderIds).toEqual(['ungrouped']);
  useLibraryStore.getState().setMapVisibilityMode('type');
});

it('removeFolder clears item folderIds and the visible selection', () => {
  useLibraryStore.getState().toggleVisibleFolder('f1');
  const wpId = useLibraryStore.getState().addWaypoint(46.8, -71.2);
  useLibraryStore.getState().setItemFolder('waypoint', wpId, 'f1');
  expect(useLibraryStore.getState().waypoints.find((w) => w.id === wpId)?.folderId).toBe('f1');
  useLibraryStore.getState().removeFolder('f1');
  const after = useLibraryStore.getState();
  expect(after.waypoints.find((w) => w.id === wpId)?.folderId).toBeUndefined();
  expect(after.visibleFolderIds).not.toContain('f1');
  useLibraryStore.getState().removeWaypoint(wpId);
});

it('removeTrack prunes the deleted trail from the overlay set', () => {
  useLibraryStore.getState().setActiveTrackIds(['t1', 't2']);
  useLibraryStore.getState().removeTrack('t1');
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2']);
});
