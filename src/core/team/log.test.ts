import { OpWriter } from './actions';
import { newTeamKey } from './keys';
import { MAX_FORKS, missingRanges, OpLog } from './log';
import { c, device, HOUR, MIN, T0 } from './testing/fixtures';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';
const key = newTeamKey(c);
const enc = { mode: 'group' as const, ...key };

describe('OpLog', () => {
  it('dedupes and indexes candidates by author and seq', () => {
    const log = new OpLog();
    const w = new OpWriter(c, device().keys, teamId);
    const ops = [1, 2, 3].map((i) => w.data(T0 + i, 'msg', { i }, enc));
    expect(log.insert(ops[0]!, T0)).toBe('new');
    expect(log.insert(ops[0]!, T0)).toBe('duplicate');
    log.insert(ops[2]!, T0);
    expect(log.maxSeq(w.id)).toBe(3);
    expect(log.candidates(w.id, 2)).toEqual([]);
    expect(log.candidates(w.id, 3)).toEqual([ops[2]]);
    expect(log.size).toBe(2);
    expect(log.bytes).toBe(ops[0]!.bytes + ops[2]!.bytes);
    expect(log.has(ops[2]!.id)).toBe(true);
    expect(log.maxSeq('nobody')).toBe(0);
  });

  it('keeps BOTH signed ops of an equivocation as evidence, bounded per seq', () => {
    const log = new OpLog();
    const keys = device().keys;
    const forks = Array.from({ length: MAX_FORKS + 2 }, (_, i) =>
      new OpWriter(c, keys, teamId).data(T0 + i, 'msg', { v: i }, enc),
    );
    expect(log.insert(forks[0]!, T0)).toBe('new');
    expect(log.insert(forks[1]!, T0)).toBe('fork');
    expect(log.equivocations).toEqual([[forks[0]!.id, forks[1]!.id]]);
    expect(log.get(forks[0]!.id)).toBe(forks[0]);
    expect(log.get(forks[1]!.id)).toBe(forks[1]);
    for (let i = 2; i < MAX_FORKS; i++) log.insert(forks[i]!, T0);
    expect(log.insert(forks[MAX_FORKS]!, T0)).toBe('full');
    // …unless the chain pins that exact op.
    expect(log.insert(forks[MAX_FORKS + 1]!, T0, forks[MAX_FORKS + 1]!.id)).toBe('fork');
  });

  it('keeps only the newest unexpired ephemeral op per author', () => {
    const log = new OpLog();
    const w = new OpWriter(c, device().keys, teamId);
    const p1 = w.ephemeral(T0, { t: 'pos', secret: { n: 1 }, enc, ttl: 60 });
    const p2 = w.ephemeral(T0 + 1000, { t: 'pos', secret: { n: 2 }, enc, ttl: 60 });
    expect(log.insert(p2, T0)).toBe('new');
    expect(log.insert(p1, T0)).toBe('stale');
    expect(log.insert(p2, T0)).toBe('duplicate');
    expect(log.has(p2.id)).toBe(true);
    expect(log.liveEphemeral(T0 + 30_000)).toEqual([p2]);
    expect(log.liveEphemeral(T0 + 2 * MIN)).toEqual([]);
    expect(log.insert(p2, T0 + HOUR)).toBe('stale');
  });

  it('drops a removed author past the cut', () => {
    const log = new OpLog();
    const w = new OpWriter(c, device().keys, teamId);
    for (let i = 1; i <= 5; i++) log.insert(w.data(T0 + i, 'msg', { i }, enc), T0);
    expect(log.dropAbove(w.id, 2)).toBe(3);
    expect(log.maxSeq(w.id)).toBe(2);
    expect(log.size).toBe(2);
    expect(log.dropAbove('nobody', 0)).toBe(0);
  });
});

describe('missingRanges', () => {
  it('lists what the other side holds beyond ours, ignoring prototype names', () => {
    expect(missingRanges({ a: 3, b: 5 }, { a: 5, b: 2, c: 1 })).toEqual([
      ['a', 4, 5],
      ['c', 1, 1],
    ]);
    expect(missingRanges({ a: 3 }, { a: 3 })).toEqual([]);
    expect(missingRanges({}, JSON.parse('{"constructor":2}') as Record<string, number>)).toEqual([
      ['constructor', 1, 2],
    ]);
  });
});
