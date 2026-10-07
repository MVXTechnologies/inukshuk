import { isLive, visibleFields } from './crdt';
import { entityKey, reduceData } from './data';
import { resolveTeam } from './membership';
import {
  authorizeRecord,
  baseKey,
  decodeLine,
  KEY,
  keyBetween,
  MAX_KEY,
  MAX_LIVE_VERTICES,
  MAX_VERTEX_RECORDS,
  trailVertices,
} from './records';
import type { TeamReplica } from './replica';
import { addMember, c, device, exchange, joinReplica, MIN, newWorld, T0 } from './testing/fixtures';
import { forAll, int, mulberry32, pick, shuffle } from './testing/prop';

/** Owner (admin), Bob and Eve (members), Gus (guest). */
function crew() {
  const w = newWorld();
  const bob = device();
  const eve = device();
  const gus = device();
  addMember(w.root, bob, 'member', T0 + 1);
  addMember(w.root, eve, 'member', T0 + 2);
  addMember(w.root, gus, 'guest', T0 + 3);
  const rb = joinReplica(w, bob, w.root, T0 + 4);
  const re = joinReplica(w, eve, w.root, T0 + 4);
  const rg = joinReplica(w, gus, w.root, T0 + 4);
  const all = [w.root, rb, re, rg];
  const sync = (now: number) => {
    for (const r of all) exchange(w.root, r, now);
    for (const r of all) exchange(w.root, r, now);
  };
  return { w, bob, eve, gus, rb, re, rg, all, sync };
}

// "_p~iF~ps|U_ulLnnqC_mqNvxq`@" → three points (Google's example).
const LINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const why = (r: TeamReplica, id: string) => r.data().skipped.find((s) => s.id === id)?.why;

function verticesOf(r: TeamReplica, owner: string, tr: string) {
  const d = r.data();
  const trl = d.entities.get(entityKey('trl', tr, owner))!;
  const base = decodeLine(visibleFields(trl.state)['base'] as string, 2000)!;
  const edits = [...d.entities.values()].filter((e) => e.kind === 'tve' && e.owner === owner);
  return trailVertices(base, tr, owner, edits);
}

describe('fractional keys', () => {
  it('always fit strictly between, at either end too, canonically', () => {
    expect(baseKey(0) < baseKey(1)).toBe(true);
    expect(baseKey(35) < baseKey(36)).toBe(true);
    forAll(
      7,
      300,
      (rnd) => rnd,
      (rnd) => {
        let keys = [baseKey(0), baseKey(1)];
        for (let i = 0; i < 30; i++) {
          const at = int(rnd, 0, keys.length);
          const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null)!;
          expect(KEY.test(k)).toBe(true);
          if (at > 0) expect(k > keys[at - 1]!).toBe(true);
          if (at < keys.length) expect(k < keys[at]!).toBe(true);
          keys = [...keys.slice(0, at), k, ...keys.slice(at)];
        }
        expect([...keys].sort()).toEqual(keys);
      },
    );
  });

  it('PoC (review #4): never out of order, null when there is no room, never a dead pair', () => {
    // The adversarial pair: `a0` is not a canonical key, so there is no a/a0 gap.
    expect(keyBetween('a', 'a0')).toBeNull();
    expect(KEY.test('a0')).toBe(false);
    expect(keyBetween('b', 'a')).toBeNull();
    expect(keyBetween('a', 'a')).toBeNull();
    // Random canonical pairs: a key in between, or null; never outside.
    const D = '0123456789abcdefghijklmnopqrstuvwxyz';
    forAll(
      11,
      2000,
      (rnd) => {
        const one = () => {
          const n = int(rnd, 1, 6);
          let k = '';
          for (let i = 0; i < n; i++) k += D[int(rnd, 0, 36)];
          return k.replace(/0+$/, '') || 'i';
        };
        const x = one();
        const y = one();
        return x < y ? [x, y] : [y, x];
      },
      ([x, y]) => {
        const k = keyBetween(x!, y!);
        if (x === y) expect(k).toBeNull();
        else {
          expect(k).not.toBeNull();
          expect(k! > x! && k! < y!).toBe(true);
          expect(KEY.test(k!)).toBe(true);
        }
      },
    );
    // Honest appends: a thousand stay ordered, within the bound.
    let last = baseKey(10);
    for (let i = 0; i < 1000; i++) {
      const k = keyBetween(last, null)!;
      expect(k > last).toBe(true);
      last = k;
    }
    expect(last.length).toBeLessThanOrEqual(MAX_KEY);
    // A key at the bound has no room after it: null, never a longer key.
    expect(keyBetween('z'.repeat(MAX_KEY), null)).toBeNull();
  });

  it('decodes polylines totally', () => {
    expect(decodeLine(LINE, 10)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
    expect(decodeLine(LINE, 2)).toBeNull();
    expect(decodeLine('~~~', 10)).toBeNull();
  });
});

