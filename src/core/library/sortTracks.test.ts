import type { TrackStats, TrackSummary } from '@core/models';
import { filterTracks } from './filterTracks';
import { groupByFolder } from './folders';
import { DEFAULT_SORT, isSortKey, SORTS, sortTracks, type SortKey } from './sortTracks';

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

const ids = (list: readonly TrackSummary[]) => list.map((t) => t.id);

// A varied library: a short flat walk, a long slow climb, a fast run.
const SHORT = track('short', {
  name: 'Boisé',
  startedAt: Date.UTC(2026, 0, 1),
  stats: stats({
    distanceM: 1200,
    durationS: 900,
    movingTimeS: 800,
    ascentM: 10,
    avgSpeedMps: 1.5,
  }),
});
const CLIMB = track('climb', {
  name: 'Acropole',
  startedAt: Date.UTC(2026, 3, 10),
  stats: stats({
    distanceM: 14000,
    durationS: 18000,
    movingTimeS: 16000,
    ascentM: 1200,
    avgSpeedMps: 0.875,
  }),
});
const RUN = track('run', {
  name: 'Zec',
  startedAt: Date.UTC(2026, 6, 20),
  stats: stats({
    distanceM: 8000,
    durationS: 2400,
    movingTimeS: 2400,
    ascentM: 90,
    avgSpeedMps: 3,
  }),
});
const LIBRARY = [SHORT, CLIMB, RUN];

