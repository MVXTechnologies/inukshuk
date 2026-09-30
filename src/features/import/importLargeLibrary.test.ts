/**
 * A 400-activity Strava import against the REAL library store (#465): the
 * Library must see a bounded number of commits (each one re-renders every
 * screen that reads `tracks` and rewrites library.json), and every imported
 * trail's drawable geometry must be primed from the points in hand, so
 * neither the map nor the Library's thumbnails ever parse its GPX back.
 */
import { newImportJob } from '@core/import/job';
import type { ActivitySource, RemoteActivity } from '@core/import/sources';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import type { Track } from '@core/models';
import * as storage from '@data/storage';
import { peekTrackGeometry, primeTrackGeometry } from '@data/trackGeometry';
import { useLibraryStore } from '@state/libraryStore';

import { runSourceImport } from './runSourceImport';

jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

const mockWrites: number[] = [];
jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(async () => null),
  writeIndex: jest.fn((value: unknown) => mockWrites.push(JSON.stringify(value).length)),
  writeTrackGeometryCache: jest.fn(),
  readTrackGeometryCache: jest.fn(async () => null),
  readFileText: jest.fn(async () => {
    throw new Error('no GPX should be read');
  }),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 10),
  deleteFileAt: jest.fn(),
}));

const N = 400;
const lib = largeLibrary(N, { stepSec: 30 });
const T0 = Date.parse('2025-01-01T12:00:00Z');

const listed: RemoteActivity[] = lib.tracks.map((t, i) => ({
  origin: { source: 'strava', externalId: String(1000 + i) },
  name: t.name,
  category: t.category,
  startedAt: T0 + i * 86_400_000,
  distanceM: t.stats.distanceM,
  hasRoute: true,
}));

const source: ActivitySource = {
  id: 'strava',
  list: async () => listed,
  fetchRoute: async (a: RemoteActivity) => {
    const i = Number(a.origin.externalId) - 1000;
    return { points: lib.points(i), segmentStarts: lib.segmentStarts(i) };
  },
} as unknown as ActivitySource;

beforeAll(async () => {
  await useLibraryStore.getState().hydrate();
});

it('commits a 400-activity import in bounded batches, geometry primed', async () => {
  mockWrites.length = 0;
  let commits = 0;
  const unsubscribe = useLibraryStore.subscribe((s, prev) => {
    if (s.tracks !== prev.tracks) commits++;
  });
  const saved: Track[] = [];
  const job = await runSourceImport(
    newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 0 }),
    {
      source,
      libraryTracks: () => useLibraryStore.getState().tracks,
      addTracks: (items) => useLibraryStore.getState().addTracks(items),
      writeGpx: (id) => `file:///doc/tracks/${id}.gpx`,
      onTrackSaved: (track, points, segmentStarts) => {
        saved.push(track);
        primeTrackGeometry(track, points, segmentStarts);
      },
      newId: storage.newId,
      now: () => 0,
      yieldToUi: async () => undefined,
      onUpdate: () => undefined,
    },
    new AbortController().signal,
    { listed, interruption: () => 'stop' },
  );
  unsubscribe();

  expect(job.status).toBe('done');
  expect(job.imported).toBe(N);
  const tracks = useLibraryStore.getState().tracks;
  expect(tracks).toHaveLength(N);

  // One commit (and one index write) per batch of 10, not one per activity.
  expect(commits).toBeLessThanOrEqual(N / 10 + 1);
  expect(mockWrites.length).toBeLessThanOrEqual(N / 10 + 1);

  // Every saved trail is drawable without touching its GPX.
  for (const t of tracks) expect(peekTrackGeometry(t)).toBeTruthy();
  expect(storage.readFileText).not.toHaveBeenCalled();
  expect(saved).toHaveLength(N);
});

it('documents the one-by-one alternative: one full index write per trail', () => {
  // `addTrack` is the single-trail path (a recording, an "Open with"); the
  // importers must never loop it — each call rewrites the whole index.
  mockWrites.length = 0;
  const before = useLibraryStore.getState().tracks.length;
  for (let i = 0; i < 50; i++) {
    const t = lib.tracks[i]!;
    useLibraryStore
      .getState()
      .addTrack(
        { ...t, id: `solo-${i}`, status: 'finished', points: [] },
        `file:///doc/tracks/solo-${i}.gpx`,
      );
  }
  expect(useLibraryStore.getState().tracks).toHaveLength(before + 50);
  expect(mockWrites).toHaveLength(50);
  // Each write carries the whole (growing) library.
  expect(mockWrites[49]!).toBeGreaterThan(mockWrites[0]!);
});