describe('team trails (adversarial)', () => {
  it('members rename and reshape; only the creator writes the base, once; guests do nothing', () => {
    const { w, bob, rb, re, rg, sync } = crew();
    rb.write(T0 + MIN, 'e.set', { k: 'trl', id: 't1', f: { name: 'Loop', base: LINE } });
    const noBase = rb.write(T0 + MIN, 'e.set', { k: 'trl', id: 't2', f: { name: 'x' } })!;
    sync(T0 + 2 * MIN);
    const rename = re.write(T0 + 3 * MIN, 'e.set', {
      k: 'trl',
      id: 't1',
      o: bob.id,
      f: { name: 'Summit loop', color: '#E07B39' },
    })!;
    const steal = re.write(T0 + 3 * MIN, 'e.set', {
      k: 'trl',
      id: 't1',
      o: bob.id,
      f: { base: LINE },
    })!;
    const rebase = rb.write(T0 + 3 * MIN, 'e.set', { k: 'trl', id: 't1', f: { base: LINE } })!;
    const guest = rg.write(T0 + 3 * MIN, 'e.set', {
      k: 'trl',
      id: 't1',
      o: bob.id,
      f: { name: 'Gus' },
    })!;
    const del = re.write(T0 + 3 * MIN, 'e.del', { k: 'trl', id: 't1', o: bob.id })!;
    // Vertex edits: Eve moves the middle point and inserts one; Gus tries; a
    // vertex of a trail that does not exist; a base vertex with a key.
    re.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 't1_b1',
      f: { to: bob.id, tr: 't1', la: 40.8, lo: -121 },
    });
    re.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 't1_x9',
      f: { to: bob.id, tr: 't1', la: 39, lo: -120.5, k: keyBetween(baseKey(0), baseKey(1)) },
    });
    const gv = rg.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 't1_g1',
      f: { to: bob.id, tr: 't1', la: 0, lo: 0, k: 'h0001' },
    })!;
    const orphan = re.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 'zz_b0',
      f: { to: bob.id, tr: 'zz', la: 0, lo: 0 },
    })!;
    const keyed = re.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 't1_b2',
      f: { to: bob.id, tr: 't1', la: 0, lo: 0, k: 'a' },
    })!;
    const wrongId = re.write(T0 + 4 * MIN, 'e.set', {
      k: 'tve',
      id: 'other_b2',
      f: { to: bob.id, tr: 't1', la: 0, lo: 0 },
    })!;
    // Bob deletes the last base point.
    rb.write(T0 + 5 * MIN, 'e.del', { k: 'tve', id: 't1_b2', o: bob.id });
    sync(T0 + 6 * MIN);
    for (const r of [w.root, rb, re]) {
      expect(why(r, noBase.id)).toBe('invalid');
      expect(why(r, rename.id)).toBeUndefined();
      expect(why(r, steal.id)).toBe('forbidden');
      expect(why(r, rebase.id)).toBe('forbidden');
      expect(why(r, guest.id)).toBe('forbidden');
      expect(why(r, del.id)).toBe('forbidden');
      expect(why(r, gv.id)).toBe('forbidden');
      expect(why(r, orphan.id)).toBe('forbidden');
      expect(why(r, keyed.id)).toBe('invalid');
      expect(why(r, wrongId.id)).toBe('invalid');
      const trl = r.data().entities.get(entityKey('trl', 't1', bob.id))!;
      expect(visibleFields(trl.state)).toMatchObject({ name: 'Summit loop', color: '#E07B39' });
      expect(verticesOf(r, bob.id, 't1').map((v) => [v.id, v.lng, v.lat])).toEqual([
        ['t1_b0', -120.2, 38.5],
        ['t1_x9', -120.5, 39],
        ['t1_b1', -121, 40.8],
      ]);
    }
    // The creator or an admin deletes the trail.
    w.root.write(T0 + 7 * MIN, 'e.del', { k: 'trl', id: 't1', o: bob.id });
    sync(T0 + 8 * MIN);
    expect(isLive(rb.data().entities.get(entityKey('trl', 't1', bob.id))!.state)).toBe(false);
  });

  it('property: concurrent vertex edits from three members converge in any order', () => {
    forAll(
      42,
      12,
      (rnd) => rnd,
      (rnd) => {
        const k = crew();
        k.rb.write(T0 + MIN, 'e.set', { k: 'trl', id: 't1', f: { name: 'L', base: LINE } });
        k.sync(T0 + MIN + 1);
        const editors = [k.w.root, k.rb, k.re];
        let inserted = 0;
        for (let i = 0; i < 30; i++) {
          const r = pick(rnd, editors);
          const t = T0 + 2 * MIN + int(rnd, 0, 30) * 1000;
          const roll = rnd();
          const keys = [baseKey(0), baseKey(1), baseKey(2)];
          if (roll < 0.4) {
            r.write(t, 'e.set', {
              k: 'tve',
              id: `t1_b${int(rnd, 0, 3)}`,
              f: { to: k.bob.id, tr: 't1', la: int(rnd, -80, 80), lo: int(rnd, -170, 170) },
            });
          } else if (roll < 0.75) {
            const at = int(rnd, 0, 3);
            r.write(t, 'e.set', {
              k: 'tve',
              id: `t1_i${inserted++}`,
              f: {
                to: k.bob.id,
                tr: 't1',
                la: int(rnd, -80, 80),
                lo: int(rnd, -170, 170),
                k: keyBetween(keys[at - 1] ?? null, keys[at] ?? null),
              },
            });
          } else {
            const id = rnd() < 0.5 ? `t1_b${int(rnd, 0, 3)}` : `t1_i${int(rnd, 0, inserted + 1)}`;
            r.write(t, 'e.del', { k: 'tve', id, o: k.bob.id });
          }
          if (rnd() < 0.3) k.sync(t + 1);
        }
        k.sync(T0 + 40 * MIN);
        const ref = JSON.stringify(verticesOf(k.w.root, k.bob.id, 't1'));
        for (const r of k.all) expect(JSON.stringify(verticesOf(r, k.bob.id, 't1'))).toBe(ref);
        const ops = [...k.w.root.log.logged()];
        const s = resolveTeam(c, k.w.teamId, shuffle(ops, mulberry32(int(rnd, 0, 1e6))));
        const d = reduceData(s, (op) => k.w.root.decode(op));
        const trl = d.entities.get(entityKey('trl', 't1', k.bob.id))!;
        const base = decodeLine(visibleFields(trl.state)['base'] as string, 2000)!;
        const again = trailVertices(
          base,
          't1',
          k.bob.id,
          [...d.entities.values()].filter((e) => e.kind === 'tve' && e.owner === k.bob.id),
        );
        expect(JSON.stringify(again)).toBe(ref);
      },
    );
  });
});