describe('sortTracks', () => {
  it('orders by date, newest and oldest', () => {
    expect(ids(sortTracks(LIBRARY, 'recent'))).toEqual(['run', 'climb', 'short']);
    expect(ids(sortTracks(LIBRARY, 'oldest'))).toEqual(['short', 'climb', 'run']);
  });

  it('orders by distance, duration and elevation gain, longest/most first', () => {
    expect(ids(sortTracks(LIBRARY, 'distance'))).toEqual(['climb', 'run', 'short']);
    expect(ids(sortTracks(LIBRARY, 'duration'))).toEqual(['climb', 'run', 'short']);
    expect(ids(sortTracks(LIBRARY, 'ascent'))).toEqual(['climb', 'run', 'short']);
  });

  it('orders by pace, fastest first, agreeing with the filter derivation', () => {
    // 3 m/s run < 1.5 m/s walk < 0.875 m/s climb, in seconds per kilometre.
    expect(ids(sortTracks(LIBRARY, 'pace'))).toEqual(['run', 'short', 'climb']);
  });

  it('orders by name, locale-aware and case/accent insensitive', () => {
    const named = [
      track('c', { name: 'zermatt' }),
      track('a', { name: 'Éboulis' }),
      track('b', { name: 'Eboulis-Nord' }),
      track('d', { name: 'acropole' }),
    ];
    // "Éboulis" folds onto "Eboulis" (base sensitivity), so it precedes
    // "Eboulis-Nord"; case does not float lowercase names to one end.
    expect(ids(sortTracks(named, 'name'))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('orders names numerically, not lexicographically', () => {
    const named = [track('x', { name: 'Sentier 10' }), track('y', { name: 'Sentier 2' })];
    expect(ids(sortTracks(named, 'name'))).toEqual(['y', 'x']);
  });

  it('does not mutate the input array', () => {
    const input = [...LIBRARY];
    sortTracks(input, 'distance');
    expect(ids(input)).toEqual(['short', 'climb', 'run']);
  });

  it('returns a sorted copy, never the input identity', () => {
    const sorted = sortTracks(LIBRARY, 'recent');
    expect(sorted).not.toBe(LIBRARY);
    expect(sorted).toHaveLength(LIBRARY.length);
  });

  it('handles empty and single-element lists', () => {
    expect(sortTracks([], 'distance')).toEqual([]);
    expect(ids(sortTracks([SHORT], 'name'))).toEqual(['short']);
  });

  describe('stability', () => {
    // Ten trails that all tie on every numeric key: only the incoming order
    // (the library's insertion order) can break the tie.
    const tied = Array.from({ length: 10 }, (_, i) => track(`t${i}`, { name: 'Same name' }));
    const expected = ids(tied);

    for (const { key } of SORTS) {
      it(`keeps insertion order for equal keys: ${key}`, () => {
        expect(ids(sortTracks(tied, key))).toEqual(expected);
      });
    }

    it('keeps insertion order among partial ties', () => {
      const a = track('a', { stats: stats({ ascentM: 100 }) });
      const b = track('b', { stats: stats({ ascentM: 500 }) });
      const c = track('c', { stats: stats({ ascentM: 100 }) });
      const d = track('d', { stats: stats({ ascentM: 500 }) });
      expect(ids(sortTracks([a, b, c, d], 'ascent'))).toEqual(['b', 'd', 'a', 'c']);
    });
  });

  describe('unknown values sort to the end, in both directions', () => {
    // Junk that a hand-edited or downgraded library.json can hydrate: the
    // types say these are numbers, disk does not.
    const noDate = track('no-date', { startedAt: Number.NaN });
    const noDist = track('no-dist', {
      stats: stats({ distanceM: undefined as unknown as number }),
    });
    const noStats = track('no-stats', { stats: undefined as unknown as TrackStats });
    const noName = track('no-name', { name: '   ' });

    it('parks undated tracks last for both date directions', () => {
      expect(ids(sortTracks([noDate, SHORT, RUN], 'recent'))).toEqual(['run', 'short', 'no-date']);
      expect(ids(sortTracks([noDate, SHORT, RUN], 'oldest'))).toEqual(['short', 'run', 'no-date']);
    });

    it('parks tracks with a missing stat last', () => {
      expect(ids(sortTracks([noDist, CLIMB, SHORT], 'distance'))).toEqual([
        'climb',
        'short',
        'no-dist',
      ]);
    });

    it('never throws on a track with no stats object at all', () => {
      for (const { key } of SORTS) {
        expect(() => sortTracks([CLIMB, noStats, RUN], key)).not.toThrow();
        expect(sortTracks([CLIMB, noStats, RUN], key)).toHaveLength(3);
      }
      // On every stats-derived key it is parked at the end, never scattered.
      // (`recent`/`oldest`/`name` read fields it still has, so they order it
      // on its date and name like any other track.)
      for (const key of ['distance', 'ascent', 'duration', 'pace'] as const) {
        expect(ids(sortTracks([CLIMB, noStats, RUN], key)).at(-1)).toBe('no-stats');
      }
    });

    it('parks unnamed tracks last rather than first', () => {
      expect(ids(sortTracks([noName, RUN, CLIMB], 'name'))).toEqual(['climb', 'run', 'no-name']);
    });

    it('keeps insertion order among several unknowns', () => {
      const u1 = track('u1', { startedAt: Number.NaN });
      const u2 = track('u2', { startedAt: Number.NaN });
      expect(ids(sortTracks([u1, RUN, u2], 'recent'))).toEqual(['run', 'u1', 'u2']);
    });

    it('parks untimed navigation trails last on pace, not first', () => {
      const untimed = track('untimed', {
        stats: stats({ distanceM: 4000, durationS: 0, movingTimeS: 0, avgSpeedMps: 0 }),
      });
      expect(ids(sortTracks([untimed, CLIMB, RUN], 'pace'))).toEqual(['run', 'climb', 'untimed']);
    });
  });

  describe('composition with the other pure passes', () => {
    it('preserves a widened element type through filter → sort → group', () => {
      interface RichTrack extends TrackSummary {
        color: string;
      }
      const rich: RichTrack[] = [
        { ...SHORT, color: '#111' },
        { ...CLIMB, color: '#222', folderId: 'f1' },
        { ...RUN, color: '#333', folderId: 'f1' },
      ];
      const filtered = filterTracks(rich, { distanceM: { min: 1000 } });
      const sorted = sortTracks(filtered, 'distance');
      const grouped = groupByFolder(
        [{ id: 'f1', name: 'Charlevoix', createdAt: 0 }],
        [],
        sorted,
        [],
      );

      // The element type survives: `color` is reachable without a cast.
      const colors: string[] = grouped.groups[0]?.tracks.map((t) => t.color) ?? [];
      expect(colors).toEqual(['#222', '#333']);
      // Sorting happens before grouping, so each folder is ordered internally.
      expect(ids(grouped.groups[0]?.tracks ?? [])).toEqual(['climb', 'run']);
      expect(ids(grouped.ungroupedTracks)).toEqual(['short']);
    });
  });
});

describe('isSortKey', () => {
  it('accepts every advertised key and rejects junk', () => {
    for (const { key } of SORTS) expect(isSortKey(key)).toBe(true);
    for (const junk of ['', 'longest', 'RECENT', 42, null, undefined, {}]) {
      expect(isSortKey(junk)).toBe(false);
    }
  });

  it('narrows to SortKey', () => {
    const raw: unknown = 'ascent';
    const key: SortKey = isSortKey(raw) ? raw : DEFAULT_SORT;
    expect(key).toBe('ascent');
  });

  it('defaults to the list order the Library has always had', () => {
    expect(DEFAULT_SORT).toBe('recent');
    expect(isSortKey(DEFAULT_SORT)).toBe(true);
  });
});
