import type { TrackPhoto } from './model';
import { photoFilePaths } from './paths';
import {
  editPhoto,
  existingKeys,
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
  it('prefers the asset id, else time + size', () => {
    expect(sourceKeyFor({ assetId: 'ABC/L0/001', exifTime: 5, width: 2, height: 3 })).toBe(
      'asset:ABC/L0/001',
    );
    expect(sourceKeyFor({ assetId: null, exifTime: 5, width: 2, height: 3 })).toBe('shot:5:2x3');
    expect(sourceKeyFor({ exifTime: 5 })).toBeUndefined();
    expect(sourceKeyFor({})).toBeUndefined();
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
