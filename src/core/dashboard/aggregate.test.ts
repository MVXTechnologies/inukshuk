/**
 * TZ pinned before any Date use so local-time assertions are deterministic in
 * CI (jest.config sets no TZ; process-level assignment works because this file
 * constructs its first Date after the assignment).
 */
/* eslint-disable import/first */
process.env.TZ = 'America/Toronto';

import type { TrackSummary, TrackStats } from '@core/models';
import {
  addLocalDays,
  aggregateBuckets,
  calendarIndex,
  isPerformedActivity,
  matchesCategoryFilter,
  startOfLocalDay,
  startOfLocalWeek,
} from './aggregate';

const stats = (over: Partial<TrackStats> = {}): TrackStats => ({
  distanceM: 5000,
  ascentM: 120,
  descentM: 110,
  durationS: 3600,
  movingTimeS: 3000,
  avgSpeedMps: 1.6,
  maxSpeedMps: 3,
  pointCount: 100,
  ...over,
});

let seq = 0;
const track = (startedAt: number, over: Partial<TrackSummary> = {}): TrackSummary => ({
  id: `t${++seq}`,
  name: `Track ${seq}`,
  startedAt,
  stats: stats(),
  fileUri: 'file:///x.gpx',
  ...over,
});

/** Local-time constructor shorthand. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo, d, h, mi).getTime();

describe('startOfLocalDay / addLocalDays across DST', () => {
  it('is local midnight', () => {
    const t = at(2026, 6, 24, 15, 30);
    const start = startOfLocalDay(t);
    const d = new Date(start);
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
    expect(d.getDate()).toBe(24);
  });

  it('stays midnight-aligned across spring-forward (2026-03-08)', () => {
    const before = startOfLocalDay(at(2026, 2, 7));
    const after = addLocalDays(before, 2); // crosses the 23-hour day
    const d = new Date(after);
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([2, 9, 0]);
  });

  it('stays midnight-aligned across fall-back (2026-11-01)', () => {
    const before = startOfLocalDay(at(2026, 9, 31));
    const after = addLocalDays(before, 2); // crosses the 25-hour day
    const d = new Date(after);
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([10, 2, 0]);
  });
});

describe('startOfLocalWeek (Monday start)', () => {
  it('maps a Wednesday to its Monday', () => {
    // 2026-07-22 is a Wednesday; its Monday is 2026-07-20.
    const monday = new Date(startOfLocalWeek(at(2026, 6, 22)));
    expect([monday.getDay(), monday.getDate()]).toEqual([1, 20]);
  });

  it('maps a Sunday to the PREVIOUS Monday', () => {
    // 2026-07-26 is a Sunday → Monday 2026-07-20.
    const monday = new Date(startOfLocalWeek(at(2026, 6, 26)));
    expect([monday.getDay(), monday.getDate()]).toEqual([1, 20]);
  });

  it('maps Monday 00:00 to itself', () => {
    const mondayMidnight = new Date(2026, 6, 20, 0, 0).getTime();
    expect(startOfLocalWeek(mondayMidnight)).toBe(mondayMidnight);
  });
});

describe('isPerformedActivity / matchesCategoryFilter', () => {
  it.each([
    [undefined, true],
    ['run', true],
    ['custom-x', true],
    ['navigation', false],
  ])('isPerformedActivity(category=%p) → %p', (category, expected) => {
    expect(isPerformedActivity(category === undefined ? {} : { category })).toBe(expected);
  });

  it('null filter = all performed (excludes navigation, keeps uncategorized/dangling)', () => {
    expect(matchesCategoryFilter({}, null)).toBe(true);
    expect(matchesCategoryFilter({ category: 'deleted-custom' }, null)).toBe(true);
    expect(matchesCategoryFilter({ category: 'navigation' }, null)).toBe(false);
  });

  it('explicit filters match strictly', () => {
    expect(matchesCategoryFilter({ category: 'run' }, 'run')).toBe(true);
    expect(matchesCategoryFilter({ category: 'hike' }, 'run')).toBe(false);
    expect(matchesCategoryFilter({}, 'run')).toBe(false);
    expect(matchesCategoryFilter({ category: 'navigation' }, 'navigation')).toBe(true);
  });
});

describe('aggregateBuckets', () => {
  const now = at(2026, 6, 24, 14); // Friday 2026-07-24

  it.each([
    ['7d', 7],
    ['3m', 13],
    ['1y', 52],
  ] as const)('%s → exactly %i buckets, oldest → newest, last contains now', (period, count) => {
    const buckets = aggregateBuckets([], period, now, null);
    expect(buckets).toHaveLength(count);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.startMs).toBe(buckets[i - 1]!.endMs);
    }
    const last = buckets[buckets.length - 1]!;
    expect(now).toBeGreaterThanOrEqual(last.startMs);
    expect(now).toBeLessThan(last.endMs);
  });

  it('sums a week and lists ids newest-first; empty buckets zeroed', () => {
    const a = track(at(2026, 6, 21, 9), {
      stats: stats({ distanceM: 3000, ascentM: 50, movingTimeS: 1000 }),
    });
    const b = track(at(2026, 6, 22, 9), {
      stats: stats({ distanceM: 7000, ascentM: 150, movingTimeS: 2000 }),
    });
    const buckets = aggregateBuckets([a, b], '3m', now, null);
    const last = buckets[buckets.length - 1]!;
    expect(last.distanceM).toBe(10000);
    expect(last.ascentM).toBe(200);
    expect(last.movingTimeS).toBe(3000);
    expect(last.trackIds).toEqual([b.id, a.id]);
    expect(buckets[0]!.distanceM).toBe(0);
    expect(buckets[0]!.trackIds).toEqual([]);
  });

  it('places Sunday 23:59 and Monday 00:00 in different weekly buckets', () => {
    const sunday = track(new Date(2026, 6, 19, 23, 59).getTime());
    const monday = track(new Date(2026, 6, 20, 0, 0).getTime());
    const buckets = aggregateBuckets([sunday, monday], '3m', now, null);
    const last = buckets[buckets.length - 1]!;
    const prev = buckets[buckets.length - 2]!;
    expect(last.trackIds).toEqual([monday.id]);
    expect(prev.trackIds).toContain(sunday.id);
  });

  it("'7d' is today plus the 6 previous local days (not rolling 168h)", () => {
    const buckets = aggregateBuckets([], '7d', now, null);
    expect(buckets[0]!.startMs).toBe(startOfLocalDay(addLocalDays(now, -6)));
    expect(buckets[6]!.startMs).toBe(startOfLocalDay(now));
  });

  it('excludes tracks outside the window and non-matching categories', () => {
    const old = track(at(2026, 3, 1)); // months before the 7d window
    const ski = track(at(2026, 6, 24, 8), { category: 'ski' });
    const nav = track(at(2026, 6, 24, 9), { category: 'navigation' });
    const all = aggregateBuckets([old, ski, nav], '7d', now, null);
    expect(all.flatMap((b) => b.trackIds)).toEqual([ski.id]);
    const skiOnly = aggregateBuckets([old, ski, nav], '7d', now, 'ski');
    expect(skiOnly.flatMap((b) => b.trackIds)).toEqual([ski.id]);
    const navOnly = aggregateBuckets([old, ski, nav], '7d', now, 'navigation');
    expect(navOnly.flatMap((b) => b.trackIds)).toEqual([nav.id]);
  });
});

describe('calendarIndex', () => {
  it('returns only days with matches, ascending, chronological within a day', () => {
    const early = track(at(2026, 6, 8, 7), { category: 'run' });
    const late = track(at(2026, 6, 8, 18), { category: 'hike' });
    const other = track(at(2026, 6, 20, 10));
    const idx = calendarIndex([late, other, early], 2026, 6, null);
    expect(idx.map((e) => e.day)).toEqual([8, 20]);
    expect(idx[0]!.tracks.map((t) => t.id)).toEqual([early.id, late.id]);
    expect(idx[0]!.tracks[0]).toEqual({ id: early.id, category: 'run' });
  });

  it('respects month/year boundaries (Dec vs Jan)', () => {
    const dec = track(at(2025, 11, 31, 23));
    const jan = track(at(2026, 0, 1, 0, 30));
    expect(calendarIndex([dec, jan], 2025, 11, null).map((e) => e.day)).toEqual([31]);
    expect(calendarIndex([dec, jan], 2026, 0, null).map((e) => e.day)).toEqual([1]);
  });

  it('applies the category filter', () => {
    const nav = track(at(2026, 6, 10), { category: 'navigation' });
    const run = track(at(2026, 6, 11), { category: 'run' });
    expect(calendarIndex([nav, run], 2026, 6, null).map((e) => e.day)).toEqual([11]);
    expect(calendarIndex([nav, run], 2026, 6, 'navigation').map((e) => e.day)).toEqual([10]);
  });
});
