import { enqueue, recordAttempt, settle, type Outbox } from './outbox';

const empty: Outbox = [];

describe('enqueue', () => {
  it('appends a fresh entry with zero attempts', () => {
    const out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 5_000);
    expect(out).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 100, enqueuedAt: 5_000, attempts: 0 },
    ]);
  });

  it('keeps one entry per item and preserves FIFO order of first enqueue', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'photo', id: 'p', op: 'upsert', stamp: 110 }, 2);
    out = enqueue(out, { kind: 'track', id: 'a', op: 'upsert', stamp: 120 }, 3);
    expect(out.map((e) => `${e.kind}:${e.id}`)).toEqual(['track:a', 'photo:p']);
    expect(out[0]).toMatchObject({ stamp: 120, enqueuedAt: 1 });
  });

  it('distinguishes the same id across kinds', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'photo', id: 'a', op: 'upsert', stamp: 100 }, 2);
    expect(out).toHaveLength(2);
  });

  it('is idempotent for the identical change (replaying a mutation log)', () => {
    const once = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    const twice = enqueue(once, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 99);
    expect(twice).toBe(once);
  });

  it('ignores a stale change (older stamp than the queued one)', () => {
    const newer = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 200 }, 1);
    expect(enqueue(newer, { kind: 'track', id: 'a', op: 'upsert', stamp: 150 }, 2)).toBe(newer);
  });

  it('coalesces upsert then delete into a delete', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'track', id: 'a', op: 'delete', stamp: 150 }, 2);
    expect(out).toEqual([
      { kind: 'track', id: 'a', op: 'delete', stamp: 150, enqueuedAt: 1, attempts: 0 },
    ]);
  });

  it('coalesces delete then re-create into an upsert', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'delete', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'track', id: 'a', op: 'upsert', stamp: 150 }, 2);
    expect(out[0]).toMatchObject({ op: 'upsert', stamp: 150 });
  });

  it('an op flip at the same stamp still applies (delete stamped equal to upsert)', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'track', id: 'a', op: 'delete', stamp: 100 }, 2);
    expect(out[0]).toMatchObject({ op: 'delete', stamp: 100 });
  });

  it('resets attempts when a newer change replaces the payload', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = recordAttempt(out, 'track', 'a');
    out = recordAttempt(out, 'track', 'a');
    out = enqueue(out, { kind: 'track', id: 'a', op: 'upsert', stamp: 200 }, 3);
    expect(out[0]).toMatchObject({ stamp: 200, attempts: 0 });
  });

  it('does not mutate its input', () => {
    const before = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    const snapshot = structuredClone(before);
    enqueue(before, { kind: 'track', id: 'a', op: 'delete', stamp: 200 }, 2);
    recordAttempt(before, 'track', 'a');
    settle(before, 'track', 'a', 100);
    expect(before).toEqual(snapshot);
  });
});

describe('recordAttempt', () => {
  it('increments attempts for the item', () => {
    let out = enqueue(empty, { kind: 'photo', id: 'p', op: 'upsert', stamp: 100 }, 1);
    out = recordAttempt(out, 'photo', 'p');
    expect(out[0]).toMatchObject({ attempts: 1 });
    out = recordAttempt(out, 'photo', 'p');
    expect(out[0]).toMatchObject({ attempts: 2 });
  });

  it('is a no-op for an unknown item', () => {
    const out = enqueue(empty, { kind: 'photo', id: 'p', op: 'upsert', stamp: 100 }, 1);
    expect(recordAttempt(out, 'track', 'p')).toBe(out);
  });
});

describe('settle', () => {
  it('removes the entry when the ack covers its stamp', () => {
    const out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    expect(settle(out, 'track', 'a', 100)).toEqual([]);
  });

  it('removes the entry when the ack is newer than its stamp', () => {
    const out = enqueue(empty, { kind: 'track', id: 'a', op: 'delete', stamp: 100 }, 1);
    expect(settle(out, 'track', 'a', 500)).toEqual([]);
  });

  it('keeps the entry when a change raced in during the upload', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    // Upload of stamp 100 departs; the user renames the track meanwhile.
    out = enqueue(out, { kind: 'track', id: 'a', op: 'upsert', stamp: 180 }, 2);
    const settled = settle(out, 'track', 'a', 100);
    expect(settled).toBe(out);
    expect(settled[0]).toMatchObject({ stamp: 180 });
  });

  it('is idempotent: settling twice or settling an unknown item is a no-op', () => {
    const out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    const once = settle(out, 'track', 'a', 100);
    expect(settle(once, 'track', 'a', 100)).toBe(once);
    expect(settle(empty, 'photo', 'nope', 999)).toBe(empty);
  });

  it('only settles the matching item', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = enqueue(out, { kind: 'track', id: 'b', op: 'upsert', stamp: 100 }, 2);
    const settled = settle(out, 'track', 'a', 100);
    expect(settled.map((e) => e.id)).toEqual(['b']);
  });
});

describe('replay scenario (end to end)', () => {
  it('enqueue → attempt → settle → identical re-enqueue leaves a clean single entry', () => {
    let out = enqueue(empty, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 1);
    out = recordAttempt(out, 'track', 'a');
    out = settle(out, 'track', 'a', 100);
    expect(out).toEqual([]);
    // A crash-recovery replay of the same mutation re-dirties the item; the
    // server-side upsert at the same stamp is idempotent, so this is safe.
    out = enqueue(out, { kind: 'track', id: 'a', op: 'upsert', stamp: 100 }, 9);
    expect(out).toEqual([
      { kind: 'track', id: 'a', op: 'upsert', stamp: 100, enqueuedAt: 9, attempts: 0 },
    ]);
  });
});