describe('SOS (adversarial)', () => {
  it('anyone raises; the raiser or an admin resolves; nobody resolves in another name', () => {
    const { w, gus, rb, rg, sync } = crew();
    const noPlace = rg.write(T0 + MIN, 'e.set', { k: 'sos', id: 's0', f: { tx: 'help' } })!;
    rg.write(T0 + MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 47, lo: -71, tx: 'Ankle' } });
    sync(T0 + 2 * MIN);
    const bobRes = rb.write(T0 + 3 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      o: gus.id,
      f: { res: true, rby: rb.id, rat: T0 },
    })!;
    const spoof = w.root.write(T0 + 3 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      o: gus.id,
      f: { res: true, rby: gus.id, rat: T0 },
    })!;
    const move = w.root.write(T0 + 3 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      o: gus.id,
      f: { la: 0 },
    })!;
    sync(T0 + 4 * MIN);
    expect(why(w.root, noPlace.id)).toBe('invalid');
    expect(why(w.root, bobRes.id)).toBe('forbidden');
    expect(why(w.root, spoof.id)).toBe('invalid');
    expect(why(w.root, move.id)).toBe('forbidden');
    w.root.write(T0 + 5 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      o: gus.id,
      f: { res: true, rby: w.owner.id, rat: T0 + 5 * MIN },
    });
    sync(T0 + 6 * MIN);
    const sos = rb.data().entities.get(entityKey('sos', 's1', gus.id))!;
    expect(visibleFields(sos.state)).toMatchObject({ la: 47, res: true, rby: w.owner.id });
    // The raiser reopens it (their own record).
    rg.write(T0 + 7 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      f: { res: false, rby: null, rat: null },
    });
    sync(T0 + 8 * MIN);
    expect(
      visibleFields(rb.data().entities.get(entityKey('sos', 's1', gus.id))!.state),
    ).toMatchObject({
      res: false,
    });
  });
});

