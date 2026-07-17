import type { TrackStats, TrackSummary } from '@core/models';
import {
  countActiveFilters,
  filterTracks,
  hasActiveFilters,
  matchesFilter,
  paceSecPerKm,
  UNCATEGORIZED,
  type TrackFilter,
} from './filterTracks';

function stats(partial: Partial<TrackStats> = {}): TrackStats {
  return {
    distanceM: 5000,
    ascentM: 250,
    descentM: 250,
    durationS: 3600,
    movingTimeS: 3000,
    avgSpeedMps: 5000 / 3000,
    maxSpeedMps: 3,
    pointCount: 100,
    ...partial,
  };
}

function track(id: string, partial: Partial<TrackSummary> = {}): TrackSummary {
  return {
    id,
    name: `Trail ${id}`,
    startedAt: Date.UTC(2026, 5, 15),
    stats: stats(),
    fileUri: `file://tracks/${id}.gpx`,
    ...partial,
  };
}

// A varied library: short flat walk, long climb, categorized run, uncategorized.
const SHORT = track('short', {
  startedAt: Date.UTC(2026, 0, 1),
  stats: stats({
    distanceM: 1200,
    durationS: 900,
    movingTimeS: 800,
    ascentM: 10,
    avgSpeedMps: 1.5,
  }),
  category: 'walk',
});
const CLIMB = track('climb', {
  startedAt: Date.UTC(2026, 3, 10),
  stats: stats({
    distanceM: 14000,
    durationS: 18000,
    movingTimeS: 16000,
    ascentM: 1200,
    avgSpeedMps: 0.875,
  }),
  category: 'hike',
});
const RUN = track('run', {
  startedAt: Date.UTC(2026, 6, 1),
  stats: stats({
    distanceM: 10000,
    durationS: 3000,
    movingTimeS: 2900,
    ascentM: 120,
    avgSpeedMps: 10000 / 2900,
  }),
  category: 'run',
});
const PLAIN = track('plain', { startedAt: Date.UTC(2026, 6, 5) }); // uncategorized
const ALL = [SHORT, CLIMB, RUN, PLAIN];

describe('paceSecPerKm', () => {
  it('uses the stored average speed when present', () => {
    expect(paceSecPerKm(stats({ avgSpeedMps: 2 }))).toBeCloseTo(500);
  });

  it('derives from distance / movingTime when avgSpeedMps is 0', () => {
    expect(paceSecPerKm(stats({ avgSpeedMps: 0, distanceM: 6000, movingTimeS: 3600 }))).toBeCloseTo(
      600,
    );
  });

  it('falls back to distance / duration when moving time is 0 too', () => {
    expect(
      paceSecPerKm(stats({ avgSpeedMps: 0, movingTimeS: 0, distanceM: 3000, durationS: 3600 })),
    ).toBeCloseTo(1200);
  });

  it('returns null when no positive finite pace is derivable', () => {
    expect(paceSecPerKm(stats({ avgSpeedMps: 0, movingTimeS: 0, durationS: 0 }))).toBeNull();
    expect(
      paceSecPerKm(stats({ avgSpeedMps: 0, distanceM: 0, movingTimeS: 0, durationS: 100 })),
    ).toBeNull();
    // A junk stored speed (NaN) falls through to the derived pace.
    expect(paceSecPerKm(stats({ avgSpeedMps: Number.NaN }))).toBeCloseTo(600);
  });
});

describe('empty criteria', () => {
  it('matches every track and returns the input array identity', () => {
    expect(filterTracks(ALL, {})).toBe(ALL);
    expect(hasActiveFilters({})).toBe(false);
    expect(countActiveFilters({})).toBe(0);
  });

  it('treats empty ranges and empty category lists as inactive', () => {
    const f: TrackFilter = { distanceM: {}, durationS: {}, categories: [] };
    expect(filterTracks(ALL, f)).toBe(ALL);
    expect(countActiveFilters(f)).toBe(0);
  });
});

