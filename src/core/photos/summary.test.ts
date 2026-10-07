import type { TrackPhoto } from './model';
import { photoCountLabel, photoSummaryChanged, trailPhotoSummary } from './summary';

const photo = (id: string, takenAt: number | undefined, extra: Partial<TrackPhoto> = {}) =>
  ({
    id,
    trackId: 't',
    distanceM: 0,
    lngLat: [0, 0],
    placement: 'time',
    file: 'f',
    thumb: 't',
    sprite: 's',
    width: 1,
    height: 1,
    bytes: 1,
    createdAt: 0,
    updatedAt: 0,
    ...(takenAt === undefined ? {} : { takenAt }),
    ...extra,
  }) as TrackPhoto;

describe('trailPhotoSummary', () => {
  it('counts shown photos and covers with the first in time', () => {
    expect(
      trailPhotoSummary([
        photo('b', 20),
        photo('a', 10, { hidden: true }),
        photo('c', 5, { deletedAt: 1 }),
        photo('d', 15),
      ]),
    ).toEqual({ photoCount: 2, coverPhotoId: 'd' });
  });

  it('is empty without photos', () => {
    expect(trailPhotoSummary([])).toEqual({});
    expect(trailPhotoSummary([photo('a', 1, { hidden: true })])).toEqual({});
  });

  it('spots a change', () => {
    expect(photoSummaryChanged({}, {})).toBe(false);
    expect(
      photoSummaryChanged(
        { photoCount: 1, coverPhotoId: 'a' },
        { photoCount: 1, coverPhotoId: 'a' },
      ),
    ).toBe(false);
    expect(
      photoSummaryChanged(
        { photoCount: 1, coverPhotoId: 'a' },
        { photoCount: 2, coverPhotoId: 'a' },
      ),
    ).toBe(true);
    expect(
      photoSummaryChanged(
        { photoCount: 1, coverPhotoId: 'a' },
        { photoCount: 1, coverPhotoId: 'b' },
      ),
    ).toBe(true);
  });

  it('labels a count', () => {
    expect(photoCountLabel(1)).toBe('1 photo');
    expect(photoCountLabel(33)).toBe('33 photos');
  });
});
