import type { Json } from '@core/team/canonical';
import { hlcObserve, hlcTick, type Hlc, type Stamp } from '@core/team/hlc';
import { forAll, int, mulberry32, pick, shuffle } from '@core/team/testing/prop';

import {
  BASE_FIELD,
  baseFrom,
  baseToWire,
  beatenEdits,
  compareWrites,
  conflicts,
  EMPTY_BASE,
  hasBase,
  heads,
  MAX_BASE_AUTHORS,
  parseBase,
  saw,
  silentMerges,
  type Base,
  type Removal,
  type Write,
} from './conflicts';

const W0 = Date.UTC(2026, 9, 7, 12);
const A = 'A'.repeat(43);
const B = 'B'.repeat(42) + 'A';
const C = 'C'.repeat(42) + 'A';

const st = (author: string, wall: number, counter = 0): Stamp => ({
  wall: W0 + wall,
  counter,
  author,
});

let n = 0;
function w(
  stamp: Stamp,
  fields: Record<string, Json>,
  base: Readonly<Record<string, Stamp>> = {},
  del = false,
): Write {
  n += 1;
  const b = new Map<string, Hlc>(
    Object.entries(base).map(([k, s]) => [k, { wall: s.wall, counter: s.counter }]),
  );
  const out: Write = { id: `w${String(n).padStart(4, '0')}`, stamp, fields, base: b };
  if (del) out.del = true;
  return out;
}

describe('base stamps on the wire', () => {
  it('round-trips, keys sorted, and refuses anything malformed', () => {
    const base: Base = new Map([
      [B, { wall: W0, counter: 2 }],
      [A, { wall: W0 + 5, counter: 0 }],
    ]);
    const wire = baseToWire(base);
    expect(Object.keys(wire)).toEqual([A, B]);
    expect(wire[A]).toEqual([W0 + 5, 0]);
    expect(parseBase(wire)).toEqual(base);
    expect(parseBase({})).toEqual(new Map());
    for (const bad of [
      null,
      [],
      'x',
      { short: [W0, 0] },
      { [A]: [W0] },
      { [A]: [1, 0] },
      { [A]: [W0, -1] },
      { [A]: 'x' },
    ])
      expect(parseBase(bad)).toBeUndefined();
    const many = Object.fromEntries(
      Array.from({ length: MAX_BASE_AUTHORS + 1 }, (_, i) => [
        `${String(i).padStart(3, '0')}`.padEnd(42, 'Q') + 'A',
        [W0, 0],
      ]),
    );
    expect(parseBase(many)).toBeUndefined();
    expect(hasBase({ [BASE_FIELD]: {} })).toBe(true);
    expect(hasBase({ n: 'x' })).toBe(false);
  });

  it('baseFrom keeps each other author newest stamp, never the writer', () => {
    const base = baseFrom(
      [{ stamp: st(A, 1) }, { stamp: st(A, 3) }, { stamp: st(B, 2, 4) }, { stamp: st(C, 9) }],
      C,
    );
    expect(base).toEqual(
      new Map([
        [A, { wall: W0 + 3, counter: 0 }],
        [B, { wall: W0 + 2, counter: 4 }],
      ]),
    );
  });

  it('baseFrom keeps the newest authors when a record has too many', () => {
    const stamps = Array.from({ length: MAX_BASE_AUTHORS + 3 }, (_, i) => ({
      stamp: st(`${String(i).padStart(3, '0')}`.padEnd(42, 'Q') + 'A', i),
    }));
    const base = baseFrom(stamps, A);
    expect(base.size).toBe(MAX_BASE_AUTHORS);
    expect(base.has(stamps[0]!.stamp.author)).toBe(false);
    expect(base.has(stamps[stamps.length - 1]!.stamp.author)).toBe(true);
  });
});

describe('saw / heads', () => {
  it('an author always saw its own earlier writes; others only through the base', () => {
    const a1 = w(st(A, 1), { n: 'a' });
    const a2 = w(st(A, 2), { n: 'b' });
    const b1 = w(st(B, 3), { n: 'c' });
    const b2 = w(st(B, 4), { n: 'd' }, { [A]: st(A, 1) });
    expect(saw(a2, a1)).toBe(true);
    expect(saw(a1, a2)).toBe(false);
    expect(saw(b1, a1)).toBe(false);
    expect(saw(b2, a1)).toBe(true);
    expect(saw(b2, a2)).toBe(false);
    expect(heads([a1, a2, b1, b2]).map((x) => x.id)).toEqual([b2.id, a2.id]);
  });

  it('a base can never make a later write look seen', () => {
    const a1 = w(st(A, 5), { n: 'a' });
    const b1 = w(st(B, 1), { n: 'b' }, { [A]: st(A, 99) });
    expect(saw(b1, a1)).toBe(false);
    expect(heads([a1, b1]).map((x) => x.id)).toEqual([a1.id, b1.id]);
  });

  it('equal stamps order by op id, as the fold does', () => {
    const x = { ...w(st(A, 1), { n: 'x' }), id: 'b' };
    const y = { ...w(st(A, 1), { n: 'y' }), id: 'a' };
    expect(compareWrites(x, y)).toBe(1);
    expect(compareWrites(y, x)).toBe(-1);
    expect(compareWrites(x, x)).toBe(0);
    expect(saw(x, y)).toBe(true);
  });
});

