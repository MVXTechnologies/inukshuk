/**
 * The connected-source importer against a fake source: planning, saving with
 * origins, route-less and duplicate skips, rate-limit pauses, stop / background
 * interruption, daily-limit and auth stops, and resume idempotence.
 */
import { newImportJob, type ImportJob } from '@core/import/job';
import {
  SourceStopError,
  type ActivityRoute,
  type ActivitySource,
  type ImportPause,
  type RemoteActivity,
} from '@core/import/sources';
import type { TrackPoint, TrackSummary } from '@core/models';

import type { ImportedTrack } from '../library/importGpx';
import { runSourceImport, type SourceImportDeps } from './runSourceImport';

const T0 = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

const remote = (id: string, over: Partial<RemoteActivity> = {}): RemoteActivity => ({
  origin: { source: 'strava', externalId: id },
  name: `Run ${id}`,
  category: 'run',
  startedAt: T0 + Number(id.replace(/\D/g, '') || 0) * DAY,
  distanceM: 0,
  hasRoute: true,
  ...over,
});

/** A ~1.1 km northward line starting at `start`. */
function route(start: number): ActivityRoute {
  const points: TrackPoint[] = [0, 1, 2].map((i) => ({
    latitude: 46.8 + i * 0.005,
    longitude: -71.2,
    altitude: 100 + i * 10,
    time: start + i * 60_000,
  }));
  return { points, segmentStarts: [] };
}

interface Harness {
  deps: SourceImportDeps;
  library: TrackSummary[];
  updates: { job: ImportJob; persist: boolean }[];
  source: ActivitySource & { list: jest.Mock; fetchRoute: jest.Mock };
}

function harness(listed: RemoteActivity[], library: TrackSummary[] = []): Harness {
  const updates: Harness['updates'] = [];
  let n = 0;
  const source = {
    id: 'strava' as const,
    list: jest.fn(async () => listed),
    fetchRoute: jest.fn(async (a: RemoteActivity) => route(a.startedAt)),
  };
  const h: Harness = {
    library,
    updates,
    source,
    deps: {
      source,
      libraryTracks: () => h.library,
      addTracks: (items: readonly ImportedTrack[]) => {
        h.library = [
          ...items.map((i) => ({
            id: i.track.id,
            name: i.track.name,
            startedAt: i.track.startedAt,
            stats: i.track.stats,
            fileUri: i.fileUri,
            ...(i.track.category ? { category: i.track.category } : {}),
            ...(i.track.origin ? { origin: i.track.origin } : {}),
          })),
          ...h.library,
        ];
      },
      writeGpx: (id) => `file:///tracks/${id}.gpx`,
      newId: () => `t${++n}`,
      now: () => 0,
      yieldToUi: async () => undefined,
      onUpdate: (job, persist) => updates.push({ job, persist }),
      flushEvery: 2,
    },
  };
  return h;
}

const start = (): ImportJob =>
  newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 5 });

const opts = { interruption: () => 'stop' as const };
const signal = () => new AbortController().signal;

it('imports new activities with their names, categories and origins', async () => {
  const h = harness([remote('1'), remote('2', { name: undefined, sportLabel: 'Trail Run' })]);
  const job = await runSourceImport(start(), h.deps, signal(), opts);

  expect(job).toMatchObject({
    status: 'done',
    listing: false,
    total: 2,
    done: 2,
    imported: 2,
    remaining: [],
  });
  expect(job.distanceM).toBeGreaterThan(2000);
  expect(job.ascentM).toBeGreaterThan(0);
  expect(job.importedTrackIds).toEqual(['t1', 't2']);
  const byId = Object.fromEntries(h.library.map((t) => [t.origin?.externalId, t]));
  expect(byId['1']).toMatchObject({ name: 'Run 1', category: 'run' });
  expect(byId['2']?.name).toMatch(/^Trail Run 2026-09-0\d$/);
  expect(byId['2']?.origin).toEqual({ source: 'strava', externalId: '2' });
  // Newest first.
  expect(h.source.fetchRoute.mock.calls.map((c) => c[0].origin.externalId)).toEqual(['2', '1']);
  // The final update is persisted.
  expect(h.updates.at(-1)).toMatchObject({ persist: true, job: { status: 'done' } });
});

