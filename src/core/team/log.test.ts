import { OpWriter } from './actions';
import { missingRanges, OpLog } from './log';
import { newTeamKey } from './keys';
import { c, device, HOUR, MIN, T0 } from './testing/fixtures';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';
const key = newTeamKey(c);
const enc = { mode: 'group' as const, ...key };

function writer() {
  return new OpWriter(c, device().keys, teamId);
}

describe('OpLog', () => {
  it('dedupes, tracks contiguous version vectors across gaps, serves ranges', () => {
    const log = new OpLog();
    const w = writer();
    const ops = [1, 2, 3, 4].map((i) => w.data(T0 + i, 'msg', { i }, enc));
    expect(log.insert(ops[0]!, T0)).toBe('new');
    expect(log.insert(ops[0]!, T0)).toBe('duplicate');
    expect(log.insert(ops[2]!, T0)).toBe('new'); // gap at 2
    expect(log.versionVector()).toEqual({ [w.id]: 1 });
    expect(log.range(w.id, 1, 4).map((o) => o.env.sq)).toEqual([1]);
    log.insert(ops[1]!, T0);
    expect(log.versionVector()).toEqual({ [w.id]: 3 });
    expect(log.range(w.id, 2, 3).map((o) => o.env.sq)).toEqual([2, 3]);
    expect(log.range('nobody', 1, 2)).toEqual([]);
    expect(log.size).toBe(3);
    expect(log.bytes).toBe(ops.slice(0, 3).reduce((n, o) => n + o.bytes, 0));
    expect(log.has(ops[1]!.id)).toBe(true);
    expect(log.idAt(w.id, 2)).toBe(ops[1]!.id);
  });

  it('flags equivocation (two ops for one author+seq) and keeps the first', () => {
    const log = new OpLog();
    const keys = device().keys;
    const a = new OpWriter(c, keys, teamId).data(T0, 'msg', { v: 'a' }, enc);
    const b = new OpWriter(c, keys, teamId).data(T0 + 1, 'msg', { v: 'b' }, enc);
    log.insert(a, T0);
    expect(log.insert(b, T0)).toBe('equivocation');
    expect(log.equivocations).toEqual([[a.id, b.id]]);
    expect(log.get(a.id)).toBe(a);
    expect(log.get(b.id)).toBeUndefined();
  });

  it('keeps only the newest unexpired ephemeral op per author', () => {
    const log = new OpLog();
    const w = writer();
    const p1 = w.ephemeral(T0, { t: 'pos', secret: { n: 1 }, enc, ttl: 60 });
    const p2 = w.ephemeral(T0 + 1000, { t: 'pos', secret: { n: 2 }, enc, ttl: 60 });
    expect(log.insert(p2, T0)).toBe('new');
    expect(log.insert(p1, T0)).toBe('stale');
    expect(log.insert(p2, T0)).toBe('duplicate');
    expect(log.has(p2.id)).toBe(true);
    expect(log.liveEphemeral(T0 + 30_000)).toEqual([p2]);
    expect(log.liveEphemeral(T0 + 2 * MIN)).toEqual([]);
    expect(log.insert(p2, T0 + HOUR)).toBe('stale');
    expect(log.versionVector()).toEqual({});
  });

  it('drops a removed author past the cut', () => {
    const log = new OpLog();
    const w = writer();
    for (let i = 1; i <= 5; i++) log.insert(w.data(T0 + i, 'msg', { i }, enc), T0);
    expect(log.dropAbove(w.id, 2)).toBe(3);
    expect(log.versionVector()).toEqual({ [w.id]: 2 });
    expect(log.size).toBe(2);
    expect(log.dropAbove('nobody', 0)).toBe(0);
  });
});

describe('missingRanges', () => {
  it('lists what the other side holds beyond ours', () => {
    expect(missingRanges({ a: 3, b: 5 }, { a: 5, b: 2, c: 1 })).toEqual([
      ['a', 4, 5],
      ['c', 1, 1],
    ]);
    expect(missingRanges({ a: 3 }, { a: 3 })).toEqual([]);
  });
});
