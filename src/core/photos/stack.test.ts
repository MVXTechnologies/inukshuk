import type { TrackPhoto } from './model';
import {
  comparePhotos,
  groupLane,
  orderPhotos,
  PHOTO_CLUSTER_PROPERTIES,
  photoFeatureCollection,
  snapToLane,
  stackCover,
  visiblePhotos,
} from './stack';

const photo = (
  id: string,
  takenAt: number | undefined,
  distanceM: number,
  extra: Partial<TrackPhoto> = {},
): TrackPhoto => ({
  id,
  trackId: 't',
  distanceM,
  lngLat: [distanceM / 1000, 47],
  placement: 'time',
  ...(takenAt === undefined ? {} : { takenAt }),
  file: `photos/t/${id}.jpg`,
  thumb: `photos/t/${id}.sq.jpg`,
  sprite: `photos/t/${id}.map.png`,
  width: 1,
  height: 1,
  bytes: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('ordering', () => {
  const a = photo('a', 300, 50);
  const b = photo('b', 100, 900);
  const c = photo('c', undefined, 10);
  const d = photo('d', undefined, 5);
  const e = photo('e', 100, 900);

  it('sorts by time, timeless last by distance, ids break ties', () => {
    expect(orderPhotos([a, c, e, b, d]).map((p) => p.id)).toEqual(['b', 'e', 'a', 'd', 'c']);
    expect(comparePhotos(b, b)).toBe(0);
    expect(comparePhotos(photo('x', 1, 5), photo('y', 1, 9))).toBeLessThan(0);
  });

  it('the cover of a stack is its first photo in time', () => {
    expect(stackCover([a, c, e, b])!.id).toBe('b');
    expect(stackCover([])).toBeUndefined();
  });
});

describe('visiblePhotos / photoFeatureCollection', () => {
  const photos = [
    photo('late', 300, 50),
    photo('gone', 1, 1, { deletedAt: 5 }),
    photo('hid', 2, 2, { hidden: true }),
    photo('early', 100, 900),
  ];

  it('drops hidden and tombstoned photos', () => {
    expect(visiblePhotos(photos).map((p) => p.id)).toEqual(['late', 'early']);
  });

  it('builds one point per visible photo with its rank in time', () => {
    const fc = photoFeatureCollection(photos);
    expect(fc.features.map((f) => f.properties)).toEqual([
      { id: 'early', order: 0 },
      { id: 'late', order: 1 },
    ]);
    expect(fc.features[0]!.geometry.coordinates).toEqual([0.9, 47]);
    expect(fc.features[0]!.id).toBe(0);
  });

  it('the cluster cover is the minimum rank', () => {
    expect(PHOTO_CLUSTER_PROPERTIES).toEqual({ order: ['min', ['get', 'order']] });
  });
});

describe('groupLane', () => {
  const items = [
    { photo: photo('p1', 10, 0), x: 10 },
    { photo: photo('p2', 5, 0), x: 25 },
    { photo: photo('p3', 30, 0), x: 38 },
    { photo: photo('p4', 40, 0), x: 100 },
    { photo: photo('p5', 50, 0), x: 104 },
  ];

  it('stacks photos closer than the gap to the group start, cover first in time', () => {
    const groups = groupLane(items, 25);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([
      ['p2', 'p1'],
      ['p3'],
      ['p4', 'p5'],
    ]);
    expect(groups.map((g) => g.cover.id)).toEqual(['p2', 'p3', 'p4']);
    expect(groups[0]!.x).toBe(17.5);
    expect(groups[2]!.x).toBe(102);
  });

  it('accepts unsorted input', () => {
    expect(groupLane([...items].reverse(), 25).map((g) => g.cover.id)).toEqual(['p2', 'p3', 'p4']);
  });

  it('snaps the cursor to the nearest group within reach', () => {
    const groups = groupLane(items, 25);
    expect(snapToLane(groups, 20)!.cover.id).toBe('p2');
    expect(snapToLane(groups, 95)!.cover.id).toBe('p4');
    expect(snapToLane(groups, 70)).toBeUndefined();
    expect(snapToLane(groups, 70, 40)!.cover.id).toBe('p3');
  });
});
