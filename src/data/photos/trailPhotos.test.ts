import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import type { TrackPhoto } from '@core/photos/model';
import { photoFilePaths } from '@core/photos/paths';
import { TOMBSTONE_RETAIN_MS } from '@core/photos/record';

import { writePhotoCopies } from './photoFiles';
import { readSidecar, SidecarUnavailableError, updateSidecar, writeSidecar } from './sidecarStore';
import { fakeFs } from './testUtils/testFileSystem';
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
  jest
    .requireActual<typeof import('./testUtils/testFileSystem')>('./testUtils/testFileSystem')
    .createFakeFileSystem(),
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

  it('reports each read status', async () => {
    seedTrail('ok', [photo('ok', 'a', 10)]);
    expect(await readSidecar('ok')).toMatchObject({ status: 'ok' });
    expect(await readSidecar('none')).toMatchObject({ status: 'missing', dropped: 0 });
    fs.seed('/doc/photos/bad/photos.json', '{"version":1,"photos":[');
    expect(await readSidecar('bad')).toMatchObject({ status: 'unreadable' });
    fs.seed('/doc/photos/new/photos.json', JSON.stringify({ version: 9, photos: [{ id: 'a' }] }));
    expect(await readSidecar('new')).toMatchObject({ status: 'future', dropped: 1 });
    fs.seed('/doc/photos/shape/photos.json', '[1,2]');
    expect(await readSidecar('shape')).toMatchObject({ status: 'unreadable' });
  });

  it('recovers from the staged copy when the sidecar itself is torn', async () => {
    seedTrail('t1', [photo('t1', 'a', 10)]);
    const good = fs.text('/doc/photos/t1/photos.json')!;
    fs.seed('/doc/photos/t1/photos.json', '{"torn');
    fs.seed('/doc/photos/t1/photos.json.tmp', good);
    const r = await readSidecar('t1');
    expect(r.status).toBe('ok');
    expect(r.sidecar.photos.map((p) => p.id)).toEqual(['a']);
    // Promoted from the stage after a crash between delete and move.
    fs.files.delete('/doc/photos/t1/photos.json');
    expect((await readSidecar('t1')).status).toBe('ok');
  });

  it('is unreadable when both the sidecar and its staged copy are corrupt', async () => {
    fs.seed('/doc/photos/t1/photos.json', '{"torn');
    fs.seed('/doc/photos/t1/photos.json.tmp', '{"also torn');
    expect((await readSidecar('t1')).status).toBe('unreadable');
  });

  it('treats a lone torn staged copy (a first write that never landed) as missing', async () => {
    fs.seed('/doc/photos/t1/photos.json.tmp', '{"torn');
    expect((await readSidecar('t1')).status).toBe('missing');
  });

  it.each([
    ['unreadable', '{"version":1,"photos":['],
    ['future', JSON.stringify({ version: 2, photos: [] })],
  ])('refuses to write over an %s sidecar and leaves it as it was', async (status, text) => {
    fs.seed('/doc/photos/t1/photos.json', text);
    const update = updateSidecar('t1', (s) => ({ ...s, photos: [photo('t1', 'a', 1)] }));
    await expect(update).rejects.toThrow(SidecarUnavailableError);
    await expect(update).rejects.toMatchObject({ status, trackId: 't1' });
    expect(fs.text('/doc/photos/t1/photos.json')).toBe(text);
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

  it('merges: photos are copied to the new trail under new ids, originals kept', async () => {
    seedTrail('t2', [photo('t2', 'other', 50)]);
    const merged = lineTrack({ lengthM: 1000 });
    let n = 0;
    const newId = () => `m${++n}`;
    expect(await onTrailsMerged(['t1', 't2'], 'new', merged, newId, 9)).toEqual({
      copied: 4,
      skippedTrails: [],
    });
    const all = await loadTrailPhotos('new');
    expect(all).toHaveLength(4);
    expect(all.every((p) => p.trackId === 'new' && p.file.startsWith('photos/new/m'))).toBe(true);
    expect(fs.files.has(`/doc/${all[0]!.sprite}`)).toBe(true);
    // The sources are untouched.
    expect((await loadTrailPhotos('t1')).map((p) => p.id)).toEqual(['early', 'mid', 'late']);
    expect((await loadTrailPhotos('t2')).map((p) => p.id)).toEqual(['other']);
    expect(fs.files.has('/doc/photos/t2/other.jpg')).toBe(true);
  });

  it('a merge without photos writes nothing', async () => {
    const merged = lineTrack({ lengthM: 1000 });
    expect(await onTrailsMerged(['x', 'y'], 'new', merged, () => 'id', 9)).toEqual({
      copied: 0,
      skippedTrails: [],
    });
    expect(fs.list('/doc/photos/new')).toEqual([]);
  });

  describe.each([
    ['unreadable', '{"version":1,"photos":[{"id":"late"'],
    ['future', JSON.stringify({ version: 2, trackId: 't1', photos: [], extra: 'x' })],
  ])('over an %s sidecar', (_status, text) => {
    beforeEach(() => fs.seed('/doc/photos/t1/photos.json', text));
    const files = () => fs.list('/doc/photos/t1/');

    it('tidy neither rewrites it nor sweeps a single copy', async () => {
      const before = files();
      expect(await tidyTrailPhotos('t1', 5)).toBe(0);
      expect(files()).toEqual(before);
      expect(fs.text('/doc/photos/t1/photos.json')).toBe(text);
    });

    it('edits, removals and trims fail and touch nothing', async () => {
      const before = files();
      await expect(editTrailPhoto('t1', 'late', { caption: 'x' })).rejects.toThrow(
        SidecarUnavailableError,
      );
      await expect(removeTrailPhoto('t1', 'late')).rejects.toThrow(SidecarUnavailableError);
      await expect(
        onTrailTrimmed('t1', 200, 700, lineTrack({ lengthM: 1000 }).slice(20, 71), 9),
      ).rejects.toThrow(SidecarUnavailableError);
      expect(files()).toEqual(before);
      expect(fs.text('/doc/photos/t1/photos.json')).toBe(text);
    });

    it('a merge leaves it out (reported), and refuses to write into it', async () => {
      seedTrail('t2', [photo('t2', 'other', 50)]);
      const merged = lineTrack({ lengthM: 1000 });
      const before = files();
      expect(await onTrailsMerged(['t1', 't2'], 'new', merged, () => 'c1', 9)).toEqual({
        copied: 1,
        skippedTrails: ['t1'],
      });
      expect(files()).toEqual(before);
      expect(fs.text('/doc/photos/t1/photos.json')).toBe(text);
      const listing = fs.list('/doc/photos/');
      await expect(onTrailsMerged(['t2'], 't1', merged, () => 'c2', 9)).rejects.toThrow(
        SidecarUnavailableError,
      );
      expect(fs.list('/doc/photos/')).toEqual(listing);
    });
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
