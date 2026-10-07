import type { PhotoComment, TrackPhoto } from '@core/photos/model';

import { deleteOp, mergeEntity, setOp } from './crdt';
import type { EntityRecord } from './data';
import {
  changedPhotoFields,
  commentToFields,
  entityToComment,
  entityToPhoto,
  photoToFields,
} from './photos';
import { T0 } from './testing/fixtures';

const owner = 'OWNER';
const paths = { file: 'photos/t/p.jpg', thumb: 'photos/t/p.t.jpg', sprite: 'photos/t/p.s.png' };
const photo: TrackPhoto = {
  id: 'p1',
  trackId: 't1',
  distanceM: 1200,
  lngLat: [-71.2, 46.8],
  elevationM: 400,
  placement: 'time',
  takenAt: T0,
  takenAtSource: 'exif-offset',
  file: 'local/a.jpg',
  thumb: 'local/a.t.jpg',
  sprite: 'local/a.s.png',
  width: 1600,
  height: 1200,
  bytes: 300_000,
  contentHash: 'md5:abc',
  sourceKey: 'asset:XYZ',
  caption: 'Lookout',
  createdAt: T0,
  updatedAt: T0,
};
const s = (wall: number) => ({ wall, counter: 0, author: owner });

describe('photo ↔ team entity', () => {
  it('syncs metadata but never local paths or the camera-roll source key', () => {
    const f = photoToFields(photo);
    expect(f).not.toHaveProperty('file');
    expect(f).not.toHaveProperty('sourceKey');
    expect(f).not.toHaveProperty('author');
    expect(f['contentHash']).toBe('md5:abc');
  });

  it('reads back as the same TrackPhoto (with this device’s paths and LWW times)', () => {
    let state = setOp(photoToFields(photo), s(T0));
    state = mergeEntity(
      state,
      setOp(changedPhotoFields(photo, { ...photo, caption: 'Summit' }), s(T0 + 5)),
    );
    const rec: EntityRecord = { kind: 'photo', id: 'p1', owner, state };
    const back = entityToPhoto(rec, 'Alice', paths)!;
    expect(back).toMatchObject({
      ...paths,
      id: 'p1',
      caption: 'Summit',
      createdAt: T0,
      updatedAt: T0 + 5,
    });
    expect(back.author).toEqual({ id: owner, name: 'Alice' });
    expect(back.sourceKey).toBeUndefined();
    expect(back.deletedAt).toBeUndefined();
  });

  it('a deleted photo comes back as a tombstone', () => {
    const state = mergeEntity(setOp(photoToFields(photo), s(T0)), deleteOp(s(T0 + 9)));
    const back = entityToPhoto({ kind: 'photo', id: 'p1', owner, state }, 'Alice', paths)!;
    expect(back.deletedAt).toBe(T0 + 9);
    expect(back.trackId).toBe('t1');
  });

  it('cannot show a photo without its bytes, its owner or its trail', () => {
    const state = setOp(photoToFields(photo), s(T0));
    expect(entityToPhoto({ kind: 'photo', id: 'p1', owner, state }, 'A', undefined)).toBeNull();
    expect(entityToPhoto({ kind: 'photo', id: 'p1', state }, 'A', paths)).toBeNull();
    expect(entityToPhoto({ kind: 'wpt', id: 'p1', owner, state }, 'A', paths)).toBeNull();
    const noTrack = setOp({ distanceM: 1 }, s(T0));
    expect(
      entityToPhoto({ kind: 'photo', id: 'p1', owner, state: noTrack }, 'A', paths),
    ).toBeNull();
    const deadNoTrack = mergeEntity(noTrack, deleteOp(s(T0 + 1)));
    expect(
      entityToPhoto({ kind: 'photo', id: 'p1', owner, state: deadNoTrack }, 'A', paths),
    ).toBeNull();
  });
});

describe('comment ↔ team entity', () => {
  const comment: PhotoComment = {
    id: 'c1',
    photoId: 'p1',
    author: { id: owner, name: 'Alice' },
    text: 'Nice view @Bob',
    mentions: ['BOB'],
    createdAt: T0,
    updatedAt: T0,
  };

  it('round-trips, including mentions and tombstones', () => {
    const state = setOp(commentToFields(comment), s(T0));
    expect(entityToComment({ kind: 'comment', id: 'c1', owner, state }, 'Alice')).toEqual(comment);
    const dead = mergeEntity(state, deleteOp(s(T0 + 3)));
    expect(
      entityToComment({ kind: 'comment', id: 'c1', owner, state: dead }, 'Alice'),
    ).toMatchObject({
      text: 'Nice view @Bob',
      deletedAt: T0 + 3,
    });
    expect(commentToFields({ ...comment, mentions: [] })).not.toHaveProperty('mentions');
  });

  it('rejects records that are not readable comments', () => {
    const state = setOp({ photoId: 'p1' }, s(T0));
    expect(entityToComment({ kind: 'comment', id: 'c1', owner, state }, 'A')).toBeNull();
    expect(entityToComment({ kind: 'photo', id: 'c1', owner, state }, 'A')).toBeNull();
    expect(
      entityToComment({ kind: 'comment', id: 'c1', owner, state: deleteOp(s(T0)) }, 'A'),
    ).toBeNull();
    const odd = setOp({ photoId: 'p1', text: 'x', mentions: [1, 'ok'] }, s(T0));
    expect(
      entityToComment({ kind: 'comment', id: 'c1', owner, state: odd }, 'A')?.mentions,
    ).toEqual(['ok']);
  });
});
