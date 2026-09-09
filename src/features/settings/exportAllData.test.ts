import { planDataArchive, type ArchivePlan } from '@core/export/archivePlan';
import type { TrackSummary, Waypoint } from '@core/models';
import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import * as storage from '@data/storage';
import * as Sharing from 'expo-sharing';
import { unzipSync, strFromU8 } from 'fflate';
import { exportAllData } from './exportAllData';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
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
  waypointCount: 0,
  photoCount: 0,
};

function waypoint(id: string, photoUri?: string, folderId?: string): Waypoint {
  return { id, label: id, latitude: 0, longitude: 0, createdAt: 0, photoUri, folderId };
}

function track(id: string, photoUris: string[]): TrackSummary {
  return {
    id,
    name: id,
    startedAt: 0,
    fileUri: `file:///doc/tracks/${id}.gpx`,
    stats: {
      distanceM: 0,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 0,
    },
    notes: photoUris.map((photoUri, i) => ({
      id: `${id}-n${i}`,
      distanceM: i,
      text: '',
      createdAt: 0,
      photoUri,
    })),
  };
}

/** Names of the members of the zip that `exportAllData` streamed, sorted. */
async function exportedMembers(input: Parameters<typeof planDataArchive>[0]): Promise<string[]> {
  const chunks = stubWriter();
  const result = await exportAllData(planDataArchive(input), {});
  expect(result).toEqual({ kind: 'shared' });
  return Object.keys(unzipSync(bytesOf(chunks))).sort();
}

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
    // The in-memory snapshot holds ABSOLUTE uris; the archived index must not
    // (#247) — a backup naming a container UUID that no longer exists restores
    // to nothing. The fallback goes through the same migration as a persist.
    const snapshot = {
      schemaVersion: 5,
      maps: [],
      tracks: [
        {
          id: 't1',
          name: 'Hike',
          startedAt: 1,
          stats: { pointCount: 1 },
          fileUri: 'file:///doc/tracks/t1.gpx',
        },
      ],
      folders: [],
      waypoints: [],
      customCategories: [],
      activeMapId: null,
      activeTrackIds: [],
    };
    const result = await exportAllData(plan, snapshot, { onReady: ready });

    expect(result).toEqual({ kind: 'shared' });
    expect(ready).toHaveBeenCalledWith(2, 2048); // library.json + the surviving gpx
    const unzipped = unzipSync(bytesOf(chunks));
    expect(Object.keys(unzipped).sort()).toEqual(['Alps/hike.gpx', 'library.json']);

    const archived = JSON.parse(strFromU8(unzipped['library.json']!)) as {
      schemaVersion: number;
      tracks: { fileUri: string }[];
    };
    expect(archived.schemaVersion).toBe(LIBRARY_SCHEMA_VERSION);
    expect(archived.tracks[0]?.fileUri).toBe('tracks/t1.gpx');
  });

  it('packs an index-only archive for an empty or waypoint-only library (#288)', async () => {
    const chunks = stubWriter();
    const ready = jest.fn();
    const result = await exportAllData(
      planDataArchive({ folders: [], maps: [], tracks: [], waypoints: [waypoint('w1')] }),
      {},
      { onReady: ready },
    );
    expect(result).toEqual({ kind: 'shared' });
    expect(ready).toHaveBeenCalledWith(1, 2048);
    expect(Object.keys(unzipSync(bytesOf(chunks)))).toEqual(['library.json']);
  });

  it('packs standalone waypoint photos for a waypoint-only library (#288)', async () => {
    const members = await exportedMembers({
      folders: [{ id: 'f1', name: 'Trips', createdAt: 0 }],
      maps: [],
      tracks: [],
      waypoints: [
        waypoint('w1', 'file:///doc/photos/w1.jpg', 'f1'),
        waypoint('w2', 'file:///doc/photos/w2.jpg'),
        waypoint('w3'),
      ],
    });
    expect(members).toEqual(['Trips/photos/w1.jpg', 'library.json', 'photos/w2.jpg']);
  });

  it('packs waypoint photos alongside trails and note photos in a mixed library (#288)', async () => {
    const members = await exportedMembers({
      folders: [{ id: 'f1', name: 'Alps', createdAt: 0 }],
      maps: [],
      tracks: [
        { ...track('hike', ['file:///doc/photos/n1.jpg']), folderId: 'f1' },
        track('stroll', []),
      ],
      waypoints: [
        waypoint('w-alp', 'file:///doc/photos/w-alp.jpg', 'f1'),
        waypoint('w-root', 'file:///doc/photos/w-root.jpg'),
      ],
    });
    expect(members).toEqual([
      'Alps/hike.gpx',
      'Alps/photos/n1.jpg',
      'Alps/photos/w-alp.jpg',
      'library.json',
      'photos/w-root.jpg',
      'stroll.gpx',
    ]);
  });

  it('writes a photo referenced by several waypoints and notes only once (#288)', async () => {
    const shared = 'file:///doc/photos/shared.jpg';
    const members = await exportedMembers({
      folders: [],
      maps: [],
      tracks: [track('hike', [shared, shared])],
      waypoints: [waypoint('w1', shared), waypoint('w2', shared)],
    });
    expect(members).toEqual(['hike.gpx', 'library.json', 'photos/shared.jpg']);
    // Each source file is read exactly once — no duplicate member, no wasted I/O.
    expect(mocked.readFileChunks.mock.calls.filter(([uri]) => uri === shared)).toHaveLength(1);
  });

  it('reports unavailable sharing without staging an archive', async () => {
    stubWriter();
    sharing.isAvailableAsync.mockResolvedValue(false);
    expect(await exportAllData(plan, {})).toEqual({ kind: 'unavailable' });
    expect(mocked.createCacheFileWriter).not.toHaveBeenCalled();
  });
});
