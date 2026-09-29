import { SourceStopError, type ImportPause } from '@core/import/sources';
import type { RateLimitState, StravaActivitySummary } from '@core/strava/activities';

import { createStravaSource, sleepUnlessAborted, type StravaApi } from './stravaSource';

jest.mock('./strava', () => {
  class StravaReadError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  }
  return { StravaReadError, listStravaActivities: jest.fn(), fetchStravaActivityPoints: jest.fn() };
});

const { StravaReadError } = jest.requireMock('./strava') as {
  StravaReadError: new (message: string, kind: string) => Error;
};

const NOW = Date.parse('2026-09-28T13:02:00Z');
const DAY = 86_400_000;

const summary = (id: number, startTime: number, over: Partial<StravaActivitySummary> = {}) => ({
  id,
  name: `A${id}`,
  sportType: 'Run',
  startTime,
  distanceM: 5000,
  movingTimeS: 1,
  elapsedTimeS: 1,
  hasTrack: true,
  ...over,
});

const easy: RateLimitState = { shortUsed: 1, shortLimit: 100, dailyUsed: 1, dailyLimit: 1000 };

function api(over: Partial<StravaApi> = {}): StravaApi & { sleep: jest.Mock } {
  return {
    list: jest.fn(),
    points: jest.fn(),
    now: () => NOW,
    sleep: jest.fn(async () => undefined),
    ...over,
  } as StravaApi & { sleep: jest.Mock };
}

const signal = () => new AbortController().signal;

describe('list', () => {
  it('pages until an empty page, newest first, within the range', async () => {
    const a = api();
    (a.list as jest.Mock)
      .mockResolvedValueOnce({
        activities: [summary(1, NOW - DAY), summary(2, NOW - 3 * DAY)],
        rate: easy,
      })
      .mockResolvedValueOnce({ activities: [summary(3, NOW - 2 * DAY)], rate: easy })
      .mockResolvedValueOnce({ activities: [], rate: easy });
    const listed = await createStravaSource(a).list(NOW - 2.5 * DAY, signal());
    expect(listed.map((r) => r.origin.externalId)).toEqual(['1', '3']);
    expect(a.list).toHaveBeenNthCalledWith(1, 1, Math.floor((NOW - 2.5 * DAY) / 1000) - 1);
    expect(a.list).toHaveBeenCalledTimes(3);
  });

  it('stops at a page entirely older than the range', async () => {
    const a = api();
    (a.list as jest.Mock).mockResolvedValue({ activities: [summary(1, 0)], rate: easy });
    await expect(createStravaSource(a).list(NOW - DAY, signal())).resolves.toEqual([]);
    expect(a.list).toHaveBeenCalledTimes(1);
  });

  it('lists everything with no `after` from the beginning', async () => {
    const a = api();
    (a.list as jest.Mock)
      .mockResolvedValueOnce({ activities: [summary(1, 5)], rate: null })
      .mockResolvedValueOnce({ activities: [], rate: null });
    await createStravaSource(a).list(0, signal());
    expect(a.list).toHaveBeenNthCalledWith(1, 1, undefined);
  });

  it('sits out a spent 15-minute window between pages, reporting the pause', async () => {
    const a = api();
    const tight = { ...easy, shortUsed: 99 };
    (a.list as jest.Mock)
      .mockResolvedValueOnce({ activities: [summary(1, NOW)], rate: tight })
      .mockResolvedValueOnce({ activities: [], rate: easy });
    const pauses: ImportPause[] = [];
    await createStravaSource(a).list(0, signal(), (p) => pauses.push(p));
    // 13:02 → the 13:15 window, plus a second.
    expect(a.sleep).toHaveBeenCalledWith(13 * 60_000 + 1000, expect.anything());
    expect(pauses).toEqual([{ kind: 'rate-limit', resumeAt: NOW + 13 * 60_000 + 1000 }, null]);
  });

  it('turns a refused token into an auth stop', async () => {
    const a = api();
    (a.list as jest.Mock).mockRejectedValue(new StravaReadError('reconnect', 'auth'));
    await expect(createStravaSource(a).list(0, signal())).rejects.toMatchObject({
      kind: 'auth',
      message: 'reconnect',
    });
  });

  it('passes other errors through', async () => {
    const a = api();
    (a.list as jest.Mock).mockRejectedValue(new StravaReadError('offline', 'other'));
    await expect(createStravaSource(a).list(0, signal())).rejects.toThrow('offline');
    (a.list as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(createStravaSource(a).list(0, signal())).rejects.toThrow('boom');
  });

  it('refuses to start once aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(createStravaSource(api()).list(0, c.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('fetchRoute', () => {
  const remote = {
    origin: { source: 'strava' as const, externalId: '7' },
    startedAt: NOW,
    distanceM: 1,
    hasRoute: true,
  };

  it('fetches the streams as one segment', async () => {
    const a = api();
    const points = [{ latitude: 1, longitude: 2, time: NOW }];
    (a.points as jest.Mock).mockResolvedValue({ points, rate: easy });
    await expect(createStravaSource(a).fetchRoute(remote, signal(), jest.fn())).resolves.toEqual({
      points,
      segmentStarts: [],
    });
    expect(a.points).toHaveBeenCalledWith(expect.objectContaining({ id: 7, startTime: NOW }));
  });

  it('returns nothing for an id that is not Strava’s', async () => {
    const a = api();
    const route = await createStravaSource(a).fetchRoute(
      { ...remote, origin: { source: 'strava', externalId: 'x' } },
      signal(),
      jest.fn(),
    );
    expect(route.points).toEqual([]);
    expect(a.points).not.toHaveBeenCalled();
  });

  it('stops for the day once the daily budget is spent, until midnight UTC', async () => {
    let now = NOW;
    const a = api({ now: () => now });
    (a.points as jest.Mock).mockResolvedValue({
      points: [],
      rate: { ...easy, dailyUsed: 999 },
    });
    const source = createStravaSource(a);
    await source.fetchRoute(remote, signal(), jest.fn());
    const midnight = Date.parse('2026-09-29T00:00:00Z');
    await expect(source.fetchRoute(remote, signal(), jest.fn())).rejects.toEqual(
      new SourceStopError('Strava’s daily limit reached', 'daily-limit', midnight),
    );
    expect(a.points).toHaveBeenCalledTimes(1);
    now = midnight + 1;
    (a.points as jest.Mock).mockResolvedValue({ points: [], rate: easy });
    await source.fetchRoute(remote, signal(), jest.fn());
    expect(a.points).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 after the window, then calls it a day', async () => {
    const a = api();
    (a.points as jest.Mock)
      .mockRejectedValueOnce(new StravaReadError('slow', 'rate-limited'))
      .mockResolvedValueOnce({ points: [], rate: easy });
    const onPause = jest.fn();
    await createStravaSource(a).fetchRoute(remote, signal(), onPause);
    expect(a.sleep).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenLastCalledWith(null);

    const b = api();
    (b.points as jest.Mock).mockRejectedValue(new StravaReadError('slow', 'rate-limited'));
    await expect(
      createStravaSource(b).fetchRoute(remote, signal(), jest.fn()),
    ).rejects.toMatchObject({ kind: 'daily-limit' });
    expect(b.points).toHaveBeenCalledTimes(3);
  });
});

describe('sleepUnlessAborted', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves after the wait', async () => {
    const p = sleepUnlessAborted(1000, signal());
    jest.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects when aborted, before or during the wait', async () => {
    const c = new AbortController();
    const p = sleepUnlessAborted(1000, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(sleepUnlessAborted(5, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