describe('conflicts', () => {
  it('two offline renames from the same base: the later is kept, the other listed', () => {
    const create = w(st(A, 1), { n: 'Belvédère', t: 'wpt' });
    const julie = w(st(B, 5), { n: 'Belvédère du lac' }, { [A]: st(A, 1) });
    const noe = w(st(C, 4), { n: 'Lookout' }, { [A]: st(A, 1) });
    const [c, ...rest] = conflicts([create, julie, noe]);
    expect(rest).toEqual([]);
    expect(c!.field).toBe('n');
    expect(c!.kept.value).toBe('Belvédère du lac');
    expect(c!.others.map((o) => o.value)).toEqual(['Lookout']);
  });

  it('a later write that saw both resolves it; one that saw only the winner does not', () => {
    const create = w(st(A, 1), { n: 'x' });
    const b = w(st(B, 5), { n: 'b' }, { [A]: st(A, 1) });
    const c = w(st(C, 4), { n: 'c' }, { [A]: st(A, 1) });
    const onlyB = w(st(A, 6), { n: 'a' }, { [B]: st(B, 5) });
    expect(conflicts([create, b, c, onlyB])[0]!.others.map((o) => o.value)).toEqual(['c']);
    const both = w(st(A, 7), { n: 'c' }, { [B]: st(B, 5), [C]: st(C, 4) });
    expect(conflicts([create, b, c, onlyB, both])).toEqual([]);
  });

  it('different fields merge silently, and are listed as such', () => {
    const create = w(st(A, 1), { n: 'x', ic: 'camp' });
    const noe = w(st(B, 5), { ic: 'peak' }, { [A]: st(A, 1) });
    const julie = w(st(C, 4), { d: 'View', [BASE_FIELD]: {} }, { [A]: st(A, 1) });
    expect(conflicts([create, noe, julie])).toEqual([]);
    expect(silentMerges([create, noe, julie]).map((m) => [m.write.id, m.fields])).toEqual([
      [noe.id, ['ic']],
      [julie.id, ['d']],
    ]);
    expect(silentMerges([create, noe])).toEqual([]);
  });

  it('skipped fields and tombstones are never conflicts', () => {
    const a = w(st(A, 1), { n: 'x', rm: 1 });
    const b = w(st(B, 2), { n: 'y', rm: 0 });
    const d = w(st(C, 3), {}, {}, true);
    const c = conflicts([a, b, d], new Set(['rm']));
    expect(c.map((x) => x.field)).toEqual(['n']);
    expect(silentMerges([a, b], new Set(['rm', 'n']))).toEqual([]);
  });

  it('several fields sort by name', () => {
    const a = w(st(A, 1), { n: 'x', d: 'a' });
    const b = w(st(B, 2), { n: 'y', d: 'b' });
    expect(conflicts([a, b]).map((x) => x.field)).toEqual(['d', 'n']);
  });
});

describe('delete beats edit', () => {
  const removal = (x: Write): Removal =>
    x.fields['rm'] === 1 ? 'remove' : x.fields['rm'] === 0 ? 'restore' : undefined;

  it('lists edits the deleter never saw, older or newer than the delete', () => {
    const create = w(st(A, 1), { n: 'x' });
    const before = w(st(B, 2), { n: 'offline' }, { [A]: st(A, 1) });
    const del = w(st(C, 3), { rm: 1 }, { [A]: st(A, 1) });
    const after = w(st(B, 9), { d: 'still offline' }, { [A]: st(A, 1) });
    const r = beatenEdits([create, before, del, after], removal)!;
    expect(r.removal.id).toBe(del.id);
    expect(r.edits.map((e) => e.id)).toEqual([before.id, after.id]);
  });

  it('nothing when the deleter saw the edit, after a restore, or with no delete', () => {
    const create = w(st(A, 1), { n: 'x' });
    const edit = w(st(B, 2), { n: 'y' }, { [A]: st(A, 1) });
    const seen = w(st(C, 3), { rm: 1 }, { [A]: st(A, 1), [B]: st(B, 2) });
    expect(beatenEdits([create, edit, seen], removal)).toBeUndefined();
    const del = w(st(C, 3), { rm: 1 }, { [A]: st(A, 1) });
    const back = w(st(A, 4), { rm: 0 }, { [C]: st(C, 3) });
    expect(beatenEdits([create, edit, del, back], removal)).toBeUndefined();
    expect(beatenEdits([create, edit], removal)).toBeUndefined();
    // An edit made after seeing the delete was not beaten by it.
    const later = w(st(B, 5), { d: 'z' }, { [C]: st(C, 3), [A]: st(A, 1) });
    expect(beatenEdits([create, del, later], removal)).toBeUndefined();
  });
});

