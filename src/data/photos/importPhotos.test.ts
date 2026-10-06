import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import { StorageFullError } from '@data/storage';

import {
  commitPhotoImport,
  defaultSelection,
  deviceZoneOffsetAt,
  preparePhotoImport,
  type PickedPhoto,
} from './importPhotos';
import type { PhotoResizer, ResizedPhoto } from './resizer';
import { readSidecar } from './sidecarStore';
import { fakeFs } from './testFileSystem';

jest.mock('expo-file-system', () =>
  jest.requireActual<typeof import('./testFileSystem')>('./testFileSystem').createFakeFileSystem(),
);
jest.mock('@data/localServer', () => ({ copyToServed: jest.fn() }));

const fs = fakeFs();
const EDT = () => -240;
const HOUR = 3_600_000;
const points = lineTrack({ lengthM: 3000 }); // 09:12 → 10:02 EDT, 1 m/s

/** EXIF of a photo taken at `m` metres along the walk (local EDT wall time, Android-style). */
function exifAt(m: number, opts: { gps?: boolean; skewMs?: number } = {}): Record<string, unknown> {
  const local = new Date(T0 + m * 1000 + (opts.skewMs ?? 0) - 4 * HOUR);
  const pad = (n: number) => String(n).padStart(2, '0');
  const exif: Record<string, unknown> = {
    DateTimeOriginal: `${local.getUTCFullYear()}:${pad(local.getUTCMonth() + 1)}:${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`,
  };
  if (opts.gps !== false) {
    const [lng, lat] = offset(m, 6);
    exif['GPSLatitude'] = lat;
    exif['GPSLongitude'] = lng;
  }
  return exif;
}

const picks: PickedPhoto[] = [
  { uri: 'file:///cache/a.jpg', assetId: 'A', exif: exifAt(500), width: 4000, height: 3000 },
  { uri: 'file:///cache/b.jpg', assetId: 'B', exif: exifAt(1500), width: 4000, height: 3000 },
  { uri: 'file:///cache/c.jpg', assetId: 'C', exif: exifAt(2500), width: 4000, height: 3000 },
  // An edited copy: no time, GPS only.
  {
    uri: 'file:///cache/d.jpg',
    assetId: 'D',
    exif: { GPSLatitude: offset(1000, 9)[1], GPSLongitude: offset(1000, 9)[0] },
  },
  // Taken the next day.
  { uri: 'file:///cache/e.jpg', assetId: 'E', exif: exifAt(800 + 24 * 3600, { gps: false }) },
];

function fakeResizer(fail: Record<string, Error> = {}): PhotoResizer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resize: async (uri: string): Promise<ResizedPhoto> => {
      calls.push(uri);
      const err = fail[uri];
      if (err) throw err;
      const o = (s: string, w: number, h: number) => ({
        base64: Buffer.from(s).toString('base64'),
        width: w,
        height: h,
      });
      return {
        display: o(`display:${uri}`, 2048, 1536),
        thumb: o('thumb', 240, 240),
        sprite: o('sprite', 132, 132),
        sourceWidth: 4000,
        sourceHeight: 3000,
        decodeMs: 1,
        encodeMs: 1,
        totalMs: 2,
      };
    },
  };
}

let ids = 0;
const newId = () => `p${++ids}`;

beforeEach(() => {
  fs.reset();
  ids = 0;
});

