import {
  compareHlc,
  compareStamp,
  hlcObserve,
  hlcTick,
  hlcToWire,
  isTooFarAhead,
  MAX_COUNTER,
  MAX_FUTURE_SKEW_MS,
  maxStamp,
  MIN_WALL,
  parseHlc,
  ZERO_HLC,
  type Hlc,
} from './hlc';
import { forAll, int, pick } from './testing/prop';

const T = Date.UTC(2026, 9, 7);

describe('hlc', () => {
  it('ticks monotonically even when the wall clock goes backwards', () => {
    const a = hlcTick(ZERO_HLC, T);
    expect(a).toEqual({ wall: T, counter: 0 });
    const b = hlcTick(a, T);
    expect(b).toEqual({ wall: T, counter: 1 });
    const c = hlcTick(b, T - 60_000);
    expect(compareHlc(c, b)).toBeGreaterThan(0);
    expect(hlcTick(c, NaN).wall).toBe(T);
  });

  it('rolls the counter over into the wall', () => {
    expect(hlcTick({ wall: T, counter: MAX_COUNTER }, T)).toEqual({ wall: T + 1, counter: 0 });
  });

  it('observe moves past both clocks', () => {
    const local: Hlc = { wall: T, counter: 3 };
    expect(hlcObserve(local, { wall: T, counter: 7 }, T - 1)).toEqual({ wall: T, counter: 8 });
    expect(hlcObserve(local, { wall: T + 5, counter: 2 }, T)).toEqual({ wall: T + 5, counter: 3 });
    expect(hlcObserve(local, { wall: T - 5, counter: 2 }, T)).toEqual({ wall: T, counter: 4 });
    expect(hlcObserve(local, { wall: T - 5, counter: 2 }, T + 9)).toEqual({
      wall: T + 9,
      counter: 0,
    });
  });

  it('property: observe is ≥ both inputs and tick strictly advances', () => {
    forAll(
      3,
      500,
      (rnd) => ({
        local: { wall: T + int(rnd, -5, 5), counter: int(rnd, 0, 5) },
        remote: { wall: T + int(rnd, -5, 5), counter: int(rnd, 0, 5) },
        now: T + int(rnd, -5, 5),
      }),
      ({ local, remote, now }) => {
        const o = hlcObserve(local, remote, now);
        expect(compareHlc(o, local)).toBeGreaterThan(0);
        expect(compareHlc(o, remote)).toBeGreaterThan(0);
        expect(compareHlc(hlcTick(o, now), o)).toBeGreaterThan(0);
      },
    );
  });

  it('parses only well-formed wire stamps', () => {
    expect(parseHlc([T, 0])).toEqual({ wall: T, counter: 0 });
    for (const bad of [
      [T],
      [T, -1],
      [T, MAX_COUNTER + 1],
      [MIN_WALL - 1, 0],
      [T + 0.5, 0],
      'x',
      [T, '0'],
    ]) {
      expect(parseHlc(bad)).toBeUndefined();
    }
    expect(hlcToWire({ wall: T, counter: 2 })).toEqual([T, 2]);
  });

  it('bounds future skew with the M0 constant', () => {
    expect(isTooFarAhead({ wall: T + MAX_FUTURE_SKEW_MS, counter: 0 }, T)).toBe(false);
    expect(isTooFarAhead({ wall: T + MAX_FUTURE_SKEW_MS + 1, counter: 0 }, T)).toBe(true);
    expect(isTooFarAhead({ wall: T + 10, counter: 0 }, T, 5)).toBe(true);
  });

  it('stamps are totally ordered, ties broken by author', () => {
    const s = (wall: number, counter: number, author: string) => ({ wall, counter, author });
    expect(compareStamp(s(T, 0, 'b'), s(T, 0, 'a'))).toBeGreaterThan(0);
    expect(compareStamp(s(T, 1, 'a'), s(T, 0, 'b'))).toBeGreaterThan(0);
    expect(compareStamp(s(T, 0, 'a'), s(T, 0, 'a'))).toBe(0);
    forAll(
      4,
      300,
      (rnd) => [0, 1, 2].map(() => s(T + int(rnd, 0, 1), int(rnd, 0, 1), pick(rnd, ['a', 'b']))),
      ([a, b, c]) => {
        expect(Math.sign(compareStamp(a!, b!)) + Math.sign(compareStamp(b!, a!))).toBe(0);
        if (compareStamp(a!, b!) <= 0 && compareStamp(b!, c!) <= 0) {
          expect(compareStamp(a!, c!)).toBeLessThanOrEqual(0);
        }
      },
    );
    expect(maxStamp(undefined, s(T, 0, 'a'))).toEqual(s(T, 0, 'a'));
    expect(maxStamp(s(T, 0, 'a'), undefined)).toEqual(s(T, 0, 'a'));
    expect(maxStamp(s(T, 0, 'a'), s(T, 0, 'b'))).toEqual(s(T, 0, 'b'));
  });
});
