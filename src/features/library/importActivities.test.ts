import { gzipSync, strToU8, zipSync } from 'fflate';

import { GPX, T0, TCX, fitBytes } from '@core/geo/activityFiles/testFixtures';
import { memoryByteSource } from '@core/geo/geopdf/pdfReader';
import { parseGpx } from '@core/geo/gpx';
import type { TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import * as DocumentPicker from 'expo-document-picker';

import {
  activityImportMessage,
  importActivitiesFromUri,
  openImportedUri,
  pickAndImportActivityFiles,
} from './importActivities';

const files = new Map<string, Uint8Array>();
const written = new Map<string, string>();
let ids = 0;

jest.mock('@data/storage', () => ({
  newId: jest.fn(),
  readFileHead: jest.fn(),
  withFileByteSource: jest.fn(),
  readFileBytes: jest.fn(),
  fileSizeAt: jest.fn(),
  writeTrackGpx: jest.fn(),
  createImportSpillWriter: jest.fn(),
  copyToImportCache: jest.fn(),
  deleteFileAt: jest.fn(),
  isCacheUri: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const lookup = (uri: string): Uint8Array => {
  const bytes = files.get(uri);
  if (!bytes) throw new Error(`ENOENT ${uri}`);
  return bytes;
};

beforeEach(() => {
  files.clear();
  written.clear();
  ids = 0;
  const s = jest.mocked(storage);
  s.newId.mockImplementation(() => `id${++ids}`);
  s.withFileByteSource.mockImplementation((uri, fn) => fn(memoryByteSource(lookup(uri))));
  s.readFileHead.mockImplementation((uri, n) => lookup(uri).slice(0, n));
  s.readFileBytes.mockImplementation(async (uri) => lookup(uri));
  s.fileSizeAt.mockImplementation((uri) => files.get(uri)?.length ?? 0);
  s.writeTrackGpx.mockImplementation((id, text) => {
    written.set(id, text);
    return `file:///doc/tracks/${id}.gpx`;
  });
  s.createImportSpillWriter.mockImplementation((name) => {
    const chunks: number[] = [];
    const uri = `file:///cache/imports/${name}`;
    return {
      uri,
      write: (c: Uint8Array) => void chunks.push(...c),
      close: () => void files.set(uri, Uint8Array.from(chunks)),
    };
  });
  s.deleteFileAt.mockImplementation((uri) => void files.delete(uri));
  s.isCacheUri.mockImplementation((uri) => uri.startsWith('file:///cache/'));
  s.copyToImportCache.mockImplementation(async (uri, name) => {
    const dest = `file:///cache/imports/${name}`;
    files.set(dest, lookup(uri));
    return dest;
  });
});

function pick(...assets: { uri: string; name: string; bytes: Uint8Array }[]) {
  for (const a of assets) files.set(a.uri, a.bytes);
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
    canceled: false,
    assets: assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: undefined })),
  } as unknown as DocumentPicker.DocumentPickerResult);
}

const summaryAt = (startedAt: number, distanceM: number): TrackSummary =>
  ({ id: 'old', name: 'Old', startedAt, stats: { distanceM }, fileUri: 'x' }) as TrackSummary;