describe('preparePhotoImport', () => {
  it('reads EXIF in the device zone, checks the clock and groups the picks', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks,
      zoneOffsetAt: EDT,
    });
    expect(prepared.plan.clock.status).toBe('ok');
    expect(prepared.plan.byTime.map((p) => p.candidate.key)).toEqual([
      'pick-0',
      'pick-1',
      'pick-2',
    ]);
    expect(prepared.plan.byGps.map((p) => p.candidate.key)).toEqual(['pick-3']);
    expect(prepared.plan.outside.map((p) => p.candidate.key)).toEqual(['pick-4']);
    expect([...defaultSelection(prepared)].sort()).toEqual([
      'pick-0',
      'pick-1',
      'pick-2',
      'pick-3',
    ]);
    expect(prepared.items.get('pick-0')).toMatchObject({
      takenAtSource: 'exif-local',
      sourceKey: 'asset:A',
      duplicate: false,
    });
    const b = prepared.plan.byTime[1]!.result;
    expect(b.kind === 'time' && b.position.distanceM).toBeCloseTo(1500, 0);
  });

  it('catches a camera on the wrong time zone', async () => {
    const skewed = picks
      .slice(0, 3)
      .map((p, i) => ({ ...p, exif: exifAt([500, 1500, 2500][i]!, { skewMs: -HOUR }) }));
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: skewed,
      zoneOffsetAt: EDT,
    });
    expect(prepared.plan.clock).toMatchObject({ status: 'corrected', offsetMs: HOUR });
    expect(prepared.plan.byTime).toHaveLength(3);
  });

  it('honours a manual Adjust offset', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 1),
      zoneOffsetAt: EDT,
      manualClockOffsetMs: 60_000,
    });
    expect(prepared.plan.clock).toMatchObject({ status: 'corrected', offsetMs: 60_000 });
  });

  it('uses the device zone by default', async () => {
    expect(deviceZoneOffsetAt(T0)).toBe(-new Date(T0).getTimezoneOffset());
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: [{ uri: 'x', exif: null }],
    });
    expect(prepared.plan.outside).toHaveLength(1);
  });
});

