/**
 * Share live's one way into the Library (#712): `applySync` applies the
 * bridge's edit in ONE index write, deletes what removed items leave behind,
 * and writes nothing when nothing changes.
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
jest.mock('@data/photos/trailFolder', () => ({ deleteTrailPhotoFolder: jest.fn() }));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  readIndex: jest.Mock;
  deleteFileAt: jest.Mock;
};
const photos = jest.requireMock('@data/photos/trailFolder') as {
  deleteTrailPhotoFolder: jest.Mock;
};

const track = (id: string): TrackSummary => ({
  id,
  name: id,
  fileUri: `file:///Documents/${id}.gpx`,
  startedAt: 1,
  stats: {} as TrackSummary['stats'],
  folderId: 'f1',
});

beforeAll(async () => {
  storage.readIndex.mockResolvedValue({
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
    areas: [],
  });
  await useLibraryStore.getState().hydrate();
});

beforeEach(() => {
  useLibraryStore.setState({
    folders: [{ id: 'f1', name: 'Gaspésie', createdAt: 1 }],
    tracks: [track('t1')],
    waypoints: [],
    activeTrackIds: ['t1'],
  });
  storage.writeIndex.mockClear();
  storage.deleteFileAt.mockClear();
});

it('applies a synced edit in one write', () => {
  const changed = useLibraryStore.getState().applySync({
    folders: { put: [{ id: 'f1', name: 'Gaspésie 2026', createdAt: 1 }] },
    waypoints: {
      put: [
        {
          id: 'w1',
          latitude: 48.9,
          longitude: -66.2,
          label: 'Refuge',
          folderId: 'f1',
          createdAt: 2,
        },
      ],
    },
  });
  expect(changed).toBe(true);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  const s = useLibraryStore.getState();
  expect(s.folders[0]!.name).toBe('Gaspésie 2026');
  expect(s.waypoints.map((w) => w.label)).toEqual(['Refuge']);
});

it('a synced delete takes the trail, its file and its overlay', () => {
  useLibraryStore.getState().applySync({ tracks: { remove: ['t1'] } });
  const s = useLibraryStore.getState();
  expect(s.tracks).toEqual([]);
  expect(s.activeTrackIds).toEqual([]);
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///Documents/t1.gpx');
  expect(photos.deleteTrailPhotoFolder).toHaveBeenCalledWith('t1');
});

it('writes nothing for an empty edit', () => {
  expect(useLibraryStore.getState().applySync({})).toBe(false);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});
