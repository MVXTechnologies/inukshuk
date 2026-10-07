/**
 * Photos taken with the recording's Photo button (#587): checkpointed with
 * the session, materialized on stop under the session's id, deleted on
 * discard or undo, restored after a crash.
 */
import type { TrackPoint } from '@core/models';
import type { PendingPhoto } from '@core/photos/capture';
import * as checkpoint from '@data/recorderCheckpoint';

import { useLibraryStore } from './libraryStore';
import {
  initRecorderRecovery,
  resetRecorderRecoveryForTests,
  useRecorderStore,
} from './recorderStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'id_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  writeTrackGpx: jest.fn(() => 'file://tracks/test.gpx'),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/trailStatsStore', () => ({ primeTrailStats: jest.fn() }));
jest.mock('@data/photos/capturedPhotos', () => ({
  deleteCapturedPhoto: jest.fn(),
  discardCapturedPhotos: jest.fn(),
  saveCapturedPhotos: jest.fn(async () => undefined),
}));
jest.mock('@data/recorderCheckpoint', () => {
  let stored: unknown = null;
  return {
    writeCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
      return true;
    }),
    maybeWriteCheckpoint: jest.fn((cp: unknown) => {
      stored = cp;
    }),
    readCheckpoint: jest.fn(async () => stored),
    clearCheckpoint: jest.fn(() => {
      stored = null;
    }),
    readBackgroundPoints: jest.fn(async () => []),
    clearBackgroundPoints: jest.fn(),
    acknowledgeBackgroundPoints: jest.fn(),
  };
});

const captured = jest.requireMock('@data/photos/capturedPhotos') as {
  deleteCapturedPhoto: jest.Mock;
  discardCapturedPhotos: jest.Mock;
  saveCapturedPhotos: jest.Mock;
};

const T = Date.now() - 60_000;
const pt = (i: number): TrackPoint => ({
  latitude: 46.8 + i * 0.0005,
  longitude: -71.2,
  time: T + i * 5_000,
  accuracy: 5,
});

function photo(id: string, takenAt: number): PendingPhoto {
  return {
    id,
    takenAt,
    lngLat: [-71.2, 46.8],
    distanceM: 50,
    file: `photos/s/${id}.jpg`,
    thumb: `photos/s/${id}.sq.jpg`,
    sprite: `photos/s/${id}.map.png`,
    width: 2048,
    height: 1536,
    bytes: 1,
  };
}

function record(n = 6) {
  useRecorderStore.getState().start('Walk');
  useRecorderStore.setState({ startedAt: T });
  for (let i = 0; i < n; i++) useRecorderStore.getState().addPoint(pt(i));
}

beforeEach(() => {
  jest.clearAllMocks();
  useRecorderStore.getState().discard();
  jest.clearAllMocks();
  useLibraryStore.setState({ hydrated: true, tracks: [] });
  resetRecorderRecoveryForTests();
});

it('has no photo session while idle', () => {
  expect(useRecorderStore.getState().photoSessionFor()).toBeNull();
  expect(() => useRecorderStore.getState().addPhoto(photo('a', T))).toThrow();
});

it('checkpoints each photo with its session', () => {
  record();
  const s = useRecorderStore.getState();
  const session = s.photoSessionFor()!;
  expect(s.photoSessionFor()).toBe(session);
  expect(useRecorderStore.getState().addPhoto(photo('a', T + 5_000))).toBe(1);
  expect(useRecorderStore.getState().addPhoto(photo('b', T + 10_000))).toBe(2);
  const last = jest.mocked(checkpoint.writeCheckpoint).mock.calls.at(-1)![0];
  expect(last).toMatchObject({ photoSessionId: session, photos: [{ id: 'a' }, { id: 'b' }] });
});

it('refuses a photo whose checkpoint cannot be written', () => {
  record();
  useRecorderStore.getState().photoSessionFor();
  jest.mocked(checkpoint.writeCheckpoint).mockReturnValueOnce(false);
  expect(() => useRecorderStore.getState().addPhoto(photo('a', T))).toThrow(/storage/);
  expect(useRecorderStore.getState().photos).toEqual([]);
});

it('undoes a capture: entry, checkpoint and files', () => {
  record();
  useRecorderStore.getState().photoSessionFor();
  useRecorderStore.getState().addPhoto(photo('a', T));
  useRecorderStore.getState().removePhoto('a');
  useRecorderStore.getState().removePhoto('missing');
  expect(useRecorderStore.getState().photos).toEqual([]);
  expect(captured.deleteCapturedPhoto).toHaveBeenCalledTimes(1);
  expect(captured.deleteCapturedPhoto).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
});

it('saves the trail under the session id with its photos placed by time', async () => {
  record();
  const session = useRecorderStore.getState().photoSessionFor()!;
  useRecorderStore.getState().addPhoto(photo('a', T + 10_000));
  const track = await useRecorderStore.getState().stop();
  expect(track?.id).toBe(session);
  const [trackId, photos] = captured.saveCapturedPhotos.mock.calls[0] as [
    string,
    { id: string; placement: string; distanceM: number }[],
  ];
  expect(trackId).toBe(session);
  expect(photos).toEqual([expect.objectContaining({ id: 'a', placement: 'capture' })]);
  expect(photos[0]!.distanceM).toBeGreaterThan(0);
  expect(captured.discardCapturedPhotos).not.toHaveBeenCalled();
  expect(useRecorderStore.getState()).toMatchObject({ photoSessionId: null, photos: [] });
});

it('keeps the saved trail when its photos cannot be recorded', async () => {
  record();
  useRecorderStore.getState().photoSessionFor();
  useRecorderStore.getState().addPhoto(photo('a', T));
  captured.saveCapturedPhotos.mockRejectedValueOnce(new Error('io'));
  await expect(useRecorderStore.getState().stop()).resolves.not.toBeNull();
});

it('drops the photo folder when nothing is saved, or on discard', async () => {
  useRecorderStore.getState().start('Empty');
  const session = useRecorderStore.getState().photoSessionFor();
  useRecorderStore.getState().addPhoto(photo('a', T));
  await useRecorderStore.getState().stop();
  expect(captured.discardCapturedPhotos).toHaveBeenCalledWith(session);
  expect(captured.saveCapturedPhotos).not.toHaveBeenCalled();

  record();
  const second = useRecorderStore.getState().photoSessionFor();
  useRecorderStore.getState().discard();
  expect(captured.discardCapturedPhotos).toHaveBeenLastCalledWith(second);
});

it('a session id with no photo kept is not the trail’s id', async () => {
  record();
  const session = useRecorderStore.getState().photoSessionFor();
  const track = await useRecorderStore.getState().stop();
  expect(track?.id).not.toBe(session);
  expect(captured.discardCapturedPhotos).toHaveBeenCalledWith(session);
});

it('restores pending photos after a crash', async () => {
  record();
  const session = useRecorderStore.getState().photoSessionFor();
  useRecorderStore.getState().addPhoto(photo('a', T));
  // Process death: memory gone, the checkpoint stays.
  useRecorderStore.setState({ status: 'idle', photos: [], photoSessionId: null, points: [] });
  await expect(initRecorderRecovery()).resolves.toBe(true);
  expect(useRecorderStore.getState()).toMatchObject({
    status: 'paused',
    photoSessionId: session,
    photos: [{ id: 'a' }],
  });
});
