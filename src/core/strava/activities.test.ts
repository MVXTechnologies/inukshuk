import {
  STRAVA_ACTIVITIES_PER_PAGE,
  buildActivitiesUrl,
  buildStreamsUrl,
  categoryForSportType,
  parseActivitiesPage,
  parseRateLimit,
  rateLimitDelayMs,
  streamsToPoints,
} from './activities';

const START = Date.parse('2026-09-12T13:05:00Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    name: 'Morning Run',
    sport_type: 'TrailRun',
    type: 'Run',
    start_date: '2026-09-12T13:05:00Z',
    distance: 12345.6,
    moving_time: 3600,
    elapsed_time: 3900,
    manual: false,
    trainer: false,
    map: { summary_polyline: 'abc' },
    ...overrides,
  };
}

describe('buildActivitiesUrl', () => {
  it('pages at the maximum size by default', () => {
    expect(buildActivitiesUrl({ page: 2 })).toBe(
      `https://www.strava.com/api/v3/athlete/activities?page=2&per_page=${STRAVA_ACTIVITIES_PER_PAGE}`,
    );
  });

  it('adds the time window and clamps the page', () => {
    expect(buildActivitiesUrl({ page: 0, perPage: 30, after: 1000.7, before: 2000 })).toBe(
      'https://www.strava.com/api/v3/athlete/activities?page=1&per_page=30&after=1000&before=2000',
    );
  });
});

describe('buildStreamsUrl', () => {
  it('asks for the import streams keyed by type', () => {
    expect(buildStreamsUrl(42)).toBe(
      'https://www.strava.com/api/v3/activities/42/streams?keys=latlng,time,altitude,heartrate&key_by_type=true',
    );
  });
});

describe('parseActivitiesPage', () => {
  it('parses a row', () => {
    expect(parseActivitiesPage([row()])).toEqual([
      {
        id: 123,
        name: 'Morning Run',
        sportType: 'TrailRun',
        startTime: START,
        distanceM: 12345.6,
        movingTimeS: 3600,
        elapsedTimeS: 3900,
        hasTrack: true,
      },
    ]);
  });

  it('falls back to the legacy type and to the sport as the name', () => {
    const [a] = parseActivitiesPage([row({ sport_type: undefined, name: '  ' })]);
    expect(a?.sportType).toBe('Run');
    expect(a?.name).toBe('Run');
  });

  it('marks manual, indoor and map-less activities as having no track', () => {
    const rows = parseActivitiesPage([
      row({ manual: true }),
      row({ trainer: true }),
      row({ map: { summary_polyline: '' } }),
      row({ map: null }),
    ]);
    expect(rows.map((r) => r.hasTrack)).toEqual([false, false, false, false]);
  });

  it('drops rows without an id or a parseable start, and survives junk', () => {
    expect(parseActivitiesPage([row({ id: 'x' }), row({ start_date: 'soon' }), null, 7])).toEqual(
      [],
    );
    expect(parseActivitiesPage({ message: 'Rate Limit Exceeded' })).toEqual([]);
  });
});

describe('streamsToPoints', () => {
  const streams = {
    latlng: {
      data: [[46.81, -71.2], [46.811, -71.201], null, [46.812, -71.202]],
    },
    time: { data: [0, 5, 10, 15] },
    altitude: { data: [100, 101.5, 102, 103] },
    heartrate: { data: [120, 0, 130, 131] },
  };

  it('anchors the time stream on the activity start and carries altitude and HR', () => {
    const points = streamsToPoints(streams, START);
    expect(points).toEqual([
      {
        latitude: 46.81,
        longitude: -71.2,
        time: START,
        hasTime: true,
        altitude: 100,
        heartRateBpm: 120,
      },
      // A zero heart rate is a strap dropout, not a reading.
      { latitude: 46.811, longitude: -71.201, time: START + 5000, hasTime: true, altitude: 101.5 },
      {
        latitude: 46.812,
        longitude: -71.202,
        time: START + 15000,
        hasTime: true,
        altitude: 103,
        heartRateBpm: 131,
      },
    ]);
  });

  it('skips impossible and null-island positions', () => {
    const points = streamsToPoints(
      {
        latlng: {
          data: [
            [0, 0],
            [91, 10],
            [10, 181],
            [45, -73],
          ],
        },
      },
      START,
    );
    expect(points).toHaveLength(1);
    // No time stream: the point is placed at the start and flagged untimed.
    expect(points[0]).toEqual({ latitude: 45, longitude: -73, time: START, hasTime: false });
  });

  it('returns nothing without a latlng stream', () => {
    expect(streamsToPoints({ time: { data: [0] } }, START)).toEqual([]);
    expect(streamsToPoints([], START)).toEqual([]);
    expect(streamsToPoints(null, START)).toEqual([]);
  });
});

describe('categoryForSportType', () => {
  it.each([
    ['Run', 'run'],
    ['TrailRun', 'trail-run'],
    ['Hike', 'hike'],
    ['Walk', 'walk'],
    ['MountainBikeRide', 'bike'],
    ['BackcountrySki', 'ski'],
    ['Snowshoe', 'snowshoe'],
  ])('%s → %s', (sport, category) => {
    expect(categoryForSportType(sport)).toBe(category);
  });

  it('leaves unknown sports uncategorized', () => {
    expect(categoryForSportType('Kayaking')).toBeUndefined();
  });
});

describe('rate limits', () => {
  const headers =
    (map: Record<string, string>) =>
    (name: string): string | null =>
      map[name] ?? null;

  it('prefers the read limits', () => {
    expect(
      parseRateLimit(
        headers({
          'X-RateLimit-Usage': '1,2',
          'X-RateLimit-Limit': '200,2000',
          'X-ReadRateLimit-Usage': '50,400',
          'X-ReadRateLimit-Limit': '100,1000',
        }),
      ),
    ).toEqual({ shortUsed: 50, dailyUsed: 400, shortLimit: 100, dailyLimit: 1000 });
  });

  it('is null when missing or malformed', () => {
    expect(parseRateLimit(headers({}))).toBeNull();
    expect(
      parseRateLimit(headers({ 'X-RateLimit-Usage': 'a,b', 'X-RateLimit-Limit': '1,2' })),
    ).toBeNull();
  });

  it('waits for the next quarter hour when the short window is spent', () => {
    const now = Date.parse('2026-09-12T13:07:30Z');
    const state = { shortUsed: 99, shortLimit: 100, dailyUsed: 10, dailyLimit: 1000 };
    expect(rateLimitDelayMs(state, now)).toBe(7.5 * 60_000 + 1_000);
    expect(rateLimitDelayMs({ ...state, shortUsed: 10 }, now)).toBe(0);
    expect(rateLimitDelayMs(null, now)).toBe(0);
  });

  it('stops for the day when the daily budget is gone', () => {
    expect(
      rateLimitDelayMs({ shortUsed: 0, shortLimit: 100, dailyUsed: 999, dailyLimit: 1000 }, 0),
    ).toBeNull();
  });
});
