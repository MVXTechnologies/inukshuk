import { computeTrackStats } from '@core/geo/track';
import type { TrackStats, TrackSummary } from '@core/models';
import {
  activityCaption,
  activityStatsLine,
  bucketLabel,
  CHART_BUCKETS,
  countsByType,
  distanceSeries,
  distanceUnitMeters,
  heroClimb,
  heroDistance,
  heroTime,
  labelledBars,
  niceAxisMax,
  recentActivities,
  sinceLabel,
  startOfLocalMonth,
  startOfLocalYear,
} from './logbook';

function stats(partial: Partial<TrackStats>): TrackStats {
  return { ...computeTrackStats([]), ...partial };
}

function track(
  id: string,
  startedAt: Date,
  distanceM: number,
  category?: string,
  extra: Partial<TrackStats> = {},
): TrackSummary {
  return {
    id,
    name: id,
    fileUri: `${id}.gpx`,
    startedAt: startedAt.getTime(),
    stats: stats({ distanceM, ...extra }),
    ...(category !== undefined ? { category } : {}),
  };
}

// Wednesday 2026-09-23, mid-afternoon local time.
const NOW = new Date(2026, 8, 23, 15).getTime();

describe('distanceSeries', () => {
  it('gives 12 Monday weeks ending with the current one', () => {
    const series = distanceSeries([], 'week', NOW, null);
    expect(series).toHaveLength(CHART_BUCKETS.week);
    expect(series.at(-1)?.startMs).toBe(new Date(2026, 8, 21).getTime());
    expect(series[0]?.startMs).toBe(new Date(2026, 6, 6).getTime());
    for (const b of series) expect(b.trackIds).toEqual([]);
  });

  it('gives 12 calendar months and 5 years', () => {
    const months = distanceSeries([], 'month', NOW, null);
    expect(months).toHaveLength(12);
    expect(months[0]?.startMs).toBe(new Date(2025, 9, 1).getTime());
    expect(months.at(-1)?.endMs).toBe(new Date(2026, 9, 1).getTime());
    const years = distanceSeries([], 'year', NOW, null);
    expect(years.map((b) => new Date(b.startMs).getFullYear())).toEqual([
      2022, 2023, 2024, 2025, 2026,
    ]);
  });

  it('sums each bucket and applies the category filter', () => {
    const tracks = [
      track('a', new Date(2026, 8, 22, 9), 5000, 'hike', { ascentM: 300, movingTimeS: 3600 }),
      track('b', new Date(2026, 8, 23, 9), 7000, 'run'),
      track('c', new Date(2026, 8, 14, 9), 3000, 'hike'),
      track('nav', new Date(2026, 8, 22, 9), 90_000, 'navigation'),
      track('old', new Date(2020, 0, 1), 1000, 'hike'),
    ];
    const all = distanceSeries(tracks, 'week', NOW, null);
    expect(all.at(-1)).toMatchObject({
      distanceM: 12_000,
      ascentM: 300,
      movingTimeS: 3600,
      trackIds: ['b', 'a'],
    });
    expect(all.at(-2)?.distanceM).toBe(3000);
    const hikes = distanceSeries(tracks, 'week', NOW, 'hike');
    expect(hikes.at(-1)?.distanceM).toBe(5000);
    const monthly = distanceSeries(tracks, 'month', NOW, null);
    expect(monthly.at(-1)?.distanceM).toBe(15_000);
  });

  it('tolerates a track without stats', () => {
    const broken = { ...track('x', new Date(2026, 8, 22), 0) } as Partial<TrackSummary>;
    delete broken.stats;
    const series = distanceSeries([broken as TrackSummary], 'week', NOW, null);
    expect(series.at(-1)).toMatchObject({ distanceM: 0, trackIds: ['x'] });
  });
});

describe('local calendar helpers', () => {
  it('finds month and year starts', () => {
    expect(startOfLocalMonth(NOW)).toBe(new Date(2026, 8, 1).getTime());
    expect(startOfLocalYear(NOW)).toBe(new Date(2026, 0, 1).getTime());
  });

  it('labels bars', () => {
    expect(bucketLabel(new Date(2026, 6, 7).getTime(), 'week')).toBe('Jul 7');
    expect(bucketLabel(new Date(2026, 6, 1).getTime(), 'month')).toBe('Jul');
    expect(bucketLabel(new Date(2025, 0, 1).getTime(), 'year')).toBe('2025');
  });

  it('spaces the x labels and leaves the last bar to "Now"', () => {
    expect(labelledBars(12, 'week')).toEqual([0, 4, 8]);
    expect(labelledBars(12, 'month')).toEqual([0, 3, 6, 9]);
    expect(labelledBars(5, 'year')).toEqual([0, 1, 2, 3]);
  });
});

