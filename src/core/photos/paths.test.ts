import {
  assertSafeId,
  inboxPath,
  orphanFiles,
  photoFilePaths,
  photoIdOfFile,
  sidecarPath,
  trailPhotoDir,
} from './paths';

describe('photo paths', () => {
  it('lays files out per trail, document-relative', () => {
    expect(trailPhotoDir('V1StGXR8_Z5j')).toBe('photos/V1StGXR8_Z5j');
    expect(sidecarPath('t1')).toBe('photos/t1/photos.json');
    expect(photoFilePaths('t1', 'p-1')).toEqual({
      file: 'photos/t1/p-1.jpg',
      thumb: 'photos/t1/p-1.sq.jpg',
      sprite: 'photos/t1/p-1.map.png',
    });
  });

  it('refuses ids that could escape the folder', () => {
    for (const bad of ['', '..', 'a/b', 'a.b', 'x'.repeat(65), 'é']) {
      expect(() => assertSafeId(bad)).toThrow(/Unsafe/);
    }
    expect(() => photoFilePaths('../etc', 'p')).toThrow();
  });

  it('stages inbox files with a clean extension', () => {
    expect(inboxPath('job1', 'HEIC')).toBe('.photo-inbox/job1.heic');
    expect(inboxPath('job1', '../x')).toBe('.photo-inbox/job1.jpg');
    expect(inboxPath('job1')).toBe('.photo-inbox/job1.jpg');
  });

  it('maps files back to photo ids', () => {
    expect(photoIdOfFile('abc.jpg')).toBe('abc');
    expect(photoIdOfFile('abc.sq.jpg')).toBe('abc');
    expect(photoIdOfFile('abc.map.png')).toBe('abc');
    expect(photoIdOfFile('photos.json')).toBeNull();
    expect(photoIdOfFile('abc.png')).toBeNull();
  });

  it('lists orphans, never the sidecar or its staging files', () => {
    const names = [
      'a.jpg',
      'a.sq.jpg',
      'a.map.png',
      'b.jpg',
      'b.map.png',
      'photos.json',
      'photos.json.tmp',
      'notes.txt',
    ];
    expect(orphanFiles(names, new Set(['a']))).toEqual(['b.jpg', 'b.map.png']);
    expect(orphanFiles(names, new Set(['a', 'b']))).toEqual([]);
  });
});
