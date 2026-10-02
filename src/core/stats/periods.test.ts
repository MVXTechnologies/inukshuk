import {
  activityChips,
  addLocalMonths,
  averageKind,
  averageValue,
  comparisonLine,
  comparisonWindow,
  MAX_YEAR_BARS,
  periodBars,
  periodWindow,
  statsTracks,
  totalsIn,
} from './periods';
import { summary } from './testTracks';

// Friday, Oct 2 2026, noon local. Its week started Monday Sep 28.
const NOW = new Date(2026, 9, 2, 12).getTime();
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();

describe('statsTracks / activityChips', () => {
  const tracks = [
    summary({ startedAt: at(2026, 9, 1), category: 'bike' }),
    summary({ startedAt: at(2026, 9, 1), category: 'run' }),
    summary({ startedAt: at(2026, 9, 1), category: 'walk' }),
    summary({ startedAt: at(2026, 9, 1), category: 'custom-b' }),
    summary({ startedAt: at(2026, 9, 1), category: 'custom-a' }),
    summary({ startedAt: at(2026, 9, 1), category: 'navigation' }),
    summary({
      startedAt: at(2026, 9, 1),
      category: 'hike',
      plan: { mode: 'trails', vertices: [] },
    }),
    summary({ startedAt: at(2026, 9, 1), category: undefined }),
  ];

  it('offers only the activities the user has, in the board order', () => {
    expect(activityChips(tracks)).toEqual(['run', 'bike', 'walk', 'custom-a', 'custom-b']);
  });

  it('filters like the Logbook: All = every performed activity', () => {
    expect(statsTracks(tracks, null)).toHaveLength(6);
    expect(statsTracks(tracks, 'run')).toHaveLength(1);
    expect(statsTracks(tracks, 'hike')).toHaveLength(0);
  });
});

describe('periodWindow / comparisonWindow', () => {
  it('starts each period at its local start (Monday weeks)', () => {
    expect(periodWindow('week', NOW).startMs).toBe(at(2026, 8, 28, 0));
    expect(periodWindow('month', NOW).startMs).toBe(at(2026, 9, 1, 0));
    expect(periodWindow('year', NOW).startMs).toBe(at(2026, 0, 1, 0));
    expect(periodWindow('all', NOW).startMs).toBe(Number.NEGATIVE_INFINITY);
    expect(periodWindow('week', NOW).endMs).toBe(NOW + 1);
  });

  it('compares with the same stretch of the previous period', () => {
    expect(comparisonWindow('week', NOW)).toEqual({
      window: { startMs: at(2026, 8, 21, 0), endMs: new Date(2026, 8, 25, 12).getTime() + 1 },
      label: 'vs last week',
    });
    expect(comparisonWindow('month', NOW)?.window).toEqual({
      startMs: at(2026, 8, 1, 0),
      endMs: new Date(2026, 8, 2, 12).getTime() + 1,
    });
    expect(comparisonWindow('year', NOW)).toEqual({
      window: { startMs: at(2025, 0, 1, 0), endMs: new Date(2025, 9, 2, 12).getTime() + 1 },
      label: 'vs same date last year',
    });
    expect(comparisonWindow('all', NOW)).toBeNull();
  });

  it('clamps month arithmetic to the month end', () => {
    expect(addLocalMonths(at(2026, 2, 31, 8), -1)).toBe(at(2026, 1, 28, 8));
    expect(addLocalMonths(at(2024, 1, 29, 8), -12)).toBe(at(2023, 1, 28, 8));
  });
});

describe('totalsIn / comparisonLine', () => {
  const tracks = [
    summary({
      startedAt: at(2026, 9, 1),
      stats: { distanceM: 12200, movingTimeS: 3600, ascentM: 100 },
    }),
    summary({
      startedAt: at(2026, 0, 3),
      stats: { distanceM: 10000, movingTimeS: 3000, ascentM: 50 },
    }),
    // Last year, before the same date / after it.
    summary({ startedAt: at(2025, 4, 3), stats: { distanceM: 18200 } }),
    summary({ startedAt: at(2025, 10, 3), stats: { distanceM: 99000 } }),
  ];

  it('sums the trails in a window', () => {
    expect(totalsIn(tracks, periodWindow('year', NOW))).toEqual({
      distanceM: 22200,
      movingTimeS: 6600,
      ascentM: 150,
      count: 2,
    });
  });

  it('adds only a count for a summary without stats', () => {
    const broken = { ...tracks[0]!, stats: undefined as never };
    expect(totalsIn([broken], periodWindow('all', NOW))).toEqual({
      distanceM: 0,
      movingTimeS: 0,
      ascentM: 0,
      count: 1,
    });
  });

  it('reads the change in distance', () => {
    expect(comparisonLine(tracks, 'year', NOW)).toEqual({
      text: '+22 % vs same date last year',
      delta: expect.closeTo(0.2198, 3),
    });
    expect(comparisonLine(tracks, 'all', NOW)).toBeNull();
  });

  it('says so when there is nothing to compare with, or no change', () => {
    expect(comparisonLine(tracks, 'week', NOW)?.text).toBe(
      'Nothing logged by this point last week',
    );
    expect(comparisonLine(tracks, 'month', NOW)?.text).toBe(
      'Nothing logged by this date last month',
    );
    expect(comparisonLine([], 'year', NOW)?.text).toBe('Nothing logged by this date last year');
    const same = [
      summary({ startedAt: at(2026, 9, 1), stats: { distanceM: 5000 } }),
      summary({ startedAt: at(2026, 8, 22), stats: { distanceM: 5010 } }),
    ];
    expect(comparisonLine(same, 'week', NOW)).toEqual({
      text: 'Same distance vs last week',
      delta: 0,
    });
    const down = [
      summary({ startedAt: at(2026, 9, 1), stats: { distanceM: 4000 } }),
      summary({ startedAt: at(2026, 8, 22), stats: { distanceM: 5000 } }),
    ];
    expect(comparisonLine(down, 'week', NOW)?.text).toBe('−20 % vs last week');
  });
});

