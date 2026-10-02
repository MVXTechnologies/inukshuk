import { activityWeekStreaks, streakTitle, weekStreaks } from './streaks';

// Friday, Oct 2 2026. Weeks (Mondays): Sep 28, Sep 21, Sep 14, Sep 7, Aug 31 …
const NOW = new Date(2026, 9, 2, 12).getTime();
const day = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime();

describe('weekStreaks', () => {
  it('counts consecutive weeks up to this one', () => {
    const s = weekStreaks([day(9, 1), day(8, 22), day(8, 14), day(8, 13), day(8, 7)], NOW);
    // Sep 7 (Mon) is its own week; Sep 13 (Sun) is still the week of Sep 7.
    expect(s).toEqual({ current: 4, best: 4 });
  });

  it('keeps a streak alive through a week with no outing yet', () => {
    expect(weekStreaks([day(8, 25), day(8, 18)], NOW)).toEqual({ current: 2, best: 2 });
  });

  it('breaks after a whole empty week, remembering the best', () => {
    const s = weekStreaks(
      [day(9, 1), day(8, 15), day(8, 8), day(8, 1), day(7, 25), day(7, 18)],
      NOW,
    );
    expect(s).toEqual({ current: 1, best: 5 });
  });

  it('a Sunday-evening outing belongs to its Monday week', () => {
    // Sun Sep 27 23:30 → week of Sep 21; Mon Sep 28 00:10 → this week.
    const s = weekStreaks([day(8, 27, 23.5), new Date(2026, 8, 28, 0, 10).getTime()], NOW);
    expect(s.current).toBe(2);
  });

  it('is zero with nothing (or only the future / junk)', () => {
    expect(weekStreaks([], NOW)).toEqual({ current: 0, best: 0 });
    expect(weekStreaks([NOW + 1e10, Number.NaN], NOW)).toEqual({ current: 0, best: 0 });
    expect(weekStreaks([day(4, 1)], NOW)).toEqual({ current: 0, best: 1 });
  });
});

describe('activityWeekStreaks / streakTitle', () => {
  const t = (m: number, d: number, category: string) => ({ startedAt: day(m, d), category });

  it('counts every performed activity for All, one activity for a chip', () => {
    const tracks = [t(9, 1, 'run'), t(8, 22, 'bike'), t(8, 15, 'run'), t(8, 8, 'hike')];
    expect(activityWeekStreaks(tracks, null, NOW)).toEqual({ current: 4, best: 4 });
    expect(activityWeekStreaks(tracks, 'run', NOW)).toEqual({ current: 1, best: 1 });
    expect(activityWeekStreaks(tracks, 'ski', NOW)).toEqual({ current: 0, best: 0 });
  });

  it('names the activity the card is for', () => {
    expect(streakTitle(null)).toBe('Week streak');
    expect(streakTitle('Run')).toBe('Run week streak');
  });
});
