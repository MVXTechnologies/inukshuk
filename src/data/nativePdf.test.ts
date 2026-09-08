import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { nativePdfAvailable, renderNativePdfCrop, deleteNativePdfOutput } from './nativePdf';

const mockRender = jest.fn();
const mockDelete = jest.fn();
jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = true;
    delete = mockDelete;
  },
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
const args = {
  fileUri: 'file:///private/maps/map.pdf',
  pageIndex: 0,
  pageWidthPt: 1000,
  pageHeightPt: 800,
  crop: { x0: 0.25, y0: 0.25, x1: 0.5, y1: 0.5 },
  targetWidthPx: 1000,
};
beforeEach(() => {
  Platform.OS = 'android';
  jest.mocked(requireOptionalNativeModule).mockReturnValue({ renderCrop: mockRender });
});
it('keeps old binaries on the existing renderer', async () => {
  jest.mocked(requireOptionalNativeModule).mockReturnValue(null);
  expect(nativePdfAvailable()).toBe(false);
  await expect(renderNativePdfCrop(args)).rejects.toThrow('unavailable');
  Platform.OS = 'ios';
  expect(nativePdfAvailable()).toBe(false);
});
it('passes the bounded crop directly to the native module', async () => {
  mockRender.mockResolvedValue({ fileUri: 'file:///cache/overlays/pdf-detail-native-a.png' });
  expect(nativePdfAvailable()).toBe(true);
  await expect(renderNativePdfCrop(args)).resolves.toMatchObject({ fileUri: expect.any(String) });
  expect(mockRender).toHaveBeenCalledWith(args);
});
it('cleans up an abandoned native result without masking the original failure', () => {
  deleteNativePdfOutput('file:///cache/overlays/pdf-detail-native-a.png');
  expect(mockDelete).toHaveBeenCalledTimes(1);
  mockDelete.mockImplementationOnce(() => {
    throw new Error('cache already reclaimed');
  });
  expect(() =>
    deleteNativePdfOutput('file:///cache/overlays/pdf-detail-native-b.png'),
  ).not.toThrow();
});

it('enables the native module on rebuilt iOS binaries', async () => {
  Platform.OS = 'ios';
  expect(nativePdfAvailable()).toBe(true);
  mockRender.mockResolvedValue({ fileUri: 'file:///cache/overlays/pdf-detail-native-ios.png' });
  await expect(renderNativePdfCrop(args)).resolves.toMatchObject({ fileUri: expect.any(String) });
});
