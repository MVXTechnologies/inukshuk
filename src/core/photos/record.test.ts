import type { TrackPhoto } from './model';
import { photoFilePaths } from './paths';
import {
  editPhoto,
  existingKeys,
  fileFingerprint,
  newTrackPhoto,
  pruneTombstones,
  sourceKeyFor,
  tombstone,
  TOMBSTONE_RETAIN_MS,
} from './record';

const paths = photoFilePaths('t1', 'p1');

const full = newTrackPhoto({
  id: 'p1',
  trackId: 't1',
  position: { distanceM: 3200, lngLat: [-70.6, 47.6], elevationM: 830 },
  placement: 'time',
  takenAt: 1000,
  takenAtSource: 'exif-gps-utc',
  clockOffsetMs: 3_600_000,
  paths,
  width: 2048,
  height: 1536,
  bytes: 700_000,
  contentHash: 'md5:ab',
  sourceKey: 'asset:1',
  caption: '  Summit  ',
  author: { id: 'u', name: 'M' },
  now: 50,
});

describe('newTrackPhoto', () => {
  it('builds the record from a placed, copied photo', () => {
    expect(full).toEqual({
      id: 'p1',
      trackId: 't1',
      distanceM: 3200,
      lngLat: [-70.6, 47.6],
      elevationM: 830,
      placement: 'time',
      takenAt: 1000,
      takenAtSource: 'exif-gps-utc',
      clockOffsetMs: 3_600_000,
      ...paths,
      width: 2048,
      height: 1536,
      bytes: 700_000,
      contentHash: 'md5:ab',
      sourceKey: 'asset:1',
      caption: 'Summit',
      author: { id: 'u', name: 'M' },
      createdAt: 50,
      updatedAt: 50,
    });
  });

  it('leaves out what is unknown', () => {
    const minimal = newTrackPhoto({
      id: 'p2',
      trackId: 't1',
      position: { distanceM: 0, lngLat: [0, 1] },
      placement: 'manual',
      paths,
      width: 1,
      height: 1,
      bytes: 1,
      clockOffsetMs: 0,
      caption: '  ',
      now: 1,
    });
    expect(Object.keys(minimal).sort()).toEqual(
      [
        'bytes',
        'createdAt',
        'distanceM',
        'file',
        'height',
        'id',
        'lngLat',
        'placement',
        'sprite',
        'thumb',
        'trackId',
        'updatedAt',
        'width',
      ].sort(),
    );
  });
});

describe('sourceKeyFor / existingKeys', () => {
  it('prefers the asset id, else the raw EXIF wall clock + size', () => {
    const wall = '2026:09:27 10:31:05.120';
    expect(sourceKeyFor({ assetId: 'ABC/L0/001', exifWallClock: wall, width: 2, height: 3 })).toBe(
      'asset:ABC/L0/001',
    );
    expect(sourceKeyFor({ assetId: null, exifWallClock: wall, width: 2, height: 3 })).toBe(
      'shot:2026:09:27 10:31:05.120:-:2x3',
    );
    expect(sourceKeyFor({ exifWallClock: wall })).toBeUndefined();
    expect(sourceKeyFor({})).toBeUndefined();
  });

  it('tells apart different photos taken in the same second (Android: no asset id)', () => {
    const wall = '2026:09:27 10:31:05';
    const a = sourceKeyFor({
      exifWallClock: wall,
      camera: 'samsung SM-S911W',
      width: 4032,
      height: 3024,
      fingerprint: fileFingerprint(2_100_000, new Uint8Array([1, 2, 3])),
    });
    const b = sourceKeyFor({
      exifWallClock: wall,
      camera: 'samsung SM-S911W',
      width: 4032,
      height: 3024,
      fingerprint: fileFingerprint(2_100_000, new Uint8Array([1, 2, 4])),
    });
    expect(a).not.toBe(b);
    // The same file picked again: the same key.
    expect(
      sourceKeyFor({
        exifWallClock: wall,
        camera: 'samsung SM-S911W',
        width: 4032,
        height: 3024,
        fingerprint: fileFingerprint(2_100_000, new Uint8Array([1, 2, 3])),
      }),
    ).toBe(a);
    // Two cameras in the same second, without a fingerprint: still apart.
    expect(sourceKeyFor({ exifWallClock: wall, camera: 'A', width: 2, height: 3 })).not.toBe(
      sourceKeyFor({ exifWallClock: wall, camera: 'B', width: 2, height: 3 }),
    );
    // A timeless photo is still recognised by its bytes.
    expect(sourceKeyFor({ fingerprint: '10-00000001' })).toBe('shot:-:-:-:10-00000001');
  });

  it('fingerprints a file by its size and first bytes', () => {
    expect(fileFingerprint(5, new Uint8Array([]))).toBe('5-811c9dc5');
    expect(fileFingerprint(5, new Uint8Array([1]))).not.toBe(
      fileFingerprint(6, new Uint8Array([1])),
    );
    expect(fileFingerprint(5, new Uint8Array([1]))).not.toBe(
      fileFingerprint(5, new Uint8Array([2])),
    );
  });

  it('collects keys and hashes of live photos only', () => {
    const dead: TrackPhoto = {
      ...full,
      id: 'x',
      sourceKey: 'asset:dead',
      contentHash: 'md5:dead',
      deletedAt: 1,
    };
    const bare: TrackPhoto = { ...full, id: 'y' };
    delete bare.sourceKey;
    delete bare.contentHash;
    expect([...existingKeys([full, dead, bare])]).toEqual(['asset:1', 'md5:ab']);
  });
});

describe('editPhoto', () => {
  it('sets and clears caption and hidden, bumping updatedAt', () => {
    const hidden = editPhoto(full, { hidden: true, caption: 'New' }, 99);
    expect(hidden).toMatchObject({ hidden: true, caption: 'New', updatedAt: 99, createdAt: 50 });
    const shown = editPhoto(hidden, { hidden: false, caption: ' ' }, 100);
    expect(shown).not.toHaveProperty('hidden');
    expect(shown).not.toHaveProperty('caption');
  });

  it('a manual move updates position and placement', () => {
    const moved = editPhoto(full, { position: { distanceM: 10, lngLat: [1, 2] } }, 5);
    expect(moved).toMatchObject({ distanceM: 10, lngLat: [1, 2], placement: 'manual' });
    expect(moved).not.toHaveProperty('elevationM');
    expect(
      editPhoto(full, { position: { distanceM: 10, lngLat: [1, 2], elevationM: 3 } }, 5).elevationM,
    ).toBe(3);
  });
});

describe('tombstones', () => {
  it('drops the caption, keeps the id for peers', () => {
    const t = tombstone(full, 77);
    expect(t).toMatchObject({ id: 'p1', deletedAt: 77, updatedAt: 77 });
    expect(t).not.toHaveProperty('caption');
  });

  it('prunes tombstones past retention', () => {
    const old = tombstone({ ...full, id: 'old' }, 0);
    const recent = tombstone({ ...full, id: 'recent' }, TOMBSTONE_RETAIN_MS);
    const kept = pruneTombstones([full, old, recent], TOMBSTONE_RETAIN_MS + 1);
    expect(kept.map((p) => p.id)).toEqual(['p1', 'recent']);
  });
});