describe('SOS spam guard', () => {
  it('one open SOS per member, and a minute after a resolve', () => {
    const { w, gus, rg, sync } = crew();
    rg.write(T0 + MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 47, lo: -71 } });
    const second = rg.write(T0 + MIN + 1000, 'e.set', {
      k: 'sos',
      id: 's2',
      f: { la: 47, lo: -71 },
    })!;
    rg.write(T0 + 2 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      f: { res: true, rby: gus.id, rat: T0 + 2 * MIN },
    });
    const soon = rg.write(T0 + 2 * MIN + 10_000, 'e.set', {
      k: 'sos',
      id: 's3',
      f: { la: 47, lo: -71 },
    })!;
    const later = rg.write(T0 + 4 * MIN, 'e.set', { k: 'sos', id: 's4', f: { la: 47, lo: -71 } })!;
    sync(T0 + 5 * MIN);
    expect(why(w.root, second.id)).toBe('forbidden');
    expect(why(w.root, soon.id)).toBe('forbidden');
    expect(why(w.root, later.id)).toBeUndefined();
  });
});

describe('rally points and resolved messages (adversarial)', () => {
  it('members set rallies; guests cannot; nobody edits another’s', () => {
    const { w, bob, rb, re, rg, sync } = crew();
    rb.write(T0 + MIN, 'e.set', {
      k: 'rly',
      id: 'r1',
      f: { la: 47, lo: -71, tx: 'Meet', r: 60, at: T0 },
    });
    const g = rg.write(T0 + MIN, 'e.set', { k: 'rly', id: 'r2', f: { la: 47, lo: -71 } })!;
    sync(T0 + 2 * MIN);
    const edit = re.write(T0 + 3 * MIN, 'e.set', { k: 'rly', id: 'r1', o: bob.id, f: { la: 0 } })!;
    const del = re.write(T0 + 3 * MIN, 'e.del', { k: 'rly', id: 'r1', o: bob.id })!;
    const bad = rb.write(T0 + 3 * MIN, 'e.set', { k: 'rly', id: 'r1', f: { r: 5 } })!;
    sync(T0 + 4 * MIN);
    expect(why(w.root, g.id)).toBe('forbidden');
    expect(why(w.root, edit.id)).toBe('invalid');
    expect(why(w.root, del.id)).toBe('forbidden');
    expect(why(w.root, bad.id)).toBe('invalid');
    w.root.write(T0 + 5 * MIN, 'e.del', { k: 'rly', id: 'r1', o: bob.id });
    sync(T0 + 6 * MIN);
    expect(isLive(rb.data().entities.get(entityKey('rly', 'r1', bob.id))!.state)).toBe(false);
  });

  it('a message is resolved by its author, someone it mentions, or an admin', () => {
    const { w, bob, eve, gus, rb, re, rg, sync } = crew();
    const th = `pin:${bob.id}:p1`;
    rb.write(T0 + MIN, 'msg', { id: 'p1', th, tx: 'Tree down', ll: [-71, 47], mn: [gus.id] });
    sync(T0 + 2 * MIN);
    const res = (r: TeamReplica, by: string, t: number) =>
      r.write(t, 'e.set', { k: 'mres', id: 'p1', o: bob.id, f: { res: true, rby: by, rat: t } })!;
    const eveTry = res(re, eve.id, T0 + 3 * MIN);
    const nothing = re.write(T0 + 3 * MIN, 'e.set', {
      k: 'mres',
      id: 'nope',
      o: bob.id,
      f: { res: true, rby: eve.id, rat: T0 },
    })!;
    const gusDoes = res(rg, gus.id, T0 + 4 * MIN);
    sync(T0 + 5 * MIN);
    expect(why(w.root, eveTry.id)).toBe('forbidden');
    expect(why(w.root, nothing.id)).toBe('forbidden');
    expect(why(w.root, gusDoes.id)).toBeUndefined();
    expect(
      visibleFields(w.root.data().entities.get(entityKey('mres', 'p1', bob.id))!.state),
    ).toEqual({ res: true, rby: gus.id, rat: T0 + 4 * MIN });
    // The author reopens; an admin resolves again.
    rb.write(T0 + 6 * MIN, 'e.set', {
      k: 'mres',
      id: 'p1',
      f: { res: false, rby: null, rat: null },
    });
    res(w.root, w.owner.id, T0 + 7 * MIN);
    sync(T0 + 8 * MIN);
    expect(
      visibleFields(re.data().entities.get(entityKey('mres', 'p1', bob.id))!.state),
    ).toMatchObject({ res: true, rby: w.owner.id });
  });
});

