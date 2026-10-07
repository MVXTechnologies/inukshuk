import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useRecordingPhoto } from './useRecordingPhoto';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(),
  getPendingResultAsync: jest.fn(async () => null),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'p1',
  deleteFileAt: jest.fn(),
  resolveDocumentPath: (p: string) => `file:///doc/${p}`,
}));
jest.mock('./photoResizer', () => ({
  photoResizer: {
    resize: jest.fn(async () => ({
      display: { base64: 'D', width: 2048, height: 1536 },
      thumb: { base64: 'T', width: 240, height: 240 },
      sprite: { base64: 'S', width: 132, height: 132 },
      sourceWidth: 4000,
      sourceHeight: 3000,
    })),
  },
}));
jest.mock('@data/photos/capturedPhotos', () => ({
  writeCapturedCopies: jest.fn(async () => ({
    paths: { file: 'photos/s/p1.jpg', thumb: 'photos/s/p1.sq.jpg', sprite: 'photos/s/p1.map.png' },
    bytes: 700,
    contentHash: 'md5:x',
  })),
  deleteCapturedPhoto: jest.fn(),
}));
const mockRecorder = {
  status: 'recording',
  points: [{ latitude: 47, longitude: -71, altitude: 732, time: 1 }],
  stats: { distanceM: 2400 },
  photoSessionFor: jest.fn(() => 's'),
  addPhoto: jest.fn(() => 7),
  removePhoto: jest.fn(),
};
jest.mock('@state/recorderStore', () => ({
  useRecorderStore: { getState: () => mockRecorder },
}));
jest.mock('@state/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ photoCopySize: 'optimized' }) },
}));
jest.mock('@state/formatters', () => ({
  formatDistance: (m: number) => `${(m / 1000).toFixed(2)} km`,
  formatElevation: (m: number) => `${Math.round(m)} m`,
}));

const picker = jest.requireMock('expo-image-picker') as {
  requestCameraPermissionsAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
};
const files = jest.requireMock('@data/photos/capturedPhotos') as {
  writeCapturedCopies: jest.Mock;
  deleteCapturedPhoto: jest.Mock;
};
const storage = jest.requireMock('@data/storage') as { deleteFileAt: jest.Mock };

const shot = { canceled: false, assets: [{ uri: 'file:///cache/Camera/shot.jpg' }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecorder.points = [{ latitude: 47, longitude: -71, altitude: 732, time: 1 }];
  mockRecorder.addPhoto.mockReturnValue(7);
  picker.launchCameraAsync.mockResolvedValue(shot);
});

it('adds a shot to the recording and offers Undo', async () => {
  const onMessage = jest.fn();
  const { result } = await renderHook(() => useRecordingPhoto(onMessage));
  await act(async () => result.current.capture());
  await waitFor(() => expect(result.current.toast).not.toBeNull());
  expect(picker.launchCameraAsync).toHaveBeenCalledWith({ quality: 0.92, exif: true });
  expect(files.writeCapturedCopies).toHaveBeenCalledWith(
    's',
    'p1',
    shot.assets[0]!.uri,
    expect.anything(),
    false,
  );
  expect(mockRecorder.addPhoto).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'p1',
      lngLat: [-71, 47],
      distanceM: 2400,
      elevationM: 732,
      contentHash: 'md5:x',
      width: 2048,
    }),
  );
  expect(result.current.toast).toMatchObject({
    title: 'Photo 7 added to this recording',
    thumbUri: 'file:///doc/photos/s/p1.sq.jpg',
  });
  expect(result.current.toast?.detail).toMatch(/^2\.40 km · 732 m · /);
  // The camera's own file (with its EXIF) is gone.
  expect(storage.deleteFileAt).toHaveBeenCalledWith(shot.assets[0]!.uri);
  await act(async () => result.current.undo());
  expect(mockRecorder.removePhoto).toHaveBeenCalledWith('p1');
  expect(result.current.toast).toBeNull();
  expect(onMessage).not.toHaveBeenCalled();
});

it('says so when the camera permission is denied', async () => {
  picker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false });
  const onMessage = jest.fn();
  const { result } = await renderHook(() => useRecordingPhoto(onMessage));
  await act(async () => result.current.capture());
  await waitFor(() => expect(onMessage).toHaveBeenCalledWith('Camera permission denied'));
  expect(picker.launchCameraAsync).not.toHaveBeenCalled();
});

it('waits for a GPS fix, and drops the shot', async () => {
  mockRecorder.points = [];
  const onMessage = jest.fn();
  const { result } = await renderHook(() => useRecordingPhoto(onMessage));
  await act(async () => result.current.capture());
  await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/GPS fix/)));
  expect(files.writeCapturedCopies).not.toHaveBeenCalled();
  expect(storage.deleteFileAt).toHaveBeenCalledWith(shot.assets[0]!.uri);
});

it('removes the copies when the recording cannot take the photo', async () => {
  mockRecorder.addPhoto.mockImplementationOnce(() => {
    throw new Error('Could not save the photo. Free some storage and try again.');
  });
  const onMessage = jest.fn();
  const { result } = await renderHook(() => useRecordingPhoto(onMessage));
  await act(async () => result.current.capture());
  await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/storage/)));
  expect(files.deleteCapturedPhoto).toHaveBeenCalled();
  expect(result.current.toast).toBeNull();
});

it('ignores a cancelled camera', async () => {
  picker.launchCameraAsync.mockResolvedValueOnce({ canceled: true, assets: null });
  const { result } = await renderHook(() => useRecordingPhoto(jest.fn()));
  await act(async () => result.current.capture());
  expect(files.writeCapturedCopies).not.toHaveBeenCalled();
});
