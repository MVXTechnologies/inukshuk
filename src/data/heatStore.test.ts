/**
 * The stored heatmap (#500): built once, kept up to date trail by trail,
 * written in batches, rebuilt only when it must be, and read back for the
 * map and taps without any trail geometry.
 */
import { simplifyTrack, type TrackGeometry } from '@core/geo/track/simplify';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { decodeTileRender, HEAT_STORE_VERSION } from '@core/heat/heatCodec';
import { gridTrailsNearWithin } from '@core/heat/heatGrid';
import { StoredTapIndex, TileMapper, type TileRender, type TileTap } from '@core/heat/heatTiles';
import type { TrackSummary } from '@core/models';

import { HeatStore, type HeatStoreClock } from './heatStore';
import { MemoryHeatIO } from './heatStoreMemoryIO';

jest.mock('./heatStoreFiles', () => ({ createHeatFileIO: jest.fn() }));
jest.mock('./storage', () => ({}));

const lib = largeLibrary(400, { stepSec: 10 });
const geometry = new Map<string, TrackGeometry>();
function geometryOf(t: TrackSummary): TrackGeometry | null {
  const i = Number(/trk-(\d+)/.exec(t.id)?.[1] ?? -1);
  if (i < 0) return null;
  let g = geometry.get(t.id);
  if (!g) {
    g = simplifyTrack(lib.points(i), lib.segmentStarts(i));
    geometry.set(t.id, g);
  }
  // An "edited" trail (a different revision) is the same trail moved 300 m east.
  if (t.stats.pointCount !== lib.tracks[i]!.stats.pointCount) {
    return { parts: g.parts.map((p) => p.map(([x, y]) => [x + 0.004, y] as [number, number])) };
  }
  return g;
}

/** Virtual time: waits pass instantly (or when a test advances the clock). */
function virtualClock(manual = false) {
  let now = 0;
  const timers: { at: number; resolve: () => void }[] = [];
  const clock: HeatStoreClock = {
    now: () => now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        if (!manual) {
          now += ms;
          resolve();
        } else timers.push({ at: now + ms, resolve });
      }),
    yieldToUi: () => Promise.resolve(),
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    clock,
    /** Move time forward, firing due timers in order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve();
      }
      now = target;
      await settle();
    },
  };
}

function makeStore(io: MemoryHeatIO, clock = virtualClock().clock) {
  const loads: string[] = [];
  const store = new HeatStore({
    io,
    clock,
    loadGeometry: async (t) => {
      loads.push(t.id);
      return geometryOf(t);
    },
  });
  return { store, loads };
}

const tracks = (n: number, from = 0) => lib.tracks.slice(from, from + n);

/** Every stored tile's render, decoded (revisions dropped: they record history). */
function renders(io: MemoryHeatIO): Map<string, TileRender> {
  const out = new Map<string, TileRender>();
  for (const [name, v] of [...io.files].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!name.startsWith('r_') || typeof v !== 'string') continue;
    out.set(name, decodeTileRender(v)!.render);
  }
  return out;
}

async function built(list: TrackSummary[]) {
  const io = new MemoryHeatIO();
  const { store } = makeStore(io);
  store.sync(list);
  await store.whenIdle();
  return { io, store };
}

jest.setTimeout(60_000);

describe('a cold store', () => {
  it('is built from the trails, readable without any geometry', async () => {
    const { io, store } = await built(tracks(40));
    expect(store.stats.rebuilds).toBe(1);
    expect(store.status()).toEqual({ rebuilding: false, queued: 0, stored: 40 });
    expect(store.storedTiles().size).toBeGreaterThan(0);
    expect(io.files.has('manifest.json')).toBe(true);
    const [first] = store.storedTiles().keys();
    const render = await store.readRender(first!);
    expect(render!.lines.features.length + render!.glow.features.length).toBeGreaterThan(0);
    // Cached the second time.
    const reads = io.reads;
    expect(await store.readRender(first!)).toBe(render);
    expect(io.reads).toBe(reads);
    expect(await store.readRender('1_1')).toBeNull();
  });

  it('a warm reopen reads the manifest only — no geometry, no rebuild', async () => {
    const { io } = await built(tracks(40));
    const { store, loads } = makeStore(io);
    io.reads = 0;
    store.sync(tracks(40));
    await store.whenIdle();
    expect(loads).toEqual([]);
    expect(store.stats.rebuilds).toBe(0);
    expect(store.stats.flushes).toBe(0);
    expect(io.reads).toBe(1);
    expect(store.status().stored).toBe(40);
  });
});

