import {
  emptySidecar,
  isNotePhoto,
  livePhotos,
  migratePhotoSidecar,
  noteToPhoto,
  PHOTO_SIDECAR_VERSION,
  sanitizePhoto,
  type TrackPhoto,
} from './model';

const base: TrackPhoto = {
  id: 'abc123def456',
  trackId: 't1',
  distanceM: 3200,
  lngLat: [-70.6132, 47.6675],
  elevationM: 830,
  placement: 'time',
  takenAt: 1_790_519_520_000,
  takenAtSource: 'exif-offset',
  clockOffsetMs: 3_600_000,
  exifLngLat: [-70.6133, 47.6676],
  file: 'photos/t1/abc123def456.jpg',
  thumb: 'photos/t1/abc123def456.sq.jpg',
  sprite: 'photos/t1/abc123def456.map.png',
  width: 2048,
  height: 1365,
  bytes: 640_000,
  contentHash: 'md5:00ff',
  sourceKey: 'asset:XYZ',
  caption: 'Lac des Cygnes appears',
  hidden: true,
  author: { id: 'u1', name: 'Marc-André' },
  createdAt: 10,
  updatedAt: 20,
};

describe('sanitizePhoto', () => {
  it('round-trips a full record (JSON in, same record out)', () => {
    expect(sanitizePhoto(JSON.parse(JSON.stringify(base)), 't1')).toEqual(base);
  });

  it('forces the owning trail id', () => {
    expect(sanitizePhoto(base, 'other')!.trackId).toBe('other');
  });

  it.each([
    ['no id', { id: '' }],
    ['no distance', { distanceM: 'x' }],
    ['bad position', { lngLat: [200, 0] }],
    ['short position', { lngLat: [1] }],
    ['no file', { file: undefined }],
    ['no thumb', { thumb: '' }],
    ['no sprite', { sprite: 3 }],
  ])('drops a record with %s', (_label, patch) => {
    expect(sanitizePhoto({ ...base, ...patch }, 't1')).toBeNull();
  });

  it('drops bad optional fields one by one and defaults the rest', () => {
    const p = sanitizePhoto(
      {
        ...base,
        placement: 'teleport',
        takenAtSource: 'guess',
        clockOffsetMs: 0,
        exifLngLat: 'x',
        caption: '   ',
        hidden: 'yes',
        author: { id: '', name: 'x' },
        width: null,
        createdAt: 'x',
        updatedAt: undefined,
        distanceM: -5,
        elevationM: NaN,
        contentHash: 1,
        sourceKey: '',
        deletedAt: 99,
      },
      't1',
    )!;
    expect(p.placement).toBe('manual');
    expect(p.distanceM).toBe(0);
    expect(p.width).toBe(0);
    expect(p.createdAt).toBe(0);
    expect(p.updatedAt).toBe(0);
    expect(p.deletedAt).toBe(99);
    for (const k of [
      'takenAtSource',
      'clockOffsetMs',
      'exifLngLat',
      'caption',
      'hidden',
      'author',
      'elevationM',
      'contentHash',
      'sourceKey',
    ]) {
      expect(p).not.toHaveProperty(k);
    }
  });

  it('rejects non-objects', () => {
    expect(sanitizePhoto(null, 't')).toBeNull();
    expect(sanitizePhoto('x', 't')).toBeNull();
  });
});

describe('migratePhotoSidecar', () => {
  it('reads a v1 file, keeping valid records and counting the rest', () => {
    const { sidecar, dropped } = migratePhotoSidecar(
      {
        version: 1,
        trackId: 't1',
        photos: [base, { id: 'broken' }],
        comments: [
          {
            id: 'c1',
            photoId: base.id,
            author: { id: 'u2', name: 'Ann' },
            text: 'Wow @Marc',
            mentions: ['u1', 3],
            createdAt: 5,
          },
          {
            id: 'c2',
            photoId: base.id,
            author: { id: 'u2', name: 'Ann' },
            text: 'x',
            createdAt: 5,
            updatedAt: 9,
            deletedAt: 9,
          },
          { id: 'bad' },
          null,
        ],
      },
      't1',
    );
    expect(sidecar.version).toBe(PHOTO_SIDECAR_VERSION);
    expect(sidecar.photos).toEqual([base]);
    expect(sidecar.comments).toEqual([
      {
        id: 'c1',
        photoId: base.id,
        author: { id: 'u2', name: 'Ann' },
        text: 'Wow @Marc',
        mentions: ['u1'],
        createdAt: 5,
        updatedAt: 5,
      },
      {
        id: 'c2',
        photoId: base.id,
        author: { id: 'u2', name: 'Ann' },
        text: 'x',
        createdAt: 5,
        updatedAt: 9,
        deletedAt: 9,
      },
    ]);
    expect(dropped).toBe(3);
  });

  it('keeps the most recently updated record of a duplicated id', () => {
    const older = { ...base, caption: 'old', updatedAt: 1 };
    const newer = { ...base, caption: 'new', updatedAt: 50 };
    expect(migratePhotoSidecar({ photos: [newer, older] }, 't1').sidecar.photos[0]!.caption).toBe(
      'new',
    );
    expect(migratePhotoSidecar({ photos: [older, newer] }, 't1').sidecar.photos[0]!.caption).toBe(
      'new',
    );
  });

  it('gives an empty sidecar for a missing or garbage file', () => {
    expect(migratePhotoSidecar(null, 't9')).toEqual({ sidecar: emptySidecar('t9'), dropped: 0 });
    expect(migratePhotoSidecar('nope', 't9').sidecar.photos).toEqual([]);
    expect(migratePhotoSidecar({ photos: 'x', comments: 'y' }, 't9').sidecar.photos).toEqual([]);
  });

  it('leaves a file from a newer app alone', () => {
    const { sidecar, dropped } = migratePhotoSidecar({ version: 2, photos: [base, base] }, 't1');
    expect(sidecar.photos).toEqual([]);
    expect(dropped).toBe(2);
    expect(migratePhotoSidecar({ version: 2 }, 't1').dropped).toBe(0);
  });
});

describe('livePhotos', () => {
  it('drops tombstones', () => {
    expect(livePhotos([base, { ...base, id: 'x', deletedAt: 1 }])).toEqual([base]);
  });
});

describe('noteToPhoto', () => {
  const note = {
    id: 'n1',
    distanceM: 1200,
    text: 'Ravito',
    createdAt: 7,
    photoUri: 'photos/n1.jpg',
  };

  it('presents a note photo as a read-only trail photo', () => {
    const p = noteToPhoto(note, 't1', { lngLat: [1, 2], elevationM: 600 })!;
    expect(p).toMatchObject({
      id: 'note:n1',
      trackId: 't1',
      distanceM: 1200,
      lngLat: [1, 2],
      elevationM: 600,
      placement: 'manual',
      file: 'photos/n1.jpg',
      caption: 'Ravito',
    });
    expect(isNotePhoto(p)).toBe(true);
    expect(isNotePhoto(base)).toBe(false);
  });

  it('skips notes without a photo and blank captions', () => {
    expect(noteToPhoto({ ...note, photoUri: undefined }, 't1', { lngLat: [1, 2] })).toBeNull();
    const p = noteToPhoto({ ...note, text: ' ' }, 't1', { lngLat: [1, 2] })!;
    expect(p).not.toHaveProperty('caption');
    expect(p).not.toHaveProperty('elevationM');
  });
});
