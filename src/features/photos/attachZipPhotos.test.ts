import { zipSync } from 'fflate';

import { memoryArchiveHost } from '@core/geo/activityFiles';
import { ByteBudget } from '@core/geo/activityFiles/limits';
import type { GpxWaypoint } from '@core/geo/gpx';
import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import type { PhotoSidecar, TrackPhoto } from '@core/photos/model';
import { planZipPhotoAttach } from '@core/photos/zipImport';
import type { PhotoResizer } from '@data/photos/resizer';

import { attachZipPhotos } from './attachZipPhotos';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<object>('expo-modules-core'),
  uuid: { v4: jest.fn() },
}));
const mockStaged = new Map<string, Uint8Array>();
jest.mock('@data/storage', () => {
  class StorageFullError extends Error {}
  return {
    StorageFullError,
    createImportSpillWriter: (name: string) => {
      const uri = `file:///cache/imports/${name}`;
      const parts: Uint8Array[] = [];
      return {
        uri,
        write: (c: Uint8Array) => parts.push(c),
        close: () => mockStaged.set(uri, Buffer.concat(parts)),
      };
    },
    deleteFileAt: jest.fn((uri: string) => mockStaged.delete(uri)),
  };
});
jest.mock('@data/photos/photoFiles', () => ({
  writePhotoCopies: jest.fn((trackId: string, id: string) => ({
    paths: {
      file: `photos/${trackId}/${id}.jpg`,
      thumb: `photos/${trackId}/${id}.sq.jpg`,
      sprite: `photos/${trackId}/${id}.map.png`,
    },
    bytes: 3,
  })),
  deletePhotoFiles: jest.fn(),
}));
let mockSidecar: PhotoSidecar = { version: 1, trackId: 't1', photos: [], comments: [] };
jest.mock('@data/photos/sidecarStore', () => ({
  updateSidecar: jest.fn(async (_id: string, change: (s: PhotoSidecar) => PhotoSidecar) => {
    mockSidecar = change(mockSidecar);
    return mockSidecar;
  }),
}));

const { uuid } = jest.requireMock('expo-modules-core') as { uuid: { v4: jest.Mock } };
const storage = jest.requireMock('@data/storage') as {
  deleteFileAt: jest.Mock;
  StorageFullError: new (m: string) => Error;
};
const files = jest.requireMock('@data/photos/photoFiles') as {
  writePhotoCopies: jest.Mock;
  deletePhotoFiles: jest.Mock;
};
const sidecars = jest.requireMock('@data/photos/sidecarStore') as { updateSidecar: jest.Mock };

const points = lineTrack({ lengthM: 1000 });
const out = { base64: 'QQ==', width: 2048, height: 1536 };

function resizer(): PhotoResizer & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  return {
    seen,
    resize: jest.fn(async (uri: string) => {
      seen.push(mockStaged.get(uri)!);
      return {
        display: out,
        thumb: out,
        sprite: out,
        sourceWidth: 4000,
        sourceHeight: 3000,
        decodeMs: 1,
        encodeMs: 1,
        totalMs: 2,
      };
    }),
  };
}

const wpt = (name: string, m: number, href: string, time?: number): GpxWaypoint => {
  const [longitude, latitude] = offset(m);
  return {
    latitude,
    longitude,
    name,
    type: 'photo',
    link: { href },
    ...(time === undefined ? {} : { time }),
  };
};

function setup(waypoints: GpxWaypoint[], entries: Record<string, Uint8Array>) {
  const zip = zipSync(entries);
  const host = memoryArchiveHost(new Map([['zip', zip]]));
  const plan = planZipPhotoAttach(
    waypoints,
    Object.entries(entries).map(([name, b]) => ({ name, uncompressedSize: b.length })),
  );
  return { host, attach: plan.attach };
}

let ids = 0;
beforeEach(() => {
  ids = 0;
  mockStaged.clear();
  mockSidecar = { version: 1, trackId: 't1', photos: [], comments: [] };
  let n = 0;
  uuid.v4.mockImplementation(() => `00000000-0000-4000-8000-00000000000${n++}`);
  jest.clearAllMocks();
});

const newId = () => `p${++ids}`;