/**
 * The detector against ground truth: phones that edit one record offline and
 * sync at random. A write's ground-truth "saw" set is what its phone knew
 * when it wrote; the heads must be exactly the writes nobody saw.
 */
describe('property: conflicts exactly when writes did not see each other', () => {
  interface Truth {
    write: Write;
    knew: Set<string>;
  }
  const AUTHORS = [A, B, C, 'D'.repeat(42) + 'A'];
  const FIELDS = ['n', 'd', 'p'];

  function run(rnd: () => number) {
    const clocks = new Map<string, Hlc>(AUTHORS.map((a) => [a, { wall: 0, counter: 0 }]));
    const known = new Map<string, Set<string>>(AUTHORS.map((a) => [a, new Set()]));
    const all = new Map<string, Truth>();
    let now = W0;
    let i = 0;
    const steps = int(rnd, 4, 40);
    for (let s = 0; s < steps; s++) {
      now += int(rnd, 0, 2000);
      const a = pick(rnd, AUTHORS);
      if (rnd() < 0.55) {
        const mine = known.get(a)!;
        const h = hlcTick(clocks.get(a)!, now + int(rnd, -500, 500));
        clocks.set(a, h);
        const fields: Record<string, Json> = {};
        for (const f of FIELDS) if (rnd() < 0.5) fields[f] = `${a[0]}${s}`;
        if (Object.keys(fields).length === 0) fields['n'] = `${a[0]}${s}`;
        const seen = [...mine].map((id) => all.get(id)!.write);
        i += 1;
        const write: Write = {
          id: `x${String(i).padStart(4, '0')}`,
          stamp: { ...h, author: a },
          fields,
          base: baseFrom(seen, a),
        };
        all.set(write.id, { write, knew: new Set(mine) });
        mine.add(write.id);
      } else {
        const b = pick(rnd, AUTHORS);
        for (const id of known.get(a)!) {
          if (known.get(b)!.has(id)) continue;
          known.get(b)!.add(id);
          clocks.set(b, hlcObserve(clocks.get(b)!, all.get(id)!.write.stamp, now));
        }
      }
    }
    return [...all.values()];
  }

  it('heads = writes no other write knew, per field (1,000 seeded worlds)', () => {
    forAll(712, 1000, run, (truth) => {
      const writes = truth.map((t) => t.write);
      for (const f of FIELDS) {
        const ws = truth.filter((t) => Object.prototype.hasOwnProperty.call(t.write.fields, f));
        const expected = ws
          .filter((x) => !ws.some((y) => y !== x && y.knew.has(x.write.id)))
          .map((x) => x.write.id)
          .sort();
        const c = conflicts(writes).find((x) => x.field === f);
        const got = c ? [c.kept.write.id, ...c.others.map((o) => o.write.id)].sort() : [];
        expect(got).toEqual(expected.length > 1 ? expected : []);
        if (c) {
          // The kept version is the LWW winner of the field.
          const top = [...ws].map((x) => x.write).sort(compareWrites);
          expect(c.kept.write.id).toBe(top[top.length - 1]!.id);
        }
      }
    });
  });

  it('is independent of the order writes are given in (symmetric)', () => {
    const order = mulberry32(714);
    forAll(713, 300, run, (truth) => {
      const writes = truth.map((t) => t.write);
      const a = JSON.stringify(conflicts(writes), mapsAsObjects);
      const b = JSON.stringify(conflicts(shuffle(writes, order)), mapsAsObjects);
      expect(b).toBe(a);
      expect(heads(shuffle(writes, order)).map((x) => x.id)).toEqual(
        heads(writes).map((x) => x.id),
      );
    });
  });
});

function mapsAsObjects(_k: string, v: unknown): unknown {
  return v instanceof Map ? Object.fromEntries(v) : v;
}

it('EMPTY_BASE is empty', () => {
  expect(EMPTY_BASE.size).toBe(0);
});