describe('incremental updates', () => {
  it('adding trails to a store equals building it with them', async () => {
    const full = await built(tracks(40));
    const io = new MemoryHeatIO();
    const { store, loads } = makeStore(io);
    store.sync(tracks(25));
    await store.whenIdle();
    loads.length = 0;
    store.sync(tracks(40));
    await store.whenIdle();
    // Only the new trails were walked.
    expect(loads).toEqual(tracks(15, 25).map((t) => t.id));
    expect(renders(io)).toEqual(renders(full.io));
  });

  it('only the tiles a new trail reaches are rewritten', async () => {
    const { io, store } = await built(tracks(40));
    const before = new Map(store.storedTiles());
    // A lone ride well away from the city.
    const solo: TrackSummary = { ...lib.tracks[0]!, id: 'solo' };
    const { store: s2 } = makeStore(io);
    const lone: TrackGeometry = {
      parts: [
        [
          [-70.5, 47.2],
          [-70.49, 47.2],
        ],
      ],
    };
    (s2 as unknown as { loadGeometry: unknown }).loadGeometry = async () => lone;
    s2.sync([...tracks(40), solo]);
    await s2.whenIdle();
    const after = s2.storedTiles();
    const changed = [...after].filter(([k, rev]) => before.get(k) !== rev).map(([k]) => k);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(3);
    for (const k of before.keys()) expect(after.get(k)).toBe(before.get(k));
  });

  it('removing trails reverses adding them', async () => {
    const small = await built(tracks(25));
    const { io, store } = await built(tracks(40));
    store.sync(tracks(25));
    await store.whenIdle();
    expect(renders(io)).toEqual(renders(small.io));
    expect(store.status().stored).toBe(25);
  });

  it('an edited or re-qualified trail is redone; nothing else is', async () => {
    const list = tracks(30);
    const io = new MemoryHeatIO();
    const { store } = makeStore(io);
    store.sync(list);
    await store.whenIdle();
    const edited = { ...list[3]!, stats: { ...list[3]!.stats, pointCount: 1 } };
    const next = [...list.slice(0, 3), edited, ...list.slice(4, 29)]; // and the last one dropped
    const loadsBefore = store.stats.geometryLoads;
    store.sync(next);
    await store.whenIdle();
    expect(store.stats.geometryLoads - loadsBefore).toBe(1);
    expect(renders(io)).toEqual(renders((await built(next)).io));
  });

  it('keeps a trail with nothing drawable without retrying it', async () => {
    const ghost: TrackSummary = { ...lib.tracks[0]!, id: 'ghost' };
    const { io, store, loads } = (() => {
      const io = new MemoryHeatIO();
      return { io, ...makeStore(io) };
    })();
    store.sync([ghost]);
    await store.whenIdle();
    expect(store.status().stored).toBe(1);
    expect(store.storedTiles().size).toBe(0);
    const again = makeStore(io);
    again.store.sync([ghost]);
    await again.store.whenIdle();
    expect(again.loads).toEqual([]);
    expect(loads).toEqual(['ghost']);
  });
});