it('stages each photo under a random name, re-encodes it, places it and records it', async () => {
  const { host, attach } = setup(
    [
      wpt('Lac des Cygnes appears', 300, 'photos/a.jpg', T0 + 300_000),
      wpt('Photo 2', 700, '../../escape/b.jpg'),
      wpt('Photo 3', 800, 'photos/c.jpg'),
    ],
    {
      'photos/a.jpg': new Uint8Array([1, 2, 3]),
      'photos/c.jpg': new Uint8Array([4, 5]),
      '../../escape/b.jpg': new Uint8Array([6]),
    },
  );
  const r = resizer();
  const result = await attachZipPhotos({
    trackId: 't1',
    points,
    attach,
    zipRef: 'zip',
    host,
    budget: new ByteBudget(1e9),
    resizer: r,
    newId,
    now: () => 42,
  });
  expect(result).toEqual({ added: 3, failed: 0 });
  // Staged by uuid only (the entry names never reach a path), then deleted.
  const stagedUris = (r.resize as jest.Mock).mock.calls.map((c) => c[0] as string);
  expect(
    stagedUris.every((u) => /^file:\/\/\/cache\/imports\/0{8}-0{4}-4000-8000-0+\d\.jpg$/.test(u)),
  ).toBe(true);
  expect(mockStaged.size).toBe(0);
  expect(files.writePhotoCopies.mock.calls.map((c) => c[0])).toEqual(['t1', 't1', 't1']);
  const photos: TrackPhoto[] = mockSidecar.photos;
  const byCaption = photos.find((p) => p.caption === 'Lac des Cygnes appears')!;
  expect(byCaption).toMatchObject({ placement: 'time', takenAt: T0 + 300_000, width: 2048 });
  expect(byCaption.distanceM).toBeCloseTo(300, 0);
  // "Photo N" is not a caption; no time → placed by its position.
  const byGps = photos.filter((p) => p.caption === undefined);
  expect(byGps).toHaveLength(2);
  expect(byGps.every((p) => p.placement === 'gps')).toBe(true);
});

it('skips a photo over the per-photo cap, and stops when the import budget is spent', async () => {
  const big = new Uint8Array(50);
  const { host, attach } = setup(
    [wpt('A', 100, 'photos/a.jpg'), wpt('B', 200, 'photos/b.jpg'), wpt('C', 300, 'photos/c.jpg')],
    { 'photos/a.jpg': big, 'photos/b.jpg': new Uint8Array(10), 'photos/c.jpg': new Uint8Array(10) },
  );
  const result = await attachZipPhotos({
    trackId: 't1',
    points,
    attach,
    zipRef: 'zip',
    host,
    budget: new ByteBudget(15),
    resizer: resizer(),
    newId,
    limits: { maxPhotoBytes: 20, maxPhotos: 500 },
  });
  // a: too big (skipped); b: read (10 of 15); c: over the budget → stop.
  expect(result).toEqual({ added: 1, failed: 2 });
  expect(mockStaged.size).toBe(0);
});

it('stops on a full disk and still deletes the staged file', async () => {
  const { host, attach } = setup([wpt('A', 100, 'photos/a.jpg'), wpt('B', 200, 'photos/b.jpg')], {
    'photos/a.jpg': new Uint8Array(3),
    'photos/b.jpg': new Uint8Array(3),
  });
  files.writePhotoCopies.mockImplementationOnce(() => {
    throw new storage.StorageFullError('full');
  });
  const result = await attachZipPhotos({
    trackId: 't1',
    points,
    attach,
    zipRef: 'zip',
    host,
    budget: new ByteBudget(1e9),
    resizer: resizer(),
    newId,
  });
  expect(result).toEqual({ added: 0, failed: 1 });
  expect(mockStaged.size).toBe(0);
  expect(sidecars.updateSidecar).not.toHaveBeenCalled();
});

it('removes the copies it made when the sidecar cannot record them', async () => {
  const { host, attach } = setup([wpt('A', 100, 'photos/a.jpg')], {
    'photos/a.jpg': new Uint8Array(3),
  });
  sidecars.updateSidecar.mockRejectedValueOnce(new Error('newer version'));
  await expect(
    attachZipPhotos({
      trackId: 't1',
      points,
      attach,
      zipRef: 'zip',
      host,
      budget: new ByteBudget(1e9),
      resizer: resizer(),
      newId,
    }),
  ).rejects.toThrow('newer version');
  expect(files.deletePhotoFiles).toHaveBeenCalledTimes(1);
});

it('does nothing without photos', async () => {
  const host = memoryArchiveHost(new Map());
  await expect(
    attachZipPhotos({
      trackId: 't1',
      points,
      attach: [],
      zipRef: 'zip',
      host,
      budget: new ByteBudget(1),
      resizer: resizer(),
      newId,
    }),
  ).resolves.toEqual({ added: 0, failed: 0 });
});
