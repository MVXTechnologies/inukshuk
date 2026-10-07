import { OpWriter } from './actions';
import { canonicalChain, indexOps } from './chain';
import { newTeamKey } from './keys';
import { c, device, T0 } from './testing/fixtures';
import { mulberry32, shuffle } from './testing/prop';

const teamId = 'AAAAAAAAAAAAAAAAAAAAAA';
const enc = { mode: 'group' as const, ...newTeamKey(c) };

/** An author's honest history of `n` ops, plus a fork branching after `forkAt`. */
function histories(n: number, forkAt: number) {
  const keys = device().keys;
  const honest = new OpWriter(c, keys, teamId);
  const ops = Array.from({ length: n }, (_, i) => honest.data(T0 + i, 'msg', { h: i }, enc));
  const prev = forkAt === 0 ? undefined : ops[forkAt - 1]!.id;
  const evil = new OpWriter(c, keys, teamId, forkAt, { wall: 0, counter: 0 }, prev);
  const fork = Array.from({ length: 2 }, (_, i) => evil.data(T0 - 100 + i, 'msg', { f: i }, enc));
  return { author: honest.id, ops, fork };
}

describe('canonicalChain', () => {
  it('follows pv links bottom-up; a gap ends the chain', () => {
    const { author, ops } = histories(4, 0);
    expect(canonicalChain(indexOps(ops), author).ids).toEqual(ops.map((o) => o.id));
    expect(canonicalChain(indexOps([ops[0]!, ops[2]!]), author).ids).toEqual([ops[0]!.id]);
  });

  it('unanchored equivocation resolves the same in any arrival order', () => {
    const { author, ops, fork } = histories(4, 2);
    const all = [...ops, ...fork];
    const ref = canonicalChain(indexOps(all), author).ids;
    const rnd = mulberry32(3);
    for (let i = 0; i < 10; i++) {
      expect(canonicalChain(indexOps(shuffle(all, rnd)), author).ids).toEqual(ref);
    }
  });

  it('an anchor pins the history: a backdated fork below the cut is never canonical (H3)', () => {
    const { author, ops, fork } = histories(4, 1);
    const anchor = { seq: 4, id: ops[3]!.id, stop: true };
    // Even when only the forged history is held at seq 2, the anchor refuses it…
    const partial = canonicalChain(indexOps([ops[0]!, ...fork, ops[2]!, ops[3]!]), author, anchor);
    expect(partial.ids).toEqual([ops[0]!.id]);
    // …and says which op it needs there (so the replica pulls and admits it).
    expect(partial.pinned.get(3)).toBe(ops[2]!.id);
    const full = canonicalChain(indexOps([...ops, ...fork]), author, anchor);
    expect(full.ids).toEqual(ops.map((o) => o.id));
    expect(full.pinned.get(2)).toBe(ops[1]!.id);
    // A removal anchor stops the chain; a demotion anchor lets it continue.
    expect(
      canonicalChain(indexOps(ops), author, { seq: 2, id: ops[1]!.id, stop: true }).ids,
    ).toHaveLength(2);
    expect(
      canonicalChain(indexOps(ops), author, { seq: 2, id: ops[1]!.id, stop: false }).ids,
    ).toHaveLength(4);
    expect(canonicalChain(indexOps(ops), author, { seq: 0, id: '', stop: true }).ids).toEqual([]);
  });
});
