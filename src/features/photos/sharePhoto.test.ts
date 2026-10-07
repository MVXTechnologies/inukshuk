import { hasLocation, jpegWithGps, realJpeg } from '@core/photos/__fixtures__/jpegs';

import { shareablePhotoUri, UnshareablePhotoError } from './sharePhoto';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<object>('expo-modules-core'),
  uuid: { v4: () => 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
}));
const mockFiles = new Map<string, Uint8Array>();
jest.mock('@data/storage', () => ({
  readFileBytes: jest.fn(async (p: string) => {
    const b = mockFiles.get(p);
    if (!b) throw new Error('missing');
    return b;
  }),
  resolveDocumentPath: (p: string) => `file:///doc/${p}`,
  deleteFileAt: jest.fn((uri: string) => mockFiles.delete(uri)),
  createCacheFileWriter: (name: string) => {
    const uri = `file:///cache/exports/${name}`;
    const parts: Uint8Array[] = [];
    return {
      uri,
      write: (c: Uint8Array) => parts.push(c),
      close: () => mockFiles.set(uri, Buffer.concat(parts)),
    };
  },
}));

beforeEach(() => mockFiles.clear());

it('shares a clean copy as it is', async () => {
  mockFiles.set('photos/t/a.jpg', realJpeg());
  const shared = await shareablePhotoUri({ file: 'photos/t/a.jpg' });
  expect(shared.uri).toBe('file:///doc/photos/t/a.jpg');
  shared.dispose();
  expect(mockFiles.has('photos/t/a.jpg')).toBe(true);
});

it('shares a stripped cache copy of a photo that carries GPS, then deletes it', async () => {
  mockFiles.set('file:///notes/n.jpg', jpegWithGps());
  const shared = await shareablePhotoUri({ file: 'file:///notes/n.jpg' });
  expect(shared.uri).toBe('file:///cache/exports/f47ac10b-58cc-4372-a567-0e02b2c3d479.jpg');
  expect(hasLocation(mockFiles.get(shared.uri)!)).toBe(false);
  shared.dispose();
  expect(mockFiles.has(shared.uri)).toBe(false);
  // The original is untouched.
  expect(hasLocation(mockFiles.get('file:///notes/n.jpg')!)).toBe(true);
});

it('refuses a file whose metadata cannot be checked', async () => {
  mockFiles.set('photos/t/b.jpg', new Uint8Array([1, 2]));
  await expect(shareablePhotoUri({ file: 'photos/t/b.jpg' })).rejects.toBeInstanceOf(
    UnshareablePhotoError,
  );
});
