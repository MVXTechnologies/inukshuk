import { planMerge } from './merge';
import {
  applyMergedView,
  emptySyncState,
  pruneTombstones,
  recordDelete,
  recordUpsert,
  replicaView,
  sanitizeSyncState,
  TOMBSTONE_RETENTION_MS,
  type SyncState,
} from './state';

describe('emptySyncState', () => {
  it('is empty and fresh each call', () => {
    expect(emptySyncState()).toEqual({ stamps: {}, tombstones: {}, outbox: [] });
    expect(emptySyncState()).not.toBe(emptySyncState());
  });
});

describe('recordUpsert', () => {
  it('stamps the item and enqueues the upsert', () => {
    const state = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    expect(state.stamps).toEqual({ 'track:a': 1_000 });
    expect(state.outbox).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 1_000, enqueuedAt: 1_000, attempts: 0 },
    ]);
  });

  it('re-editing advances the stamp even when the clock stands still', () => {
    let state = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    state = recordUpsert(state, 'track', 'a', 1_000);
    expect(state.stamps['track:a']).toBe(1_001);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({ stamp: 1_001 });
  });

  it('re-editing advances the stamp across a backwards clock step', () => {
    let state = recordUpsert(emptySyncState(), 'track', 'a', 5_000);
    state = recordUpsert(state, 'track', 'a', 2_000); // clock jumped back 3s
    expect(state.stamps['track:a']).toBe(5_001);
  });

  it('editing after a delete clears the tombstone (resurrection)', () => {
    let state = recordDelete(emptySyncState(), 'track', 'a', 1_000);
    state = recordUpsert(state, 'track', 'a', 2_000);
    expect(state.tombstones).toEqual({});
    expect(state.stamps).toEqual({ 'track:a': 2_000 });
    expect(state.outbox).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 2_000, enqueuedAt: 1_000, attempts: 0 },
    ]);
  });

  it('does not mutate its input', () => {
    const before = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    const snapshot = structuredClone(before);
    recordUpsert(before, 'track', 'a', 2_000);
    recordDelete(before, 'track', 'a', 3_000);
    applyMergedView(before, 'track', { live: {}, tombstones: {} });
    expect(before).toEqual(snapshot);
  });
});

describe('recordDelete', () => {
  it('moves the item from stamps to tombstones and enqueues the delete', () => {
    let state = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    state = recordDelete(state, 'track', 'a', 2_000);
    expect(state.stamps).toEqual({});
    expect(state.tombstones).toEqual({ 'track:a': 2_000 });
    expect(state.outbox).toEqual([
      { kind: 'track', id: 'a', op: 'delete', stamp: 2_000, enqueuedAt: 1_000, attempts: 0 },
    ]);
  });

  it('the delete outranks the edit it follows even across a backwards clock step', () => {
    let state = recordUpsert(emptySyncState(), 'track', 'a', 5_000);
    state = recordDelete(state, 'track', 'a', 1_000); // clock jumped back
    expect(state.tombstones['track:a']).toBe(5_001);
  });

  it('deleting an unknown item still tombstones it (other devices may have it)', () => {
    const state = recordDelete(emptySyncState(), 'photo', 'p', 1_000);
    expect(state.tombstones).toEqual({ 'photo:p': 1_000 });
    expect(state.outbox[0]).toMatchObject({ kind: 'photo', id: 'p', op: 'delete' });
  });
});

describe('replicaView / applyMergedView', () => {
  const populated = (): SyncState => {
    let s = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    s = recordUpsert(s, 'photo', 'p', 1_100);
    s = recordUpsert(s, 'libraryMeta', 'library', 1_200);
    s = recordDelete(s, 'track', 'b', 1_300);
    return s;
  };

  it('replicaView extracts only the requested kind, keyed by bare id', () => {
    expect(replicaView(populated(), 'track')).toEqual({
      live: { a: 1_000 },
      tombstones: { b: 1_300 },
    });
    expect(replicaView(populated(), 'photo')).toEqual({ live: { p: 1_100 }, tombstones: {} });
  });

  it('applyMergedView replaces one kind wholesale and leaves other kinds alone', () => {
    const state = applyMergedView(populated(), 'track', {
      live: { a: 9_000, c: 4_000 },
      tombstones: { d: 5_000 },
    });
    expect(replicaView(state, 'track')).toEqual({
      live: { a: 9_000, c: 4_000 },
      tombstones: { d: 5_000 },
    });
    expect(state.stamps['photo:p']).toBe(1_100);
    expect(state.stamps['libraryMeta:library']).toBe(1_200);
    expect(state.outbox).toEqual(populated().outbox); // outbox untouched
  });

  it('round-trips through planMerge: adopting the converged view is stable', () => {
    const local = populated();
    const remote = { live: { a: 2_000, z: 500 }, tombstones: {} };
    const plan = planMerge(replicaView(local, 'track'), remote);
    const next = applyMergedView(local, 'track', plan.merged);
    // Merging again against the same remote-side view plans nothing new.
    expect(planMerge(replicaView(next, 'track'), plan.merged)).toEqual({
      applyRemote: [],
      deleteLocal: [],
      pushLocal: [],
      pushDelete: [],
      merged: plan.merged,
    });
  });
});

