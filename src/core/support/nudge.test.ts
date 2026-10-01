import {
  NUDGE_INTERVAL_MS,
  NUDGE_MIN_OUTINGS,
  recordedOutingsInYear,
  supportNudgeCount,
  type NudgeTrack,
} from './nudge';

const NOW = new Date(2026, 8, 30, 12).getTime();
const inYear = (year: number, month = 5): number => new Date(year, month, 15, 9).getTime();

const recorded = (n: number, year = 2026): NudgeTrack[] =>
  Array.from({ length: n }, (_, i) => ({ startedAt: inYear(year, i % 9) }));
const imported = (n: number): NudgeTrack[] =>
  Array.from({ length: n }, () => ({
    startedAt: inYear(2026),
    origin: { source: 'strava', externalId: 'x' },
  }));

describe('recordedOutingsInYear', () => {
  it('counts only this year and only trails recorded in the app', () => {
    const tracks = [...recorded(4), ...recorded(3, 2025), ...imported(5), { startedAt: 0 }];
    expect(recordedOutingsInYear(tracks, 2026)).toBe(4);
    expect(recordedOutingsInYear(tracks, 2025)).toBe(3);
  });

  it('ignores junk start times', () => {
    expect(recordedOutingsInYear([{ startedAt: Number.NaN }, { startedAt: -5 }], 1970)).toBe(0);
  });

  it('treats an explicit null origin as recorded', () => {
    expect(recordedOutingsInYear([{ startedAt: inYear(2026), origin: null }], 2026)).toBe(1);
  });
});

describe('supportNudgeCount', () => {
  const base = { enabled: true, tracks: recorded(NUDGE_MIN_OUTINGS), now: NOW, lastAnsweredAt: 0 };

  it('is off whenever the flag is off (the default)', () => {
    expect(supportNudgeCount({ ...base, enabled: false })).toBeNull();
  });

  it(`shows from ${NUDGE_MIN_OUTINGS} recorded outings this year, with the count`, () => {
    expect(supportNudgeCount(base)).toBe(NUDGE_MIN_OUTINGS);
    expect(supportNudgeCount({ ...base, tracks: recorded(42) })).toBe(42);
  });

  it('stays hidden below the threshold, however many imported or old trails there are', () => {
    const tracks = [...recorded(NUDGE_MIN_OUTINGS - 1), ...imported(50), ...recorded(50, 2025)];
    expect(supportNudgeCount({ ...base, tracks })).toBeNull();
  });

  it('shows at most once per 12 months after an answer', () => {
    expect(supportNudgeCount({ ...base, lastAnsweredAt: NOW - 1000 })).toBeNull();
    expect(supportNudgeCount({ ...base, lastAnsweredAt: NOW - NUDGE_INTERVAL_MS + 1 })).toBeNull();
    expect(supportNudgeCount({ ...base, lastAnsweredAt: NOW - NUDGE_INTERVAL_MS })).toBe(
      NUDGE_MIN_OUTINGS,
    );
  });

  it('treats an answer stamped in the future as just answered', () => {
    expect(supportNudgeCount({ ...base, lastAnsweredAt: NOW + 5 * NUDGE_INTERVAL_MS })).toBeNull();
  });
});
