import type { TrackNote } from '@core/models';

import { lineTrack, T0 } from './__fixtures__/tracks';
import type { TrackPhoto } from './model';
import { combineTrailPhotos, notePhotosOnTrail } from './notePhotos';
import { indexTrack } from './trackIndex';

const note = (id: string, distanceM: number, photoUri?: string): TrackNote => ({
  id,
  distanceM,
  text: `note ${id}`,
  createdAt: 1,
  ...(photoUri ? { photoUri } : {}),
});

describe('notePhotosOnTrail', () => {
  const index = indexTrack(lineTrack({ lengthM: 1000 }));

  it('places each note photo at its distance, skipping notes without one', () => {
    const photos = notePhotosOnTrail(
      [
        note('a', 250, 'file:///doc/photos/a.jpg'),
        note('b', 400),
        note('c', 5000, 'file:///c.jpg'),
      ],
      't1',
      index,
    );
    expect(photos.map((p) => p.id)).toEqual(['note:a', 'note:c']);
    expect(photos[0]).toMatchObject({ trackId: 't1', distanceM: 250, caption: 'note a' });
    expect(photos[0]!.elevationM).toBeCloseTo(525);
    // Past the end: clamped onto the last point.
    expect(photos[1]!.distanceM).toBeCloseTo(1000);
  });

  it('is empty without notes or without a trail', () => {
    expect(notePhotosOnTrail(undefined, 't1', index)).toEqual([]);
    expect(notePhotosOnTrail([note('a', 1, 'file:///a.jpg')], 't1', indexTrack([]))).toEqual([]);
  });

  it('places a note photo without elevation on an altitude-less trail', () => {
    const flat = indexTrack(lineTrack({ lengthM: 100 }).map(({ altitude: _a, ...p }) => p));
    const [p] = notePhotosOnTrail([note('a', 50, 'file:///a.jpg')], 't1', flat);
    expect(p).not.toHaveProperty('elevationM');
  });
});

describe('combineTrailPhotos', () => {
  const own = { id: 'p1', takenAt: T0 + 5, distanceM: 900 } as TrackPhoto;
  const notePhoto = { id: 'note:a', distanceM: 10 } as TrackPhoto;

  it('orders timed photos first, then note photos by distance', () => {
    expect(combineTrailPhotos([own], [notePhoto]).map((p) => p.id)).toEqual(['p1', 'note:a']);
  });

  it('keeps the photos as they are without note photos', () => {
    expect(combineTrailPhotos([own], [])).toEqual([own]);
  });
});
