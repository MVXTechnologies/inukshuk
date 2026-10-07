import {
  compactDistance,
  compactDuration,
  shortDate,
  showsKind,
  trailCaption,
  trailStatsLine,
  typeCounts,
} from './libraryRows';

describe('compactDistance', () => {
  it.each([
    [0, '0 m'],
    [-5, '0 m'],
    [NaN, '0 m'],
    [840.4, '840 m'],
    [999.4, '999 m'],
    [999.6, '1.0 km'],
    [11190, '11.2 km'],
    [99_940, '99.9 km'],
    [142_300, '142 km'],
  ])('metric %p → %s', (m, out) => {
    expect(compactDistance(m, 'metric')).toBe(out);
  });

  it.each([
    [100, '328 ft'],
    [11190, '7.0 mi'],
    [200_000, '124 mi'],
  ])('imperial %p → %s', (m, out) => {
    expect(compactDistance(m, 'imperial')).toBe(out);
  });
});

describe('compactDuration', () => {
  it.each([
    [0, '1 min'],
    [NaN, '1 min'],
    [42 * 60 + 10, '42 min'],
    [59 * 60 + 40, '1:00'],
    [3 * 3600 + 31 * 60 + 3, '3:31'],
    [2 * 3600 + 7 * 60, '2:07'],
  ])('%p s → %s', (s, out) => {
    expect(compactDuration(s)).toBe(out);
  });
});

describe('trailStatsLine', () => {
  it('shows distance, h:mm and ascent', () => {
    expect(
      trailStatsLine(
        { distanceM: 11190, durationS: 3 * 3600 + 31 * 60 + 3, ascentM: 1068.2 },
        'metric',
      ),
    ).toBe('11.2 km · 3:31 · ↑1068 m');
  });

  it('omits the duration of an untimed trail', () => {
    expect(trailStatsLine({ distanceM: 5600, durationS: 0, ascentM: 520 }, 'metric')).toBe(
      '5.6 km · ↑520 m',
    );
  });

  it('follows the unit system', () => {
    expect(trailStatsLine({ distanceM: 11190, durationS: 0, ascentM: 100 }, 'imperial')).toBe(
      '7.0 mi · ↑328 ft',
    );
  });
});

describe('shortDate / trailCaption', () => {
  const now = new Date(2026, 8, 27, 12).getTime();
  const aug29 = new Date(2026, 7, 29, 6).getTime();
  const lastYear = new Date(2025, 7, 29, 6).getTime();

  it('leaves the year out for this year and adds it otherwise', () => {
    expect(shortDate(aug29, now)).not.toMatch(/2026/);
    expect(shortDate(lastYear, now)).toMatch(/2025/);
  });

  it('names the activity type after the date', () => {
    expect(trailCaption(aug29, 'Hike', now)).toBe(`${shortDate(aug29, now)} · Hike`);
  });

  it('is just the date for an uncategorized trail', () => {
    expect(trailCaption(aug29, null, now)).toBe(shortDate(aug29, now));
  });
});

describe('type filter', () => {
  it('All shows every kind; a type chip shows only its kind', () => {
    expect(showsKind('all', 'maps')).toBe(true);
    expect(showsKind('trails', 'trails')).toBe(true);
    expect(showsKind('trails', 'maps')).toBe(false);
    expect(showsKind('waypoints', 'trails')).toBe(false);
  });

  it('counts All as the sum', () => {
    expect(typeCounts({ trails: 9, maps: 2, waypoints: 2 })).toEqual({
      all: 13,
      trails: 9,
      maps: 2,
      waypoints: 2,
      areas: 0,
      climbing: 0,
    });
    expect(typeCounts({ trails: 0, maps: 0, waypoints: 0, climbing: 2 })).toMatchObject({
      all: 2,
      climbing: 2,
    });
    expect(typeCounts({ trails: 1, maps: 0, waypoints: 0, areas: 3 })).toMatchObject({
      all: 4,
      areas: 3,
    });
  });
});
