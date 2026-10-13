import { StorageFullError } from '@data/storage';

import {
  deleteAllTrailPhotos,
  deletePhotoFiles,
  deleteTrailPhotos,
  listTrailPhotoFiles,
  photoStorageUsage,
  sweepTrailOrphans,
  trailsWithPhotos,
  writeFullSizeCopies,
  writePhotoCopies,
} from './photoFiles';
import { clearPhotoInbox, extensionOf, stageForResize, unstage } from './inbox';
import { fakeFs } from './testUtils/testFileSystem';

jest.mock('expo-file-system', () =>
  jest
    .requireActual<typeof import('./testUtils/testFileSystem')>('./testUtils/testFileSystem')
    .createFakeFileSystem(),
);
jest.mock('@data/localServer', () => ({
  copyToServed: jest.fn(async (source: string, documentPath: string) => {
    const { File, Paths } = jest.requireMock('expo-file-system');
    const dest = new File(Paths.document, documentPath);
    await new File(source).copy(dest);
    return dest.uri;
  }),
}));

const fs = fakeFs();
const b64 = (s: string) => Buffer.from(s).toString('base64');
const outputs = { display: b64('DISPLAY-JPEG'), thumb: b64('THUMB'), sprite: b64('SPRITE-PNG') };

beforeEach(() => fs.reset());

describe('writePhotoCopies', () => {
  it('writes the three copies under the trail folder, sized and hashed, no staging left', () => {
    const w = writePhotoCopies('t1', 'p1', outputs);
    expect(w.paths).toEqual({
      file: 'photos/t1/p1.jpg',
      thumb: 'photos/t1/p1.sq.jpg',
      sprite: 'photos/t1/p1.map2.png',
    });
    expect(fs.text('/doc/photos/t1/p1.jpg')).toBe('DISPLAY-JPEG');
    expect(fs.text('/doc/photos/t1/p1.map2.png')).toBe('SPRITE-PNG');
    expect(w.bytes).toBe(12 + 5 + 10);
    expect(w.contentHash).toMatch(/^md5:[0-9a-f]+$/);
    expect(fs.list('/doc/photos/t1/').filter((p) => p.endsWith('.tmp'))).toEqual([]);
  });

  it('names a full disk and leaves no partial copies behind', () => {
    fs.failWrite = { match: /p1\.map2\.png\.tmp$/, message: 'ENOSPC: no space left on device' };
    expect(() => writePhotoCopies('t1', 'p1', outputs)).toThrow(StorageFullError);
    expect(fs.list('/doc/photos/t1/')).toEqual([]);
  });

  it('passes other failures through', () => {
    fs.failWrite = { match: /p1\.jpg\.tmp$/, message: 'boom' };
    expect(() => writePhotoCopies('t1', 'p1', outputs)).toThrow('boom');
  });
});

describe('writeFullSizeCopies', () => {
  // SOI, APP1 "Exif" carrying a fake GPS string, SOS, data, EOI.
  const exif = [...Buffer.from('Exif\0\0GPS 47.66 N')];
  const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif];
  const jpegWithGps = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);

  it('keeps the original JPEG with its location stripped', async () => {
    fs.seed('/cache/picked.jpg', jpegWithGps);
    const w = await writeFullSizeCopies('t1', 'p2', 'file:///cache/picked.jpg', {
      thumb: outputs.thumb,
      sprite: outputs.sprite,
    });
    const kept = fs.files.get('/doc/photos/t1/p2.jpg')!;
    expect(Buffer.from(kept).includes(Buffer.from('GPS'))).toBe(false);
    expect([...kept]).toEqual([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    expect(w.bytes).toBe(kept.length + 5 + 10);
  });

  it('drops a Motion Photo video or MPF image appended after the JPEG', async () => {
    const trailer = [...Buffer.from('\0\0\0\x18ftypmp42 moov +47.6675-070.6132/')];
    fs.seed('/cache/motion.jpg', new Uint8Array([...jpegWithGps, ...trailer]));
    await writeFullSizeCopies('t1', 'p4', 'file:///cache/motion.jpg', {
      thumb: outputs.thumb,
      sprite: outputs.sprite,
    });
    const kept = fs.files.get('/doc/photos/t1/p4.jpg')!;
    expect([...kept]).toEqual([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  });

  it('refuses a non-JPEG', async () => {
    fs.seed('/cache/picked.heic', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74]));
    await expect(
      writeFullSizeCopies('t1', 'p3', 'file:///cache/picked.heic', {
        thumb: 'AA==',
        sprite: 'AA==',
      }),
    ).rejects.toThrow(/JPEG/);
  });
});

