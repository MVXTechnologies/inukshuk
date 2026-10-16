import { METRIC } from '@core/format';
import type { LngLat } from '@core/models';

import {
  distanceToLineM,
  overlapHits,
  overlapKey,
  overlapRowSubtitle,
  pickOverlap,
  type AreaCandidate,
  type TrailCandidate,
} from './overlapPick';

const LAT = 46.8;
const LNG = -71.2;
const M_LAT = 111_320;
const M_LNG = M_LAT * Math.cos((LAT * Math.PI) / 180);
/** A point `x` m east and `y` m north of the origin. */
const at = (x: number, y: number): LngLat => [LNG + x / M_LNG, LAT + y / M_LAT];

/** A straight east-west trail through `y` m north, 2 km long. */
const ew = (id: string, y: number): TrailCandidate => ({
  id,
  parts: [[at(-1000, y), at(1000, y)]],
});
/** A north-south trail through `x` m east. */
const ns = (id: string, x: number): TrailCandidate => ({
  id,
  parts: [[at(x, -1000), at(x, 1000)]],
});
/** A square area of side `s` m centred on the origin. */
const square = (id: string, s: number): AreaCandidate => ({
  id,
  ring: [at(-s / 2, -s / 2), at(s / 2, -s / 2), at(s / 2, s / 2), at(-s / 2, s / 2)],
});

describe('distanceToLineM', () => {
  it('measures to the nearest segment, clamped to its ends', () => {
    expect(distanceToLineM(at(0, 30), [at(-100, 0), at(100, 0)])).toBeCloseTo(30, 0);
    expect(distanceToLineM(at(140, 0), [at(-100, 0), at(100, 0)])).toBeCloseTo(40, 0);
    expect(distanceToLineM(at(0, 0), [])).toBe(Infinity);
    expect(distanceToLineM(at(3, 4), [at(0, 0)])).toBeCloseTo(5, 0);
  });

  it('closes a ring when asked', () => {
    const ring = square('a', 200).ring;
    // The closing edge (west side, x = -100) is only measured for a closed ring.
    expect(distanceToLineM(at(-110, 0), ring, true)).toBeCloseTo(10, 0);
    expect(distanceToLineM(at(-110, 0), ring, false)).toBeGreaterThan(10);
  });
});

describe('overlapHits', () => {
  it('keeps only the trails within the finger, nearest first', () => {
    const hits = overlapHits(at(0, 7), 12, [ew('far', 40), ew('b', 10), ew('a', 0)], []);
    expect(hits.map(overlapKey)).toEqual(['trail:b', 'trail:a']);
  });

  it('is zoom-aware: the same tap misses at street zoom and hits zoomed out', () => {
    const trails = [ew('t', 30)];
    // ~0.5 m/px × 22 px finger ≈ 11 m: the line 30 m away is not under it.
    expect(overlapHits(at(0, 0), 11, trails, [])).toEqual([]);
    // ~5 m/px × 22 px ≈ 110 m: it is.
    expect(overlapHits(at(0, 0), 110, trails, []).map(overlapKey)).toEqual(['trail:t']);
  });

  it('trusts the coarse lookup for a trail whose geometry is not loaded', () => {
    expect(overlapHits(at(0, 0), 20, [{ id: 'heat', parts: null }], [])).toEqual([
      { kind: 'trail', id: 'heat', distanceM: 20 },
    ]);
  });

  it('lists a duplicated candidate once', () => {
    expect(overlapHits(at(0, 0), 20, [ew('a', 0), ew('a', 0)], [])).toHaveLength(1);
  });

  it('a tap in the open part of an area is the area, even with a trail 40 m away', () => {
    // The old fixed ±50 m grid window made that trail win every such tap.
    const hits = overlapHits(at(0, 0), 15, [ew('t', 40)], [square('camp', 1000)]);
    expect(pickOverlap(hits)).toEqual({
      kind: 'one',
      hit: { kind: 'area', id: 'camp', sizeM2: expect.any(Number) },
    });
  });

  it('counts a tap on an area outline from outside', () => {
    expect(overlapHits(at(-505, 0), 10, [], [square('camp', 1000)]).map(overlapKey)).toEqual([
      'area:camp',
    ]);
    expect(overlapHits(at(-530, 0), 10, [], [square('camp', 1000)])).toEqual([]);
  });

  it('puts trails first, then nested areas smallest first', () => {
    const hits = overlapHits(
      at(0, 0),
      15,
      [ns('ride', 3), ew('hike', -2)],
      // A ring too short to be an area is never a candidate.
      [square('big', 2000), square('small', 100), { id: 'broken', ring: [at(0, 0), at(1, 1)] }],
    );
    expect(hits.map(overlapKey)).toEqual(['trail:hike', 'trail:ride', 'area:small', 'area:big']);
  });
});

describe('pickOverlap', () => {
  it('none, one or a choice', () => {
    expect(pickOverlap([])).toEqual({ kind: 'none' });
    const one = { kind: 'trail' as const, id: 'a', distanceM: 1 };
    expect(pickOverlap([one])).toEqual({ kind: 'one', hit: one });
    const two = [one, { kind: 'area' as const, id: 'b', sizeM2: 5 }];
    expect(pickOverlap(two)).toEqual({ kind: 'choose', hits: two });
  });

  it('two crossing trails of different kinds open the chooser (the "selects nothing" bug)', () => {
    const hits = overlapHits(at(1, 1), 15, [ew('hike', 0), ns('ride', 0)], []);
    expect(pickOverlap(hits).kind).toBe('choose');
  });

  it('a smaller area inside a larger one: both are offered', () => {
    const hits = overlapHits(at(0, 0), 5, [], [square('big', 2000), square('small', 100)]);
    const pick = pickOverlap(hits);
    expect(pick.kind === 'choose' && pick.hits.map(overlapKey)).toEqual(['area:small', 'area:big']);
  });
});

describe('overlapRowSubtitle', () => {
  const now = new Date(2026, 9, 16).getTime();
  it('trail: kind, length, date', () => {
    const startedAt = new Date(2026, 9, 12, 9, 12).getTime();
    expect(
      overlapRowSubtitle(
        { kind: 'trail', typeName: 'Hike', planned: false, distanceM: 12_400, startedAt },
        METRIC,
        now,
      ),
    ).toMatch(/^Hike · 12\.4 km · Oct 12$/);
  });

  it('uncategorized trail and untimed route', () => {
    expect(
      overlapRowSubtitle(
        { kind: 'trail', typeName: null, planned: true, distanceM: 8_200, startedAt: 0 },
        METRIC,
        now,
      ),
    ).toBe('Route · 8.2 km');
    expect(
      overlapRowSubtitle(
        { kind: 'trail', typeName: null, planned: false, distanceM: 800, startedAt: 0 },
        METRIC,
        now,
      ),
    ).toBe('Trail · 800 m');
  });

  it('area: its size', () => {
    expect(overlapRowSubtitle({ kind: 'area', sizeM2: 2_400_000 }, METRIC, now)).toBe(
      'Area · 2.4 km²',
    );
  });
});
