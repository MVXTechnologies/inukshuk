import type { TrackPhoto } from '@core/photos/model';

import { photosEditable, useTrailPhotosStore } from './trailPhotosStore';

jest.mock('@data/photos/trailPhotos', () => ({
  readTrailPhotos: jest.fn(),
  editTrailPhoto: jest.fn(),
  removeTrailPhoto: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
const mockUpdateTrack = jest.fn();
let mockTracks: { id: string; photoCount?: number; coverPhotoId?: string }[] = [];
jest.mock('./libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ hydrated: true, tracks: mockTracks, updateTrack: mockUpdateTrack }),
  },
}));

const data = jest.requireMock('@data/photos/trailPhotos') as {
  readTrailPhotos: jest.Mock;
  editTrailPhoto: jest.Mock;
  removeTrailPhoto: jest.Mock;
};

const photo = (id: string, takenAt: number) => ({ id, takenAt, distanceM: 0 }) as TrackPhoto;

beforeEach(() => {
  useTrailPhotosStore.setState({ byTrack: {} });
  mockTracks = [{ id: 't1' }];
  data.readTrailPhotos.mockReset();
});

it('loads a trail once, and syncs the library count and cover', async () => {
  data.readTrailPhotos.mockResolvedValue({ status: 'ok', photos: [photo('a', 1), photo('b', 2)] });
  const { load } = useTrailPhotosStore.getState();
  await Promise.all([load('t1'), load('t1')]);
  await load('t1');
  expect(data.readTrailPhotos).toHaveBeenCalledTimes(1);
  expect(useTrailPhotosStore.getState().byTrack['t1']).toMatchObject({ status: 'ok' });
  expect(mockUpdateTrack).toHaveBeenCalledWith('t1', { photoCount: 2, coverPhotoId: 'a' });
});

it('does not rewrite the library when the summary is unchanged', async () => {
  mockTracks = [{ id: 't1', photoCount: 1, coverPhotoId: 'a' }];
  data.readTrailPhotos.mockResolvedValue({ status: 'ok', photos: [photo('a', 1)] });
  await useTrailPhotosStore.getState().load('t1');
  expect(mockUpdateTrack).not.toHaveBeenCalled();
});

it('keeps a newer-version sidecar read-only and leaves the library alone', async () => {
  data.readTrailPhotos.mockResolvedValue({ status: 'future', photos: [] });
  await useTrailPhotosStore.getState().load('t1');
  const entry = useTrailPhotosStore.getState().byTrack['t1'];
  expect(entry?.status).toBe('future');
  expect(photosEditable(entry?.status)).toBe(false);
  expect(mockUpdateTrack).not.toHaveBeenCalled();
});

it('reports a failed read as an error and retries on the next load', async () => {
  data.readTrailPhotos.mockRejectedValueOnce(new Error('io'));
  await useTrailPhotosStore.getState().load('t1');
  expect(useTrailPhotosStore.getState().byTrack['t1']?.status).toBe('error');
  data.readTrailPhotos.mockResolvedValue({ status: 'missing', photos: [] });
  await useTrailPhotosStore.getState().load('t1');
  expect(useTrailPhotosStore.getState().byTrack['t1']?.status).toBe('missing');
});

it('re-reads after an edit or a removal', async () => {
  data.readTrailPhotos.mockResolvedValue({ status: 'ok', photos: [photo('a', 1)] });
  data.editTrailPhoto.mockResolvedValue(photo('a', 1));
  data.removeTrailPhoto.mockResolvedValue(true);
  const s = useTrailPhotosStore.getState();
  await s.editPhoto('t1', 'a', { caption: 'x' });
  expect(data.editTrailPhoto).toHaveBeenCalledWith('t1', 'a', { caption: 'x' });
  expect(await s.removePhoto('t1', 'a')).toBe(true);
  expect(data.readTrailPhotos).toHaveBeenCalledTimes(2);
});

it('forgets a trail', async () => {
  data.readTrailPhotos.mockResolvedValue({ status: 'ok', photos: [] });
  await useTrailPhotosStore.getState().load('t1');
  useTrailPhotosStore.getState().forget('t1');
  useTrailPhotosStore.getState().forget('t1');
  expect(useTrailPhotosStore.getState().byTrack).toEqual({});
});

it('says which statuses can be edited', () => {
  expect(photosEditable('ok')).toBe(true);
  expect(photosEditable('missing')).toBe(true);
  expect(photosEditable('unreadable')).toBe(false);
  expect(photosEditable('loading')).toBe(false);
  expect(photosEditable(undefined)).toBe(false);
});
