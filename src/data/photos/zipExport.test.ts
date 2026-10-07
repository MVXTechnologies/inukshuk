import { unzipSync, strFromU8 } from 'fflate';

import { buildGpx, parseGpx } from '@core/geo/gpx';
import { hasLocation, jpegWithGps, realJpeg } from '@core/photos/__fixtures__/jpegs';
import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import { linkedPhotos } from '@core/photos/gpxZip';
import type { TrackPhoto } from '@core/photos/model';
import { photoFilePaths } from '@core/photos/paths';
import * as storage from '@data/storage';

import { writePhotoCopies } from './photoFiles';
import { fakeFs } from './testUtils/testFileSystem';
import { writeTrailPhotoZip } from './zipExport';

jest.mock('expo-file-system', () =>
  jest
    .requireActual<typeof import('./testUtils/testFileSystem')>('./testUtils/testFileSystem')
    .createFakeFileSystem(),
);
jest.mock('@data/localServer', () => ({ copyToServed: jest.fn() }));

const fs = fakeFs();
const JPEGS: Record<string, Uint8Array> = {};

function photo(id: string, m: number, display: Uint8Array = realJpeg(m)): TrackPhoto {
  JPEGS[id] = display;
  writePhotoCopies('t1', id, {
    display: Buffer.from(display).toString('base64'),
    thumb: 'AA==',
    sprite: 'AA==',
  });
  return {
    id,
    trackId: 't1',
    distanceM: m,
    lngLat: offset(m),
    placement: 'time',
    takenAt: T0 + m * 1000,
    caption: `At ${m} m`,
    ...photoFilePaths('t1', id),
    width: 1,
    height: 1,
    bytes: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

const unzip = (uri: string) => unzipSync(fs.files.get(uri.replace('file://', ''))!);

beforeEach(() => {
  fs.reset();
  fs.seed(
    '/doc/tracks/t1.gpx',
    buildGpx({ points: lineTrack({ lengthM: 100 }), metadata: { name: 'Lac des Cygnes' } }),
  );
});

describe('writeTrailPhotoZip', () => {
  it('zips the GPX with photo waypoints and the copies, which the importer can pair again', async () => {
    const photos = [photo('b', 80), photo('a', 20)];
    const zip = await writeTrailPhotoZip({
      trackName: 'Lac des Cygnes',
      gpxUri: 'tracks/t1.gpx',
      photos,
    });
    expect(zip).toMatchObject({ name: 'Lac des Cygnes.zip', photos: 2, skipped: 0 });
    const entries = unzip(zip.uri);
    expect(Object.keys(entries).sort()).toEqual([
      'Lac des Cygnes.gpx',
      'photos/a.jpg',
      'photos/b.jpg',
    ]);
    // A clean copy goes out byte for byte.
    expect(Buffer.from(entries['photos/a.jpg']!).equals(Buffer.from(JPEGS['a']!))).toBe(true);
    const doc = parseGpx(strFromU8(entries['Lac des Cygnes.gpx']!));
    expect(doc.points).toHaveLength(11);
    expect(doc.waypoints.map((w) => w.name)).toEqual(['At 20 m', 'At 80 m']);
    expect(linkedPhotos(doc, Object.keys(entries)).map((l) => l.entryName)).toEqual([
      'photos/a.jpg',
      'photos/b.jpg',
    ]);
  });

  it('strips a copy that still carries GPS before it leaves the phone', async () => {
    const zip = await writeTrailPhotoZip({
      trackName: 'T',
      gpxUri: 'tracks/t1.gpx',
      photos: [photo('a', 20, jpegWithGps())],
    });
    const out = unzip(zip.uri)['photos/a.jpg']!;
    expect(hasLocation(out)).toBe(false);
    expect(out[0]).toBe(0xff);
  });

  it('leaves out a copy whose metadata cannot be checked, and its waypoint', async () => {
    const photos = [photo('a', 20), photo('odd', 50, new Uint8Array([1, 2, 3]))];
    const zip = await writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos });
    expect(zip).toMatchObject({ photos: 1, skipped: 1 });
    const entries = unzip(zip.uri);
    expect(Object.keys(entries)).not.toContain('photos/odd.jpg');
    expect(parseGpx(strFromU8(entries['T.gpx']!)).waypoints).toHaveLength(1);
  });

  it('skips a copy deleted since planning', async () => {
    const photos = [photo('a', 20), photo('gone', 50)];
    fs.files.delete('/doc/photos/t1/gone.jpg');
    const zip = await writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos });
    expect(zip).toMatchObject({ photos: 1, skipped: 1 });
  });

  it('leaves no half-written archive when it fails', async () => {
    const photos = [photo('a', 20)];
    jest
      .spyOn(storage, 'readFileBytes')
      .mockResolvedValueOnce(JPEGS['a']!)
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(
      writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos }),
    ).rejects.toThrow('read failed');
    expect(fs.list('/cache/exports')).toEqual([]);
  });

  it('refuses a copy swapped for something unreadable while zipping', async () => {
    const photos = [photo('a', 20)];
    jest
      .spyOn(storage, 'readFileBytes')
      .mockResolvedValueOnce(JPEGS['a']!)
      .mockResolvedValueOnce(new Uint8Array([9]));
    await expect(
      writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos }),
    ).rejects.toThrow('changed');
    expect(fs.list('/cache/exports')).toEqual([]);
  });
});
