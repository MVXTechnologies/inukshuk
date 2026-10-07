/**
 * Trail photos (#587): deleting a trail deletes its photo folder — but only
 * once the index without it is committed.
 */
import type { TrackSummary } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'r_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));
jest.mock('@data/photos/trailFolder', () => ({ deleteTrailPhotoFolder: jest.fn() }));

const storage = jest.requireMock('@data/storage') as { writeIndex: jest.Mock };
const folders = jest.requireMock('@data/photos/trailFolder') as {
  deleteTrailPhotoFolder: jest.Mock;
};

const stats: TrackSummary['stats'] = {
  distanceM: 1000,
  ascentM: 10,
  descentM: 10,
  durationS: 600,
  movingTimeS: 600,
  avgSpeedMps: 1,
  maxSpeedMps: 2,
  pointCount: 2,
};

const summary = (id: string): TrackSummary => ({
  id,
  name: id,
  startedAt: 1,
  stats,
  fileUri: `file:///Documents/tracks/${id}.gpx`,
  photoCount: 3,
  coverPhotoId: 'p1',
});

beforeEach(() => {
  storage.writeIndex.mockReset();
  folders.deleteTrailPhotoFolder.mockReset();
  useLibraryStore.setState({
    hydrated: true,
    tracks: [summary('a'), summary('b'), summary('c')],
    activeTrackIds: [],
  });
});

it('deletes a removed trail’s photos', () => {
  useLibraryStore.getState().removeTrack('a');
  expect(folders.deleteTrailPhotoFolder).toHaveBeenCalledWith('a');
  expect(folders.deleteTrailPhotoFolder).toHaveBeenCalledTimes(1);
});

it('deletes the photos of every trail removed together', () => {
  useLibraryStore.getState().removeTracks(['b', 'c', 'missing']);
  expect(folders.deleteTrailPhotoFolder.mock.calls.map((c) => c[0])).toEqual(['b', 'c']);
});

it('keeps the photos when the index cannot be written', () => {
  // Not hydrated: the delete is refused on disk, so the photos stay referenced.
  useLibraryStore.setState({ hydrated: false });
  useLibraryStore.getState().removeTrack('a');
  expect(folders.deleteTrailPhotoFolder).not.toHaveBeenCalled();
  storage.writeIndex.mockImplementation(() => {
    throw new Error('disk full');
  });
  useLibraryStore.setState({ hydrated: true });
  expect(() => useLibraryStore.getState().removeTrack('b')).toThrow('disk full');
  expect(folders.deleteTrailPhotoFolder).not.toHaveBeenCalled();
});

it('keeps the photo count and cover on the summary through a patch', () => {
  useLibraryStore.getState().updateTrack('a', { photoCount: 5, coverPhotoId: 'p9' });
  expect(useLibraryStore.getState().tracks[0]).toMatchObject({
    photoCount: 5,
    coverPhotoId: 'p9',
  });
});
