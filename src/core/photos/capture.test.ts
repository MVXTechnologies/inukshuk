import { lineTrack, T0 } from './__fixtures__/tracks';
import {
  captureToastText,
  materializePendingPhotos,
  pendingAsTrackPhotos,
  photoButtonLabel,
  sanitizePendingPhotos,
  type PendingPhoto,
} from './capture';

const pending = (id: string, takenAt: number, extra: Partial<PendingPhoto> = {}): PendingPhoto => ({
  id,
  takenAt,
  lngLat: [-71, 47],
  distanceM: 100,
  file: `photos/s1/${id}.jpg`,
  thumb: `photos/s1/${id}.sq.jpg`,
  sprite: `photos/s1/${id}.map.png`,
  width: 2048,
  height: 1536,
  bytes: 700_000,
  ...extra,
});

describe('sanitizePendingPhotos', () => {
  it('keeps valid entries and drops junk', () => {
    const good = pending('a', T0, { elevationM: 730, contentHash: 'md5:x' });
    expect(
      sanitizePendingPhotos([
        good,
        null,
        'x',
        { ...good, id: '' },
        { ...good, takenAt: 'now' },
        { ...good, lngLat: [1] },
        { ...good, lngLat: [1, 'x'] },
        { ...good, file: '../escape.jpg' },
        { ...good, sprite: '' },
        { ...pending('b', T0), width: 'w', height: null, bytes: undefined, distanceM: -5 },
      ]),
    ).toEqual([good, { ...pending('b', T0), width: 0, height: 0, bytes: 0, distanceM: 0 }]);
  });

  it('reads anything but an array as none', () => {
    expect(sanitizePendingPhotos(undefined)).toEqual([]);
    expect(sanitizePendingPhotos({})).toEqual([]);
  });
});

describe('materializePendingPhotos', () => {
  // 1 s per metre: a photo at T0 + 250 s sits at 250 m.
  const points = lineTrack({ lengthM: 1000 });

  it('places captured photos by their capture time, in time order', () => {
    const photos = materializePendingPhotos(
      [pending('late', T0 + 800_000), pending('early', T0 + 250_000, { contentHash: 'md5:a' })],
      'track1',
      points,
      42,
    );
    expect(photos.map((p) => p.id)).toEqual(['early', 'late']);
    expect(photos[0]).toMatchObject({
      trackId: 'track1',
      placement: 'capture',
      takenAtSource: 'capture',
      takenAt: T0 + 250_000,
      file: 'photos/s1/early.jpg',
      contentHash: 'md5:a',
      createdAt: 42,
    });
    expect(photos[0]!.distanceM).toBeCloseTo(250, 0);
    expect(photos[1]!.distanceM).toBeCloseTo(800, 0);
  });

  it('falls back to the fix, then the end, when the time is off the trail', () => {
    const near = points[30]!; // 300 m
    const [byFix] = materializePendingPhotos(
      [pending('a', T0 + 9e9, { lngLat: [near.longitude, near.latitude] })],
      't',
      points,
      1,
    );
    expect(byFix!.distanceM).toBeCloseTo(300, 0);
    const [atEnd] = materializePendingPhotos(
      [pending('b', T0 + 9e9, { lngLat: [10, 10] })],
      't',
      points,
      1,
    );
    expect(atEnd!.distanceM).toBeCloseTo(1000, 0);
  });

  it('is empty without pending photos or without points', () => {
    expect(materializePendingPhotos([], 't', points, 1)).toEqual([]);
    expect(materializePendingPhotos([pending('a', T0)], 't', [], 1)).toEqual([]);
  });
});

it('draws pending photos as trail photos', () => {
  const [p] = pendingAsTrackPhotos([pending('a', T0, { elevationM: 700 })], 's1');
  expect(p).toMatchObject({ id: 'a', trackId: 's1', lngLat: [-71, 47], elevationM: 700 });
  expect(pendingAsTrackPhotos([pending('b', T0)], 's1')[0]).not.toHaveProperty('elevationM');
});

it('words the capture snackbar and the button label', () => {
  expect(captureToastText(7, ['2.40 km', null, '732 m', '', '10:10'])).toEqual({
    title: 'Photo 7 added to this recording',
    detail: '2.40 km · 732 m · 10:10',
  });
  expect(photoButtonLabel(0)).toBe('Take a photo');
  expect(photoButtonLabel(1)).toBe('Take a photo, 1 photo so far');
  expect(photoButtonLabel(7)).toBe('Take a photo, 7 photos so far');
});