describe('commitPhotoImport', () => {
  it('copies the kept photos, writes the sidecar and reports progress', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks,
      zoneOffsetAt: EDT,
    });
    const progress: number[] = [];
    const resizer = fakeResizer();
    const r = await commitPhotoImport({
      prepared,
      selected: defaultSelection(prepared),
      resizer,
      newId,
      now: () => 77,
      flushEvery: 2,
      author: { id: 'u', name: 'Marc' },
      onProgress: (p) => progress.push(p.done),
    });
    expect(r.failed).toEqual([]);
    expect(r.added.map((p) => p.placement)).toEqual(['time', 'time', 'time', 'gps']);
    expect(progress).toEqual([0, 1, 2, 3, 4]);
    const { sidecar } = await readSidecar('t1');
    expect(sidecar.photos.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    const first = sidecar.photos[0]!;
    expect(first).toMatchObject({
      trackId: 't1',
      placement: 'time',
      takenAtSource: 'exif-local',
      sourceKey: 'asset:A',
      width: 2048,
      height: 1536,
      author: { id: 'u', name: 'Marc' },
      createdAt: 77,
    });
    expect(first.distanceM).toBeCloseTo(500, 0);
    expect(first.exifLngLat).toBeDefined();
    expect(first.contentHash).toMatch(/^md5:/);
    expect(fs.text('/doc/photos/t1/p1.jpg')).toBe('display:file:///cache/a.jpg');
    // The GPS-only photo has no time.
    expect(sidecar.photos[3]).not.toHaveProperty('takenAt');
  });

  it('skips photos already on the trail when picked again', async () => {
    const first = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 2),
      zoneOffsetAt: EDT,
    });
    await commitPhotoImport({
      prepared: first,
      selected: defaultSelection(first),
      resizer: fakeResizer(),
      newId,
    });
    const again = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 3),
      zoneOffsetAt: EDT,
    });
    expect(again.duplicates).toBe(2);
    expect(again.plan.byTime.map((p) => p.candidate.key)).toEqual(['pick-2']);
  });

  it('places a ticked outsider at the cursor and records the clock correction', async () => {
    const skewed = [
      ...picks
        .slice(0, 3)
        .map((p, i) => ({ ...p, exif: exifAt([500, 1500, 2500][i]!, { skewMs: -HOUR }) })),
      picks[4]!,
    ];
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: skewed,
      zoneOffsetAt: EDT,
    });
    const r = await commitPhotoImport({
      prepared,
      selected: new Set(['pick-0', 'pick-3']),
      resizer: fakeResizer(),
      newId,
      fallbackDistanceM: 1234,
    });
    expect(r.added[0]).toMatchObject({ placement: 'time', clockOffsetMs: HOUR });
    expect(r.added[1]).toMatchObject({ placement: 'manual' });
    expect(r.added[1]!.distanceM).toBeCloseTo(1234, 0);
    expect(r.added[1]!.takenAt).toBeDefined();
  });

  it('keeps going past a photo that fails, and reports it', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 3),
      zoneOffsetAt: EDT,
    });
    const r = await commitPhotoImport({
      prepared,
      selected: defaultSelection(prepared),
      resizer: fakeResizer({ 'file:///cache/b.jpg': new Error('could not decode the image') }),
      newId,
    });
    expect(r.added).toHaveLength(2);
    expect(r.failed).toEqual([{ key: 'pick-1', message: 'could not decode the image' }]);
  });

  it('stops on cancel, keeping what was done', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 3),
      zoneOffsetAt: EDT,
    });
    let n = 0;
    const r = await commitPhotoImport({
      prepared,
      selected: defaultSelection(prepared),
      resizer: fakeResizer(),
      newId,
      isCancelled: () => ++n > 1,
    });
    expect(r.stopped).toBe('cancelled');
    expect((await readSidecar('t1')).sidecar.photos).toHaveLength(1);
  });

  it('refuses up front when the disk is full, and stops when it fills mid-way', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 3),
      zoneOffsetAt: EDT,
    });
    fs.freeBytes = 1000;
    await expect(
      commitPhotoImport({
        prepared,
        selected: defaultSelection(prepared),
        resizer: fakeResizer(),
        newId,
      }),
    ).rejects.toThrow(StorageFullError);
    fs.freeBytes = null;
    fs.failWrite = { match: /p2\.jpg\.tmp$/, message: 'No space left on device' };
    const r = await commitPhotoImport({
      prepared,
      selected: defaultSelection(prepared),
      resizer: fakeResizer(),
      newId,
    });
    expect(r.stopped).toBe('storage-full');
    expect(r.added.map((p) => p.id)).toEqual(['p1']);
    expect(fs.list('/doc/photos/t1/p2')).toEqual([]);
  });

  it('removes the copies of a batch the sidecar could not record', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 1),
      zoneOffsetAt: EDT,
    });
    fs.failWrite = { match: /photos\.json\.tmp$/, message: 'disk error' };
    await expect(
      commitPhotoImport({
        prepared,
        selected: defaultSelection(prepared),
        resizer: fakeResizer(),
        newId,
      }),
    ).rejects.toThrow('disk error');
    expect(fs.list('/doc/photos/t1/p1')).toEqual([]);
  });

  it('keeps the stripped original with "Full size", falling back for non-JPEG', async () => {
    fs.seed('/cache/a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    fs.seed('/cache/b.jpg', 'not a jpeg');
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks.slice(0, 2),
      zoneOffsetAt: EDT,
    });
    const r = await commitPhotoImport({
      prepared,
      selected: defaultSelection(prepared),
      resizer: fakeResizer(),
      newId,
      fullSize: true,
    });
    expect(r.added[0]).toMatchObject({ width: 4000, height: 3000 });
    expect([...fs.files.get('/doc/photos/t1/p1.jpg')!]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(r.added[1]).toMatchObject({ width: 2048, height: 1536 });
  });

  it('does nothing with an empty selection', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points,
      picked: picks,
      zoneOffsetAt: EDT,
    });
    expect(
      await commitPhotoImport({ prepared, selected: new Set(), resizer: fakeResizer(), newId }),
    ).toEqual({ added: [], failed: [] });
  });

  it('reports a pick it cannot place', async () => {
    const prepared = await preparePhotoImport({
      trackId: 't1',
      points: [],
      picked: [{ uri: 'x', exif: null }],
      zoneOffsetAt: EDT,
    });
    const r = await commitPhotoImport({
      prepared,
      selected: new Set(['pick-0']),
      resizer: fakeResizer(),
      newId,
    });
    expect(r.failed).toEqual([{ key: 'pick-0', message: 'could not place the photo' }]);
  });
});
