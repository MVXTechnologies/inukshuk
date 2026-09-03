import type { TrackStats, TrackSummary } from '@core/models';
import { lifetimeTotals } from './lifetime';

const stats = (over: Partial<TrackStats> = {}): TrackStats => ({
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  pointCount: 2,
  ...over,
});

const track = (
  id: string,
  over: Partial<TrackSummary> & { stats?: TrackStats } = {},
): TrackSummary => ({
  id,
  name: id,
  startedAt: 1_700_000_000_000,
  stats: stats(),
  fileUri: `file:///${id}.gpx`,
  ...over,
});

describe('lifetimeTotals', () => {
  it('returns all-zero totals and no breakdown for an empty library', () => {
    expect(lifetimeTotals([])).toEqual({
      outings: 0,
      distanceM: 0,
      movingTimeS: 0,
      durationS: 0,
      ascentM: 0,
      byCategory: [],
    });
  });

  it('sums distance, moving time, wall-clock duration, ascent and outings', () => {
    const total = lifetimeTotals([
      track('a', {
        stats: stats({ distanceM: 5000, movingTimeS: 1800, durationS: 2000, ascentM: 200 }),
      }),
      track('b', {
        stats: stats({ distanceM: 12000, movingTimeS: 4000, durationS: 4500, ascentM: 750 }),
      }),
    ]);
    expect(total.outings).toBe(2);
    expect(total.distanceM).toBe(17000);
    expect(total.movingTimeS).toBe(5800);
    expect(total.durationS).toBe(6500);
    expect(total.ascentM).toBe(950);
  });

  it('breaks the totals down per category, uncategorized under null', () => {
    const total = lifetimeTotals([
      track('a', { category: 'hike', stats: stats({ distanceM: 4000, ascentM: 300 }) }),
      track('b', { category: 'hike', stats: stats({ distanceM: 6000, ascentM: 100 }) }),
      track('c', { category: 'run', stats: stats({ distanceM: 9000 }) }),
      track('d', { stats: stats({ distanceM: 1000 }) }),
      track('e', { category: '', stats: stats({ distanceM: 500 }) }),
    ]);
    expect(total.distanceM).toBe(20500);
    expect(total.byCategory).toEqual([
      {
        categoryId: 'hike',
        outings: 2,
        distanceM: 10000,
        movingTimeS: 0,
        durationS: 0,
        ascentM: 400,
      },
      { categoryId: 'run', outings: 1, distanceM: 9000, movingTimeS: 0, durationS: 0, ascentM: 0 },
      // An empty-string category is uncategorized, same bucket as no category.
      { categoryId: null, outings: 2, distanceM: 1500, movingTimeS: 0, durationS: 0, ascentM: 0 },
    ]);
  });

  it('orders the breakdown by distance, then outings, then id', () => {
    const total = lifetimeTotals([
      track('a', { category: 'zulu', stats: stats({ distanceM: 100 }) }),
      track('b', { category: 'alpha', stats: stats({ distanceM: 100 }) }),
      track('c', { category: 'bravo', stats: stats({ distanceM: 50 }) }),
      track('d', { category: 'bravo', stats: stats({ distanceM: 50 }) }),
    ]);
    expect(total.byCategory.map((c) => c.categoryId)).toEqual(['bravo', 'alpha', 'zulu']);
  });

  it('counts a track with unknown stats as an outing that adds nothing', () => {
    const broken = { ...track('x'), stats: undefined } as unknown as TrackSummary;
    const total = lifetimeTotals([track('a', { stats: stats({ distanceM: 3000 }) }), broken]);
    expect(total.outings).toBe(2);
    expect(total.distanceM).toBe(3000);
    expect(Number.isFinite(total.distanceM)).toBe(true);
  });

  it('never lets NaN or Infinity poison a total', () => {
    const total = lifetimeTotals([
      track('a', { stats: stats({ distanceM: Number.NaN, ascentM: 100 }) }),
      track('b', { stats: stats({ distanceM: Number.POSITIVE_INFINITY, movingTimeS: 60 }) }),
      track('c', { stats: stats({ distanceM: 2000, ascentM: Number.NaN }) }),
    ]);
    expect(total).toMatchObject({
      outings: 3,
      distanceM: 2000,
      ascentM: 100,
      movingTimeS: 60,
      durationS: 0,
    });
  });

  it('tolerates a stat missing from a hand-edited summary', () => {
    const partial = {
      ...track('p'),
      stats: { distanceM: 800, pointCount: 2 } as unknown as TrackStats,
    };
    const total = lifetimeTotals([partial]);
    expect(total).toMatchObject({ outings: 1, distanceM: 800, ascentM: 0, durationS: 0 });
  });

  it('does not mutate the input', () => {
    const input = [track('a', { stats: stats({ distanceM: 1000 }) })];
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    lifetimeTotals(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('keeps the overall totals equal to the sum of the breakdown', () => {
    const tracks = [
      track('a', {
        category: 'hike',
        stats: stats({ distanceM: 4000, ascentM: 120, durationS: 90 }),
      }),
      track('b', {
        category: 'bike',
        stats: stats({ distanceM: 22000, ascentM: 300, durationS: 3600 }),
      }),
      track('c', { stats: stats({ distanceM: 700, ascentM: 10, durationS: 300 }) }),
    ];
    const total = lifetimeTotals(tracks);
    const sum = (pick: (c: (typeof total.byCategory)[number]) => number) =>
      total.byCategory.reduce((acc, c) => acc + pick(c), 0);
    expect(sum((c) => c.outings)).toBe(total.outings);
    expect(sum((c) => c.distanceM)).toBe(total.distanceM);
    expect(sum((c) => c.ascentM)).toBe(total.ascentM);
    expect(sum((c) => c.durationS)).toBe(total.durationS);
  });
});