describe('deletion and housekeeping', () => {
  beforeEach(() => {
    writePhotoCopies('t1', 'a', outputs);
    writePhotoCopies('t1', 'b', outputs);
    writePhotoCopies('t2', 'c', outputs);
    fs.seed('/doc/photos/t1/photos.json', '{}');
    fs.seed('/doc/photos/note-photo.jpg', 'a trail note photo');
  });

  it('deletes one photo, tolerating missing files', () => {
    deletePhotoFiles({
      file: 'photos/t1/a.jpg',
      thumb: 'photos/t1/a.sq.jpg',
      sprite: 'photos/t1/gone.png',
    });
    expect(listTrailPhotoFiles('t1').sort()).toEqual([
      'a.map2.png',
      'b.jpg',
      'b.map2.png',
      'b.sq.jpg',
      'photos.json',
    ]);
  });

  it('sweeps orphans but never the sidecar', () => {
    expect(sweepTrailOrphans('t1', new Set(['a']))).toBe(3);
    expect(listTrailPhotoFiles('t1').sort()).toEqual([
      'a.jpg',
      'a.map2.png',
      'a.sq.jpg',
      'photos.json',
    ]);
  });

  it('lists trails with photos and adds up usage, ignoring note photos', () => {
    expect(trailsWithPhotos().sort()).toEqual(['t1', 't2']);
    expect(photoStorageUsage()).toEqual({ photos: 3, trails: 2, bytes: 3 * 27 });
  });

  it('deletes a trail folder, then all of them, leaving note photos alone', () => {
    deleteTrailPhotos('t2');
    expect(trailsWithPhotos()).toEqual(['t1']);
    deleteTrailPhotos('nope');
    expect(deleteAllTrailPhotos()).toBe(1);
    expect(trailsWithPhotos()).toEqual([]);
    expect(fs.text('/doc/photos/note-photo.jpg')).toBe('a trail note photo');
    expect(photoStorageUsage()).toEqual({ photos: 0, trails: 0, bytes: 0 });
    expect(listTrailPhotoFiles('t1')).toEqual([]);
  });
});

describe('resize inbox', () => {
  it('stages a pick under the served inbox and removes it again', async () => {
    fs.seed('/cache/ImagePicker/IMG_1234.HEIC', 'heic bytes');
    const path = await stageForResize('file:///cache/ImagePicker/IMG_1234.HEIC', 'job1');
    expect(path).toBe('.photo-inbox/job1.heic');
    expect(fs.text('/doc/.photo-inbox/job1.heic')).toBe('heic bytes');
    unstage(path);
    expect(fs.files.has('/doc/.photo-inbox/job1.heic')).toBe(false);
    unstage(path); // already gone: fine
  });

  it('clears leftovers from a crash', () => {
    fs.seed('/doc/.photo-inbox/old.jpg', 'x');
    clearPhotoInbox();
    expect(fs.list('/doc/.photo-inbox')).toEqual([]);
    clearPhotoInbox();
  });

  it('reads extensions, defaulting to jpg', () => {
    expect(extensionOf('file:///x/IMG.JPEG?x=1')).toBe('jpeg');
    expect(extensionOf('content://media/picker/0/123')).toBe('jpg');
  });
});
