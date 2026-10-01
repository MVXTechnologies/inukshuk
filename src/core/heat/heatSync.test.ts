import { DEFAULT_FLUSH_POLICY, diffHeat, flushDue, flushWaitMs } from './heatSync';

describe('diffHeat', () => {
  const stored = new Map([
    ['kept', { hash: 'h1' }],
    ['edited', { hash: 'old' }],
    ['gone', { hash: 'h3' }],
  ]);

  it('takes out what went away or changed, puts in what is new or changed', () => {
    const wanted = new Map([
      ['new', 'n'],
      ['edited', 'new'],
      ['kept', 'h1'],
    ]);
    expect(diffHeat(stored, wanted)).toEqual({
      remove: ['edited', 'gone'],
      add: ['new', 'edited'],
    });
  });

  it('is empty when the store already matches', () => {
    const wanted = new Map([...stored].map(([id, t]) => [id, t.hash]));
    expect(diffHeat(stored, wanted)).toEqual({ remove: [], add: [] });
  });
});

describe('flushDue', () => {
  const p = DEFAULT_FLUSH_POLICY;
  it('waits for a batch or the debounce', () => {
    expect(flushDue({ pending: 0, sinceFirstMs: 1e6, lastFlushMs: 0 })).toBe(false);
    expect(flushDue({ pending: 3, sinceFirstMs: 100, lastFlushMs: 0 })).toBe(false);
    expect(flushDue({ pending: p.maxBatch, sinceFirstMs: 100, lastFlushMs: 0 })).toBe(true);
    expect(flushDue({ pending: 1, sinceFirstMs: p.debounceMs, lastFlushMs: 0 })).toBe(true);
  });

  it('never writes more often than the cost ratio allows', () => {
    // Last write took 1 s: a full batch still waits 4 s.
    expect(flushDue({ pending: 500, sinceFirstMs: 3000, lastFlushMs: 1000 })).toBe(false);
    expect(flushDue({ pending: 500, sinceFirstMs: 4000, lastFlushMs: 1000 })).toBe(true);
  });

  it('tells how long a quiet batch waits', () => {
    expect(flushWaitMs({ pending: 0, sinceFirstMs: 0, lastFlushMs: 0 })).toBe(Infinity);
    expect(flushWaitMs({ pending: 1, sinceFirstMs: 500, lastFlushMs: 0 })).toBe(1500);
    expect(flushWaitMs({ pending: 1, sinceFirstMs: 500, lastFlushMs: 1000 })).toBe(3500);
    expect(flushWaitMs({ pending: 1, sinceFirstMs: 9000, lastFlushMs: 0 })).toBe(0);
  });
});