describe('rebuilds', () => {
  it('a manifest of another version (or a corrupt one) starts over', async () => {
    const { io } = await built(tracks(10));
    const doc = JSON.parse(io.files.get('manifest.json') as string);
    io.files.set('manifest.json', JSON.stringify({ ...doc, v: HEAT_STORE_VERSION + 1 }));
    io.files.set('r_stale.json', 'leftover');
    const { store, loads } = makeStore(io);
    store.sync(tracks(10));
    await store.whenIdle();
    expect(store.stats.rebuilds).toBe(1);
    expect(loads).toHaveLength(10);
    expect(io.files.has('r_stale.json')).toBe(false);

    io.files.set('manifest.json', '{"v":');
    const again = makeStore(io);
    again.store.sync(tracks(10));
    await again.store.whenIdle();
    expect(again.store.stats.rebuilds).toBe(1);
  });

  it('a grid tile that lost a stored trail triggers a rebuild', async () => {
    const { io } = await built(tracks(20));
    const grids = [...io.files.keys()].filter((k) => k.startsWith('g_'));
    io.files.set(grids[0]!, new Uint8Array([1, 2, 3]));
    const { store } = makeStore(io);
    // Touch every tile: drop half the trails.
    store.sync(tracks(10));
    await store.whenIdle();
    expect(store.stats.rebuilds).toBe(1);
    expect(renders(io)).toEqual(renders((await built(tracks(10))).io));
  });

  it('a batch interrupted before its manifest is ignored, and redone', async () => {
    const { io } = await built(tracks(20));
    const { store } = makeStore(io);
    io.failWrite = /^manifest/;
    store.sync(tracks(30));
    await store.whenIdle();
    // The tiles were written, the manifest was not: the old store stands.
    const reopened = makeStore(io);
    await reopened.store.open();
    expect(reopened.store.status().stored).toBe(20);
    reopened.store.sync(tracks(30));
    await reopened.store.whenIdle();
    expect(reopened.store.stats.rebuilds).toBe(0);
    expect(renders(io)).toEqual(renders((await built(tracks(30))).io));
  });

  it('a render that disagrees with the manifest is re-derived on first read', async () => {
    const { io, store } = await built(tracks(10));
    const [tile] = store.storedTiles().keys();
    const good = io.files.get(`r_${tile}.json`) as string;
    io.files.set(`r_${tile}.json`, good.replace(/"rev":\d+/, '"rev":999'));
    const fresh = makeStore(io).store;
    await fresh.open();
    expect(await fresh.readRender(tile!)).toBeNull();
    await fresh.whenIdle();
    const repaired = await fresh.readRender(tile!);
    expect(repaired).toEqual(decodeTileRender(good)!.render);
  });
});

describe('batching', () => {
  it('a 400-trail import, one trail every 50 ms, writes a bounded number of batches', async () => {
    const io = new MemoryHeatIO();
    const time = virtualClock(true);
    const { store, loads } = makeStore(io, time.clock);
    const library: TrackSummary[] = [];
    for (const t of lib.tracks) {
      library.push(t);
      store.sync(library);
      await time.advance(50);
    }
    await time.advance(5000);
    await store.whenIdle();
    expect(loads).toHaveLength(400);
    expect(store.status().stored).toBe(400);
    // 20 s of import: one batch per ≤ 2 s or ≤ 50 trails, never one per trail.
    expect(store.stats.flushes).toBeGreaterThan(1);
    expect(store.stats.flushes).toBeLessThanOrEqual(12);
    expect(renders(io)).toEqual(renders((await built(lib.tracks)).io));
  });

  it('pausing writes the progress; a later sync finishes the job', async () => {
    const io = new MemoryHeatIO();
    const time = virtualClock(true);
    const { store } = makeStore(io, time.clock);
    store.sync(tracks(60));
    await time.advance(0);
    await store.pause();
    const done = store.status().stored;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(60);
    const reopened = makeStore(io);
    reopened.store.sync(tracks(60));
    await reopened.store.whenIdle();
    expect(reopened.loads.length).toBe(60 - done);
    expect(reopened.store.stats.rebuilds).toBe(0);
  });
});

describe('taps', () => {
  it('finds hot spots and their trails from the stored grid', async () => {
    const list = tracks(40);
    const { io, store } = await built(list);
    io.reads = 0;
    const taps = new Map<string, TileTap>();
    for (const k of store.storedTiles().keys()) taps.set(k, (await store.readTap(k))!);
    expect(io.reads).toBe(store.storedTiles().size);
    // Cached.
    await store.readTap([...taps.keys()][0]!);
    expect(io.reads).toBe(store.storedTiles().size);
    expect(await store.readTap('1_1')).toBeNull();
    const byId = new Map(list.map((t) => [t.id, t]));
    const index = new StoredTapIndex(new TileMapper(store.grid), taps, (slot) => {
      const id = store.slotTrack(slot);
      const t = id ? byId.get(id) : undefined;
      return t ? { id: t.id, categoryId: t.category ?? 'uncategorized' } : null;
    });
    const hit = gridTrailsNearWithin(index, store.grid, -71.2, 46.81, 60);
    expect(hit.hot).toBe(true);
    expect(hit.trackIds.length).toBeGreaterThan(2);
    for (const id of hit.trackIds) expect(byId.has(id)).toBe(true);
  });
});

describe('errors', () => {
  it('a failing write stops the loop without losing what was written', async () => {
    const { io } = await built(tracks(10));
    const { store } = makeStore(io);
    io.failWrite = /^g_/;
    store.sync(tracks(20));
    await store.whenIdle();
    const reopened = makeStore(io);
    reopened.store.sync(tracks(20));
    await reopened.store.whenIdle();
    expect(renders(io)).toEqual(renders((await built(tracks(20))).io));
  });
});
