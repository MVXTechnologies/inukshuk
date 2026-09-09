/**
 * `setItemFolder` destination validation (#303, audit A23): a drop that
 * resolves to a folder id which no longer exists must be a no-op, not a
 * dangling `folderId` that renders under Ungrouped.
 */
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import type { TrackSummary } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
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

const track: TrackSummary = {
  id: 't1',
  name: 'Morning run',
  fileUri: 'file:///Documents/t1.gpx',
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
  folderId: 'f1',
};

beforeAll(async () => {
  storage.readIndex.mockResolvedValue({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps: [],
    tracks: [track],
    folders: [
      { id: 'f1', name: 'TripA', createdAt: 1 },
      { id: 'f2', name: 'TripB', createdAt: 2 },
    ],
    mapVisibilityMode: 'type',
    visibleFolderIds: [],
    activeMapId: null,
    activeTrackIds: [],
    customCategories: [],
    waypoints: [],
  });
  await useLibraryStore.getState().hydrate();
});

beforeEach(() => {
  storage.writeIndex.mockClear();
  useLibraryStore.setState({ tracks: [track] });
});

const trackFolder = () => useLibraryStore.getState().tracks[0]?.folderId;

describe('setItemFolder', () => {
  it('moves into an existing folder and out to Ungrouped', () => {
    useLibraryStore.getState().setItemFolder('track', 't1', 'f2');
    expect(trackFolder()).toBe('f2');
    useLibraryStore.getState().setItemFolder('track', 't1', null);
    expect(trackFolder()).toBeUndefined();
  });

  it('ignores a folder id that no longer exists', () => {
    useLibraryStore.getState().removeFolder('f2');
    storage.writeIndex.mockClear();
    useLibraryStore.getState().setItemFolder('track', 't1', 'f2');
    expect(trackFolder()).toBe('f1');
    expect(storage.writeIndex).not.toHaveBeenCalled();
  });
});