describe('periodBars', () => {
  const tracks = [
    summary({ startedAt: at(2026, 9, 2, 7), stats: { distanceM: 5000 } }),
    summary({ startedAt: at(2026, 8, 28, 7), stats: { distanceM: 3000 } }),
    summary({ startedAt: at(2026, 6, 10), stats: { distanceM: 8000 } }),
    summary({ startedAt: at(2023, 6, 10), stats: { distanceM: 1000 } }),
    // In the future (a clock change): never placed.
    summary({ startedAt: at(2030, 0, 1), stats: { distanceM: 1 } }),
  ];

  it('Week: Mon–Sun of this week, today current', () => {
    const bars = periodBars(tracks, 'week', NOW);
    expect(bars.map((b) => b.label)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(bars.map((b) => b.distanceM)).toEqual([3000, 0, 0, 0, 5000, 0, 0]);
    expect(bars.findIndex((b) => b.current)).toBe(4);
  });

  it('Month: the last 12 weeks, this one current', () => {
    const bars = periodBars(tracks, 'month', NOW);
    expect(bars).toHaveLength(12);
    expect(bars[11]).toMatchObject({ label: 'Sep 28', distanceM: 8000, count: 2, current: true });
    expect(bars[0]!.label).toBe('Jul 13');
    expect(bars.reduce((s, b) => s + b.distanceM, 0)).toBe(8000);
  });

  it('Year: Jan–Dec of this year', () => {
    const bars = periodBars(tracks, 'year', NOW);
    expect(bars.map((b) => b.label).join('')).toBe('JFMAMJJASOND');
    expect(bars[6]!.distanceM).toBe(8000);
    expect(bars[8]!.distanceM).toBe(3000);
    expect(bars[9]).toMatchObject({ distanceM: 5000, current: true });
  });

  it('All time: one bar per year from the first activity', () => {
    const bars = periodBars(tracks, 'all', NOW);
    expect(bars.map((b) => b.label)).toEqual(['2023', '2024', '2025', '2026']);
    expect(bars.map((b) => b.distanceM)).toEqual([1000, 0, 0, 16000]);
    expect(bars[3]!.current).toBe(true);
  });

  it('All time: caps the number of years', () => {
    const old = [summary({ startedAt: at(1990, 0, 1) })];
    const bars = periodBars(old, 'all', NOW);
    expect(bars).toHaveLength(MAX_YEAR_BARS);
    expect(bars[MAX_YEAR_BARS - 1]!.label).toBe('2026');
    expect(periodBars([], 'all', NOW).map((b) => b.label)).toEqual(['2026']);
  });

  it('a summary without stats adds only its count', () => {
    const broken = { ...summary({ startedAt: at(2026, 9, 1) }), stats: undefined as never };
    expect(periodBars([broken], 'week', NOW)[3]).toMatchObject({ count: 1, distanceM: 0 });
  });
});

describe('averageKind / averageValue', () => {
  it('picks the natural average per activity', () => {
    expect(averageKind('run')).toBe('pace');
    expect(averageKind('trail-run')).toBe('pace');
    expect(averageKind('bike')).toBe('speed');
    expect(averageKind('ski')).toBe('speed');
    expect(averageKind('hike')).toBe('climb');
    expect(averageKind(null)).toBe('distance');
    expect(averageKind('custom-x')).toBe('distance');
  });

  it('computes it, null when nothing to average', () => {
    const t = { distanceM: 10000, movingTimeS: 2500, ascentM: 300, count: 2 };
    expect(averageValue(t, 'pace')).toBe(4);
    expect(averageValue(t, 'speed')).toBe(4);
    expect(averageValue(t, 'climb')).toBe(150);
    expect(averageValue(t, 'distance')).toBe(5000);
    expect(averageValue({ ...t, movingTimeS: 0 }, 'pace')).toBeNull();
    expect(averageValue({ ...t, count: 0 }, 'distance')).toBeNull();
  });
});
