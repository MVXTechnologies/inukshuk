import type { TrackSummary } from '@core/models';
import { straightTrack, summary } from '@core/stats/testTracks';
import { EFFORT_DISTANCES_M, TRAIL_STATS_VERSION } from '@core/stats/trailSummary';

import { BATCH, TrailStatsStore, type LoadedPoints, type TrailStatsIO } from './trailStatsStore';

jest.mock('./storage', () => ({}));

const i1k = EFFORT_DISTANCES_M.indexOf(1000);

function memoryIO(initial: string | null = null): TrailStatsIO & { text: string | null } {
  const io = {
    text: initial,
    read: async () => io.text,
    write: (t: string) => {
      io.text = t;
    },
  };
  return io;
}

/** 2 km at 5 m/s for every trail, so each has a 1 km best of 200 s. */
const points = (): LoadedPoints => ({
  points: straightTrack({ n: 201, stepM: 10, stepS: 2 }),
  segmentStarts: [],
});

function makeStore(
  io: TrailStatsIO,
  load = jest.fn(async (_t: TrackSummary): Promise<LoadedPoints | null> => points()),
) {
  const store = new TrailStatsStore({
    io,
    loadPoints: load,
    clock: { yieldToUi: () => Promise.resolve() },
    primeFlushMs: 5,
  });
  return { store, load };
}

const library = (n: number) =>
  Array.from({ length: n }, (_, k) => summary({ startedAt: Date.UTC(2026, 0, 1) + k * 1e6 }));

describe('TrailStatsStore', () => {
  it('backfills every performed trail, in batches, and persists them', async () => {
    const io = memoryIO();
    const writes = jest.spyOn(io, 'write');
    const { store, load } = makeStore(io);
    const tracks = library(BATCH * 2 + 3);
    const nav = summary({ startedAt: 0, category: 'navigation' });
    const progress: number[] = [];
    store.subscribe(() => progress.push(store.progress().done));
    store.sync([...tracks, nav]);
    await store.whenIdle();

    expect(load).toHaveBeenCalledTimes(tracks.length);
    expect(store.summaries().size).toBe(tracks.length);
    expect(store.summaries().get(tracks[0]!.id)!.bestDistanceS[i1k]).toBeCloseTo(200, 0);
    expect(store.progress()).toEqual({ done: tracks.length, total: tracks.length, running: false });
    // Two full batches plus the tail.
    expect(writes).toHaveBeenCalledTimes(3);
    expect(Math.max(...progress)).toBe(tracks.length);
    const file = JSON.parse(io.text!);
    expect(file.v).toBe(TRAIL_STATS_VERSION);
    expect(Object.keys(file.entries)).toHaveLength(tracks.length);
  });

  it('reopens from the file without loading any GPX', async () => {
    const io = memoryIO();
    const tracks = library(4);
    const first = makeStore(io);
    first.store.sync(tracks);
    await first.store.whenIdle();

    const second = makeStore(io);
    second.store.sync(tracks);
    await second.store.whenIdle();
    expect(second.load).not.toHaveBeenCalled();
    expect(second.store.summaries().size).toBe(4);
    expect(second.store.progress()).toEqual({ done: 4, total: 4, running: false });
  });

  it('recomputes an edited trail and drops a deleted one', async () => {
    const io = memoryIO();
    const tracks = library(3);
    const { store, load } = makeStore(io);
    store.sync(tracks);
    await store.whenIdle();
    load.mockClear();

    const edited = { ...tracks[0]!, stats: { ...tracks[0]!.stats, pointCount: 99 } };
    store.sync([edited, tracks[1]!]);
    await store.whenIdle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0].id).toBe(edited.id);
    expect([...store.summaries().keys()].sort()).toEqual([tracks[0]!.id, tracks[1]!.id].sort());
  });

  it('uses a primed summary instead of the GPX, and a sync that lags keeps it', async () => {
    jest.useFakeTimers();
    try {
      const io = memoryIO();
      const { store, load } = makeStore(io);
      const [a, b] = library(2);
      store.sync([a!]);
      store.prime(b!, points().points);
      // A sync with the library as it was before b landed: b must survive.
      store.sync([a!]);
      jest.useRealTimers();
      await store.whenIdle();
      expect(store.summaries().has(b!.id)).toBe(true);
      store.sync([a!, b!]);
      await store.whenIdle();
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0]![0].id).toBe(a!.id);
      // Once listed and then gone, it goes.
      store.sync([a!]);
      await store.whenIdle();
      expect(store.summaries().has(b!.id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes a primed summary after a short delay', async () => {
    const io = memoryIO();
    const { store } = makeStore(io);
    const [a] = library(1);
    store.prime(a!, points().points);
    expect(io.text).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(io.text!).entries[a!.id]).toBeDefined();
  });

  it('starts empty from a corrupt or older file, and survives a failing read or write', async () => {
    for (const text of ['{nope', JSON.stringify({ v: -1, entries: {} })]) {
      const { store, load } = makeStore(memoryIO(text));
      store.sync(library(2));
      await store.whenIdle();
      expect(load).toHaveBeenCalledTimes(2);
    }
    const broken: TrailStatsIO = {
      read: () => Promise.reject(new Error('io')),
      write: () => {
        throw new Error('ENOSPC');
      },
    };
    const { store } = makeStore(broken);
    store.sync(library(2));
    await store.whenIdle();
    expect(store.summaries().size).toBe(2);
  });

  it('skips junk entries in the file', async () => {
    const tracks = library(1);
    const io = memoryIO(
      JSON.stringify({ v: TRAIL_STATS_VERSION, entries: { [tracks[0]!.id]: { key: 'k', s: 5 } } }),
    );
    const { store, load } = makeStore(io);
    store.sync(tracks);
    await store.whenIdle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('summarises an unreadable trail as empty instead of retrying forever', async () => {
    const { store } = makeStore(
      memoryIO(),
      jest.fn(async (_t: TrackSummary): Promise<LoadedPoints | null> => null),
    );
    const tracks = library(1);
    store.sync(tracks);
    await store.whenIdle();
    expect(
      store
        .summaries()
        .get(tracks[0]!.id)!
        .bestDistanceS.every((v) => v === null),
    ).toBe(true);
  });

  it('restarts with the newest list when the library changes mid-backfill', async () => {
    const io = memoryIO();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const load = jest.fn(async (_t: TrackSummary): Promise<LoadedPoints | null> => {
      await gate;
      return points();
    });
    const { store } = makeStore(io, load);
    const tracks = library(5);
    store.sync(tracks);
    await Promise.resolve();
    store.sync(tracks.slice(0, 2));
    release();
    await store.whenIdle();
    expect([...store.summaries().keys()].sort()).toEqual(
      tracks
        .slice(0, 2)
        .map((t) => t.id)
        .sort(),
    );
  });
});