describe('review regressions (records)', () => {
  it('PoC V1 (review #1): a member cannot erase another member’s trail of the same id', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', { k: 'trl', id: 't1', f: { name: 'Eve', base: LINE } });
    rb.write(T0 + MIN, 'e.set', { k: 'trl', id: 't1', f: { name: 'Bob', base: LINE } });
    sync(T0 + 2 * MIN);
    for (let i = 0; i < 3; i++) {
      rb.write(T0 + 3 * MIN, 'e.del', { k: 'tve', id: `t1_b${i}`, o: bob.id });
      rb.write(T0 + 3 * MIN, 'e.set', {
        k: 'tve',
        id: `t1_b${i}`,
        f: { to: bob.id, tr: 't1', la: 0, lo: 0 },
      });
    }
    sync(T0 + 4 * MIN);
    for (const r of [w.root, rb, re]) {
      expect(verticesOf(r, eve.id, 't1')).toHaveLength(3);
      expect(verticesOf(r, eve.id, 't1').map((v) => v.lat)).toEqual([38.5, 40.7, 43.252]);
    }
    // An edit whose fields name another trail than its key is ignored, never a deletion.
    expect(
      trailVertices(decodeLine(LINE, 10)!, 't1', eve.id, [
        {
          id: 't1_b0',
          state: {
            fields: { to: { value: bob.id, stamp: { wall: 1, counter: 0, node: 'x' } } },
          } as never,
        },
      ]),
    ).toHaveLength(3);
  });

  it('PoC V2 (review #3): inserts stop at the trail’s caps', () => {
    const live = {
      state: {
        fields: { base: { value: LINE, stamp: { wall: 1, counter: 0, node: 'x' } } },
        created: { wall: 1, counter: 0, node: 'x' },
      },
    } as never;
    const write = (id: string) => ({
      kind: 'tve' as const,
      id,
      o: undefined,
      f: { to: device().id, tr: 't1', la: 1, lo: 1, k: 'm' },
      author: 'a',
      role: 'member' as const,
    });
    const many = (n: number, alive: boolean) =>
      Array.from({ length: n }, (_, i) => ({
        id: `t1_x${i}`,
        state: alive
          ? ({
              fields: { k: { value: 'm', stamp: { wall: 2, counter: i, node: 'x' } } },
              created: { wall: 2, counter: i, node: 'x' },
            } as never)
          : ({ fields: {}, deleted: { wall: 3, counter: i, node: 'x' } } as never),
      }));
    const get = (kind: string) => (kind === 'trl' ? live : undefined);
    // 3 base points + 1996 live inserts = 1999: one more fits; at 2000, no more.
    expect(authorizeRecord(write('t1_new'), get, () => many(MAX_LIVE_VERTICES - 4, true))).toEqual({
      owner: expect.any(String),
    });
    expect(authorizeRecord(write('t1_new'), get, () => many(MAX_LIVE_VERTICES - 3, true))).toBe(
      'forbidden',
    );
    // Deleted inserts still count toward the record cap.
    expect(authorizeRecord(write('t1_new'), get, () => many(MAX_VERTEX_RECORDS, false))).toBe(
      'forbidden',
    );
  });

  it('PoC S1 (review #2): twenty guest writes to an open SOS raise one alarm', () => {
    const { w, rg, sync } = crew();
    const ops = [];
    for (let i = 0; i < 20; i++)
      ops.push(
        rg.write(T0 + MIN + i * 1000, 'e.set', {
          k: 'sos',
          id: 's1',
          f: { la: 47 + i / 1e4, lo: -71 },
        })!,
      );
    sync(T0 + 2 * MIN);
    // A second SOS id while one is open is refused.
    const second = rg.write(T0 + 3 * MIN, 'e.set', { k: 'sos', id: 's2', f: { la: 47, lo: -71 } })!;
    sync(T0 + 3 * MIN);
    expect(why(w.root, second.id)).toBe('forbidden');
    const created = w.root.data().entities.get(entityKey('sos', 's1', rg.id))!.state.created!;
    const raises = ops.filter(
      (op) => op.stamp.wall === created.wall && op.stamp.counter === created.counter,
    );
    expect(raises).toHaveLength(1);
  });

  it('review #5: a re-raise writes the whole trio; a resolution is never deleted', () => {
    const { w, bob, gus, rb, rg, sync } = crew();
    rg.write(T0 + MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 47, lo: -71 } });
    rg.write(T0 + 2 * MIN, 'e.set', { k: 'sos', id: 's1', f: { res: true, rby: gus.id, rat: T0 } });
    sync(T0 + 3 * MIN);
    const sloppy = rg.write(T0 + 4 * MIN, 'e.set', { k: 'sos', id: 's1', f: { la: 46, lo: -71 } })!;
    rg.write(T0 + 5 * MIN, 'e.set', {
      k: 'sos',
      id: 's1',
      f: { la: 46, lo: -71, res: false, rby: null, rat: null },
    });
    rb.write(T0 + 5 * MIN, 'msg', { id: 'p1', th: `pin:${bob.id}:p1`, tx: 'x', ll: [-71, 47] });
    rb.write(T0 + 6 * MIN, 'e.set', {
      k: 'mres',
      id: 'p1',
      f: { res: true, rby: bob.id, rat: T0 },
    });
    const del = rb.write(T0 + 7 * MIN, 'e.del', { k: 'mres', id: 'p1' })!;
    sync(T0 + 8 * MIN);
    expect(why(w.root, sloppy.id)).toBe('invalid');
    expect(why(w.root, del.id)).toBe('forbidden');
    expect(
      visibleFields(w.root.data().entities.get(entityKey('sos', 's1', gus.id))!.state),
    ).toMatchObject({
      res: false,
      la: 46,
    });
  });
});
