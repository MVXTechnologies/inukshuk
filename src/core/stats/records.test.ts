import { biggestRecords, fastestRecords, inFamily, NEW_RECORD_MS } from './records';
import { summary } from './testTracks';
import { EFFORT_CLIMBS_M, EFFORT_DISTANCES_M, type TrailStatsSummary } from './trailSummary';

const NOW = new Date(2026, 9, 2, 12).getTime();
const DAY = 24 * 3600 * 1000;

function efforts(byDistance: Record<number, number>, byClimb: Record<number, number> = {}) {
  const s: TrailStatsSummary = {
    v: 1,
    bestDistanceS: EFFORT_DISTANCES_M.map((d) => byDistance[d] ?? null),
    bestClimbS: EFFORT_CLIMBS_M.map((c) => byClimb[c] ?? null),
    hr: null,
  };
  return s;
}

describe('inFamily', () => {
  it('groups categories into the records tabs, never plans or navigation', () => {
    expect(inFamily({ category: 'trail-run' }, 'run')).toBe(true);
    expect(inFamily({ category: 'walk' }, 'hike')).toBe(true);
    expect(inFamily({ category: 'bike' }, 'run')).toBe(false);
    expect(inFamily({ category: undefined }, 'run')).toBe(false);
    expect(inFamily({ category: 'run', plan: { mode: 'trails', vertices: [] } }, 'run')).toBe(
      false,
    );
  });
});

describe('fastestRecords', () => {
  const old = summary({ startedAt: NOW - 90 * DAY, category: 'run', name: 'Old PB' });
  const recent = summary({ startedAt: NOW - 3 * DAY, category: 'trail-run', name: 'Fresh' });
  const ride = summary({ startedAt: NOW - DAY, category: 'bike', name: 'Ride' });
  const hike = summary({ startedAt: NOW - 20 * DAY, category: 'hike', name: 'Climb' });
  const summaries = new Map([
    [old.id, efforts({ 1000: 250, 5000: 1400 })],
    [recent.id, efforts({ 1000: 240, 5000: 1400, 10000: 3000 })],
    [ride.id, efforts({ 1000: 90, 5000: 500, 20000: 2400 })],
    [hike.id, efforts({}, { 100: 600, 500: 3500 })],
  ]);
  const tracks = [recent, old, ride, hike];

  it('takes the fastest per distance, the first setter on a tie', () => {
    const rows = fastestRecords('run', tracks, summaries, NOW);
    expect(rows.map((r) => r.label)).toEqual([
      '1 km',
      '5 km',
      '10 km',
      'Half marathon',
      'Marathon',
    ]);
    expect(rows[0]).toMatchObject({ value: 240, trackName: 'Fresh', isNew: true });
    expect(rows[1]).toMatchObject({ value: 1400, trackName: 'Old PB', isNew: false });
    expect(rows[2]).toMatchObject({ value: 3000, trackId: recent.id, startedAt: recent.startedAt });
    expect(rows[3]).toMatchObject({
      value: null,
      emptyText: 'No run long enough yet',
      isNew: false,
    });
  });

  it('keeps each family to its own trails', () => {
    const bike = fastestRecords('bike', tracks, summaries, NOW);
    expect(bike.map((r) => [r.label, r.value])).toEqual([
      ['5 km', 500],
      ['20 km', 2400],
      ['40 km', null],
    ]);
    expect(bike[2]!.emptyText).toBe('No ride long enough yet');
  });

  it('hiking records are climbs', () => {
    const rows = fastestRecords('hike', tracks, summaries, NOW);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['100 m climb', 600],
      ['500 m climb', 3500],
      ['1000 m climb', null],
    ]);
    expect(rows[0]!.isNew).toBe(false);
    expect(rows[2]!.emptyText).toBe('No climb that big yet');
  });

  it('skips trails whose summary is not computed yet', () => {
    const rows = fastestRecords('run', tracks, new Map(), NOW);
    expect(rows.every((r) => r.value === null)).toBe(true);
  });
});

describe('biggestRecords', () => {
  it('picks the biggest of each, with NEW inside 14 days', () => {
    const a = summary({
      startedAt: NOW - 30 * DAY,
      category: 'run',
      stats: { distanceM: 21000, ascentM: 100, movingTimeS: 7000, maxAltitudeM: 300 },
    });
    const b = summary({
      startedAt: NOW - NEW_RECORD_MS + DAY,
      category: 'run',
      stats: { distanceM: 9000, ascentM: 400, movingTimeS: 3000, maxAltitudeM: undefined },
    });
    const rows = biggestRecords('run', [a, b], NOW);
    expect(rows.map((r) => [r.key, r.value, r.trackId === b.id])).toEqual([
      ['longest', 21000, false],
      ['climb', 400, true],
      ['moving', 7000, false],
      ['highest', 300, false],
    ]);
    expect(rows[1]!.isNew).toBe(true);
    expect(rows[0]!.isNew).toBe(false);
  });

  it('is empty without trails of the family', () => {
    const rows = biggestRecords('hike', [summary({ startedAt: NOW, category: 'run' })], NOW);
    expect(rows.every((r) => r.value === null && r.emptyText === 'No hike yet')).toBe(true);
    const broken = { ...summary({ startedAt: NOW, category: 'bike' }), stats: undefined as never };
    expect(biggestRecords('bike', [broken], NOW)[0]!.value).toBeNull();
  });
});
