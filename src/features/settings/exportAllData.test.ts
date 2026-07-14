import type { ArchivePlan } from '@core/export/archivePlan';
import * as storage from '@data/storage';
import * as Sharing from 'expo-sharing';
import { unzipSync, strFromU8 } from 'fflate';
import { exportAllData } from './exportAllData';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('@data/storage', () => ({
  createCacheFileWriter: jest.fn(),
  readIndexText: jest.fn(),
  fileExists: jest.fn(),
  readFileChunks: jest.fn(),
  fileSizeAt: jest.fn(),
  deleteFileAt: jest.fn(),
}));

const mocked = storage as jest.Mocked<typeof storage>;
const sharing = Sharing as jest.Mocked<typeof Sharing>;

const ZIP_URI = 'file:///cache/exports/inukshuk-data.zip';

/** Fake cache writer that accumulates the streamed zip bytes in memory. */
function stubWriter() {
  const chunks: Uint8Array[] = [];
  mocked.createCacheFileWriter.mockReturnValue({
    uri: ZIP_URI,
    write: (chunk: Uint8Array) => chunks.push(chunk),
    close: () => {},
  });
  return chunks;
}

function bytesOf(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const plan: ArchivePlan = {
  entries: [
    { zipPath: 'Alps/hike.gpx', sourceUri: 'file:///doc/a.gpx', kind: 'gpx', deflate: true },
    { zipPath: 'Alps/map.pdf', sourceUri: 'file:///doc/m.pdf', kind: 'map', deflate: false },
  ],
  mapCount: 1,
  trackCount: 1,
  photoCount: 0,
};

beforeEach(() => {
  sharing.isAvailableAsync.mockResolvedValue(true);
  sharing.shareAsync.mockResolvedValue(undefined);
  mocked.readIndexText.mockResolvedValue('{"schemaVersion":1}');
  mocked.fileExists.mockReturnValue(true);
  mocked.fileSizeAt.mockReturnValue(2048);
  mocked.readFileChunks.mockImplementation((uri, _size, onChunk) => {
    onChunk(new TextEncoder().encode(`bytes of ${uri}`), true);
  });
});

describe('exportAllData', () => {
  it('packs library.json plus every planned entry and reports the archive before sharing', async () => {
    const chunks = stubWriter();
    const order: string[] = [];
    sharing.shareAsync.mockImplementation(async () => {
      order.push('share');
    });

    const result = await exportAllData(
      plan,
      { schemaVersion: 1 },
      {
        onReady: (files, bytes) => order.push(`ready:${files}:${bytes}`),
      },
    );

    expect(result).toEqual({ kind: 'shared' });
    // The user is told what exists *before* the sheet opens — never after.
    expect(order).toEqual(['ready:3:2048', 'share']);

    const unzipped = unzipSync(bytesOf(chunks));
    expect(Object.keys(unzipped).sort()).toEqual(['Alps/hike.gpx', 'Alps/map.pdf', 'library.json']);
    expect(strFromU8(unzipped['library.json']!)).toBe('{"schemaVersion":1}');
  });

  it('never claims success — a dismissed share sheet resolves to `shared` with no counts', async () => {
    stubWriter();
    // expo-sharing resolves the same way on completion and on dismissal.
    const result = await exportAllData(plan, {});
    expect(result).toEqual({ kind: 'shared' });
    expect(result).not.toHaveProperty('files');
  });

  it('deletes the staged zip once the sheet closes, dismissed or not', async () => {
    stubWriter();
    await exportAllData(plan, {});
    expect(mocked.deleteFileAt).toHaveBeenCalledWith(ZIP_URI);
  });

  it('deletes the staged zip when the share sheet itself throws', async () => {
    stubWriter();
    sharing.shareAsync.mockRejectedValue(new Error('activity not found'));
    const result = await exportAllData(plan, {});
    expect(result).toEqual({ kind: 'error', message: 'activity not found' });
    expect(mocked.deleteFileAt).toHaveBeenCalledWith(ZIP_URI);
  });

  it('skips sources that vanished since planning, and falls back to the in-memory index', async () => {
    const chunks = stubWriter();
    mocked.readIndexText.mockResolvedValue(null);
    mocked.fileExists.mockImplementation((uri: string) => uri.endsWith('.gpx'));

    const ready = jest.fn();
    const result = await exportAllData(plan, { schemaVersion: 2 }, { onReady: ready });

    expect(result).toEqual({ kind: 'shared' });
    expect(ready).toHaveBeenCalledWith(2, 2048); // library.json + the surviving gpx
    const unzipped = unzipSync(bytesOf(chunks));
    expect(Object.keys(unzipped).sort()).toEqual(['Alps/hike.gpx', 'library.json']);
    expect(strFromU8(unzipped['library.json']!)).toBe('{"schemaVersion":2}');
  });

  it('reports unavailable sharing without staging an archive', async () => {
    stubWriter();
    sharing.isAvailableAsync.mockResolvedValue(false);
    expect(await exportAllData(plan, {})).toEqual({ kind: 'unavailable' });
    expect(mocked.createCacheFileWriter).not.toHaveBeenCalled();
  });
});