describe('each criterion alone', () => {
  it('distance range (inclusive bounds)', () => {
    expect(filterTracks(ALL, { distanceM: { min: 5000 } }).map((t) => t.id)).toEqual([
      'climb',
      'run',
      'plain',
    ]);
    expect(filterTracks(ALL, { distanceM: { max: 5000 } }).map((t) => t.id)).toEqual([
      'short',
      'plain',
    ]);
    expect(filterTracks(ALL, { distanceM: { min: 1200, max: 1200 } }).map((t) => t.id)).toEqual([
      'short',
    ]);
  });

  it('duration range', () => {
    expect(filterTracks(ALL, { durationS: { min: 3600 } }).map((t) => t.id)).toEqual([
      'climb',
      'plain',
    ]);
    expect(filterTracks(ALL, { durationS: { max: 1000 } }).map((t) => t.id)).toEqual(['short']);
  });

  it('elevation gain (D+) range', () => {
    expect(filterTracks(ALL, { ascentM: { min: 1000 } }).map((t) => t.id)).toEqual(['climb']);
    expect(filterTracks(ALL, { ascentM: { max: 100 } }).map((t) => t.id)).toEqual(['short']);
  });

  it('date range on startedAt', () => {
    const f: TrackFilter = { startedAt: { min: Date.UTC(2026, 3, 1), max: Date.UTC(2026, 6, 2) } };
    expect(filterTracks(ALL, f).map((t) => t.id)).toEqual(['climb', 'run']);
  });

  it('pace range (seconds per km)', () => {
    // RUN paces ~290 s/km; SHORT ~667; ALL default ~600; CLIMB ~1143.
    expect(filterTracks(ALL, { paceSecPerKm: { max: 300 } }).map((t) => t.id)).toEqual(['run']);
    expect(filterTracks(ALL, { paceSecPerKm: { min: 1000 } }).map((t) => t.id)).toEqual(['climb']);
  });

  it('an active pace range excludes tracks whose pace is underivable', () => {
    const still = track('still', {
      stats: stats({ avgSpeedMps: 0, distanceM: 0, movingTimeS: 0, durationS: 0 }),
    });
    expect(filterTracks([still], { paceSecPerKm: { min: 0 } })).toEqual([]);
    // …but an inactive filter keeps them.
    expect(filterTracks([still], {})).toEqual([still]);
  });

  it('category multi-select ORs the picked ids', () => {
    expect(filterTracks(ALL, { categories: ['run', 'walk'] }).map((t) => t.id)).toEqual([
      'short',
      'run',
    ]);
  });

  it('UNCATEGORIZED matches tracks without a category (and junk ids match nothing)', () => {
    expect(filterTracks(ALL, { categories: [UNCATEGORIZED] }).map((t) => t.id)).toEqual(['plain']);
    expect(filterTracks(ALL, { categories: ['no-such-category'] })).toEqual([]);
    // Empty-string category counts as uncategorized, not as a real id.
    const weird = track('weird', { category: '' });
    expect(filterTracks([weird], { categories: [UNCATEGORIZED] }).map((t) => t.id)).toEqual([
      'weird',
    ]);
  });
});

describe('combined criteria (AND across criteria)', () => {
  it('applies every active criterion together', () => {
    const f: TrackFilter = {
      distanceM: { min: 5000 },
      ascentM: { max: 500 },
      categories: ['run', 'hike'],
    };
    expect(filterTracks(ALL, f).map((t) => t.id)).toEqual(['run']);
    expect(countActiveFilters(f)).toBe(3);
  });

  it('a single failing criterion excludes the track', () => {
    const f: TrackFilter = {
      distanceM: { min: 5000 },
      durationS: { max: 3500 },
      startedAt: { min: Date.UTC(2026, 6, 2) },
    };
    // RUN passes distance+duration but started July 1 < July 2; every other
    // track already fails distance or duration.
    expect(filterTracks(ALL, f)).toEqual([]);
  });

  it('matchesFilter agrees with filterTracks', () => {
    const f: TrackFilter = { paceSecPerKm: { max: 700 }, categories: ['walk'] };
    for (const t of ALL) {
      expect(matchesFilter(t, f)).toBe(filterTracks(ALL, f).includes(t));
    }
  });

  it('counts each active criterion once for the badge', () => {
    expect(
      countActiveFilters({
        distanceM: { min: 1 },
        durationS: { max: 2 },
        ascentM: { min: 0 },
        startedAt: { min: 1 },
        paceSecPerKm: { max: 900 },
        categories: ['hike'],
      }),
    ).toBe(6);
  });
});
