import { unzipSync, strFromU8 } from 'fflate';

import { buildGpx, parseGpx } from '@core/geo/gpx';
import { lineTrack, offset, T0 } from '@core/photos/__fixtures__/tracks';
import { linkedPhotos } from '@core/photos/gpxZip';
import type { TrackPhoto } from '@core/photos/model';
import { photoFilePaths } from '@core/photos/paths';
import * as storage from '@data/storage';

import { writePhotoCopies } from './photoFiles';
import { fakeFs } from './testFileSystem';
import { writeTrailPhotoZip } from './zipExport';

jest.mock('expo-file-system', () =>
  jest.requireActual<typeof import('./testFileSystem')>('./testFileSystem').createFakeFileSystem(),
);
jest.mock('@data/localServer', () => ({ copyToServed: jest.fn() }));

const fs = fakeFs();

function photo(id: string, m: number): TrackPhoto {
  writePhotoCopies('t1', id, {
    display: Buffer.from(`JPEG-${id}`).toString('base64'),
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
    expect(zip).toMatchObject({ name: 'Lac des Cygnes.zip', photos: 2 });
    const entries = unzipSync(fs.files.get(zip.uri.replace('file://', ''))!);
    expect(Object.keys(entries).sort()).toEqual([
      'Lac des Cygnes.gpx',
      'photos/a.jpg',
      'photos/b.jpg',
    ]);
    expect(strFromU8(entries['photos/a.jpg']!)).toBe('JPEG-a');
    const doc = parseGpx(strFromU8(entries['Lac des Cygnes.gpx']!));
    expect(doc.points).toHaveLength(11);
    expect(doc.waypoints.map((w) => w.name)).toEqual(['At 20 m', 'At 80 m']);
    expect(linkedPhotos(doc, Object.keys(entries)).map((l) => l.entryName)).toEqual([
      'photos/a.jpg',
      'photos/b.jpg',
    ]);
  });

  it('skips a copy deleted since planning', async () => {
    const photos = [photo('a', 20), photo('gone', 50)];
    fs.files.delete('/doc/photos/t1/gone.jpg');
    const zip = await writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos });
    expect(zip.photos).toBe(1);
  });

  it('leaves no half-written archive when it fails', async () => {
    const photos = [photo('a', 20)];
    jest.spyOn(storage, 'readFileChunks').mockImplementationOnce(() => {
      throw new Error('read failed');
    });
    await expect(
      writeTrailPhotoZip({ trackName: 'T', gpxUri: 'tracks/t1.gpx', photos }),
    ).rejects.toThrow('read failed');
    expect(fs.list('/cache/exports')).toEqual([]);
  });
});
