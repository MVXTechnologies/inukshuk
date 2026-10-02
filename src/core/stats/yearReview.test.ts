import { summary } from './testTracks';
import {
  dayOfYear,
  daysInYear,
  heatmapStrip,
  reviewYears,
  shadeLevels,
  yearReview,
} from './yearReview';

const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();

describe('dayOfYear / daysInYear', () => {
  it('indexes local days from Jan 1, across DST', () => {
    expect(dayOfYear(at(2026, 0, 1, 0), 2026)).toBe(0);
    expect(dayOfYear(at(2026, 2, 9, 23), 2026)).toBe(67);
    expect(dayOfYear(at(2026, 10, 2, 1), 2026)).toBe(305);
    expect(dayOfYear(at(2026, 11, 31, 23), 2026)).toBe(364);
    expect(dayOfYear(at(2025, 11, 31), 2026)).toBe(-1);
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2024)).toBe(366);
  });
});

describe('shadeLevels', () => {
  it('quartiles the non-zero days into four shades', () => {
    expect(shadeLevels([0, 1, 2, 3, 4, 0])).toEqual([0, 1, 2, 3, 4, 0]);
    expect(shadeLevels([5, 5, 5])).toEqual([4, 4, 4]);
    expect(shadeLevels([0, 0])).toEqual([0, 0]);
  });
});

describe('yearReview', () => {
  const tracks = [
    summary({ startedAt: at(2026, 0, 1), stats: { distanceM: 5000, movingTimeS: 1500 } }),
    summary({ startedAt: at(2026, 0, 1, 17), stats: { distanceM: 3000, movingTimeS: 900 } }),
    summary({ startedAt: at(2026, 5, 10), stats: { distanceM: 20000, movingTimeS: 0 } }),
    summary({ startedAt: at(2025, 5, 10), stats: { distanceM: 99999 } }),
  ];

  it('bins distance per day and month, with the best month', () => {
    const r = yearReview(tracks, 2026, 'distance');
    expect(r.days).toHaveLength(365);
    expect(r.days[0]).toBe(8000);
    expect(r.days[dayOfYear(at(2026, 5, 10), 2026)]).toBe(20000);
    expect(r.monthDistanceM[0]).toBe(8000);
    expect(r.monthDistanceM[5]).toBe(20000);
    expect(r.bestMonth).toBe(5);
    expect(r.outings).toBe(3);
    expect(r.activeDays).toBe(2);
    expect(r.totalDistanceM).toBe(28000);
    // Jan 1 2026 is a Thursday: Monday-based offset 3.
    expect(r.firstWeekday).toBe(3);
  });

  it('bins moving time on Time, still shading a day whose time is zero', () => {
    const r = yearReview(tracks, 2026, 'time');
    expect(r.days[0]).toBe(2400);
    const june = dayOfYear(at(2026, 5, 10), 2026);
    expect(r.days[june]).toBe(0);
    expect(r.levels[june]).toBe(1);
    expect(r.levels[0]).toBe(4);
  });

  it('an empty year has no best month', () => {
    const r = yearReview([], 2020, 'distance');
    expect(r.bestMonth).toBeNull();
    expect(r.levels.every((l) => l === 0)).toBe(true);
    expect(r.days).toHaveLength(366);
  });

  it('tolerates a summary without stats', () => {
    const broken = { ...summary({ startedAt: at(2026, 3, 3) }), stats: undefined as never };
    expect(yearReview([broken], 2026, 'distance').outings).toBe(1);
  });
});

describe('reviewYears', () => {
  it('lists every year with an outing plus this one, newest first', () => {
    const now = at(2026, 9, 2);
    expect(
      reviewYears(
        [
          { startedAt: at(2023, 1, 1) },
          { startedAt: at(2025, 1, 1) },
          { startedAt: at(2031, 1, 1) },
        ],
        now,
      ),
    ).toEqual([2026, 2025, 2023]);
  });
});

describe('heatmapStrip', () => {
  // 2026 starts on a Thursday (weekday 3, Monday-based): 53 week columns.
  const base = { year: 2026, firstWeekday: 3, dayCount: 365, width: 335, gap: 3 };

  it('fits 26 weeks across the card and scrolls the rest', () => {
    const s = heatmapStrip({ ...base, now: at(2026, 9, 2) });
    expect(s.columns).toBe(53);
    expect(s.cell).toBeCloseTo((335 - 25 * 3) / 26);
    expect(s.contentWidth).toBeCloseTo(53 * 10 + 52 * 3);
  });

  it('opens with this week at the right edge in the current year', () => {
    const s = heatmapStrip({ ...base, now: at(2026, 9, 2) });
    // Oct 2 is day 274: column floor((3 + 274) / 7) = 39.
    expect(s.offsetX).toBeCloseTo(40 * 10 + 39 * 3 - 335);
  });

  it('opens on December for a past year, and at the start early in the year', () => {
    const past = heatmapStrip({ ...base, now: at(2027, 4, 1) });
    expect(past.offsetX).toBeCloseTo(past.contentWidth - 335);
    expect(heatmapStrip({ ...base, now: at(2026, 1, 10) }).offsetX).toBe(0);
  });

  it('stays finite before the card is measured', () => {
    expect(heatmapStrip({ ...base, width: 0, now: at(2026, 9, 2) })).toMatchObject({
      cell: 0,
      offsetX: 0,
    });
  });
});