describe('niceAxisMax', () => {
  it('rounds up to a two-step 1/2/5 ceiling (board: 36 km → 40)', () => {
    expect(niceAxisMax(36)).toBe(40);
    expect(niceAxisMax(21)).toBe(40);
    expect(niceAxisMax(9)).toBe(10);
    expect(niceAxisMax(120)).toBe(200);
    expect(niceAxisMax(0.3)).toBe(2);
    expect(niceAxisMax(0)).toBe(2);
    expect(niceAxisMax(Number.NaN)).toBe(2);
  });

  it('knows the display unit', () => {
    expect(distanceUnitMeters('metric')).toBe(1000);
    expect(distanceUnitMeters('imperial')).toBeCloseTo(1609.344);
  });
});

describe('hero numbers', () => {
  it('formats distance like the board', () => {
    expect(heroDistance(412_300, 'metric')).toEqual({ value: '412', unit: 'km' });
    expect(heroDistance(4_240, 'metric')).toEqual({ value: '4.2', unit: 'km' });
    expect(heroDistance(840, 'metric')).toEqual({ value: '840', unit: 'm' });
    expect(heroDistance(1_234_000, 'metric')).toEqual({ value: '1,234', unit: 'km' });
    expect(heroDistance(16_093, 'imperial')).toEqual({ value: '10', unit: 'mi' });
    expect(heroDistance(8_047, 'imperial')).toEqual({ value: '5', unit: 'mi' });
    expect(heroDistance(30, 'imperial')).toEqual({ value: '98', unit: 'ft' });
    expect(heroDistance(Number.NaN, 'metric')).toEqual({ value: '0', unit: 'm' });
  });

  it('formats time', () => {
    expect(heroTime(118 * 3600 + 1200)).toEqual({ value: '118', unit: 'h' });
    expect(heroTime(4.5 * 3600)).toEqual({ value: '4.5', unit: 'h' });
    expect(heroTime(45 * 60)).toEqual({ value: '45', unit: 'min' });
  });

  it('formats the climb, switching to km past 10 km', () => {
    expect(heroClimb(21_400, 'metric')).toEqual({ value: '21.4', unit: 'km' });
    expect(heroClimb(1_068, 'metric')).toEqual({ value: '1,068', unit: 'm' });
    expect(heroClimb(1_000, 'imperial')).toEqual({ value: '3,281', unit: 'ft' });
    expect(heroClimb(21_400, 'imperial')).toEqual({ value: '70.2', unit: 'k ft' });
  });

  it('dates the logbook from its oldest activity', () => {
    expect(sinceLabel([{ startedAt: NOW }, { startedAt: new Date(2025, 2, 14).getTime() }])).toBe(
      'SINCE MAR 2025',
    );
    expect(sinceLabel([])).toBeNull();
  });
});

describe('countsByType', () => {
  it('always lists the four headline types, then the rest by count', () => {
    const counts = countsByType([
      { category: 'run' },
      { category: 'run' },
      { category: 'walk' },
      { category: 'snowshoe' },
      { category: 'snowshoe' },
      { category: 'navigation' },
      {},
      { category: '' },
    ]);
    expect(counts).toEqual([
      { categoryId: 'hike', count: 0 },
      { categoryId: 'run', count: 2 },
      { categoryId: 'ski', count: 0 },
      { categoryId: 'bike', count: 0 },
      { categoryId: 'snowshoe', count: 2 },
      { categoryId: 'walk', count: 1 },
    ]);
  });
});

describe('recentActivities', () => {
  it('returns the newest performed activities, filtered and capped', () => {
    const tracks = [
      track('old', new Date(2026, 0, 1), 1, 'hike'),
      track('new', new Date(2026, 8, 1), 1, 'run'),
      track('nav', new Date(2026, 8, 20), 1, 'navigation'),
      track('mid', new Date(2026, 5, 1), 1, 'hike'),
    ];
    expect(recentActivities(tracks, null, 2).map((t) => t.id)).toEqual(['new', 'mid']);
    expect(recentActivities(tracks, 'hike', 5).map((t) => t.id)).toEqual(['mid', 'old']);
    expect(recentActivities(tracks, null, -1)).toEqual([]);
  });
});

describe('activity row text', () => {
  it('writes the board stats line', () => {
    expect(
      activityStatsLine(
        stats({ distanceM: 11_240, movingTimeS: 3 * 3600 + 31 * 60, ascentM: 1068 }),
        'metric',
      ),
    ).toBe('11.2 km · 3:31 · ↑1068 m');
  });

  it('falls back to wall-clock time, and drops time when untimed', () => {
    expect(
      activityStatsLine(stats({ distanceM: 9100, durationS: 5400, ascentM: 675 }), 'metric'),
    ).toBe('9.1 km · 1:30 · ↑675 m');
    expect(activityStatsLine(stats({ distanceM: 1609.344, ascentM: 30.48 }), 'imperial')).toBe(
      '1.0 mi · ↑100 ft',
    );
    expect(activityStatsLine(undefined, 'metric')).toBe('0.0 km · ↑0 m');
  });

  it('captions with date and type', () => {
    expect(activityCaption(new Date(2026, 7, 29, 10).getTime(), 'Hike')).toBe('Aug 29 · Hike');
    expect(activityCaption(new Date(2026, 3, 27).getTime(), null)).toBe('Apr 27');
  });
});
