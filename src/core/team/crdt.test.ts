import type { Json } from './canonical';
import {
  deleteOp,
  isLive,
  lastWrite,
  mergeEntity,
  mergeEntityMaps,
  mergeRegister,
  mergeRegisterMaps,
  setOp,
  visibleFields,
  type EntityState,
  type Register,
} from './crdt';
import type { Stamp } from './hlc';
import { forAll, int, pick, shuffle, type Rng } from './testing/prop';

const T = Date.UTC(2026, 9, 7);
const AUTHORS = ['alice', 'bob', 'carol'];
const FIELDS = ['name', 'note', 'status'];
const VALUES: Json[] = ['a', 'b', 1, 2, null, true, ['x'], { k: 1 }];

/** Small ranges on purpose: collisions (equal walls/counters) are where merges go wrong. */
const stamp = (rnd: Rng): Stamp => ({
  wall: T + int(rnd, 0, 3),
  counter: int(rnd, 0, 1),
  author: pick(rnd, AUTHORS),
});
const register = (rnd: Rng): Register => ({ value: pick(rnd, VALUES), stamp: stamp(rnd) });

function entity(rnd: Rng): EntityState {
  let e: EntityState = { fields: {} };
  for (let i = int(rnd, 1, 4); i > 0; i--) {
    const s = stamp(rnd);
    e = mergeEntity(
      e,
      int(rnd, 0, 3) === 0 ? deleteOp(s) : setOp({ [pick(rnd, FIELDS)]: pick(rnd, VALUES) }, s),
    );
  }
  return e;
}

const entityMap = (rnd: Rng) => {
  const m = new Map<string, EntityState>();
  for (let i = int(rnd, 0, 3); i > 0; i--) m.set(pick(rnd, ['w1', 'w2', 't1']), entity(rnd));
  return m;
};

const norm = (m: ReadonlyMap<string, unknown>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));

describe('LWW register', () => {
  it('commutative, associative, idempotent', () => {
    forAll(
      21,
      1000,
      (rnd) => [register(rnd), register(rnd), register(rnd)] as const,
      ([a, b, c]) => {
        expect(mergeRegister(a, b)).toEqual(mergeRegister(b, a));
        expect(mergeRegister(mergeRegister(a, b), c)).toEqual(
          mergeRegister(a, mergeRegister(b, c)),
        );
        expect(mergeRegister(a, a)).toEqual(a);
      },
    );
  });

  it('newer stamp wins; an equivocated tie still resolves the same everywhere', () => {
    const s: Stamp = { wall: T, counter: 0, author: 'a' };
    const old = { value: 'old', stamp: s };
    const neu = { value: 'new', stamp: { ...s, counter: 1 } };
    expect(mergeRegister(old, neu).value).toBe('new');
    expect(mergeRegister({ value: 'x', stamp: s }, { value: 'y', stamp: s }).value).toBe('y');
    expect(mergeRegister({ value: 'y', stamp: s }, { value: 'x', stamp: s }).value).toBe('y');
  });

  it('register maps merge per key with the same laws', () => {
    const map = (rnd: Rng) =>
      new Map(AUTHORS.filter(() => rnd() < 0.6).map((a) => [a, register(rnd)]));
    forAll(
      22,
      300,
      (rnd) => [map(rnd), map(rnd), map(rnd)] as const,
      ([a, b, c]) => {
        expect(norm(mergeRegisterMaps(a, b))).toEqual(norm(mergeRegisterMaps(b, a)));
        expect(norm(mergeRegisterMaps(mergeRegisterMaps(a, b), c))).toEqual(
          norm(mergeRegisterMaps(a, mergeRegisterMaps(b, c))),
        );
        expect(norm(mergeRegisterMaps(a, a))).toEqual(norm(a));
      },
    );
  });
});

describe('entity (LWW fields + tombstone)', () => {
  it('commutative, associative, idempotent', () => {
    forAll(
      23,
      1000,
      (rnd) => [entity(rnd), entity(rnd), entity(rnd)] as const,
      ([a, b, c]) => {
        expect(mergeEntity(a, b)).toEqual(mergeEntity(b, a));
        expect(mergeEntity(mergeEntity(a, b), c)).toEqual(mergeEntity(a, mergeEntity(b, c)));
        expect(mergeEntity(a, a)).toEqual(a);
      },
    );
  });

  it('any order of the same single-op states converges (op-based view)', () => {
    forAll(
      24,
      300,
      (rnd) => {
        const ops: EntityState[] = [];
        for (let i = int(rnd, 1, 8); i > 0; i--) {
          const s = stamp(rnd);
          ops.push(
            rnd() < 0.25 ? deleteOp(s) : setOp({ [pick(rnd, FIELDS)]: pick(rnd, VALUES) }, s),
          );
        }
        return { ops, order: shuffle(ops, rnd), dup: [...ops, ...ops.slice(0, 2)] };
      },
      ({ ops, order, dup }) => {
        const fold = (xs: EntityState[]) =>
          xs.reduce((acc, e) => mergeEntity(acc, e), { fields: {} } as EntityState);
        const ref = fold(ops);
        expect(fold(order)).toEqual(ref);
        expect(fold(dup)).toEqual(ref);
        expect(isLive(fold(order))).toBe(isLive(ref));
        expect(visibleFields(fold(order))).toEqual(visibleFields(ref));
      },
    );
  });

  it('tombstone wins ties; a newer edit resurrects with only the post-delete fields', () => {
    const s = (wall: number): Stamp => ({ wall, counter: 0, author: 'a' });
    const created = setOp({ name: 'Camp', note: 'water here' }, s(T));
    const deleted = mergeEntity(created, deleteOp(s(T + 1)));
    expect(isLive(deleted)).toBe(false);
    expect(visibleFields(deleted)).toEqual({});
    const tie = mergeEntity(setOp({ name: 'x' }, s(T + 1)), deleteOp(s(T + 1)));
    expect(isLive(tie)).toBe(false);
    const revived = mergeEntity(deleted, setOp({ name: 'Camp 2' }, s(T + 2)));
    expect(isLive(revived)).toBe(true);
    expect(visibleFields(revived)).toEqual({ name: 'Camp 2' });
    expect(revived.created).toEqual(s(T));
    expect(lastWrite(revived)).toEqual(s(T + 2));
    expect(isLive(deleteOp(s(T)))).toBe(false);
    expect(lastWrite(deleteOp(s(T)))).toBeUndefined();
  });

  it('two members editing different fields both keep their change', () => {
    const a = setOp({ name: 'Summit' }, { wall: T, counter: 0, author: 'alice' });
    const b = setOp({ note: 'icy' }, { wall: T, counter: 0, author: 'bob' });
    expect(visibleFields(mergeEntity(a, b))).toEqual({ name: 'Summit', note: 'icy' });
  });

  it('entity maps merge per key with the same laws', () => {
    forAll(
      25,
      300,
      (rnd) => [entityMap(rnd), entityMap(rnd), entityMap(rnd)] as const,
      ([a, b, c]) => {
        expect(norm(mergeEntityMaps(a, b))).toEqual(norm(mergeEntityMaps(b, a)));
        expect(norm(mergeEntityMaps(mergeEntityMaps(a, b), c))).toEqual(
          norm(mergeEntityMaps(a, mergeEntityMaps(b, c))),
        );
        expect(norm(mergeEntityMaps(a, a))).toEqual(norm(a));
      },
    );
  });
});