describe('pruneTombstones', () => {
  const now = 10_000_000_000;

  it('drops tombstones past the retention window, keeps fresh ones', () => {
    let state = recordDelete(emptySyncState(), 'track', 'old', now - TOMBSTONE_RETENTION_MS - 1);
    state = recordDelete(state, 'track', 'fresh', now - 1_000);
    const pruned = pruneTombstones(state, now);
    expect(Object.keys(pruned.tombstones)).toEqual(['track:fresh']);
    expect(pruned.outbox).toEqual(state.outbox); // pending pushes unaffected
  });

  it('keeps a tombstone exactly at the cutoff', () => {
    const state = recordDelete(emptySyncState(), 'track', 'edge', now - TOMBSTONE_RETENTION_MS);
    expect(pruneTombstones(state, now).tombstones).toEqual(state.tombstones);
  });

  it('honours a custom retention and returns the same object when nothing prunes', () => {
    const state = recordDelete(emptySyncState(), 'track', 'a', now - 5_000);
    expect(pruneTombstones(state, now, 1_000).tombstones).toEqual({});
    expect(pruneTombstones(state, now)).toBe(state);
  });
});

describe('sanitizeSyncState', () => {
  it('round-trips a valid state (including a populated outbox)', () => {
    let state = recordUpsert(emptySyncState(), 'track', 'a', 1_000);
    state = recordDelete(state, 'photo', 'p', 2_000);
    expect(sanitizeSyncState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([null, undefined, 42, 'junk', [], true])('yields the empty state for %p', (raw) => {
    expect(sanitizeSyncState(raw)).toEqual(emptySyncState());
  });

  it('drops malformed keys and junk stamps', () => {
    const state = sanitizeSyncState({
      stamps: {
        'track:a': 1_000,
        'map:x': 1_000, // unknown kind
        'track:': 1_000, // empty id
        noSeparator: 1_000,
        'track:nan': NaN,
        'track:neg': -5,
        'track:str': '1000',
      },
      tombstones: { 'photo:p': 2_000, 'photo:bad': Infinity },
      outbox: [],
    });
    expect(state.stamps).toEqual({ 'track:a': 1_000 });
    expect(state.tombstones).toEqual({ 'photo:p': 2_000 });
  });

  it('drops malformed outbox entries and defaults their bookkeeping fields', () => {
    const state = sanitizeSyncState({
      stamps: {},
      tombstones: {},
      outbox: [
        { kind: 'track', id: 'a', op: 'upsert', stamp: 100, enqueuedAt: 50, attempts: 2 },
        { kind: 'track', id: 'b', op: 'delete', stamp: 200 }, // missing bookkeeping → defaults
        { kind: 'map', id: 'x', op: 'upsert', stamp: 100 }, // unknown kind
        { kind: 'track', id: '', op: 'upsert', stamp: 100 }, // empty id
        { kind: 'track', id: 'c', op: 'purge', stamp: 100 }, // unknown op
        { kind: 'track', id: 'd', op: 'upsert', stamp: 0 }, // junk stamp
        { kind: 'track', id: 'e', op: 'upsert', stamp: 100, attempts: -3, enqueuedAt: NaN },
        'junk',
        null,
      ],
    });
    expect(state.outbox).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 100, enqueuedAt: 50, attempts: 2 },
      { kind: 'track', id: 'b', op: 'delete', stamp: 200, enqueuedAt: 0, attempts: 0 },
      { kind: 'track', id: 'e', op: 'upsert', stamp: 100, enqueuedAt: 0, attempts: 0 },
    ]);
  });

  it('enforces one outbox entry per item (first wins)', () => {
    const state = sanitizeSyncState({
      outbox: [
        { kind: 'track', id: 'a', op: 'upsert', stamp: 100 },
        { kind: 'track', id: 'a', op: 'delete', stamp: 200 },
      ],
    });
    expect(state.outbox).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 100, enqueuedAt: 0, attempts: 0 },
    ]);
  });

  it('drops unknown top-level fields', () => {
    const state = sanitizeSyncState({ stamps: {}, tombstones: {}, outbox: [], cursor: 'x' });
    expect(state).toEqual(emptySyncState());
    expect('cursor' in state).toBe(false);
  });
});