describe('pickAndImportActivityFiles', () => {
  it('imports loose FIT, TCX and gzipped GPX files as GPX tracks', async () => {
    pick(
      { uri: 'file:///cache/p/run.fit', name: 'run.fit', bytes: fitBytes(1) },
      { uri: 'file:///picked/ride.tcx', name: 'ride.tcx', bytes: strToU8(TCX) },
      { uri: 'file:///cache/p/x.gpx.gz', name: 'x.gpx.gz', bytes: gzipSync(strToU8(GPX)) },
    );
    const res = await pickAndImportActivityFiles([]);
    if (res.kind !== 'imported') throw new Error(res.kind);
    // FIT and TCX start at the same second but differ in distance; GPX == FIT.
    expect(res.items.map((i) => [i.track.name, i.track.category])).toEqual([
      [expect.stringMatching(/^Run \d{4}-\d\d-\d\d$/), 'run'],
      [expect.stringMatching(/^Ride /), 'bike'],
    ]);
    expect(res.duplicates).toBe(1);
    expect(res.failed).toBe(0);
    // Stored as GPX with the points; the returned track releases them.
    expect(parseGpx(written.get('id1')!).points).toHaveLength(2);
    expect(res.items[0]!.track.points).toEqual([]);
    expect(res.items[0]!.track.stats.pointCount).toBe(2);
    // Picker cache copies are cleaned up; other uris are left alone.
    expect(files.has('file:///cache/p/run.fit')).toBe(false);
    expect(files.has('file:///picked/ride.tcx')).toBe(true);
  });

  it('imports a Strava archive, skipping what the library already has', async () => {
    const csv = 'Activity Name,Activity Type,Filename\nLunch Run,Trail Run,activities/1.fit.gz\n';
    const zip = zipSync({
      'activities.csv': strToU8(csv),
      'activities/1.fit.gz': gzipSync(fitBytes(1)),
      'activities/2.gpx': strToU8(GPX.replace('46.801', '46.9')),
      'activities/3.fit': strToU8('broken'),
      'DI_CONNECT/Uploaded/UploadedFiles_0.zip': zipSync({ 'g.fit': fitBytes(17) }),
    });
    pick({ uri: 'file:///cache/p/export.zip', name: 'export_1.zip', bytes: zip });
    const progress = jest.fn();
    const existing = [summaryAt(T0 + 5_000, 11_000_000)]; // same start, far longer: not a dup
    const res = await pickAndImportActivityFiles(existing, progress);
    if (res.kind !== 'imported') throw new Error(res.kind);
    expect(res.items.map((i) => [i.track.name, i.track.category])).toEqual([
      ['Lunch Run', 'trail-run'],
      ['Morning Run', 'run'],
    ]);
    // The Garmin copy of the Strava FIT (same start + distance) is a duplicate.
    expect(res.duplicates).toBe(1);
    expect(res.failed).toBe(1);
    expect(progress).toHaveBeenCalled();
    // Nested spill and picker copy are gone.
    expect([...files.keys()]).toEqual([]);
    expect(activityImportMessage(res)).toBe('Imported 2 trails · 1 duplicate skipped · 1 failed');
  });

  it('counts unreadable and oversized files as failed', async () => {
    pick(
      { uri: 'file:///p/photo.jpg', name: 'photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0]) },
      { uri: 'file:///p/bad.zip', name: 'bad.zip', bytes: strToU8('PK\u0003\u0004 truncated') },
      { uri: 'file:///p/huge.fit', name: 'huge.fit', bytes: fitBytes() },
    );
    jest
      .mocked(storage.fileSizeAt)
      .mockImplementation((uri) => (uri === 'file:///p/huge.fit' ? 1e12 : 10));
    const res = await pickAndImportActivityFiles([]);
    expect(res).toMatchObject({ kind: 'imported', items: [], failed: 3 });
  });

  it('marks untimed routes as navigation and reports cancel / picker errors', async () => {
    const route = `<gpx><rte><rtept lat="45" lon="-73"/><rtept lat="45.01" lon="-73"/></rte></gpx>`;
    pick({ uri: 'file:///p/r.gpx', name: 'r.gpx', bytes: strToU8(route) });
    const res = await pickAndImportActivityFiles([summaryAt(0, 0)]);
    if (res.kind !== 'imported') throw new Error(res.kind);
    expect(res.items[0]!.track).toMatchObject({ name: 'r', category: 'navigation' });

    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: true,
      assets: null,
    } as unknown as DocumentPicker.DocumentPickerResult);
    expect(await pickAndImportActivityFiles([])).toEqual({ kind: 'canceled' });
    jest.mocked(DocumentPicker.getDocumentAsync).mockRejectedValue(new Error('boom'));
    expect(await pickAndImportActivityFiles([])).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('opened uris', () => {
  it('sniffs in place, or through a cache copy when random access fails', async () => {
    files.set('content://x/1', fitBytes());
    const inPlace = await openImportedUri('content://x/1');
    expect(inPlace).toMatchObject({ uri: 'content://x/1', format: 'fit' });
    inPlace.dispose();

    jest.mocked(storage.readFileHead).mockImplementationOnce(() => {
      throw new Error('SAF');
    });
    const copied = await openImportedUri('content://x/1');
    expect(copied.uri).toMatch(/^file:\/\/\/cache\/imports\//);
    expect(copied.format).toBe('fit');
    copied.dispose();
    expect(files.has(copied.uri)).toBe(false);

    const unreadable = await openImportedUri('content://missing');
    expect(unreadable.format).toBe('unknown');

    jest
      .mocked(storage.readFileHead)
      .mockImplementationOnce(() => {
        throw new Error('SAF');
      })
      .mockImplementationOnce(() => {
        throw new Error('still');
      });
    const neither = await openImportedUri('content://x/1');
    expect(neither).toMatchObject({ uri: 'content://x/1', format: 'unknown' });
  });

  it('imports every activity in an opened archive', async () => {
    files.set('file:///a.zip', zipSync({ 'a.fit': fitBytes(1), 'b.tcx': strToU8(TCX) }));
    const res = await importActivitiesFromUri('file:///a.zip', 'Imported activity', []);
    expect(res.items).toHaveLength(2);
    expect(
      activityImportMessage({ ...res, items: res.items.slice(0, 1), limitReached: true }),
    ).toBe('Imported 1 trail · stopped at the size limit');
  });
});