it('skips route-less, already-imported and duplicate activities', async () => {
  const recordedHere: TrackSummary = {
    id: 'rec',
    name: 'Recorded here',
    startedAt: T0 + 3 * DAY,
    stats: {
      distanceM: 1112,
      ascentM: 0,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 3,
    },
    fileUri: 'file:///rec.gpx',
  };
  const imported: TrackSummary = {
    ...recordedHere,
    id: 'old',
    startedAt: 0,
    origin: { source: 'strava', externalId: '1' },
  };
  const h = harness(
    [
      remote('1'), // origin already here
      remote('2', { hasRoute: false }), // indoor
      remote('3'), // same start + distance as a recording (found after fetch)
      remote('4'),
      remote('5'),
    ],
    [recordedHere, imported],
  );
  h.source.fetchRoute.mockImplementation(async (a: RemoteActivity) =>
    a.origin.externalId === '5' ? { points: [], segmentStarts: [] } : route(a.startedAt),
  );
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({
    status: 'done',
    total: 3,
    imported: 1,
    skippedDuplicates: 2,
    noGps: 2,
    failed: 0,
  });
  expect(h.source.fetchRoute).toHaveBeenCalledTimes(3);
});

it('counts a route that fails to load and carries on', async () => {
  const h = harness([remote('1'), remote('2')]);
  h.source.fetchRoute.mockRejectedValueOnce(new Error('HTTP 500'));
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({ status: 'done', failed: 1, imported: 1, done: 2 });
});

it('counts a GPX that cannot be written as failed', async () => {
  const h = harness([remote('1')]);
  h.deps.writeGpx = () => {
    throw new Error('ENOSPC');
  };
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({ status: 'done', failed: 1, imported: 0 });
  expect(h.library).toEqual([]);
});

it('reuses the sheet’s listing instead of listing again', async () => {
  const h = harness([]);
  const job = await runSourceImport(start(), h.deps, signal(), {
    ...opts,
    listed: [remote('1')],
  });
  expect(h.source.list).not.toHaveBeenCalled();
  expect(job.imported).toBe(1);
});

it('reports a rate-limit wait while running', async () => {
  const h = harness([remote('1')]);
  h.source.fetchRoute.mockImplementation(
    async (a: RemoteActivity, _s: AbortSignal, onPause: (p: ImportPause) => void) => {
      onPause({ kind: 'rate-limit', resumeAt: 99 });
      onPause(null);
      return route(a.startedAt);
    },
  );
  await runSourceImport(start(), h.deps, signal(), opts);
  expect(
    h.updates.some((u) => u.job.pause?.kind === 'rate-limit' && u.job.status === 'running'),
  ).toBe(true);
});

it('pauses on the daily limit, then resumes without importing anything twice', async () => {
  const listed = [remote('1'), remote('2'), remote('3'), remote('4')];
  const h = harness(listed);
  let calls = 0;
  h.source.fetchRoute.mockImplementation(async (a: RemoteActivity) => {
    calls += 1;
    if (calls === 3) throw new SourceStopError('limit', 'daily-limit', 777);
    return route(a.startedAt);
  });
  const paused = await runSourceImport(start(), h.deps, signal(), opts);
  expect(paused).toMatchObject({
    status: 'paused',
    pausedReason: 'daily-limit',
    resumeAt: 777,
    total: 4,
    done: 2,
    imported: 2,
    remaining: ['2', '1'],
  });
  // Everything counted done is in the Library before the pause is persisted.
  expect(h.library).toHaveLength(2);
  expect(h.updates.at(-1)?.persist).toBe(true);

  h.source.fetchRoute.mockImplementation(async (a: RemoteActivity) => route(a.startedAt));
  const done = await runSourceImport(paused, h.deps, signal(), opts);
  expect(done).toMatchObject({ status: 'done', total: 4, done: 4, imported: 4, remaining: [] });
  expect(h.library).toHaveLength(4);
  expect(new Set(h.library.map((t) => t.origin?.externalId)).size).toBe(4);
  // The resume re-listed and only fetched what was left.
  expect(h.source.list).toHaveBeenCalledTimes(2);
  expect(h.source.fetchRoute).toHaveBeenCalledTimes(5);
});

