import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import type { TrackPhoto } from '@core/photos/model';
import { photoFilePaths } from '@core/photos/paths';
import { TOMBSTONE_RETAIN_MS } from '@core/photos/record';

import { writePhotoCopies } from './photoFiles';
import { readSidecar, updateSidecar, writeSidecar } from './sidecarStore';
import { fakeFs } from './testFileSystem';
import {
  deleteTrailWithPhotos,
  editTrailPhoto,
  loadTrailPhotos,
  onTrailsMerged,
  onTrailTrimmed,
  removeTrailPhoto,
  tidyTrailPhotos,
  trailPhotoCount,
} from './trailPhotos';

jest.mock('expo-file-system', () =>
  jest.requireActual<typeof import('./testFileSystem')>('./testFileSystem').createFakeFileSystem(),
);
jest.mock('@data/localServer', () => ({ copyToServed: jest.fn() }));

const fs = fakeFs();
const b64 = Buffer.from('x').toString('base64');

function photo(
  trackId: string,
  id: string,
  distanceM: number,
  extra: Partial<TrackPhoto> = {},
): TrackPhoto {
  writePhotoCopies(trackId, id, { display: b64, thumb: b64, sprite: b64 });
  return {
    id,
    trackId,
    distanceM,
    lngLat: offset(distanceM),
    placement: 'time',
    takenAt: T0 + distanceM * 1000,
    ...photoFilePaths(trackId, id),
    width: 1,
    height: 1,
    bytes: 3,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function seedTrail(trackId: string, photos: TrackPhoto[]) {
  writeSidecar({ version: 1, trackId, photos, comments: [] }, 0);
}

beforeEach(() => fs.reset());

describe('sidecar store', () => {
  it('round-trips and reports unreadable records', async () => {
    seedTrail('t1', [photo('t1', 'a', 10)]);
    fs.seed('/doc/photos/t2/photos.json', JSON.stringify({ version: 1, photos: [{ id: 'x' }] }));
    expect((await readSidecar('t1')).sidecar.photos.map((p) => p.id)).toEqual(['a']);
    expect(await readSidecar('t2')).toMatchObject({ dropped: 1 });
    expect((await readSidecar('none')).sidecar.photos).toEqual([]);
  });

  it('serializes concurrent updates to one trail', async () => {
    seedTrail('t1', []);
    const add = (id: string) =>
      updateSidecar('t1', async (s) => {
        await new Promise((r) => setTimeout(r, 1));
        return { ...s, photos: [...s.photos, photo('t1', id, 1)] };
      });
    await Promise.all([add('a'), add('b'), add('c')]);
    expect((await readSidecar('t1')).sidecar.photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the queue going after a failed update', async () => {
    seedTrail('t1', []);
    await expect(updateSidecar('t1', () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    await updateSidecar('t1', (s) => ({ ...s, photos: [photo('t1', 'a', 1)] }));
    expect((await readSidecar('t1')).sidecar.photos).toHaveLength(1);
  });

  it('skips the write when nothing changed', async () => {
    await updateSidecar('t9', (s) => s);
    expect(fs.files.has('/doc/photos/t9/photos.json')).toBe(false);
  });

  it('prunes old tombstones on write', async () => {
    const dead = photo('t1', 'a', 1, { deletedAt: 1 });
    writeSidecar({ version: 1, trackId: 't1', photos: [dead], comments: [] }, 2);
    expect((await readSidecar('t1')).sidecar.photos).toHaveLength(1);
    writeSidecar(
      { version: 1, trackId: 't1', photos: [dead], comments: [] },
      TOMBSTONE_RETAIN_MS + 2,
    );
    expect((await readSidecar('t1')).sidecar.photos).toEqual([]);
  });
});

describe('trail photos', () => {
  beforeEach(() => {
    seedTrail('t1', [photo('t1', 'late', 900), photo('t1', 'early', 100), photo('t1', 'mid', 500)]);
  });

  it('loads live photos in time order', async () => {
    expect((await loadTrailPhotos('t1')).map((p) => p.id)).toEqual(['early', 'mid', 'late']);
    expect(await trailPhotoCount('t1')).toBe(3);
  });

  it('edits a caption, and returns null for an unknown photo', async () => {
    const p = await editTrailPhoto('t1', 'mid', { caption: 'Lookout' }, 50);
    expect(p).toMatchObject({ caption: 'Lookout', updatedAt: 50 });
    expect((await loadTrailPhotos('t1'))[1]!.caption).toBe('Lookout');
    expect(await editTrailPhoto('t1', 'ghost', { caption: 'x' })).toBeNull();
  });

  it('removes a photo: tombstone kept, files gone', async () => {
    expect(await removeTrailPhoto('t1', 'mid', Date.now())).toBe(true);
    expect((await loadTrailPhotos('t1')).map((p) => p.id)).toEqual(['early', 'late']);
    const { sidecar } = await readSidecar('t1');
    expect(sidecar.photos.find((p) => p.id === 'mid')?.deletedAt).toBeDefined();
    expect(fs.files.has('/doc/photos/t1/mid.jpg')).toBe(false);
    expect(await removeTrailPhoto('t1', 'mid')).toBe(false);
  });

  it('deletes everything with the trail', async () => {
    deleteTrailWithPhotos('t1');
    expect(await loadTrailPhotos('t1')).toEqual([]);
    expect(fs.list('/doc/photos/t1')).toEqual([]);
  });

  it('trims: photos on the cut ends go, the rest shift', async () => {
    const trimmed = lineTrack({ lengthM: 1000 }).slice(20, 71); // keep 200–700 m
    expect(await onTrailTrimmed('t1', 200, 700, trimmed, 9)).toBe(2);
    const left = await loadTrailPhotos('t1');
    expect(left.map((p) => [p.id, Math.round(p.distanceM)])).toEqual([['mid', 300]]);
    expect(fs.files.has('/doc/photos/t1/early.jpg')).toBe(false);
    expect(fs.files.has('/doc/photos/t1/late.map.png')).toBe(false);
  });

  it('a trim that touches no photo does not rewrite the sidecar', async () => {
    const before = fs.text('/doc/photos/t1/photos.json');
    // Same trail, nothing cut: reanchoring still refreshes updatedAt, so it writes.
    await onTrailTrimmed('t1', 0, 1000, lineTrack({ lengthM: 1000 }), 9);
    expect(fs.text('/doc/photos/t1/photos.json')).not.toBe(before);
    seedTrail('t3', []);
    const empty = fs.text('/doc/photos/t3/photos.json');
    await onTrailTrimmed('t3', 0, 10, lineTrack({ lengthM: 10 }), 9);
    expect(fs.text('/doc/photos/t3/photos.json')).toBe(empty);
  });

  it('merges: photos move folders and are re-placed by time', async () => {
    seedTrail('t2', [photo('t2', 'other', 50)]);
    const merged = lineTrack({ lengthM: 1000 });
    expect(await onTrailsMerged(['t1', 't2'], 't1', merged, 9)).toBe(1);
    const all = await loadTrailPhotos('t1');
    expect(all.map((p) => p.id)).toEqual(['other', 'early', 'mid', 'late']);
    expect(all[0]).toMatchObject({ trackId: 't1', file: 'photos/t1/other.jpg' });
    expect(fs.files.has('/doc/photos/t1/other.map.png')).toBe(true);
    expect(fs.list('/doc/photos/t2')).toEqual([]);
  });

  it('tidies: rewrites a torn sidecar and sweeps orphans', async () => {
    writePhotoCopies('t1', 'orphan', { display: b64, thumb: b64, sprite: b64 });
    const raw = JSON.parse(fs.text('/doc/photos/t1/photos.json')!);
    raw.photos.push({ id: 'broken' });
    fs.seed('/doc/photos/t1/photos.json', JSON.stringify(raw));
    expect(await tidyTrailPhotos('t1', 5)).toBe(3);
    expect(await readSidecar('t1')).toMatchObject({ dropped: 0 });
    expect(await tidyTrailPhotos('t1')).toBe(0);
  });
});
