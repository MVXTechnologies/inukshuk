import {
  LATE_SYNC_MARGIN_MS,
  STRAVA_SLOW_IMPORT_THRESHOLD,
  dayMonth,
  importPreviewText,
  planImport,
  remoteActivityName,
  resolveRange,
  showsSlowImportNote,
  type LibraryTrackRef,
} from './plan';
import type { RemoteActivity } from './sources';

const T0 = Date.parse('2026-09-12T14:00:00Z');

const remote = (id: string, over: Partial<RemoteActivity> = {}): RemoteActivity => ({
  origin: { source: 'strava', externalId: id },
  startedAt: T0,
  distanceM: 10_000,
  hasRoute: true,
  ...over,
});

const lib = (over: Partial<LibraryTrackRef> = {}): LibraryTrackRef => ({
  startedAt: 0,
  stats: { distanceM: 0 },
  ...over,
});

describe('planImport', () => {
  it('fetches everything new, newest first', () => {
    const plan = planImport(
      [remote('a', { startedAt: T0 }), remote('b', { startedAt: T0 + 86_400_000 })],
      [],
    );
    expect(plan.toFetch.map((a) => a.origin.externalId)).toEqual(['b', 'a']);
    expect(plan).toMatchObject({ alreadyHere: 0, noGps: 0 });
  });

  it('counts route-less activities as no GPS', () => {
    const plan = planImport([remote('a', { hasRoute: false }), remote('b')], []);
    expect(plan.toFetch).toHaveLength(1);
    expect(plan.noGps).toBe(1);
  });

  it('skips activities whose origin is already in the Library', () => {
    const plan = planImport(
      [remote('a'), remote('b', { hasRoute: false })],
      [
        lib({ origin: { source: 'strava', externalId: 'a' } }),
        lib({ origin: { source: 'strava', externalId: 'b' } }),
      ],
    );
    expect(plan.toFetch).toEqual([]);
    expect(plan.alreadyHere).toBe(2);
    expect(plan.noGps).toBe(0);
  });

  it('does not confuse the same id from another source', () => {
    const plan = planImport(
      [remote('a')],
      [lib({ origin: { source: 'apple-health', externalId: 'a' } })],
    );
    expect(plan.toFetch).toHaveLength(1);
  });

  it('skips a fingerprint duplicate (the same run recorded here)', () => {
    const plan = planImport(
      [remote('a', { startedAt: T0 + 30_000, distanceM: 10_100 }), remote('b', { distanceM: 0 })],
      [lib({ startedAt: T0, stats: { distanceM: 10_000 } })],
    );
    // 'b' has no distance yet: it can't be matched until its route is fetched.
    expect(plan.toFetch.map((a) => a.origin.externalId)).toEqual(['b']);
    expect(plan.alreadyHere).toBe(1);
  });

  it('counts an activity listed twice once', () => {
    const plan = planImport([remote('a'), remote('a')], []);
    expect(plan.toFetch).toHaveLength(1);
  });

  it('restricts a resumed plan to the remaining ids', () => {
    const plan = planImport(
      [remote('a'), remote('b'), remote('c', { hasRoute: false })],
      [lib({ origin: { source: 'strava', externalId: 'b' } })],
      new Set(['a', 'b']),
    );
    expect(plan.toFetch.map((a) => a.origin.externalId)).toEqual(['a']);
    expect(plan.alreadyHere).toBe(1);
    expect(plan.noGps).toBe(0);
  });
});

describe('remoteActivityName', () => {
  it('prefers the source name', () => {
    expect(remoteActivityName(remote('a', { name: '  Crête  ' }))).toBe('Crête');
  });

  it('falls back to the sport and local date', () => {
    const at = new Date(2026, 8, 12, 9).getTime();
    expect(remoteActivityName(remote('a', { sportLabel: 'Trail Run', startedAt: at }))).toBe(
      'Trail Run 2026-09-12',
    );
    expect(remoteActivityName(remote('a', { name: ' ', startedAt: at }))).toBe(
      'Activity 2026-09-12',
    );
  });
});

describe('ranges', () => {
  it('resolves "since last import" with a late-sync margin, or everything the first time', () => {
    expect(resolveRange('since-last', null)).toEqual({ kind: 'everything' });
    expect(resolveRange('since-last', T0)).toEqual({
      kind: 'since',
      after: T0 - LATE_SYNC_MARGIN_MS,
    });
    expect(resolveRange('since-last', 5)).toEqual({ kind: 'since', after: 0 });
    expect(resolveRange('last-30', T0)).toEqual({ kind: 'last-days', days: 30 });
    expect(resolveRange('everything', T0)).toEqual({ kind: 'everything' });
  });

  it('warns about slow Strava imports only for a big "Everything"', () => {
    const big = STRAVA_SLOW_IMPORT_THRESHOLD + 1;
    expect(showsSlowImportNote('strava', 'everything', big)).toBe(true);
    expect(showsSlowImportNote('strava', 'everything', STRAVA_SLOW_IMPORT_THRESHOLD)).toBe(false);
    expect(showsSlowImportNote('strava', 'last-30', big)).toBe(false);
    expect(showsSlowImportNote('apple-health', 'everything', big)).toBe(false);
  });
});

describe('importPreviewText', () => {
  it('says how many are new since the last import', () => {
    const at = new Date(2026, 8, 12, 9).getTime();
    expect(dayMonth(at)).toBe('12 Sep');
    expect(
      importPreviewText({ count: 41, source: 'strava', choice: 'since-last', lastImportAt: at }),
    ).toEqual({
      lead: '41 new activities',
      rest: ' since 12 Sep. Indoor workouts and ones already in your Library are skipped.',
    });
  });

  it('covers the other ranges, one activity, nothing and Health', () => {
    expect(
      importPreviewText({ count: 1, source: 'strava', choice: 'last-30', lastImportAt: null }),
    ).toEqual({
      lead: '1 new activity',
      rest: ' in the last 30 days. Indoor workouts and ones already in your Library are skipped.',
    });
    expect(
      importPreviewText({
        count: 1200,
        source: 'apple-health',
        choice: 'since-last',
        lastImportAt: null,
      }),
    ).toEqual({
      lead: '1,200 new activities',
      rest: ' in your Apple Health history. Workouts without a route and ones already in your Library are skipped.',
    });
    expect(
      importPreviewText({ count: 0, source: 'strava', choice: 'everything', lastImportAt: 1 }).lead,
    ).toBe('Nothing new');
  });
});