it('resuming a job whose remaining work is already here fetches nothing', async () => {
  const h = harness([remote('1'), remote('2')]);
  const first = await runSourceImport(start(), h.deps, signal(), opts);
  const again = await runSourceImport(
    { ...first, status: 'paused', pausedReason: 'interrupted', remaining: ['1', '2'], done: 0 },
    h.deps,
    signal(),
    opts,
  );
  expect(again).toMatchObject({ status: 'done', done: 2, imported: 2 });
  expect(again.skippedDuplicates).toBe(2);
  expect(h.library).toHaveLength(2);
});

it('stops with a reconnect message when the source refuses access', async () => {
  const h = harness([remote('1')]);
  h.source.fetchRoute.mockRejectedValue(
    new SourceStopError('Strava refused access — reconnect in Settings', 'auth'),
  );
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({
    status: 'error',
    errorKind: 'auth',
    message: 'Strava refused access — reconnect in Settings',
    remaining: ['1'],
  });
});

it('fails with the listing error when listing fails', async () => {
  const h = harness([]);
  h.source.list.mockRejectedValue(new Error('could not reach Strava'));
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({ status: 'error', errorKind: 'other', listing: true });
  expect(job.message).toBe('could not reach Strava');
});

it('pauses on a daily limit hit while listing', async () => {
  const h = harness([]);
  h.source.list.mockRejectedValue(new SourceStopError('limit', 'daily-limit', 5));
  const job = await runSourceImport(start(), h.deps, signal(), opts);
  expect(job).toMatchObject({ status: 'paused', pausedReason: 'daily-limit', listing: true });
});

it('stops when aborted, keeping what was saved and what is left', async () => {
  const h = harness([remote('1'), remote('2'), remote('3')]);
  const controller = new AbortController();
  h.source.fetchRoute.mockImplementation(async (a: RemoteActivity) => {
    if (a.origin.externalId === '2') controller.abort();
    return route(a.startedAt);
  });
  const job = await runSourceImport(start(), h.deps, controller.signal, opts);
  expect(job).toMatchObject({ status: 'stopped', imported: 2, remaining: ['1'] });
  expect(h.library).toHaveLength(2);
});

it('pauses (not stops) when the app went to the background', async () => {
  const h = harness([remote('1'), remote('2')]);
  const controller = new AbortController();
  h.source.fetchRoute.mockImplementation(async (a: RemoteActivity, s: AbortSignal) => {
    controller.abort();
    if (s.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return route(a.startedAt);
  });
  const job = await runSourceImport(start(), h.deps, controller.signal, {
    interruption: () => 'background',
  });
  expect(job).toMatchObject({
    status: 'paused',
    pausedReason: 'background',
    remaining: ['2', '1'],
  });
});

it('stops before fetching when aborted while listing', async () => {
  const h = harness([remote('1')]);
  const controller = new AbortController();
  h.source.list.mockImplementation(async () => {
    controller.abort();
    return [remote('1')];
  });
  const job = await runSourceImport(start(), h.deps, controller.signal, opts);
  expect(job.status).toBe('stopped');
  expect(h.source.fetchRoute).not.toHaveBeenCalled();
});
